import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readReviewVerdict } from './review-result-evidence.mjs';

const sha = 'a'.repeat(64);
function fixture(t, { legacy = false, role = 'CodeReviewer' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'review-proof-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runId = 'run-one', pipelineId = 'lane-one', stage = 'review';
  const dir = join(root, runId);
  const dispatchPath = join(dir, 'checks', 'review-dispatch', `${pipelineId}--${stage}.json`);
  const evidencePath = join(dir, 'handoffs', 'results', 'review.json');
  mkdirSync(join(dir, 'checks', 'review-dispatch'), { recursive: true });
  mkdirSync(join(dir, 'handoffs', 'results'), { recursive: true });
  const dispatch = { run_id: runId, pipeline_id: pipelineId, stage, role, loop: 0,
    recorded_at: new Date(Date.now() - 2000).toISOString(),
    ...(legacy ? {} : { review_dispatch_id: 'review-1', source_digest: sha }) };
  const verdict = { status: 'ready', run_id: runId, pipeline_id: pipelineId, stage,
    findings: [], ...(legacy ? {} : { review_dispatch_id: dispatch.review_dispatch_id, review_source_digest: sha }) };
  const writeDispatch = value => writeFileSync(dispatchPath, JSON.stringify(value));
  const writeVerdict = value => writeFileSync(evidencePath, JSON.stringify(value));
  writeDispatch(dispatch);
  writeVerdict(verdict);
  const args = { stateRoot: root, runId, pipelineId, stage, evidencePath };
  return { args, dispatch, verdict, writeDispatch, writeVerdict, evidencePath };
}

test('ready verdict needs a full CodeReviewer result from the current dispatch/source', t => {
  const f = fixture(t);
  const result = readReviewVerdict(f.args);
  assert.equal(result.verdict.status, 'ready');
  assert.match(result.evidenceSha256, /^[0-9a-f]{64}$/);
  f.writeVerdict({ ...f.verdict, review_dispatch_id: 'older' });
  assert.throws(() => readReviewVerdict(f.args), /REVIEW_RESULT_SOURCE_IDENTITY_MISMATCH/);
  f.writeVerdict({ ...f.verdict, review_source_digest: 'b'.repeat(64) });
  assert.throws(() => readReviewVerdict(f.args), /REVIEW_RESULT_SOURCE_IDENTITY_MISMATCH/);
  f.writeVerdict(f.verdict);
  f.writeDispatch({ ...f.dispatch, role: 'FindingsReviewer' });
  assert.throws(() => readReviewVerdict(f.args), /REVIEW_DISPATCH_IDENTITY_MISMATCH/);
});

test('missing, nonlocal, stale, mismatched and unbound review evidence cannot complete', t => {
  const f = fixture(t);
  assert.throws(() => readReviewVerdict({ ...f.args, evidencePath: null }), /REVIEW_RESULT_PENDING/);
  assert.throws(() => readReviewVerdict({ ...f.args, evidencePath: '/tmp/unrelated-review.json' }), /REVIEW_RESULT_OUTSIDE_RUN/);
  f.writeVerdict({ ...f.verdict, stage: 'other' });
  assert.throws(() => readReviewVerdict(f.args), /REVIEW_RESULT_STALE_OR_WRONG_STAGE/);
  f.writeVerdict(f.verdict);
  f.writeDispatch({ ...f.dispatch, recorded_at: new Date(Date.now() + 60000).toISOString() });
  assert.throws(() => readReviewVerdict(f.args), /REVIEW_RESULT_STALE_OR_WRONG_STAGE/);
  f.writeDispatch({ ...f.dispatch, source_digest: undefined, review_dispatch_id: undefined });
  assert.throws(() => readReviewVerdict(f.args), /REVIEW_DISPATCH_UNBOUND/);
});

test('blocking/optional verdicts differ: optional does not create a repair', t => {
  const f = fixture(t);
  const optional = { ...f.verdict, status: 'needs_revision',
    findings: [{ classification: 'optional', blocking: false }] };
  f.writeVerdict(optional);
  assert.throws(() => readReviewVerdict(f.args), /REVIEW_RESULT_NOT_READY/);
  assert.throws(() => readReviewVerdict({ ...f.args, mode: 'negative' }), /REVIEW_RESULT_NOT_BLOCKING/);
  const blocking = { ...f.verdict, status: 'needs_revision',
    findings: [{ classification: 'technical_fix', blocking: true, locations: ['src/x.ts:2'] }] };
  f.writeVerdict(blocking);
  assert.equal(readReviewVerdict({ ...f.args, mode: 'negative' }).blockingFindings.length, 1);
  f.writeVerdict({ ...f.verdict, findings: blocking.findings });
  assert.throws(() => readReviewVerdict(f.args), /REVIEW_RESULT_NOT_READY/);
});

test('legacy late review remains eligible only for negative/verified blocking repair', t => {
  const f = fixture(t, { legacy: true });
  f.writeVerdict({ ...f.verdict, status: 'needs_revision',
    findings: [{ classification: 'technical_fix', blocking: true }] });
  assert.throws(() => readReviewVerdict({ ...f.args, mode: 'negative' }), /REVIEW_DISPATCH_UNBOUND/);
  assert.equal(readReviewVerdict({ ...f.args, mode: 'negative', allowLegacy: true }).blockingFindings.length, 1);
  f.writeVerdict({ ...f.verdict, status: 'ready', findings: [] });
  assert.throws(() => readReviewVerdict({ ...f.args, mode: 'negative', allowLegacy: true }), /REVIEW_RESULT_NOT_BLOCKING/);
});
