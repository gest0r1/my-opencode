#!/usr/bin/env bash
# Root cutover rollback always preserves the OpenCode runtime and old UI.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COORD="$ROOT/scripts/install-openchamber-root.sh"
python3 - "$COORD" <<'PY'
from pathlib import Path
import sys
s=Path(sys.argv[1]).read_text()
a=s.index('rollback_cutover() {')
b=s.index('trap rollback_cutover ERR',a)
body=s[a:b]
for needle in ('systemctl stop openchamber.service', 'python3 "$TMP/migrate.py" rollback',
               'run_oc_user systemctl --user start openchamber.service',
               'oc_rollback_activation', 'exit "$code"'):
    assert needle in body, needle
for forbidden in ('systemctl restart opencode-web.service', 'systemctl --user stop opencode-web.service',
                  'rm -rf /home/opencode'):
    assert forbidden not in body, forbidden
assert 'oc_commit_activation' in s
assert 'opencode-web.service' in s
print('PASS: root rollback restores old OpenChamber and does not alter OpenCode')
PY
