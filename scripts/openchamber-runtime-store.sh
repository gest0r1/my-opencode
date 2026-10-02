#!/usr/bin/env bash
# Helpers for immutable OpenChamber V2 runtime staging and atomic activation.
# This file is sourced by install-openchamber.sh.

: "${OPENCHAMBER_RUNTIME_ROOT:=$HOME/.local/share/openchamber-v2}"
: "${EXPECTED_OPENCHAMBER_VERSION:?EXPECTED_OPENCHAMBER_VERSION is required}"
: "${BUN_INSTALL:=$HOME/.bun}"

OPENCHAMBER_RELEASES="$OPENCHAMBER_RUNTIME_ROOT/releases"
OPENCHAMBER_CURRENT="$OPENCHAMBER_RUNTIME_ROOT/current"
OPENCHAMBER_CURRENT_BIN="$OPENCHAMBER_CURRENT/bin/openchamber"
OPENCHAMBER_MANAGED_BIN="$HOME/.local/bin/openchamber"
OPENCHAMBER_PREVIOUS_TARGET=''
OPENCHAMBER_RUNTIME_ACTIVATED=0
OPENCHAMBER_SERVICE_SNAPSHOT=''
OPENCHAMBER_SERVICE_WAS_ACTIVE=0

oc_runtime_init() {
  mkdir -p "$OPENCHAMBER_RELEASES" "$HOME/.local/bin"
}

oc_version_of() {
  local bin=$1
  [[ -x "$bin" ]] || return 1
  "$bin" --version 2>/dev/null | sed -E 's/^OpenChamber[[:space:]]+v?//; s/^v//'
}

oc_detect_bin() {
  if [[ -x "$OPENCHAMBER_CURRENT_BIN" ]]; then
    printf '%s\n' "$OPENCHAMBER_CURRENT_BIN"
    return 0
  fi
  if command -v openchamber >/dev/null 2>&1; then
    command -v openchamber
    return 0
  fi
  return 1
}

oc_current_version() {
  local bin
  bin="$(oc_detect_bin 2>/dev/null || true)"
  [[ -n "$bin" ]] || return 0
  oc_version_of "$bin" || true
}

oc_validate_release() {
  local release_dir=$1 actual
  [[ -x "$release_dir/bin/openchamber" ]] || return 1
  actual="$(oc_version_of "$release_dir/bin/openchamber" || true)"
  [[ "$actual" == "$EXPECTED_OPENCHAMBER_VERSION" ]]
}

oc_stage_package() {
  local package_file=$1 package_sha256=$2 release_dir
  [[ -f "$package_file" ]] || {
    echo "OpenChamber package missing: $package_file" >&2
    return 1
  }
  [[ "$package_sha256" =~ ^[a-f0-9]{64}$ ]] || {
    echo "Invalid OpenChamber package SHA256: $package_sha256" >&2
    return 1
  }
  printf '%s  %s\n' "$package_sha256" "$package_file" | sha256sum -c - >/dev/null

  oc_runtime_init
  release_dir="$OPENCHAMBER_RELEASES/$package_sha256"
  if oc_validate_release "$release_dir"; then
    printf '%s\n' "$release_dir"
    return 0
  fi

  # A partial directory can only be left by an interrupted previous staging
  # attempt. It has never been active because current is switched only after
  # validation, so it is safe to replace.
  rm -rf -- "$release_dir"
  mkdir -p "$release_dir"

  if ! BUN_INSTALL="$release_dir" bun add -g "$package_file"; then
    rm -rf -- "$release_dir"
    return 1
  fi
  if ! oc_validate_release "$release_dir"; then
    echo "Staged OpenChamber runtime failed version validation: $release_dir" >&2
    rm -rf -- "$release_dir"
    return 1
  fi

  printf '%s\n' "$release_dir"
}

oc_write_managed_launcher() {
  local tmp="$HOME/.local/bin/.openchamber.tmp.${BASHPID}"
  cat > "$tmp" <<'EOF'
#!/usr/bin/env bash
# managed-by: my-opencode-v2
set -Eeuo pipefail
exec "$HOME/.local/share/openchamber-v2/current/bin/openchamber" "$@"
EOF
  chmod 755 "$tmp"
  mv -f "$tmp" "$OPENCHAMBER_MANAGED_BIN"
}

oc_activate_release() {
  local release_dir=$1 link_tmp
  oc_validate_release "$release_dir" || {
    echo "Refusing to activate invalid OpenChamber release: $release_dir" >&2
    return 1
  }

  OPENCHAMBER_PREVIOUS_TARGET="$(readlink -f "$OPENCHAMBER_CURRENT" 2>/dev/null || true)"
  link_tmp="$OPENCHAMBER_RUNTIME_ROOT/.current.tmp.${BASHPID}"
  rm -f -- "$link_tmp"
  ln -s "$release_dir" "$link_tmp"
  mv -Tf "$link_tmp" "$OPENCHAMBER_CURRENT"
  oc_write_managed_launcher
  OPENCHAMBER_RUNTIME_ACTIVATED=1
}

