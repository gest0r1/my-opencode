#!/usr/bin/env bash
# Exact-SHA OpenChamber/OpenCode delivery. Native OpenChamber startup owns its
# service lifecycle; no legacy root runtime migration/cutover is performed.
set -Eeuo pipefail

# The supported distribution entrypoint now coordinates two independent UIDs.
# OpenCode installer retains opencode, OpenChamber and approval broker use root.
# Existing legacy shell code below is retained temporarily for installer
# fixture compatibility; it is not an executable installation path.
if [[ "${EUID}" == 0 ]]; then
  CONFIG_REPO="${OPENCODE_CONFIG_REPO:-gest0r1/my-opencode}"
  CONFIG_REF="${OPENCODE_CONFIG_REF:-${MY_OPENCODE_REF:-main}}"
  [[ "$CONFIG_REF" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$ && "$CONFIG_REF" != *..* && "$CONFIG_REF" != *//* ]] || {
    echo 'INSTALL_SOURCE_REF_INVALID' >&2; exit 2;
  }
  for tool in gh mktemp chmod bash; do command -v "$tool" >/dev/null || exit 2; done
  CONFIG_SHA="$(gh api "repos/$CONFIG_REPO/commits/$CONFIG_REF" --jq .sha)"
  [[ "$CONFIG_SHA" =~ ^[a-f0-9]{40}$ ]] || { echo 'CONFIG_SHA_INVALID' >&2; exit 2; }
  COORDINATOR="$(mktemp /tmp/openchamber-root-coordinator.XXXXXXXX)"
  trap 'rm -f -- "$COORDINATOR"' EXIT
  gh api -H 'Accept: application/vnd.github.raw' \
    "repos/$CONFIG_REPO/contents/scripts/install-openchamber-root.sh?ref=$CONFIG_SHA" > "$COORDINATOR"
  # A unique pinned coordinator resolves and installs the same exact SHA.
  OPENCODE_CONFIG_REF="$CONFIG_SHA" bash "$COORDINATOR" "$@"
  exit $?
fi
echo 'OpenChamber installation requires root; run the canonical installer with sudo/root. OpenCode itself remains opencode.' >&2
exit 2


RUNTIME_USER="${OPENCODE_RUNTIME_USER:-opencode}"
[[ "$RUNTIME_USER" == opencode ]] || {
  echo "Invalid runtime user '$RUNTIME_USER': required name is exactly opencode" >&2
  exit 2
}
for cmd in id getent cut; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing prerequisite: $cmd" >&2; exit 1; }
done

# Refs are written verbatim into a line-based state file. Refuse line/field
# injection (and malformed Git refs) before any install side effect.
valid_install_source_ref() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$ ]] &&
    [[ "$1" != *..* && "$1" != *//* && "$1" != */ ]]
}
REQUESTED_CONFIG_REF="${OPENCODE_CONFIG_REF:-${MY_OPENCODE_REF:-main}}"
REQUESTED_APP_REF="${OPENCHAMBER_REF:-main}"
for source_ref in "$REQUESTED_CONFIG_REF" "$REQUESTED_APP_REF"; do
  valid_install_source_ref "$source_ref" || { echo 'INSTALL_SOURCE_REF_INVALID: requested ref contains unsafe characters' >&2; exit 2; }
done
CURRENT_USER="$(id -un)"
RUNTIME_HOME="$(getent passwd "$RUNTIME_USER" | cut -d: -f6 || true)"
[[ -n "$RUNTIME_HOME" || "$CURRENT_USER" != "$RUNTIME_USER" ]] || {
  echo "Runtime user '$RUNTIME_USER' does not exist." >&2
  exit 2
}

reexec_as_runtime_user() {
  [[ "$CURRENT_USER" != "$RUNTIME_USER" ]] || return 0
  for cmd in sudo loginctl systemctl mktemp cp chmod rm gh; do
    command -v "$cmd" >/dev/null 2>&1 || {
      echo "Missing prerequisite for user switch: $cmd" >&2
      exit 1
    }
  done
  sudo -v || {
    echo "Current user '$CURRENT_USER' must have sudo rights." >&2
    exit 2
  }

  # Permanent bootstrap only: create/refresh opencode and its narrow package
  # helper from the same immutable configuration SHA.
  local provision_dir provision_sha provision_repo provision_ref file
  provision_repo="${OPENCODE_CONFIG_REPO:-gest0r1/my-opencode}"
  provision_ref="$REQUESTED_CONFIG_REF"
  provision_sha="$(gh api "repos/$provision_repo/commits/$provision_ref" --jq .sha)"
  [[ "$provision_sha" =~ ^[a-f0-9]{40}$ ]] || exit 1
  provision_dir="$(mktemp -d /tmp/my-opencode-provision.XXXXXXXX)"
  chmod 755 "$provision_dir"
  for file in provision-runtime-user.sh setup-opencode-package-sudo.sh setup-opencode-deploy-sudo.sh; do
    gh api -H 'Accept: application/vnd.github.raw' \
      "repos/$provision_repo/contents/scripts/$file?ref=$provision_sha" > "$provision_dir/$file"
    chmod 755 "$provision_dir/$file"
  done
  sudo env -i PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    bash "$provision_dir/provision-runtime-user.sh"
  rm -rf -- "$provision_dir"

  RUNTIME_HOME="$(getent passwd "$RUNTIME_USER" | cut -d: -f6)"
  [[ -n "$RUNTIME_HOME" ]] || {
    echo "Runtime user '$RUNTIME_USER' was not provisioned." >&2
    exit 2
  }

  local runtime_uid script_copy rc token name source_file token_file=''
  local -a pass_env=("OPENCODE_CONFIG_REF=$provision_sha" "MY_OPENCODE_REF=$provision_sha"
    "OPENCODE_CONFIG_SOURCE_REF=$REQUESTED_CONFIG_REF" "OPENCHAMBER_SOURCE_REF=$REQUESTED_APP_REF"
    "OPENCHAMBER_REF=$REQUESTED_APP_REF")
  runtime_uid="$(id -u "$RUNTIME_USER")"
  sudo loginctl enable-linger "$RUNTIME_USER" >/dev/null
  sudo systemctl start "user@${runtime_uid}.service"

  script_copy="$(mktemp /tmp/openchamber-install.XXXXXXXX)"
  source_file="${BASH_SOURCE[0]:-}"
  if [[ -n "$source_file" && -f "$source_file" ]]; then
    cp -- "$source_file" "$script_copy"
  else
    gh api -H 'Accept: application/vnd.github.raw' \
      "repos/$provision_repo/contents/install-openchamber.sh?ref=$provision_sha" > "$script_copy"
  fi
  chmod 755 "$script_copy"

  for name in $(compgen -e); do
    case "$name" in
      OPENCODE_CONFIG_REF|MY_OPENCODE_REF|OPENCHAMBER_REF|OPENCODE_CONFIG_SOURCE_REF|OPENCHAMBER_SOURCE_REF) continue ;;
      OPENCODE_*|OPENCHAMBER_*|EXPECTED_OPENCHAMBER_VERSION|GH_HOST|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy)
        pass_env+=("$name=${!name}")
        ;;
    esac
  done

  if ! sudo -H -u "$RUNTIME_USER" env -i \
      HOME="$RUNTIME_HOME" USER="$RUNTIME_USER" LOGNAME="$RUNTIME_USER" \
      PATH="$RUNTIME_HOME/.local/bin:$RUNTIME_HOME/.opencode/bin:$RUNTIME_HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin" \
      XDG_RUNTIME_DIR="/run/user/$runtime_uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$runtime_uid/bus" \
      gh auth status --hostname github.com >/dev/null 2>&1; then
    if [[ -n "${GH_TOKEN:-}" ]]; then
      token="$GH_TOKEN"
    elif gh auth status --hostname github.com >/dev/null 2>&1; then
      token="$(gh auth token --hostname github.com)"
    fi
    if [[ -n "${token:-}" ]]; then
      token_file="/run/user/$runtime_uid/.my-opencode-gh-token.${BASHPID}.${RANDOM}"
      printf '%s' "$token" | sudo -H -u "$RUNTIME_USER" sh -c \
        'cd "$HOME"; umask 077; cat > "$1"' sh "$token_file"
      pass_env+=("OPENCODE_INSTALL_GH_TOKEN_FILE=$token_file")
    fi
  fi

  echo "Switching installer runtime: $CURRENT_USER -> $RUNTIME_USER"
  if sudo -H -u "$RUNTIME_USER" env -i \
      HOME="$RUNTIME_HOME" USER="$RUNTIME_USER" LOGNAME="$RUNTIME_USER" \
      PATH="$RUNTIME_HOME/.local/bin:$RUNTIME_HOME/.opencode/bin:$RUNTIME_HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin" \
      XDG_RUNTIME_DIR="/run/user/$runtime_uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$runtime_uid/bus" \
      "${pass_env[@]}" bash -c 'cd "$HOME"; exec bash "$@"' bash "$script_copy" "$@"; then
    rc=0
  else
    rc=$?
  fi
  rm -f -- "$script_copy"
  [[ -z "$token_file" ]] || sudo -H -u "$RUNTIME_USER" rm -f -- "$token_file" >/dev/null 2>&1 || true
  exit "$rc"
}
reexec_as_runtime_user "$@"

