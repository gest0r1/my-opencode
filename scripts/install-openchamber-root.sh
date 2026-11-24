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
for file in install-openchamber-v2-core.sh openchamber-runtime-store.sh bootstrap-runtime-tools.sh runtime-processes.py install-journal.sh opencode-owner-approvald.py opencode-owner-approval.py openchamber-child-boundary.cjs opencode-unpriv-wrapper.sh launch-openchamber-root.sh; do
  fetch "scripts/$file" "$TMP/$file"
done
fetch scripts/migrate-openchamber-to-root.py "$TMP/migrate.py"
fetch scripts/rekey-openchamber-ui.py "$TMP/rekey.py"
fetch scripts/repair-openchamber-root-extensions.py "$TMP/rebase-extensions.py"
fetch config/systemd/openchamber-root.service "$TMP/openchamber.service"
fetch config/systemd/opencode-owner-approval.service "$TMP/owner-broker.service"
fetch install.sh "$TMP/install-opencode.sh"
export HOME=/root XDG_STATE_HOME=/root/.local/state
source "$TMP/install-journal.sh"
# Explicit now permits terminating only the managed services at cutover.
# Never stop the service/cgroup from which this installer was launched.
RESTART_MODE="${OPENCHAMBER_RESTART_MODE:-auto}"
case "$RESTART_MODE" in auto|now|defer) ;; *) echo 'Invalid OPENCHAMBER_RESTART_MODE' >&2; exit 2;; esac
origin="$(python3 "$TMP/runtime-processes.py" --ancestor "$PPID")" || origin=unknown
if [[ "${OPENCHAMBER_EMBEDDED_TERMINAL:-0}" == 1 || "$origin" != external ]]; then
  RESTART_MODE=defer
fi
install_journal_event install start "config_ref=${OPENCODE_CONFIG_SOURCE_REF:-$CONFIG_REF}" "config_sha=$CONFIG_SHA" "openchamber_ref=${OPENCHAMBER_SOURCE_REF:-$APP_REF}" "openchamber_sha=$APP_SHA"

# Reuse the canonical OpenCode installer under the existing opencode UID.
# This call does not launch OpenChamber or move OpenCode databases.
OPENCODE_CONFIG_REF="$CONFIG_SHA" MY_OPENCODE_REF="$CONFIG_SHA" bash "$TMP/install-opencode.sh"
OPENCODE_HOME="$(getent passwd "$OPENCODE_USER" | cut -d: -f6)"
[[ -d "$OPENCODE_HOME" && "$OPENCODE_HOME" != /root ]] || { echo 'Missing unprivileged OpenCode runtime user' >&2; exit 2; }

# OpenCode remains a systemd --user unit for opencode; only the final
# cutover may restart it when the installed version or active RUNs require it.
OPENCODE_UID="$(id -u "$OPENCODE_USER")"
run_oc_user() {
  # Do not inherit runner/root XDG paths. OpenCode 2.3.2 may initialize its
  # config even for --version and must never write to another user's HOME.
  sudo -H -u "$OPENCODE_USER" env HOME="$OPENCODE_HOME" \
    XDG_CONFIG_HOME="$OPENCODE_HOME/.config" \
    XDG_DATA_HOME="$OPENCODE_HOME/.local/share" \
    XDG_STATE_HOME="$OPENCODE_HOME/.local/state" \
    XDG_RUNTIME_DIR="/run/user/$OPENCODE_UID" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$OPENCODE_UID/bus" "$@"
}
if ! run_oc_user systemctl --user is-active --quiet opencode-web.service; then
  # A standalone OpenCode service with no configured credential generates a
  # random password at startup. Establish a stable credential ONLY before
  # first service start; NEVER rotate a running server or break its sessions.
  run_oc_user bash -c '
    set -Eeuo pipefail
    file="$HOME/.config/opencode.env"
    if [[ -L "$file" ]]; then echo "OPENCODE_PASSWORD_FILE_SYMLINK_FORBIDDEN" >&2; exit 3; fi
    mkdir -p "$HOME/.config"
    if [[ -f "$file" ]]; then source "$file"; fi
    if [[ -z "${OPENCODE_PASSWORD:-${OPENCODE_SERVER_PASSWORD:-}}" ]]; then
      generated="$(python3 -c "import secrets; print(secrets.token_urlsafe(36))")"
      (umask 077; printf "OPENCODE_PASSWORD=%s\\n" "$generated" >> "$file")
      chmod 600 "$file"
    fi
  '
  # Fresh installations enable but do not start OpenCode in install.sh.
  # Start only an inactive service; never restart a running OpenCode with
  # potentially active RUNs or session DB writes.
  run_oc_user systemctl --user start opencode-web.service || {
    echo 'OpenCode service failed to start under opencode; refusing root cutover' >&2
    exit 2
  }
