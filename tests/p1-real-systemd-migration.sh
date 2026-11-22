#!/usr/bin/env bash
# Must run on a disposable GitHub-hosted Ubuntu runner, never any owned VPS.
set -Eeuo pipefail
[[ "${RUNNER_ENVIRONMENT:-}" == github-hosted &&
   "${GITHUB_ACTIONS:-}" == true && "${EUID}" != 0 ]] || {
  echo 'P1_EPHEMERAL_RUNNER_REQUIRED' >&2; exit 2;
}
[[ -n "${GH_TOKEN:-}" && "${OC_SHA:-}" =~ ^[a-f0-9]{40}$ ]] || exit 2
source_sha="$GITHUB_SHA"
export PATH="/usr/local/bin:$PATH"
sudo -n env GH_TOKEN="$GH_TOKEN" PATH="/usr/local/bin:/usr/bin:/bin" \
  OPENCODE_CONFIG_REF="$source_sha" bash install.sh
uid="$(id -u opencode)"
sudo systemctl start "user@${uid}.service"
# Existing host credentials must be stable before a running OpenCode server
# can be attached without re-authenticating its current sessions.
sudo -H -u opencode bash -c '
  set -Eeuo pipefail
  file="$HOME/.config/opencode.env"
  [[ ! -L "$file" ]]
  token="$(python3 -c "import secrets;print(secrets.token_urlsafe(36))")"
  (umask 077; printf "OPENCODE_PASSWORD=%s\\n" "$token" >> "$file")
'
OPENCODE_TEST_PASSWORD="$(sudo -H -u opencode bash -c 'source "$HOME/.config/opencode.env";printf %s "$OPENCODE_PASSWORD"')"
oc_curl() { curl -u "opencode:$OPENCODE_TEST_PASSWORD" "$@"; }
user_systemctl() {
  sudo -n -u opencode env XDG_RUNTIME_DIR="/run/user/$uid" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" \
    systemctl --user "$@"
}
user_systemctl start opencode-web.service
ready=0
for i in {1..40}; do
  if oc_curl -fsS --max-time 2 http://127.0.0.1:4096/api/info >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then
  user_systemctl status --no-pager -l opencode-web.service || true
  sudo journalctl --user-unit=opencode-web.service --no-pager -n 80 || true
  echo 'P1_OPENCODE_USER_SERVICE_NOT_READY' >&2
  exit 3
fi
old_id="$(oc_curl -fsS -X POST http://127.0.0.1:4096/api/session \
  -H 'Content-Type: application/json' \
  -d '{"title":"P1 before migration"}' | \
  node -e 'let v="";process.stdin.on("data",x=>v+=x).on("end",()=>{let j=JSON.parse(v);if(!j.data?.id)process.exit(1);console.log(j.data.id)})')"

# Simulate the existing unprivileged OpenChamber layout and active unit.
sudo -n install -d -o opencode -g opencode -m 700 /home/opencode/.config/openchamber
sudo -n install -d -o opencode -g opencode -m 755 /home/opencode/.config/systemd/user
printf 'current-source-kept\n' | sudo -n -u opencode tee /home/opencode/.config/openchamber/profile-source.txt >/dev/null
printf 'former-ui-jwt\n' | sudo -n -u opencode tee /home/opencode/.config/openchamber/jwt-secret >/dev/null
printf '%s\n' 'OPENCHAMBER_UI_PASSWORD=former-agent-readable' \
  'LD_PRELOAD=/home/opencode/agent.so' \
  'NODE_OPTIONS=--require=/home/opencode/agent.cjs' \
  'OPENCHAMBER_BIND_PORT=81' | \
  sudo -n -u opencode tee /home/opencode/.config/openchamber/startup.env >/dev/null
sudo -n tee /home/opencode/.config/systemd/user/openchamber.service >/dev/null <<'UNIT'
[Unit]
Description=P1 legacy OpenChamber fixture (unprivileged, ephemeral)
[Service]
Type=simple
ExecStart=/usr/bin/python3 -m http.server 3000 --bind 127.0.0.1 --directory /home/opencode/.config/openchamber
Restart=on-failure
[Install]
WantedBy=default.target
UNIT
sudo chown opencode:opencode /home/opencode/.config/systemd/user/openchamber.service
user_systemctl daemon-reload
user_systemctl enable --now openchamber.service
legacy_ui_ready=0
for i in {1..30}; do
  if curl -fsS --max-time 2 http://127.0.0.1:3000/profile-source.txt 2>/dev/null | grep -Fxq current-source-kept; then
    legacy_ui_ready=1
    break
  fi
  sleep 1
