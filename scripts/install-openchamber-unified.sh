#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ $EUID == 0 ]] || { echo 'OpenChamber installation requires an administrative root session' >&2; exit 2; }
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

CONFIG_REPO="${OPENCODE_CONFIG_REPO:-gest0r1/my-opencode}"
CONFIG_SHA="${OPENCODE_CONFIG_REF:?Exact my-opencode commit is required}"
APP_REPO="${OPENCHAMBER_REPO:-gest0r1/openchamber-ru}"
APP_SHA="${OPENCHAMBER_REF:?Exact OpenChamber commit is required}"
EXPECTED_OPENCHAMBER_VERSION=2.8.0
EXPECTED_OPENCODE_VERSION=2.3.2
STATE=/var/lib/my-openchamber
POLICY=/etc/my-opencode
LIB=/usr/local/lib/my-opencode
UNITS=/etc/systemd/system
RESTART_MODE="${OPENCHAMBER_RESTART_MODE:-auto}"
[[ "$CONFIG_SHA" =~ ^[a-f0-9]{40}$ && "$APP_SHA" =~ ^[a-f0-9]{40}$ ]] || exit 2
[[ "$RESTART_MODE" == auto || "$RESTART_MODE" == now || "$RESTART_MODE" == defer ]] || exit 2
[[ "${OPENCHAMBER_PACKAGE_MODE:-release}" == release ]] || { echo 'A verified Linux package is required' >&2; exit 2; }
for tool in gh python3 systemctl runuser sudo flock curl tar install; do command -v "$tool" >/dev/null; done

install -d -m 755 -o root -g root "$STATE" "$STATE/runtime"
install -d -m 700 -o root -g root "$STATE/install"
exec 9>"$STATE/install/lock"
flock -x 9
work="$(mktemp -d /tmp/my-openchamber-unified.XXXXXXXX)"
trap 'rm -rf -- "$work"' EXIT

fetch() {
  gh api -H 'Accept: application/vnd.github.raw' "repos/$CONFIG_REPO/contents/$1?ref=$CONFIG_SHA" > "$2"
}
for part in bootstrap-openchamber-root-tools.sh openchamber-runtime-store.sh runtime-processes.py stage-openchamber-unified-release.sh install-journal.sh; do
  fetch "scripts/$part" "$work/$part"
done
source "$work/bootstrap-openchamber-root-tools.sh"
source "$work/install-journal.sh"
ensure_root_node
ensure_root_bun
source "$work/stage-openchamber-unified-release.sh"
export OPENCHAMBER_RUNTIME_ROOT="$STATE/runtime" EXPECTED_OPENCHAMBER_VERSION
source "$work/openchamber-runtime-store.sh"

if [[ "$(python3 "$work/runtime-processes.py" --ancestor "$PPID")" != external || "${OPENCHAMBER_EMBEDDED_TERMINAL:-0}" == 1 ]]; then
  RESTART_MODE=defer
fi
approval_origin="${OPENCHAMBER_OWNER_APPROVAL_ORIGIN:-}"
if [[ -z "$approval_origin" && -f "$POLICY/owner-broker-passkey" ]]; then approval_origin="$(cat "$POLICY/owner-broker-passkey")"; fi
node -e 'const s=process.argv[1],u=URL.parse(s);if(!u||u.protocol!=="https:"||u.origin!==s||!u.hostname.includes("."))process.exit(2)' "$approval_origin" || {
  echo 'Set OPENCHAMBER_OWNER_APPROVAL_ORIGIN to the dedicated HTTPS origin.' >&2; exit 2;
}
if [[ -f "$POLICY/owner-broker-passkey" && "$(cat "$POLICY/owner-broker-passkey")" != "$approval_origin" ]]; then
  echo 'The installed passkeys are bound to the existing approval origin.' >&2; exit 2
fi
bind_host="${OPENCHAMBER_BIND_HOST:-0.0.0.0}"
bind_port="${OPENCHAMBER_BIND_PORT:-3000}"
[[ "$bind_host" =~ ^[a-zA-Z0-9.:_-]+$ && "$bind_port" =~ ^[0-9]{1,5}$ && "${bind_port#0}" == "$bind_port" ]] &&
  ((bind_port > 0 && bind_port <= 65535)) || { echo 'Invalid OpenChamber bind address' >&2; exit 2; }
