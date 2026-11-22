#!/usr/bin/env bash
# Root-owned OpenChamber delivery, with the OpenCode runtime left under opencode.
# This script is invoked from the canonical wrapper after the opencode config
# has been installed. Version switching and cutover are distinct transactions.
set -Eeuo pipefail
[[ $EUID == 0 ]] || { echo 'Root OpenChamber installation must be invoked by root coordinator' >&2; exit 2; }
umask 077

CONFIG_REPO="${OPENCODE_CONFIG_REPO:-gest0r1/my-opencode}"
CONFIG_REF="${OPENCODE_CONFIG_REF:-main}"
APP_REPO="${OPENCHAMBER_REPO:-gest0r1/openchamber-ru}"
APP_REF="${OPENCHAMBER_REF:-main}"
OPENCODE_USER=opencode

for tool in gh systemctl sudo python3 curl flock sha256sum tar setpriv install stat; do command -v "$tool" >/dev/null || { echo "Missing $tool" >&2; exit 2; }; done

gh auth status --hostname github.com >/dev/null 2>&1 || { echo 'GitHub CLI authorization required for root installer' >&2; exit 2; }
CONFIG_SHA="$(gh api "repos/$CONFIG_REPO/commits/$CONFIG_REF" --jq .sha)"
APP_SHA="$(gh api "repos/$APP_REPO/commits/$APP_REF" --jq .sha)"
[[ "$CONFIG_SHA" =~ ^[a-f0-9]{40}$ && "$APP_SHA" =~ ^[a-f0-9]{40}$ ]] || exit 2

ROOT_STATE=/var/lib/my-opencode/openchamber-root-installer
mkdir -p "$ROOT_STATE"
chmod 700 "$ROOT_STATE"
exec 9>"$ROOT_STATE/install.lock"
flock -x 9
TMP="$(mktemp -d /tmp/my-openchamber-root.XXXXXXXX)"
trap 'rm -rf -- "$TMP"' EXIT
fetch() {
  local path=$1 dest=$2
  gh api -H 'Accept: application/vnd.github.raw' \
    "repos/$CONFIG_REPO/contents/$path?ref=$CONFIG_SHA" > "$dest"
}
for file in install-openchamber-v2-core.sh openchamber-runtime-store.sh bootstrap-runtime-tools.sh runtime-processes.py install-journal.sh opencode-owner-approvald.py opencode-owner-approval.py openchamber-child-boundary.cjs opencode-unpriv-wrapper.sh; do
  fetch "scripts/$file" "$TMP/$file"
done
fetch scripts/migrate-openchamber-to-root.py "$TMP/migrate.py"
fetch scripts/rekey-openchamber-ui.py "$TMP/rekey.py"
fetch config/systemd/openchamber-root.service "$TMP/openchamber.service"
fetch config/systemd/opencode-owner-approval.service "$TMP/owner-broker.service"
fetch install.sh "$TMP/install-opencode.sh"

# Reuse the canonical OpenCode installer under the existing opencode UID.
# This call does not launch OpenChamber or move OpenCode databases.
OPENCODE_CONFIG_REF="$CONFIG_SHA" MY_OPENCODE_REF="$CONFIG_SHA" bash "$TMP/install-opencode.sh"
OPENCODE_HOME="$(getent passwd "$OPENCODE_USER" | cut -d: -f6)"
[[ -d "$OPENCODE_HOME" && "$OPENCODE_HOME" != /root ]] || { echo 'Missing unprivileged OpenCode runtime user' >&2; exit 2; }

# OpenCode remains a systemd --user unit for opencode; never reboot/restart it
# from the OpenChamber release transaction.
OPENCODE_UID="$(id -u "$OPENCODE_USER")"
run_oc_user() {
  sudo -H -u opencode env XDG_RUNTIME_DIR="/run/user/$OPENCODE_UID" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$OPENCODE_UID/bus" "$@"
}
run_oc_user systemctl --user is-active --quiet opencode-web.service || {
  echo 'OpenCode service is not active. Install/start it separately under opencode before cutover.' >&2
  exit 2
}

