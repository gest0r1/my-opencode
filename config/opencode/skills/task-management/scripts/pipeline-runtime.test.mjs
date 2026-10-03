import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import runtime from '../../../plugins/pipeline-runtime.ts';
import { dispatchPacket } from './pipeline-dispatch.ts';
const STAGE_CLI = fileURLToPath(new URL('./stage-cli.ts', import.meta.url));
function run(cwd, args) {
 const result = spawnSync('npx',['--yes','tsx',STAGE_CLI,...args], {cwd,encoding:'utf8',env:process.env});
 assert.equal(result.status,0,result.stderr); return result;
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
    const id = `wi-${pipeline.id}`;
    const artifact = await frozen(root, `work-items/${id}.json`, JSON.stringify({ id, pipeline_id: pipeline.id }));
    workItems.push({ id, pipeline_id: pipeline.id, ...artifact });
    normalized.push({
      ...pipeline,
      deployable: false,
      executors: Object.fromEntries(pipeline.stages.map((stage) => [stage, 'agent'])),
      work_items: [id],
      decision_ids: [],
      research_ids: [],
      contract_ids: [],
    });
  }
  return {
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


test('validated dispatch resumes only the same healthy worker with frozen repair evidence', async () => {
 const previousCwd = process.cwd(), root = await tempProject();
 try {
  const manifest = await baseManifest(root,'runtime-test',[{id:'p',stages:['implementation']}]);
  manifest.allowed_change_paths=['src/**'];
  const manifestPath=await writeManifest(root,manifest);
  run(root,['init',manifestPath]); run(root,['approve','runtime-test']); run(root,['start','runtime-test','implementation','--pipeline','p']);
  process.chdir(root);
  const hooks={}, sessionHooks={}; let unavailable=false;
  await runtime.setup({location:{directory:root}, tool:{hook:async(name,fn)=>{hooks[name]=fn},transform:async(fn)=>fn({add:()=>{}})},session:{hook:async(name,fn)=>{sessionHooks[name]=fn},get:async()=>{if(unavailable) throw Error('removed');return {data:{}}}}});
  const input=()=>({agent:'CoderAgent',prompt:'<pipeline_work_item id="wi-p"/><pipeline_dispatch run="runtime-test" pipeline="p" stage="implementation"/>',sessionID:'model-invented'});
  let e={tool:'subagent',sessionID:'parent',id:'first',input:input()};
  await hooks['execute.before'](e); assert.equal(e.input.sessionID,undefined); assert.match(e.input.prompt,/decision-register/);
  await sessionHooks.context({sessionID:'worker',agent:'CoderAgent',model:{providerID:'test',modelID:'test'},system:[],messages:[{text:'history'}],tools:{}});
  await hooks['execute.after']({...e,status:'completed',result:{metadata:{sessionID:'worker'},content:'done'}});
  await writeFile(path.join(root,'review.json'),'{"status":"technical_fix"}');
  run(root,['scope-check','runtime-test','implementation','src/a.ts','--pipeline','p']);
  run(root,['fix-cycle','runtime-test','implementation','--pipeline','p','--evidence',path.join(root,'review.json')]);
  e={tool:'subagent',sessionID:'parent',id:'repair',input:input()};await hooks['execute.before'](e);
  assert.equal(e.input.sessionID,'worker');assert.match(e.input.prompt,/session_reuse_delta/);
  await hooks['execute.after']({...e,status:'completed',result:{metadata:{sessionID:'worker'},content:'fixed'}});
  unavailable=true;e={tool:'subagent',sessionID:'parent',id:'unavailable',input:input()};await hooks['execute.before'](e);assert.equal(e.input.sessionID,undefined);
  await sessionHooks.prompt({sessionID:'parent',prompt:'/pipeline-run runtime-test --no-session-reuse'});
  unavailable=false;e={tool:'subagent',sessionID:'parent',id:'disabled',input:input()};await hooks['execute.before'](e);assert.equal(e.input.sessionID,undefined);
  await assert.rejects(dispatchPacket(root,'runtime-test','p','implementation','unknown','CoderAgent'),/WORK_ITEM_IDENTITY/);
  await assert.rejects(dispatchPacket(root,'runtime-test','p','missing','wi-p','CoderAgent'),/STAGE_NOT_RUNNABLE/);
  await writeFile(path.join(root,'review.json'),'changed');
  await assert.rejects(dispatchPacket(root,'runtime-test','p','implementation','wi-p','CoderAgent'),/REPAIR_EVIDENCE_CHANGED/);
 } finally {process.chdir(previousCwd); await rm(root,{recursive:true,force:true});}
});