fi
run_oc_user systemctl --user is-active --quiet opencode-web.service || {
  echo 'OpenCode service is not active after install' >&2; exit 2
}

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
ensure_root_node

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
ensure_root_bun

# OpenCode stays on its existing authentication policy. Do not rotate or restart
# the running service just to migrate OpenChamber: that would invalidate live
# clients/sessions. The P1 owner trust channel is the independent root broker.
AUTH_FILE=/etc/my-opencode/opencode-connect.secret
mkdir -p /etc/my-opencode
# Searchable but not listable by the agent. The mandatory root-owned
# enforcement marker must be stat()-visible to the opencode UID.
chmod 711 /etc/my-opencode
OPENCODE_SERVICE_PASSWORD="$(run_oc_user bash -c 'if [[ -f "$HOME/.config/opencode.env" ]]; then source "$HOME/.config/opencode.env"; fi; printf %s "${OPENCODE_PASSWORD:-${OPENCODE_SERVER_PASSWORD:-}}"' )"
if [[ -z "$OPENCODE_SERVICE_PASSWORD" ]]; then
  echo 'OPENCODE_EXISTING_AUTH_NOT_CONFIGURED: running server may use ephemeral password; refusing root UI migration without touching sessions.' >&2
  exit 3
fi
if [[ -n "$OPENCODE_SERVICE_PASSWORD" ]]; then
  curl -fsS --max-time 6 -u "opencode:$OPENCODE_SERVICE_PASSWORD" \
    http://127.0.0.1:4096/api/info -o "$TMP/opencode-info.json" || {
      echo 'OpenCode authentication/readiness failed; refusing root cutover' >&2; exit 3;
    }
  installed_opencode="$(run_oc_user "$OPENCODE_HOME/.opencode/bin/opencode" --version | sed -E 's/^opencode[[:space:]]+v?//')"
  read_opencode_version() {
    python3 - "$TMP/opencode-info.json" <<'VERSION'
import json
import re
import sys
with open(sys.argv[1], encoding="utf-8") as stream:
    body = json.load(stream)
    info = body.get("data", body)
    version = info.get("version")
    if not isinstance(version, str) or not re.fullmatch(r"2\.\d+\.\d+", version):
        sys.exit(1)
    print(version)
VERSION
  }
  live_opencode="$(read_opencode_version)" || { echo 'OPENCODE_LIVE_VERSION_UNAVAILABLE' >&2; exit 3; }
  if [[ -f "$AUTH_FILE" ]]; then
    [[ "$(stat -c %u "$AUTH_FILE")" == 0 && "$(stat -c %a "$AUTH_FILE")" =~ ^[460][04]0$ ]] || {
      echo 'External OpenCode auth file must be root-owned and private' >&2; exit 2;
    }
  fi
  # Root-owned transaction stores inert password bytes, not a shell-sourced
  # environment file. The root launcher exports them only at exec time.
  python3 -c 'import sys; sys.exit(chr(10) in sys.argv[1])' "$OPENCODE_SERVICE_PASSWORD" || {
    echo 'OPENCODE_CONNECT_MULTILINE_UNSUPPORTED' >&2; exit 3;
  }
  (umask 077; printf '%s' "$OPENCODE_SERVICE_PASSWORD" > "$AUTH_FILE.tmp"; mv -f "$AUTH_FILE.tmp" "$AUTH_FILE")
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
export OPENCHAMBER_EXPECTED_VERSION="${OPENCHAMBER_EXPECTED_VERSION:-2.8.0}"
export OPENCHAMBER_RUNTIME_ROOT="${OPENCHAMBER_RUNTIME_ROOT:-/root/.local/share/openchamber-v2}"
export PATH="/root/.local/bin:/root/.bun/bin:/root/.opencode/bin:$PATH"
EXPECTED_OPENCHAMBER_VERSION="$OPENCHAMBER_EXPECTED_VERSION"
export EXPECTED_OPENCHAMBER_VERSION
# Privileged installation code and child security interposers are immutable
# from the OpenCode agent's UID.
install -d -o root -g root -m 755 /usr/local/lib/my-opencode
for file in opencode-owner-approval.py opencode-owner-approvald.py openchamber-child-boundary.cjs opencode-unpriv-wrapper.sh launch-openchamber-root.sh; do
  install -o root -g root -m 755 "$TMP/$file" "/usr/local/lib/my-opencode/$file"
