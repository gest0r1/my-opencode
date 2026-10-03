import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validateGateManifest, ManifestPreflightError } from './manifest-preflight.mjs';

const STAGE_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'stage-cli.ts');
const sha = (value) => createHash('sha256').update(value).digest('hex');

function call(root, args) {
  return spawnSync('npx', ['--yes', 'tsx', STAGE_CLI, ...args], { cwd: root, encoding: 'utf8' });
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pipeline-preflight-v2-'));
  const runId = 'preflight-v2';
  const runRoot = path.join(root, '.tmp', 'pipelines', runId);
  await mkdir(path.join(runRoot, 'planning'), { recursive: true });
  await mkdir(path.join(runRoot, 'reviews'), { recursive: true });
  await mkdir(path.join(runRoot, 'work-items'), { recursive: true });
  const frozen = async (relative, content) => {
    const file = path.join(runRoot, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
    return { path: relative, sha256: sha(content) };
  };
  const architecture = await frozen('planning/architecture.md', '# architecture\n');
  const review = await frozen('reviews/architecture.md', '# review\n');
  const decision = await frozen('decision-register.md', '# decisions\n');
  const index = await frozen('work-items/index.json', '{"items":["wi"]}\n');
  const item = await frozen('work-items/wi.json', '{"id":"wi"}\n');
  const spec = {
    schema_version: 2,
    run_id: runId,
    rules_file: 'docs/pipeline-rules.md',
    rules_version: 2,
    planning_mode: 'design-freeze',
    planning_readiness: {
      design_freeze: true,
      required_gates: ['architecture'],
      gates: {
        architecture: { required: true, status: 'ready', artifact: architecture, review, cycles: 1, blocking_decision_ids: [] },
      },
      required_artifacts: { decision_register: decision, architecture, work_items: index },
    },
    open_decisions: [],
    allowed_change_paths: ['backend/**'],
    work_items: [{ id: 'wi', pipeline_id: 'app', ...item }],
    pipelines: [{
      id: 'app',
      deployable: false,
      stages: ['implementation', 'test-rule-actions'],
      executors: { implementation: 'agent', 'test-rule-actions': 'local_gate' },
      work_items: ['wi'],
      decision_ids: [],
      research_ids: [],
      contract_ids: [],
    }],
    gate_profiles: {},
  };
  const manifestPath = path.join(runRoot, 'manifest.json');
  return { root, runId, runRoot, spec, manifestPath };
}

async function validate(fx, options = {}) {
  return validateGateManifest(fx.spec, { cwd: fx.root, manifestPath: fx.manifestPath, ...options });
}

test('rejects missing local-gate profile before init without writing state', async () => {
  const fx = await fixture();
  await writeFile(fx.manifestPath, JSON.stringify(fx.spec));
  const result = call(fx.root, ['init', fx.manifestPath]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pipeline has no gate profile/);
  await assert.rejects(access(path.join(fx.root, '.tmp', 'pipelines-state', fx.runId, 'state.json')));
});

test('rejects wrong profile shape and stage-to-gate mismatch', async () => {
  const fx = await fixture();
  fx.spec.pipelines[0].profile = 'pytest';
  fx.spec.gate_profiles = { pytest: { legacy: ['pytest -q'] } };
  assert.throws(() => validateGateManifest(fx.spec, { cwd: fx.root, manifestPath: fx.manifestPath }), /MACHINE_GATE_MISSING/);
  fx.spec.gate_profiles = { pytest: { 'test-rule-actions': { commands: ['pytest -q'] } };
  assert.throws(() => validateGateManifest(fx.spec, { cwd: fx.root, manifestPath: fx.manifestPath }), /must contain commands/);
});

test('rejects shell composition and disallowed executable before runner dispatch', async () => {
  const fx = await fixture();
  fx.spec.pipelines[0].profile = 'pytest';
  for (const command of ['cd backend && python -m pytest -q', 'python -m pytest $(touch forbidden)', 'cd backend', 'python -c print(1)']) {
    fx.spec.gate_profiles = { pytest: { 'test-rule-actions': [command] } };
    assert.throws(
      () => validateGateManifest(fx.spec, { cwd: fx.root, manifestPath: fx.manifestPath }),
      ManifestPreflightError,
      command,
    );
  }
});

test('accepts exact local-gate key and runner-safe command', async () => {
  const fx = await fixture();
  fx.spec.pipelines[0].profile = 'pytest';
  fx.spec.gate_profiles = { pytest: { 'test-rule-actions': ['python -m pytest backend/tests/test_selection_rule_actions.py -q'] } };
  assert.deepEqual(await validate(fx), { status: 'PASS', checked_commands: 1, environment_checked: false });
});

test('environment preflight rejects missing executable', async () => {
  const fx = await fixture();
  fx.spec.pipelines[0].profile = 'pytest';
  fx.spec.gate_profiles = { pytest: { 'test-rule-actions': ['python -m pytest backend/tests/test_selection_rule_actions.py -q'] } };
  const oldPath = process.env.PATH;
  const emptyBin = await mkdtemp(path.join(os.tmpdir(), 'no-python-path-'));
  try {
    process.env.PATH = emptyBin;
    assert.throws(
      () => validateGateManifest(fx.spec, { cwd: fx.root, manifestPath: fx.manifestPath, environment: true }),
      /EXECUTABLE_NOT_FOUND/,
    );
  } finally { process.env.PATH = oldPath; }
});

test('accepts frozen uv pytest gates and validates locked environment', async () => {
  const fx = await fixture();
  const bin = path.join(fx.root, 'bin');
  await mkdir(bin);
  await writeFile(path.join(fx.root, 'pyproject.toml'), '[project]\nrequires-python = ">=3.12,<3.13"\n');
  await writeFile(path.join(fx.root, 'uv.lock'), 'version = 1\n');
  await writeFile(path.join(fx.root, '.python-version'), '3.12\n');
  await writeFile(path.join(bin, 'uv'), '#!/bin/sh\necho 3.12.7\necho 8.3.0\n', { mode: 0o755 });
  fx.spec.pipelines[0].profile = 'pytest';
  fx.spec.gate_profiles = {
    pytest: {
      'test-rule-actions': [
        'uv run --frozen pytest backend/tests/test_x.py -q',
        'uv run --frozen python -m pytest backend/tests/test_x.py -q',
      ],
    },
  };
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${bin}:${oldPath}`;
    assert.deepEqual(
      validateGateManifest(fx.spec, { cwd: fx.root, manifestPath: fx.manifestPath, environment: true }),
      { status: 'PASS', checked_commands: 2, environment_checked: true },
    );
  } finally { process.env.PATH = oldPath; }
});

test('rejects unsafe or unfrozen uv forms identically', async () => {
  const fx = await fixture();
  fx.spec.pipelines[0].profile = 'pytest';
  for (const command of [
    'uv run pytest -q', 'uv run bash -c whoami', 'uv run sh -c whoami',
    'uv run python script.py', 'uv run --frozen python script.py',
    'uv run --frozen arbitrary-command', 'uv run --frozen pytest -q && touch pwned',
  ]) {
    fx.spec.gate_profiles = { pytest: { 'test-rule-actions': [command] } };
    assert.throws(
      () => validateGateManifest(fx.spec, { cwd: fx.root, manifestPath: fx.manifestPath }),
      ManifestPreflightError,
      command,
    );
  }
});