cd "$RUNTIME_HOME"
export XDG_CONFIG_HOME="$HOME/.config" XDG_DATA_HOME="$HOME/.local/share" XDG_STATE_HOME="$HOME/.local/state"

if [[ -n "${OPENCODE_INSTALL_GH_TOKEN_FILE:-}" ]]; then
  [[ -r "$OPENCODE_INSTALL_GH_TOKEN_FILE" ]] || {
    echo 'Temporary GitHub token handoff is unreadable.' >&2
    exit 1
  }
  export GH_TOKEN="$(cat -- "$OPENCODE_INSTALL_GH_TOKEN_FILE")"
  rm -f -- "$OPENCODE_INSTALL_GH_TOKEN_FILE"
  unset OPENCODE_INSTALL_GH_TOKEN_FILE
fi

if [[ "$HOME" != "$RUNTIME_HOME" ]]; then
  echo "Invalid HOME for runtime user '$RUNTIME_USER': HOME='$HOME', expected='$RUNTIME_HOME'." >&2
  exit 2
fi
if ! command -v sudo >/dev/null ||
   ! sudo -n /usr/local/sbin/opencode-install-packages --check >/dev/null 2>&1; then
  echo 'Package-install helper is not configured. Run scripts/setup-opencode-package-sudo.sh once with sudo/root.' >&2
  exit 2
