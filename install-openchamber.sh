#!/usr/bin/env bash
# Exact-SHA delivery and binary-only atomic activation. Native CLI owns services.
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

  local runtime_uid script_copy rc token name source_file bootstrap_sha='' token_file=''
  local -a pass_env=()
  runtime_uid="$(id -u "$RUNTIME_USER")"
  sudo loginctl enable-linger "$RUNTIME_USER" >/dev/null
  sudo systemctl start "user@${runtime_uid}.service"

  script_copy="$(mktemp /tmp/openchamber-install.XXXXXXXX)"
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
      "repos/$bootstrap_repo/contents/install-openchamber.sh?ref=$bootstrap_sha" > "$script_copy"
  fi
  chmod 755 "$script_copy"

  for name in $(compgen -e); do
    case "$name" in
      OPENCODE_*|OPENCHAMBER_*|MY_OPENCODE_REF|EXPECTED_OPENCHAMBER_VERSION|LEGACY_BUN_INSTALL|GH_HOST|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy)
        pass_env+=("$name=${!name}")
        ;;
    esac
  done
  if [[ -n "$bootstrap_sha" ]]; then
    pass_env+=("OPENCODE_CONFIG_REF=$bootstrap_sha" "MY_OPENCODE_REF=$bootstrap_sha")
  fi

  # Prefer opencode's migrated gh auth. If unavailable, hand the invoking
  # sudo user's token over through a mode-0600 runtime file, never argv.
  if ! sudo -H -u "$RUNTIME_USER" env \
      HOME="$RUNTIME_HOME" USER="$RUNTIME_USER" LOGNAME="$RUNTIME_USER" \
      PATH="$RUNTIME_HOME/.local/bin:$RUNTIME_HOME/.opencode/bin:$RUNTIME_HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin" \
      XDG_RUNTIME_DIR="/run/user/$runtime_uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$runtime_uid/bus" \
      gh auth status --hostname github.com >/dev/null 2>&1; then
    if [[ -n "${GH_TOKEN:-}" ]]; then
      token="$GH_TOKEN"
    elif command -v gh >/dev/null 2>&1 && gh auth status --hostname github.com >/dev/null 2>&1; then
      token="$(gh auth token --hostname github.com)"
    fi
    if [[ -n "$token" ]]; then
      token_file="/run/user/$runtime_uid/.my-opencode-gh-token.${BASHPID}.${RANDOM}"
      printf '%s' "$token" | sudo -H -u "$RUNTIME_USER" sh -c 'umask 077; cat > "$1"' sh "$token_file"
      pass_env+=("OPENCODE_INSTALL_GH_TOKEN_FILE=$token_file")
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
  [[ -z "$token_file" ]] || sudo -H -u "$RUNTIME_USER" rm -f -- "$token_file" >/dev/null 2>&1 || true
  exit "$rc"
}
reexec_as_runtime_user "$@"

if [[ -n "${OPENCODE_INSTALL_GH_TOKEN_FILE:-}" ]]; then
  [[ -r "$OPENCODE_INSTALL_GH_TOKEN_FILE" ]] || { echo 'Temporary GitHub token handoff is unreadable.' >&2; exit 1; }
  export GH_TOKEN="$(cat -- "$OPENCODE_INSTALL_GH_TOKEN_FILE")"
  rm -f -- "$OPENCODE_INSTALL_GH_TOKEN_FILE"
  unset OPENCODE_INSTALL_GH_TOKEN_FILE
fi

if [[ "$HOME" != "$RUNTIME_HOME" ]]; then
  echo "Invalid HOME for runtime user '$RUNTIME_USER': HOME='$HOME', expected='$RUNTIME_HOME'." >&2
  exit 2
fi
if ! command -v sudo >/dev/null ||
   ! sudo -n /usr/local/sbin/opencode-install-packages --check >/dev/null 2>&1 ||
   ! sudo -n /usr/local/sbin/opencode-runtime-cutover --check >/dev/null 2>&1; then
  echo 'Runtime sudo helpers are not configured. Run scripts/migrate-root-runtime-to-opencode.sh or scripts/setup-opencode-package-sudo.sh once with sudo/root.' >&2
  exit 2
fi

