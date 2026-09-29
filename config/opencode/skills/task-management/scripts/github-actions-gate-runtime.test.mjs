import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'github-actions-gate-cli.ts');

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'github-gate-runtime-'));
  const stateRoot = path.join(root, '.tmp', 'state');
  const runId = 'run-1';
  const runRoot = path.join(root, '.tmp', 'artifacts', runId);
  const manifestFile = path.join(runRoot, 'manifest.json');
  const workflow = path.join(root, '.github', 'workflows', 'ci.yml');
  const bin = path.join(root, 'bin');
  await mkdir(path.dirname(workflow), { recursive: true });
  await mkdir(path.join(stateRoot, runId), { recursive: true });
  await mkdir(runRoot, { recursive: true });
  await mkdir(bin, { recursive: true });

  await writeFile(workflow, [
    'name: CI',
    'on:',
    '  workflow_dispatch:',
    'permissions:',
    '  contents: read',
    'jobs:',
    '  pipeline_ci:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: echo ok',
    '',
  ].join('\n'));

  const manifest = {
    schema_version: 2,
    run_id: runId,
    repository: 'owner/repo',
    git_setup: { branch: 'feature/x' },
    pipelines: [{
      id: 'app',
      stages: ['tests'],
      executors: { tests: 'github_ci' },
      github_gates: {
        tests: {
          workflow: '.github/workflows/ci.yml',
          terminal_job: 'pipeline_ci',
          trigger: 'workflow_dispatch',
          timeout_seconds: 30,
        },
      },
    }],
  };
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2));
  await writeFile(path.join(runRoot, 'candidate.json'), JSON.stringify({
    status: 'PASS',
    run_id: runId,
    branch: 'feature/x',
    candidate_sha: 'a'.repeat(40),
    remote_sha: 'a'.repeat(40),
  }, null, 2));
  await writeFile(path.join(stateRoot, runId, 'state.json'), JSON.stringify({
    run_id: runId,
    manifest_file: manifestFile,
  }, null, 2));

  return { root, stateRoot, runId, runRoot, bin };
}

function gateCli(fx, commandArgs, env = {}) {
  return spawnSync('npx', [
    '--yes', 'tsx', CLI,
    ...commandArgs,
    '--state-root', fx.stateRoot,
  ], {
    cwd: fx.root,
    encoding: 'utf8',
    env: { ...process.env, PATH: fx.bin + path.delimiter + process.env.PATH, ...env },
    timeout: 20_000,
  });
}

function runCli(fx, env = {}) {
  return gateCli(fx, ['run', fx.runId, 'app', 'tests'], env);
}

test('dispatch failure writes canonical BLOCKED evidence before any workflow run exists', async () => {
  const fx = await fixture();
  const gh = path.join(fx.bin, 'gh');
  await writeFile(gh, `#!/bin/sh
set -eu
case "$*" in
  "api repos/owner/repo/actions/workflows/ci.yml/runs?branch=feature%2Fx&per_page=100")
    printf '%s\\n' '{"workflow_runs":[]}'
    ;;
  "workflow run ci.yml --repo owner/repo --ref feature/x -f candidate_sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    printf '%s\\n' 'dispatch denied by fixture' >&2
    exit 1
    ;;
  *)
    printf 'unexpected gh args: %s\\n' "$*" >&2
    exit 2
    ;;
esac
`);
  await chmod(gh, 0o755);

  const result = runCli(fx);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /dispatch denied by fixture/);
  assert.match(result.stderr, /evidence=/);

  const evidence = JSON.parse(await readFile(path.join(fx.runRoot, 'github', 'app-tests.json'), 'utf8'));
  assert.equal(evidence.status, 'BLOCKED');
  assert.equal(evidence.failure_phase, 'dispatch');
  assert.equal(evidence.workflow, '.github/workflows/ci.yml');
  assert.equal(evidence.candidate_sha, 'a'.repeat(40));
  assert.equal(evidence.branch, 'feature/x');
  assert.equal(evidence.workflow_run_id, undefined);
  assert.match(evidence.validation_error, /dispatch denied by fixture/);
});

test('run discovery API failure writes canonical BLOCKED evidence', async () => {
  const fx = await fixture();
  const gh = path.join(fx.bin, 'gh');
  await writeFile(gh, `#!/bin/sh
set -eu
printf '%s\\n' 'GitHub Actions API unavailable' >&2
exit 1
`);
  await chmod(gh, 0o755);

  const result = runCli(fx);
  assert.notEqual(result.status, 0);

  const evidence = JSON.parse(await readFile(path.join(fx.runRoot, 'github', 'app-tests.json'), 'utf8'));
  assert.equal(evidence.status, 'BLOCKED');
  assert.equal(evidence.failure_phase, 'run_discovery');
  assert.match(evidence.validation_error, /GitHub Actions API unavailable/);
});


