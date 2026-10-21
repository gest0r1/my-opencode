import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'pipeline-replan-cli.ts');

function runCommand(exe, args, cwd) {
  const result = spawnSync(exe, args, { cwd, encoding: 'utf8', env: process.env });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return String(result.stdout ?? '').trim();
}

function git(cwd, ...args) {
  return runCommand('git', args, cwd);
}

async function fixture(runId = 'refresh-run') {
  const main = await mkdtemp(path.join(os.tmpdir(), 'pipeline-refresh-main-'));
  const b = `${main}-b`;
  git(main, 'init', '-b', 'main');
  git(main, 'config', 'user.name', 'Refresh Test');
  git(main, 'config', 'user.email', 'refresh@example.invalid');
  await mkdir(path.join(main, 'src'), { recursive: true });
  await mkdir(path.join(main, 'docs'), { recursive: true });
  await writeFile(path.join(main, '.gitignore'), '.tmp/\n');
  await writeFile(path.join(main, 'src', 'input.ts'), 'export const value = 1;\n');
  await writeFile(path.join(main, 'docs', 'pipeline-rules.md'), '# rules\n');
  git(main, 'add', '.');
  git(main, 'commit', '-m', 'base');
  const base = git(main, 'rev-parse', 'HEAD');
  git(main, 'worktree', 'add', '-b', 'feature/refresh', b);

  const runRoot = path.join(b, '.tmp', 'pipelines', runId);
  await mkdir(path.join(runRoot, 'planning'), { recursive: true });
  await writeFile(path.join(runRoot, 'planning', 'architecture.md'), '# architecture\n');
  const manifest = {
    schema_version: 2,
    run_id: runId,
    planning_mode: 'design-freeze',
    git_setup: { base_sha: base, branch: 'feature/refresh' },
    planning_base_sha: base,
    allowed_change_paths: ['src/**'],
    freshness_sensitive_paths: ['src/**'],
    planning_inputs: {
      architecture: ['src/**'],
      work_items: ['src/**'],
    },
    planning_readiness: {
      design_freeze: true,
      required_gates: ['architecture'],
      gates: {
        architecture: {
          required: true,
          status: 'ready',
          artifact: { path: 'planning/architecture.md', sha256: '0'.repeat(64) },
          blocking_decision_ids: [],
        },
      },
    },
    pipelines: [{ id: 'app', stages: ['implementation'], executors: { implementation: 'agent' } }],
  };
  await writeFile(path.join(runRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(path.join(runRoot, 'state.json'), JSON.stringify({
    run_id: runId,
    status: 'approved',
    active_stages: [],
  }, null, 2));

  return { main, b, base, runId, runRoot };
}

function invoke(cwd, args) {
  const result = spawnSync('npx', ['--yes', 'tsx', CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: process.env,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

async function advanceMain(fx, relative, content) {
  const file = path.join(fx.main, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  git(fx.main, 'add', relative);
  git(fx.main, 'commit', '-m', `change ${relative}`);
  const newBase = git(fx.main, 'rev-parse', 'HEAD');
  git(fx.b, 'merge', '--no-edit', 'main');
  return newBase;
}

test('legacy aggregate in_progress with no active stage can refresh the same folder', async () => {
  const fx=await fixture();
  await writeFile(path.join(fx.runRoot,'state.json'),JSON.stringify({run_id:fx.runId,status:'in_progress',active_stages:[],history:[]}));
  assert.equal(invoke(fx.b,['preflight',fx.runId]).status,'PASS');
  await advanceMain(fx,'docs/unrelated.md','# other');
  const result=invoke(fx.b,['apply',fx.runId]);
  assert.equal(result.result,'COMPATIBLE');
  assert.equal(result.run_id,fx.runId);
});
test('changed planning input requires semantic review instead of cloning/replan', async () => {
  const fx=await fixture();
  await advanceMain(fx,'src/input.ts','export const value=2;');
  const result=invoke(fx.b,['apply',fx.runId]);
  assert.equal(result.status,'REVIEW_REQUIRED');
  assert.equal(result.implementation_started,false);
  const input=JSON.parse(await readFile(result.evidence,'utf8'));
  assert.match(input.git_diff,/value=2/);
  const review=path.join(fx.runRoot,'planning/reconcile-review.json');
  await writeFile(review,JSON.stringify({input_sha256:input.input_sha256,result:'COMPATIBLE',reason:'Existing approved implementation covers changed constant',business_intent_changed:false,architecture_invalid:false,external_contract_changed:false,security_boundary_changed:false,destructive_change:false,owner_decision_required:false,implementation_change_required:false}));
  const applied=invoke(fx.b,['apply',fx.runId,'--evidence',review]);
  assert.equal(applied.result,'COMPATIBLE');
  assert.equal(invoke(fx.b,['apply',fx.runId]).result,'COMPATIBLE');
});
test('real active stage blocks refresh before mutations', async () => {
  const fx=await fixture();
  await writeFile(path.join(fx.runRoot,'state.json'),JSON.stringify({run_id:fx.runId,status:'approved',active_stages:[],pipelines:{app:{stages:{implementation:{status:'in_progress'}}}}}));
  const result=spawnSync('npx',['--yes','tsx',CLI,'preflight',fx.runId],{cwd:fx.b,encoding:'utf8'});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/RUN_ACTIVE/);
});

test('delta lists main changes against planning inputs, scopes, test_rework and gate sources', async () => {
  const fx=await fixture();
  const manifestPath=path.join(fx.runRoot,'manifest.json');
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  manifest.planning_scope=['docs/pipeline-rules.md'];
  manifest.allowed_change_paths=['src/**','tests/rework.test.mjs'];
  manifest.test_rework=[{id:'tr1',path:'tests/rework.test.mjs',action:'update',reason:'pin',work_item_id:'wi1'}];
  manifest.gate_testing={ci:{test:{impact_groups:[{paths:['tools/map.json']}]}}};
  await writeFile(manifestPath,JSON.stringify(manifest));
  const before=await readFile(manifestPath,'utf8');
  const none=invoke(fx.b,['delta',fx.runId,'--json']);
  assert.deepEqual(none.changed_files,[]);
  assert.deepEqual(none.affected_gates,[]);
  assert.equal(none.base_sha,fx.base);
  await advanceMain(fx,'README.md','# readme');
  const docsOnly=invoke(fx.b,['delta',fx.runId]);
  assert.deepEqual(docsOnly.changed_files,['README.md']);
  assert.deepEqual(docsOnly.affected_gates,['gate_probes']);
  await advanceMain(fx,'tests/rework.test.mjs','x');
  await advanceMain(fx,'tools/map.json','{}');
  await advanceMain(fx,'docs/pipeline-rules.md','# rules 2');
  const result=invoke(fx.b,['delta','--json',fx.runId]);
  assert.deepEqual(result.intersections.planning_scope,['docs/pipeline-rules.md']);
  assert.deepEqual(result.intersections.test_rework,['tests/rework.test.mjs']);
  assert.deepEqual(result.intersections.allowed_change_paths,['tests/rework.test.mjs']);
  assert.deepEqual(result.intersections.gate_testing_source,['tools/map.json']);
  assert.deepEqual(result.affected_gates,['stories','architecture','contracts','work_items','gate_probes']);
  assert.equal(result.implementation_started,false);
  assert.equal(await readFile(manifestPath,'utf8'),before);
});
test('delta measures from the last adopted reconcile base', async () => {
  const fx=await fixture();
  await advanceMain(fx,'docs/unrelated.md','# other');
  const applied=invoke(fx.b,['apply',fx.runId]);
  assert.equal(applied.result,'COMPATIBLE');
  const after=await advanceMain(fx,'README.md','# readme');
  const result=invoke(fx.b,['delta',fx.runId]);
  assert.equal(result.base_source,'reconcile');
  assert.deepEqual(result.changed_files,['README.md']);
  assert.equal(result.main_sha,after);
});
