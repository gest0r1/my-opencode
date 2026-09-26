import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
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

async function tempProject() {
  return mkdtemp(path.join(os.tmpdir(), 'stage-cli-dag-'));
}

async function writeManifest(root, manifest) {
  const manifestPath = path.join(root, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifestPath;
}

function baseManifest(runId, pipelines) {
  return {
    schema_version: 1,
    run_id: runId,
    rules_file: 'docs/pipeline-rules.md',
    rules_version: 2,
    planning_mode: 'design-freeze',
    planning_readiness: 'ready',
    open_decisions: [],
    pipelines,
  };
}

test('next exposes only dependency-ready stages and supports independent parallel roots', async () => {
  const root = await tempProject();
  const stateRoot = path.join(root, '.tmp', 'pipelines');
  const manifest = baseManifest('dag-ready-run', [
    { id: 'a', stages: ['implementation'] },
    { id: 'b', stages: ['implementation'], depends_on: ['a'] },
    { id: 'c', stages: ['implementation'] },
  ]);
  const manifestPath = await writeManifest(root, manifest);

  let result = run(root, ['init', manifestPath, '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);
  result = run(root, ['approve', manifest.run_id, '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);

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
  assert.match(premature.stderr, /dependency is not completed/);

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

test('init rejects dependency cycles before execution', async () => {
  const root = await tempProject();
  const stateRoot = path.join(root, '.tmp', 'pipelines');
  const manifest = baseManifest('cycle-run', [
    { id: 'a', stages: ['implementation'], depends_on: ['b'] },
    { id: 'b', stages: ['implementation'], depends_on: ['a'] },
  ]);
  const manifestPath = await writeManifest(root, manifest);
  const result = run(root, ['init', manifestPath, '--state-root', stateRoot]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /dependency cycle/i);
});

test('validate fails closed when approved manifest changes', async () => {
  const root = await tempProject();
  const stateRoot = path.join(root, '.tmp', 'pipelines');
  const manifest = baseManifest('manifest-freeze-run', [
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
  const root=await tempProject(),stateRoot=path.join(root,'.tmp','pipelines');const manifest={...baseManifest('github-issue-run',[{id:'app',stages:['implementation'],issue_numbers:[51,47]}]),source_type:'github_issues',repository:'owner/repo',source_issues:[{repository:'owner/repo',number:51,url:'https://github.com/owner/repo/issues/51',title:'One'},{repository:'owner/repo',number:47,url:'https://github.com/owner/repo/issues/47',title:'Two'}]};const manifestPath=await writeManifest(root,manifest);let result=run(root,['init',manifestPath,'--state-root',stateRoot,'--json']);assert.equal(result.status,0,result.stderr);result=run(root,['approve',manifest.run_id,'--state-root',stateRoot,'--json']);assert.equal(result.status,0,result.stderr);result=run(root,['start',manifest.run_id,'implementation','--pipeline','app','--state-root',stateRoot,'--json']);assert.equal(result.status,0,result.stderr);const state=JSON.parse(result.stdout);assert.deepEqual(state.pipelines.app.issue_numbers,[51,47]);assert.deepEqual(state.github_outbox.map(e=>[e.from_status??'created',e.to_status]),[['created','planned'],['planned','approved'],['approved','in_progress']]);assert.equal(new Set(state.github_outbox.map(e=>e.id)).size,state.github_outbox.length);
});
test('github issue source rejects an unmapped issue', async () => {
  const root=await tempProject(),stateRoot=path.join(root,'.tmp','pipelines');const manifest={...baseManifest('github-unmapped-run',[{id:'app',stages:['implementation'],issue_numbers:[51]}]),source_type:'github_issues',repository:'owner/repo',source_issues:[{repository:'owner/repo',number:51,url:'https://github.com/owner/repo/issues/51',title:'One'},{repository:'owner/repo',number:47,url:'https://github.com/owner/repo/issues/47',title:'Two'}]};const manifestPath=await writeManifest(root,manifest);const result=run(root,['init',manifestPath,'--state-root',stateRoot]);assert.notEqual(result.status,0);assert.match(result.stderr,/Source issue #47 is not mapped/);
});
