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
if [[ "${FAIL_NEW:-0}" == 1 && "$(readlink -f "$OPENCHAMBER_RUNTIME_ROOT/current")" == *"$APP_SHA" ]]; then printf 500; else printf 200; fi
CURL
cat > "$TASK_TMP/bin/systemctl" <<'SYSTEMCTL'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >> "$TRACE"
[[ "$*" == '--user is-active --quiet openchamber.service' || "$*" == '--user status openchamber.service --no-pager -l' ]]
SYSTEMCTL
printf '#!/bin/sh\nexit 0\n' > "$TASK_TMP/bin/sleep"
chmod +x "$TASK_TMP/bin/"* "$TASK_TMP/cli"
export CORE_FIXTURE="$TASK_TMP/core" CLI_FIXTURE="$TASK_TMP/cli"
source "$ROOT/scripts/openchamber-runtime-store.sh"
oc_runtime_init
old="$OPENCHAMBER_RELEASES/old"
mkdir -p "$old/bin";cp "$CLI_FIXTURE" "$old/bin/openchamber"
oc_activate_release "$old";oc_commit_activation
mkdir -p "$HOME/.local/state/my-opencode"
printf 'old-state\n' > "$HOME/.local/state/my-opencode/openchamber-v2-install.state"
rc=0
FAIL_NEW=1 bash "$ROOT/install-openchamber.sh" > "$TASK_TMP/failure.log" 2>&1 || rc=$?
[[ "$rc" != 0 ]]
[[ "$(readlink -f "$OPENCHAMBER_CURRENT")" == "$old" ]]
[[ "$(cat "$HOME/.local/state/my-opencode/openchamber-v2-install.state")" == old-state ]]
[[ "$(grep -c '^native startup enable' "$TRACE")" == 2 ]]
OPENCHAMBER_RESTART_MODE=defer bash "$ROOT/install-openchamber.sh" > "$TASK_TMP/defer.log" 2>&1
[[ "$(readlink -f "$OPENCHAMBER_CURRENT")" == "$old" ]]
grep -Fq 'PENDING APPLY' "$TASK_TMP/defer.log"
bash "$ROOT/install-openchamber.sh" > "$TASK_TMP/success.log" 2>&1
[[ "$(readlink -f "$OPENCHAMBER_CURRENT")" == "$OPENCHAMBER_RELEASES/$APP_SHA" ]]
grep -Fxq 'service_restart_pending=0' "$HOME/.local/state/my-opencode/openchamber-v2-install.state"
[[ -d "$old" ]]
! grep -Eq '^systemctl .* (restart|stop|start|enable|daemon-reload)' "$TRACE"
echo 'PASS: native activation, failed health rollback, defer, readiness commit and previous retention'
