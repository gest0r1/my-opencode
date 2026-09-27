import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'deployment-target-cli.ts');

async function fixture(exitCode = 0) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deployment-target-'));
  const bin = path.join(root, 'bin');
  await mkdir(bin, { recursive: true });
  const ssh = path.join(bin, 'ssh');
  await writeFile(ssh, `#!/bin/sh
exit ${exitCode}
`, 'utf8');
  await chmod(ssh, 0o755);
  await mkdir(path.join(root, '.opencode'), { recursive: true });
  await writeFile(path.join(root, '.opencode', 'pipeline-policy.json'), JSON.stringify({
    schema_version: 1,
    protected_paths: [],
    required_gates: [],
    deployment_target: {
      kind: 'external_ssh',
      host: 'dev.example.test',
      user: 'deploy',
      port: 22,
      connect_timeout_seconds: 2,
    },
  }, null, 2));
  return { root, bin };
}

function run(fx, args) {
  return spawnSync('npx', ['--yes', 'tsx', CLI, ...args], {
    cwd: fx.root,
    encoding: 'utf8',
    env: { ...process.env, PATH: fx.bin + path.delimiter + process.env.PATH },
  });
}

test('inspect proves external SSH reachability/auth and freezes evidence', async () => {
  const fx = await fixture(0);
  const result = run(fx, ['inspect', 'run-1']);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'READY');
  assert.equal(output.authentication, 'batch-mode-ready');
  assert.match(output.artifact.sha256, /^[0-9a-f]{64}$/);
  const file = path.join(fx.root, '.tmp', 'pipelines', 'run-1', output.artifact.path);
  const before = await readFile(file, 'utf8');

  const check = run(fx, ['check', 'run-1']);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(JSON.parse(check.stdout).status, 'READY');
  assert.equal(await readFile(file, 'utf8'), before);
});

test('external SSH authentication/reachability failure blocks', async () => {
  const fx = await fixture(255);
  const result = run(fx, ['inspect', 'run-2']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /EXTERNAL_SSH_AUTH_OR_REACHABILITY_FAILED/);
});
