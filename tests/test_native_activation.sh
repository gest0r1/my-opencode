#!/usr/bin/env bash
# Static activation contract: update rollback stays within the permanent user runtime.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WRAPPER="$ROOT/install-openchamber.sh"
CORE="$ROOT/scripts/install-openchamber-v2-core.sh"
STORE="$ROOT/scripts/openchamber-runtime-store.sh"

for f in "$WRAPPER" "$CORE" "$STORE"; do bash -n "$f"; done

grep -Fq 'oc_rollback_activation' "$WRAPPER"
grep -Fq 'oc_activate_release' "$WRAPPER"
grep -Fq 'native_startup' "$WRAPPER"
grep -Fq 'readiness' "$WRAPPER"
grep -Fq 'systemctl --user restart opencode-web.service openchamber.service' "$WRAPPER"
if grep -Fq 'verify-runtime-services.py' "$WRAPPER"; then echo 'FAIL: runtime acceptance probe is back in the wrapper' >&2; exit 1; fi
grep -Fq 'effective_restart_mode=defer' "$CORE"
grep -Fq 'OPENCHAMBER_EMBEDDED_TERMINAL' "$CORE"

for forbidden in opencode-runtime-cutover legacy-stop legacy-restore legacy-commit root-state-sync.pending migration-plan; do
  ! grep -Fq "$forbidden" "$WRAPPER"
done

echo 'PASS: native activation uses only permanent user-runtime rollback and embedded-terminal defer'