fi

CONFIG_REPO="${OPENCODE_CONFIG_REPO:-gest0r1/my-opencode}"
CONFIG_REF="${OPENCODE_CONFIG_REF:-${MY_OPENCODE_REF:-main}}"
CONFIG_SOURCE_REF="${OPENCODE_CONFIG_SOURCE_REF:-$REQUESTED_CONFIG_REF}"
APP_REPO="${OPENCHAMBER_REPO:-gest0r1/openchamber-ru}"
APP_REF="${OPENCHAMBER_REF:-main}"
APP_SOURCE_REF="${OPENCHAMBER_SOURCE_REF:-$REQUESTED_APP_REF}"
for source_ref in "$CONFIG_SOURCE_REF" "$APP_SOURCE_REF" "$CONFIG_REF" "$APP_REF"; do
  valid_install_source_ref "$source_ref" || { echo 'INSTALL_SOURCE_REF_INVALID: unsafe forwarded or pinned ref' >&2; exit 2; }
done
export OPENCODE_INSTALL_VERSION="${OPENCODE_INSTALL_VERSION:-2.2.7}"
export OPENCHAMBER_EXPECTED_VERSION="${OPENCHAMBER_EXPECTED_VERSION:-2.7.1}"
EXPECTED_OPENCHAMBER_VERSION="$OPENCHAMBER_EXPECTED_VERSION"
OPENCHAMBER_RUNTIME_ROOT="${OPENCHAMBER_RUNTIME_ROOT:-$HOME/.local/share/openchamber-v2}"
STATE_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/my-opencode"
STATE="$STATE_ROOT/openchamber-v2-install.state"
HOST="${OPENCHAMBER_BIND_HOST:-0.0.0.0}"
PORT="${OPENCHAMBER_BIND_PORT:-3000}"

for cmd in gh mktemp readlink ln mv cp rm sed flock curl systemctl date stat; do
  command -v "$cmd" >/dev/null || { echo "Missing prerequisite: $cmd" >&2; exit 1; }
done

TMP="$(mktemp -d /tmp/openchamber-v2.XXXXXXXX)"
trap 'rm -rf -- "$TMP"' EXIT

CONFIG_SHA="$(gh api "repos/$CONFIG_REPO/commits/$CONFIG_REF" --jq .sha)"
APP_SHA="$(gh api "repos/$APP_REPO/commits/$APP_REF" --jq .sha)"
[[ "$CONFIG_SHA" =~ ^[a-f0-9]{40}$ && "$APP_SHA" =~ ^[a-f0-9]{40}$ ]] || {
  echo 'Invalid resolved SHA' >&2
  exit 1
}