done
install -d -o root -g root -m 711 /etc/my-opencode
# Chats are execution data, not owner credentials. Use the preserved original
# OpenChamber Chats tree, so OpenCode's existing chat session directories keep
# their absolute paths after the root UI cutover. The separate root profile
# (settings, passwords and approval evidence) is never made accessible to opencode.
# Root-created chat directories must remain writable by opencode: setgid on the
# Chats tree + the root UI unit's UMask=0002 keeps the group inherited.
SHARED_CHATS_DIR="$OPENCODE_HOME/.config/openchamber/chats"
# Perform all operations on the untrusted legacy Chats tree AS opencode, not as
# root. Even a concurrent symlink swap cannot elevate a filesystem mutation.
# Never put this location in startup.env: migrated user settings must not be
# able to redefine the trusted identity or Chats location.
# These values are the protected root-side trust boundary and must win over
# any migrated startup.env values (systemd reads this file last).
printf 'OPENCHAMBER_EXECUTION_UID=%s\nOPENCHAMBER_EXECUTION_GID=%s\nOPENCHAMBER_CHATS_DIR=%s\n' \
  "$(id -u opencode)" "$(id -g opencode)" "$SHARED_CHATS_DIR" > /etc/my-opencode/openchamber-execution.env
cat >> /etc/my-opencode/openchamber-execution.env <<'EOF'
OPENCHAMBER_ROOT_MODE=separated
OPENCHAMBER_EXECUTION_USER=opencode
OPENCHAMBER_DATA_DIR=/root/.config/openchamber
OPENCODE_HOST=http://127.0.0.1:4096
OPENCODE_SKIP_START=true
OPENCODE_BINARY=/usr/local/lib/my-opencode/opencode-unpriv-wrapper.sh
NODE_OPTIONS="--require /usr/local/lib/my-opencode/openchamber-child-boundary.cjs"
EOF
chmod 600 /etc/my-opencode/openchamber-execution.env
source "$TMP/openchamber-runtime-store.sh"
oc_runtime_init
# Reapplying the same pinned versions must not kill a healthy root OpenChamber
# or its guest sessions. This check is after the OpenCode config refresh, which
# itself never restarts the existing opencode-web service.
if [[ -f "$ROOT_STATE/active-sha" &&
      "$(cat "$ROOT_STATE/active-sha")" == "$CONFIG_SHA $APP_SHA" &&
      -f /etc/my-opencode/owner-broker-required &&
      "$(stat -c %u /etc/my-opencode/owner-broker-required)" == 0 ]] &&
   [[ "$live_opencode" == "$installed_opencode" ]] &&
   systemctl is-active --quiet openchamber.service &&
   systemctl is-active --quiet opencode-owner-approval.service &&
   [[ -S /run/my-opencode-approval/agent.sock &&
      -S /run/my-opencode-approval/owner.sock ]] &&
   oc_validate_release "$(readlink -f "$OPENCHAMBER_CURRENT" 2>/dev/null || true)"; then
  install_journal_event activation activated "config_sha=$CONFIG_SHA" "openchamber_sha=$APP_SHA" "mode=noop"
  echo 'Root OpenChamber package and service unchanged: no restart or migration'
  exit 0
