#!/usr/bin/env bash
# Execute the real wrapper rollback function against a private activation/state fixture.
# No systemd, installed OpenCode, real package or host runtime is touched.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WRAPPER="$ROOT/install-openchamber.sh"
WORK="$(mktemp -d /tmp/opencode-rollback-test.XXXXXXXX)"
trap 'rm -rf -- "$WORK"' EXIT
sed -n '/^rollback() {/,/^}/p' "$WRAPPER" > "$WORK/rollback-function.sh"
grep -Fq 'oc_rollback_activation' "$WORK/rollback-function.sh" || {
  echo 'FAIL: live rollback body not found' >&2; exit 1;
}

for scenario in restored rollback-failed; do
  dir="$WORK/$scenario"
  mkdir -p "$dir/work" "$dir/old-runtime" "$dir/new-runtime"
  printf '%s\n' 'config_sha=old' 'activation_status=activated' > "$dir/work/state.before"
  printf '%s\n' 'config_sha=new' 'activation_status=pending' > "$dir/state"
  ln -s "$dir/new-runtime" "$dir/current"
  cat > "$dir/invoke.sh" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
TMP="$FIXTURE_DIR/work"
STATE="$FIXTURE_DIR/state"
TRACE="$FIXTURE_DIR/trace"
OPENCHAMBER_CURRENT_BIN="$FIXTURE_DIR/nonexistent-binary"
CONFIG_SOURCE_REF=main CONFIG_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
APP_SOURCE_REF=main APP_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
oc_rollback_activation() {
  echo 'runtime_rollback' >> "$TRACE"
  if [[ "$SCENARIO" == rollback-failed ]]; then return 1; fi
  ln -sfn "$FIXTURE_DIR/old-runtime" "$FIXTURE_DIR/current"
}
install_journal_event() {
  echo "journal $*" >> "$TRACE"
  cmp -s "$TMP/state.before" "$STATE" || {
    echo 'ERROR: journal emitted before state restoration' >> "$TRACE"
    return 1
  }
}
source "$ROLLBACK_FUNCTION"
rollback 17
SH
  chmod +x "$dir/invoke.sh"
  rc=0
  FIXTURE_DIR="$dir" ROLLBACK_FUNCTION="$WORK/rollback-function.sh" SCENARIO="$scenario" \
    bash "$dir/invoke.sh" > "$dir/output" 2>&1 || rc=$?
  [[ "$rc" == 17 ]] || { echo "FAIL: rollback exit code $rc" >&2; exit 1; }
  cmp -s "$dir/work/state.before" "$dir/state" || { echo 'FAIL: state not restored' >&2; exit 1; }
  grep -Fq 'runtime_rollback' "$dir/trace" || { echo 'FAIL: runtime rollback not attempted' >&2; exit 1; }
  grep -Fq 'journal install failed' "$dir/trace" || { echo 'FAIL: failure event missing' >&2; exit 1; }
  ! grep -Fq 'ERROR:' "$dir/trace" || { echo 'FAIL: journal emitted before recovery' >&2; exit 1; }
  if [[ "$scenario" == restored ]]; then
    [[ "$(readlink "$dir/current")" == "$dir/old-runtime" ]] || {
      echo 'FAIL: previously active runtime not restored' >&2; exit 1;
    }
  else
    grep -Fq 'WARN: activation rollback failed' "$dir/output" || {
      echo 'FAIL: runtime rollback failure was suppressed without warning' >&2; exit 1;
    }
  fi
done
echo 'PASS: live rollback restores state before failure audit, including failed activation recovery'