oc_rollback_activation() {
  local link_tmp
  (( OPENCHAMBER_RUNTIME_ACTIVATED == 1 )) || return 0
  link_tmp="$OPENCHAMBER_RUNTIME_ROOT/.current.rollback.${BASHPID}"
  rm -f -- "$link_tmp"
  if [[ -n "$OPENCHAMBER_PREVIOUS_TARGET" && -d "$OPENCHAMBER_PREVIOUS_TARGET" ]]; then
    ln -s "$OPENCHAMBER_PREVIOUS_TARGET" "$link_tmp"
    mv -Tf "$link_tmp" "$OPENCHAMBER_CURRENT"
    oc_write_managed_launcher
  else
    rm -f -- "$OPENCHAMBER_CURRENT" "$OPENCHAMBER_MANAGED_BIN"
  fi
  OPENCHAMBER_RUNTIME_ACTIVATED=0
}

oc_commit_activation() {
  OPENCHAMBER_PREVIOUS_TARGET=''
  OPENCHAMBER_RUNTIME_ACTIVATED=0
}

oc_snapshot_service() {
  local unit=$1 startup_env=$2 drop_dir=$3 snapshot_root=$4
  OPENCHAMBER_SERVICE_SNAPSHOT="$snapshot_root"
  rm -rf -- "$snapshot_root"
  mkdir -p "$snapshot_root"

  [[ -f "$unit" ]] && cp -a "$unit" "$snapshot_root/unit" || : > "$snapshot_root/no-unit"
  [[ -f "$startup_env" ]] && cp -a "$startup_env" "$snapshot_root/startup.env" || : > "$snapshot_root/no-startup-env"
  [[ -d "$drop_dir" ]] && cp -a "$drop_dir" "$snapshot_root/dropins" || : > "$snapshot_root/no-dropins"
  systemctl --user is-active --quiet openchamber.service && OPENCHAMBER_SERVICE_WAS_ACTIVE=1 || OPENCHAMBER_SERVICE_WAS_ACTIVE=0
}

oc_rollback_service() {
  local unit=$1 startup_env=$2 drop_dir=$3
  [[ -n "$OPENCHAMBER_SERVICE_SNAPSHOT" && -d "$OPENCHAMBER_SERVICE_SNAPSHOT" ]] || {
    oc_rollback_activation
    return 0
  }

  systemctl --user stop openchamber.service >/dev/null 2>&1 || true
  if [[ -f "$OPENCHAMBER_SERVICE_SNAPSHOT/unit" ]]; then
    mkdir -p "$(dirname "$unit")"
    cp -a "$OPENCHAMBER_SERVICE_SNAPSHOT/unit" "$unit"
  else
    rm -f -- "$unit"
  fi

  if [[ -f "$OPENCHAMBER_SERVICE_SNAPSHOT/startup.env" ]]; then
    mkdir -p "$(dirname "$startup_env")"
    cp -a "$OPENCHAMBER_SERVICE_SNAPSHOT/startup.env" "$startup_env"
  else
    rm -f -- "$startup_env"
  fi

  rm -rf -- "$drop_dir"
  if [[ -d "$OPENCHAMBER_SERVICE_SNAPSHOT/dropins" ]]; then
    mkdir -p "$(dirname "$drop_dir")"
    cp -a "$OPENCHAMBER_SERVICE_SNAPSHOT/dropins" "$drop_dir"
  fi

  oc_rollback_activation
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  if (( OPENCHAMBER_SERVICE_WAS_ACTIVE == 1 )) && [[ -f "$unit" ]]; then
    systemctl --user restart openchamber.service >/dev/null 2>&1 || true
  fi
}

oc_commit_service() {
  [[ -z "$OPENCHAMBER_SERVICE_SNAPSHOT" ]] || rm -rf -- "$OPENCHAMBER_SERVICE_SNAPSHOT"
  OPENCHAMBER_SERVICE_SNAPSHOT=''
  OPENCHAMBER_SERVICE_WAS_ACTIVE=0
  oc_commit_activation
}

oc_remove_legacy_bun_global() {
  # The immutable current runtime is healthy before this is called. Removing
  # the old global package eliminates a competing CLI lookup path without
  # risking the active service.
  if [[ -x "$OPENCHAMBER_CURRENT_BIN" ]] && command -v bun >/dev/null 2>&1; then
    BUN_INSTALL="$BUN_INSTALL" bun remove -g @openchamber/web >/dev/null 2>&1 || true
  fi
}

oc_prune_releases() {
  local current previous keep dir
  current="$(readlink -f "$OPENCHAMBER_CURRENT" 2>/dev/null || true)"
  previous="$OPENCHAMBER_PREVIOUS_TARGET"
  for dir in "$OPENCHAMBER_RELEASES"/*; do
    [[ -d "$dir" ]] || continue
    keep=0
    [[ "$dir" == "$current" ]] && keep=1
    [[ -n "$previous" && "$dir" == "$previous" ]] && keep=1
    (( keep == 1 )) || rm -rf -- "$dir"
  done
}
