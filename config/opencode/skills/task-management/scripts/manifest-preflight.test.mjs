import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validateGateManifest, ManifestPreflightError } from './manifest-preflight.mjs';

const STAGE_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'stage-cli.ts');
const runId = 'blocked-machine-gates';
function manifest() {
  return { schema_version: 1, run_id: runId, rules_file: 'docs/pipeline-rules.md',
    rules_version: 1, planning_mode: 'design-freeze', open_decisions: [],
    pipelines: [{ id: 'app', stages: ['implementation', 'test-rule-actions'] }],
    gate_profiles: { pytest: { commands: ['cd backend && python -m pytest -q'] } } };
}
function call(root, args) {
  return spawnSync('npx', ['--yes', 'tsx', STAGE_CLI, ...args], { cwd: root, encoding: 'utf8' });
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pipeline-preflight-'));
  await mkdir(path.join(root, '.tmp', 'pipelines'), { recursive: true });
  return root;
}

test('rejects missing profile BEFORE init without writing state or running a command', async () => {
  const root = await fixture();
  const file = path.join(root, 'manifest.json');
  await writeFile(file, `${JSON.stringify(manifest())}\n`);
  const result = call(root, ['init', file]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pipeline has no gate profile/);
  await assert.rejects(access(path.join(root, '.tmp', 'pipelines', runId, 'state.json')));
});

test('rejects wrong profile shape and stage-to-gate mismatch', () => {
  const spec = manifest();
  spec.pipelines[0].profile = 'pytest';
  assert.throws(() => validateGateManifest(spec), /MACHINE_GATE_MISSING/);
  spec.gate_profiles = { pytest: { 'test-rule-actions': ['pytest -q'], legacy: { commands: ['pytest -q'] } } };
  assert.throws(() => validateGateManifest(spec), /nonempty command array/);
});

test('rejects cd, &&, shell substitution and disallowed executable before runner dispatch', () => {
  const spec = manifest();
  spec.pipelines[0].profile = 'pytest';
  for (const command of ['cd backend && python -m pytest -q', 'python -m pytest $(touch forbidden)', 'cd backend', 'python -c print(1)']) {
    spec.gate_profiles = { pytest: { 'test-rule-actions': [command] } };
    assert.throws(() => validateGateManifest(spec), ManifestPreflightError, command);
  }
});

test('accepts exact gate key and a single-process runner-safe command', () => {
  const spec = manifest();
  spec.pipelines[0].profile = 'pytest';
  spec.gate_profiles = { pytest: { 'test-rule-actions': ['python -m pytest backend/tests/test_selection_rule_actions.py -q'] } };
  assert.deepEqual(validateGateManifest(spec), { status: 'PASS', checked_commands: 1, environment_checked: false });
});

test('environment preflight rejects missing executable without running gate or touching checkout', async () => {
  const spec = manifest();
  spec.pipelines[0].profile = 'pytest';
  spec.gate_profiles = { pytest: { 'test-rule-actions': ['python -m pytest backend/tests/test_selection_rule_actions.py -q'] } };
  const oldPath = process.env.PATH;
  const emptyBin = await mkdtemp(path.join(os.tmpdir(), 'no-python-path-'));
  try {
    process.env.PATH = emptyBin;
    assert.throws(() => validateGateManifest(spec, { environment: true }), /EXECUTABLE_NOT_FOUND/);
  } finally { process.env.PATH = oldPath; }
});

test('invalid manifest is rejected by explicit preflight and no state is written', async () => {
  const root = await fixture();
  const file = path.join(root, 'manifest.json');
  await writeFile(file, `${JSON.stringify(manifest())}\n`);
  const result = call(root, ['preflight', file]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pipeline has no gate profile/);
  await assert.rejects(access(path.join(root, '.tmp', 'pipelines', runId, 'state.json')));
});


test('accepts frozen uv pytest gates and validates the locked project environment', async () => {
  const root = await fixture();
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  await writeFile(path.join(root, 'pyproject.toml'), '[project]\nrequires-python = ">=3.12,<3.13"\n');
  await writeFile(path.join(root, 'uv.lock'), 'version = 1\n');
  await writeFile(path.join(root, '.python-version'), '3.12\n');
  const uv = path.join(bin, 'uv');
  await writeFile(uv, '#!/bin/sh\necho 3.12.7\necho 8.3.0\n', { mode: 0o755 });
  const spec = manifest();
  spec.pipelines[0].profile = 'pytest';
  spec.gate_profiles = { pytest: { 'test-rule-actions': ['uv run --frozen pytest backend/tests/test_x.py -q', 'uv run --frozen python -m pytest backend/tests/test_x.py -q'] } };
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${bin}:/bin`;
    assert.deepEqual(validateGateManifest(spec, { environment: true, cwd: root }), { status: 'PASS', checked_commands: 2, environment_checked: true });
  } finally { process.env.PATH = oldPath; }
});

test('rejects unsafe or unfrozen uv forms identically during preflight', () => {
  const spec = manifest();
  spec.pipelines[0].profile = 'pytest';
  for (const command of ['uv run pytest -q', 'uv run bash -c whoami', 'uv run sh -c whoami', 'uv run python script.py', 'uv run --frozen python script.py', 'uv run --frozen arbitrary-command', 'uv run --frozen pytest -q && touch pwned']) {
    spec.gate_profiles = { pytest: { 'test-rule-actions': [command] } };
    assert.throws(() => validateGateManifest(spec), ManifestPreflightError, command);
  }
});

test('uv environment preflight fails closed for missing uv, lock, pytest, or Python contract', async () => {
  const root = await fixture();
  const spec = manifest();
  spec.pipelines[0].profile = 'pytest';
  spec.gate_profiles = { pytest: { 'test-rule-actions': ['uv run --frozen pytest -q'] } };
  await writeFile(path.join(root, 'pyproject.toml'), '[project]\nrequires-python = ">=3.12,<3.13"\n');
  const oldPath = process.env.PATH;
  const empty = await mkdtemp(path.join(os.tmpdir(), 'no-uv-path-'));
  try {
    process.env.PATH = empty;
    assert.throws(() => validateGateManifest(spec, { environment: true, cwd: root }), /EXECUTABLE_NOT_FOUND/);
    const bin = path.join(root, 'bin');
    await mkdir(bin);
    await writeFile(path.join(bin, 'uv'), '#!/bin/sh\necho 3.11.9\nexit 0\n', { mode: 0o755 });
    process.env.PATH = `${bin}:/bin`;
    assert.throws(() => validateGateManifest(spec, { environment: true, cwd: root }), /UV_LOCK_NOT_FOUND/);
    await writeFile(path.join(root, 'uv.lock'), 'version = 1\n');
    assert.throws(() => validateGateManifest(spec, { environment: true, cwd: root }), /PYTHON_CONTRACT_MISMATCH/);
  } finally { process.env.PATH = oldPath; }
});
