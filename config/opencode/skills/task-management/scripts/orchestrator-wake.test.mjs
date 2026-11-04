import assert from 'node:assert/strict';
import test from 'node:test';
import { wakeDecision, wakeText } from './orchestrator-wake.mjs';

const runId = 'example';
const manifest = { pipelines: [{ id: 'app', executors: { implementation: 'agent', review: 'review' } }] };
const state = () => ({
  run_id: runId, status: 'in_progress', updated_at: '2026-11-04T10:00:00.000Z',
  pipelines: { app: { status: 'in_progress', current_stage: 'implementation',
    stages: { implementation: { status: 'in_progress', technical_fix_cycles: 0 },
              review: { status: 'pending' } } } },
});

test('maintenance JSON writes do not trigger duplicate wakes', () => {
  const first = wakeDecision({ stateRaw: JSON.stringify(state()), manifest });
  assert.equal(first.wake, true);
  const changed = state();
  changed.updated_at = '2026-11-04T15:00:00.000Z';
  changed.github_outbox = [{ id: 'audit', delivered_issue_numbers: [1] }];
  changed.scope_preflight = { timestamp: '2026-11-04T15:00:01Z', paths: [] };
  const again = wakeDecision({ stateRaw: JSON.stringify(changed), manifest, lastFingerprint: first.fingerprint });
  assert.deepEqual({ wake: again.wake, reason: again.reason }, { wake: false, reason: 'no_progress_since_last_wake' });
});

test('real stage completion and repair-cycle change allow a new wake', () => {
  const first = wakeDecision({ stateRaw: JSON.stringify(state()), manifest });
  const progressed = state();
  progressed.pipelines.app.stages.implementation.status = 'completed';
  progressed.pipelines.app.current_stage = 'review';
  const second = wakeDecision({ stateRaw: JSON.stringify(progressed), manifest, lastFingerprint: first.fingerprint });
  assert.equal(second.wake, true);
  assert.notEqual(second.fingerprint, first.fingerprint);
  const repaired = state();
  repaired.pipelines.app.stages.implementation.technical_fix_cycles = 1;
  assert.equal(wakeDecision({ stateRaw: JSON.stringify(repaired), manifest, lastFingerprint: first.fingerprint }).wake, true);
});

test('unknown/running children or owner checkpoints do not manufacture completion', () => {
  const raw = JSON.stringify(state());
  assert.equal(wakeDecision({ stateRaw: raw, manifest, pendingChildren: 1 }).reason, 'child_running');
  assert.equal(wakeDecision({ stateRaw: raw, manifest, runningWork: 1 }).reason, 'work_running');
  const question = state();
  question.pipelines.app.stages.review.status = 'awaiting_owner_approval';
  assert.equal(wakeDecision({ stateRaw: JSON.stringify(question), manifest }).reason, 'owner_checkpoint');
  assert.match(wakeText(runId), /no child, worker lease or gate is running/);
});
