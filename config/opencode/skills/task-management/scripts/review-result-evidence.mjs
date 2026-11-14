// Canonical, fail-closed proof for a review-stage verdict. Shared by normal completion
// and recovery of a review that arrived after an older RUN had closed its stage.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const digest = text => createHash('sha256').update(text).digest('hex');
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const sha256 = value => typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
const fail = code => { throw new Error(code); };

export function readReviewVerdict({ stateRoot, runId, pipelineId, stage, evidencePath, mode = 'ready', allowLegacy = false }) {
  if (![runId, pipelineId, stage].every(validId)) fail('REVIEW_IDENTITY_INVALID');
  if (!evidencePath) fail('REVIEW_RESULT_PENDING: pass --evidence <run-local-review.json>');
  const root = resolve(stateRoot, runId);
  const file = resolve(evidencePath);
  if (!file.startsWith(root + sep)) fail('REVIEW_RESULT_OUTSIDE_RUN');
  const dispatchPath = join(root, 'checks', 'review-dispatch', `${pipelineId}--${stage}.json`);
  let dispatch, result, raw, modified;
  try {
    dispatch = JSON.parse(readFileSync(dispatchPath, 'utf8'));
  } catch { fail('REVIEW_DISPATCH_REQUIRED: dispatch CodeReviewer before recording its verdict'); }
  if (dispatch.run_id !== runId || dispatch.pipeline_id !== pipelineId || dispatch.stage !== stage || dispatch.role !== 'CodeReviewer') {
    fail('REVIEW_DISPATCH_IDENTITY_MISMATCH: a full CodeReviewer dispatch is required');
  }
  try {
    raw = readFileSync(file, 'utf8');
    result = JSON.parse(raw);
    modified = statSync(file).mtimeMs;
  } catch { fail('REVIEW_RESULT_PENDING: a persisted JSON verdict is required'); }
  if (!result || result.run_id !== runId || result.pipeline_id !== pipelineId || result.stage !== stage ||
      !Number.isFinite(Date.parse(dispatch.recorded_at)) || modified < Date.parse(dispatch.recorded_at)) {
    fail('REVIEW_RESULT_STALE_OR_WRONG_STAGE');
  }
  if (sha256(dispatch.source_digest) && typeof dispatch.review_dispatch_id === 'string') {
    if (result.review_dispatch_id !== dispatch.review_dispatch_id || result.review_source_digest !== dispatch.source_digest) {
      fail('REVIEW_RESULT_SOURCE_IDENTITY_MISMATCH');
    }
  } else if (!allowLegacy) {
    fail('REVIEW_DISPATCH_UNBOUND: dispatch CodeReviewer with a source-bound packet');
  }
  const findings = [
    ...(Array.isArray(result.findings) ? result.findings : []),
    ...(Array.isArray(result.blockers) ? result.blockers : []),
  ];
  const blockers = findings.filter(item => item && (item.blocking === true || (item.blocking === undefined && item.classification && item.classification !== 'optional')));
  const status = String(result.status ?? '').toLowerCase();
  if (mode === 'ready') {
    if (status !== 'ready' || blockers.length) fail('REVIEW_RESULT_NOT_READY: handle blocking findings before completing the stage');
  } else if (mode === 'negative') {
    if (!['needs_revision', 'fail', 'failed', 'technical_fix', 'security_fix'].includes(status) || !blockers.length) {
      fail('REVIEW_RESULT_NOT_BLOCKING: a concrete negative CodeReviewer verdict is required');
    }
  } else fail('REVIEW_RESULT_MODE_INVALID');
  return { dispatch, verdict: result, evidencePath: file, evidenceSha256: digest(raw), blockingFindings: blockers };
}