test('artifactless disposable DEV dispatches exact candidate SHA and source CI run without artifact APIs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'github-gate-runtime-dev-'));
  const stateRoot = path.join(root, '.tmp', 'state');
  const runId = 'run-1';
  const runRoot = path.join(root, '.tmp', 'artifacts', runId);
  const manifestFile = path.join(runRoot, 'manifest.json');
  const workflow = path.join(root, '.github', 'workflows', 'dev.yml');
  const bin = path.join(root, 'bin');
  await mkdir(path.dirname(workflow), { recursive: true });
  await mkdir(path.join(stateRoot, runId), { recursive: true });
  await mkdir(path.join(runRoot, 'github'), { recursive: true });
  await mkdir(bin, { recursive: true });

  await writeFile(workflow, [
    'name: DEV',
    'on:',
    '  workflow_dispatch:',
    '    inputs:',
    '      candidate_sha: { required: true }',
    '      ci_run_id: { required: true }',
    '      pipeline_run_id: { required: true }',
    'permissions:',
    '  contents: read',
    'jobs:',
    '  pipeline_dev:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@1111111111111111111111111111111111111111',
    '        with:',
    '          ref: ${{ inputs.candidate_sha }}',
    '      - run: echo "ci=${{ inputs.ci_run_id }}"',
    '      - run: ./verify-installed-sha "${{ inputs.candidate_sha }}"',
    '',
  ].join('\n'));

  const manifest = {
    schema_version: 2,
    run_id: runId,
    repository: 'owner/repo',
    git_setup: { branch: 'feature/x' },
    pipelines: [{
      id: 'app',
      stages: ['tests', 'dev'],
      executors: { tests: 'github_ci', dev: 'github_dev' },
      github_gates: {
        tests: {
          workflow: '.github/workflows/ci.yml',
          terminal_job: 'pipeline_ci',
          trigger: 'push',
        },
        dev: {
          workflow: '.github/workflows/dev.yml',
          terminal_job: 'pipeline_dev',
          trigger: 'workflow_dispatch',
          mode: 'disposable',
          source_ci_stage: 'tests',
          timeout_seconds: 30,
        },
      },
    }],
  };
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2));
  await writeFile(path.join(runRoot, 'candidate.json'), JSON.stringify({
    status: 'PASS',
    run_id: runId,
    branch: 'feature/x',
    candidate_sha: 'a'.repeat(40),
    remote_sha: 'a'.repeat(40),
  }, null, 2));
  await writeFile(path.join(runRoot, 'github', 'app-tests.json'), JSON.stringify({
    status: 'PASS',
    run_id: runId,
    pipeline_id: 'app',
    stage: 'tests',
    executor: 'github_ci',
    workflow: '.github/workflows/ci.yml',
    workflow_run_id: 50,
    candidate_sha: 'a'.repeat(40),
  }, null, 2));
  await writeFile(path.join(stateRoot, runId, 'state.json'), JSON.stringify({
    run_id: runId,
    manifest_file: manifestFile,
  }, null, 2));

  const gh = path.join(bin, 'gh');
  const counter = path.join(root, 'dev-run-list-count');
  await writeFile(gh, `#!/bin/sh
set -eu
counter='${counter}'
case "$*" in
  "api repos/owner/repo/actions/workflows/dev.yml/runs?branch=feature%2Fx&per_page=100")
    n=0
    [ ! -f "$counter" ] || n=$(cat "$counter")
    if [ "$n" = 0 ]; then
      printf '1' > "$counter"
      printf '%s\\n' '{"workflow_runs":[]}'
    else
      printf '%s\\n' '{"workflow_runs":[{"id":88,"head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","head_branch":"feature/x","event":"workflow_dispatch","run_attempt":1}]}'
    fi
    ;;
  "workflow run dev.yml --repo owner/repo --ref feature/x -f candidate_sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -f ci_run_id=50 -f pipeline_run_id=run-1")
    ;;
  "api repos/owner/repo/actions/runs/88")
    printf '%s\\n' '{"id":88,"run_attempt":1,"head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","head_branch":"feature/x","event":"workflow_dispatch","status":"completed","conclusion":"success"}'
    ;;
  "api repos/owner/repo/actions/runs/88/jobs?filter=latest&per_page=100")
    printf '%s\\n' '{"jobs":[{"id":89,"name":"pipeline_dev","status":"completed","conclusion":"success","steps":[]}]}'
    ;;
  *"/artifacts"*)
    printf '%s\\n' 'artifact API must not be called' >&2
    exit 3
    ;;
  *)
    printf 'unexpected gh args: %s\\n' "$*" >&2
    exit 2
    ;;
esac
`);
  await chmod(gh, 0o755);

  const result = spawnSync('npx', [
    '--yes', 'tsx', CLI,
    'run', runId, 'app', 'dev',
    '--state-root', stateRoot,
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: bin + path.delimiter + process.env.PATH,
      GITHUB_ACTIONS_GATE_POLL_MS: '250',
    },
    timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(await readFile(path.join(runRoot, 'github', 'app-dev.json'), 'utf8'));
  assert.equal(evidence.status, 'PASS');
  assert.equal(evidence.source_ci_run_id, 50);
  assert.equal(evidence.installed_sha, 'a'.repeat(40));
  assert.equal(evidence.dev_evidence_source, 'trusted_workflow_success');
  assert.equal('ci_artifact_id' in evidence, false);
  assert.equal('ci_artifact_digest' in evidence, false);
});

