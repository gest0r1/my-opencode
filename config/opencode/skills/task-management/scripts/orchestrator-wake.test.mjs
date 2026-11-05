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

test('unchanged state wakes once when pending work becomes runnable after child completion', () => {
  const raw = JSON.stringify(state());
  const running = wakeDecision({ stateRaw: raw, manifest, runnableCount: 1, pendingChildren: 1, runningWork: 1 });
  assert.equal(running.wake, true, 'an unrelated lane can run while the child is active');
  const repeated = wakeDecision({ stateRaw: raw, manifest, runnableCount: 1, pendingChildren: 1, runningWork: 1,
    lastFingerprint: running.fingerprint });
  assert.equal(repeated.wake, false, 'unchanged work does not generate duplicate synthetic messages');
  const finished = wakeDecision({ stateRaw: raw, manifest, runnableCount: 1, pendingChildren: 0, runningWork: 0,
    lastFingerprint: running.fingerprint });
  assert.equal(finished.wake, true, 'completed child changes actual runnable availability');
  assert.notEqual(finished.fingerprint, running.fingerprint);
  const stable = wakeDecision({ stateRaw: raw, manifest, runnableCount: 1,
    lastFingerprint: finished.fingerprint });
  assert.equal(stable.wake, false);
});

test('unknown/running children or owner checkpoints do not manufacture completion', () => {
  const raw = JSON.stringify(state());
  assert.equal(wakeDecision({ stateRaw: raw, manifest, pendingChildren: 1 }).reason, 'child_running');
  assert.equal(wakeDecision({ stateRaw: raw, manifest, runningWork: 1 }).reason, 'work_running');
  const question = state();
  question.pipelines.app.stages.review.status = 'awaiting_owner_approval';
  assert.equal(wakeDecision({ stateRaw: JSON.stringify(question), manifest }).reason, 'owner_checkpoint');
  assert.match(wakeText(runId), /Respect existing children, leases, gates and owner checkpoints/);
});

test('a lane awaiting owner review does not suppress an independent open lane', () => {
  const m = { pipelines: [{ id: 'waiting', executors: { accept: 'owner_acceptance' } }, { id: 'work', executors: { build: 'agent' } }] };
  const s = { run_id: runId, status: 'in_progress', pipelines: {
    waiting: { status: 'in_progress', stages: { accept: { status: 'in_progress' } } },
    work: { status: 'pending', stages: { build: { status: 'pending' } } },
  } };
  assert.equal(wakeDecision({ stateRaw: JSON.stringify(s), manifest: m, runnableCount: 1 }).wake, true);
  assert.equal(wakeDecision({ stateRaw: JSON.stringify(s), manifest: m, runnableCount: 1, pendingChildren: 1, runningWork: 1 }).wake, true);
  s.pipelines.waiting.stages.accept = { status: 'blocked', runtime_replans: [{ status: 'awaiting_owner_approval' }] };
  assert.equal(wakeDecision({ stateRaw: JSON.stringify(s), manifest: m, runnableCount: 1 }).wake, true);
  s.pipelines.work.status = 'completed';
  assert.equal(wakeDecision({ stateRaw: JSON.stringify(s), manifest: m, runnableCount: 0 }).wake, false);
});
