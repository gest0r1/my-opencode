#!/usr/bin/env bash
# Always stage and validate a full configuration generation. Binary downloads
# remain independent and are skipped when the installed version matches.
set -Eeuo pipefail

RUNTIME_USER="${OPENCODE_RUNTIME_USER:-opencode}"
[[ "$RUNTIME_USER" == opencode ]] || {
  echo "Invalid runtime user '$RUNTIME_USER': required name is exactly opencode" >&2; exit 2;
}
for cmd in id getent cut; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing prerequisite: $cmd" >&2; exit 1; }
done
CURRENT_USER="$(id -un)"
RUNTIME_HOME="$(getent passwd "$RUNTIME_USER" | cut -d: -f6 || true)"
[[ -n "$RUNTIME_HOME" ]] || {
  echo "Runtime user '$RUNTIME_USER' does not exist. Run scripts/migrate-root-runtime-to-opencode.sh first." >&2
  exit 2
}

reexec_as_runtime_user() {
  [[ "$CURRENT_USER" != "$RUNTIME_USER" ]] || return 0
  for cmd in sudo loginctl systemctl mktemp cp chmod rm; do
    command -v "$cmd" >/dev/null 2>&1 || { echo "Missing prerequisite for user switch: $cmd" >&2; exit 1; }
  done
  sudo -v || { echo "Current user '$CURRENT_USER' must have sudo rights." >&2; exit 2; }

  local runtime_uid script_copy rc token name source_file bootstrap_sha=''
  local -a pass_env=()
  runtime_uid="$(id -u "$RUNTIME_USER")"
  sudo loginctl enable-linger "$RUNTIME_USER" >/dev/null
  sudo systemctl start "user@${runtime_uid}.service"

  script_copy="$(mktemp /tmp/my-opencode-install.XXXXXXXX)"
  source_file="${BASH_SOURCE[0]:-}"
  if [[ -n "$source_file" && -f "$source_file" ]]; then
    cp -- "$source_file" "$script_copy"
  else
    command -v gh >/dev/null 2>&1 || {
      rm -f -- "$script_copy"
      echo 'Piped install from another user requires an authenticated GitHub CLI.' >&2
      exit 1
    }
    local bootstrap_repo="${OPENCODE_CONFIG_REPO:-gest0r1/my-opencode}"
    local bootstrap_ref="${OPENCODE_CONFIG_REF:-${MY_OPENCODE_REF:-main}}"
    bootstrap_sha="$(gh api "repos/$bootstrap_repo/commits/$bootstrap_ref" --jq .sha)"
    [[ "$bootstrap_sha" =~ ^[a-f0-9]{40}$ ]] || { rm -f -- "$script_copy"; exit 1; }
    gh api -H 'Accept: application/vnd.github.raw' \
      "repos/$bootstrap_repo/contents/install.sh?ref=$bootstrap_sha" > "$script_copy"
  fi
  chmod 755 "$script_copy"

  for name in $(compgen -e); do
    case "$name" in
      OPENCODE_*|OPENCHAMBER_*|MY_OPENCODE_REF|EXPECTED_OPENCHAMBER_VERSION|LEGACY_BUN_INSTALL|GH_TOKEN|GH_HOST|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy)
        pass_env+=("$name=${!name}")
        ;;
    esac
  done
  if [[ -n "$bootstrap_sha" ]]; then
    pass_env+=("OPENCODE_CONFIG_REF=$bootstrap_sha" "MY_OPENCODE_REF=$bootstrap_sha")
  fi

  # Prefer opencode's migrated gh auth. If it is unavailable, temporarily use
  # the invoking sudo user's token without persisting/copying its credentials.
  if ! sudo -H -u "$RUNTIME_USER" env \
      HOME="$RUNTIME_HOME" USER="$RUNTIME_USER" LOGNAME="$RUNTIME_USER" \
      PATH="$RUNTIME_HOME/.local/bin:$RUNTIME_HOME/.opencode/bin:$RUNTIME_HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin" \
      XDG_RUNTIME_DIR="/run/user/$runtime_uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$runtime_uid/bus" \
      gh auth status --hostname github.com >/dev/null 2>&1; then
    if [[ -z "${GH_TOKEN:-}" ]] && command -v gh >/dev/null 2>&1 && gh auth status --hostname github.com >/dev/null 2>&1; then
      token="$(gh auth token --hostname github.com)"
      [[ -z "$token" ]] || pass_env+=("GH_TOKEN=$token")
    fi
  fi

  echo "Switching installer runtime: $CURRENT_USER -> $RUNTIME_USER"
  if sudo -H -u "$RUNTIME_USER" env \
      HOME="$RUNTIME_HOME" USER="$RUNTIME_USER" LOGNAME="$RUNTIME_USER" \
      PATH="$RUNTIME_HOME/.local/bin:$RUNTIME_HOME/.opencode/bin:$RUNTIME_HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin" \
      XDG_RUNTIME_DIR="/run/user/$runtime_uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$runtime_uid/bus" \
      "${pass_env[@]}" bash "$script_copy" "$@"; then
    rc=0
  else
    rc=$?
  fi
  rm -f -- "$script_copy"
  exit "$rc"
}
reexec_as_runtime_user "$@"

