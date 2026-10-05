#!/usr/bin/env bash
# Exercise the real wrapper transaction with isolated delivery/native CLI fixtures.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TASK_TMP=$(mktemp -d)
trap 'rm -rf -- "$TASK_TMP"' EXIT
export TEST_ROOT="$ROOT" CONFIG_SHA=1111111111111111111111111111111111111111 APP_SHA=2222222222222222222222222222222222222222
export HOME="$TASK_TMP/home" PATH="$TASK_TMP/bin:$PATH" TRACE="$TASK_TMP/trace"
mkdir -p "$HOME" "$TASK_TMP/bin"
export OPENCHAMBER_RUNTIME_ROOT="$HOME/.local/share/openchamber-v2" OPENCHAMBER_BIND_HOST=127.0.0.1
export EXPECTED_OPENCHAMBER_VERSION=2.1.0 OPENCHAMBER_UI_PASSWORD='test-password' OPENCHAMBER_RESTART_MODE=now
cat > "$TASK_TMP/bin/gh" <<'GH'
#!/usr/bin/env bash
case "$*" in
 *commits/main*) if [[ "$*" == *my-opencode* ]]; then echo "$CONFIG_SHA"; else echo "$APP_SHA"; fi;;
 *contents/scripts/bootstrap-runtime-tools.sh*) cat "$TEST_ROOT/scripts/bootstrap-runtime-tools.sh";;
 *contents/scripts/runtime-processes.py*) printf 'print("external")\n';;
 *contents/scripts/verify-runtime-services.py*) printf 'import os\nwith open(os.environ["TRACE"],"a") as f: f.write("acceptance PASS\\n")\n';;
 *contents/scripts/openchamber-runtime-store.sh*) cat "$TEST_ROOT/scripts/openchamber-runtime-store.sh";;
 *contents/scripts/install-openchamber-v2-core.sh*) cat "$CORE_FIXTURE";;
 *) exit 91;;
esac
GH
cat > "$TASK_TMP/core" <<'CORE'
#!/usr/bin/env bash
set -Eeuo pipefail
mkdir -p "$BUN_INSTALL/bin" "$HOME/.local/state/my-opencode"
cp "$CLI_FIXTURE" "$BUN_INSTALL/bin/openchamber"
printf 'effective_restart_mode=%s\nservice_restart_pending=1\n' "$OPENCHAMBER_RESTART_MODE" > "$HOME/.local/state/my-opencode/openchamber-v2-install.state"
CORE
cat > "$TASK_TMP/cli" <<'CLI'
#!/usr/bin/env bash
if [[ "$1" == --version ]]; then echo 'OpenChamber 2.1.0'; exit; fi
printf 'native %s launcher=%s\n' "$*" "$OPENCHAMBER_STARTUP_LAUNCHER" >> "$TRACE"
CLI
cat > "$TASK_TMP/bin/curl" <<'CURL'
#!/usr/bin/env bash
if [[ "$*" == *"/api/info"* ]]; then printf '{"version":"2.0.21","pid":1234}'; exit 0; fi
if [[ "${TRANSIENT_FAILURES:-0}" == 1 ]]; then
  count=0
  [[ ! -f "$CURL_COUNTER" ]] || read -r count < "$CURL_COUNTER"
  printf '%s\n' "$((count+1))" > "$CURL_COUNTER"
  if ((count<3)); then
    echo 'curl: (7) simulated connection refused' >&2
    printf 000
    exit 7
  fi