for file in install-openchamber-v2-core.sh openchamber-runtime-store.sh bootstrap-runtime-tools.sh runtime-processes.py install-journal.sh; do
  gh api -H 'Accept: application/vnd.github.raw' \
    "repos/$CONFIG_REPO/contents/scripts/$file?ref=$CONFIG_SHA" > "$TMP/$file"
done

source "$TMP/bootstrap-runtime-tools.sh"
ensure_runtime_toolchain 24.14.0
source "$TMP/install-journal.sh"

export OPENCODE_CONFIG_REF="$CONFIG_SHA" MY_OPENCODE_REF="$CONFIG_SHA" OPENCHAMBER_REF="$APP_SHA"
export OPENCODE_CONFIG_SOURCE_REF="$CONFIG_SOURCE_REF" OPENCHAMBER_SOURCE_REF="$APP_SOURCE_REF"
export EXPECTED_OPENCHAMBER_VERSION OPENCHAMBER_RUNTIME_ROOT
source "$TMP/openchamber-runtime-store.sh"
oc_runtime_init

mkdir -p "$STATE_ROOT"
exec 8>"$STATE_ROOT/openchamber-v2-atomic.lock"
flock -x 8

install_journal_event install start "config_ref=$CONFIG_SOURCE_REF" "config_sha=$CONFIG_SHA" \
  "openchamber_ref=$APP_SOURCE_REF" "openchamber_sha=$APP_SHA" \
  "restart_mode=${OPENCHAMBER_RESTART_MODE:-auto}"

# Preserve native configuration; explicit caller values win.
NATIVE_ENV="$HOME/.config/openchamber/startup.env"
read_env_value() {
  [[ -f "$1" ]] || return 0
  (set +u; unset "$2"; source "$1" >/dev/null 2>&1; printf '%s' "${!2:-}")
}
for key in OPENCHAMBER_UI_PASSWORD OPENCHAMBER_DATA_DIR OPENCHAMBER_API_ONLY; do
  if [[ -z "${!key:-}" ]]; then
    value="$(read_env_value "$NATIVE_ENV" "$key")"
    [[ -z "$value" ]] || export "$key=$value"
  fi
done
if [[ "$HOST" != 127.0.0.1 && "$HOST" != localhost && -z "${OPENCHAMBER_UI_PASSWORD:-}" ]]; then
  export OPENCHAMBER_UI_PASSWORD="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
fi

export OPENCODE_BINARY="$HOME/.opencode/bin/opencode"
RELEASE_DIR="$OPENCHAMBER_RELEASES/$APP_SHA"
export BUN_INSTALL="$RELEASE_DIR"
export PATH="$BUN_INSTALL/bin:$HOME/.local/bin:$HOME/.opencode/bin:$HOME/.bun/bin:$PATH"

[[ ! -f "$STATE" ]] || cp -p "$STATE" "$TMP/state.before"
core_rc=0
bash +h "$TMP/install-openchamber-v2-core.sh" "$@" || core_rc=$?
if (( core_rc != 0 )); then
  install_journal_event install failed "config_ref=$CONFIG_SOURCE_REF" "config_sha=$CONFIG_SHA" \
    "openchamber_ref=$APP_SOURCE_REF" "openchamber_sha=$APP_SHA" "exit_code=$core_rc" reason=core_failure || true
  exit "$core_rc"
fi

state_value() {
  [[ ! -f "$STATE" ]] || sed -n "s/^$1=//p" "$STATE" | head -1
}
if [[ "$(state_value effective_restart_mode)" == defer ]]; then
  sed -i 's/^activation_status=.*/activation_status=pending_restart/' "$STATE"
  install_journal_event activation pending_restart "config_sha=$CONFIG_SHA" "openchamber_sha=$APP_SHA" reason=deferred_restart || true
  echo 'PENDING APPLY: runtime/service restart was deferred to protect the embedded OpenChamber terminal.'
  exit 0
fi

native_startup() {
  local args=(startup enable --host "$HOST" --port "$PORT" --no-env-snapshot)
  [[ -z "${OPENCHAMBER_UI_PASSWORD:-}" ]] || args+=(--ui-password "$OPENCHAMBER_UI_PASSWORD")
  case "${OPENCHAMBER_API_ONLY:-}" in
    1|true|TRUE|yes|YES|on|ON) args+=(--api-only) ;;
  esac
  OPENCHAMBER_STARTUP_LAUNCHER="$OPENCHAMBER_MANAGED_BIN" \
    OPENCHAMBER_MIGRATE_MANAGED_STARTUP=1 \
    "$OPENCHAMBER_MANAGED_BIN" "${args[@]}"

  mkdir -p "$HOME/.config/systemd/user/openchamber.service.d"
  cat > "$HOME/.config/systemd/user/openchamber.service.d/runtime-env.conf" <<EOF
