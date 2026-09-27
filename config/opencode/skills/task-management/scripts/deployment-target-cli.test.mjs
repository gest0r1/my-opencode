import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validateTarget } from './deployment-target-cli.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'deployment-target-cli.ts');

function sh(command, cwd) {
  const result = spawnSync('sh', ['-c', command], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

async function fixture({ missingSecret = false, probeConclusion = 'success' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deployment-target-'));
  const bin = path.join(root, 'bin');
  await mkdir(bin, { recursive: true });
  sh('git init -q && git remote add origin https://github.com/owner/repo.git', root);

  await mkdir(path.join(root, '.opencode'), { recursive: true });
  await writeFile(path.join(root, '.opencode', 'pipeline-policy.json'), JSON.stringify({
    schema_version: 1,
    protected_paths: [],
    required_gates: [],
    deployment_target: {
      kind: 'opencode_host',
      transport: 'github_ssh',
      environment: 'development',
      probe_workflow: '.github/workflows/deployment-target-probe.yml',
      probe_job: 'probe_target',
      trusted_ref: 'main',
      required_environment_secrets: ['DEPLOY_HOST', 'DEPLOY_USER', 'DEPLOY_SSH_KEY'],
      runner_labels: [],
      probe_timeout_seconds: 30,
    },
  }, null, 2));

  const marker = path.join(root, 'dispatched');
  const gh = path.join(bin, 'gh');
  const secrets = missingSecret
    ? '[{"name":"DEPLOY_HOST"},{"name":"DEPLOY_USER"}]'
    : '[{"name":"DEPLOY_HOST"},{"name":"DEPLOY_USER"},{"name":"DEPLOY_SSH_KEY"}]';
  await writeFile(gh, `#!/bin/sh
set -eu
MARKER='${marker}'
ARGS="$*"
if [ "$1" = "workflow" ] && [ "$2" = "run" ]; then
  : > "$MARKER"
  exit 0
fi
if [ "$1" != "api" ]; then
  echo "unsupported gh call: $ARGS" >&2
  exit 2
fi
case "$2" in
  repos/owner/repo/environments/development)
    printf '%s\\n' '{"id":1,"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
    ;;
  'repos/owner/repo/environments/development/deployment-branch-policies?per_page=100')
    printf '%s\\n' '{"branch_policies":[{"name":"main"}]}'
    ;;
  'repos/owner/repo/environments/development/secrets?per_page=100')
    printf '%s\\n' '{"secrets":${secrets}}'
    ;;
  'repos/owner/repo/actions/workflows/deployment-target-probe.yml/runs?branch=main&event=workflow_dispatch&per_page=100')
    if [ -f "$MARKER" ]; then
      printf '%s\\n' '{"workflow_runs":[{"id":9001,"head_branch":"main","event":"workflow_dispatch"}]}'
    else
      printf '%s\\n' '{"workflow_runs":[]}'
    fi
    ;;
  repos/owner/repo/actions/runs/9001)
    printf '%s\\n' '{"id":9001,"status":"completed","conclusion":"${probeConclusion}","run_attempt":1,"head_branch":"main","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","event":"workflow_dispatch"}'
    ;;
  'repos/owner/repo/actions/runs/9001/jobs?filter=latest&per_page=100')
    printf '%s\\n' '{"jobs":[{"id":9002,"name":"probe_target","status":"completed","conclusion":"${probeConclusion}"}]}'
    ;;
  *)
    echo "unsupported api: $2" >&2
    exit 2
    ;;
esac
`, 'utf8');
  await chmod(gh, 0o755);
  return { root, bin };
}

function run(fx, args) {
  return spawnSync('npx', ['--yes', 'tsx', CLI, ...args], {
    cwd: fx.root,
    encoding: 'utf8',
    env: { ...process.env, PATH: fx.bin + path.delimiter + process.env.PATH },
  });
}

test('target contract allows GitHub SSH or self-hosted runner only', () => {
  assert.equal(validateTarget({
    kind: 'opencode_host',
    transport: 'github_ssh',
    environment: 'development',
    probe_workflow: '.github/workflows/deployment-target-probe.yml',
    probe_job: 'probe_target',
    trusted_ref: 'main',
    required_environment_secrets: ['DEPLOY_SSH_KEY'],
  }).transport, 'github_ssh');

  assert.throws(() => validateTarget({
    kind: 'opencode_host',
    transport: 'github_ssh',
    environment: 'development',
    probe_workflow: '.github/workflows/deployment-target-probe.yml',
    probe_job: 'probe_target',
    trusted_ref: 'main',
    required_environment_secrets: [],
  }), /SSH_SECRETS_REQUIRED/);
});

test('PLAN probe proves GitHub can authenticate/reach the OpenCode host without reading secret values', async () => {
  const fx = await fixture();
  const result = run(fx, ['inspect', 'run-1']);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'READY');
  assert.equal(output.kind, 'opencode_host');
  assert.equal(output.transport, 'github_ssh');
  assert.equal(output.workflow_run_id, 9001);
  assert.deepEqual(output.required_secret_names, ['DEPLOY_HOST', 'DEPLOY_USER', 'DEPLOY_SSH_KEY']);
  assert.match(output.artifact.sha256, /^[0-9a-f]{64}$/);

  const file = path.join(fx.root, '.tmp', 'pipelines', 'run-1', output.artifact.path);
  const before = await readFile(file, 'utf8');
  const check = run(fx, ['check', 'run-1']);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(JSON.parse(check.stdout).status, 'READY');
  assert.equal(await readFile(file, 'utf8'), before);
});

test('missing GitHub Environment credential blocks local/hybrid readiness', async () => {
  const fx = await fixture({ missingSecret: true });
  const result = run(fx, ['inspect', 'run-2']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ENVIRONMENT_SECRETS_MISSING/);
});

test('failed GitHub-to-target probe blocks local/hybrid readiness', async () => {
  const fx = await fixture({ probeConclusion: 'failure' });
  const result = run(fx, ['inspect', 'run-3']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OPENCODE_HOST_PROBE_FAILED/);
});