fi
if [[ "${FAIL_NEW:-0}" == 1 && "$(readlink -f "$OPENCHAMBER_RUNTIME_ROOT/current")" == *"$APP_SHA" ]]; then printf 500; else printf 200; fi
CURL
cat > "$TASK_TMP/bin/systemctl" <<'SYSTEMCTL'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >> "$TRACE"
exit 0
SYSTEMCTL
cat > "$TASK_TMP/bin/journalctl" <<'JOURNAL'
#!/usr/bin/env bash
printf 'journalctl %s\n' "$*" >> "$TRACE"
echo 'simulated service journal'
JOURNAL
cat > "$TASK_TMP/bin/id" <<'ID'
#!/bin/bash
case "$1" in -un) echo opencode;; -u) echo 1234;; *) /usr/bin/id "$@";; esac
ID
cat > "$TASK_TMP/bin/getent" <<'GETENT'
#!/bin/bash
echo "opencode:x:1234:1234::$HOME:/bin/bash"
GETENT
cat > "$TASK_TMP/bin/sudo" <<'SUDO'
#!/bin/sh
printf 'sudo %s\n' "$*" >> "$TRACE"
if [ "${FAIL_CUTOVER:-0}" = 1 ] && [ "$3" = legacy-stop ]; then exit 1; fi
echo 'Runtime cutover sudo: READY migration-v2'
exit 0
SUDO
printf '#!/bin/sh\nexit 0\n' > "$TASK_TMP/bin/sleep"
chmod +x "$TASK_TMP/bin/"* "$TASK_TMP/cli"
mkdir -p "$HOME/.local/bin"
cp "$TASK_TMP/bin/"* "$HOME/.local/bin/"
ln -s "$(command -v node)" "$HOME/.local/bin/node"
export CORE_FIXTURE="$TASK_TMP/core" CLI_FIXTURE="$TASK_TMP/cli"
source "$ROOT/scripts/openchamber-runtime-store.sh"
oc_runtime_init
old="$OPENCHAMBER_RELEASES/old"
mkdir -p "$old/bin";cp "$CLI_FIXTURE" "$old/bin/openchamber"
oc_activate_release "$old";oc_commit_activation
mkdir -p "$HOME/.local/state/my-opencode"
printf 'old-state\n' > "$HOME/.local/state/my-opencode/openchamber-v2-install.state"
rc=0
FAIL_CUTOVER=1 bash "$ROOT/install-openchamber.sh" > "$TASK_TMP/cutover-failure.log" 2>&1 || rc=$?
[[ "$rc" != 0 ]]
grep -Fq 'legacy-restore' "$TRACE"
! grep -Fq 'native startup enable' "$TRACE"
! grep -Fq 'legacy-commit' "$TRACE"
: > "$TRACE"
rc=0
FAIL_NEW=1 bash "$ROOT/install-openchamber.sh" > "$TASK_TMP/failure.log" 2>&1 || rc=$?
[[ "$rc" != 0 ]]
grep -Fq 'OpenChamber readiness failed after 30 attempts' "$TASK_TMP/failure.log"
grep -Fq 'simulated service journal' "$TASK_TMP/failure.log"
[[ "$(readlink -f "$OPENCHAMBER_CURRENT")" == "$old" ]]
[[ "$(cat "$HOME/.local/state/my-opencode/openchamber-v2-install.state")" == old-state ]]
[[ "$(grep -c '^native startup enable' "$TRACE")" == 2 ]]
OPENCHAMBER_RESTART_MODE=defer bash "$ROOT/install-openchamber.sh" > "$TASK_TMP/defer.log" 2>&1
[[ "$(readlink -f "$OPENCHAMBER_CURRENT")" == "$old" ]]
grep -Fq 'PENDING APPLY' "$TASK_TMP/defer.log"
TRANSIENT_FAILURES=1 CURL_COUNTER="$TASK_TMP/curl-counter" bash "$ROOT/install-openchamber.sh" > "$TASK_TMP/success.log" 2>&1
[[ "$(cat "$TASK_TMP/curl-counter")" == 5 ]]
! grep -Eq 'curl:|readiness failed|simulated service journal' "$TASK_TMP/success.log"
[[ "$(readlink -f "$OPENCHAMBER_CURRENT")" == "$OPENCHAMBER_RELEASES/$APP_SHA" ]]
grep -Fxq 'service_restart_pending=0' "$HOME/.local/state/my-opencode/openchamber-v2-install.state"
[[ -d "$old" ]]
grep -Fq 'systemctl --user restart opencode-web.service openchamber.service' "$TRACE"
grep -Fq 'acceptance PASS' "$TRACE"
grep -Fq 'sudo -n /usr/local/sbin/opencode-runtime-cutover legacy-commit' "$TRACE"
echo 'PASS: native activation, failed health rollback, defer, readiness commit and previous retention'