# Root runtime has its own verified Node distribution. Never execute the
# agent-writable /home/opencode node binary as root.
root_node_version_ok() {
  command -v node >/dev/null && node -e 'const a=process.versions.node.split(".").map(Number);process.exit(a[0]>24||(a[0]===24&&a[1]>=14)?0:1)' >/dev/null 2>&1
}
ensure_root_node() {
  if root_node_version_ok; then return 0; fi
  local version=24.21.0 name="node-v24.21.0-linux-x64.tar.xz" dest=/opt/my-openchamber/node-v24.21.0
  if [[ ! -x "$dest/bin/node" ]]; then
    local tmp; tmp="$(mktemp -d /tmp/openchamber-node.XXXXXXXX)"
    (cd "$tmp" && curl -fsSLO "https://nodejs.org/dist/v$version/$name" && \
      curl -fsSLO "https://nodejs.org/dist/v$version/SHASUMS256.txt" && \
      grep -F "  $name" SHASUMS256.txt > node.sha && sha256sum -c node.sha && \
      tar -xJf "$name" && install -d -m 755 /opt/my-openchamber && \
      mv "node-v$version-linux-x64" "$dest") || { rm -rf -- "$tmp"; return 1; }
    rm -rf -- "$tmp"
  fi
  export PATH="$dest/bin:$PATH"
  root_node_version_ok
}
ensure_root_node

# OpenCode stays on its existing authentication policy. Do not rotate or restart
# the running service just to migrate OpenChamber: that would invalidate live
# clients/sessions. The P1 owner trust channel is the independent root broker.
AUTH_FILE=/etc/my-opencode/openchamber-connect.env
mkdir -p /etc/my-opencode
chmod 700 /etc/my-opencode
OPENCODE_SERVICE_PASSWORD="$(run_oc_user bash -c 'if [[ -f "$HOME/.config/opencode.env" ]]; then source "$HOME/.config/opencode.env"; fi; printf %s "${OPENCODE_PASSWORD:-${OPENCODE_SERVER_PASSWORD:-}}"' )"
if [[ -n "$OPENCODE_SERVICE_PASSWORD" ]]; then
  curl -fsS --max-time 6 -u "opencode:$OPENCODE_SERVICE_PASSWORD" \
    http://127.0.0.1:4096/api/info -o "$TMP/opencode-info.json" || {
      echo 'OpenCode authentication/readiness failed; refusing root cutover' >&2; exit 3;
    }
  if [[ -f "$AUTH_FILE" ]]; then
    [[ "$(stat -c %u "$AUTH_FILE")" == 0 && "$(stat -c %a "$AUTH_FILE")" =~ ^[460][04]0$ ]] || {
      echo 'External OpenCode auth file must be root-owned and private' >&2; exit 2;
    }
  fi
  # Root-owned transaction replaces the previous credential only after it has
  # been validated against the *existing* OpenCode service.
  ( umask 077; printf 'OPENCODE_PASSWORD=%q\\n' "$OPENCODE_SERVICE_PASSWORD" > "$AUTH_FILE.tmp"; mv -f "$AUTH_FILE.tmp" "$AUTH_FILE" )
  chmod 600 "$AUTH_FILE"
else
  # An unchanged local no-password OpenCode is supported. Only loopback is
  # allowed; UI owner approval still requires root-only socket + fresh auth.
  curl -fsS --max-time 6 http://127.0.0.1:4096/api/info -o "$TMP/opencode-info.json" || {
    echo 'OpenCode external readiness failed; refusing root cutover' >&2; exit 3;
  }
  [[ ! -f "$AUTH_FILE" ]] || rm -f -- "$AUTH_FILE"
fi