CONFIG_REPO="${OPENCODE_CONFIG_REPO:-gest0r1/my-opencode}"
CONFIG_REF="${OPENCODE_CONFIG_REF:-${MY_OPENCODE_REF:-main}}"
APP_REPO="${OPENCHAMBER_REPO:-gest0r1/openchamber-ru}"
APP_REF="${OPENCHAMBER_REF:-main}"
EXPECTED_OPENCHAMBER_VERSION="${OPENCHAMBER_EXPECTED_VERSION:-2.1.0}"
OPENCHAMBER_RUNTIME_ROOT="${OPENCHAMBER_RUNTIME_ROOT:-$HOME/.local/share/openchamber-v2}"
LEGACY_BUN_INSTALL="${LEGACY_BUN_INSTALL:-$HOME/.bun}"
STATE_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/my-opencode"
STATE="$STATE_ROOT/openchamber-v2-install.state"
HOST="${OPENCHAMBER_BIND_HOST:-172.18.0.1}"
PORT="${OPENCHAMBER_BIND_PORT:-3000}"
for cmd in gh mktemp readlink ln mv cp rm sed flock curl systemctl; do
  command -v "$cmd" >/dev/null || { echo "Missing prerequisite: $cmd" >&2; exit 1; }
done
TMP="$(mktemp -d /tmp/openchamber-v2.XXXXXXXX)"
trap 'rm -rf -- "$TMP"' EXIT
CONFIG_SHA="$(gh api "repos/$CONFIG_REPO/commits/$CONFIG_REF" --jq .sha)"
APP_SHA="$(gh api "repos/$APP_REPO/commits/$APP_REF" --jq .sha)"
[[ "$CONFIG_SHA" =~ ^[a-f0-9]{40}$ && "$APP_SHA" =~ ^[a-f0-9]{40}$ ]] || { echo 'Invalid resolved SHA' >&2; exit 1; }
for file in install-openchamber-v2-core.sh openchamber-runtime-store.sh; do
  gh api -H 'Accept: application/vnd.github.raw' "repos/$CONFIG_REPO/contents/scripts/$file?ref=$CONFIG_SHA" > "$TMP/$file"
done
export OPENCODE_CONFIG_REF="$CONFIG_SHA" MY_OPENCODE_REF="$CONFIG_SHA" OPENCHAMBER_REF="$APP_SHA"
export EXPECTED_OPENCHAMBER_VERSION OPENCHAMBER_RUNTIME_ROOT LEGACY_BUN_INSTALL
source "$TMP/openchamber-runtime-store.sh"
oc_runtime_init
mkdir -p "$STATE_ROOT"
exec 8>"$STATE_ROOT/openchamber-v2-atomic.lock"
flock -x 8
# Preserve native configuration; explicit caller values win.
NATIVE_ENV="$HOME/.config/openchamber/startup.env"
LEGACY_ENV="$HOME/.config/openchamber-live.env"
read_env_value() {
  [[ -f "$1" ]] || return 0
  (set +u; unset "$2"; source "$1" >/dev/null 2>&1; printf '%s' "${!2:-}")
}
for key in OPENCHAMBER_UI_PASSWORD OPENCHAMBER_DATA_DIR OPENCHAMBER_API_ONLY; do
  if [[ -z "${!key:-}" ]]; then
    value="$(read_env_value "$NATIVE_ENV" "$key")"
    if [[ -z "$value" && "$key" == OPENCHAMBER_UI_PASSWORD ]]; then value="$(read_env_value "$LEGACY_ENV" "$key")"; fi
    [[ -z "$value" ]] || export "$key=$value"
  fi
done
if [[ "$HOST" != 127.0.0.1 && "$HOST" != localhost && -z "${OPENCHAMBER_UI_PASSWORD:-}" ]]; then
  export OPENCHAMBER_UI_PASSWORD="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
fi
export OPENCODE_BINARY="$HOME/.opencode/bin/opencode"
RELEASE_DIR="$OPENCHAMBER_RELEASES/$APP_SHA"
export BUN_INSTALL="$RELEASE_DIR"
export PATH="$BUN_INSTALL/bin:$HOME/.local/bin:$HOME/.opencode/bin:$LEGACY_BUN_INSTALL/bin:$PATH"
[[ ! -f "$STATE" ]] || cp -p "$STATE" "$TMP/state.before"
bash +h "$TMP/install-openchamber-v2-core.sh" "$@"
state_value() { [[ ! -f "$STATE" ]] || sed -n "s/^$1=//p" "$STATE" | head -1; }
if [[ "$(state_value effective_restart_mode)" == defer ]]; then
  echo 'PENDING APPLY: repeat installer from an external console; the old runtime was left running and no service cutover was attempted.'
  exit 0
