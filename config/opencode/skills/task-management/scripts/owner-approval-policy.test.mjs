import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOwnerApprovalComment, isAuthenticatedApprovalComment, latestApprovalEntry } from './owner-approval-policy.mjs';

const sha = 'a'.repeat(64);
const entry = { issue_number: 12, artifact_path: 'stories/issue-12.md', sha256: sha, decision: 'approve' };
const body = (entries = [entry], run_id = 'run-12') =>
  '<!-- pipeline-owner-approval:v1\n' + JSON.stringify({ run_id, entries }) + '\n-->';
const comment = (overrides = {}) => ({
  id: 101, user: 'owner', created_at: '2026-10-31T12:00:00Z', updated_at: '2026-10-31T12:00:00Z',
  owner_approval_authorized: true, body: body(), ...overrides,
});

test('strict human comment grammar, no mixed requirement text', () => {
  assert.deepEqual(parseOwnerApprovalComment(body()), { run_id: 'run-12', entries: [entry] });
  assert.equal(parseOwnerApprovalComment('please change behavior\n' + body()), null);
  assert.equal(parseOwnerApprovalComment(body() + '\nnew requirement'), null);
  assert.equal(parseOwnerApprovalComment(body([{ ...entry, sha256: 'not-a-hash' }])), null);
  assert.equal(parseOwnerApprovalComment(body([{ ...entry, issue_number: 13 }])), null);
  assert.equal(parseOwnerApprovalComment(body([{ ...entry, issue_number: 1 }])), null);
  assert.equal(parseOwnerApprovalComment(body([entry, entry])), null);
  assert.equal(parseOwnerApprovalComment(body([{ ...entry, artifact_path: '../manifest.json' }])), null);
  assert.equal(parseOwnerApprovalComment(body([{ ...entry, decision: 'accept' }])), null);
});

test('approval must be from checked actor and unedited human comment', () => {
  assert.equal(isAuthenticatedApprovalComment(comment()), true);
  assert.equal(isAuthenticatedApprovalComment(comment({ owner_approval_authorized: false })), false);
  assert.equal(isAuthenticatedApprovalComment(comment({ updated_at: '2026-10-31T12:01:00Z' })), false);
  assert.equal(isAuthenticatedApprovalComment(comment({ body: 'LGTM' })), false);
});

test('latest approval, rejection and run identity', () => {
  const reject = { ...entry, decision: 'reject' };
  const issues = [{ number: 12, comments: [
    comment(), comment({ id: 102, created_at: '2026-10-31T12:03:00Z',
      updated_at: '2026-10-31T12:03:00Z', body: body([reject]) }),
  ] }];
  assert.equal(latestApprovalEntry(issues, 'run-12', 12, entry.artifact_path).decision, 'reject');
  assert.equal(latestApprovalEntry(issues, 'other-run', 12, entry.artifact_path), null);
  assert.equal(latestApprovalEntry(issues, 'run-12', 13, entry.artifact_path), null);
});

test('versioned delta format and multiple entries', () => {
  const delta = { issue_number: 12, artifact_path: 'planning/story-deltas/issue-12-v1.md',
    sha256: 'b'.repeat(64), decision: 'approve' };
  assert.deepEqual(parseOwnerApprovalComment(body([entry, delta])).entries, [entry, delta]);
});

test('an untrusted later comment cannot override an authenticated owner decision', () => {
  const fake = comment({ id: 1002, owner_approval_authorized: false,
    body: body([{ ...entry, decision: 'reject' }]) });
  assert.equal(latestApprovalEntry([{ number: 12, comments: [comment(), fake] }],
    'run-12', 12, entry.artifact_path).decision, 'approve');
});

test('the latest owner rejection wins even for equal timestamps', () => {
  const refusal = comment({ id: 102, body: body([{ ...entry, decision: 'reject' }]) });
  assert.equal(latestApprovalEntry([{ number: 12, comments: [refusal, comment()] }],
    'run-12', 12, entry.artifact_path).comment.id, 102);
});

test('rejects extra metadata and same-prefix path tricks', () => {
  assert.equal(parseOwnerApprovalComment(body([{ ...entry, extra: true }])), null);
  assert.equal(parseOwnerApprovalComment(body([{ ...entry, artifact_path: 'stories/issue-123.md' }])), null);
  assert.equal(parseOwnerApprovalComment(body([{ ...entry, artifact_path: 'planning/story-deltas/issue-12-../bad.md' }])), null);
  assert.equal(parseOwnerApprovalComment(body([], '../escape')), null);
});
