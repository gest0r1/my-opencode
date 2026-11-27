#!/usr/bin/env python3
"""Administrative passkey enrollment and revocation over the root-only socket."""
import argparse
import json
import os
from pathlib import Path
import socket
import stat
import sys
from urllib.parse import urlsplit

SOCKET = '/run/my-opencode-approval/admin.sock'
POLICY = Path('/etc/my-opencode/owner-broker-passkey')


def admin(request):
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(5)
        client.connect(SOCKET)
        client.sendall(json.dumps(request).encode() + b'\n')
        with client.makefile('rb') as stream:
            reply = json.loads(stream.readline(16384))
    if 'ok' not in reply:
        raise RuntimeError('The broker rejected the administrative request')
    return reply['ok']


def main():
    if os.geteuid() != 0:
        raise RuntimeError('Run this command from an administrative root SSH session')
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='action', required=True)
    commands.add_parser('enroll')
    revoke = commands.add_parser('revoke')
    revoke.add_argument('credential_id')
    args = parser.parse_args()
    if args.action == 'enroll':
        attributes = POLICY.lstat()
        if not stat.S_ISREG(attributes.st_mode) or attributes.st_uid != 0 or attributes.st_mode & 0o022:
            raise RuntimeError('The owner approval policy is not trusted')
        origin = POLICY.read_text(encoding='utf-8').strip()
        address = urlsplit(origin)
        if (address.scheme != 'https' or not address.hostname or not address.netloc or address.username is not None
                or address.password is not None or address.path or address.fragment or address.query):
            raise RuntimeError('Supply the configured HTTPS origin without a path')
        result = admin({'action': 'create_enrollment'})
        print(f'{origin}/enroll#{result["token"]}')
    else:
        admin({'action': 'revoke_credential', 'credential_id': args.credential_id})
        print('Owner passkey revoked')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
