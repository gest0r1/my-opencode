import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, 'gate-runner-cli.ts');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function run(cwd, args) {
  return spawnSync('npx', ['--yes', 'tsx', RUNNER, ...args], {
    cwd,
    encoding: 'utf8',
    env: process.env,
  });
}

async function makeRun(command, gate = 'build') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gate-runner-'));
  const stateRoot = path.join(root, '.tmp', 'pipelines');
  const runId = 'gate-run';
  const manifest = {
    schema_version: 1,
    run_id: runId,
    pipelines: [{ id: 'app', stages: [gate], profile: 'default' }],
    gate_profiles: { default: { [gate]: [command] } },
  };
  const manifestFile = path.join(root, 'manifest.json');
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(manifestFile, manifestContent, 'utf8');
  await mkdir(path.join(stateRoot, runId), { recursive: true });
  await writeFile(
    path.join(stateRoot, runId, 'state.json'),
    `${JSON.stringify({
      run_id: runId,
      status: 'approved',
      manifest_file: manifestFile,
      manifest_sha256: sha256(manifestContent),
    }, null, 2)}\n`,
    'utf8',
  );
  return { root, stateRoot, runId };
}

test('runner executes an approved argv command without a shell and records evidence', async () => {
  const fixture = await makeRun('bash -n check.sh');
  await writeFile(path.join(fixture.root, 'check.sh'), '#!/usr/bin/env bash\necho ok\n', 'utf8');

  const result = run(fixture.root, [
    fixture.runId,
    'app',
    'build',
    '--state-root',
    fixture.stateRoot,
  ]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'PASS');

  const evidence = JSON.parse(await readFile(output.evidence, 'utf8'));
  assert.equal(evidence.status, 'PASS');
  assert.equal(evidence.results[0].executable, 'bash');
  assert.deepEqual(evidence.results[0].argv, ['-n', 'check.sh']);
  assert.equal(evidence.results[0].exit_code, 0);
});

test('runner rejects shell composition before any command is executed', async () => {
  const fixture = await makeRun('bash -n check.sh; touch pwned');
  await writeFile(path.join(fixture.root, 'check.sh'), '#!/usr/bin/env bash\necho ok\n', 'utf8');

  const result = run(fixture.root, [
    fixture.runId,
    'app',
    'build',
    '--state-root',
    fixture.stateRoot,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /shell composition/i);
  await assert.rejects(access(path.join(fixture.root, 'pwned')));
});

test('runtime candidate placeholder fails closed without published candidate evidence', async () => {
  const fixture = await makeRun('bash scripts/install.sh {candidate_sha}', 'runtime_validation');
  await mkdir(path.join(fixture.root, 'scripts'), { recursive: true });
  await writeFile(path.join(fixture.root, 'scripts', 'install.sh'), '#!/usr/bin/env bash\nexit 0\n', 'utf8');

  const result = run(fixture.root, [
    fixture.runId,
    'app',
    'runtime_validation',
    '--state-root',
    fixture.stateRoot,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /candidate evidence is missing/);
});


test('runner executes frozen uv pytest and rejects every non-pytest uv form', async () => {
  const fixture = await makeRun('uv run --frozen pytest backend/tests/test_x.py -q');
  const bin = path.join(fixture.root, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'uv'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${bin}:${oldPath}`;
    const pass = run(fixture.root, [fixture.runId, 'app', 'build', '--state-root', fixture.stateRoot]);
    assert.equal(pass.status, 0, pass.stderr);
    for (const command of ['uv run pytest -q', 'uv run bash -c id', 'uv run sh -c id', 'uv run python script.py', 'uv run --frozen python script.py', 'uv run --frozen arbitrary-command', 'uv run --frozen pytest -q | tee out']) {
      const rejected = await makeRun(command);
      const result = run(rejected.root, [rejected.runId, 'app', 'build', '--state-root', rejected.stateRoot]);
      assert.notEqual(result.status, 0, command);
    }
  } finally { process.env.PATH = oldPath; }
});
