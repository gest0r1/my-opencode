#!/usr/bin/env bash
# Exact-SHA delivery and binary-only atomic activation. Native CLI owns services.
set -Eeuo pipefail
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
for cmd in gh mktemp readlink ln mv cp rm sed flock curl; do
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
  echo 'PENDING APPLY: repeat installer from an external console with OPENCHAMBER_RESTART_MODE=now'
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
rollback() {
  local rc=${1:-$?}
  trap - ERR INT TERM
  oc_rollback_activation
  if [[ -f "$TMP/state.before" ]]; then cp -p "$TMP/state.before" "$STATE"; else rm -f "$STATE"; fi
  if [[ -x "$OPENCHAMBER_MANAGED_BIN" ]]; then
    native_startup && readiness || echo 'Previous binary restored; native service recovery failed' >&2
  fi
  exit "$rc"
}
trap 'rollback $?' ERR
trap 'rollback 130' INT
trap 'rollback 143' TERM
if [[ -x "$RELEASE_DIR/bin/openchamber" ]]; then
  if [[ "$(readlink -f "$OPENCHAMBER_CURRENT" 2>/dev/null || true)" != "$RELEASE_DIR" ]]; then oc_activate_release "$RELEASE_DIR"; fi
fi
[[ -x "$OPENCHAMBER_CURRENT_BIN" ]] || { echo 'No validated current runtime' >&2; false; }
oc_write_managed_launcher
native_startup
readiness
oc_prune_releases
oc_commit_activation
trap - ERR INT TERM
# Core metadata is committed only after native startup readiness.
sed -i 's/^service_restart_pending=.*/service_restart_pending=0/' "$STATE"
oc_remove_legacy_bun_global
echo "OpenChamber runtime committed: $(readlink -f "$OPENCHAMBER_CURRENT")"