fi
RELEASE_DIR="$OPENCHAMBER_RELEASES/$APP_SHA"
export BUN_INSTALL="$RELEASE_DIR"
export PATH="$BUN_INSTALL/bin:$PATH"
# Never run a source fallback build (package scripts, bun install) as root.
# Verified exact-SHA CI release is mandatory for root-owned deployment.
if [[ -n "${OPENCHAMBER_PACKAGE_MODE:-}" && "$OPENCHAMBER_PACKAGE_MODE" != release ]]; then
  echo 'ROOT_INSTALL_SOURCE_BUILD_FORBIDDEN: use a verified GitHub release' >&2
  exit 2
fi
OPENCHAMBER_PACKAGE_MODE=release \
  OPENCHAMBER_RESTART_MODE=now \
  bash "$TMP/install-openchamber-v2-core.sh"

# Runtime fingerprint may remain unchanged when only the source metadata SHA
# advances. In that case core intentionally skips package installation: reuse
# the already validated current package, not an empty new-SHA directory.
# A pending delivery (e.g. embedded terminal/defer) must never become active.
ROOT_CORE_STATE="${XDG_STATE_HOME}/my-opencode/openchamber-v2-install.state"
root_state_value() { sed -n "s/^$1=//p" "$ROOT_CORE_STATE" 2>/dev/null | head -1; }
if [[ ! -x "$RELEASE_DIR/bin/openchamber" ]]; then
  current_verified="$(readlink -f "$OPENCHAMBER_CURRENT" 2>/dev/null || true)"
  if [[ -n "$current_verified" && -x "$current_verified/bin/openchamber" &&
        "$(root_state_value runtime_pending)" == 0 ]]; then
    RELEASE_DIR="$current_verified"
  elif [[ -n "$current_verified" && -x "$current_verified/bin/openchamber" &&
          "$(root_state_value effective_restart_mode)" == defer ]]; then
    RELEASE_DIR="$current_verified"
  else
    echo 'Root OpenChamber package not installed and no safe reusable release exists' >&2
    exit 3
  fi
fi
oc_validate_release "$RELEASE_DIR" || { echo 'Root OpenChamber release validation failed' >&2; exit 3; }
# Clean installs have neither a previous UI nor a migration source, so there
# are no PTYs or user sessions to interrupt. Activate automatically after the
# signed/release-verified package, isolated OpenCode runtime and broker checks.
# Existing installations require explicit now; auto is non-disruptive.
fresh_install=0
if [[ ! -e "$OPENCODE_HOME/.config/openchamber" &&
      ! -e /root/.config/openchamber &&
      ! -e "$ROOT_STATE/active-sha" ]] &&
   ! run_oc_user systemctl --user is-active --quiet openchamber.service &&
   ! systemctl is-active --quiet openchamber.service; then
  fresh_install=1
fi
if [[ "$RESTART_MODE" == defer || ( "$RESTART_MODE" == auto && "$fresh_install" != 1 ) ]]; then
  install_journal_event activation pending_restart "reason=embedded_or_deferred" "openchamber_sha=$APP_SHA"
  echo 'PENDING APPLY: runtime staged; use OPENCHAMBER_RESTART_MODE=now from SSH to activate.'
  exit 0