# Source package delivery stays independent. Version and source SHA must match
# the verified package manifest; package fallback builds pinned source only.
export XDG_CONFIG_HOME=/root/.config XDG_DATA_HOME=/root/.local/share XDG_STATE_HOME=/root/.local/state
export HOME=/root OPENCODE_BINARY=/usr/local/lib/my-opencode/opencode-unpriv-wrapper.sh
export OPENCHAMBER_ROOT_ONLY=1 OPENCHAMBER_EXECUTION_USER=opencode OPENCHAMBER_ROOT_MODE=separated
export OPENCODE_CONFIG_REF="$CONFIG_SHA" OPENCHAMBER_REF="$APP_SHA"
export OPENCHAMBER_EXPECTED_VERSION="${OPENCHAMBER_EXPECTED_VERSION:-2.7.1}"
export OPENCHAMBER_RUNTIME_ROOT="${OPENCHAMBER_RUNTIME_ROOT:-/root/.local/share/openchamber-v2}"
export PATH="/root/.local/bin:/root/.bun/bin:/root/.opencode/bin:$PATH"
EXPECTED_OPENCHAMBER_VERSION="$OPENCHAMBER_EXPECTED_VERSION"
export EXPECTED_OPENCHAMBER_VERSION
# Privileged installation code and child security interposers are immutable
# from the OpenCode agent's UID.
install -d -o root -g root -m 755 /usr/local/lib/my-opencode
for file in opencode-owner-approval.py opencode-owner-approvald.py openchamber-child-boundary.cjs opencode-unpriv-wrapper.sh; do
  install -o root -g root -m 755 "$TMP/$file" "/usr/local/lib/my-opencode/$file"
done
install -d -o root -g root -m 700 /etc/my-opencode
printf 'OPENCHAMBER_EXECUTION_UID=%s\nOPENCHAMBER_EXECUTION_GID=%s\n' "$(id -u opencode)" "$(id -g opencode)" > /etc/my-opencode/openchamber-execution.env
chmod 600 /etc/my-opencode/openchamber-execution.env
source "$TMP/openchamber-runtime-store.sh"
oc_runtime_init
RELEASE_DIR="$OPENCHAMBER_RELEASES/$APP_SHA"
export BUN_INSTALL="$RELEASE_DIR"
export PATH="$BUN_INSTALL/bin:$PATH"
OPENCHAMBER_PACKAGE_MODE="${OPENCHAMBER_PACKAGE_MODE:-auto}" \
  OPENCHAMBER_RESTART_MODE=now \
  bash "$TMP/install-openchamber-v2-core.sh"

# Core delivered an exact-source SHA release; only activate the validated package.
oc_validate_release "$RELEASE_DIR" || { echo 'Root OpenChamber release validation failed' >&2; exit 3; }
if [[ "$(readlink -f "$OPENCHAMBER_CURRENT" 2>/dev/null || true)" != "$RELEASE_DIR" ]]; then
  oc_activate_release "$RELEASE_DIR"
fi
oc_write_managed_launcher
[[ -x "$OPENCHAMBER_CURRENT_BIN" ]] || { echo 'Root OpenChamber binary is not installed' >&2; exit 3; }

if [[ "${OPENCHAMBER_RESTART_MODE:-auto}" == defer || "${OPENCHAMBER_EMBEDDED_TERMINAL:-0}" == 1 ]]; then
  echo 'PENDING APPLY: installed root runtime staged; do not cut over from an embedded terminal.'
  exit 0
fi

# Require a verified root-safe OpenChamber release and a human-confirmed
# quiescent window; no unprivileged user should be stranded in an active PTY.
if [[ "${OPENCHAMBER_ROOT_RUNTIME_VERIFIED:-0}" != 1 ]]; then
  echo 'PENDING APPLY: root execution boundary not yet accepted (OPENCHAMBER_ROOT_RUNTIME_VERIFIED=1 required).' >&2
  exit 0
fi
if [[ "${OPENCHAMBER_CUTOVER_QUIESCENT:-0}" != 1 ]]; then
  echo 'PENDING APPLY: active OpenChamber terminal state not confirmed quiescent.' >&2
  exit 0
fi

