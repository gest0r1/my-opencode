#!/usr/bin/env bash
# New root OpenChamber activation and rollback do not own OpenCode sessions.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WRAPPER="$ROOT/install-openchamber.sh"
COORD="$ROOT/scripts/install-openchamber-root.sh"
CORE="$ROOT/scripts/install-openchamber-v2-core.sh"
STORE="$ROOT/scripts/openchamber-runtime-store.sh"
for f in "$WRAPPER" "$COORD" "$CORE" "$STORE"; do bash -n "$f"; done
grep -Fq 'oc_rollback_activation' "$COORD"
grep -Fq 'oc_activate_release' "$COORD"
grep -Fq 'PENDING APPLY:' "$COORD"
grep -Fq 'stop_managed_service' "$COORD"
grep -Fq 'restart_opencode_if_needed' "$COORD"
! grep -Fq 'OPENCHAMBER_CUTOVER_QUIESCENT' "$COORD"
! grep -Fq 'OPENCHAMBER_ROOT_RUNTIME_VERIFIED' "$COORD"
grep -Fq 'opencode-owner-approval.service' "$COORD"
grep -Fq 'systemctl restart openchamber.service' "$COORD"
! grep -Fq 'systemctl --user restart opencode-web.service openchamber.service' "$COORD"
grep -Fq 'effective_restart_mode=defer' "$CORE"
grep -Fq 'mv -Tf "$link_tmp" "$OPENCHAMBER_CURRENT"' "$STORE"
for forbidden in opencode-runtime-cutover legacy-stop legacy-restore legacy-commit root-state-sync.pending; do
  ! grep -Fq "$forbidden" "$WRAPPER"
  ! grep -Fq "$forbidden" "$COORD"
done
echo 'PASS: root OpenChamber activation is isolated, deferred and rollback-capable'


# Exercise the actual cutover decision functions with a deterministic API.
# Real systemd stop/start and version mismatch are covered by P1 acceptance.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
OPENCODE_SERVICE_PASSWORD=fixture
source <(sed -n '/^opencode_has_work() {/,/^# Auto is non-disruptive/{ /^# Auto is non-disruptive/d; p; }' "$COORD")
installed_opencode=2.3.2
live_opencode=2.3.2
calls="$TMP/calls"
curl() {
  local output='' url=''
  while (($#)); do
    case "$1" in
      -o) output="$2"; shift;;
      http://*) url="$1";;
    esac
    shift
  done
  case "$url" in
    */api/session/active)
      [[ "$inventory" != unavailable ]] || return 22
      printf '%s' "$inventory" > "$output";;
    */api/info) printf '%s' '{"data":{"version":"2.3.2"}}' > "$output";;
    *) return 2;;
  esac
}
read_opencode_version() { printf '%s\n' "$installed_opencode"; }
stop_managed_service() { printf 'stop %s\n' "$*" >> "$calls"; }
run_oc_user() { printf 'start %s\n' "$*" >> "$calls"; }
inventory='{"data":{}}'
: > "$calls"
restart_opencode_if_needed
[[ ! -s "$calls" ]]
for inventory in '{"data":{"session-fixture":{"type":"busy"}}}' malformed unavailable; do
  : > "$calls"
  restart_opencode_if_needed
  [[ "$(wc -l < "$calls")" == 2 ]]
  grep -Fxq 'stop opencode-web.service run_oc_user systemctl --user' "$calls"
  grep -Fxq 'start systemctl --user start opencode-web.service' "$calls"
done
inventory='{"data":{}}'
live_opencode=2.2.7
: > "$calls"
restart_opencode_if_needed
[[ "$(wc -l < "$calls")" == 2 && "$live_opencode" == 2.3.2 ]]
echo 'PASS: idle server retained, busy/unverified server restarted, live version mismatch reconciled'
