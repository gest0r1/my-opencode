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
    const artifact = await frozen(root, `work-items/${id}.json`, JSON.stringify({ id, pipeline_id: pipeline.id, stage: pipeline.stages[0], suggested_agent: 'CoderAgent' }));
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

function handoffPathFromPrompt(prompt, tag) {
  const match = new RegExp(`<${tag} path="([^"]+)"\\/>`).exec(prompt);
  assert.ok(match, `missing ${tag} path in prompt`);
  return match[1];
}

test('validated dispatch uses file-backed handoffs and resumes only the same healthy worker', async () => {
 const previousCwd = process.cwd(), root = await tempProject();
 try {
  spawnSync('git',['init'],{cwd:root});
  spawnSync('git',['config','user.email','test@example.invalid'],{cwd:root});
  spawnSync('git',['config','user.name','Test'],{cwd:root});
  await mkdir(path.join(root,'src'),{recursive:true});
  await writeFile(path.join(root,'src','a.ts'),'export const a = 1;\n');
  spawnSync('git',['add','src'],{cwd:root});
  spawnSync('git',['commit','-m','base'],{cwd:root});

  const manifest = await baseManifest(root,'runtime-test',[{id:'p',stages:['implementation', 'code-review']}]);
  manifest.allowed_change_paths=['src/**'];
  manifest.pipelines[0].executors['code-review']='review';
  manifest.pipelines[0].profile='local';
  manifest.gate_profiles={local:{'local-test':['npm test']}};
  manifest.gate_testing={local:{'local-test':{impact_groups:[{inputs:['src/**'],command_index:0}]}}};
  const workItemPath=path.join(root,manifest.work_items[0].path);
  const workItemRaw=JSON.stringify({id:'wi-p',pipeline_id:'p',stage:'implementation',suggested_agent:'CoderAgent',allowed_change_paths:['src/**']});
  await writeFile(workItemPath,workItemRaw);
  manifest.work_items[0].sha256=sha(workItemRaw);

  const manifestPath=await writeManifest(root,manifest);
  run(root,['init',manifestPath]); run(root,['approve','runtime-test']); run(root,['start','runtime-test','implementation','--pipeline','p']);
  process.chdir(root);
  const baselinePacket = await dispatchPacket(root,'runtime-test','p','implementation','wi-p','CoderAgent');
  assert.equal(baselinePacket.advisory_checks.length,1);
  assert.equal(baselinePacket.advisory_checks[0].gate,'local-test');
  assert.equal(baselinePacket.advisory_checks[0].mode,'affected');
  assert.equal(baselinePacket.advisory_checks[0].work_item_id,'wi-p');
  assert.match(baselinePacket.advisory_checks[0].baseline_path,/^checks\/baselines\//);
  assert.match(baselinePacket.advisory_checks[0].baseline_sha256,/^[0-9a-f]{64}$/);
  await assert.rejects(dispatchPacket(root,'runtime-test','p','implementation','wi-p','TestEngineer'),/WORK_ITEM_ROLE_MISMATCH/);
  const hooks={}, sessionHooks={}; let unavailable=false;
  await runtime.setup({location:{directory:root}, tool:{hook:async(name,fn)=>{hooks[name]=fn},transform:async(fn)=>fn({add:()=>{}})},session:{hook:async(name,fn)=>{sessionHooks[name]=fn},get:async()=>{if(unavailable) throw Error('removed');return {data:{}}}}});

  const shellDispatch={
    tool:'shell',sessionID:'parent',id:'dispatch-shell',status:'completed',
    input:{command:'npx tsx $HOME/.config/opencode/skills/task-management/scripts/stage-cli.ts dispatch runtime-test --pipeline p --stage implementation --work-item wi-p --role CoderAgent --json'},
    result:{content:JSON.stringify(baselinePacket)},
  };
  await hooks['execute.after'](shellDispatch);
  const compactDispatch=JSON.parse(shellDispatch.result.content);
  assert.equal(compactDispatch.status,'ready');
  assert.equal(compactDispatch.work_item_id,'wi-p');
  assert.equal(compactDispatch.advisory_required,true);
  assert.match(compactDispatch.packet_path,/^\.tmp\/pipelines\/runtime-test\/handoffs\/dispatch\//);
  const persistedDispatch=JSON.parse(await readFile(path.join(root,compactDispatch.packet_path),'utf8'));
  assert.equal(persistedDispatch.advisory_checks[0].gate,'local-test');
  assert.ok(shellDispatch.result.content.length < JSON.stringify(baselinePacket).length);

  const input=()=>({agent:'CoderAgent',prompt:'<pipeline_work_item id="wi-p"/><pipeline_dispatch run="runtime-test" pipeline="p" stage="implementation"/>',sessionID:'model-invented'});
  let e={tool:'subagent',sessionID:'parent',id:'first',input:input()};
  await hooks['execute.before'](e);
  assert.equal(e.input.sessionID,undefined);
  assert.doesNotMatch(e.input.prompt,/<dispatch_packet>/);
  assert.doesNotMatch(e.input.prompt,/"advisory_checks"/);
  const dispatchPath = handoffPathFromPrompt(e.input.prompt,'pipeline_dispatch_packet');
  const dispatch = JSON.parse(await readFile(path.join(root,dispatchPath),'utf8'));
  assert.equal(dispatch.work_item_id,'wi-p');
  assert.equal(dispatch.advisory_checks[0].gate,'local-test');
  await sessionHooks.context({sessionID:'worker',agent:'CoderAgent',model:{providerID:'test',modelID:'test'},system:[],messages:[{text:'history'}],tools:{}});
  const firstResult={...e,status:'completed',result:{metadata:{sessionID:'worker'},content:'status: ready\nimplementation detail that should not stay in parent context'}};
  await hooks['execute.after'](firstResult);
  const compactFirst=JSON.parse(firstResult.result.content);
  assert.equal(compactFirst.status,'ready');
  assert.match(compactFirst.result_path,/^\.tmp\/pipelines\/runtime-test\/handoffs\/results\//);
  const persistedFirst=JSON.parse(await readFile(path.join(root,compactFirst.result_path),'utf8'));
  assert.match(persistedFirst.content,/implementation detail/);
  assert.ok(firstResult.result.content.length < persistedFirst.content.length + 200);

  await writeFile(path.join(root,'review.json'),'{"status":"technical_fix"}');
  run(root,['complete','runtime-test','implementation','--pipeline','p']);
  run(root,['start','runtime-test','code-review','--pipeline','p']);
  const reviewPacket = await dispatchPacket(root,'runtime-test','p','code-review','code-review','CodeReviewer');
  assert.equal(reviewPacket.review_work_items[0].id, 'wi-p');
  assert.equal(reviewPacket.reuse.eligible, false);
  assert.deepEqual(reviewPacket.advisory_checks, []);
  run(root,['scope-check','runtime-test','code-review','src/a.ts','--pipeline','p']);
  run(root,['fix-cycle','runtime-test','code-review','--pipeline','p','--evidence',path.join(root,'review.json')]);
  e={tool:'subagent',sessionID:'parent',id:'repair',input:input()};await hooks['execute.before'](e);
  assert.equal(e.input.sessionID,'worker');
  assert.doesNotMatch(e.input.prompt,/<session_reuse_delta>\s*\{/);
  const deltaPath = handoffPathFromPrompt(e.input.prompt,'session_reuse_delta');
  const delta=JSON.parse(await readFile(path.join(root,deltaPath),'utf8'));
  assert.equal(delta.work_item_id,'wi-p');
  const repairResult={...e,status:'completed',result:{metadata:{sessionID:'worker'},content:'status: ready\nfixed with long technical explanation'}};
  await hooks['execute.after'](repairResult);
  assert.equal(JSON.parse(repairResult.result.content).status,'ready');
  unavailable=true;e={tool:'subagent',sessionID:'parent',id:'unavailable',input:input()};await hooks['execute.before'](e);assert.equal(e.input.sessionID,undefined);
  await sessionHooks.prompt({sessionID:'parent',prompt:'/pipeline-run runtime-test --no-session-reuse'});
  unavailable=false;e={tool:'subagent',sessionID:'parent',id:'disabled',input:input()};await hooks['execute.before'](e);assert.equal(e.input.sessionID,undefined);
  await assert.rejects(dispatchPacket(root,'runtime-test','p','implementation','unknown','CoderAgent'),/WORK_ITEM_IDENTITY/);
  await assert.rejects(dispatchPacket(root,'runtime-test','p','missing','wi-p','CoderAgent'),/STAGE_NOT_RUNNABLE/);
  await writeFile(path.join(root,'review.json'),'changed');
  await assert.rejects(dispatchPacket(root,'runtime-test','p','implementation','wi-p','CoderAgent'),/REPAIR_EVIDENCE_CHANGED/);
 } finally {process.chdir(previousCwd); await rm(root,{recursive:true,force:true});}
});

test('runtime preflight forwards selected research roles and checks their effective access', async () => {
 const root = await tempProject();
 try {
  const registered = new Map();
  const ids = ['ContextScout', 'ExternalScout', 'StoryMapper', 'SeniorStoryReviewer', 'ArchitectureAnalyzer', 'ContractManager', 'PrioritizationEngine', 'SeniorTechnicalPlanReviewer', 'TaskManager', 'CoderAgent', 'BuildAgent', 'CodeReviewer', 'TestEngineer', 'DocWriter', 'OpenDevopsSpecialist', 'OpenFrontendSpecialist', 'WebResearcher'];
  let denied = false;
  const parent = {id:'OpenStageOrchestrator', mode:'primary', permissions:[
    ...ids.map(resource => ({action:'subagent', resource, effect:'allow'})),
    {action:'bash',resource:'*',effect:'deny'},
    {action:'bash',resource:'npx tsx $HOME/.config/opencode/skills/task-management/scripts/stage-complete-cli.ts*',effect:'allow'},
  ]};
  await runtime.setup({location:{directory:root},
   tool:{hook:async()=>{}, transform:async fn=>fn({add:t=>registered.set(t.name,t)}),
    list:async()=>['read','shell','subagent','pipeline_runtime_prepare','webfetch','gh_grep_searchGitHub'].map(id=>({id}))},
   session:{hook:async()=>{}},
   agent:{list:async()=>({data:[parent,...ids.map(id=>({id,mode:'subagent',permissions:[
    ...(['CoderAgent','TestEngineer'].includes(id) ? [
      {action:'bash',resource:'*',effect:'deny'},
      {action:'bash',resource:'npx tsx $HOME/.config/opencode/skills/task-management/scripts/gate-runner-cli.ts * --advisory*',effect:'allow'},
    ] : []),
    ...(id === 'TestEngineer' ? [{action:'bash',resource:'pytest *',effect:'allow'}] : []),
    ...(id === 'OpenDevopsSpecialist' ? [
      {action:'bash',resource:'*',effect:'deny'},
      {action:'bash',resource:'npx tsx $HOME/.config/opencode/skills/task-management/scripts/runtime-diagnostic-cli.ts *',effect:'allow'},
    ] : []),
    {action:'webfetch',resource:'*',effect:denied?'deny':'allow'}, {action:'gh_grep_*',resource:'*',effect:'allow'}]}))]})},
   skill:{list:async()=>({data:[{name:'task-management'}]})},
   model:{list:async()=>({data:[{providerID:'test',id:'test'}]})},
  });
  const preflight=registered.get('pipeline_runtime_preflight');
  assert.ok(preflight.input.properties.research_agents.items.enum.includes('ArchitectureAnalyzer'));
  const result=await preflight.execute({research_agents:['ArchitectureAnalyzer','WebResearcher']},{sessionID:'parent'});
  assert.deepEqual(JSON.parse(result.content).research_checked.map(r=>r.agent),['ArchitectureAnalyzer','WebResearcher']);
  denied=true;
  await assert.rejects(preflight.execute({research_agents:['ArchitectureAnalyzer']},{sessionID:'parent'}), /research:ArchitectureAnalyzer:webfetch/);
  assert.equal(JSON.parse((await preflight.execute({}, {sessionID:'parent'})).content).status,'PASS');
 } finally {await rm(root,{recursive:true,force:true});}
});
