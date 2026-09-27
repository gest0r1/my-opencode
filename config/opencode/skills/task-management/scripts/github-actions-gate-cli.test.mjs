import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyMissingWorkflow,
  inspectWorkflowText,
  selectStatefulWorkflowRun,
  selectWorkflowRun,
  validateDevEvidence,
  validateWorkflowResult,
} from './github-actions-gate-core.mjs';

const DIGEST = 'sha256:' + 'a'.repeat(64);

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
      - uses: actions/upload-artifact@1111111111111111111111111111111111111111
        with:
          name: candidate-build
          path: package.json
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

test('candidate workflow must accept the frozen branch and use pinned actions without secrets', () => {
  const branchContract = { ...contract, artifact: undefined };
  const wrongBranch = inspectWorkflowText(`
on:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  pipeline_ci:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`, branchContract, 'github_ci', { candidateBranch: 'feature/task' });
  assert.equal(wrongBranch.status, 'INCOMPATIBLE');
  assert.ok(wrongBranch.issues.some((item) => item.includes('candidate branch')));

  const unsafe = inspectWorkflowText(`
on:
  push:
permissions:
  contents: read
jobs:
  pipeline_ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: echo "\${{ secrets.TEST_TOKEN }}"
`, branchContract, 'github_ci', { candidateBranch: 'feature/task' });
  assert.equal(unsafe.status, 'INCOMPATIBLE');
  assert.ok(unsafe.issues.some((item) => item.includes('commit-SHA pinned')));
  assert.ok(unsafe.issues.some((item) => item.includes('must not reference')));
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
    artifacts: [{ id: 90, name: 'candidate-build', expired: false, digest: DIGEST }],
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

test('required candidate artifact missing from the exact run is rejected', () => {
  assert.throws(() => validateWorkflowResult({
    run: {
      id: 51,
      run_attempt: 1,
      head_sha: 'c'.repeat(40),
      head_branch: 'feature/x',
      event: 'push',
      status: 'completed',
      conclusion: 'success',
    },
    jobs: [{ id: 71, name: 'pipeline_ci', status: 'completed', conclusion: 'success' }],
    artifacts: [],
    contract,
    candidateSha: 'c'.repeat(40),
    terminalJobName: 'pipeline_ci',
    executor: 'github_ci',
  }), /GITHUB_ARTIFACT_MISSING/);
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
    artifacts: [{ id: 90, name: 'candidate-build', expired: false, digest: DIGEST }],
    contract,
    candidateSha: 'c'.repeat(40),
    terminalJobName: 'pipeline_ci',
    executor: 'github_ci',
  }), /GITHUB_RUN_SHA_MISMATCH/);
});

test('disposable DEV workflow consumes exact CI artifact without secrets', () => {
  const dev = {
    workflow: '.github/workflows/dev-disposable.yml',
    terminal_job: 'pipeline_dev',
    trigger: 'workflow_dispatch',
    mode: 'disposable',
    source_ci_stage: 'tests',
    artifact: 'dev-evidence',
    evidence_file: 'dev-evidence.json',
  };
  const lines = [
    'name: Disposable DEV',
    'on:',
    '  workflow_dispatch:',
    '    inputs:',
    '      candidate_sha:',
    '        required: true',
    '      ci_run_id:',
    '        required: true',
    '      ci_artifact:',
    '        required: true',
    '      ci_artifact_digest:',
    '        required: true',
    '      pipeline_run_id:'
    '        required: true',
    'permissions:',
    '  actions: read',
    '  contents: read',
    'jobs:',
    '  pipeline_dev:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/download-artifact@2222222222222222222222222222222222222222',
    '        with:',
    '          name: candidate-build',
    '      - run: echo inputs.ci_run_id inputs.ci_artifact inputs.ci_artifact_digest',
    '      - run: printf "{\\\"status\\\":\\\"PASS\\\"}" > dev-evidence.json',
    '      - uses: actions/upload-artifact@3333333333333333333333333333333333333333',
    '        with:',
    '          name: dev-evidence',
    '          path: dev-evidence.json',
  ];
  const workflow = lines.join(String.fromCharCode(10));
  const result = inspectWorkflowText(workflow, dev, 'github_dev');
  assert.equal(result.status, 'READY');

  const unsafe = [...lines, '      - run: echo "${{ secrets.TEST_TOKEN }}"'].join(String.fromCharCode(10));
  const unsafeResult = inspectWorkflowText(unsafe, dev, 'github_dev');
  assert.equal(unsafeResult.status, 'INCOMPATIBLE');
  assert.ok(unsafeResult.issues.some((item) => item.includes('must not reference')));
});

