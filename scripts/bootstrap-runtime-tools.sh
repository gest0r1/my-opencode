#!/usr/bin/env bash
# Source only as runtime user; deterministic user PATH also works in systemd.
set -Eeuo pipefail
export PATH="$HOME/.local/bin:$HOME/.opencode/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"
export XDG_CONFIG_HOME="$HOME/.config" XDG_DATA_HOME="$HOME/.local/share" XDG_STATE_HOME="$HOME/.local/state"
cd "$HOME"

# Mutate only our managed links or links already broken for this user.
# Never silently replace an unrelated executable in ~/.local/bin.
runtime_install_links() {
  local prefix=$1 tool dest link current wanted temp
  shift
  mkdir -p "$HOME/.local/bin" || return 1
  # Preflight the entire batch before touching any links.
  for tool in "$@"; do
    dest="$prefix/$tool"
    [[ -f "$dest" && -x "$dest" ]] || {
      echo "RUNTIME_TOOLCHAIN_UNUSABLE: missing executable $dest" >&2; return 1;
    }
    link="$HOME/.local/bin/$tool"
    if [[ -L "$link" ]]; then
      current="$(readlink -f "$link" 2>/dev/null || true)"
      wanted="$(readlink -f "$dest" 2>/dev/null || true)"
      if [[ -n "$current" && "$current" != "$wanted" &&
            "$current" != /root/* && "$current" != "$HOME/.local/share/my-opencode/"* ]]; then
        echo "RUNTIME_TOOLCHAIN_CONFLICT: refusing to overwrite unmanaged link $link" >&2; return 1
      fi
    elif [[ -e "$link" ]]; then
      echo "RUNTIME_TOOLCHAIN_CONFLICT: refusing to overwrite unmanaged file $link" >&2; return 1
    fi
  done
  for tool in "$@"; do
    dest="$prefix/$tool"
    link="$HOME/.local/bin/$tool"
    if [[ -L "$link" && "$(readlink -f "$link" 2>/dev/null || true)" == "$(readlink -f "$dest")" ]]; then
      continue
    fi
    temp="$HOME/.local/bin/.$tool.my-opencode-${BASHPID}"
    [[ ! -e "$temp" && ! -L "$temp" ]] || {
      echo "RUNTIME_TOOLCHAIN_CONFLICT: temporary link already exists: $temp" >&2; return 1
    }
    ln -s -- "$dest" "$temp" || return 1
    mv -Tf -- "$temp" "$link" || { rm -f -- "$temp"; return 1; }
  done
  hash -r
}

install_pinned_runtime_node() {
  # Install the pinned LTS into the user's own prefix. Never touch system Node.
  local version=24.21.0 arch archive tmp dest
  case "$(uname -m)" in x86_64) arch=x64;; *) echo 'Node bootstrap supports Linux x86_64 only' >&2; return 1;; esac
  dest="$HOME/.local/share/my-opencode/node-v$version"
  if [[ -x "$dest/bin/node" && -f "$dest/bin/npm" && -f "$dest/bin/npx" ]]; then
    runtime_install_links "$dest/bin" node npm npx || return 1
    return 0
  fi
  archive="node-v$version-linux-$arch.tar.xz"
  tmp="$(mktemp -d)"
  if ! (
    cd "$tmp"
    curl -fsSLO "https://nodejs.org/dist/v$version/$archive" || exit 1
    curl -fsSLO "https://nodejs.org/dist/v$version/SHASUMS256.txt" || exit 1
    awk -v file="$archive" '$2 == file {print}' SHASUMS256.txt > checksum
    [[ "$(wc -l < checksum)" == 1 ]] || exit 1
    sha256sum -c checksum || exit 1
    tar -xJf "$archive" || exit 1
    "node-v$version-linux-$arch/bin/node" --version || exit 1
    [[ -f "node-v$version-linux-$arch/bin/npm" && -f "node-v$version-linux-$arch/bin/npx" ]] || exit 1
    mkdir -p "$(dirname "$dest")" "$HOME/.local/bin" || exit 1
    [[ ! -e "$dest" ]] || { echo 'Incomplete Node bootstrap exists; inspect before retry' >&2; exit 1; }
    mv "node-v$version-linux-$arch" "$dest" || exit 1
  ); then rm -rf -- "$tmp"; return 1; fi
  rm -rf -- "$tmp"
  runtime_install_links "$dest/bin" node npm npx || return 1
}

node_version_ok() {
  local minimum="${1:-22.0.0}"
  local check='const a=process.versions.node.split(".").map(Number),b=process.argv[1].split(".").map(Number);process.exit(a[0]>b[0]||(a[0]===b[0]&&(a[1]>b[1]||(a[1]===b[1]&&a[2]>=b[2])))?0:1)'
  command -v node >/dev/null 2>&1 && node -e "$check" "$minimum" 2>/dev/null
}

# A tool is usable only when it executes for this user and does not resolve into
# another user's home (the classic /usr/local/bin -> /root/.nvm failure).
runtime_tool_usable() {
  local tool=$1 target
  [[ -n "$tool" && ( -f "$tool" || -L "$tool" ) && -x "$tool" ]] || return 1
  target="$(readlink -f "$tool" 2>/dev/null)" || return 1
  [[ "$target" != /root/* ]] || return 1
  "$tool" --version >/dev/null 2>&1
}

ensure_runtime_node() {
  local minimum="${1:-22.0.0}"
  if node_version_ok "$minimum"; then return 0; fi
  install_pinned_runtime_node
  node_version_ok "$minimum"
}

ensure_runtime_toolchain() {
  local minimum="${1:-22.0.0}" node_real node_dir tool bundled current wanted
  ensure_runtime_node "$minimum" || {
    echo "RUNTIME_TOOLCHAIN_UNUSABLE: no compatible Node runtime is available at or above $minimum" >&2
    return 1
  }
  node_real="$(readlink -f "$(command -v node)")"
  node_dir="$(dirname "$node_real")"
  if ! runtime_tool_usable "$node_dir/npm" || ! runtime_tool_usable "$node_dir/npx"; then
    bundled="$HOME/.local/share/my-opencode/node-v24.21.0/bin"
    if runtime_tool_usable "$bundled/npm" && runtime_tool_usable "$bundled/npx"; then
      node_dir="$bundled"
    else
      install_pinned_runtime_node || {
        echo "RUNTIME_TOOLCHAIN_UNUSABLE: npm/npx are not executable beside $(command -v node) and the pinned user-local runtime could not be installed" >&2
        return 1
      }
      node_dir="$HOME/.local/share/my-opencode/node-v24.21.0/bin"
    fi
  fi
  runtime_install_links "$node_dir" npm npx || return 1
  for tool in npm npx; do
    runtime_tool_usable "$HOME/.local/bin/$tool" || {
      echo "RUNTIME_TOOLCHAIN_UNUSABLE: user-local $tool is not executable" >&2
      return 1
    }
  done
}

ensure_claude_cli() {
  # Claude Code is a native OpenCode 2.2.3+ provider: there is no longer a
  # subscription plugin to detect. A pre-existing CLI/login is preserved.
  # Opt-in bootstrap for new hosts; an absent optional CLI does not fail install.
  if ! command -v claude >/dev/null 2>&1; then
    if [[ "${OPENCODE_INSTALL_CLAUDE_CLI:-0}" == 1 ]]; then
      npm install --global --prefix "$HOME/.local" @anthropic-ai/claude-code
      hash -r
    else
      echo 'Claude CLI not installed (optional native provider). To enable: set OPENCODE_INSTALL_CLAUDE_CLI=1 or install the CLI manually.'
      return 0
    fi
  fi
  claude --version
  local status auth_rc=0 parsed_rc=0
  status="$(claude auth status)" || auth_rc=$?
  printf '%s' "$status" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const v=JSON.parse(s);process.exit(v.loggedIn===true?0:v.loggedIn===false?2:1)}catch{process.exit(1)}})' || parsed_rc=$?
  if (( parsed_rc == 2 )); then
    echo 'CLAUDE_LOGIN_REQUIRED: run claude auth login --claudeai as opencode' >&2
  elif (( parsed_rc != 0 || auth_rc != 0 )); then
    echo 'Claude CLI auth check failed; inspect native Claude provider separately' >&2
    return 1
  fi
}

configure_server_browser() {
  local config="$HOME/.config/openchamber/extensions/server-browser/config.json"
  [[ -f "$config" ]] || return 0
  local chrome=''
  for candidate in /usr/bin/google-chrome /usr/bin/google-chrome-stable /usr/bin/chromium; do
    if [[ -x "$candidate" ]] && [[ "$(readlink -f "$candidate")" != /snap/* ]]; then chrome="$candidate"; break; fi
  done
  [[ -n "$chrome" ]] || { echo 'SERVER_BROWSER_NATIVE_CHROME_REQUIRED: install native Chrome; sandbox stays enabled' >&2; return 1; }
  node - "$config" "$chrome" <<'NODE'
const fs = require('node:fs');
const [file, chrome] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
if (data.chromePath === chrome) process.exit(0);
fs.copyFileSync(file, `${file}.backup-${Date.now()}`);
data.chromePath = chrome;
const tmp = `${file}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', {mode: 0o600});
fs.renameSync(tmp, file);
NODE
}