approval_host="${approval_origin#https://}"
health_host="$bind_host"
case "$bind_host" in 0.0.0.0) health_host=127.0.0.1;; ::) health_host='[::1]';; *:*) health_host="[$bind_host]";; esac
loopback="http://$health_host:$bind_port"

if id opencode >/dev/null 2>&1; then
  if [[ -x /usr/local/sbin/opencode-deploy-target ]] &&
      runuser -u opencode -- sudo -n -l /usr/local/sbin/opencode-deploy-target >/dev/null 2>&1 &&
      compgen -G '/etc/opencode/deploy-targets/*.conf' >/dev/null; then
    echo 'OWNER_APPROVAL_LOCAL_PRIVILEGED_CONTOUR: isolate the registered dev deployment before cutover.' >&2
    exit 3
  fi
  for group in $(id -nG opencode); do
    case "$group" in root|sudo|wheel|docker|lxd|incus|opencode-approval|opencode-approval-proxy)
      echo "OWNER_APPROVAL_RUNTIME_PRIVILEGED_GROUP: $group" >&2; exit 3;;
    esac
  done
fi

state_active="$STATE/install/active-sha"
protected_items=("$UNITS/openchamber.service" "$UNITS/opencode-owner-approval.service" "$UNITS/opencode-owner-verifier.socket" "$UNITS/opencode-owner-verifier.service"
  "$POLICY/owner-broker-required" "$POLICY/owner-broker-passkey" "$POLICY/owner-verifier.env" "$POLICY/openchamber-unified.env"
  "$POLICY/openchamber-startup.env" "$LIB/verified-node" "$OPENCHAMBER_CURRENT" "$state_active")
identify_runtime() {
  runtime_home="$(getent passwd opencode | cut -d: -f6)"
  runtime_uid="$(id -u opencode)"
  [[ "$runtime_home" =~ ^/home/[a-zA-Z0-9._-]+$ && "$runtime_uid" != 0 ]]
}
user_run() {
  runuser -u opencode -- env HOME="$runtime_home" XDG_RUNTIME_DIR="/run/user/$runtime_uid" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$runtime_uid/bus" "$@"
}
user_systemd() { user_run systemctl --user "$@"; }
stop_unit() {
  local name=$1 phase
  shift
  phase="$("$@" show --property=ActiveState --value "$name" 2>/dev/null || true)"
  if [[ -z "$phase" || "$phase" == inactive || "$phase" == failed ]]; then return 0; fi
  "$@" stop --no-block "$name"
  for _ in {1..10}; do
    phase="$("$@" show --property=ActiveState --value "$name")"
    if [[ "$phase" == inactive || "$phase" == failed ]]; then return 0; fi
    sleep 1
  done
  "$@" kill --kill-whom=all --signal=KILL "$name" || true
  for _ in {1..5}; do
    phase="$("$@" show --property=ActiveState --value "$name")"
    if [[ "$phase" == inactive || "$phase" == failed ]]; then return 0; fi
    sleep 1
  done
  echo "OpenChamber managed unit failed to stop: $name" >&2
  return 3
}
rollback() {
  local result="${1:-$?}" item
  trap - ERR INT TERM
  stop_unit openchamber.service systemctl
  stop_unit opencode-owner-verifier.service systemctl
  stop_unit opencode-owner-verifier.socket systemctl
  stop_unit opencode-owner-approval.service systemctl
  if [[ -x "$LIB/migrate-openchamber-profile.py" ]]; then user_run python3 "$LIB/migrate-openchamber-profile.py" rollback "$transaction"; fi
  for item in "${protected_items[@]}"; do
    rm -f -- "$item"
    if [[ -e "$saved$item" || -L "$saved$item" ]]; then cp -a "$saved$item" "$item"; fi
  done
  systemctl daemon-reload
  (( existing_broker == 0 )) || systemctl start opencode-owner-approval.service
  (( existing_verifier == 0 )) || systemctl start opencode-owner-verifier.socket
  (( old_oc == 0 )) || user_systemd start opencode-web.service
  (( old_user_ui == 0 )) || user_systemd start openchamber.service
  (( old_ui == 0 )) || systemctl start openchamber.service
  rm -f "$STATE/install/pending"
  echo "OpenChamber activation rolled back. Backup kept at $saved" >&2
  exit "$result"
}
health() {
  curl -fsS --max-time 2 "$loopback/health" | python3 -c 'import json,sys;h=json.load(sys.stdin);sys.exit(not(h.get("openchamberVersion")=="2.8.0" and h.get("openCodeRunning") is True and h.get("opencodeLaunchBinary")))'
}
verifier_health() {
  curl -fsS --max-time 2 --unix-socket /run/my-opencode-verifier/http.sock -H "Host: $approval_host" -o /dev/null http://localhost/healthz
}
if [[ -f "$STATE/install/pending" ]]; then
  if [[ "$RESTART_MODE" != now ]]; then
    echo 'PENDING APPLY: run from external SSH with OPENCHAMBER_RESTART_MODE=now to recover the interrupted activation.'
    exit 0
  fi
  transaction="$(cat "$STATE/install/pending")"
  [[ "$transaction" =~ ^[a-f0-9]{32}$ ]] || exit 3
  saved="$STATE/install/$transaction"
  read -r old_ui existing_broker existing_verifier old_user_ui old_oc < "$saved/old-unit-state"
  identify_runtime
  rollback 0
