import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
let reviewSequence = 0;
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, unlink, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { withApprovalArgs } from './test-approval-args.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STAGE_CLI = path.join(HERE, 'stage-cli.ts');

test('approved source deletion removes tracked source, rejects scope escapes and is resumable', async () => {
  const fx = await fixture('source-delete', ['implementation'], { implementation: 'agent' }, true);
  const manifestPath = path.join(fx.root, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  // Source deletion follows the same canonical run layout as dispatch.
  // Paths in a manifest resolve relative to its folder. Keep fixture evidence at root;
  // place authorization in the same folder and use state-root for stage setup only.
  const evidence = { kind: 'source_deletion', status: 'ready', run_id: fx.runId, pipeline_id: 'app', work_item_id: 'wi-app',
    work_item_sha256: manifest.work_items[0].sha256, approved_requirement: true, owner_decision_required: false,
    policy_basis: 'AC: remove obsolete source', paths: ['packages/db/src/obsolete.ts'] };
  const file = path.join(fx.root, 'deletion.json'); await writeFile(file, JSON.stringify(evidence));
  const remove = () => spawnSync('npx', ['--yes', 'tsx', path.join(HERE, 'git-worktree-cli.ts'), 'delete', fx.runId,
    '--pipeline', 'app', '--stage', 'implementation', '--work-item', 'wi-app', '--role', 'CoderAgent', '--evidence', file], { cwd: fx.root, encoding: 'utf8', env: process.env });
  evidence.paths = ['packages/db/src/obsolete.ts', 'protected.ts']; await writeFile(file, JSON.stringify(evidence));
  let result = remove(); assert.notEqual(result.status, 0); assert.match(result.stderr, /SOURCE_DELETE_OUTSIDE_SCOPE/);
  assert.match(await readFile(path.join(fx.root, 'packages/db/src/obsolete.ts'), 'utf8'), /obsolete/);
  evidence.paths = ['packages/db/src/obsolete.ts']; evidence.owner_decision_required = true; await writeFile(file, JSON.stringify(evidence));
  result = remove(); assert.notEqual(result.status, 0); assert.match(result.stderr, /SOURCE_DELETE_AUTHORIZATION_REQUIRED/);
  evidence.owner_decision_required = false; await writeFile(file, JSON.stringify(evidence));
  await unlink(path.join(fx.root, evidence.paths[0]));
  await symlink(path.join(fx.root, 'protected.ts'), path.join(fx.root, evidence.paths[0]));
  result = remove(); assert.notEqual(result.status, 0); assert.match(result.stderr, /SOURCE_DELETE_REQUIRES_REGULAR_FILE/);
  await unlink(path.join(fx.root, evidence.paths[0]));
  await writeFile(path.join(fx.root, evidence.paths[0]), 'export const obsolete = true;\n');
  result = remove(); assert.equal(result.status, 0, result.stderr);
  await assert.rejects(readFile(path.join(fx.root, evidence.paths[0])), /ENOENT/);
  result = remove(); assert.equal(result.status, 0, result.stderr);
  evidence.paths = ['protected.ts']; await writeFile(file, JSON.stringify(evidence));
  result = remove(); assert.notEqual(result.status, 0); assert.match(result.stderr, /SOURCE_DELETE_OUTSIDE_SCOPE/);
  assert.equal(await readFile(path.join(fx.root, 'protected.ts'), 'utf8'), 'keep\n');
});

test('approved source move copies bytes exactly, verifies the hash, then removes the original', async () => {
  const fx = await fixture('source-move', ['implementation'], { implementation: 'agent' }, true);
  const manifest = JSON.parse(await readFile(path.join(fx.root, 'manifest.json'), 'utf8'));
  const from = 'packages/db/src/obsolete.ts'; const to = 'packages/db/src/archive/pre-baseline/obsolete.ts';
  const original = await readFile(path.join(fx.root, from));
  const evidence = { kind: 'source_move', status: 'ready', run_id: fx.runId, pipeline_id: 'app', work_item_id: 'wi-app',
    work_item_sha256: manifest.work_items[0].sha256, approved_requirement: true, owner_decision_required: false,
    policy_basis: 'AC: archive released source byte-for-byte', moves: [{ from, to: 'archive/obsolete.ts' }] };
  const file = path.join(fx.root, 'move.json');
  const move = async () => {
    await writeFile(file, JSON.stringify(evidence));
    return spawnSync('npx', ['--yes', 'tsx', path.join(HERE, 'git-worktree-cli.ts'), 'move', fx.runId,
      '--pipeline', 'app', '--stage', 'implementation', '--work-item', 'wi-app', '--role', 'CoderAgent', '--evidence', file], { cwd: fx.root, encoding: 'utf8', env: process.env });
  };
  let result = await move(); assert.notEqual(result.status, 0); assert.match(result.stderr, /SOURCE_MOVE_OUTSIDE_SCOPE/);
  evidence.moves = [{ from, to }, { from: to, to: 'packages/db/src/other.ts' }];
  result = await move(); assert.notEqual(result.status, 0); assert.match(result.stderr, /SOURCE_MOVE_CHAINED_PATH/);
  evidence.moves = [{ from, to }]; evidence.owner_decision_required = true;
  result = await move(); assert.notEqual(result.status, 0); assert.match(result.stderr, /SOURCE_MOVE_AUTHORIZATION_REQUIRED/);
  evidence.owner_decision_required = false;
  await mkdir(path.dirname(path.join(fx.root, to)), { recursive: true });
  await writeFile(path.join(fx.root, to), 'different\n');
  result = await move(); assert.notEqual(result.status, 0); assert.match(result.stderr, /SOURCE_MOVE_TARGET_EXISTS/);
  await unlink(path.join(fx.root, to));
  assert.deepEqual(await readFile(path.join(fx.root, from)), original);
  result = await move(); assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(await readFile(path.join(fx.root, to)), original);
  await assert.rejects(readFile(path.join(fx.root, from)), /ENOENT/);
  assert.equal(output.moved[0].sha256, createHash('sha256').update(original).digest('hex'));
  assert.equal(JSON.parse(await readFile(output.evidence, 'utf8')).status, 'PASS');
  result = await move(); assert.equal(result.status, 0, result.stderr);
  await writeFile(path.join(fx.root, to), 'tampered\n');
  result = await move(); assert.notEqual(result.status, 0); assert.match(result.stderr, /SOURCE_MOVE_SOURCE_MISSING/);
});

test('deferred owner decision lets repairs finish and blocks only the final gate', async () => {
  const fx = await fixture('deferred-owner', ['implementation', 'code-review', 'final-test'], { implementation: 'agent', 'code-review': 'review', 'final-test': 'local_gate' });
  const file = await writeReview(fx, 'decision.json', { kind: 'deferred_owner_decision', owner_decision_required: true,
    independent_repairs_safe: true, action_executed: false, summary: 'Remove data?', paths: ['data.bin'], source_stage: 'code-review', before_stage: 'final-test' });
  let result = run(fx.root, ['owner-decision-defer', fx.runId, 'delete-data', '--pipeline', 'app', '--evidence', file, '--state-root', fx.stateRoot]);
  assert.equal(result.status, 0, result.stderr);
  for (const [command, stage] of [['complete', 'implementation'], ['start', 'code-review'], ['complete', 'code-review']]) {
    result = run(fx.root, [command, fx.runId, stage, '--pipeline', 'app', '--state-root', fx.stateRoot, '--json']);
    assert.equal(result.status, 0, result.stderr);
  }
  const state = JSON.parse(result.stdout);
  assert.equal(state.pipelines.app.stages['final-test'].status, 'blocked');
  assert.equal(state.pipelines.app.stages.implementation.status, 'completed');
  result = run(fx.root, ['start', fx.runId, 'final-test', '--pipeline', 'app', '--state-root', fx.stateRoot]);
  assert.notEqual(result.status, 0);
  result = run(fx.root, ['owner-decision-resolve', fx.runId, 'delete-data', '--message', 'approve', '--state-root', fx.stateRoot]);
  assert.equal(result.status, 0, result.stderr);
  result = run(fx.root, ['scope-check', fx.runId, 'code-review', 'packages/db/src/change.ts', '--pipeline', 'app', '--state-root', fx.stateRoot]);
  assert.equal(result.status, 0, result.stderr);
  result = run(fx.root, ['fix-cycle', fx.runId, 'code-review', '--pipeline', 'app', '--state-root', fx.stateRoot, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).pipelines.app.stages['code-review'].technical_fix_cycles, 1);
});

test('legacy blocked review resumes its already charged attempt without spending another cycle', async () => {
  const fx = await fixture('legacy-review-repair', ['implementation', 'code-review'], { implementation: 'agent', 'code-review': 'review' });
  const cli = args => run(fx.root, [...args, '--pipeline', 'app', '--state-root', fx.stateRoot]);
  for (const [command, stage] of [['complete', 'implementation'], ['start', 'code-review']]) {
    const result = cli([command, fx.runId, stage]); assert.equal(result.status, 0, result.stderr);
  }
  const evidence = await writeReview(fx, 'repair.json', { findings: ['bounded repair'] });
  let result = cli(['scope-check', fx.runId, 'code-review', 'packages/db/src/change.ts']); assert.equal(result.status, 0, result.stderr);
  result = cli(['fix-cycle', fx.runId, 'code-review', '--evidence', evidence]); assert.equal(result.status, 0, result.stderr);
  // Seed the valid persisted shape produced by the old transport bug.
  const statePath = path.join(fx.stateRoot, fx.runId, 'state.json');
  const old = JSON.parse(await readFile(statePath, 'utf8'));
  old.pipelines.app.stages.implementation.status = 'completed';
  delete old.pipelines.app.stages.implementation.repair_origin_stage;
  old.pipelines.app.stages['code-review'].status = 'blocked';
  old.pipelines.app.stages['code-review'].message = 'INVALID_DISPATCH_ROLE: repair transport unavailable';
  old.pipelines.app.status = 'blocked'; old.status = 'blocked';
  await writeFile(statePath, JSON.stringify(old));
  result = cli(['scope-check', fx.runId, 'code-review', 'packages/db/src/change.ts']); assert.equal(result.status, 0, result.stderr);
  result = cli(['fix-cycle', fx.runId, 'code-review', '--evidence', evidence, '--json']); assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(result.stdout);
  assert.equal(state.pipelines.app.stages['code-review'].technical_fix_cycles, 1);
  assert.equal(state.pipelines.app.stages.implementation.status, 'pending');
  assert.equal(state.pipelines.app.stages.implementation.repair_origin_stage, 'code-review');
});

test('review repairs reopen implementation and share the initiating gate budget through repeated reviews', async () => {
  const fx = await fixture('review-repair', ['implementation', 'code-review'], { implementation: 'agent', 'code-review': 'review' });
  let result = run(fx.root, ['complete', fx.runId, 'implementation', '--pipeline', 'app', '--state-root', fx.stateRoot, '--json']);
  assert.equal(result.status, 0, result.stderr);
  for (let cycle = 1; cycle <= 5; cycle++) {
    result = run(fx.root, ['start', fx.runId, 'code-review', '--pipeline', 'app', '--state-root', fx.stateRoot, '--json']);
    assert.equal(result.status, 0, result.stderr);
    result = run(fx.root, ['scope-check', fx.runId, 'code-review', 'packages/db/src/change.ts', '--pipeline', 'app', '--state-root', fx.stateRoot]);
    assert.equal(result.status, 0, result.stderr);
    const repairEvidence = await writeReview(fx, `review-${cycle}.json`, { findings: [`repair cycle ${cycle}`] });
    result = run(fx.root, ['fix-cycle', fx.runId, 'code-review', '--pipeline', 'app', '--state-root', fx.stateRoot, '--evidence', repairEvidence, '--json']);
    assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(result.stdout);
    assert.equal(state.pipelines.app.stages['code-review'].technical_fix_cycles, cycle);
    assert.equal(state.pipelines.app.stages.implementation.technical_fix_cycles ?? 0, 0);
    assert.equal(state.pipelines.app.stages.implementation.status, 'pending');
    assert.equal(state.pipelines.app.stages.implementation.repair_origin_stage, 'code-review');
    const packet = run(fx.root, ['dispatch', fx.runId, '--pipeline', 'app', '--stage', 'implementation', '--work-item', 'wi-app', '--role', 'CoderAgent']);
    assert.equal(packet.status, 0, packet.stderr);
    const dispatched = JSON.parse(packet.stdout);
    assert.equal(dispatched.loop, cycle);
    assert.equal(dispatched.repair_origin_stage, 'code-review');
    assert.deepEqual(dispatched.repair_paths, ['packages/db/src/change.ts']);
    assert.ok(dispatched.evidence_paths.includes(repairEvidence));
    const duplicate = run(fx.root, ['fix-cycle', fx.runId, 'implementation', '--pipeline', 'app', '--state-root', fx.stateRoot]);
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, /REPAIR_BUDGET_OWNER/);
    result = run(fx.root, ['start', fx.runId, 'implementation', '--pipeline', 'app', '--state-root', fx.stateRoot]);
    assert.equal(result.status, 0, result.stderr);
    result = run(fx.root, ['complete', fx.runId, 'implementation', '--pipeline', 'app', '--state-root', fx.stateRoot]);
    assert.equal(result.status, 0, result.stderr);
  }
  result = run(fx.root, ['start', fx.runId, 'code-review', '--pipeline', 'app', '--state-root', fx.stateRoot]);
  assert.equal(result.status, 0, result.stderr);
  result = run(fx.root, ['scope-check', fx.runId, 'code-review', 'packages/db/src/change.ts', '--pipeline', 'app', '--state-root', fx.stateRoot]);
  assert.equal(result.status, 0, result.stderr);
  result = run(fx.root, ['fix-cycle', fx.runId, 'code-review', '--pipeline', 'app', '--state-root', fx.stateRoot]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TECHNICAL_FIX_LIMIT_EXCEEDED/);
});

