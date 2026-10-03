import test from 'node:test';
import assert from 'node:assert/strict';
import { selectWorkflowRun, validateWorkflowResult, inspectWorkflowText } from './github-actions-gate-core.mjs';

const head = 'a'.repeat(40), merge = 'b'.repeat(40), base = 'c'.repeat(40);
const pr = { number: 7, head: { sha: head, ref: 'feature/test', repo: { full_name: 'owner/repo' } }, base: { sha: base, repo: { full_name: 'owner/repo' } }, merge_commit_sha: merge };
const run = { id: 12, head_sha: merge, head_branch: 'feature/test', event: 'pull_request', status: 'completed', conclusion: 'success', pull_requests: [{ number: 7, head: { sha: head }, base: { sha: base } }] };
const context = { candidateSha: head, branch: 'feature/test', event: 'pull_request', pullRequest: pr, repository: 'owner/repo', prNumber: 7 };
const contract = { workflow: '.github/workflows/ci.yml', terminal_job: 'tests', trigger: 'pull_request', pr_number: 7 };
const result = (r = run, p = pr) => validateWorkflowResult({ run: r, pullRequest: p, repository: 'owner/repo', branch: 'feature/test', candidateSha: head, contract, executor: 'github_ci', jobs: [{ id: 1, name: 'tests', status: 'completed', conclusion: 'success' }] });

test('PR merge SHA and direct head SHA are mapped to exact candidate', () => {
  assert.equal(selectWorkflowRun([run], context), run);
  assert.equal(result().pr_head_sha, head);
  assert.equal(result({ ...run, head_sha: head }).candidate_sha, head);
});
test('wrong PR, new head, stale base/merge, foreign repository and missing association fail closed', () => {
  for (const changed of [{ ...run, head_sha: 'd'.repeat(40) }, { ...run, pull_requests: [] }, { ...run, pull_requests: [{ number: 8, head: { sha: head } }] }]) {
    assert.equal(selectWorkflowRun([changed], context), undefined);
    assert.throws(() => result(changed), /GITHUB_PR_/);
  }
  assert.throws(() => result(run, { ...pr, head: { ...pr.head, sha: 'd'.repeat(40) } }), /GITHUB_PR_/);
  assert.throws(() => result(run, { ...pr, base: { ...pr.base, sha: 'd'.repeat(40) } }), /GITHUB_PR_/);
  assert.throws(() => result(run, { ...pr, head: { ...pr.head, repo: { full_name: 'fork/repo' } } }), /GITHUB_PR_/);
});
test('push mode remains exact SHA and PR context cannot make merge SHA pass as push', () => {
  assert.equal(selectWorkflowRun([run], { ...context, event: 'push' }), undefined);
  assert.throws(() => validateWorkflowResult({ run, contract: { ...contract, trigger: 'push' }, candidateSha: head, jobs: [], executor: 'github_ci' }), /GITHUB_RUN_SHA_MISMATCH/);
});
test('PR contract requires explicit number and rejects path filtering', () => {
  const yaml = 'on:\n  pull_request:\n    paths: [src/**]\npermissions:\n  contents: read\njobs:\n  tests:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n';
  assert.ok(inspectWorkflowText(yaml, contract, 'github_ci').issues.some(x => x.includes('paths')));
  assert.throws(() => result(run, null), /GITHUB_PR_/);
});