fi
if [[ -f "$state_active" && "$(cat "$state_active")" == "$CONFIG_SHA $APP_SHA $bind_host $bind_port" ]] &&
    systemctl is-active --quiet openchamber.service && systemctl is-active --quiet opencode-owner-approval.service &&
    systemctl is-active --quiet opencode-owner-verifier.socket && health && verifier_health; then
  echo "Unified runtime already active config=$CONFIG_SHA app=$APP_SHA"; exit 0
fi

release="$(stage_unified_release "$work")"
if [[ "$RESTART_MODE" != now ]] && { [[ "$RESTART_MODE" == defer ]] || systemctl is-active --quiet openchamber.service; }; then
  echo 'PENDING APPLY: verified package staged. Run the installer from external SSH with OPENCHAMBER_RESTART_MODE=now.'
  exit 0
fi

for part in opencode-owner-approvald.py opencode-owner-approval.py opencode-owner-approval-state.py opencode-owner-approval-admin.py migrate-openchamber-profile.py migrate-openchamber-to-root.py; do
  fetch "scripts/$part" "$work/$part"
done
for part in openchamber-unified.service opencode-owner-approval.service opencode-owner-verifier.socket opencode-owner-verifier.service; do
  fetch "config/systemd/$part" "$work/$part"
done
fetch install.sh "$work/install-opencode.sh"
OPENCODE_MANAGED_BY_OPENCHAMBER=1 MY_OPENCODE_REF="$CONFIG_SHA" bash "$work/install-opencode.sh" "$@"
identify_runtime
installed="$(user_run "$runtime_home/.opencode/bin/opencode" --version | sed -E 's/^opencode[[:space:]]+v?//')"
[[ "$installed" == "$EXPECTED_OPENCODE_VERSION" ]] || exit 3

getent group opencode-approval-proxy >/dev/null || groupadd --system opencode-approval-proxy
id opencode-approval >/dev/null 2>&1 || useradd --system --user-group --no-create-home --shell /usr/sbin/nologin opencode-approval
[[ "$(id -u opencode-approval)" != 0 && "$(id -u opencode-approval)" != "$runtime_uid" ]] || exit 3
install -d -m 711 -o root -g root "$POLICY"
install -d -m 755 -o root -g root "$LIB"
node_path="$(readlink -f "$(command -v node)")"
trusted_root_exec "$node_path"
transaction="$(python3 -c 'import secrets;print(secrets.token_hex(16))')"
saved="$STATE/install/$transaction"
install -d -m 700 "$saved"
old_current="$(readlink "$OPENCHAMBER_CURRENT" || true)"
old_ui=0 existing_broker=0 existing_verifier=0 old_user_ui=0 old_oc=0
systemctl is-active --quiet openchamber.service && old_ui=1 || true
systemctl is-active --quiet opencode-owner-approval.service && existing_broker=1 || true
systemctl is-active --quiet opencode-owner-verifier.socket && existing_verifier=1 || true
user_systemd is-active --quiet openchamber.service && old_user_ui=1 || true
user_systemd is-active --quiet opencode-web.service && old_oc=1 || true
for item in "${protected_items[@]}"; do
  if [[ -e "$item" || -L "$item" ]]; then cp -a --parents "$item" "$saved"; fi
done
printf '%s\n' "$old_ui $existing_broker $existing_verifier $old_user_ui $old_oc" > "$saved/old-unit-state"
printf '%s\n' "$transaction" > "$saved/pending"
mv -Tf "$saved/pending" "$STATE/install/pending"
trap rollback ERR
trap 'rollback 130' INT TERM