test('FindingsReviewer only re-checks issued findings, and a review stage closes on a full CodeReviewer', async () => {
  const fx = await fixture('findings-review', ['implementation', 'code-review'], { implementation: 'agent', 'code-review': 'review' });
  const cli = (args) => run(fx.root, [...args, '--pipeline', 'app', '--state-root', fx.stateRoot]);
  const dispatch = (stage, role) => run(fx.root, ['dispatch', fx.runId, '--pipeline', 'app', '--stage', stage, '--work-item', stage === 'code-review' ? stage : 'wi-app', '--role', role]);
  const complete = (stage) => spawnSync('npx', ['--yes', 'tsx', path.join(HERE, 'stage-complete-cli.ts'), 'complete', fx.runId, stage, '--pipeline', 'app'],
    { cwd: fx.root, encoding: 'utf8', env: process.env });
  // The fixture leaves implementation completed and code-review in progress.
  let result;
  result = dispatch('code-review', 'FindingsReviewer');
  assert.notEqual(result.status, 0); assert.match(result.stderr, /FINDINGS_REVIEW_NEEDS_ISSUED_FINDINGS/);
  result = dispatch('code-review', 'CodeReviewer'); assert.equal(result.status, 0, result.stderr);
  result = cli(['scope-check', fx.runId, 'code-review', 'packages/db/src/change.ts']); assert.equal(result.status, 0, result.stderr);
  result = cli(['fix-cycle', fx.runId, 'code-review', '--evidence', await writeReview(fx, 'findings-1.json', { findings: ['R1'] })]);
  assert.equal(result.status, 0, result.stderr);
  result = dispatch('implementation', 'FindingsReviewer');
  assert.notEqual(result.status, 0); assert.match(result.stderr, /INVALID_DISPATCH_ROLE/);
  for (const command of ['start', 'complete']) { result = cli([command, fx.runId, 'implementation']); assert.equal(result.status, 0, `${command}: ${result.stderr}`); }
  result = cli(['start', fx.runId, 'code-review']); assert.equal(result.status, 0, result.stderr);
  result = dispatch('code-review', 'FindingsReviewer'); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).role, 'FindingsReviewer');
  result = complete('code-review');
  assert.notEqual(result.status, 0); assert.match(result.stderr, /REVIEW_CLOSING_FULL_REQUIRED: app\/code-review/);
  result = dispatch('code-review', 'CodeReviewer'); assert.equal(result.status, 0, result.stderr);
  result = complete('code-review'); assert.equal(result.status, 0, result.stderr);
});