test('terminal failure diagnose writes readable per-job log and log command reuses exact run job', async () => {
  const fx = await fixture();
  const gh = path.join(fx.bin, 'gh');
  const counter = path.join(fx.root, 'run-list-count');
  await writeFile(gh, `#!/bin/sh
set -eu
counter='${counter}'
case "$*" in
  "api repos/owner/repo/actions/workflows/ci.yml/runs?branch=feature%2Fx&per_page=100")
    n=0
    [ ! -f "$counter" ] || n=$(cat "$counter")
    if [ "$n" = 0 ]; then
      printf '1' > "$counter"
      printf '%s\\n' '{"workflow_runs":[]}'
    else
      printf '%s\\n' '{"workflow_runs":[{"id":77,"head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","head_branch":"feature/x","event":"workflow_dispatch","run_attempt":1}]}'
    fi
    ;;
  "workflow run ci.yml --repo owner/repo --ref feature/x -f candidate_sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    ;;
  "api repos/owner/repo/actions/runs/77")
    printf '%s\\n' '{"id":77,"run_attempt":1,"head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","head_branch":"feature/x","event":"workflow_dispatch","status":"completed","conclusion":"failure"}'
    ;;
  "api repos/owner/repo/actions/runs/77/jobs?filter=latest&per_page=100")
    printf '%s\\n' '{"jobs":[{"id":101,"name":"pipeline_ci","status":"completed","conclusion":"failure","steps":[{"number":1,"name":"Intentional failure","status":"completed","conclusion":"failure"}]}]}'
    ;;
  "api repos/owner/repo/actions/runs/77/artifacts?per_page=100")
    printf '%s\\n' '{"artifacts":[]}'
    ;;
  "run view 77 --repo owner/repo --job 101 --log-failed"|"run view 77 --repo owner/repo --job 101 --log")
    printf '%s\\n' 'TOKEN=fixture-secret-value'
    printf '%s\\n' 'first diagnostic line'
    printf '%s\\n' 'second diagnostic line'
    ;;
  *)
    printf 'unexpected gh args: %s\\n' "$*" >&2
    exit 2
    ;;
esac
`);
  await chmod(gh, 0o755);

  let result = runCli(fx, { GITHUB_ACTIONS_GATE_POLL_MS: '250' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /GITHUB_RUN_FAILED/);

  const canonical = JSON.parse(await readFile(path.join(fx.runRoot, 'github', 'app-tests.json'), 'utf8'));
  assert.equal(canonical.status, 'FAIL');
  assert.equal(canonical.workflow_run_id, 77);
  assert.equal('failed_log_excerpt' in canonical, false);

  result = gateCli(fx, ['diagnose', fx.runId, 'app', 'tests']);
  assert.equal(result.status, 0, result.stderr);
  const diagnostics = JSON.parse(await readFile(
    path.join(fx.runRoot, 'github', 'app-tests-diagnostics.json'), 'utf8',
  ));
  assert.equal('failed_log_excerpt' in diagnostics, false);
  assert.equal(diagnostics.failed_jobs.length, 1);
  assert.equal(diagnostics.failed_jobs[0].id, 101);
  assert.equal(diagnostics.failed_jobs[0].name, 'pipeline_ci');
  assert.deepEqual(
    diagnostics.failed_jobs[0].failed_steps.map((step) => step.name),
    ['Intentional failure'],
  );

  const jobLog = await readFile(path.join(fx.runRoot, diagnostics.failed_jobs[0].log_file), 'utf8');
  assert.match(jobLog, /TOKEN=\[REDACTED\]/);
  assert.match(jobLog, /first diagnostic line\nsecond diagnostic line/);
  assert.doesNotMatch(jobLog, /fixture-secret-value/);

  result = gateCli(fx, ['log', fx.runId, 'app', 'tests', '--job', 'pipeline_ci']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /job_id=101 job=pipeline_ci conclusion=failure/);
  assert.match(result.stdout, /TOKEN=\[REDACTED\]/);
  assert.match(result.stdout, /first diagnostic line/);
  assert.doesNotMatch(result.stdout, /fixture-secret-value/);
});
