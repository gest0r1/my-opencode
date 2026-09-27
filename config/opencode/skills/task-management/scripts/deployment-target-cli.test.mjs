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

test('OpenCode-host target requires trusted transport and authorization material', () => {
  assert.throws(() => validateTarget({
    kind: 'opencode_host',
    transport: 'github_ssh',
    environment: 'development',
    probe_workflow: '.github/workflows/deployment-target-probe.yml',
    probe_job: 'probe_target',
    trusted_ref: 'main',
    required_environment_secrets: [],
  }), /SSH_SECRETS_REQUIRED/);

  const target = validateTarget({
    kind: 'opencode_host',
    transport: 'github_ssh',
    environment: 'development',
    probe_workflow: '.github/workflows/deployment-target-probe.yml',
    probe_job: 'probe_target',
    trusted_ref: 'main',
    required_environment_secrets: ['DEPLOY_HOST', 'DEPLOY_USER', 'DEPLOY_SSH_KEY', 'DEPLOY_KNOWN_HOSTS'],
    runner_labels: [],
    probe_timeout_seconds: 180,
  });
  assert.equal(target.kind, 'opencode_host');
  assert.equal(target.transport, 'github_ssh');
});

async function fixture({ probeConclusion = 'success' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deployment-target-'));
  const bin = path.join(root, 'bin');
  const state = path.join(root, 'gh-dispatched');
  await mkdir(bin, { recursive: true });
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
      required_environment_secrets: ['DEPLOY_HOST', 'DEPLOY_USER', 'DEPLOY_SSH_KEY', 'DEPLOY_KNOWN_HOSTS'],
      runner_labels: [],
      probe_timeout_seconds: 30,
    },
  }, null, 2));

  const git = path.join(bin, 'git');
  await writeFile(git, [
    '#!/bin/sh',
    'if [ "$1" = "remote" ] && [ "$2" = "get-url" ]; then',
    '  echo https://github.com/owner/repo.git',
    '  exit 0',
    'fi',
    'exit 1',
    '',
  ].join('\n'), 'utf8');
  await chmod(git, 0o755);

  const gh = path.join(bin, 'gh');
  const ghScript = [
    '#!/bin/sh',
    'STATE="$GH_FAKE_STATE"',
    'ARGS="$*"',
    'case "$ARGS" in',
    '  "api repos/owner/repo/environments/development")',
    '    printf \'%s\\n\' \'{"id":7,"deployment_branch_policy":{"protected_branches":true,"custom_branch_policies":false},"protection_rules":[{"type":"branch_policy"}]}\'',
    '    ;;',
    '  "api repos/owner/repo")',
    '    printf \'%s\\n\' \'{"default_branch":"main"}\'',
    '    ;;',
    '  "api repos/owner/repo/branches/main")',
    '    printf \'%s\\n\' \'{"name":"main","protected":true}\'',
    '    ;;',
    '  "api repos/owner/repo/environments/development/secrets?per_page=100")',
    '    printf \'%s\\n\' \'{"secrets":[{"name":"DEPLOY_HOST"},{"name":"DEPLOY_USER"},{"name":"DEPLOY_SSH_KEY"},{"name":"DEPLOY_KNOWN_HOSTS"}]}\'',
    '    ;;',
    '  "workflow run deployment-target-probe.yml --repo owner/repo --ref main -f pipeline_run_id=run-1"|"workflow run deployment-target-probe.yml --repo owner/repo --ref main -f pipeline_run_id=run-2")',
    '    : > "$STATE"',
    '    ;;',
    '  "api repos/owner/repo/actions/workflows/deployment-target-probe.yml/runs?branch=main&event=workflow_dispatch&per_page=100")',
    '    if [ -f "$STATE" ]; then',
    '      printf \'%s\\n\' \'{"workflow_runs":[{"id":77,"head_branch":"main","event":"workflow_dispatch"}]}\'',
    '    else',
    '      printf \'%s\\n\' \'{"workflow_runs":[]}\'',
    '    fi',
    '    ;;',
    '  "api repos/owner/repo/actions/runs/77")',
    '    printf \'%s\\n\' \'{"id":77,"status":"completed","conclusion":"' + probeConclusion + '","run_attempt":1,"head_branch":"main","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","event":"workflow_dispatch"}\'',
    '    ;;',
    '  "api repos/owner/repo/actions/runs/77/jobs?filter=latest&per_page=100")',
    '    printf \'%s\\n\' \'{"jobs":[{"id":88,"name":"probe_target","status":"completed","conclusion":"' + probeConclusion + '"}]}\'',
    '    ;;',
    '  *)',
    '    echo "unexpected gh args: $ARGS" >&2',
    '    exit 2',
    '    ;;',
    'esac',
    '',
  ].join('\n');
  await writeFile(gh, ghScript, 'utf8');
  await chmod(gh, 0o755);
  return { root, bin, state };
}

function run(fx, args) {
  return spawnSync('npx', ['--yes', 'tsx', CLI, ...args], {
    cwd: fx.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: fx.bin + path.delimiter + process.env.PATH,
      GH_FAKE_STATE: fx.state,
    },
  });
}

test('inspect dispatches trusted probe and freezes successful target authorization evidence', async () => {
  const fx = await fixture();
  const result = run(fx, ['inspect', 'run-1']);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'READY');
  assert.equal(output.kind, 'opencode_host');
  assert.equal(output.transport, 'github_ssh');
  assert.equal(output.workflow_run_id, 77);
  assert.match(output.artifact.sha256, /^[0-9a-f]{64}$/);

  const file = path.join(fx.root, '.tmp', 'pipelines', 'run-1', output.artifact.path);
  const before = await readFile(file, 'utf8');
  const check = run(fx, ['check', 'run-1']);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(JSON.parse(check.stdout).status, 'READY');
  assert.equal(await readFile(file, 'utf8'), before);
});

test('failed trusted target probe blocks PLAN/RUN', async () => {
  const fx = await fixture({ probeConclusion: 'failure' });
  const result = run(fx, ['inspect', 'run-2']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OPENCODE_HOST_PROBE_FAILED/);
});