fi

# Use systemd's service cgroups, not process names/PIDs. TERM first, then
# KILL only the managed unit if it has not stopped within ten seconds.
stop_managed_service() {
  local unit=$1 state i
  shift
  "$@" stop --no-block "$unit"
  for ((i=0; i<15; i++)); do
    state="$("$@" show -p ActiveState --value "$unit")"
    case "$state" in inactive|failed) return 0;; esac
    if ((i == 10)); then
      echo "Force stopping remaining processes in $unit" >&2
      "$@" kill --kill-whom=all --signal=KILL "$unit" || true
    fi
    sleep 1
  done
  echo "MANAGED_SERVICE_STOP_FAILED: $unit" >&2
  return 3
}

opencode_has_work() {
  # An invalid/unavailable inventory cannot establish that the server is idle.
  # In explicitly authorized now mode, restart the managed server in that case.
  curl -fsS --max-time 7 -u "opencode:$OPENCODE_SERVICE_PASSWORD" \
    http://127.0.0.1:4096/api/session/active -o "$TMP/opencode-active.json" || return 0
  python3 - "$TMP/opencode-active.json" <<'PY'
import json,sys
try:
    data=json.load(open(sys.argv[1],encoding='utf-8')).get('data')
    sys.exit(1 if isinstance(data,dict) and not data else 0)
except (OSError,ValueError,AttributeError):
    sys.exit(0)
PY
}

restart_opencode_if_needed() {
  if [[ "$live_opencode" == "$installed_opencode" ]] && ! opencode_has_work; then
    return 0
  fi
  echo "Applying OpenCode runtime: $live_opencode -> $installed_opencode"
  stop_managed_service opencode-web.service run_oc_user systemctl --user
  run_oc_user systemctl --user start opencode-web.service
  local i version
  for ((i=0; i<30; i++)); do
    if curl -fsS --max-time 2 -u "opencode:$OPENCODE_SERVICE_PASSWORD" \
      http://127.0.0.1:4096/api/info -o "$TMP/opencode-info.json" 2>/dev/null &&
      version="$(read_opencode_version 2>/dev/null)" &&
      [[ "$version" == "$installed_opencode" ]]; then
      live_opencode="$version"
      return 0
    fi
    sleep 1
  done
  echo 'OPENCODE_RESTART_NOT_READY' >&2
  return 3
}

# Roll back the root OpenChamber package and migration, not the OpenCode
# binary/config already installed by install.sh. Session history is preserved.
old_active=0
old_enabled=0
root_was_active=0
broker_was_active=0
old_marker_present=0
cutover_started=0
migration_status=not_required
[[ ! -f /etc/my-opencode/owner-broker-required ]] || old_marker_present=1
systemctl is-active --quiet openchamber.service && root_was_active=1 || true
systemctl is-active --quiet opencode-owner-approval.service && broker_was_active=1 || true
for unit in openchamber.service opencode-owner-approval.service; do
  [[ ! -f "/etc/systemd/system/$unit" ]] ||
    cp -p "/etc/systemd/system/$unit" "$TMP/$unit.before"
