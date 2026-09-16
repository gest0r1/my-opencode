import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../../..');
const INIT = path.join(HERE, 'pipeline-init-cli.ts');

function run(cwd, args) {
  return spawnSync('npx', ['--yes', 'tsx', INIT, ...args], {
    cwd,
    encoding: 'utf8',
    env: process.env,
  });
}

async function manifestFixture(command = 'bash -n check.sh', gate = 'build') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pipeline-init-'));
  const stateRoot = path.join(root, '.tmp', 'pipelines');
  const runId = 'preflight-run';
  const manifest = {
    schema_version: 1,
    run_id: runId,
    planning_mode: 'design-freeze',
    rules_file: 'docs/pipeline-rules.md',
    rules_version: 1,
    open_decisions: [],
    pipelines: [{ id: 'app', stages: [gate], profile: 'default' }],
    gate_profiles: { default: { [gate]: [command] } },
  };
  const manifestFile = path.join(root, 'manifest.json');
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { root, stateRoot, runId, manifestFile };
}

test('pipeline-init --check validates readiness without creating canonical state', async () => {
  const fixture = await manifestFixture();
  const result = run(fixture.root, [fixture.manifestFile, '--check', '--json', '--state-root', fixture.stateRoot]);

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'PASS');
  assert.equal(output.gate, 'pipeline_init');
  assert.equal(output.mode, 'check');
  assert.equal(output.run_id, fixture.runId);
  assert.equal(output.command_count, 1);
  assert.deepEqual(output.executables, ['bash']);
  await assert.rejects(access(path.join(fixture.stateRoot, fixture.runId, 'state.json')));
});

test('pipeline-init --check fails closed when a required executable is unavailable', async () => {
  const fixture = await manifestFixture('mypy --version', 'typecheck');
  const result = run(fixture.root, [fixture.manifestFile, '--check', '--json', '--state-root', fixture.stateRoot]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /required executable is unavailable: mypy/i);
  await assert.rejects(access(path.join(fixture.stateRoot, fixture.runId, 'state.json')));
});

test('normal pipeline initialization repeats readiness checks before freezing state', async () => {
  const fixture = await manifestFixture('mypy --version', 'typecheck');
  const result = run(fixture.root, [fixture.manifestFile, '--json', '--state-root', fixture.stateRoot]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /required executable is unavailable: mypy/i);
  await assert.rejects(access(path.join(fixture.stateRoot, fixture.runId, 'state.json')));
});

test('pipeline-init delegates workspace identity to git-worktree capability and PLAN uses --check', async () => {
  const initSource = await readFile(path.join(HERE, 'pipeline-init-cli.ts'), 'utf8');
  const plan = await readFile(path.join(ROOT, 'config/opencode/command/pipeline-plan.md'), 'utf8');
  const installer = await readFile(path.join(ROOT, 'install.sh'), 'utf8');

  assert.match(initSource, /git-worktree-cli\.ts/);
  assert.match(initSource, /capability/);
  assert.match(plan, /pipeline-init-cli\.ts <manifest> --check --json/);
  assert.match(installer, /python3-venv/);
  assert.match(installer, /python3-pip/);
  assert.match(installer, /python-is-python3/);
  assert.match(installer, /python -m pip --version/);
});