if [[ "$HOME" != "$RUNTIME_HOME" ]]; then
  echo "Invalid HOME for runtime user '$RUNTIME_USER': HOME='$HOME', expected='$RUNTIME_HOME'." >&2
  exit 2
fi
if ! command -v sudo >/dev/null || ! sudo -n /usr/local/sbin/opencode-install-packages --check >/dev/null 2>&1; then
  echo 'Package-install helper is not configured. Run scripts/migrate-root-runtime-to-opencode.sh or scripts/setup-opencode-package-sudo.sh once with sudo/root.' >&2
  exit 2
fi

REPO="${OPENCODE_CONFIG_REPO:-gest0r1/my-opencode}"
REF="${OPENCODE_CONFIG_REF:-main}"
OPENCODE_INSTALL_VERSION="${OPENCODE_INSTALL_VERSION:-2.0.21}"
GENERATION_PATH="scripts/install-opencode-generation.sh"
for cmd in gh mktemp rm sed systemctl; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing prerequisite: $cmd" >&2; exit 1; }
done
gh auth status --hostname github.com >/dev/null 2>&1 || { echo 'GitHub CLI is not authorized for this install run.' >&2; exit 1; }
CONFIG_SHA="${OPENCODE_RESOLVED_CONFIG_SHA:-$REF}"
if [[ ! "$CONFIG_SHA" =~ ^[a-f0-9]{40}$ ]]; then
  CONFIG_SHA="$(gh api "repos/$REPO/commits/$REF" --jq .sha)"
fi
export OPENCODE_RESOLVED_CONFIG_SHA="$CONFIG_SHA"
OPENCODE_BIN="$HOME/.opencode/bin/opencode"
if [[ "${OPENCODE_SKIP_BINARY_INSTALL:-0}" != 1 && "${OPENCODE_FORCE_BINARY_INSTALL:-0}" != 1 && -x "$OPENCODE_BIN" ]] &&
   [[ "$("$OPENCODE_BIN" --version | sed -E 's/^opencode[[:space:]]+v?//')" == "$OPENCODE_INSTALL_VERSION" ]]; then
  export OPENCODE_SKIP_BINARY_INSTALL=1
fi
TMP_DIR="$(mktemp -d /tmp/opencode-generation-bootstrap.XXXXXXXX)"
GENERATION="$TMP_DIR/install-opencode-generation.sh"
trap 'rm -rf -- "$TMP_DIR"' EXIT
gh api -H 'Accept: application/vnd.github.raw' \
  "repos/$REPO/contents/$GENERATION_PATH?ref=$CONFIG_SHA" > "$GENERATION"
bash "$GENERATION" "$@"

# OpenCode is a user service owned by opencode. Enable it for boot/login now;
# the combined OpenChamber installer starts it only after the old root runtime
# has been safely stopped at the final cutover point.
WEB_HOST="${OPENCODE_WEB_HOST:-0.0.0.0}"
WEB_PORT="${OPENCODE_WEB_PORT:-4096}"
[[ "$WEB_PORT" =~ ^[0-9]+$ && "$WEB_PORT" -ge 1 && "$WEB_PORT" -le 65535 ]] || {
  echo 'OPENCODE_WEB_PORT must be 1..65535' >&2; exit 2;
}
USER_SYSTEMD_DIR="$HOME/.config/systemd/user"
UNIT="$USER_SYSTEMD_DIR/opencode-web.service"
mkdir -p "$USER_SYSTEMD_DIR"
UNIT_TMP="$(mktemp "$USER_SYSTEMD_DIR/.opencode-web.service.XXXXXXXX")"
cat > "$UNIT_TMP" <<EOF
[Unit]
Description=OpenCode Web Server
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=10

[Service]
Type=simple
WorkingDirectory=$HOME
ExecStart=$HOME/.opencode/bin/opencode web --port $WEB_PORT --hostname $WEB_HOST
EnvironmentFile=-$HOME/.config/opencode.env
TimeoutStopSec=10
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF
chmod 644 "$UNIT_TMP"
mv -f "$UNIT_TMP" "$UNIT"
systemctl --user daemon-reload
systemctl --user enable opencode-web.service >/dev/null
echo "OpenCode autostart enabled for user $RUNTIME_USER."