done
[[ ! -f "$ROOT_STATE/active-sha" ]] || cp -p "$ROOT_STATE/active-sha" "$TMP/active-sha.before"
rollback_cutover() {
  local code=$?
  (( code != 0 )) || code=130
  trap - ERR INT TERM
  if (( cutover_started )); then
    systemctl stop openchamber.service >/dev/null 2>&1 || true
    if [[ "$migration_status" == staged ]]; then python3 "$TMP/migrate.py" rollback || true; fi
    if (( old_marker_present == 0 )); then rm -f -- /etc/my-opencode/owner-broker-required; fi
    if [[ -f "$TMP/active-sha.before" ]]; then
      cp -p "$TMP/active-sha.before" "$ROOT_STATE/active-sha" || true
    else
      rm -f -- "$ROOT_STATE/active-sha"
    fi
    for unit in openchamber.service opencode-owner-approval.service; do
      if [[ -f "$TMP/$unit.before" ]]; then
        cp -p "$TMP/$unit.before" "/etc/systemd/system/$unit" || true
      else
        rm -f -- "/etc/systemd/system/$unit"
      fi
    done
    systemctl daemon-reload || true
  fi
  oc_rollback_activation || true
  if (( cutover_started )); then
    run_oc_user systemctl --user start opencode-web.service >/dev/null 2>&1 || true
    if (( root_was_active )); then
      systemctl restart openchamber.service || true
    else
      systemctl disable --now openchamber.service >/dev/null 2>&1 || true
      if (( old_active )); then run_oc_user systemctl --user start openchamber.service || true; fi
      if (( old_enabled )); then run_oc_user systemctl --user enable openchamber.service || true; fi
    fi
    if (( broker_was_active == 0 )); then systemctl disable --now opencode-owner-approval.service >/dev/null 2>&1 || true; fi
  fi
  install_journal_event install failed "openchamber_sha=$APP_SHA" "exit_code=$code" "reason=cutover_rollback" || true
  exit "$code"
}
trap rollback_cutover ERR
trap 'rollback_cutover' INT TERM

# Detect a non-default OpenChamber data directory from the old runtime.
# Parse its startup file only as opencode, never source its shell content as
# root. A custom directory outside the old user's home is refused rather
# than silently starting the new UI without its sessions/settings.
OLD_OC_DATA_DIR="$(run_oc_user bash -c 'if [[ -f "$HOME/.config/openchamber/startup.env" ]]; then source "$HOME/.config/openchamber/startup.env"; fi; printf %s "${OPENCHAMBER_DATA_DIR:-$HOME/.config/openchamber}"')"
if [[ "$OLD_OC_DATA_DIR" != "$OPENCODE_HOME/.config/openchamber" &&
      "$OLD_OC_DATA_DIR" != "$OPENCODE_HOME/"* ]]; then
  echo "OPENCHAMBER_DATA_MIGRATION_UNSUPPORTED: custom data outside opencode HOME; refusing cutover" >&2
  exit 3
fi
[[ ! -L "$OLD_OC_DATA_DIR" ]] || { echo 'OPENCHAMBER_DATA_MIGRATION_SYMLINK_REFUSED' >&2; exit 3; }

# Preparation is complete. Start the short maintenance window: stop UI
# cgroups including PTYs and project processes; no global process killing.
run_oc_user systemctl --user is-active --quiet openchamber.service && old_active=1 || true
run_oc_user systemctl --user is-enabled --quiet openchamber.service && old_enabled=1 || true
cutover_started=1
if ((old_active)); then stop_managed_service openchamber.service run_oc_user systemctl --user; fi
if ((root_was_active)); then stop_managed_service openchamber.service systemctl; fi
restart_opencode_if_needed

# Publish only after the old services have stopped.
if [[ "$(readlink -f "$OPENCHAMBER_CURRENT" 2>/dev/null || true)" != "$RELEASE_DIR" ]]; then
  oc_activate_release "$RELEASE_DIR"
fi
oc_write_managed_launcher
[[ -x "$OPENCHAMBER_CURRENT_BIN" ]] || { echo 'Root OpenChamber binary is not installed' >&2; exit 3; }
migration_status='not_required'
if [[ -d "$OLD_OC_DATA_DIR" ]]; then
  migration_status="$(python3 "$TMP/migrate.py" stage --source "$OLD_OC_DATA_DIR" --quiescent yes | python3 -c 'import sys,json;print(json.load(sys.stdin)["status"])')"
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
# Idempotent repair after a data-only opencode->root migration. The copied
# extensions.json can still refer to /home/opencode-owned plugin directories.
# Root services refuse those as untrusted; move only copied extension paths to
# their root-owned replicas before service activation. No plugin code runs here.
python3 "$TMP/rebase-extensions.py"

