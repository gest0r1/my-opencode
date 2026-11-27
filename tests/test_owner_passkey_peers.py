#!/usr/bin/env python3
"""Disposable Linux container acceptance for the canonical socket roles."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOCKETS = Path('/run/my-opencode-approval')
LEDGER = Path('/var/lib/my-opencode-approval')


def request(path, payload=None):
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(5)
        client.connect(str(SOCKETS / path))
        if payload is not None:
            client.sendall(json.dumps(payload).encode() + b'\n')
        with client.makefile('rb') as stream:
            return json.loads(stream.readline())


class PasskeyPeerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if os.environ.get('MY_OPENCODE_DISPOSABLE_PEER_TEST') != '1' or os.geteuid() != 0:
            raise unittest.SkipTest('requires an explicitly isolated root Linux fixture')
        if SOCKETS.exists() or LEDGER.exists():
            raise RuntimeError('Refusing pre-existing broker paths')
        cls.broker = subprocess.Popen([sys.executable, str(ROOT / 'scripts/opencode-owner-approvald.py'), '--passkey'])
        cls.addClassCleanup(cls.stop_broker)
        for _ in range(80):
            if all((SOCKETS / name).is_socket() for name in ('agent.sock', 'verify.sock', 'admin.sock')):
                return
            if cls.broker.poll() is not None:
                break
            time.sleep(.05)
        raise RuntimeError('The passkey broker did not serve')

    @classmethod
    def stop_broker(cls):
        cls.broker.terminate()
        cls.broker.wait(timeout=10)

    def as_user(self, user, path, payload):
        return subprocess.run(['runuser', '-u', user, '--', sys.executable, __file__, path, json.dumps(payload)],
                              capture_output=True, text=True, timeout=8)

    def test_no_legacy_decider_or_agent_access_to_verifier_or_admin(self):
        self.assertFalse((SOCKETS / 'owner.sock').exists())
        for target in ('verify.sock', 'admin.sock'):
            response = self.as_user('opencode', target, {'action': 'create_enrollment'})
            self.assertNotEqual(response.returncode, 0)
        response = self.as_user('opencode-approval', 'admin.sock', {'action': 'create_enrollment'})
        self.assertNotEqual(response.returncode, 0)
        role_boundary = self.as_user('opencode', 'agent.sock', {'action': 'finish'})
        self.assertEqual(role_boundary.returncode, 0, role_boundary.stderr)
        self.assertEqual(json.loads(role_boundary.stdout), {'error': 'APPROVAL_ACTION_FORBIDDEN'})
        uid_boundary = request('verify.sock')
        self.assertEqual(uid_boundary, {'error': 'PEER_UID_FORBIDDEN'})
        verifier = self.as_user('opencode-approval', 'verify.sock', {'action': 'review', 'request_id': 'nonexistent'})
        self.assertEqual(verifier.returncode, 0, verifier.stderr)
        self.assertEqual(json.loads(verifier.stdout), {'error': 'UNKNOWN_REQUEST'})
        self.assertIn('ok', request('admin.sock', {'action': 'create_enrollment'}))


if __name__ == '__main__':
    if len(sys.argv) == 3:
        print(json.dumps(request(sys.argv[1], json.loads(sys.argv[2]))))
    else:
        unittest.main()
