#!/usr/bin/env python3
"""Unprivileged behavioral suite for owner approval ledger. OS-UID proof is separate."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'opencode-owner-approval.py'
H = 'a'*64
B = 'b'*64
C = 'c'*64

def checkpoint(**changes):
    x = dict(run_instance_id='runinstance1', run_id='run1', operation='plan.final_manifest.approve', pipeline_id='p1', stage='final_manifest', generation=1, manifest_sha256=H, subject_sha256=B, candidate_sha='')
    x.update(changes)
    return x

class TestApproval(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.chmod(self.tmp.name, 0o700)

    def tearDown(self):
        self.tmp.cleanup()

    def call(self, role, action, **params):
        env = {**os.environ, 'MY_OPENCODE_APPROVAL_TEST_ROOT': self.tmp.name}
        proc = subprocess.run([sys.executable, str(SCRIPT), role], input=json.dumps({'action': action, **params}), text=True, capture_output=True, env=env)
        return proc.returncode, json.loads(proc.stdout if proc.returncode==0 else proc.stderr)

    def submit(self, data=None):
        code, body = self.call('agent','submit',checkpoint=data or checkpoint())
        self.assertEqual(code,0,body)
        return body['id']

    def test_owner_only_can_approve(self):
        data = checkpoint()
        rid = self.submit(data)
        code, body = self.call('agent','approve',request_id=rid)
        self.assertNotEqual(code,0)
        self.assertEqual(body['error'],'AGENT_ACTION_FORBIDDEN')
        code, body = self.call('agent','consume',request_id=rid,checkpoint=data)
        self.assertFalse(body['authorized'])
        code, body = self.call('owner','approve',request_id=rid)
        self.assertEqual(code,0,body)
        code, body = self.call('agent','consume',request_id=rid,checkpoint=data)
        self.assertTrue(body['authorized'])
        self.assertTrue(body['consumed'])

    def test_replay_idempotent_but_new_subject_denied(self):
        data = checkpoint()
        rid = self.submit(data)
        self.call('owner','approve',request_id=rid)
        self.assertTrue(self.call('agent','consume',request_id=rid,checkpoint=data)[1]['authorized'])
        self.assertTrue(self.call('agent','consume',request_id=rid,checkpoint=data)[1]['authorized'])
        self.assertEqual(self.submit(data),rid)
        for change in [dict(run_id='run2'),dict(manifest_sha256=C),dict(generation=2),dict(subject_sha256=C),dict(operation='owner.accept',candidate_sha=C),dict(run_instance_id='other')]:
            code, body = self.call('agent','consume',request_id=rid,checkpoint=checkpoint(**change))
            self.assertNotEqual(code,0)
            self.assertEqual(body['error'],'CHECKPOINT_MISMATCH')

    def test_rejection_does_not_authorize(self):
        data=checkpoint()
        rid=self.submit(data)
        self.assertEqual(self.call('owner','reject',request_id=rid)[1]['decision'],'rejected')
        self.assertFalse(self.call('agent','consume',request_id=rid,checkpoint=data)[1]['authorized'])
        self.assertNotEqual(self.call('owner','approve',request_id=rid)[0],0)

    def test_invalid_fields_and_no_owner_bypass(self):
        data=checkpoint(candidate_sha='z')
        code,body=self.call('agent','submit',checkpoint=data)
        self.assertNotEqual(code,0)
        self.assertEqual(body['error'],'INVALID_CANDIDATE_SHA')
        code,body=self.call('agent','submit',checkpoint=checkpoint(operation='owner.accept'))
        self.assertNotEqual(code,0)
        self.assertEqual(body['error'],'CANDIDATE_SHA_REQUIRED')
        code,body=self.call('agent','owner',request_id='0'*32)
        self.assertNotEqual(code,0)
        self.assertEqual(body['error'],'AGENT_ACTION_FORBIDDEN')

    def test_ledger_file_permissions(self):
        self.submit()
        root=Path(self.tmp.name)
        self.assertEqual((root/'ledger.sqlite3').stat().st_mode&0o077,0)
        self.assertEqual(root.stat().st_mode&0o077,0)

if __name__=='__main__': unittest.main()