#!/usr/bin/env python3
"""One-time root OpenChamber UI credential rekey after opencode->root copy.

OpenCode sessions stay untouched. Old UI session tokens must be invalidated:
while OpenChamber was owned by opencode, agents could read its UI secrets.
Registered passkeys keep their public keys, re-bound to the new root-only secret.
"""
import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys

STRIP = frozenset({
    'OPENCHAMBER_UI_PASSWORD', 'OPENCHAMBER_DATA_DIR', 'OPENCODE_HOST',
    'OPENCODE_SKIP_START', 'OPENCODE_PASSWORD', 'OPENCODE_SERVER_PASSWORD',
    'OPENCODE_BINARY', 'OPENCODE_JWT_SECRET', 'NODE_OPTIONS',
})


def secure_atomic(path, payload):
    if path.is_symlink():
        raise ValueError('UNSAFE_UI_SECRET_SYMLINK')
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp = path.with_name('.' + path.name + '.p1.' + secrets.token_hex(8))
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()


def rekey(data_dir, test=False):
    data_dir = Path(data_dir)
    if os.geteuid() != 0 and not test:
        raise ValueError('ROOT_REQUIRED')
    if data_dir.is_symlink() or not data_dir.is_dir():
        raise ValueError('INVALID_ROOT_DATA_DIR')
    if not test and data_dir.resolve() != Path('/root/.config/openchamber'):
        raise ValueError('INVALID_ROOT_DATA_DIR')
    env_file = data_dir / 'startup.env'
    jwt_file = data_dir / 'jwt-secret'
    passkeys_file = data_dir / 'ui-passkeys.json'
    marker = data_dir / '.p1-root-ui-rekeyed'
    if marker.is_file():
        return {'status': 'already_rekeyed'}
    if any(p.is_symlink() for p in (env_file, jwt_file, passkeys_file, marker)):
        raise ValueError('UNSAFE_UI_SECRET_SYMLINK')
    old_env = env_file.read_text(encoding='utf-8') if env_file.exists() else ''
    new_lines = []
    for line in old_env.splitlines():
        match = re.match(r'^\s*(?:export\s+)?([A-Z_][A-Z_0-9]*)\s*=', line)
        if match and (match.group(1) in STRIP or match.group(1).startswith('OPENCHAMBER_APPROVAL_')):
            continue
        new_lines.append(line)
    ui_password = secrets.token_hex(32)
    jwt_secret = secrets.token_hex(32)
    new_lines.append('OPENCHAMBER_UI_PASSWORD=' + ui_password)
    new_lines.append('OPENCHAMBER_DATA_DIR=/root/.config/openchamber' if not test else 'OPENCHAMBER_DATA_DIR=' + str(data_dir))
    passkeys = None
    if passkeys_file.exists():
        passkeys = json.loads(passkeys_file.read_text(encoding='utf-8'))
        if not isinstance(passkeys, dict) or not isinstance(passkeys.get('passkeys'), list):
            raise ValueError('INVALID_PASSKEY_STORE')
        passkeys['passwordBinding'] = hmac.new(jwt_secret.encode(), ui_password.encode(), hashlib.sha256).hexdigest()
    # All files written before commit marker; a crashed migration can repeat.
    secure_atomic(env_file, '\n'.join(new_lines) + '\n')
    secure_atomic(jwt_file, jwt_secret + '\n')
    if passkeys is not None:
        secure_atomic(passkeys_file, json.dumps(passkeys, indent=2) + '\n')
    secure_atomic(marker, 'rekeyed\n')
    for p in (env_file, jwt_file, marker, passkeys_file):
        if p.exists():
            os.chmod(p, stat.S_IRUSR | stat.S_IWUSR)
    return {'status': 'rekeyed', 'passkeys_preserved': len(passkeys['passkeys']) if passkeys else 0,
            'existing_ui_sessions_revoked': True}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', default='/root/.config/openchamber')
    options = parser.parse_args()
    try:
        print(json.dumps(rekey(options.data_dir, test=os.environ.get('OPENCHAMBER_UI_REKEY_TEST') == '1')))
    except (ValueError, OSError, json.JSONDecodeError) as error:
        print(json.dumps({'error': str(error)}), file=sys.stderr)
        sys.exit(2)