#!/usr/bin/env bash
# Behavioral sudo reexec: execute the actual wrapper across env -i and into a
# fake deferred core. Only a private HOME and fake external commands are used.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d /tmp/opencode-ref-state-test.XXXXXXXX)"
trap 'rm -rf -- "$WORK"' EXIT
BIN="$WORK/bin"
RUNTIME_HOME="$WORK/runtime-home"
TRACE="$WORK/sudo.trace"
mkdir -p "$BIN" "$RUNTIME_HOME/.local/bin" "$WORK/owner"
: > "$TRACE"
cat > "$BIN/id" <<'SH'
#!/bin/sh
case "${1:-}" in
  -un) printf '%s\n' "${USER:-owner}";;
  -u) printf '1001\n';;
  *) exec /usr/bin/id "$@";;
esac
SH
cat > "$BIN/getent" <<'SH'
#!/bin/sh
if [ "${1:-}" = passwd ] && [ "${2:-}" = opencode ]; then
  printf 'opencode:x:1001:1001::__RUNTIME_HOME__:/bin/bash\n'
else
  exit 1
fi
SH
sed -i "s|__RUNTIME_HOME__|$RUNTIME_HOME|g" "$BIN/getent"
cat > "$BIN/sudo" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'sudo %s\n' "$*" >> "__TRACE__"
if [[ "${1:-}" == -H && "${2:-}" == -u && "${3:-}" == opencode ]]; then
  shift 3
  exec "$@" # actual env -i, including actual second-stage wrapper execution
fi
# Root provision/loginctl and runtime package-helper checks are fake successes.
exit 0
SH
sed -i "s|__TRACE__|$TRACE|g" "$BIN/sudo"
cat > "$BIN/gh" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${1:-}" == auth && "${2:-}" == status ]]; then exit 0; fi
if [[ "${1:-}" != api ]]; then echo "unexpected gh: $*" >&2; exit 91; fi
case "$*" in
  *"repos/gest0r1/my-opencode/commits/"*) echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
  *"repos/gest0r1/openchamber-ru/commits/"*) echo bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ;;
  *"contents/scripts/bootstrap-runtime-tools.sh?ref="*)
    cat <<'BOOT'
ensure_runtime_toolchain() { :; }
BOOT
    ;;
  *"contents/scripts/install-journal.sh?ref="*)
    cat <<'JOURNAL'
install_journal_event() { :; }
JOURNAL
    ;;
  *"contents/scripts/openchamber-runtime-store.sh?ref="*)
    cat <<'STORE'
OPENCHAMBER_RELEASES="$HOME/.local/share/openchamber-v2/releases"
OPENCHAMBER_CURRENT="$HOME/.local/share/openchamber-v2/current"
oc_runtime_init() { mkdir -p "$OPENCHAMBER_RELEASES"; }
STORE
    ;;
  *"contents/scripts/install-openchamber-v2-core.sh?ref="*)
    cat <<'CORE'
#!/usr/bin/env bash
set -Eeuo pipefail
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/my-opencode/openchamber-v2-install.state"
mkdir -p "$(dirname "$STATE")"
printf 'config_ref=%s\nconfig_sha=%s\nopenchamber_ref=%s\nopenchamber_sha=%s\neffective_restart_mode=defer\nactivation_status=pending_restart\n' \
  "$OPENCODE_CONFIG_SOURCE_REF" "$OPENCODE_CONFIG_REF" "$OPENCHAMBER_SOURCE_REF" "$OPENCHAMBER_REF" > "$STATE"
CORE
    ;;
  *"contents/scripts/"*)
    printf '%s\n' '#!/bin/sh' 'exit 0' ;;
  *) echo "unexpected gh api: $*" >&2; exit 92 ;;
esac
SH
chmod +x "$BIN/"*
cp "$BIN/"* "$RUNTIME_HOME/.local/bin/"
USER=owner HOME="$WORK/owner" PATH="$BIN:$PATH" \
  OPENCODE_CONFIG_REF=feature/install-audit OPENCHAMBER_REF=feature/app-audit \
  OPENCHAMBER_BIND_HOST=127.0.0.1 OPENCHAMBER_UI_PASSWORD=fixture-password \
  OPENCHAMBER_RESTART_MODE=defer \
  bash "$ROOT/install-openchamber.sh" > "$WORK/output" 2>&1 || {
    cat "$WORK/output" >&2; echo 'FAIL: live wrapper handover did not complete' >&2; exit 1;
  }
state="$RUNTIME_HOME/.local/state/my-opencode/openchamber-v2-install.state"
[[ -f "$state" ]] || { cat "$WORK/output"; echo 'FAIL: no core state' >&2; exit 1; }
for value in \
  'config_ref=feature/install-audit' \
  'config_sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
  'openchamber_ref=feature/app-audit' \
  'openchamber_sha=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' \
  'activation_status=pending_restart'; do
  grep -Fxq "$value" "$state" || { echo "FAIL: state missing $value" >&2; exit 1; }
done
grep -Fq 'sudo -H -u opencode env -i' "$TRACE" || {
  echo 'FAIL: sudo env -i reexec was not exercised' >&2; exit 1;
}
# Unsafe refs fail before provisioning or state changes.
cp "$state" "$WORK/state.before"
trace_lines="$(wc -l < "$TRACE")"
rc=0
USER=owner HOME="$WORK/owner" PATH="$BIN:$PATH" \
  OPENCODE_CONFIG_REF=$'main\nconfig_sha=0000000000000000000000000000000000000000' \
  bash "$ROOT/install-openchamber.sh" > "$WORK/bad.out" 2>&1 || rc=$?
[[ "$rc" -ne 0 ]] && grep -Fq 'INSTALL_SOURCE_REF_INVALID' "$WORK/bad.out" || {
  echo 'FAIL: unsafe input accepted at outer boundary' >&2; exit 1;
}
cmp -s "$state" "$WORK/state.before" || { echo 'FAIL: invalid ref changed state' >&2; exit 1; }
[[ "$(wc -l < "$TRACE")" == "$trace_lines" ]] || {
  echo 'FAIL: invalid ref reached provisioning' >&2; exit 1;
}
echo 'PASS: actual env -i handover persists source refs separately from pinned SHAs'