test('stateful DEV workflow is trusted-ref dispatch and consumes CI artifact', () => {
  const dev = {
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
  const result = inspectWorkflowText(`
name: DEV
run-name: pipeline-dev-\${{ inputs.pipeline_run_id }}-\${{ inputs.candidate_sha }}
concurrency:
  group: development
  cancel-in-progress: false
on:
  workflow_dispatch:
    inputs:
      candidate_sha:
        required: true
      ci_run_id:
        required: true
      ci_artifact:
        required: true
      ci_artifact_digest:
        required: true
      pipeline_run_id:
        required: true
permissions:
  actions: read
  contents: read
jobs:
  pipeline_dev:
    environment: development
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@2222222222222222222222222222222222222222
        with:
          run-id: \${{ inputs.ci_run_id }}
          name: \${{ inputs.ci_artifact }}
      - run: echo '\${{ inputs.ci_run_id }} \${{ inputs.ci_artifact }} \${{ inputs.ci_artifact_digest }}'
      - run: printf '{"status":"PASS"}' > dev-evidence.json
      - uses: actions/upload-artifact@3333333333333333333333333333333333333333
        with:
          name: dev-evidence
          path: dev-evidence.json
`, dev, 'github_dev');
  assert.equal(result.status, 'READY');
});

test('stateful DEV run selection uses trusted ref and correlation instead of candidate head SHA', () => {
  const selected = selectStatefulWorkflowRun([
    { id: 1, head_branch: 'main', event: 'workflow_dispatch', display_title: 'pipeline-dev-old-aaaaaaaaaaaa' },
    { id: 2, head_branch: 'feature/x', event: 'workflow_dispatch', display_title: 'pipeline-dev-run-1-cccccccccccc' },
    { id: 3, head_branch: 'main', event: 'workflow_dispatch', display_title: 'pipeline-dev-run-1-cccccccccccc' },
  ], {
    trustedRef: 'main',
    correlation: 'run-1',
    candidateSha: 'c'.repeat(40),
    excludeIds: [1],
  });
  assert.equal(selected.id, 3);
});

test('stateful DEV result binds trusted workflow and exact source CI run', () => {
  const dev = {
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
  const result = validateWorkflowResult({
    run: {
      id: 80,
      head_sha: 'f'.repeat(40),
      head_branch: 'main',
      event: 'workflow_dispatch',
      status: 'completed',
      conclusion: 'success',
    },
    jobs: [{ id: 81, name: 'pipeline_dev', status: 'completed', conclusion: 'success' }],
    artifacts: [{ id: 82, name: 'dev-evidence', expired: false, digest: DIGEST }],
    contract: dev,
    candidateSha: 'e'.repeat(40),
    terminalJobName: 'pipeline_dev',
    executor: 'github_dev',
    sourceCiRunId: 50,
  });
  assert.equal(result.source_ci_run_id, 50);
  assert.equal(result.head_branch, 'main');
});

test('downloaded DEV evidence proves the installed candidate SHA', () => {
  const evidence = validateDevEvidence({
    status: 'PASS',
    candidate_sha: 'e'.repeat(40),
    installed_sha: 'e'.repeat(40),
    ci_run_id: 50,
    ci_artifact_digest: DIGEST,
    smoke_result: 'PASS',
  }, {
    candidateSha: 'e'.repeat(40),
    ciRunId: 50,
    ciArtifactDigest: DIGEST,
  });
  assert.equal(evidence.status, 'PASS');
  assert.equal(evidence.installed_sha, 'e'.repeat(40));

  assert.throws(() => validateDevEvidence({
    status: 'PASS',
    candidate_sha: 'e'.repeat(40),
    installed_sha: 'd'.repeat(40),
    ci_run_id: 50,
    ci_artifact_digest: DIGEST,
  }, {
    candidateSha: 'e'.repeat(40),
    ciRunId: 50,
    ciArtifactDigest: DIGEST,
  }), /INSTALLED_SHA_MISMATCH/);
});
