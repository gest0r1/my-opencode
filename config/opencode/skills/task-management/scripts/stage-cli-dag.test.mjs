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

async function tempProject() {
  return mkdtemp(path.join(os.tmpdir(), 'stage-cli-dag-'));
}

async function writeManifest(root, manifest) {
  const manifestPath = path.join(root, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifestPath;
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

async function baseManifest(root, runId, pipelines) {
  const architecture = await frozen(root, 'planning/architecture.md', '# architecture\n');
  const architectureReview = await frozen(root, 'reviews/architecture.md', '# review\n');
  const requiredArtifacts = {
    decision_register: await frozen(root, 'decision-register.md', '# decisions\n'),
    technology_evidence: await frozen(root, 'technology-evidence.md', '# evidence\n'),
    contract_inventory: await frozen(root, 'contract-inventory.md', '# contracts\n'),
    test_strategy: await frozen(root, 'test-strategy.md', '# tests\n'),
    accepted_risks: await frozen(root, 'accepted-risks.md', '# risks\n'),
    work_items: await frozen(root, 'work-items/index.json', '{"schema":2}\n'),
  };
  const workItems = [];
  const normalized = [];
  for (const pipeline of pipelines) {
    const executors = { ...Object.fromEntries(pipeline.stages.map((stage) => [stage, 'agent'])), ...pipeline.executors };
    const ids = [];
    for (const [index, stage] of pipeline.stages.filter(s => executors[s] === 'agent').entries()) {
      const id = index === 0 ? `wi-${pipeline.id}` : `wi-${pipeline.id}-${stage}`;
      const artifact = await frozen(root, `work-items/${id}.json`,
        JSON.stringify({ id, pipeline_id: pipeline.id, stage, suggested_agent: 'CoderAgent' }));
      workItems.push({ id, pipeline_id: pipeline.id, ...artifact });
      ids.push(id);
    }
    normalized.push({
      ...pipeline,
      deployable: false,
      executors,
      work_items: ids,
      decision_ids: [],
      research_ids: [],
      contract_ids: [],
    });
  }
  return {
    schema_version: 2,
    work_item_output_contract_version: 1,
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
          review: architectureReview,
          blocking_decision_ids: [],
        },
      },
      required_artifacts: requiredArtifacts,
    },
    open_decisions: [],
    allowed_change_paths: [],
    gate_profiles: {},
    pipelines: normalized,
    work_items: workItems,
  };
}