fi
native_startup() {
  local args=(startup enable --host "$HOST" --port "$PORT" --no-env-snapshot)
  [[ -z "${OPENCHAMBER_UI_PASSWORD:-}" ]] || args+=(--ui-password "$OPENCHAMBER_UI_PASSWORD")
  case "${OPENCHAMBER_API_ONLY:-}" in 1|true|TRUE|yes|YES|on|ON) args+=(--api-only);; esac
  OPENCHAMBER_STARTUP_LAUNCHER="$OPENCHAMBER_MANAGED_BIN" OPENCHAMBER_MIGRATE_MANAGED_STARTUP=1 "$OPENCHAMBER_MANAGED_BIN" "${args[@]}"
}
readiness() {
  local probe_host="$HOST" code attempt
  [[ "$probe_host" != 0.0.0.0 ]] || probe_host=127.0.0.1
  for ((attempt=0;attempt<30;attempt++)); do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "http://$probe_host:$PORT/" 2>"$TMP/readiness-curl.err" || true)"
    if systemctl --user is-active --quiet openchamber.service; then
      case "$code" in 200|301|302|303|307|308|401|403) return 0;; esac
    fi
    sleep 1
  done
  echo "OpenChamber readiness failed after 30 attempts: http://$probe_host:$PORT/ (last HTTP status: ${code:-unknown})" >&2
  [[ ! -s "$TMP/readiness-curl.err" ]] || cat "$TMP/readiness-curl.err" >&2
  systemctl --user status openchamber.service --no-pager -l >&2 || true
  if command -v journalctl >/dev/null; then
    journalctl --user -u openchamber.service -n 50 --no-pager >&2 || true
  fi
  return 1
}
opencode_readiness() {
  local attempt
  for ((attempt=0;attempt<20;attempt++)); do
    systemctl --user is-active --quiet opencode-web.service && return 0
    sleep 1
  done
  echo 'OpenCode user service failed to become active.' >&2
  systemctl --user status opencode-web.service --no-pager -l >&2 || true
  return 1
}

LEGACY_CUTOVER_ACTIVE=0
rollback() {
  local rc=${1:-$?} recovered=0
  trap - ERR INT TERM
  oc_rollback_activation
  if [[ -f "$TMP/state.before" ]]; then cp -p "$TMP/state.before" "$STATE"; else rm -f "$STATE"; fi

  if [[ -x "$OPENCHAMBER_MANAGED_BIN" ]]; then
    if systemctl --user enable --now opencode-web.service >/dev/null 2>&1 && opencode_readiness && native_startup && readiness; then
      recovered=1
    else
      echo 'Previous user runtime recovery failed' >&2
    fi
  fi

  if (( LEGACY_CUTOVER_ACTIVE == 1 )); then
    if (( recovered == 1 )); then
      sudo -n /usr/local/sbin/opencode-runtime-cutover legacy-commit || true
    else
      systemctl --user disable --now openchamber.service >/dev/null 2>&1 || true
      systemctl --user disable --now opencode-web.service >/dev/null 2>&1 || true
      sudo -n /usr/local/sbin/opencode-runtime-cutover legacy-restore || true
    fi
  fi
  exit "$rc"
}
trap 'rollback $?' ERR
trap 'rollback 130' INT
trap 'rollback 143' TERM

# Arm rollback before privileged cutover: even a partially failed legacy-stop
# is followed by legacy-restore from the ERR trap.
LEGACY_CUTOVER_ACTIVE=1
sudo -n /usr/local/sbin/opencode-runtime-cutover legacy-stop
systemctl --user daemon-reload
systemctl --user enable --now opencode-web.service >/dev/null
opencode_readiness

if [[ -x "$RELEASE_DIR/bin/openchamber" ]]; then
  if [[ "$(readlink -f "$OPENCHAMBER_CURRENT" 2>/dev/null || true)" != "$RELEASE_DIR" ]]; then oc_activate_release "$RELEASE_DIR"; fi
fi
[[ -x "$OPENCHAMBER_CURRENT_BIN" ]] || { echo 'No validated current runtime' >&2; false; }
oc_write_managed_launcher
native_startup
readiness
systemctl --user is-enabled --quiet openchamber.service || { echo 'OpenChamber autostart is not enabled' >&2; false; }
systemctl --user is-enabled --quiet opencode-web.service || { echo 'OpenCode autostart is not enabled' >&2; false; }
oc_prune_releases
oc_commit_activation
sudo -n /usr/local/sbin/opencode-runtime-cutover legacy-commit
LEGACY_CUTOVER_ACTIVE=0
trap - ERR INT TERM
# Core metadata is committed only after native startup readiness.
sed -i 's/^service_restart_pending=.*/service_restart_pending=0/' "$STATE"
oc_remove_legacy_bun_global
echo "OpenChamber runtime committed: $(readlink -f "$OPENCHAMBER_CURRENT")"
echo "Autostart enabled for OpenCode and OpenChamber under user $RUNTIME_USER."