test('advance completes a stage, starts the next stage that needs no preparation and leaves the rest waiting', async () => {
  const fx = await fixture('advance-run', ['implementation', 'second-review', 'verify'], { implementation: 'agent', 'second-review': 'review', verify: 'git_verify' });
  const advance = (stage) => spawnSync('npx', ['--yes', 'tsx', path.join(HERE, 'stage-complete-cli.ts'), 'advance', fx.runId, stage, '--pipeline', 'app'],
    { cwd: fx.root, encoding: 'utf8', env: process.env });
  let result = advance('implementation');
  assert.equal(result.status, 0, result.stderr);
  let out = JSON.parse(result.stdout);
  assert.deepEqual(out.completed, { pipeline_id: 'app', stage: 'implementation' });
  assert.deepEqual(out.started, [{ pipeline_id: 'app', stage: 'second-review', executor: 'review' }]);
  assert.deepEqual(out.waiting, []);
  assert.equal(out.github_sync.status, 'PASS');
  result = run(fx.root, ['dispatch', fx.runId, '--pipeline', 'app', '--stage', 'second-review', '--work-item', 'second-review', '--role', 'CodeReviewer']);
  assert.equal(result.status, 0, result.stderr);
  result = advance('second-review');
  assert.equal(result.status, 0, result.stderr);
  out = JSON.parse(result.stdout);
  assert.deepEqual(out.started, []);
  assert.deepEqual(out.waiting, [{ pipeline_id: 'app', stage: 'verify', executor: 'git_verify' }]);
  const state = JSON.parse(readFileSync(path.join(fx.stateRoot, fx.runId, 'state.json'), 'utf8'));
  assert.equal(state.pipelines.app.stages.verify.status, 'pending');
  result = run(fx.root, ['status', fx.runId, '--chart', '--state-root', fx.stateRoot]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^advance-run  \S+  █+░+ 2\/3 stages 67%  fix cycles 0\n/);
  assert.match(result.stdout, /\napp +\S+ +✓ implementation → ✓ second-review → · verify\n/);
});

