#!/usr/bin/env bash
# Ref provenance is distinct from immutable SHA; no root->opencode OpenChamber cutover.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
python3 - "$ROOT" <<'PY'
from pathlib import Path
import sys
root=Path(sys.argv[1])
wrapper=(root/'install-openchamber.sh').read_text()
coordinator=(root/'scripts/install-openchamber-root.sh').read_text()
core=(root/'scripts/install-openchamber-v2-core.sh').read_text()
for needle in ('OPENCODE_CONFIG_REF="$CONFIG_SHA"', 'OPENCODE_CONFIG_SOURCE_REF="$REQUESTED_CONFIG_REF"',
               'OPENCHAMBER_REF="$APP_SHA"', 'OPENCHAMBER_SOURCE_REF="$REQUESTED_APP_REF"'):
    assert needle in wrapper, needle
for needle in ('CONFIG_SHA="$(gh api', 'APP_SHA="$(gh api', 'OPENCHAMBER_ROOT_ONLY=1',
               'OPENCODE_BINARY=/usr/local/lib/my-opencode/opencode-unpriv-wrapper.sh',
               'install-openchamber-root.sh', 'oc_rollback_activation'):
    # The wrapper's own path is consumed through a pinned GitHub API request.
    assert needle in (wrapper + coordinator), needle
assert 'OPENCHAMBER_ROOT_ONLY' in core
assert 'OPENCODE_CONFIG_SOURCE_REF' in core
assert 'OPENCHAMBER_SOURCE_REF' in core
assert 'sudo -H -u "$RUNTIME_USER"' not in wrapper
print('PASS: root coordinator retains source ref, immutable SHA and opencode isolation')
PY
