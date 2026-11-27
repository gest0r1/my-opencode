#!/usr/bin/env bash
# Ref provenance remains distinct from the exact SHAs used for unified activation.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
python3 - "$ROOT" <<'PY'
from pathlib import Path
import sys
root=Path(sys.argv[1])
wrapper=(root/'install-openchamber.sh').read_text()
coordinator=(root/'scripts/install-openchamber-unified.sh').read_text()
core=(root/'scripts/install-openchamber-v2-core.sh').read_text()
for needle in ('OPENCODE_CONFIG_REF="$CONFIG_SHA"', 'OPENCODE_CONFIG_SOURCE_REF="$REQUESTED_CONFIG_REF"',
               'OPENCHAMBER_REF="$APP_SHA"', 'OPENCHAMBER_SOURCE_REF="$REQUESTED_APP_REF"'):
    assert needle in wrapper, needle
for needle in ('CONFIG_SHA="$(gh api', 'APP_SHA="$(gh api', 'install-openchamber-unified.sh?ref=$CONFIG_SHA'):
    assert needle in wrapper, needle
for needle in ('config_ref=${OPENCODE_CONFIG_SOURCE_REF:-$CONFIG_SHA}', 'openchamber_ref=${OPENCHAMBER_SOURCE_REF:-$APP_SHA}',
               'stage_unified_release "$work"', 'rollback()', 'OPENCODE_MANAGED_BY_OPENCHAMBER=1'):
    assert needle in coordinator, needle
assert 'OPENCHAMBER_ROOT_ONLY' in core
assert 'OPENCODE_CONFIG_SOURCE_REF' in core
assert 'OPENCHAMBER_SOURCE_REF' in core
assert 'sudo -H -u "$RUNTIME_USER"' not in wrapper
print('PASS: unified coordinator retains source refs, exact SHA pins and rollback')
PY
