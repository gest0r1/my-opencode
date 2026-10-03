#!/usr/bin/env bash
# Bounded dependency preparation; active configuration is never touched here.
set -Eeuo pipefail
STAGE=${1:?staging directory required}
STATE_ROOT=${2:?state directory required}
LIMIT=${OPENCODE_DEPENDENCY_TIMEOUT_SECONDS:-300}
[[ "$LIMIT" =~ ^[1-9][0-9]*$ ]] || { echo 'OPENCODE_DEPENDENCY_TIMEOUT_SECONDS must be a positive integer' >&2; exit 2; }
for cmd in bun timeout; do
  command -v "$cmd" >/dev/null || { echo "Missing prerequisite: $cmd" >&2; exit 1; }
done
[[ -f "$STAGE/bun.lock" ]] || { echo 'Dependency lockfile missing; refusing unfrozen installation' >&2; exit 1; }
mkdir -p "$STATE_ROOT"
LOG="$STATE_ROOT/opencode-dependency-install.log"
umask 077
# One retained log, truncated on each invocation; no accumulating log directory.
: > "$LOG"
chmod 600 "$LOG"
worker=''
heartbeat=''
cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  [[ -z "$heartbeat" ]] || { kill "$heartbeat" 2>/dev/null || true; wait "$heartbeat" 2>/dev/null || true; }
  [[ -z "$worker" ]] || { kill -TERM "$worker" 2>/dev/null || true; wait "$worker" 2>/dev/null || true; }
  exit "$rc"
}
trap cleanup EXIT
trap 'echo "Dependency installation interrupted; log: $LOG" >&2; exit 130' INT
trap 'echo "Dependency installation terminated; log: $LOG" >&2; exit 143' TERM
cd "$STAGE"
echo "Installing locked OpenCode plugin dependencies (limit=${LIMIT}s); log: $LOG"
timeout --kill-after=5s "${LIMIT}s" bun install --production --frozen-lockfile --no-progress --verbose > "$LOG" 2>&1 &
worker=$!
(
  SECONDS=0
  while kill -0 "$worker" 2>/dev/null; do
    sleep 15
    kill -0 "$worker" 2>/dev/null || break
    echo "Dependency installation running: ${SECONDS}s elapsed; log: $LOG"
  done
) &
heartbeat=$!
rc=0
wait "$worker" || rc=$?
worker=''
kill "$heartbeat" 2>/dev/null || true
wait "$heartbeat" 2>/dev/null || true
heartbeat=''
if (( rc != 0 )); then
  if [[ "$rc" == 124 || "$rc" == 137 ]]; then
    echo "Dependency installation timed out after ${LIMIT}s; active configuration was not replaced. Log: $LOG" >&2
  else
    echo "Dependency installation failed (exit=$rc); active configuration was not replaced. Log: $LOG" >&2
  fi
  tail -n 40 "$LOG" >&2
  exit "$rc"
fi
echo 'Locked OpenCode plugin dependencies installed successfully.'
