#!/usr/bin/env python3
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

MODULE = Path(__file__).resolve().parents[1] / 'scripts/opencode-owner-approval-state.py'
SPEC = importlib.util.spec_from_file_location('owner_passkey_state', MODULE)
STATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(STATE)


class OwnerPasskeyStateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.database = Path(self.tmp.name) / 'approval.db'
        self.conn = sqlite3.connect(self.database, isolation_level=None)
        self.addCleanup(self.conn.close)
        STATE.initialize(self.conn)
        self.now = 100
        self.run = self.act('runtime', 'register', run_id='test-run', session_id='ses_existing', workspace='workspace')
        self.act('admin', 'register_credential', credential_id='key_id', public_key='cose_key', counter=0)

    def act(self, role, action, **fields):
        return STATE.act(self.conn, role, {'action': action, **fields}, clock=lambda: self.now)

    def plan(self, previous=0, name='one'):
        raw = json.dumps({'schema_version': 2, 'run_id': 'test-run', 'title': name, 'repository': 'example/project',
                          'pipelines': [{'id': 'jobs', 'stages': ['accept'], 'executors': {'accept': 'owner_acceptance'}}]})
        entry = self.act('runtime', 'prepare', instance_id=self.run['instance_id'], operation='plan.final_manifest.approve',
                         pipeline_id='all', stage='approval', previous_generation=previous, snapshot=raw)
        self.assertEqual(entry['manifest_sha256'], hashlib.sha256(raw.encode()).hexdigest())
        return entry

    def challenge(self, entry, decision='approve'):
        return self.act('verifier', 'challenge', request_id=entry['request_id'], decision=decision)['challenge']

    def finish(self, entry, challenge, after=1, before=0):
        return self.act('verifier', 'finish', request_id=entry['request_id'], challenge=challenge,
                        credential_id='key_id', previous_counter=before, new_counter=after)

    def test_approval_is_atomically_bound_to_snapshot_and_recovers_same_outbox(self):
        plan = self.plan()
        self.assertEqual(self.plan()['request_id'], plan['request_id'])
        shown = self.act('verifier', 'review', request_id=plan['request_id'])
        self.assertEqual(json.loads(shown['snapshot'])['title'], 'one')
        self.assertEqual(shown['session_id'], 'ses_existing')
        challenge = self.challenge(plan)
        self.assertEqual(self.finish(plan, challenge)['decision'], 'approved')
        with self.assertRaisesRegex(ValueError, 'CHECKPOINT_NOT_PENDING'):
            self.finish(plan, challenge)
        self.assertEqual(self.act('runtime', 'continuations', session_id='ses_other')['pending'], [])
        pending = self.act('runtime', 'continuations', session_id='ses_existing')['pending']
        self.assertEqual(len(pending), 1)
        self.conn.close()
        self.conn = sqlite3.connect(self.database, isolation_level=None)
        self.addCleanup(self.conn.close)
        self.assertEqual(self.act('runtime', 'continuations', session_id='ses_existing')['pending'], pending)
        with self.assertRaisesRegex(ValueError, 'CONTINUATION_MISMATCH'):
            self.act('runtime', 'ack_continuation', request_id=plan['request_id'], session_id='ses_existing', message_id='other')
        with self.assertRaisesRegex(ValueError, 'CONTINUATION_MISMATCH'):
            self.act('runtime', 'ack_continuation', request_id=plan['request_id'], session_id='ses_existing', message_id=pending[0]['message_id'])
        self.act('runtime', 'claim_continuation', request_id=plan['request_id'], session_id='ses_existing', message_id=pending[0]['message_id'])
        for _ in range(2):
            self.act('runtime', 'ack_continuation', request_id=plan['request_id'], session_id='ses_existing', message_id=pending[0]['message_id'])
        self.assertEqual(self.act('runtime', 'continuations', session_id='ses_existing')['pending'], [])

    def test_reject_has_no_continuation_and_a_stale_revision_cannot_reactivate(self):
        old = self.plan()
        challenge = self.challenge(old)
        new = self.plan(previous=1, name='two')
        with self.assertRaisesRegex(ValueError, 'CHECKPOINT_GENERATION_MISMATCH'):
            self.plan(previous=0)
        with self.assertRaisesRegex(ValueError, 'CHECKPOINT_NOT_PENDING'):
            self.finish(old, challenge)
        self.assertEqual(self.finish(new, self.challenge(new, 'reject'))['decision'], 'rejected')
        self.assertEqual(self.act('runtime', 'continuations', session_id='ses_existing')['pending'], [])

    def test_extension_history_shows_current_pending_and_preceding_generations_without_snapshot(self):
        old = self.plan()
        new = self.plan(previous=1, name='two')
        self.assertEqual(self.act('runtime', 'list_pending_sessions'), {'sessions': ['ses_existing']})
        entries = self.act('runtime', 'list_checkpoints', before=0)['entries']
        self.assertEqual([(entry['request_id'], entry['decision']) for entry in entries],
                         [(new['request_id'], 'pending'), (old['request_id'], 'superseded')])
        self.assertEqual(entries[0]['project'], 'example/project')
        self.assertNotIn('snapshot', entries[0])
        self.now += STATE.APPROVAL_TIMEOUT
        self.assertEqual(self.act('runtime', 'list_pending_sessions'), {'sessions': []})
        self.assertEqual(self.act('runtime', 'list_checkpoints', before=0)['entries'][0]['decision'], 'expired')

    def test_an_in_flight_continuation_blocks_a_revision_and_recovers_after_a_lease(self):
        plan = self.plan()
        self.finish(plan, self.challenge(plan))
        entry = self.act('runtime', 'scan_continuations')['pending'][0]
        identity = {key: entry[key] for key in ('request_id', 'session_id', 'message_id')}
        self.assertTrue(self.act('runtime', 'claim_continuation', **identity)['claimed'])
        self.assertFalse(self.act('runtime', 'claim_continuation', **identity)['claimed'])
        with self.assertRaisesRegex(ValueError, 'OWNER_CONTINUATION_IN_PROGRESS'):
            self.plan(previous=1, name='new')
        self.now += 15
        self.assertTrue(self.act('runtime', 'claim_continuation', **identity)['claimed'])
        self.act('runtime', 'ack_continuation', **identity)
        replacement = self.plan(previous=1, name='new')
        self.assertNotEqual(replacement['request_id'], plan['request_id'])

    def test_unfreeze_suspends_the_old_plan_and_requires_canonical_refreeze_lineage(self):
        plan = self.plan()
        self.finish(plan, self.challenge(plan))
        unfreeze = self.act('runtime', 'prepare', instance_id=self.run['instance_id'], operation='plan.unfreeze',
                            pipeline_id='all', stage='approval', previous_generation=0,
                            snapshot=json.dumps({'run_id': 'test-run', 'manifest_sha256': plan['manifest_sha256']}))
        self.finish(unfreeze, self.challenge(unfreeze), before=1, after=2)
        self.assertFalse(self.act('runtime', 'status', request_id=plan['request_id'])['current'])
        revised = self.plan(previous=1, name='refrozen')
        lineage = {'request_id': revised['request_id'], 'unfreeze_request_id': unfreeze['request_id']}
        self.assertFalse(self.act('runtime', 'verify_refreeze', **lineage)['authorized'])
        self.finish(revised, self.challenge(revised), before=2, after=3)
        self.assertTrue(self.act('runtime', 'verify_refreeze', **lineage)['authorized'])
        self.assertFalse(self.act('runtime', 'verify_refreeze', request_id=revised['request_id'], unfreeze_request_id=plan['request_id'])['authorized'])

    def test_retirement_invalidates_receipts_challenges_and_outbox(self):
        plan = self.plan()
        self.finish(plan, self.challenge(plan))
        self.act('runtime', 'retire_run', run_id='test-run', replacement_run_id='replacement')
        self.assertEqual(self.act('runtime', 'retired_run', run_id='test-run')['replacement_run_id'], 'replacement')
        self.assertFalse(self.act('runtime', 'status', request_id=plan['request_id'])['current'])
        self.assertEqual(self.act('runtime', 'scan_continuations')['pending'], [])
        with self.assertRaisesRegex(ValueError, 'OWNER_RUN_RETIRED'):
            self.plan(previous=1, name='later')

    def test_agent_cannot_decide_and_revocation_and_expiry_fail_closed(self):
        plan = self.plan()
        challenge = self.challenge(plan)
        with self.assertRaisesRegex(ValueError, 'APPROVAL_ACTION_FORBIDDEN'):
            self.act('runtime', 'finish', request_id=plan['request_id'], challenge=challenge,
                     credential_id='key_id', previous_counter=0, new_counter=1)
        self.now += STATE.CHALLENGE_TIMEOUT
        with self.assertRaisesRegex(ValueError, 'INVALID_OR_EXPIRED_CHALLENGE'):
            self.finish(plan, challenge)
        fresh = self.challenge(plan)
        self.act('admin', 'revoke_credential', credential_id='key_id')
        with self.assertRaisesRegex(ValueError, 'UNKNOWN_OWNER_CREDENTIAL'):
            self.finish(plan, fresh)
        self.assertEqual(self.act('runtime', 'status', request_id=plan['request_id'])['decision'], 'pending')

    def test_acceptance_binds_a_candidate_to_the_current_approved_plan(self):
        plan = self.plan()
        request = {'instance_id': self.run['instance_id'], 'operation': 'owner.accept', 'pipeline_id': 'jobs',
                   'stage': 'accept', 'previous_generation': 0, 'snapshot': json.dumps({
                       'manifest_sha256': plan['manifest_sha256'], 'pipeline_id': 'jobs', 'stage': 'accept', 'candidate_sha': 'a' * 40,
                   })}
        with self.assertRaisesRegex(ValueError, 'PLAN_APPROVAL_REQUIRED'):
            self.act('runtime', 'prepare', **request)
        self.finish(plan, self.challenge(plan))
        acceptance = self.act('runtime', 'prepare', **request)
        self.assertEqual(acceptance['candidate_sha'], 'a' * 40)
        self.finish(acceptance, self.challenge(acceptance), before=1, after=2)
        self.plan(previous=1, name='revised')
        self.assertFalse(self.act('runtime', 'status', request_id=acceptance['request_id'])['current'])
        self.assertEqual(self.act('runtime', 'continuations', session_id='ses_existing')['pending'], [])

    def test_enrollment_requires_an_administrator_and_is_consumed_once(self):
        with self.assertRaisesRegex(ValueError, 'APPROVAL_ACTION_FORBIDDEN'):
            self.act('verifier', 'create_enrollment')
        token = self.act('admin', 'create_enrollment')['token']
        enrollment = self.act('verifier', 'enrollment', token=token)
        parameters = {'token': token, 'challenge': enrollment['challenge'], 'credential_id': 'new_key',
                      'public_key': 'public_test_key', 'counter': 0}
        self.act('verifier', 'enroll', **parameters)
        with self.assertRaisesRegex(ValueError, 'INVALID_OR_EXPIRED_ENROLLMENT'):
            self.act('verifier', 'enroll', **parameters)


if __name__ == '__main__':
    unittest.main()
