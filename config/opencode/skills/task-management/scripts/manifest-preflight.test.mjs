import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
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
  const spec = manifest();
  const file = path.join(root, 'manifest.json');
  await writeFile(file, `${JSON.stringify(spec)}\n`);
  const result = call(root, ['init', file]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pipeline has no gate profile/);
  await assert.rejects(access(path.join(root, '.tmp', 'pipelines', runId, 'state.json')));
});

test('rejects wrong profile shape and stage-to-gate mismatch', () => {
  const spec = manifest();
  spec.pipelines[0].profile = 'pytest';
  assert.throws(() => validateGateManifest(spec), /MACHINE_GATE_MISSING/);
  spec.gate_profiles = { pytest: { 'test-rule-actions': { commands: ['pytest -q'] } } };
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

test('invalid manifest is rejected by explicit preflight and original state is not overwritten', async () => {
  const root = await fixture();
  const spec = manifest();
  const file = path.join(root, 'manifest.json');
  await writeFile(file, `${JSON.stringify(spec)}\n`);
  const result = call(root, ['preflight', file]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pipeline has no gate profile/);
  await assert.rejects(access(path.join(root, '.tmp', 'pipelines', runId, 'state.json')));
});
