import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STAGE_CLI = path.join(HERE, 'stage-cli.ts');

function run(cwd, args) {
  return spawnSync('npx', ['--yes', 'tsx', STAGE_CLI, ...args], {
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
async function fixture(runId) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stage-cli-budget-'));
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
    gate_profiles: {},
    pipelines: [{
      id: 'app',
      deployable: false,
      stages: ['implementation'],
      executors: { implementation: 'agent' },
      work_items: ['wi-app'],
      decision_ids: [],
      research_ids: [],
      contract_ids: [],
    }],
    work_items: [{ id: 'wi-app', pipeline_id: 'app', ...item }],
  };
  const manifestPath = path.join(root, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  let result = run(root, ['init', manifestPath, '--state-root', stateRoot, '--json']);
  assert.equal(result.status, 0, result.stderr);
  result = run(root, ['approve', runId, '--state-root', stateRoot, '--json']);
  assert.equal(result.status, 0, result.stderr);
  result = run(root, ['start', runId, 'implementation', '--pipeline', 'app', '--state-root', stateRoot, '--json']);
  assert.equal(result.status, 0, result.stderr);
  return { root, stateRoot, runId };
}
async function exhaustFive(fx) {
  for (let cycle = 1; cycle <= 5; cycle += 1) {
    let result = run(fx.root, [
      'scope-check', fx.runId, 'implementation', 'packages/db/src/change.ts',
      '--pipeline', 'app', '--state-root', fx.stateRoot,
    ]);
    assert.equal(result.status, 0, result.stderr);
    result = run(fx.root, [
      'fix-cycle', fx.runId, 'implementation',
      '--pipeline', 'app', '--state-root', fx.stateRoot, '--json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(result.stdout);
    assert.equal(state.pipelines.app.stages.implementation.technical_fix_cycles, cycle);
    assert.equal(state.pipelines.app.stages.implementation.technical_fix_limit, 5);
  }
}
async function writeReview(fx, name, review) {
  const file = path.join(fx.stateRoot, fx.runId, name);
  await writeFile(file, JSON.stringify(review, null, 2) + '\n');
  return file;
}
function reviewBase(fx, status) {
  return {
    kind: 'runtime_replan',
    status,
    pipeline_id: 'app',
    stage: 'implementation',
    summary: 'Change the technical approach for this block without changing frozen product behavior.',
    owner_questions: [],
    requirements_changed: false,
    acceptance_criteria_changed: false,
    external_contract_changed: false,
    security_boundary_changed: false,
    destructive_change: false,
  };
}

test('initial budget is 5 and owner can grant +3 after exhaustion', async () => {
  const fx = await fixture('budget-direct-grant');
  await exhaustFive(fx);

  let result = run(fx.root, [
    'scope-check', fx.runId, 'implementation', 'packages/db/src/change.ts',
    '--pipeline', 'app', '--state-root', fx.stateRoot,
  ]);
  assert.equal(result.status, 0, result.stderr);
  result = run(fx.root, [
    'fix-cycle', fx.runId, 'implementation', '--pipeline', 'app', '--state-root', fx.stateRoot,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TECHNICAL_FIX_LIMIT_EXCEEDED/);
  assert.match(result.stderr, /owner may grant \+N cycles or request runtime replan/);

  result = run(fx.root, [
    'fix-budget-add', fx.runId, 'implementation',
    '--pipeline', 'app', '--cycles', '3', '--state-root', fx.stateRoot, '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  let state = JSON.parse(result.stdout);
  let runtime = state.pipelines.app.stages.implementation;
  assert.equal(runtime.technical_fix_cycles, 5);
  assert.equal(runtime.technical_fix_limit, 8);
  assert.deepEqual(runtime.technical_fix_budget_grants[0], {
    timestamp: runtime.technical_fix_budget_grants[0].timestamp,
    source: 'owner_direct',
    added_cycles: 3,
    previous_limit: 5,
    new_limit: 8,
  });

  result = run(fx.root, [
    'scope-check', fx.runId, 'implementation', 'packages/db/src/change.ts',
    '--pipeline', 'app', '--state-root', fx.stateRoot,
  ]);
  assert.equal(result.status, 0, result.stderr);
  result = run(fx.root, [
    'fix-cycle', fx.runId, 'implementation',
    '--pipeline', 'app', '--state-root', fx.stateRoot, '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  state = JSON.parse(result.stdout);
  runtime = state.pipelines.app.stages.implementation;
  assert.equal(runtime.technical_fix_cycles, 6);
  assert.equal(runtime.technical_fix_limit, 8);
  assert.match(runtime.message, /cycle 6\/8/);
});

test('owner can increase the fix budget before exhaustion', async () => {
  const fx = await fixture('budget-not-exhausted');
  const result = run(fx.root, [
    'fix-budget-add', fx.runId, 'implementation',
    '--pipeline', 'app', '--cycles', '4', '--state-root', fx.stateRoot, '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(result.stdout);
  const runtime = state.pipelines.app.stages.implementation;
  assert.equal(runtime.technical_fix_cycles ?? 0, 0);
  assert.equal(runtime.technical_fix_limit, 9);
  assert.equal(runtime.technical_fix_budget_grants[0].source, 'owner_direct');
  assert.equal(runtime.technical_fix_budget_grants[0].added_cycles, 4);
  assert.equal(runtime.technical_fix_budget_grants[0].previous_limit, 5);
  assert.equal(runtime.technical_fix_budget_grants[0].new_limit, 9);
});

test('RUN-level fix-budget-set raises all stage ceilings and never lowers them', async () => {
  const fx = await fixture('budget-run-override');

  let result = run(fx.root, [
    'fix-budget-set', fx.runId, '--cycles', '12', '--state-root', fx.stateRoot, '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  let state = JSON.parse(result.stdout);
  let runtime = state.pipelines.app.stages.implementation;
  assert.equal(runtime.technical_fix_limit, 12);
  assert.deepEqual(runtime.technical_fix_budget_grants[0], {
    timestamp: runtime.technical_fix_budget_grants[0].timestamp,
    source: 'run_override',
    added_cycles: 7,
    previous_limit: 5,
    new_limit: 12,
  });

  result = run(fx.root, [
    'fix-budget-set', fx.runId, '--cycles', '7', '--state-root', fx.stateRoot, '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  state = JSON.parse(result.stdout);
  runtime = state.pipelines.app.stages.implementation;
  assert.equal(runtime.technical_fix_limit, 12);
  assert.equal(runtime.technical_fix_budget_grants.length, 1);
});

test('bounded security_fix requires deterministic evidence and consumes the shared fix budget', async () => {
  const fx = await fixture('security-fix-cycle');
  const evidence = await writeReview(fx, 'security-fix-app-implementation-1.json', {
    kind: 'security_fix',
    pipeline_id: 'app',
    stage: 'implementation',
    paths: ['packages/db/src/change.ts'],
    policy_basis: ['CT-08', 'least-privilege EXECUTE'],
    bounded_remediation: true,
    owner_decision_required: false,
    requirements_changed: false,
    acceptance_criteria_changed: false,
    external_contract_changed: false,
    security_boundary_changed: false,
    privilege_expansion: false,
    secret_exposure: false,
    destructive_change: false,
  });

  let result = run(fx.root, [
    'security-fix-check', fx.runId, 'implementation',
    '--pipeline', 'app', '--evidence', evidence, '--state-root', fx.stateRoot, '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  let state = JSON.parse(result.stdout);
  assert.equal(state.security_fix_preflight.pipeline_id, 'app');

  result = run(fx.root, [
    'scope-check', fx.runId, 'implementation', 'packages/db/src/change.ts',
    '--pipeline', 'app', '--state-root', fx.stateRoot,
  ]);
  assert.equal(result.status, 0, result.stderr);

  result = run(fx.root, [
    'fix-cycle', fx.runId, 'implementation',
    '--pipeline', 'app', '--state-root', fx.stateRoot,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SECURITY_FIX_REPAIR_CLASS_REQUIRED/);

  result = run(fx.root, [
    'fix-cycle', fx.runId, 'implementation', '--repair-class', 'security_fix',
    '--pipeline', 'app', '--state-root', fx.stateRoot, '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  state = JSON.parse(result.stdout);
  assert.equal(state.pipelines.app.stages.implementation.technical_fix_cycles, 1);
  assert.equal(state.pipelines.app.stages.implementation.technical_fix_limit, 5);
  assert.match(state.pipelines.app.stages.implementation.message, /security_fix cycle 1\/5/);
  assert.equal(state.security_fix_preflight, undefined);
});

test('security_fix authorization rejects privilege expansion and owner decisions', async () => {
  const fx = await fixture('security-fix-stop');
  const evidence = await writeReview(fx, 'security-fix-app-implementation-stop.json', {
    kind: 'security_fix',
    pipeline_id: 'app',
    stage: 'implementation',
    paths: ['packages/db/src/change.ts'],
    policy_basis: ['security policy'],
    bounded_remediation: true,
    owner_decision_required: false,
    requirements_changed: false,
    acceptance_criteria_changed: false,
    external_contract_changed: false,
    security_boundary_changed: false,
    privilege_expansion: true,
    secret_exposure: false,
    destructive_change: false,
  });

  const result = run(fx.root, [
    'security-fix-check', fx.runId, 'implementation',
    '--pipeline', 'app', '--evidence', evidence, '--state-root', fx.stateRoot,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SECURITY_FIX_OWNER_STOP_REQUIRED/);
});

test('runtime replan clarification can start before exhaustion but does not grant cycles', async () => {
  const fx = await fixture('runtime-replan-clarification');
  const evidence = await writeReview(fx, 'runtime-replan-app-implementation-1.json', {
    ...reviewBase(fx, 'needs_owner_clarification'),
    owner_questions: ['Use approach A or B for this block?'],
  });

  let result = run(fx.root, [
    'runtime-replan-propose', fx.runId, 'implementation',
    '--pipeline', 'app', '--evidence', evidence, '--state-root', fx.stateRoot, '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  let state = JSON.parse(result.stdout);
  let runtime = state.pipelines.app.stages.implementation;
  assert.equal(runtime.technical_fix_limit, 5);
  assert.equal(runtime.runtime_replans[0].status, 'awaiting_owner_clarification');
  assert.deepEqual(runtime.runtime_replans[0].owner_questions, ['Use approach A or B for this block?']);

  result = run(fx.root, [
    'runtime-replan-approve', fx.runId, 'implementation',
    '--pipeline', 'app', '--cycles', '3', '--state-root', fx.stateRoot,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OWNER_CLARIFICATION_REQUIRED/);

  result = run(fx.root, [
    'fix-budget-add', fx.runId, 'implementation',
    '--pipeline', 'app', '--cycles', '3', '--state-root', fx.stateRoot,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RUNTIME_REPLAN_PENDING/);
});

test('runtime replan approval can add cycles before exhaustion (5/6 -> 5/10)', async () => {
  const fx = await fixture('runtime-replan-approve');
  await exhaustFive(fx);

  let result = run(fx.root, [
    'fix-budget-add', fx.runId, 'implementation',
    '--pipeline', 'app', '--cycles', '1', '--state-root', fx.stateRoot, '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);

  const first = await writeReview(fx, 'runtime-replan-app-implementation-1.json', {
    ...reviewBase(fx, 'needs_owner_clarification'),
    owner_questions: ['Confirm whether the block may replace the internal helper.'],
  });
  result = run(fx.root, [
    'runtime-replan-propose', fx.runId, 'implementation',
    '--pipeline', 'app', '--evidence', first, '--state-root', fx.stateRoot,
  ]);
  assert.equal(result.status, 0, result.stderr);

  const second = await writeReview(fx, 'runtime-replan-app-implementation-2.json', {
    ...reviewBase(fx, 'ready_for_owner_approval'),
    summary: 'Use the reviewed replacement helper and keep all frozen behavior unchanged.',
  });
  result = run(fx.root, [
    'runtime-replan-propose', fx.runId, 'implementation',
    '--pipeline', 'app', '--evidence', second, '--state-root', fx.stateRoot, '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  let state = JSON.parse(result.stdout);
  let runtime = state.pipelines.app.stages.implementation;
  assert.equal(runtime.technical_fix_cycles, 5);
  assert.equal(runtime.technical_fix_limit, 6);
  assert.equal(runtime.runtime_replans.length, 2);
  assert.equal(runtime.runtime_replans[0].status, 'superseded');
  assert.equal(runtime.runtime_replans[1].status, 'awaiting_owner_approval');
  assert.equal(state.scope_preflight, undefined);

  result = run(fx.root, [
    'runtime-replan-approve', fx.runId, 'implementation',
    '--pipeline', 'app', '--cycles', '4', '--state-root', fx.stateRoot, '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  state = JSON.parse(result.stdout);
  runtime = state.pipelines.app.stages.implementation;
  assert.equal(runtime.technical_fix_cycles, 5);
  assert.equal(runtime.technical_fix_limit, 10);
  assert.equal(runtime.runtime_replans[1].status, 'approved');
  assert.equal(runtime.runtime_replans[1].granted_cycles, 4);
  assert.equal(runtime.technical_fix_budget_grants[0].source, 'owner_direct');
  assert.equal(runtime.technical_fix_budget_grants[1].source, 'runtime_replan');
  assert.equal(runtime.technical_fix_budget_grants[1].runtime_replan_revision, 2);

  result = run(fx.root, [
    'scope-check', fx.runId, 'implementation', 'packages/db/src/change.ts',
    '--pipeline', 'app', '--state-root', fx.stateRoot,
  ]);
  assert.equal(result.status, 0, result.stderr);
  result = run(fx.root, [
    'fix-cycle', fx.runId, 'implementation',
    '--pipeline', 'app', '--state-root', fx.stateRoot, '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  state = JSON.parse(result.stdout);
  assert.equal(state.pipelines.app.stages.implementation.technical_fix_cycles, 6);
  assert.equal(state.pipelines.app.stages.implementation.technical_fix_limit, 10);
});

test('runtime replan cannot cross frozen PLAN boundaries', async () => {
  const fx = await fixture('runtime-replan-full-plan');
  await exhaustFive(fx);
  const evidence = await writeReview(fx, 'runtime-replan-app-implementation-1.json', {
    ...reviewBase(fx, 'ready_for_owner_approval'),
    acceptance_criteria_changed: true,
  });

  const result = run(fx.root, [
    'runtime-replan-propose', fx.runId, 'implementation',
    '--pipeline', 'app', '--evidence', evidence, '--state-root', fx.stateRoot,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FULL_REPLAN_REQUIRED/);
});

test('runtime replan evidence must be run-owned', async () => {
  const fx = await fixture('runtime-replan-evidence-boundary');
  await exhaustFive(fx);
  const outside = path.join(fx.root, 'outside-review.json');
  await writeFile(outside, JSON.stringify(reviewBase(fx, 'ready_for_owner_approval')) + '\n');
  const result = run(fx.root, [
    'runtime-replan-propose', fx.runId, 'implementation',
    '--pipeline', 'app', '--evidence', outside, '--state-root', fx.stateRoot,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must live inside the current run directory/);
});