# Roll back only the root OpenChamber package and migration, never the OpenCode
# runtime or its sessions. A failed activation cannot strand the old UI.
old_active=0
cutover_started=0
migration_status=not_required
rollback_cutover() {
  local code=$?
  trap - ERR INT TERM
  if (( cutover_started )); then
    systemctl stop openchamber.service >/dev/null 2>&1 || true
    if [[ "$migration_status" == staged ]]; then python3 "$TMP/migrate.py" rollback || true; fi
    if (( old_active )); then run_oc_user systemctl --user start openchamber.service || true; fi
  fi
  oc_rollback_activation || true
  exit "$code"
}
trap rollback_cutover ERR
trap 'rollback_cutover' INT TERM

# Stop only the old OpenChamber service. Keep OpenCode's server and live RUNs.
cutover_started=1
run_oc_user systemctl --user is-active --quiet openchamber.service && old_active=1 || true
if ((old_active)); then run_oc_user systemctl --user stop openchamber.service; fi
migration_status='not_required'
if [[ -d "$OPENCODE_HOME/.config/openchamber" ]]; then
  migration_status="$(python3 "$TMP/migrate.py" stage --quiescent yes | python3 -c 'import sys,json;print(json.load(sys.stdin)["status"])')"
fi
if [[ "$migration_status" != staged && "$migration_status" != completed && "$migration_status" != not_required ]]; then
  echo 'OpenChamber data migration not staged' >&2; exit 3
fi

# The original OpenChamber UI secret and password were readable under the
# opencode UID. Rotate once after moving the files to root so an agent cannot
# replay a captured UI cookie/password. Existing OpenCode sessions are intact;
# only the OpenChamber UI needs one re-login. Rebind public passkeys, do not
# discard them.
NATIVE_ENV=/root/.config/openchamber/startup.env
if [[ "$migration_status" == staged || ! -f "$NATIVE_ENV" ]]; then
  mkdir -p /root/.config/openchamber
  chmod 700 /root/.config/openchamber
  python3 "$TMP/rekey.py"
fi
[[ -f "$NATIVE_ENV" && "$(stat -c %u "$NATIVE_ENV")" == 0 ]] || {
  echo 'Root OpenChamber authentication configuration unavailable' >&2; exit 3;
}
# Root-owned service; never use root systemd --user and never stop opencode-web.
# Prepare protected P1 broker and root-owned UI. The policy marker is not
# published until the root UI, socket modes and broker all pass readiness.
install -o root -g root -m 644 "$TMP/owner-broker.service" /etc/systemd/system/opencode-owner-approval.service
install -o root -g root -m 644 "$TMP/openchamber.service" /etc/systemd/system/openchamber.service
systemctl daemon-reload
systemctl enable --now opencode-owner-approval.service
for i in {1..20}; do
  [[ -S /run/my-opencode-approval/owner.sock && -S /run/my-opencode-approval/agent.sock ]] && break
  sleep 1
done
[[ -S /run/my-opencode-approval/owner.sock && -S /run/my-opencode-approval/agent.sock ]] || {
  echo 'Owner broker sockets unavailable' >&2; exit 3;
}
[[ "$(stat -c %a /run/my-opencode-approval/owner.sock)" == 600 ]] || {
  echo 'Owner approval socket is not private' >&2; exit 3;
}
systemctl enable --now openchamber.service
# "enable --now" does not reload an existing running root service.
systemctl restart openchamber.service
for i in {1..30}; do
  if systemctl is-active --quiet openchamber.service && \
     curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:"${OPENCHAMBER_BIND_PORT:-3000}"/; then
    if [[ "$migration_status" == staged ]]; then python3 "$TMP/migrate.py" complete --ready yes; fi
    run_oc_user systemctl --user disable openchamber.service >/dev/null || true
    # Enforce broker for every new PLAN/owner-accept at this point.
    install -o root -g root -m 600 /dev/null /etc/my-opencode/owner-broker-required
    printf '%s\n' "$CONFIG_SHA $APP_SHA" > "$ROOT_STATE/active-sha"
    oc_commit_activation
    trap - ERR INT TERM
    echo "ROOT OPENCHAMBER READY config=$CONFIG_SHA app=$APP_SHA"
    exit 0
  fi
  sleep 1
done

echo 'ROOT_OPENCHAMBER_CUTOVER_FAILED: rolling back root cutover' >&2
false