function run(cwd, args) {
  if (args[0] === 'fix-cycle' && args[2] === 'code-review' && !args.includes('--evidence')) {
    const file = path.join(cwd, 'review-result.json');
    writeFileSync(file, JSON.stringify({ status: 'needs_revision', run_id: args[1], pipeline_id: 'app', stage: 'code-review', result_id: ++reviewSequence }));
    args = [...args, '--evidence', file];
  }
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
async function fixture(runId, stages = ['implementation', 'code-review'], executors = { implementation: 'agent', 'code-review': 'review' }, sourceFiles = false) {
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
    gate_profiles: stages.some(stage => executors[stage] === 'local_gate') ? { test: Object.fromEntries(stages.filter(stage => executors[stage] === 'local_gate').map(stage => [stage, ['npm test']])) } : {},
    pipelines: [{
      id: 'app',
      ...(stages.some(stage => executors[stage] === 'local_gate') ? { profile: 'test' } : {}),
      deployable: false,
      stages,
      executors,
      work_items: ['wi-app'],
      decision_ids: [],
      research_ids: [],
      contract_ids: [],
    }],
    work_items: [{ id: 'wi-app', pipeline_id: 'app', ...item }],
  };
  const manifestPath = path.join(root, 'manifest.json');
  if (sourceFiles) {
    await mkdir(path.join(root, 'packages/db/src'), { recursive: true });
    await writeFile(path.join(root, 'packages/db/src/obsolete.ts'), 'export const obsolete = true;\n');
    await writeFile(path.join(root, 'protected.ts'), 'keep\n');
    const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(git('init', '-b', 'main').status, 0);
    git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
    git('add', '.'); assert.equal(git('commit', '-m', 'base').status, 0);
    const base = git('rev-parse', 'HEAD').stdout.trim();
    assert.equal(git('checkout', '-b', 'fix-source').status, 0);
    manifest.git_setup = { base_sha: base, branch: 'fix-source' };
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  let result = run(root, ['init', manifestPath, '--state-root', stateRoot, '--json']);
  assert.equal(result.status, 0, result.stderr);
  result = run(root, ['approve', runId, '--state-root', stateRoot, '--json']);
  assert.equal(result.status, 0, result.stderr);
  result = run(root, ['start', runId, 'implementation', '--pipeline', 'app', '--state-root', stateRoot, '--json']);
  assert.equal(result.status, 0, result.stderr);
  if (stages.includes('code-review') && !['review-repair', 'legacy-review-repair', 'deferred-owner'].includes(runId)) {
    result = run(root, ['complete', runId, 'implementation', '--pipeline', 'app', '--state-root', stateRoot]);
    assert.equal(result.status, 0, result.stderr);
    result = run(root, ['start', runId, 'code-review', '--pipeline', 'app', '--state-root', stateRoot]);
    assert.equal(result.status, 0, result.stderr);
  }
  return { root, stateRoot, runId };
}
async function exhaustFive(fx) {
  for (let cycle = 1; cycle <= 5; cycle += 1) {
    let result = run(fx.root, [
      'scope-check', fx.runId, 'code-review', 'packages/db/src/change.ts',
      '--pipeline', 'app', '--state-root', fx.stateRoot,
    ]);
    assert.equal(result.status, 0, result.stderr);
    result = run(fx.root, [
      'fix-cycle', fx.runId, 'code-review',
      '--pipeline', 'app', '--state-root', fx.stateRoot, '--json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(result.stdout);
    assert.equal(state.pipelines.app.stages['code-review'].technical_fix_cycles, cycle);
    assert.equal(state.pipelines.app.stages['code-review'].technical_fix_limit, 5);
    for (const [command, stage] of [['start', 'implementation'], ['complete', 'implementation'], ['start', 'code-review']]) {
      const next = run(fx.root, [command, fx.runId, stage, '--pipeline', 'app', '--state-root', fx.stateRoot]);
      assert.equal(next.status, 0, next.stderr);
    }
  }
}
async function recordNoChangeReview(fx) {
  const file = path.join(fx.stateRoot, fx.runId, `architecture-${Date.now()}.json`);
  await writeFile(file, JSON.stringify({ kind: 'architecture_review', run_id: fx.runId, pipeline_id: 'app', stage: 'code-review',
    result: 'no_change', summary: 'design holds; repeat findings were local' }));
  const result = run(fx.root, ['architecture-review-record', fx.runId, 'code-review', '--pipeline', 'app', '--evidence', file, '--state-root', fx.stateRoot]);
  assert.equal(result.status, 0, result.stderr);
}
async function writeReview(fx, name, review) {
  const file = path.join(fx.stateRoot, fx.runId, name);
  await writeFile(file, JSON.stringify({ status: 'needs_revision', ...review }, null, 2) + '\n');
  return file;
}
function reviewBase(fx, status) {
  return {
    kind: 'runtime_replan',
    status,
    pipeline_id: 'app',
    stage: 'code-review',
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
    'scope-check', fx.runId, 'code-review', 'packages/db/src/change.ts',
    '--pipeline', 'app', '--state-root', fx.stateRoot,
  ]);
  assert.equal(result.status, 0, result.stderr);
  result = run(fx.root, [
    'fix-cycle', fx.runId, 'code-review', '--pipeline', 'app', '--state-root', fx.stateRoot,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TECHNICAL_FIX_LIMIT_EXCEEDED/);
  assert.match(result.stderr, /owner may grant \+N cycles or request runtime replan/);

  result = run(fx.root, [
    'fix-budget-add', fx.runId, 'code-review',
    '--pipeline', 'app', '--cycles', '3', '--state-root', fx.stateRoot, '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  let state = JSON.parse(result.stdout);
  let runtime = state.pipelines.app.stages['code-review'];
  assert.equal(runtime.technical_fix_cycles, 5);
  assert.equal(runtime.technical_fix_limit, 8);
  assert.deepEqual(runtime.technical_fix_budget_grants[0], {
    timestamp: runtime.technical_fix_budget_grants[0].timestamp,
    source: 'owner_direct',
    added_cycles: 3,
    previous_limit: 5,
    new_limit: 8,
  });
  await recordNoChangeReview(fx);

  result = run(fx.root, [
    'scope-check', fx.runId, 'code-review', 'packages/db/src/change.ts',
    '--pipeline', 'app', '--state-root', fx.stateRoot,
  ]);
  assert.equal(result.status, 0, result.stderr);
  result = run(fx.root, [
    'fix-cycle', fx.runId, 'code-review',
    '--pipeline', 'app', '--state-root', fx.stateRoot, '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  state = JSON.parse(result.stdout);
  runtime = state.pipelines.app.stages['code-review'];
  assert.equal(runtime.technical_fix_cycles, 6);
  assert.equal(runtime.technical_fix_limit, 8);
  assert.match(runtime.message, /cycle 6\/8/);
});

test('owner can increase the fix budget before exhaustion', async () => {
  const fx = await fixture('budget-not-exhausted');
  const result = run(fx.root, [
    'fix-budget-add', fx.runId, 'code-review',
    '--pipeline', 'app', '--cycles', '4', '--state-root', fx.stateRoot, '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(result.stdout);
  const runtime = state.pipelines.app.stages['code-review'];
  assert.equal(runtime.technical_fix_cycles ?? 0, 0);
  assert.equal(runtime.technical_fix_limit, 9);
  assert.equal(runtime.technical_fix_budget_grants[0].source, 'owner_direct');
  assert.equal(runtime.technical_fix_budget_grants[0].added_cycles, 4);
  assert.equal(runtime.technical_fix_budget_grants[0].previous_limit, 5);
  assert.equal(runtime.technical_fix_budget_grants[0].new_limit, 9);
});

test('RUN-level fix-budget-set raises only repair-stage ceilings and never lowers them', async () => {
  const fx = await fixture('budget-run-override');

  let result = run(fx.root, [
    'fix-budget-set', fx.runId, '--cycles', '12', '--state-root', fx.stateRoot, '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  let state = JSON.parse(result.stdout);
  assert.equal(state.pipelines.app.stages.implementation.technical_fix_limit, undefined);
  assert.equal(state.pipelines.app.stages.implementation.technical_fix_budget_grants, undefined);
  let runtime = state.pipelines.app.stages['code-review'];
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
  runtime = state.pipelines.app.stages['code-review'];
  assert.equal(runtime.technical_fix_limit, 12);
  assert.equal(runtime.technical_fix_budget_grants.length, 1);
});

test('automatic repair budget has a hard ceiling of 20', async () => {
  const fx = await fixture('budget-max-ceiling');

  let result = run(fx.root, [
    'fix-budget-set', fx.runId, '--cycles', '20', '--state-root', fx.stateRoot, '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);

  result = run(fx.root, [
    'fix-budget-add', fx.runId, 'code-review',
    '--pipeline', 'app', '--cycles', '1', '--state-root', fx.stateRoot,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TECHNICAL_FIX_LIMIT_MAX/);
});

test('bounded security_fix requires deterministic evidence and consumes the shared fix budget', async () => {
  const fx = await fixture('security-fix-cycle');
  const evidence = await writeReview(fx, 'security-fix-app-code-review-1.json', {
    kind: 'security_fix',
    pipeline_id: 'app',
    stage: 'code-review',
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
    'security-fix-check', fx.runId, 'code-review',
    '--pipeline', 'app', '--evidence', evidence, '--state-root', fx.stateRoot, '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  let state = JSON.parse(result.stdout);
  assert.equal(state.security_fix_preflight.pipeline_id, 'app');

  // A scope without the security path cannot close the security finding.
  result = run(fx.root, [
    'scope-check', fx.runId, 'code-review', 'packages/db/src/other.ts',
    '--pipeline', 'app', '--state-root', fx.stateRoot,
  ]);
  assert.equal(result.status, 0, result.stderr);
  result = run(fx.root, [
    'fix-cycle', fx.runId, 'code-review', '--repair-class', 'security_fix',
    '--pipeline', 'app', '--state-root', fx.stateRoot,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SECURITY_FIX_PREFLIGHT_REQUIRED/);

  // Security and technical findings of one review share one cycle and one scope.
  result = run(fx.root, [
    'scope-check', fx.runId, 'code-review', 'packages/db/src/change.ts', 'packages/db/src/other.ts',
    '--pipeline', 'app', '--state-root', fx.stateRoot,
  ]);
  assert.equal(result.status, 0, result.stderr);

  result = run(fx.root, [
    'fix-cycle', fx.runId, 'code-review',
    '--pipeline', 'app', '--state-root', fx.stateRoot,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SECURITY_FIX_REPAIR_CLASS_REQUIRED/);

  result = run(fx.root, [
    'fix-cycle', fx.runId, 'code-review', '--repair-class', 'security_fix',
    '--pipeline', 'app', '--state-root', fx.stateRoot, '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  state = JSON.parse(result.stdout);
  assert.equal(state.pipelines.app.stages['code-review'].technical_fix_cycles, 1);
  assert.equal(state.pipelines.app.stages['code-review'].technical_fix_limit, 5);
  assert.match(state.pipelines.app.stages['code-review'].message, /security_fix cycle 1\/5/);
  assert.deepEqual(state.pipelines.app.stages['code-review'].repair_paths, ['packages/db/src/change.ts', 'packages/db/src/other.ts']);
  assert.equal(state.security_fix_preflight, undefined);
});

test('security_fix authorization rejects privilege expansion and owner decisions', async () => {
  const fx = await fixture('security-fix-stop');
  const evidence = await writeReview(fx, 'security-fix-app-code-review-stop.json', {
    kind: 'security_fix',
    pipeline_id: 'app',
    stage: 'code-review',
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
    'security-fix-check', fx.runId, 'code-review',
    '--pipeline', 'app', '--evidence', evidence, '--state-root', fx.stateRoot,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SECURITY_FIX_OWNER_STOP_REQUIRED/);
});

test('runtime replan clarification can start before exhaustion but does not grant cycles', async () => {
  const fx = await fixture('runtime-replan-clarification');
  const evidence = await writeReview(fx, 'runtime-replan-app-code-review-1.json', {
    ...reviewBase(fx, 'needs_owner_clarification'),
    owner_questions: ['Use approach A or B for this block?'],
  });

  let result = run(fx.root, [
    'runtime-replan-propose', fx.runId, 'code-review',
    '--pipeline', 'app', '--evidence', evidence, '--state-root', fx.stateRoot, '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  let state = JSON.parse(result.stdout);
  let runtime = state.pipelines.app.stages['code-review'];
  assert.equal(runtime.technical_fix_limit, 5);
  assert.equal(runtime.runtime_replans[0].status, 'awaiting_owner_clarification');
  assert.deepEqual(runtime.runtime_replans[0].owner_questions, ['Use approach A or B for this block?']);

  result = run(fx.root, [
    'runtime-replan-approve', fx.runId, 'code-review',
    '--pipeline', 'app', '--cycles', '3', '--state-root', fx.stateRoot,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OWNER_CLARIFICATION_REQUIRED/);

  result = run(fx.root, [
    'fix-budget-add', fx.runId, 'code-review',
    '--pipeline', 'app', '--cycles', '3', '--state-root', fx.stateRoot,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RUNTIME_REPLAN_PENDING/);
});

test('runtime replan approval can add cycles before exhaustion (5/6 -> 5/10)', async () => {
  const fx = await fixture('runtime-replan-approve');
  await exhaustFive(fx);

  let result = run(fx.root, [
    'fix-budget-add', fx.runId, 'code-review',
    '--pipeline', 'app', '--cycles', '1', '--state-root', fx.stateRoot, '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);

  const first = await writeReview(fx, 'runtime-replan-app-code-review-1.json', {
    ...reviewBase(fx, 'needs_owner_clarification'),
    owner_questions: ['Confirm whether the block may replace the internal helper.'],
  });
  result = run(fx.root, [
    'runtime-replan-propose', fx.runId, 'code-review',
    '--pipeline', 'app', '--evidence', first, '--state-root', fx.stateRoot,
  ]);
  assert.equal(result.status, 0, result.stderr);

  const second = await writeReview(fx, 'runtime-replan-app-code-review-2.json', {
    ...reviewBase(fx, 'ready_for_owner_approval'),
    summary: 'Use the reviewed replacement helper and keep all frozen behavior unchanged.',
  });
  result = run(fx.root, [
    'runtime-replan-propose', fx.runId, 'code-review',
    '--pipeline', 'app', '--evidence', second, '--state-root', fx.stateRoot, '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  let state = JSON.parse(result.stdout);
  let runtime = state.pipelines.app.stages['code-review'];
  assert.equal(runtime.technical_fix_cycles, 5);
  assert.equal(runtime.technical_fix_limit, 6);
  assert.equal(runtime.runtime_replans.length, 2);
  assert.equal(runtime.runtime_replans[0].status, 'superseded');
  assert.equal(runtime.runtime_replans[1].status, 'awaiting_owner_approval');
  assert.equal(state.scope_preflight, undefined);

  result = run(fx.root, [
    'runtime-replan-approve', fx.runId, 'code-review',
    '--pipeline', 'app', '--cycles', '4', '--state-root', fx.stateRoot, '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  state = JSON.parse(result.stdout);
  runtime = state.pipelines.app.stages['code-review'];
  assert.equal(runtime.technical_fix_cycles, 5);
  assert.equal(runtime.technical_fix_limit, 10);
  assert.equal(runtime.runtime_replans[1].status, 'approved');
  assert.equal(runtime.runtime_replans[1].granted_cycles, 4);
  assert.equal(runtime.technical_fix_budget_grants[0].source, 'owner_direct');
  assert.equal(runtime.technical_fix_budget_grants[1].source, 'runtime_replan');
  assert.equal(runtime.technical_fix_budget_grants[1].runtime_replan_revision, 2);
  await recordNoChangeReview(fx);

  result = run(fx.root, [
    'scope-check', fx.runId, 'code-review', 'packages/db/src/change.ts',
    '--pipeline', 'app', '--state-root', fx.stateRoot,
  ]);
  assert.equal(result.status, 0, result.stderr);
  result = run(fx.root, [
    'fix-cycle', fx.runId, 'code-review',
    '--pipeline', 'app', '--state-root', fx.stateRoot, '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  state = JSON.parse(result.stdout);
  assert.equal(state.pipelines.app.stages['code-review'].technical_fix_cycles, 6);
  assert.equal(state.pipelines.app.stages['code-review'].technical_fix_limit, 10);
});

test('runtime replan cannot cross frozen PLAN boundaries', async () => {
  const fx = await fixture('runtime-replan-full-plan');
  await exhaustFive(fx);
  const evidence = await writeReview(fx, 'runtime-replan-app-code-review-1.json', {
    ...reviewBase(fx, 'ready_for_owner_approval'),
    acceptance_criteria_changed: true,
  });

  const result = run(fx.root, [
    'runtime-replan-propose', fx.runId, 'code-review',
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
    'runtime-replan-propose', fx.runId, 'code-review',
    '--pipeline', 'app', '--evidence', outside, '--state-root', fx.stateRoot,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must live inside the current run directory/);
});

test('missing or positive review results never spend budget and free dispatch remains possible', async () => {
  const fx = await fixture('negative-result-only');
  const raw = args => spawnSync('npx', ['--yes', 'tsx', STAGE_CLI, ...args, '--pipeline', 'app', '--state-root', fx.stateRoot], { cwd: fx.root, encoding: 'utf8', env: process.env });
  let result = raw(['fix-cycle', fx.runId, 'code-review']);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /REPAIR_RESULT_REQUIRED/);
  const evidence = await writeReview(fx, 'positive.json', { status: 'PASS' });
  result = raw(['fix-cycle', fx.runId, 'code-review', '--evidence', evidence]);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /REPAIR_RESULT_REQUIRED/);
  const state = JSON.parse(await readFile(path.join(fx.stateRoot, fx.runId, 'state.json'), 'utf8'));
  assert.equal(state.pipelines.app.stages['code-review'].technical_fix_cycles ?? 0, 0);
  assert.equal(state.pipelines.app.stages['code-review'].status, 'in_progress');
});

test('live PASS followed by bounded review findings reopens completed implementation without owner amendment', async () => {
  const fx = await fixture('live-pass-review-repair');
  const cli = args => run(fx.root, [...args, '--pipeline', 'app', '--state-root', fx.stateRoot]);
  const review = await writeReview(fx, 'review-pass4.json', { status: 'technical_fix', live_pg: 'PASS', owner_decision_required: false,
    findings: ['N3 lock order', 'R13 deadline', 'R10/R9 production barriers', 'R5 fairness'] });
  let result = cli(['scope-check', fx.runId, 'code-review', 'packages/db/src/change.ts']);
  assert.equal(result.status, 0, result.stderr);
  result = cli(['fix-cycle', fx.runId, 'code-review', '--evidence', review, '--json']);
  assert.equal(result.status, 0, result.stderr);
  let state = JSON.parse(result.stdout);
  assert.equal(state.pipelines.app.stages.implementation.status, 'pending');
  assert.equal(state.pipelines.app.stages.implementation.technical_fix_limit, undefined);
  assert.equal(state.pipelines.app.stages['code-review'].technical_fix_cycles, 1);
  assert.equal(state.owner_amendments?.length ?? 0, 0);
  result = cli(['start', fx.runId, 'implementation']); assert.equal(result.status, 0, result.stderr);
  result = cli(['fix-budget-add', fx.runId, 'implementation', '--cycles', '5']);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /REPAIR_BUDGET_NOT_APPLICABLE/);
  result = cli(['status', fx.runId]); assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.split('\n').find(line => line.includes('implementation:'));
  assert.ok(!line.includes('fix_budget')); assert.match(line, /repair_from=code-review/);
});

// ---- architecture checkpoint (B2.1) and cross-lane repair (B2.2) ----

const sh = (root, args) => run(root, args);
async function lanesFixture(runId, { sinkScope = ['packages/sink/**'], laneScope = ['packages/lane/**'], laneExtra = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stage-cli-lanes-'));
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
  const scopes = { lane: laneScope, sink: sinkScope, other: ['packages/other/**'] };
  const workItems = [];
  for (const id of ['lane', 'sink', 'other']) {
    const artifact = await frozen(root, `work-items/wi-${id}.json`, JSON.stringify({ id: `wi-${id}`, pipeline_id: id, allowed_change_paths: scopes[id] }));
    workItems.push({ id: `wi-${id}`, pipeline_id: id, ...artifact });
  }
  const gated = ['implementation', 'code-review'];
  const executors = { implementation: 'agent', 'code-review': 'review' };
  const pipeline = (id, extra = {}) => ({ id, deployable: false, stages: gated, executors, work_items: [`wi-${id}`],
    decision_ids: [], research_ids: [], contract_ids: [], ...extra });
  const manifest = {
    schema_version: 2, run_id: runId, rules_file: 'docs/pipeline-rules.md', rules_version: 2, planning_mode: 'design-freeze',
    planning_readiness: { design_freeze: true, required_gates: ['architecture'],
      gates: { architecture: { required: true, status: 'ready', cycles: 1, artifact: architecture, review, blocking_decision_ids: [] } },
      required_artifacts: requiredArtifacts },
    open_decisions: [], allowed_change_paths: ['packages/**'], gate_profiles: {},
    pipelines: [
      pipeline('lane', { ready_after_stage: 'code-review', ...laneExtra }),
      pipeline('sink', { depends_on: ['lane'] }),
      pipeline('other', { stages: ['implementation'], executors: { implementation: 'agent' } }),
    ],
    work_items: workItems,
  };
  const manifestPath = path.join(root, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const cli = (...args) => sh(root, [...args, '--state-root', stateRoot]);
  let result = cli('init', manifestPath, '--json'); assert.equal(result.status, 0, result.stderr);
  result = cli('approve', runId, '--json'); assert.equal(result.status, 0, result.stderr);
  let seq = 0;
  const fx = {
    root, stateRoot, runId, cli,
    step(pipeline, stage, command) {
      const r = cli(command, runId, stage, '--pipeline', pipeline, '--json'); assert.equal(r.status, 0, `${pipeline}/${stage} ${command}: ${r.stderr}`); return JSON.parse(r.stdout);
    },
    finish(pipeline, stage) { this.step(pipeline, stage, 'start'); return this.step(pipeline, stage, 'complete'); },
    async evidence(pipeline, stage = 'code-review') {
      const file = path.join(root, `negative-${++seq}.json`);
      await writeFile(file, JSON.stringify({ status: 'needs_revision', run_id: runId, pipeline_id: pipeline, stage, result_id: seq }));
      return file;
    },
    next() { const r = cli('next', runId, '--json'); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout).runnable.map(i => `${i.pipeline_id}/${i.stage}`).sort(); },
    status() { const r = cli('status', runId, '--json'); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); },
    async fixCycle(pipeline, scopePaths, extra = []) {
      let r = cli('scope-check', runId, 'code-review', ...scopePaths, '--pipeline', pipeline); assert.equal(r.status, 0, r.stderr);
      return cli('fix-cycle', runId, 'code-review', '--pipeline', pipeline, '--evidence', await this.evidence(pipeline), '--json', ...extra);
    },
  };
  return fx;
}

test('the 5th charged cycle flags an architecture checkpoint; the next cycle needs a recorded review', async () => {
  const fx = await lanesFixture('arch-checkpoint');
  fx.finish('lane', 'implementation');
  fx.step('lane', 'code-review', 'start');
  for (let cycle = 1; cycle <= 5; cycle += 1) {
    const result = await fx.fixCycle('lane', ['packages/lane/src/a.ts']);
    assert.equal(result.status, 0, result.stderr);
    const runtime = JSON.parse(result.stdout).pipelines.lane.stages['code-review'];
    assert.equal(runtime.technical_fix_cycles, cycle);
    assert.equal(runtime.architecture_review_due === true, cycle === 5);
    if (cycle < 5) fx.finish('lane', 'implementation'), fx.step('lane', 'code-review', 'start');
  }
  assert.equal(fx.status().pipelines.lane.stages['code-review'].architecture_review_due, true);
  assert.match(fx.cli('status', fx.runId).stdout, /architecture_review_due=true/);
  // Exhausted budget keeps its own error; after an owner grant the checkpoint gates the next cycle.
  fx.finish('lane', 'implementation'); fx.step('lane', 'code-review', 'start');
  let result = await fx.fixCycle('lane', ['packages/lane/src/a.ts']);
  assert.match(result.stderr, /TECHNICAL_FIX_LIMIT_EXCEEDED/);
  result = fx.cli('fix-budget-add', fx.runId, 'code-review', '--pipeline', 'lane', '--cycles', '5'); assert.equal(result.status, 0, result.stderr);
  result = await fx.fixCycle('lane', ['packages/lane/src/a.ts']);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /ARCHITECTURE_REVIEW_REQUIRED: lane\/code-review/);

  const record = async (patch) => {
    const file = path.join(fx.stateRoot, fx.runId, `arch-${Math.random().toString(36).slice(2)}.json`);
    await writeFile(file, JSON.stringify({ kind: 'architecture_review', run_id: fx.runId, pipeline_id: 'lane', stage: 'code-review',
      result: 'apply_within_requirements', summary: 'extract the shared helper', requirements_changed: false, acceptance_criteria_changed: false,
      external_contract_changed: false, security_boundary_changed: false, destructive_change: false, ...patch }));
    return fx.cli('architecture-review-record', fx.runId, 'code-review', '--pipeline', 'lane', '--evidence', file, '--json');
  };
  result = await record({ external_contract_changed: true }); assert.match(result.stderr, /ARCHITECTURE_REVIEW_INVALID/);
  result = await record({ summary: ' ' }); assert.match(result.stderr, /ARCHITECTURE_REVIEW_INVALID/);
  result = await record({ result: 'maybe' }); assert.match(result.stderr, /ARCHITECTURE_REVIEW_INVALID/);
  result = await record({ stage: 'implementation' }); assert.match(result.stderr, /ARCHITECTURE_REVIEW_INVALID/);
  result = await record({}); assert.equal(result.status, 0, result.stderr);
  const runtime = JSON.parse(result.stdout).pipelines.lane.stages['code-review'];
  assert.equal(runtime.architecture_review_due, false);
  assert.equal(runtime.architecture_reviews.length, 1);
  assert.equal(runtime.architecture_reviews[0].result, 'apply_within_requirements');
  assert.match(runtime.architecture_reviews[0].sha256, /^[0-9a-f]{64}$/);
  result = await record({}); assert.match(result.stderr, /ARCHITECTURE_REVIEW_NOT_DUE/);
  result = await fx.fixCycle('lane', ['packages/lane/src/a.ts']); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).pipelines.lane.stages['code-review'].technical_fix_cycles, 6);
});

test('a defect class repeated by consecutive reviews needs a class review; a recurrence after the rework needs new research, not the owner', async () => {
  const fx = await lanesFixture('class-recurrence');
  const again = () => { fx.finish('lane', 'implementation'); fx.step('lane', 'code-review', 'start'); };
  const runtime = () => fx.status().pipelines.lane.stages['code-review'];
  fx.finish('lane', 'implementation');
  fx.step('lane', 'code-review', 'start');
  let result = await fx.fixCycle('lane', ['packages/lane/src/a.ts'], ['--defect-class', 'Bad Class!']);
  assert.match(result.stderr, /DEFECT_CLASS_INVALID/);
  // Classes also come from the review JSON itself.
  let r = fx.cli('scope-check', fx.runId, 'code-review', 'packages/lane/src/a.ts', '--pipeline', 'lane'); assert.equal(r.status, 0, r.stderr);
  const reviewFile = path.join(fx.root, 'review-with-classes.json');
  await writeFile(reviewFile, JSON.stringify({ status: 'needs_revision', run_id: fx.runId, pipeline_id: 'lane', stage: 'code-review',
    findings: [{ id: 'R1', defect_class: 'validator-laxer-than-consumer' }] }));
  result = fx.cli('fix-cycle', fx.runId, 'code-review', '--pipeline', 'lane', '--evidence', reviewFile, '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(runtime().defect_class_history.map((item) => item.classes), [['validator-laxer-than-consumer']]);

  again();
  result = await fx.fixCycle('lane', ['packages/lane/src/a.ts'], ['--defect-class', 'validator-laxer-than-consumer,readme-drift']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CLASS_REVIEW_REQUIRED: lane\/code-review classes=validator-laxer-than-consumer recurred/);
  assert.equal(runtime().technical_fix_cycles, 1);
  assert.deepEqual(runtime().class_review_due, ['validator-laxer-than-consumer']);
  assert.match(fx.cli('status', fx.runId).stdout, /class_review_due=validator-laxer-than-consumer/);
  result = await fx.fixCycle('lane', ['packages/lane/src/a.ts'], ['--defect-class', 'readme-drift']);
  assert.match(result.stderr, /CLASS_REVIEW_REQUIRED/);

  const runDir = path.join(fx.stateRoot, fx.runId);
  await writeFile(path.join(runDir, 'research.md'), '# prior art\nByte comparison instead of a second HTML reader.\n');
  await writeFile(path.join(runDir, 'class-review-tech.md'), 'status: ready\n');
  const record = async (patch) => {
    const file = path.join(runDir, `class-${Math.random().toString(36).slice(2)}.json`);
    await writeFile(file, JSON.stringify({ kind: 'class_review', run_id: fx.runId, pipeline_id: 'lane', stage: 'code-review',
      classes: ['validator-laxer-than-consumer'], approach: 'rework_block', summary: 'compare served bytes with the built artifact',
      research_artifact: path.join(runDir, 'research.md'), technical_review_artifact: path.join(runDir, 'class-review-tech.md'),
      requirements_changed: false, acceptance_criteria_changed: false, external_contract_changed: false,
      security_boundary_changed: false, destructive_change: false, ...patch }));
    return fx.cli('class-review-record', fx.runId, 'code-review', '--pipeline', 'lane', '--evidence', file, '--json');
  };
  result = await record({ research_artifact: path.join(runDir, 'missing.md') }); assert.match(result.stderr, /CLASS_REVIEW_INVALID: research_artifact/);
  result = await record({ technical_review_artifact: undefined }); assert.match(result.stderr, /CLASS_REVIEW_INVALID: technical_review_artifact/);
  result = await record({ classes: ['readme-drift'] }); assert.match(result.stderr, /CLASS_REVIEW_INVALID: classes must cover validator-laxer-than-consumer/);
  result = await record({ approach: 'patch_again' }); assert.match(result.stderr, /CLASS_REVIEW_INVALID: approach/);
  result = await record({ destructive_change: true }); assert.match(result.stderr, /CLASS_REVIEW_INVALID/);
  result = await record({}); assert.equal(result.status, 0, result.stderr);
  assert.equal(runtime().class_review_due, undefined);
  assert.equal(runtime().class_reviews[0].after_cycle, 1);
  result = await record({}); assert.match(result.stderr, /CLASS_REVIEW_NOT_DUE/);

  // One consolidated rework cycle is charged for the reviewed class.
  result = await fx.fixCycle('lane', ['packages/lane/src/a.ts'], ['--defect-class', 'validator-laxer-than-consumer']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(runtime().technical_fix_cycles, 2);

  // The same class after its rework needs a new review with new research and a changed approach; nobody waits for the owner.
  again();
  result = await fx.fixCycle('lane', ['packages/lane/src/a.ts'], ['--defect-class', 'validator-laxer-than-consumer']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CLASS_REVIEW_REQUIRED: lane\/code-review classes=validator-laxer-than-consumer recurred after rework/);
  assert.equal(runtime().status, 'in_progress');
  assert.equal(runtime().technical_fix_cycles, 2);
  result = await record({}); assert.match(result.stderr, /new research_artifact required/);
  await writeFile(path.join(runDir, 'research-2.md'), '# prior art 2\nUse the producer output as the oracle.\n');
  result = await record({ research_artifact: path.join(runDir, 'research-2.md') }); assert.match(result.stderr, /approach summary must change/);
  result = await record({ research_artifact: path.join(runDir, 'research-2.md'), approach: 'remove_mechanism',
    summary: 'drop the second reader; serve the built artifact as is' });
  assert.equal(result.status, 0, result.stderr);
  result = await fx.fixCycle('lane', ['packages/lane/src/a.ts'], ['--defect-class', 'validator-laxer-than-consumer']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(runtime().technical_fix_cycles, 3);
  assert.deepEqual(fx.next(), ['lane/implementation', 'other/implementation']);
});

test('a class review satisfies a pending architecture checkpoint; unrelated classes keep the plain loop', async () => {
  const fx = await lanesFixture('class-and-checkpoint');
  fx.finish('lane', 'implementation');
  fx.step('lane', 'code-review', 'start');
  for (let cycle = 1; cycle <= 4; cycle += 1) {
    const result = await fx.fixCycle('lane', ['packages/lane/src/a.ts'], ['--defect-class', `class-${cycle}`]);
    assert.equal(result.status, 0, result.stderr);
    fx.finish('lane', 'implementation'); fx.step('lane', 'code-review', 'start');
  }
  let result = await fx.fixCycle('lane', ['packages/lane/src/a.ts'], ['--defect-class', 'class-4']);
  assert.match(result.stderr, /CLASS_REVIEW_REQUIRED/);
  const runDir = path.join(fx.stateRoot, fx.runId);
  await writeFile(path.join(runDir, 'research.md'), 'evidence\n');
  await writeFile(path.join(runDir, 'tech.md'), 'status: ready\n');
  const contractPath = path.join(fx.root, 'reviewed-contract.json');
  const contractContent = '{"api":"v1"}\n';
  await writeFile(contractPath, contractContent);
  const file = path.join(runDir, 'class.json');
  await writeFile(file, JSON.stringify({ kind: 'class_review', run_id: fx.runId, pipeline_id: 'lane', stage: 'code-review',
    classes: ['class-4'], approach: 'remove_mechanism', summary: 'use the standard format; delete the converter',
    covered_paths: ['packages/lane/src/a.ts'],
    dependency_files: [{ path: 'reviewed-contract.json', sha256: createHash('sha256').update(contractContent).digest('hex') }],
    research_artifact: 'research.md', technical_review_artifact: path.join(runDir, 'tech.md'),
    requirements_changed: false, acceptance_criteria_changed: false, external_contract_changed: false,
    security_boundary_changed: false, destructive_change: false }));
  result = fx.cli('class-review-record', fx.runId, 'code-review', '--pipeline', 'lane', '--evidence', file, '--json');
  assert.match(result.stderr, /research_artifact must live inside the current run directory/);
  await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), research_artifact: path.join(runDir, 'research.md') }));
  result = fx.cli('class-review-record', fx.runId, 'code-review', '--pipeline', 'lane', '--evidence', file, '--json');
  assert.equal(result.status, 0, result.stderr);
  result = await fx.fixCycle('lane', ['packages/lane/src/a.ts'], ['--defect-class', 'class-4']);
  assert.equal(result.status, 0, result.stderr);
  const runtime = JSON.parse(result.stdout).pipelines.lane.stages['code-review'];
  assert.equal(runtime.technical_fix_cycles, 5);
  // The class review at cycle 4 covers this block; cycle 5 is NOT another checkpoint.
  assert.equal(runtime.architecture_review_due, false);
  result = fx.cli('fix-budget-add', fx.runId, 'code-review', '--pipeline', 'lane', '--cycles', '5');
  assert.equal(result.status, 0, result.stderr);
  for (let cycle = 6; cycle <= 9; cycle += 1) {
    fx.finish('lane', 'implementation'); fx.step('lane', 'code-review', 'start');
    result = await fx.fixCycle('lane', ['packages/lane/src/a.ts'], ['--defect-class', 'class-new-' + cycle]);
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(fx.status().pipelines.lane.stages['code-review'].architecture_review_due, true,
    'next checkpoint is five charged cycles after the class review, not absolute 5/10');
  fx.finish('lane', 'implementation'); fx.step('lane', 'code-review', 'start');
  result = await fx.fixCycle('lane', ['packages/lane/src/a.ts'], ['--defect-class', 'class-next']);
  assert.match(result.stderr, /ARCHITECTURE_REVIEW_REQUIRED: lane\/code-review/);
});

test('architecture requirements_change blocks only that lane; other pipelines stay runnable and the owner path resumes it', async () => {
  const fx = await lanesFixture('arch-requirements-change');
  fx.finish('lane', 'implementation');
  fx.step('lane', 'code-review', 'start');
  for (let cycle = 1; cycle <= 5; cycle += 1) {
    const result = await fx.fixCycle('lane', ['packages/lane/src/a.ts']); assert.equal(result.status, 0, result.stderr);
    if (cycle < 5) fx.finish('lane', 'implementation'), fx.step('lane', 'code-review', 'start');
  }
  const file = path.join(fx.stateRoot, fx.runId, 'arch-rc.json');
  await writeFile(file, JSON.stringify({ kind: 'architecture_review', run_id: fx.runId, pipeline_id: 'lane', stage: 'code-review',
    result: 'requirements_change', summary: 'the acceptance criteria cannot be met with this design' }));
  let result = fx.cli('architecture-review-record', fx.runId, 'code-review', '--pipeline', 'lane', '--evidence', file, '--json');
  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(result.stdout);
  assert.equal(state.pipelines.lane.stages['code-review'].status, 'blocked');
  assert.equal(state.pipelines.lane.stages['code-review'].message, 'ARCHITECTURE_REQUIREMENTS_CHANGE: owner decision; other lanes continue');
  assert.equal(state.pipelines.lane.status, 'blocked');
  assert.equal(state.pipelines.other.status, 'approved');
  assert.deepEqual(fx.next(), ['other/implementation']);

  const replan = path.join(fx.stateRoot, fx.runId, 'replan.json');
  await writeFile(replan, JSON.stringify({ kind: 'runtime_replan', status: 'ready_for_owner_approval', pipeline_id: 'lane', stage: 'code-review',
    summary: 'owner decided the new criteria', owner_questions: [], requirements_changed: false, acceptance_criteria_changed: false,
    external_contract_changed: false, security_boundary_changed: false, destructive_change: false }));
  result = fx.cli('runtime-replan-propose', fx.runId, 'code-review', '--pipeline', 'lane', '--evidence', replan, '--json'); assert.equal(result.status, 0, result.stderr);
  result = fx.cli('runtime-replan-approve', fx.runId, 'code-review', '--pipeline', 'lane', '--cycles', '2', '--json'); assert.equal(result.status, 0, result.stderr);
  const resumed = JSON.parse(result.stdout);
  assert.equal(resumed.pipelines.lane.stages['code-review'].status, 'pending');
  assert.equal(resumed.pipelines.lane.status, 'approved');
  assert.deepEqual(fx.next(), ['lane/implementation', 'other/implementation']);
});

test('cross-lane fix-cycle reopens the upstream lane, charges the sink gate and the sink waits for the lane milestone', async () => {
  const fx = await lanesFixture('cross-lane');
  fx.finish('lane', 'implementation'); fx.finish('lane', 'code-review');
  fx.finish('sink', 'implementation'); fx.step('sink', 'code-review', 'start');
  assert.deepEqual(fx.next(), ['other/implementation']);

  // Ownership and topology are checked before any state change.
  let result = await fx.fixCycle('sink', ['packages/lane/src/a.ts'], ['--repair-pipeline', 'other']);
  assert.match(result.stderr, /CROSS_LANE_NOT_UPSTREAM/);
  result = await fx.fixCycle('sink', ['packages/lane/src/a.ts'], ['--repair-pipeline', 'sink']);
  assert.match(result.stderr, /CROSS_LANE_NOT_UPSTREAM/);
  result = await fx.fixCycle('sink', ['packages/sink/src/own.ts'], ['--repair-pipeline', 'lane']);
  assert.match(result.stderr, /CROSS_LANE_OWNER_AMBIGUOUS/);
  result = await fx.fixCycle('sink', ['packages/lane/src/a.ts', 'packages/sink/src/own.ts'], ['--repair-pipeline', 'lane']);
  assert.match(result.stderr, /CROSS_LANE_OWNER_AMBIGUOUS/);
  assert.equal(fx.status().pipelines.sink.stages['code-review'].technical_fix_cycles ?? 0, 0);
  assert.equal(fx.status().pipelines.lane.status, 'completed');

  result = await fx.fixCycle('sink', ['packages/lane/src/a.ts'], ['--repair-pipeline', 'lane']);
  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(result.stdout);
  const sink = state.pipelines.sink.stages; const lane = state.pipelines.lane.stages;
  assert.equal(sink['code-review'].technical_fix_cycles, 1);
  assert.equal(sink.implementation.repair_origin_stage, 'code-review');
  assert.equal(sink.implementation.repair_origin_pipeline, undefined);
  assert.equal(lane.implementation.status, 'pending');
  assert.equal(lane.implementation.repair_origin_stage, 'code-review');
  assert.equal(lane.implementation.repair_origin_pipeline, 'sink');
  assert.equal(lane['code-review'].status, 'pending');
  assert.equal(state.pipelines.lane.status, 'approved');
  assert.match(fx.cli('status', fx.runId).stdout, /repair_from=sink\/code-review/);
  // The sink must wait: only the lane (and the unrelated pipeline) are runnable.
  assert.deepEqual(fx.next(), ['lane/implementation', 'other/implementation']);

  // The lane agent borrows the sink gate's evidence, paths and loop number.
  const packet = run(fx.root, ['dispatch', fx.runId, '--pipeline', 'lane', '--stage', 'implementation', '--work-item', 'wi-lane', '--role', 'CoderAgent']);
  assert.equal(packet.status, 0, packet.stderr);
  const dispatched = JSON.parse(packet.stdout);
  assert.equal(dispatched.loop, 1);
  assert.equal(dispatched.repair_origin_stage, 'code-review');
  assert.equal(dispatched.repair_origin_pipeline, 'sink');
  assert.deepEqual(dispatched.repair_paths, ['packages/lane/src/a.ts']);
  assert.ok(dispatched.evidence_paths.some(file => file.endsWith('negative-5.json')), dispatched.evidence_paths.join(','));

  fx.finish('lane', 'implementation');
  assert.deepEqual(fx.next(), ['lane/code-review', 'other/implementation']);
  fx.finish('lane', 'code-review');
  assert.deepEqual(fx.next(), ['other/implementation', 'sink/implementation']);
  // Same-pipeline fix-cycle without the flag is unchanged.
  fx.finish('sink', 'implementation'); fx.step('sink', 'code-review', 'start');
  result = await fx.fixCycle('sink', ['packages/sink/src/own.ts']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).pipelines.sink.stages['code-review'].technical_fix_cycles, 2);
  assert.equal(fx.status().pipelines.lane.status, 'completed');
});

test('cross-lane ownership is ambiguous when another pipeline also declares the path or the lane declares nothing', async () => {
  const shared = await lanesFixture('cross-lane-shared', { sinkScope: ['packages/lane/src/**'] });
  shared.finish('lane', 'implementation'); shared.finish('lane', 'code-review');
  shared.finish('sink', 'implementation'); shared.step('sink', 'code-review', 'start');
  let result = await shared.fixCycle('sink', ['packages/lane/src/a.ts'], ['--repair-pipeline', 'lane']);
  assert.match(result.stderr, /CROSS_LANE_OWNER_AMBIGUOUS/);
  const none = await lanesFixture('cross-lane-none', { laneScope: [] });
  none.finish('lane', 'implementation'); none.finish('lane', 'code-review');
  none.finish('sink', 'implementation'); none.step('sink', 'code-review', 'start');
  result = await none.fixCycle('sink', ['packages/lane/src/a.ts'], ['--repair-pipeline', 'lane']);
  assert.match(result.stderr, /CROSS_LANE_OWNER_AMBIGUOUS/);
});


test('distinct evidenced root causes in one defect class do not force class review', async () => {
  const fx = await lanesFixture('distinct-root-causes');
  fx.finish('lane', 'implementation');
  fx.step('lane', 'code-review', 'start');
  const cause = async (id, evidence) => {
    let result = fx.cli('scope-check', fx.runId, 'code-review', 'packages/lane/src/a.ts', '--pipeline', 'lane');
    assert.equal(result.status, 0, result.stderr);
    const file = path.join(fx.root, 'cause-' + id + '.json');
    await writeFile(file, JSON.stringify({ status: 'needs_revision', run_id: fx.runId,
      pipeline_id: 'lane', stage: 'code-review',
      findings: [{ id, defect_class: 'same-class', root_cause_id: id,
        root_cause_evidence: evidence }] }));
    return fx.cli('fix-cycle', fx.runId, 'code-review', '--pipeline', 'lane', '--evidence', file, '--json');
  };
  let result = await cause('cause-a', 'tests/a.test.ts failed at assertion A');
  assert.equal(result.status, 0, result.stderr);
  fx.finish('lane', 'implementation'); fx.step('lane', 'code-review', 'start');
  result = await cause('cause-b', 'tests/b.test.ts failed at assertion B');
  assert.equal(result.status, 0, result.stderr);
  const runtime = fx.status().pipelines.lane.stages['code-review'];
  assert.equal(runtime.technical_fix_cycles, 2);
  assert.equal(runtime.class_review_due, undefined);
  assert.equal(runtime.defect_class_history[0].cause_keys['same-class'], 'cause-a');
  assert.equal(runtime.defect_class_history[1].cause_keys['same-class'], 'cause-b');
  fx.finish('lane', 'implementation'); fx.step('lane', 'code-review', 'start');
  result = await cause('cause-b', 'tests/b.test.ts still fails at assertion B');
  assert.match(result.stderr, /CLASS_REVIEW_REQUIRED/);
  assert.equal(fx.status().pipelines.lane.stages['code-review'].technical_fix_cycles, 2);
});

test('class review may confirm a sound approach only with new diagnostic evidence and a repair plan', async () => {
  const fx = await lanesFixture('confirm-class-approach');
  fx.finish('lane', 'implementation'); fx.step('lane', 'code-review', 'start');
  let result = await fx.fixCycle('lane', ['packages/lane/src/a.ts'], ['--defect-class', 'same-bug']);
  assert.equal(result.status, 0, result.stderr);
  fx.finish('lane', 'implementation'); fx.step('lane', 'code-review', 'start');
  result = await fx.fixCycle('lane', ['packages/lane/src/a.ts'], ['--defect-class', 'same-bug']);
  assert.match(result.stderr, /CLASS_REVIEW_REQUIRED/);
  const runDir = path.join(fx.stateRoot, fx.runId);
  await writeFile(path.join(runDir, 'research.md'), '# Official documentation checked for the current version\n');
  await writeFile(path.join(runDir, 'tech.md'), 'status: ready\n');
  await writeFile(path.join(runDir, 'diagnostic-1.md'), 'Root cause is implementation error at test A, not architecture.\n');
  const record = async (patch = {}) => {
    const file = path.join(runDir, 'confirm-' + Math.random().toString(36).slice(2) + '.json');
    await writeFile(file, JSON.stringify({
      kind: 'class_review', run_id: fx.runId, pipeline_id: 'lane', stage: 'code-review',
      classes: ['same-bug'], approach: 'confirm_approach', summary: 'Existing approach is correct',
      research_artifact: path.join(runDir, 'research.md'),
      technical_review_artifact: path.join(runDir, 'tech.md'),
      diagnostic_artifact: path.join(runDir, 'diagnostic-1.md'),
      research_freshness_confirmed: true,
      implementation_plan: 'Fix implementation at assertion A, then test all sibling paths',
      approach_justification: 'Existing invariant and contracts remain valid',
      requirements_changed: false, acceptance_criteria_changed: false,
      external_contract_changed: false, security_boundary_changed: false, destructive_change: false,
      ...patch,
    }));
    return fx.cli('class-review-record', fx.runId, 'code-review', '--pipeline', 'lane', '--evidence', file, '--json');
  };
  result = await record({ implementation_plan: '' }); assert.match(result.stderr, /confirm_approach requires/);
  result = await record(); assert.equal(result.status, 0, result.stderr);
  assert.equal(fx.status().pipelines.lane.stages['code-review'].class_reviews[0].approach, 'confirm_approach');
  result = await fx.fixCycle('lane', ['packages/lane/src/a.ts'], ['--defect-class', 'same-bug']);
  assert.equal(result.status, 0, result.stderr);
  fx.finish('lane', 'implementation'); fx.step('lane', 'code-review', 'start');
  result = await fx.fixCycle('lane', ['packages/lane/src/a.ts'], ['--defect-class', 'same-bug']);
  assert.match(result.stderr, /CLASS_REVIEW_REQUIRED.*after rework/);
  result = await record(); assert.match(result.stderr, /repeated confirmation needs new diagnostic evidence/);
  await writeFile(path.join(runDir, 'diagnostic-2.md'), 'New run shows a different implementation fault at test B.\n');
  result = await record({ diagnostic_artifact: path.join(runDir, 'diagnostic-2.md'),
    implementation_plan: 'Correct assertion B and all related paths' });
  assert.equal(result.status, 0, result.stderr);
});