# Prepare the shared Chats tree only after migration source detection and
# copying. A clean install must never treat the new empty tree as legacy data.
run_oc_user python3 - "$SHARED_CHATS_DIR" <<'PY'
import os, stat, sys
from pathlib import Path
target = Path(sys.argv[1])
home = Path.home()
if target != home / '.config/openchamber/chats':
    raise SystemExit('OPENCHAMBER_SHARED_CHATS_INVALID_LOCATION')
for parent in (home / '.config', home / '.config/openchamber', target):
    if parent.is_symlink():
        raise SystemExit(f'OPENCHAMBER_SHARED_CHATS_SYMLINK_REFUSED: {parent}')
target.mkdir(parents=True, exist_ok=True)
if not target.is_dir():
    raise SystemExit('OPENCHAMBER_SHARED_CHATS_NOT_DIRECTORY')
def walk_error(error):
    raise error

for current, directories, files in os.walk(target, followlinks=False, onerror=walk_error):
    if any((Path(current) / name).is_symlink() for name in directories + files):
        raise SystemExit(f'OPENCHAMBER_SHARED_CHATS_ENTRY_SYMLINK_REFUSED: {current}')
    info = os.stat(current, follow_symlinks=False)
    mode = stat.S_IMODE(info.st_mode)
    if not stat.S_ISDIR(info.st_mode):
        raise SystemExit(f'OPENCHAMBER_SHARED_CHATS_NOT_DIRECTORY: {current}')
    if info.st_uid == os.geteuid():
        os.chown(current, -1, os.getgid(), follow_symlinks=False)
        os.chmod(current, (mode | 0o2770) & ~0o007, follow_symlinks=False)
    elif (info.st_uid == 0 and Path(current) != target
          and info.st_gid == os.getgid()
          and mode & 0o7770 == 0o2770
          and not mode & 0o002
          and os.access(current, os.R_OK | os.W_OK | os.X_OK)):
        # The root UI creates date/session directories with setgid and
        # UMask=0002 (typically 2775) inside the private Chats tree.
        # They are already writable by opencode. Only their owner can
        # chmod/chown them, and no privileged mutation is needed.
        continue
    else:
        raise SystemExit(f'OPENCHAMBER_SHARED_CHATS_UNSAFE_OWNER_OR_MODE: {current}')
PY

# Root-owned UI and broker; OpenCode remains a separate user service.
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
for i in {1..30}; do
  if systemctl is-active --quiet openchamber.service && \
     curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:"${OPENCHAMBER_BIND_PORT:-3000}"/; then
    run_oc_user systemctl --user disable openchamber.service >/dev/null || true
    # Enforce broker for every new PLAN/owner-accept at this point.
    install -o root -g root -m 644 /dev/null /etc/my-opencode/owner-broker-required
    (umask 077; printf '%s\n' "$CONFIG_SHA $APP_SHA" > "$ROOT_STATE/active-sha.new")
    mv -f "$ROOT_STATE/active-sha.new" "$ROOT_STATE/active-sha"
    install_journal_event activation activated "config_sha=$CONFIG_SHA" "openchamber_sha=$APP_SHA"
    # Final durable migration commit: every preceding fallible step can still
    # roll back the data, unit files, marker and previous active runtime.
    if [[ "$migration_status" == staged ]]; then python3 "$TMP/migrate.py" complete --ready yes; fi
    trap - ERR INT TERM
    oc_commit_activation || echo 'WARN: root service healthy but previous-release pointer not yet persisted' >&2
    echo "ROOT OPENCHAMBER READY config=$CONFIG_SHA app=$APP_SHA OpenCode=$live_opencode"
    exit 0
  fi
  sleep 1
done

echo 'ROOT_OPENCHAMBER_CUTOVER_FAILED: rolling back root cutover' >&2
false