done
if [[ "$legacy_ui_ready" != 1 ]]; then
  user_systemctl status --no-pager -l openchamber.service || true
  echo 'P1_LEGACY_OPENCHAMBER_FIXTURE_NOT_READY' >&2
  exit 3
fi
sudo -n install -d -o root -g root -m 700 /root/.config/openchamber
printf 'historical-root-kept\n' | sudo -n tee /root/.config/openchamber/profile-root-only.txt >/dev/null

# First attempt must fail safely after migration stage and restore the old
# running UI, the historical profile, and the unmodified OpenCode session.
set +e
sudo -n env GH_TOKEN="$GH_TOKEN" PATH="/usr/local/bin:/usr/bin:/bin" \
  OPENCODE_CONFIG_REF="$source_sha" OPENCHAMBER_REF="$OC_SHA" \
  OPENCHAMBER_ROOT_RUNTIME_VERIFIED=1 OPENCHAMBER_CUTOVER_QUIESCENT=1 \
  bash scripts/install-openchamber-root.sh >"$RUNNER_TEMP/p1-failed-cutover.log" 2>&1
first_rc=$?
set -e
[[ "$first_rc" != 0 ]] || { echo 'P1_ROLLBACK_NOT_TRIGGERED' >&2; exit 1; }
user_systemctl is-active --quiet openchamber.service || {
  echo 'P1_OLD_UI_NOT_RESTORED' >&2; tail -n 80 "$RUNNER_TEMP/p1-failed-cutover.log"; exit 1;
}
test "$(sudo cat /root/.config/openchamber/profile-root-only.txt)" = historical-root-kept
test "$(sudo cat /home/opencode/.config/openchamber/profile-source.txt)" = current-source-kept
oc_curl -fsS "http://127.0.0.1:4096/api/session/$old_id" >/dev/null
echo 'PASS: failed cutover restored old UI, historical root data and OpenCode session'

# Retry with a valid port after the previous rollback. Source remains the
# authority on conflicts; root-only history is merged additively.
sudo -n -u opencode sed -i 's/OPENCHAMBER_BIND_PORT=81/OPENCHAMBER_BIND_PORT=3000/' \
  /home/opencode/.config/openchamber/startup.env
sudo -n env GH_TOKEN="$GH_TOKEN" PATH="/usr/local/bin:/usr/bin:/bin" \
  OPENCODE_CONFIG_REF="$source_sha" OPENCHAMBER_REF="$OC_SHA" \
  OPENCHAMBER_ROOT_RUNTIME_VERIFIED=1 OPENCHAMBER_CUTOVER_QUIESCENT=1 \
  bash scripts/install-openchamber-root.sh
sudo systemctl is-active --quiet openchamber.service
sudo systemctl is-active --quiet opencode-owner-approval.service
! user_systemctl is-active --quiet openchamber.service
test "$(sudo cat /root/.config/openchamber/profile-source.txt)" = current-source-kept
test "$(sudo cat /root/.config/openchamber/profile-root-only.txt)" = historical-root-kept
test "$(sudo cat /home/opencode/.config/openchamber/profile-source.txt)" = current-source-kept
test "$(sudo stat -c %a /root/.config/openchamber/startup.env)" = 600
! sudo grep -Eq 'LD_PRELOAD|NODE_OPTIONS|former-agent-readable' /root/.config/openchamber/startup.env
sudo grep -Fq 'LD_PRELOAD=/home/opencode/agent.so' /root/.config/openchamber/startup.env.pre-p1
oc_curl -fsS "http://127.0.0.1:4096/api/session/$old_id" >/dev/null
curl -fsS http://127.0.0.1:3000/ >/dev/null
echo 'PASS: user-to-root migration, historical merge, credential quarantine, OpenCode session continuity'
