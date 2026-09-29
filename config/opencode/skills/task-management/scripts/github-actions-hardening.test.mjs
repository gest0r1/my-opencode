import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inspectWorkflowText,
  selectWorkflowRun,
  validateWorkflowResult,
} from './github-actions-gate-core.mjs';
import { parseWorkflowYaml } from './github-workflow-yaml.mjs';

const DIGEST = 'sha256:' + 'a'.repeat(64);

test('structural workflow parser preserves on/jobs/steps shape', () => {
  const parsed = parseWorkflowYaml(`
name: CI
on:
  push:
    branches: [main, "feature/**"]
permissions:
  contents: read
jobs:
  tests:
    runs-on: ubuntu-latest
    steps:
      - name: Test
        run: |
          echo one
          echo two
`);
  assert.deepEqual(parsed.on.push.branches, ['main', 'feature/**']);
  assert.equal(parsed.permissions.contents, 'read');
  assert.equal(parsed.jobs.tests.steps[0].name, 'Test');
  assert.match(parsed.jobs.tests.steps[0].run, /echo one/);
});

test('candidate CI rejects write permissions and path-filtered push', () => {
  const base = {
    workflow: '.github/workflows/ci.yml',
    terminal_job: 'pipeline_ci',
    trigger: 'push',
  };
  const write = inspectWorkflowText(`
on:
  push:
permissions:
  contents: write
jobs:
  pipeline_ci:
    runs-on: ubuntu-latest
    steps:
      - run: echo no
`, base, 'github_ci', { candidateBranch: 'feature/task' });
  assert.equal(write.status, 'INCOMPATIBLE');
  assert.ok(write.issues.some((item) => item.includes('read-only')));

  const filtered = inspectWorkflowText(`
on:
  push:
    branches: ['feature/**']
    paths: ['src/**']
permissions:
  contents: read
jobs:
  pipeline_ci:
    runs-on: ubuntu-latest
    steps:
      - run: echo no
`, base, 'github_ci', { candidateBranch: 'feature/task' });
  assert.equal(filtered.status, 'INCOMPATIBLE');
  assert.ok(filtered.issues.some((item) => item.includes('paths/paths-ignore')));
});

test('workflow_dispatch selection excludes runs that existed before dispatch', () => {
  const { id } = selectWorkflowRun([
    { id: 1, head_sha: 'a'.repeat(40), head_branch: 'main', event: 'workflow_dispatch', run_attempt: 1 },
    { id: 2, head_sha: 'a'.repeat(40), head_branch: 'main', event: 'workflow_dispatch', run_attempt: 1 },
  ], {
    candidateSha: 'a'.repeat(40),
    branch: 'main',
    event: 'workflow_dispatch',
    excludeIds: [1],
  });
  assert.equal(id, 2);
});

test('required jobs are resolved structurally and skipped jobs fail closed', () => {
  const contract = {
    workflow: '.github/workflows/ci.yml',
    terminal_job: 'pipeline_ci',
    required_jobs: ['tests', 'build'],
    trigger: 'push',
  };
  const inspected = inspectWorkflowText(`
on:
  push:
permissions:
  contents: read
jobs:
  tests:
    name: unit-tests
    runs-on: ubuntu-latest
    steps:
      - run: npm test
  build:
    name: app-build
    runs-on: ubuntu-latest
    steps:
      - run: npm run build
  pipeline_ci:
    needs: [tests, build]
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`, contract, 'github_ci');
  assert.equal(inspected.status, 'READY');
  assert.deepEqual(inspected.required_job_names, ['unit-tests', 'app-build']);

  assert.throws(() => validateWorkflowResult({
    run: {
      id: 1,
      head_sha: 'c'.repeat(40),
      head_branch: 'feature/task',
      event: 'push',
      status: 'completed',
      conclusion: 'success',
    },
    jobs: [
      { id: 2, name: 'unit-tests', status: 'completed', conclusion: 'success' },
      { id: 3, name: 'app-build', status: 'completed', conclusion: 'skipped' },
      { id: 4, name: 'pipeline_ci', status: 'completed', conclusion: 'success' },
    ],
    artifacts: [],
    contract,
    candidateSha: 'c'.repeat(40),
    terminalJobName: inspected.terminal_job_name,
    requiredJobNames: inspected.required_job_names,
    executor: 'github_ci',
  }), /GITHUB_REQUIRED_JOB_FAILED/);
});

test('required artifact must expose immutable SHA-256 digest', () => {
  const contract = {
    workflow: '.github/workflows/ci.yml',
    terminal_job: 'pipeline_ci',
    trigger: 'push',
    artifact: 'candidate-build',
  };
  const base = {
    run: {
      id: 10,
      head_sha: 'd'.repeat(40),
      head_branch: 'feature/task',
      event: 'push',
      status: 'completed',
      conclusion: 'success',
    },
    jobs: [{ id: 11, name: 'pipeline_ci', status: 'completed', conclusion: 'success' }],
    contract,
    candidateSha: 'd'.repeat(40),
    terminalJobName: 'pipeline_ci',
    executor: 'github_ci',
  };
  assert.throws(() => validateWorkflowResult({
    ...base,
    artifacts: [{ id: 12, name: 'candidate-build', expired: false }],
  }), /GITHUB_ARTIFACT_DIGEST_MISSING/);

  const pass = validateWorkflowResult({
    ...base,
    artifacts: [{ id: 12, name: 'candidate-build', expired: false, digest: DIGEST }],
  });
  assert.equal(pass.artifact_digest, DIGEST);
});

test('legacy stateful DEV artifact contract remains compatible and requires frozen concurrency', () => {
  const contract = {
    workflow: '.github/workflows/dev.yml',
    terminal_job: 'pipeline_dev',
    trigger: 'workflow_dispatch',
    mode: 'stateful',
    environment: 'development',
    trusted_ref: 'main',
    concurrency_group: 'development',
    source_ci_stage: 'tests',
    artifact: 'dev-evidence',
    evidence_file: 'dev-evidence.json',
  };
  const workflow = `
name: DEV
run-name: pipeline inputs.pipeline_run_id inputs.candidate_sha
on:
  workflow_dispatch:
    inputs:
      candidate_sha: { required: true }
      ci_run_id: { required: true }
      ci_artifact: { required: true }
      ci_artifact_id: { required: true }
      ci_artifact_digest: { required: true }
      pipeline_run_id: { required: true }
permissions:
  actions: read
jobs:
  pipeline_dev:
    environment: development
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@2222222222222222222222222222222222222222
        with:
          artifact-ids: inputs.ci_artifact_id
          run-id: inputs.ci_run_id
          github-token: github.token
      - run: echo inputs.candidate_sha inputs.ci_run_id inputs.ci_artifact inputs.ci_artifact_id inputs.ci_artifact_digest
      - uses: actions/upload-artifact@3333333333333333333333333333333333333333
        with:
          name: dev-evidence
          path: dev-evidence.json
`;
  const missing = inspectWorkflowText(workflow, contract, 'github_dev');
  assert.equal(missing.status, 'INCOMPATIBLE');
  assert.ok(missing.issues.some((item) => item.includes('concurrency')));

  const ready = inspectWorkflowText(workflow.replace(
    'on:',
    'concurrency:\n  group: development\n  cancel-in-progress: false\non:',
  ), contract, 'github_dev');
  assert.equal(ready.status, 'READY');
});
