#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TASK_TMP=$(mktemp -d)
trap 'rm -rf -- "$TASK_TMP"' EXIT
mkdir -p "$TASK_TMP/bin" "$TASK_TMP/stage" "$TASK_TMP/state"
touch "$TASK_TMP/stage/bun.lock"
printf 'active config\n' > "$TASK_TMP/active"
cat > "$TASK_TMP/bin/bun" <<'BUN'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TRACE"
echo "bun mode=$MODE"
case "$MODE" in
  success) exit 0 ;;
  failure) exit 42 ;;
  stalled) sleep 30 ;;
esac
BUN
chmod +x "$TASK_TMP/bin/bun"
export PATH="$TASK_TMP/bin:$PATH" TRACE="$TASK_TMP/trace"
run_case() {
  local mode=$1 expected=$2
  local rc=0
  MODE="$mode" OPENCODE_DEPENDENCY_TIMEOUT_SECONDS=1 bash "$ROOT/scripts/install-opencode-dependencies.sh" "$TASK_TMP/stage" "$TASK_TMP/state" > "$TASK_TMP/output" 2>&1 || rc=$?
  [[ "$rc" == "$expected" ]] || { cat "$TASK_TMP/output"; exit 1; }
  [[ "$(cat "$TASK_TMP/active")" == 'active config' ]]
}
run_case success 0
grep -Fq 'install --production --frozen-lockfile --no-progress --verbose' "$TRACE"
run_case failure 42
grep -Fq 'failed (exit=42)' "$TASK_TMP/output"
run_case stalled 124
grep -Fq 'timed out after 1s' "$TASK_TMP/output"
[[ $(find "$TASK_TMP/state" -type f | wc -l) == 1 ]]
! grep -Fq 'mode=failure' "$TASK_TMP/state/opencode-dependency-install.log"
[[ $(stat -c %a "$TASK_TMP/state/opencode-dependency-install.log") == 600 ]]
# Cancellation also terminates the worker and leaves a distinct diagnostic.
: > "$TASK_TMP/state/opencode-dependency-install.log"
MODE=stalled OPENCODE_DEPENDENCY_TIMEOUT_SECONDS=30 bash "$ROOT/scripts/install-opencode-dependencies.sh" "$TASK_TMP/stage" "$TASK_TMP/state" > "$TASK_TMP/output" 2>&1 &
parent=$!
for attempt in {1..50}; do
  grep -Fq 'mode=stalled' "$TASK_TMP/state/opencode-dependency-install.log" && break
  sleep 0.02
done
kill -TERM "$parent"
rc=0
wait "$parent" || rc=$?
[[ "$rc" == 143 ]]
grep -Fq 'terminated; log:' "$TASK_TMP/output"
echo 'PASS: dependencies are locked, bounded, logged and cancellable'
