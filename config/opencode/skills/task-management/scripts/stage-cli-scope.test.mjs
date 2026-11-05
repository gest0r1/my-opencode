import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { withApprovalArgs } from './test-approval-args.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STAGE_CLI = path.join(HERE, 'stage-cli.ts');

function run(cwd, args) {
  return spawnSync('npx', ['--yes', 'tsx', STAGE_CLI, ...withApprovalArgs(cwd, args)], {
    cwd,
    encoding: 'utf8',
    env: process.env,
  });
}
function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}
async function frozen(root, relative, content) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
  return { path: relative, sha256: sha(content) };
}
async function fixture(runId = 'scope-run', extra = {}, mutate = () => {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stage-cli-scope-'));
  const stateRoot = path.join(root, '.tmp', 'pipelines');
  const architecture = await frozen(root, 'planning/architecture.md', '# architecture\n');
  const review = await frozen(root, 'reviews/architecture.md', '# review\n');
  const requiredArtifacts = {
    decision_register: await frozen(root, 'decision-register.md', '# decisions\n'),
    technology_evidence: await frozen(root, 'technology-evidence.md', '# evidence\n'),
    contract_inventory: await frozen(root, 'contract-inventory.md', '# contracts\n'),
    test_strategy: await frozen(root, 'test-strategy.md', '# tests\n'),
    accepted_risks: await frozen(root, 'accepted-risks.md', '# risks\n'),
    work_items: await frozen(root, 'work-items/index.json', '{"schema":2}\n'),
  };
  const item = await frozen(root, 'work-items/wi-app.json', '{"id":"wi-app","pipeline_id":"app"}\n');
  const manifest = {
    schema_version: 2,
    run_id: runId,
    rules_file: 'docs/pipeline-rules.md',
    rules_version: 2,
    planning_mode: 'design-freeze',
    planning_readiness: {
      design_freeze: true,
      required_gates: ['architecture'],
      gates: {
        architecture: {
          required: true,
          status: 'ready',
          cycles: 1,
          artifact: architecture,
          review,
          blocking_decision_ids: [],
        },
      },
      required_artifacts: requiredArtifacts,
    },
    open_decisions: [],
    allowed_change_paths: ['packages/db/src/**'],
    ...extra,
    gate_profiles: {},
    pipelines: [{
      id: 'app',
      deployable: false,
      stages: ['implementation', 'code-review'],
      executors: { implementation: 'agent', 'code-review': 'review' },
      work_items: ['wi-app'],
      decision_ids: [],
      research_ids: [],
      contract_ids: [],
    }],
    work_items: [{ id: 'wi-app', pipeline_id: 'app', ...item }],
  };
  await mutate(manifest, root);
  const manifestPath = path.join(root, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  let result = run(root, ['init', manifestPath, '--state-root', stateRoot, '--json']);
  assert.equal(result.status, 0, result.stderr);
  result = run(root, ['approve', runId, '--state-root', stateRoot, '--json']);
  assert.equal(result.status, 0, result.stderr);
  return { root, stateRoot, runId, manifestPath };
}

test('scope-check automatically authorizes a concrete test path for an approved component', async () => {
  const fx = await fixture('scope-test-auto');
  const beforeManifest = await readFile(fx.manifestPath, 'utf8');
  const testPath = 'packages/db/test/047-client-contact-invariant.test.ts';

  const result = run(fx.root, [
    'scope-check', fx.runId, 'implementation', testPath,
    '--pipeline', 'app', '--state-root', fx.stateRoot, '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.requested_paths, [testPath]);
  assert.ok(output.effective_allowed_change_paths.includes(testPath));
  assert.equal(output.runtime_scope_extensions.length, 1);
  assert.equal(output.runtime_scope_extensions[0].scope_class, 'test');
  assert.deepEqual(output.runtime_scope_extensions[0].paths, [testPath]);

  const state = JSON.parse(await readFile(path.join(fx.stateRoot, fx.runId, 'state.json'), 'utf8'));
  assert.equal(state.scope_preflight.pipeline_id, 'app');
  assert.equal(state.scope_preflight.stage, 'implementation');
  assert.deepEqual(state.scope_preflight.paths, [testPath]);
  assert.equal(await readFile(fx.manifestPath, 'utf8'), beforeManifest);
});

test('scope-check requires architecture review for a new production path', async () => {
  const fx = await fixture('scope-technical-review');
  const result = run(fx.root, [
    'scope-check', fx.runId, 'implementation', 'packages/db/scripts/new-helper.ts',
    '--pipeline', 'app', '--state-root', fx.stateRoot,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TECHNICAL_SCOPE_REVIEW_REQUIRED/);
  assert.match(result.stderr, /do not consume a technical_fix cycle/);

  const state = JSON.parse(await readFile(path.join(fx.stateRoot, fx.runId, 'state.json'), 'utf8'));
  assert.deepEqual(state.runtime_scope_extensions ?? [], []);
});

test('scope-extend authorizes decision-free technical clarification with reviewed evidence', async () => {
  const fx = await fixture('scope-technical-ready');
  const requested = ['packages/db/scripts/new-helper.ts'];
  const evidence = path.join(fx.stateRoot, fx.runId, 'runtime-scope-review.json');
  await writeFile(evidence, JSON.stringify({
    status: 'ready',
    scope_class: 'technical',
    paths: requested,
    architecture_status: 'ready',
    review_status: 'ready',
    owner_decision_required: false,
    requirements_changed: false,
    acceptance_criteria_changed: false,
    external_contract_changed: false,
    security_boundary_changed: false,
    destructive_change: false,
  }, null, 2));

  const result = run(fx.root, [
    'scope-extend', fx.runId, 'implementation', ...requested,
    '--class', 'technical', '--evidence', evidence,
    '--pipeline', 'app', '--state-root', fx.stateRoot, '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.ok(output.effective_allowed_change_paths.includes(requested[0]));
  assert.equal(output.runtime_scope_extensions[0].scope_class, 'technical');
  assert.equal(output.runtime_scope_extensions[0].evidence_path, evidence);
  assert.match(output.runtime_scope_extensions[0].evidence_sha256, /^[0-9a-f]{64}$/);
});

test('scope-extend refuses technical review that needs an owner decision', async () => {
  const fx = await fixture('scope-owner-required');
  const requested = ['packages/db/scripts/new-helper.ts'];
  const evidence = path.join(fx.stateRoot, fx.runId, 'runtime-scope-review.json');
  await writeFile(evidence, JSON.stringify({
    status: 'ready',
    scope_class: 'technical',
    paths: requested,
    architecture_status: 'ready',
    review_status: 'ready',
    owner_decision_required: true,
    requirements_changed: false,
    acceptance_criteria_changed: false,
    external_contract_changed: false,
    security_boundary_changed: false,
    destructive_change: false,
  }, null, 2));

  const result = run(fx.root, [
    'scope-extend', fx.runId, 'implementation', ...requested,
    '--class', 'technical', '--evidence', evidence,
    '--pipeline', 'app', '--state-root', fx.stateRoot,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OWNER_OR_REPLAN_REQUIRED/);
});

test('PLAN scope rejects unsupported wildcard syntax before init', async () => {
  const fx = await fixture('scope-glob-base');
  const manifest = JSON.parse(await readFile(fx.manifestPath, 'utf8'));
  manifest.run_id = 'scope-bad-glob';
  manifest.allowed_change_paths = ['eslint.config.*'];
  const bad = path.join(fx.root, 'bad-manifest.json');
  await writeFile(bad, JSON.stringify(manifest, null, 2) + '\n');
  const result = run(fx.root, ['init', bad, '--state-root', path.join(fx.root, '.tmp', 'bad-state')]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exact repository-relative paths or directory\/\*\*/);
});


test('fix-cycle requires matching scope preflight and consumes it once', async () => {
  const fx = await fixture('scope-fix-preflight');
  for (const [command, stage] of [['start', 'implementation'], ['complete', 'implementation'], ['start', 'code-review']]) {
    const setup = run(fx.root, [command, fx.runId, stage, '--pipeline', 'app', '--state-root', fx.stateRoot]);
    assert.equal(setup.status, 0, setup.stderr);
  }
  const evidence = path.join(fx.root, 'review.json');
  await writeFile(evidence, JSON.stringify({ status: 'needs_revision' }));
  let result = run(fx.root, [
    'fix-cycle', fx.runId, 'code-review', '--pipeline', 'app', '--state-root', fx.stateRoot, '--evidence', evidence,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SCOPE_PREFLIGHT_REQUIRED/);

  result = run(fx.root, [
    'scope-check', fx.runId, 'code-review', 'packages/db/src/migrate.ts',
    '--pipeline', 'app', '--state-root', fx.stateRoot, '--evidence', evidence,
  ]);
  assert.equal(result.status, 0, result.stderr);

  result = run(fx.root, [
    'fix-cycle', fx.runId, 'code-review', '--pipeline', 'app', '--state-root', fx.stateRoot, '--evidence', evidence, '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(result.stdout);
  assert.equal(state.pipelines.app.stages['code-review'].technical_fix_cycles, 1);
  assert.equal(state.scope_preflight, undefined);

  result = run(fx.root, [
    'fix-cycle', fx.runId, 'code-review', '--pipeline', 'app', '--state-root', fx.stateRoot, '--evidence', evidence,
  ]);
  assert.equal(result.status, 0, result.stderr);
});

test('runtime scope cannot auto-authorize workflow trust-boundary paths', async () => {
  const fx = await fixture('scope-workflow-protected');
  const result = run(fx.root, [
    'scope-check', fx.runId, 'implementation', '.github/workflows/new-ci.yml',
    '--pipeline', 'app', '--state-root', fx.stateRoot,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OWNER_OR_REPLAN_REQUIRED/);
  assert.match(result.stderr, /protected\/sensitive path/);
});


test('scope-check authorizes declared generator outputs without a reviewer', async () => {
  const fx = await fixture('scope-generated', { generated_paths: ['docs/testing/**'] });
  const result = run(fx.root, ['scope-check', fx.runId, 'implementation', 'docs/testing/test-blocks.json', '--pipeline', 'app', '--state-root', fx.stateRoot, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.runtime_scope_extensions[0].scope_class, 'generated');
});

test('class 1 technical scope needs only the senior review when no module boundary changes', async () => {
  const fx = await fixture('scope-class-one');
  const requested = ['packages/db/scripts/new-helper.ts'];
  const evidence = path.join(fx.stateRoot, fx.runId, 'runtime-scope-review.json');
  const base = { status: 'ready', scope_class: 'technical', paths: requested, review_status: 'ready', owner_decision_required: false,
    requirements_changed: false, acceptance_criteria_changed: false, external_contract_changed: false, security_boundary_changed: false, destructive_change: false };
  const extend = () => run(fx.root, ['scope-extend', fx.runId, 'implementation', ...requested, '--class', 'technical', '--evidence', evidence, '--pipeline', 'app', '--state-root', fx.stateRoot, '--json']);
  await writeFile(evidence, JSON.stringify({ ...base, architecture_status: 'not_required', module_boundary_changed: true }));
  assert.notEqual(extend().status, 0);
  await writeFile(evidence, JSON.stringify({ ...base, architecture_status: 'not_required', module_boundary_changed: false }));
  const result = extend();
  assert.equal(result.status, 0, result.stderr);
});

test('owner-skip needs the owner decision and makes the stage skipped', async () => {
  const fx = await fixture('owner-skip-run');
  const evidence = path.join(fx.stateRoot, fx.runId, 'owner-skip.json');
  const skip = () => run(fx.root, ['owner-skip', fx.runId, 'implementation', '--pipeline', 'app', '--evidence', evidence, '--state-root', fx.stateRoot, '--json']);
  await writeFile(evidence, JSON.stringify({ kind: 'owner_skip', stage: 'implementation', pipeline_id: 'app', reason: 'CI billing', owner_decision_required: true }));
  assert.notEqual(skip().status, 0);
  await writeFile(evidence, JSON.stringify({ kind: 'owner_skip', stage: 'implementation', pipeline_id: 'app', reason: 'CI billing', owner_decision_required: true, owner_decision: 'Пропусти стадию' }));
  const result = skip();
  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(await readFile(path.join(fx.stateRoot, fx.runId, 'state.json'), 'utf8'));
  assert.equal(state.pipelines.app.stages.implementation.status, 'skipped');
});

test('scope-check extends to siblings of an exact in-scope test path, not to other directories or protected paths', async () => {
  const fx = await fixture('scope-sibling', { allowed_change_paths: ['packages/db/src/**', 'tools/gen/inventory.test.mjs'] });
  const sibling = 'tools/gen/pin.test.mjs';
  let result = run(fx.root, ['scope-check', fx.runId, 'implementation', sibling,
    '--pipeline', 'app', '--state-root', fx.stateRoot, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.runtime_scope_extensions[0].scope_class, 'test');
  assert.deepEqual(output.runtime_scope_extensions[0].paths, [sibling]);
  result = run(fx.root, ['scope-check', fx.runId, 'implementation', 'tools/other/pin.test.mjs', '--pipeline', 'app', '--state-root', fx.stateRoot]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TECHNICAL_SCOPE_REVIEW_REQUIRED/);
  result = run(fx.root, ['scope-check', fx.runId, 'implementation', 'tools/gen/not-a-test.mjs', '--pipeline', 'app', '--state-root', fx.stateRoot]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TECHNICAL_SCOPE_REVIEW_REQUIRED/);
  result = run(fx.root, ['scope-check', fx.runId, 'implementation', 'tools/gen/fixtures/list.json', '--pipeline', 'app', '--state-root', fx.stateRoot]);
  assert.notEqual(result.status, 0, 'fixtures subdirectory is not a sibling');
});

test('scope-check never auto-authorizes protected paths as test siblings', async () => {
  const fx = await fixture('scope-sibling-protected', { allowed_change_paths: ['packages/db/src/**', '.github/workflows/ci.test.yml'] });
  const result = run(fx.root, ['scope-check', fx.runId, 'implementation', '.github/workflows/other.test.yml', '--pipeline', 'app', '--state-root', fx.stateRoot]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OWNER_OR_REPLAN_REQUIRED/);
});

async function withTestPreparation(manifest, root, reworkPath = 'tools/gen/inventory.test.mjs') {
  const prep = await frozen(root, 'work-items/wi-prep.json', '{"id":"wi-prep","pipeline_id":"prep"}\n');
  manifest.test_rework = [{ id: 'tr-1', path: reworkPath, action: 'update', reason: 'pins the list this run changes', work_item_id: 'wi-prep' }];
  manifest.pipelines.unshift({
    id: 'prep', deployable: false, test_preparation: true, stages: ['implementation', 'code-review'],
    executors: { implementation: 'agent', 'code-review': 'review' }, ready_after_stage: 'code-review',
    work_items: ['wi-prep'], decision_ids: [], research_ids: [], contract_ids: [],
  });
  manifest.pipelines.find(p => p.id === 'app').depends_on = ['prep'];
  manifest.work_items.push({ id: 'wi-prep', pipeline_id: 'prep', ...prep });
}

test('scope-check authorizes tests under the directory of a test_rework entry', async () => {
  const fx = await fixture('scope-rework', { allowed_change_paths: ['packages/db/src/**', 'tools/gen/inventory.test.mjs'] }, withTestPreparation);
  const result = run(fx.root, ['scope-check', fx.runId, 'implementation', 'tools/gen/fixtures/list.json',
    '--pipeline', 'app', '--state-root', fx.stateRoot, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).runtime_scope_extensions[0].paths, ['tools/gen/fixtures/list.json']);
  const other = run(fx.root, ['scope-check', fx.runId, 'implementation', 'tools/elsewhere/fixtures/list.json', '--pipeline', 'app', '--state-root', fx.stateRoot]);
  assert.notEqual(other.status, 0);
});

test('v2 policy validates test_rework entries and the test_preparation lane', async () => {
  const { validateTestRework } = await import('./manifest-v2-policy.mjs');
  const base = () => ({
    allowed_change_paths: ['tools/gen/inventory.test.mjs', 'src/**'],
    test_rework: [{ id: 'tr-1', path: 'tools/gen/inventory.test.mjs', action: 'update', reason: 'pin', work_item_id: 'wi-prep' }],
    pipelines: [
      { id: 'prep', deployable: false, test_preparation: true, stages: ['implementation'], executors: { implementation: 'agent' }, work_items: ['wi-prep'] },
      { id: 'app', deployable: false, stages: ['implementation'], executors: { implementation: 'agent' }, depends_on: ['mid'], work_items: ['wi-app'] },
      { id: 'mid', deployable: false, stages: ['implementation'], executors: { implementation: 'agent' }, depends_on: ['prep'], work_items: ['wi-mid'] },
    ],
    work_items: [{ id: 'wi-prep', pipeline_id: 'prep' }, { id: 'wi-app', pipeline_id: 'app' }, { id: 'wi-mid', pipeline_id: 'mid' }],
  });
  validateTestRework(base());
  const reject = (mutate, code) => { const m = base(); mutate(m); assert.throws(() => validateTestRework(m), new RegExp(code)); };
  reject(m => { m.test_rework[0].action = 'delete'; }, 'TEST_REWORK_ACTION_INVALID');
  reject(m => { m.test_rework.push({ ...m.test_rework[0] }); }, 'TEST_REWORK_DUPLICATE_ID');
  reject(m => { m.test_rework[0].path = 'src/**'; }, 'TEST_REWORK_PATH_INVALID');
  reject(m => { m.test_rework[0].path = 'tools/other.test.mjs'; }, 'TEST_REWORK_PATH_OUT_OF_SCOPE');
  reject(m => { m.test_rework[0].work_item_id = 'wi-app'; }, 'TEST_REWORK_WORK_ITEM_INVALID');
  reject(m => { m.test_rework[0].work_item_id = 'missing'; }, 'TEST_REWORK_WORK_ITEM_INVALID');
  reject(m => { m.test_rework[0].reason = ' '; }, 'TEST_REWORK_INVALID');
  reject(m => { delete m.pipelines[0].test_preparation; }, 'TEST_REWORK_LANE_MISSING');
  reject(m => { m.pipelines[0].deployable = true; }, 'TEST_REWORK_LANE_DEPLOYABLE');
  reject(m => { m.pipelines[1].depends_on = []; }, 'TEST_REWORK_LANE_NOT_FIRST');
  reject(m => { m.pipelines[0].test_preparation = 'yes'; }, 'TEST_REWORK_LANE_INVALID');
});
