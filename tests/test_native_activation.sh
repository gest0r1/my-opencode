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
grep -Fq 'OPENCHAMBER_CUTOVER_QUIESCENT' "$COORD"
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
