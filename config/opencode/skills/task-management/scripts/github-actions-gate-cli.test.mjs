import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyMissingWorkflow,
  inspectWorkflowText,
  selectWorkflowRun,
  validateWorkflowResult,
} from './github-actions-gate-core.mjs';

const contract = {
  workflow: '.github/workflows/ci.yml',
  terminal_job: 'pipeline_ci',
  trigger: 'push',
  artifact: 'candidate-build',
};

test('workflow inspection requires declared push trigger and terminal job', () => {
  const result = inspectWorkflowText(`
name: CI
on:
  push:
    branches: ['feature/**']
permissions:
  contents: read
jobs:
  tests:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
  pipeline_ci:
    name: pipeline_ci
    needs: [tests]
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`, contract, 'github_ci');
  assert.equal(result.status, 'READY');
  assert.equal(result.terminal_job_name, 'pipeline_ci');
  assert.deepEqual(result.issues, []);
});

test('workflow inspection rejects dangerous candidate-CI primitives', () => {
  const result = inspectWorkflowText(`
on:
  push:
  pull_request_target:
permissions: write-all
jobs:
  pipeline_ci:
    runs-on: ubuntu-latest
    steps:
      - run: echo no
`, contract, 'github_ci');
  assert.equal(result.status, 'INCOMPATIBLE');
  assert.ok(result.issues.some((item) => item.includes('pull_request_target')));
  assert.ok(result.issues.some((item) => item.includes('write-all')));
});

test('missing workflow is an explicit bootstrap state rather than local fallback', () => {
  const result = classifyMissingWorkflow(contract, 'github_ci');
  assert.equal(result.status, 'MISSING');
  assert.equal(result.workflow, '.github/workflows/ci.yml');
});

test('run selection is exact-SHA, exact-branch and chooses latest attempt', () => {
  const selected = selectWorkflowRun([
    { id: 1, head_sha: 'a'.repeat(40), head_branch: 'feature/x', event: 'push', run_attempt: 1 },
    { id: 2, head_sha: 'b'.repeat(40), head_branch: 'feature/x', event: 'push', run_attempt: 1 },
    { id: 3, head_sha: 'a'.repeat(40), head_branch: 'feature/x', event: 'push', run_attempt: 2 },
    { id: 4, head_sha: 'a'.repeat(40), head_branch: 'other', event: 'push', run_attempt: 3 },
  ], {
    candidateSha: 'a'.repeat(40),
    branch: 'feature/x',
    event: 'push',
  });
  assert.equal(selected.id, 3);
});

test('workflow result requires successful terminal job and artifact from same run', () => {
  const result = validateWorkflowResult({
    run: {
      id: 50,
      run_attempt: 2,
      head_sha: 'c'.repeat(40),
      head_branch: 'feature/x',
      event: 'push',
      status: 'completed',
      conclusion: 'success',
    },
    jobs: [{ id: 70, name: 'pipeline_ci', status: 'completed', conclusion: 'success' }],
    artifacts: [{ id: 90, name: 'candidate-build', expired: false }],
    contract,
    candidateSha: 'c'.repeat(40),
    terminalJobName: 'pipeline_ci',
    executor: 'github_ci',
  });
  assert.equal(result.status, 'PASS');
  assert.equal(result.workflow_run_id, 50);
  assert.equal(result.run_attempt, 2);
  assert.equal(result.artifact_id, 90);
});

test('successful run from another SHA cannot satisfy the gate', () => {
  assert.throws(() => validateWorkflowResult({
    run: {
      id: 50,
      head_sha: 'd'.repeat(40),
      head_branch: 'feature/x',
      event: 'push',
      status: 'completed',
      conclusion: 'success',
    },
    jobs: [{ id: 70, name: 'pipeline_ci', status: 'completed', conclusion: 'success' }],
    artifacts: [{ id: 90, name: 'candidate-build', expired: false }],
    contract,
    candidateSha: 'c'.repeat(40),
    terminalJobName: 'pipeline_ci',
    executor: 'github_ci',
  }), /GITHUB_RUN_SHA_MISMATCH/);
});

test('DEV evidence retains exact source CI run identity', () => {
  const dev = {
    workflow: '.github/workflows/dev.yml',
    terminal_job: 'pipeline_dev',
    trigger: 'workflow_dispatch',
    mode: 'stateful',
    environment: 'development',
    source_ci_stage: 'tests',
  };
  const result = validateWorkflowResult({
    run: {
      id: 80,
      head_sha: 'e'.repeat(40),
      head_branch: 'feature/x',
      event: 'workflow_dispatch',
      status: 'completed',
      conclusion: 'success',
    },
    jobs: [{ id: 81, name: 'pipeline_dev', status: 'completed', conclusion: 'success' }],
    artifacts: [],
    contract: dev,
    candidateSha: 'e'.repeat(40),
    terminalJobName: 'pipeline_dev',
    executor: 'github_dev',
    sourceCiRunId: 50,
  });
  assert.equal(result.source_ci_run_id, 50);
});
