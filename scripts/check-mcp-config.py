#!/usr/bin/env python3
"""Deterministic current-tree MCP guard; historical secret audit is separate."""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONFIG = ROOT / 'config/opencode/opencode.json'
EXPECTED = {'context7', 'gh_grep', 'exa', 'yadisk', 'memory', 'ya-metrika', '1c-buddy'}
REMOVED = {'yonote', 'exchange', 'bitrix24', 'n8n', 'itop', 'google-drive', 'image-gen'}
errors = []

try:
    config = json.loads(CONFIG.read_text(encoding='utf-8'))
except (OSError, json.JSONDecodeError) as exc:
    raise SystemExit(f'MCP config cannot be parsed: {exc}')

mcp = config.get('mcp', {})
if set(mcp) != EXPECTED:
    errors.append(f'MCP names differ: missing={sorted(EXPECTED-set(mcp))}, extra={sorted(set(mcp)-EXPECTED)}')
for name in EXPECTED:
    if name in mcp and mcp[name].get('enabled') is not True:
        errors.append(f'{name} is disabled')
for name, value in mcp.items():
    for field in ('env', 'headers'):
        for key, secret in value.get(field, {}).items():
            if re.search(r'(TOKEN|SECRET|API.KEY|PASSWORD|AUTHORIZATION)', key, re.I):
                # Only env substitutions may occur in tracked integration credentials.
                if not re.fullmatch(r'(?:Bearer )?\{env:[A-Z][A-Z0-9_]*\}', str(secret)):
                    errors.append(f'{name}.{field}.{key} is a literal credential')
if mcp.get('1c-buddy', {}).get('oauth') is not False:
    errors.append('1c-buddy OAuth must be disabled for loopback-only unauthenticated upstream')
if mcp.get('1c-buddy', {}).get('url') != 'http://127.0.0.1:6002/mcp':
    errors.append('1c-buddy must use loopback MCP URL')
if 'NODE_TLS_REJECT_UNAUTHORIZED' in CONFIG.read_text(encoding='utf-8'):
    errors.append('TLS verification bypass present')
for key in config.get('permission', {}):
    if any(key == f'{removed}_*' for removed in REMOVED):
        errors.append(f'orphaned permission: {key}')

for relative in ('mcp/1c-buddy/source.lock', 'mcp/1c-buddy/compose.yml', 'scripts/install-mcp.sh'):
    if not (ROOT / relative).is_file():
        errors.append(f'missing reproducible-install component: {relative}')

if errors:
    print('MCP guard FAIL: ' + '; '.join(errors), file=sys.stderr)
    raise SystemExit(1)
print('MCP guard PASS: 7 enabled MCP, no inline integration credentials, pinned install components present')