[Service]
WorkingDirectory=$HOME
Environment="HOME=$HOME" "PATH=$HOME/.local/bin:$HOME/.opencode/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"
Environment="OPENCODE_BINARY=$OPENCODE_BINARY"
Environment="XDG_CONFIG_HOME=$HOME/.config" "XDG_DATA_HOME=$HOME/.local/share" "XDG_STATE_HOME=$HOME/.local/state"
EOF
  systemctl --user daemon-reload
  systemctl --user restart openchamber.service
}

readiness() {
  local probe_host="$HOST" code attempt
  [[ "$probe_host" != 0.0.0.0 ]] || probe_host=127.0.0.1
  for ((attempt=0; attempt<30; attempt++)); do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 \
      "http://$probe_host:$PORT/" 2>"$TMP/readiness-curl.err" || true)"
    if systemctl --user is-active --quiet openchamber.service; then
      case "$code" in
        200|301|302|303|307|308|401|403) return 0 ;;
      esac
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
  for ((attempt=0; attempt<20; attempt++)); do
    systemctl --user is-active --quiet opencode-web.service && return 0
    sleep 1
  done
  echo 'OpenCode user service failed to become active.' >&2
  systemctl --user status opencode-web.service --no-pager -l >&2 || true
  return 1
}

rollback() {
  local rc=${1:-$?}
  trap - ERR INT TERM
  oc_rollback_activation || echo 'WARN: activation rollback failed; continue state recovery' >&2
  if [[ -f "$TMP/state.before" ]]; then
    cp -p "$TMP/state.before" "$STATE" || echo 'WARN: previous install state could not be restored' >&2
  else
    rm -f "$STATE" || true
  fi

  # Restore the previously committed user runtime when possible. There is no
  # fallback to an old root runtime.
  if [[ -x "$OPENCHAMBER_CURRENT_BIN" ]]; then
    systemctl --user enable --now opencode-web.service >/dev/null 2>&1 || true
    opencode_readiness || true
    native_startup || true
    readiness || true
  fi
  (( rc == 0 )) || install_journal_event install failed "config_ref=$CONFIG_SOURCE_REF" "config_sha=$CONFIG_SHA" \
    "openchamber_ref=$APP_SOURCE_REF" "openchamber_sha=$APP_SHA" "exit_code=$rc" reason=rollback || true
  exit "$rc"
}
trap 'rollback $?' ERR
trap 'rollback 130' INT
trap 'rollback 143' TERM

configure_server_browser

systemctl --user daemon-reload
systemctl --user enable --now opencode-web.service >/dev/null
opencode_readiness

if [[ -x "$RELEASE_DIR/bin/openchamber" ]]; then
  if [[ "$(readlink -f "$OPENCHAMBER_CURRENT" 2>/dev/null || true)" != "$RELEASE_DIR" ]]; then
    oc_activate_release "$RELEASE_DIR"
  fi
fi
[[ -x "$OPENCHAMBER_CURRENT_BIN" ]] || {
  echo 'No validated current runtime' >&2
  false
}

oc_write_managed_launcher
native_startup
readiness

systemctl --user is-enabled --quiet openchamber.service || {
  echo 'OpenChamber autostart is not enabled' >&2
  false
}
systemctl --user is-enabled --quiet opencode-web.service || {
  echo 'OpenCode autostart is not enabled' >&2
  false
}

# Readiness must survive another service restart before the runtime is committed.
systemctl --user restart opencode-web.service openchamber.service
opencode_readiness
readiness

oc_prune_releases
oc_commit_activation
trap - ERR INT TERM

# Core metadata is committed only after native startup readiness.
sed -i -e 's/^service_restart_pending=.*/service_restart_pending=0/' \
  -e 's/^activation_status=.*/activation_status=activated/' \
  -e 's/^installation_status=.*/installation_status=delivered/' "$STATE"
install_journal_event activation activated "config_ref=$CONFIG_SOURCE_REF" "config_sha=$CONFIG_SHA" \
  "openchamber_ref=$APP_SOURCE_REF" "openchamber_sha=$APP_SHA" "runtime=$(readlink -f "$OPENCHAMBER_CURRENT")" || true
echo "OpenChamber runtime committed: $(readlink -f "$OPENCHAMBER_CURRENT")"
echo "Autostart enabled for OpenCode and OpenChamber under user $RUNTIME_USER."