test('next exposes only dependency-ready stages and supports independent parallel roots', async () => {
  const root = await tempProject();
  const stateRoot = path.join(root, '.tmp', 'pipelines');
  const manifest = await baseManifest(root, 'dag-ready-run', [
    { id: 'a', stages: ['implementation'], ready_after_stage: 'implementation' },
    { id: 'b', stages: ['implementation'], depends_on: ['a'] },
    { id: 'c', stages: ['implementation'] },
  ]);
  const manifestPath = await writeManifest(root, manifest);

  let result = run(root, ['init', manifestPath, '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);
  result = run(root, ['approve', manifest.run_id, '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(await readFile(path.join(stateRoot,manifest.run_id,'state.json'),'utf8')).status,'approved');

  result = run(root, ['next', manifest.run_id, '--state-root', stateRoot, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const initial = JSON.parse(result.stdout);
  assert.deepEqual(initial.runnable, [
    { pipeline_id: 'a', stage: 'implementation' },
    { pipeline_id: 'c', stage: 'implementation' },
  ]);

  const premature = run(root, [
    'start',
    manifest.run_id,
    'implementation',
    '--pipeline',
    'b',
    '--state-root',
    stateRoot,
  ]);
  assert.notEqual(premature.status, 0);
  assert.match(premature.stderr, /dependency is not source-ready/);

  for (const id of ['a', 'c']) {
    result = run(root, [
      'start', manifest.run_id, 'implementation', '--pipeline', id, '--state-root', stateRoot,
    ]);
    assert.equal(result.status, 0, result.stderr);
  }

  const stateDuringParallel = JSON.parse(
    await readFile(path.join(stateRoot, manifest.run_id, 'state.json'), 'utf8'),
  );
  assert.deepEqual(stateDuringParallel.active_stages.sort(), ['a/implementation', 'c/implementation']);

  result = run(root, [
    'complete', manifest.run_id, 'implementation', '--pipeline', 'c', '--state-root', stateRoot,
  ]);
  assert.equal(result.status, 0, result.stderr);
  result = run(root, [
    'complete', manifest.run_id, 'implementation', '--pipeline', 'a', '--state-root', stateRoot,
  ]);
  assert.equal(result.status, 0, result.stderr);

  result = run(root, ['next', manifest.run_id, '--state-root', stateRoot, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).runnable, [{ pipeline_id: 'b', stage: 'implementation' }]);

  result = run(root, [
    'start', manifest.run_id, 'implementation', '--pipeline', 'b', '--state-root', stateRoot,
  ]);
  assert.equal(result.status, 0, result.stderr);
  result = run(root, [
    'complete', manifest.run_id, 'implementation', '--pipeline', 'b', '--state-root', stateRoot, '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'completed');
});

test('late blocker after source-ready does not freeze downstream work', async () => {
  const root = await tempProject();
  const stateRoot = path.join(root, '.tmp', 'pipelines');
  const manifest = await baseManifest(root, 'dag-late-blocker', [
    { id: 'a', stages: ['implementation', 'late-validation'], ready_after_stage: 'implementation', executors: { 'late-validation': 'review' } },
    { id: 'b', stages: ['implementation'], depends_on: ['a'] },
  ]);
  const manifestPath = await writeManifest(root, manifest);

  let result = run(root, ['init', manifestPath, '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);
  result = run(root, ['approve', manifest.run_id, '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);

  result = run(root, ['start', manifest.run_id, 'implementation', '--pipeline', 'a', '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);
  result = run(root, ['complete', manifest.run_id, 'implementation', '--pipeline', 'a', '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);

  result = run(root, ['start', manifest.run_id, 'late-validation', '--pipeline', 'a', '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);
  result = run(root, ['block', manifest.run_id, 'late-validation', '--pipeline', 'a', '--state-root', stateRoot, '--message', 'external quota']);
  assert.equal(result.status, 0, result.stderr);

  result = run(root, ['next', manifest.run_id, '--state-root', stateRoot, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(result.stdout);
  assert.deepEqual(state.runnable, [{ pipeline_id: 'b', stage: 'implementation' }]);
  assert.equal(state.status, 'in_progress');
});

test('blocker before source-ready keeps dependent work closed', async () => {
  const root = await tempProject();
  const stateRoot = path.join(root, '.tmp', 'pipelines');
  const manifest = await baseManifest(root, 'dag-early-blocker', [
    { id: 'a', stages: ['implementation', 'review'], ready_after_stage: 'review' },
    { id: 'b', stages: ['implementation'], depends_on: ['a'] },
  ]);
  const manifestPath = await writeManifest(root, manifest);

  let result = run(root, ['init', manifestPath, '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);
  result = run(root, ['approve', manifest.run_id, '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);
  result = run(root, ['start', manifest.run_id, 'implementation', '--pipeline', 'a', '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);
  result = run(root, ['block', manifest.run_id, 'implementation', '--pipeline', 'a', '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);

  result = run(root, ['next', manifest.run_id, '--state-root', stateRoot, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(result.stdout);
  assert.deepEqual(state.runnable, []);
  assert.equal(state.status, 'blocked');
});

test('init rejects dependency cycles before execution', async () => {
  const root = await tempProject();
  const stateRoot = path.join(root, '.tmp', 'pipelines');
  const manifest = await baseManifest(root, 'cycle-run', [
    { id: 'a', stages: ['implementation'], ready_after_stage: 'implementation', depends_on: ['b'] },
    { id: 'b', stages: ['implementation'], ready_after_stage: 'implementation', depends_on: ['a'] },
  ]);
  const manifestPath = await writeManifest(root, manifest);
  const result = run(root, ['init', manifestPath, '--state-root', stateRoot]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /dependency cycle/i);
});

test('validate fails closed when approved manifest changes', async () => {
  const root = await tempProject();
  const stateRoot = path.join(root, '.tmp', 'pipelines');
  const manifest = await baseManifest(root, 'manifest-freeze-run', [
    { id: 'app', stages: ['implementation'] },
  ]);
  const manifestPath = await writeManifest(root, manifest);

  let result = run(root, ['init', manifestPath, '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);
  result = run(root, ['approve', manifest.run_id, '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);

  manifest.pipelines[0].stages.push('tests');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  result = run(root, ['validate', manifest.run_id, '--state-root', stateRoot]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Manifest changed since pipeline initialization/);
});


test('github issue source freezes mapping and queues status audit events', async () => {
  const root=await tempProject(),stateRoot=path.join(root,'.tmp','pipelines');const manifest={...(await baseManifest(root,'github-issue-run',[{id:'app',stages:['implementation'],issue_numbers:[51,47]}])),source_type:'github_issues',repository:'owner/repo',source_issues:[{repository:'owner/repo',number:51,url:'https://github.com/owner/repo/issues/51',title:'One'},{repository:'owner/repo',number:47,url:'https://github.com/owner/repo/issues/47',title:'Two'}]};manifest.source_requirements_sha256='1'.repeat(64);const manifestPath=await writeManifest(root,manifest);let result=run(root,['init',manifestPath,'--state-root',stateRoot,'--json']);assert.equal(result.status,0,result.stderr);result=run(root,['approve',manifest.run_id,'--state-root',stateRoot,'--json']);assert.equal(result.status,0,result.stderr);result=run(root,['start',manifest.run_id,'implementation','--pipeline','app','--state-root',stateRoot,'--json']);assert.equal(result.status,0,result.stderr);const state=JSON.parse(result.stdout);assert.deepEqual(state.pipelines.app.issue_numbers,[51,47]);assert.deepEqual(state.github_outbox.map(e=>[e.from_status??'created',e.to_status]),[['created','planned'],['planned','approved'],['approved','in_progress']]);assert.equal(new Set(state.github_outbox.map(e=>e.id)).size,state.github_outbox.length);
});
test('github issue source rejects an unmapped issue', async () => {
  const root = await tempProject();
  const stateRoot = path.join(root, '.tmp', 'pipelines');
  const manifest = {
    ...(await baseManifest(root, 'github-unmapped-run', [
      { id: 'app', stages: ['implementation'], issue_numbers: [51] },
    ])),
    source_type: 'github_issues',
    repository: 'owner/repo',
    source_issues: [
      { repository: 'owner/repo', number: 51, url: 'https://github.com/owner/repo/issues/51', title: 'One' },
      { repository: 'owner/repo', number: 47, url: 'https://github.com/owner/repo/issues/47', title: 'Two' },
    ],
  };
  manifest.source_requirements_sha256 = '1'.repeat(64);
  const manifestPath = await writeManifest(root, manifest);
  const result = run(root, ['init', manifestPath, '--state-root', stateRoot]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Source issue #47 is not mapped/);
});


test('agent stage cannot transition to DONE before its frozen required output exists', async () => {
  const root = await tempProject();
  const previous = process.env.OPENCODE_AGENT_POLICY_DIR;
  const agents = path.join(root, 'agents');
  await mkdir(agents, { recursive: true });
  await writeFile(path.join(agents, 'CoderAgent.md'),
    '---\nname: CoderAgent\npermission:\n  edit:\n    "*": allow\n    ".tmp/pipelines/**": deny\n---\n');
  process.env.OPENCODE_AGENT_POLICY_DIR = agents;
  try {
    const stateRoot = path.join(root, '.tmp', 'pipelines');
    const manifest = await baseManifest(root, 'output-completion-run', [
      { id: 'a', stages: ['implementation'] },
    ]);
    manifest.allowed_change_paths = ['docs/**'];
    manifest.work_item_output_contract_version = 1;
    const itemRaw = JSON.stringify({ id: 'wi-a', pipeline_id: 'a', stage: 'implementation',
      suggested_agent: 'CoderAgent', allowed_change_paths: ['docs/**'],
      required_outputs: ['docs/completed.md'] });
    await writeFile(path.join(root, 'work-items/wi-a.json'), itemRaw);
    manifest.work_items[0].sha256 = sha(itemRaw);
    const manifestPath = await writeManifest(root, manifest);
    let result = run(root, ['init', manifestPath, '--state-root', stateRoot]);
    assert.equal(result.status, 0, result.stderr);
    result = run(root, ['approve', manifest.run_id, '--state-root', stateRoot]);
    assert.equal(result.status, 0, result.stderr);
    result = run(root, ['start', manifest.run_id, 'implementation', '--pipeline', 'a', '--state-root', stateRoot]);
    assert.equal(result.status, 0, result.stderr);
    result = run(root, ['complete', manifest.run_id, 'implementation', '--pipeline', 'a', '--state-root', stateRoot]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /WORK_ITEM_OUTPUT_MISSING/);
    const directCore = spawnSync('npx', ['--yes', 'tsx', path.join(HERE, 'stage-cli-core.ts'),
      'complete', manifest.run_id, 'implementation', '--state-root', stateRoot], { cwd: root, encoding: 'utf8' });
    assert.notEqual(directCore.status, 0);
    assert.match(directCore.stderr, /WORK_ITEM_OUTPUT_MISSING/);
    const wrapped = spawnSync('npx', ['--yes', 'tsx', path.join(HERE, 'stage-complete-cli.ts'),
      'complete', manifest.run_id, 'implementation', '--state-root', stateRoot], { cwd: root, encoding: 'utf8' });
    assert.notEqual(wrapped.status, 0);
    assert.match(wrapped.stderr, /STAGE_COMPLETE_DELEGATE_FAILED/);
    const intruder = await tempProject();
    await mkdir(path.join(intruder, 'docs'), { recursive: true });
    await writeFile(path.join(intruder, 'docs/completed.md'), '# fake evidence\n');
    const fromForeign = run(intruder, ['complete', manifest.run_id, 'implementation', '--state-root', stateRoot]);
    assert.notEqual(fromForeign.status, 0);
    assert.match(fromForeign.stderr, /RUN_WORKTREE_ROOT_MISMATCH/);
    result = run(root, ['complete', manifest.run_id, 'implementation', '--pipeline', 'a',
      '--pipeline', 'a', '--state-root', stateRoot]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DUPLICATE_SECURITY_OPTION/);
    const blockedState = JSON.parse(await readFile(path.join(stateRoot, manifest.run_id, 'state.json'), 'utf8'));
    assert.equal(blockedState.pipelines.a.stages.implementation.status, 'in_progress');
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await writeFile(path.join(root, 'docs/completed.md'), '# Completed\n');
    result = run(root, ['complete', manifest.run_id, 'implementation', '--state-root', stateRoot]);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_AGENT_POLICY_DIR;
    else process.env.OPENCODE_AGENT_POLICY_DIR = previous;
  }
});
