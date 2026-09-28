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

function runCli(fx, env = {}) {
  return spawnSync('npx', [
    '--yes', 'tsx', CLI,
    'run', fx.runId, 'app', 'tests',
    '--state-root', fx.stateRoot,
  ], {
    cwd: fx.root,
    encoding: 'utf8',
    env: { ...process.env, PATH: fx.bin + path.delimiter + process.env.PATH, ...env },
    timeout: 20_000,
  });
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
