#!/usr/bin/env bash

# Verify that no agent-writable path component can replace an executable
# used by the privileged installer. Follows symlinks and checks their parents.
trusted_root_exec() {
  local file="${1:-}" resolved current mode
  [[ "$file" == /* ]] || return 1
  resolved="$(readlink -f "$file" 2>/dev/null)" || return 1
  [[ -x "$resolved" ]] || return 1
  for current in "$file" "$resolved"; do
    while [[ "$current" != / ]]; do
      [[ "$(stat -c %u "$current" 2>/dev/null)" == 0 ]] || return 1
      mode="$(stat -c %a "$current")" || return 1
      [[ "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
      (( (8#$mode & 8#6022) == 0 )) || return 1
      current="$(dirname "$current")"
    done
  done
}

# Root runtime has its own verified Node distribution. Never execute the
# agent-writable /home/opencode node binary as root.
root_node_version_ok() {
  local candidate
  candidate="$(command -v node 2>/dev/null || true)"
  [[ -n "$candidate" ]] && trusted_root_exec "$candidate" &&
    node -e 'const a=process.versions.node.split(".").map(Number);process.exit(a[0]>24||(a[0]===24&&a[1]>=14)?0:1)' >/dev/null 2>&1
}
ensure_root_node() {
  if root_node_version_ok; then return 0; fi
  local version=24.21.0 name="node-v24.21.0-linux-x64.tar.xz" dest=/usr/local/lib/my-openchamber/node-v24.21.0
  if [[ ! -x "$dest/bin/node" ]]; then
    local tmp; tmp="$(mktemp -d /tmp/openchamber-node.XXXXXXXX)"
    (cd "$tmp" && curl -fsSLO "https://nodejs.org/dist/v$version/$name" && \
      curl -fsSLO "https://nodejs.org/dist/v$version/SHASUMS256.txt" && \
      grep -F "  $name" SHASUMS256.txt > node.sha && sha256sum -c node.sha && \
      tar -xJf "$name" && install -d -m 755 /usr/local/lib/my-openchamber && \
      mv "node-v$version-linux-x64" "$dest" && \
      chown -R root:root "$dest" && chmod -R go-w "$dest") || { rm -rf -- "$tmp"; return 1; }
    rm -rf -- "$tmp"
  fi
  export PATH="$dest/bin:$PATH"
  root_node_version_ok || {
    local candidate
    candidate="$(command -v node 2>/dev/null || true)"
    echo "ROOT_NODE_TRUST_OR_VERSION_INVALID: $candidate" >&2
    for part in "$candidate" "$(dirname "$candidate")" "$(dirname "$(dirname "$candidate")")" \
                "$(dirname "$(dirname "$(dirname "$candidate")")")" /opt; do
      if [[ -e "$part" ]]; then
        stat -c 'NODE_TRUST_PATH %n uid=%u mode=%a kind=%F' "$part" >&2 || true
      fi
    done
    "$candidate" --version >&2 || true
    return 2
  }
}

# Deterministic, verified Bun bootstrap: no curl|bash or lifecycle installer
# runs with root privileges. GitHub release checksum is pinned to the exact
# archive; the extracted executable lives under a root-owned immutable path.
ensure_root_bun() {
  local current version=1.3.4 archive=bun-linux-x64.zip
  local destination="/usr/local/lib/my-openchamber/bun-1.3.4"
  current="$(command -v bun 2>/dev/null || true)"
  if [[ -n "$current" ]] && trusted_root_exec "$current" && bun --version >/dev/null 2>&1; then
    return 0
  fi
  [[ "$(uname -m)" == x86_64 ]] || { echo 'ROOT_BUN_ARCH_UNSUPPORTED' >&2; return 2; }
  if [[ -x "$destination/bin/bun" ]] &&
     trusted_root_exec "$destination/bin/bun" &&
     [[ "$("$destination/bin/bun" --version)" == "$version" ]]; then
    export PATH="$destination/bin:$PATH"
    return 0
  fi
  command -v unzip >/dev/null || { echo 'ROOT_BUN_UNZIP_REQUIRED' >&2; return 2; }
  local stage; stage="$(mktemp -d /tmp/openchamber-bun.XXXXXXXX)"
  if ! (
    cd "$stage"
    gh release download "bun-v$version" --repo oven-sh/bun \
      --pattern "$archive" --pattern SHASUMS256.txt --dir "$stage" --clobber
    awk -v name="$archive" '$2 == name {print}' SHASUMS256.txt > pinned.sha
    [[ "$(wc -l < pinned.sha)" == 1 ]]
    sha256sum -c pinned.sha
    unzip -q "$archive"
    [[ -x bun-linux-x64/bun ]]
    [[ "$(./bun-linux-x64/bun --version)" == "$version" ]]
    install -d -o root -g root -m 755 "$destination/bin"
    install -o root -g root -m 755 bun-linux-x64/bun "$destination/bin/bun"
  ); then
    rm -rf -- "$stage"
    echo 'ROOT_BUN_VERIFIED_BOOTSTRAP_FAILED' >&2
    return 2
  fi
  rm -rf -- "$stage"
  export PATH="$destination/bin:$PATH"
  trusted_root_exec "$destination/bin/bun" &&
    [[ "$("$destination/bin/bun" --version)" == "$version" ]]
}