for part in opencode-owner-approvald.py opencode-owner-approval.py opencode-owner-approval-state.py opencode-owner-approval-admin.py migrate-openchamber-profile.py migrate-openchamber-to-root.py; do
  install -m 755 -o root -g root "$work/$part" "$LIB/$part"
done
profile=/root/.config/openchamber
stop_unit openchamber.service user_systemd
stop_unit opencode-web.service user_systemd
stop_unit openchamber.service systemctl
stop_unit opencode-owner-verifier.service systemctl
stop_unit opencode-owner-verifier.socket systemctl
stop_unit opencode-owner-approval.service systemctl
if [[ ! -f "$state_active" ]]; then
  if [[ -d "$profile" && ! -L "$profile" ]]; then
    tar --one-file-system -C "$profile" --exclude=./startup.env.pre-p1 --exclude=./.p1-root-ui-rekeyed -cf - . |
      user_run python3 "$LIB/migrate-openchamber-profile.py" prepare "$transaction" > "$saved/profile-report.json"
    user_run python3 "$LIB/migrate-openchamber-profile.py" activate "$transaction"
  fi
fi
if [[ -n "$old_current" ]]; then printf '%s\n' "$old_current" > "$saved/previous-release"; fi
ln -s "$node_path" "$work/verified-node"
mv -Tf "$work/verified-node" "$LIB/verified-node"
ln -s "$release" "$STATE/runtime/.current.$transaction"
mv -Tf "$STATE/runtime/.current.$transaction" "$OPENCHAMBER_CURRENT"

user_run sh -c 'test ! -f "$HOME/.config/openchamber/startup.env" || cat "$HOME/.config/openchamber/startup.env"' > "$work/ui.env.input"
grep -E '^OPENCHAMBER_UI_PASSWORD=[^[:cntrl:]]+$' "$work/ui.env.input" > "$work/ui.env" || [[ "$?" == 1 ]]
install -m 600 "$work/ui.env" "$POLICY/openchamber-startup.env"
printf 'OPENCHAMBER_OWNER_APPROVAL_ORIGIN=%s\n' "$approval_origin" > "$POLICY/owner-verifier.env"
printf 'OPENCHAMBER_BIND_HOST=%s\nOPENCHAMBER_BIND_PORT=%s\nOPENCODE_BINARY=%s/.opencode/bin/opencode\nPATH=%s/.local/bin:%s/.opencode/bin:/usr/local/bin:/usr/bin:/bin\n' \
  "$bind_host" "$bind_port" "$runtime_home" "$runtime_home" "$runtime_home" > "$POLICY/openchamber-unified.env"
install -m 644 /dev/null "$POLICY/owner-broker-required"
printf '%s\n' "$approval_origin" > "$work/owner-origin"
install -m 644 "$work/owner-origin" "$POLICY/owner-broker-passkey"
sed 's|^ExecStart=.*|ExecStart=/usr/bin/python3 /usr/local/lib/my-opencode/opencode-owner-approvald.py --passkey|' "$work/opencode-owner-approval.service" > "$work/broker.service"
install -m 644 "$work/broker.service" "$UNITS/opencode-owner-approval.service"
install -m 644 "$work/openchamber-unified.service" "$UNITS/openchamber.service"
install -m 644 "$work/opencode-owner-verifier.service" "$work/opencode-owner-verifier.socket" "$UNITS/"

systemctl daemon-reload
systemctl start opencode-owner-approval.service opencode-owner-verifier.socket
curl --silent --show-error --fail --max-time 8 -o /dev/null "$approval_origin/healthz"
systemctl start openchamber.service
for _ in {1..30}; do
  if health 2>/dev/null && verifier_health; then
    break
  fi
  sleep 1
done
health
verifier_health
main_pid="$(systemctl show --property=MainPID --value openchamber.service)"
[[ "$main_pid" != 0 && "$(ps -p "$main_pid" -o uid= | tr -d ' ')" == "$runtime_uid" ]]
systemctl enable openchamber.service opencode-owner-approval.service opencode-owner-verifier.socket >/dev/null
user_systemd disable opencode-web.service openchamber.service >/dev/null || true
printf '%s\n' "$CONFIG_SHA $APP_SHA $bind_host $bind_port" > "$saved/active-sha"
mv -Tf "$saved/active-sha" "$state_active"
rm -f "$STATE/install/pending"
trap - ERR INT TERM
echo "Unified runtime ready config=$CONFIG_SHA app=$APP_SHA OpenCode=$installed"
