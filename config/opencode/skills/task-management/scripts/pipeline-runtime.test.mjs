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


async function writeBaseProbe(root, run, pipeline, gate, status = 'PASS') {
  const dir = path.join(root, '.tmp/pipelines', run, 'checks');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${pipeline}-${gate}-base-probe.json`), JSON.stringify({ status, purpose: 'advisory', base_probe: { head_sha: 'a'.repeat(40), base_sha: null } }));
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
  const otherItem=await frozen(root,'work-items/wi-other.json',JSON.stringify({id:'wi-other',pipeline_id:'p',stage:'implementation',suggested_agent:'CoderAgent',depends_on:['wi-p'],allowed_change_paths:['src/**']}));
  manifest.work_items.push({id:'wi-other',pipeline_id:'p',...otherItem});
  manifest.pipelines[0].work_items.push('wi-other');

  const manifestPath=await writeManifest(root,manifest);
  run(root,['init',manifestPath]); run(root,['approve','runtime-test']); run(root,['start','runtime-test','implementation','--pipeline','p']);
  process.chdir(root);
  await assert.rejects(dispatchPacket(root,'runtime-test','p','implementation','wi-p','CoderAgent'),/BASE_PROBE_REQUIRED/);
  await writeBaseProbe(root,'runtime-test','p','local-test','FAIL');
  await assert.rejects(dispatchPacket(root,'runtime-test','p','implementation','wi-p','CoderAgent'),/BASE_RED_REPAIR_REQUIRED/);
  await writeBaseProbe(root,'runtime-test','p','local-test');
  const baselinePacket = await dispatchPacket(root,'runtime-test','p','implementation','wi-p','CoderAgent');
  assert.deepEqual(baselinePacket.advisory_checks[0].shell,{background:false,timeout:3_600_000});
  assert.equal(baselinePacket.advisory_checks.length,1);
  assert.equal(baselinePacket.advisory_checks[0].gate,'local-test');
  assert.equal(baselinePacket.advisory_checks[0].mode,'affected');
  assert.equal(baselinePacket.advisory_checks[0].work_item_id,'wi-p');
  assert.match(baselinePacket.advisory_checks[0].baseline_path,/^checks\/baselines\//);
  assert.match(baselinePacket.advisory_checks[0].baseline_sha256,/^[0-9a-f]{64}$/);
  assert.equal(baselinePacket.advisory_checks[0].command,`$HOME/.config/opencode/node_modules/.bin/tsx $HOME/.config/opencode/skills/task-management/scripts/gate-runner-cli.ts ${baselinePacket.run_id} ${baselinePacket.pipeline_id} local-test --advisory --affected --work-item wi-p --baseline ${baselinePacket.advisory_checks[0].baseline_path} --baseline-sha256 ${baselinePacket.advisory_checks[0].baseline_sha256}`);
  assert.match(baselinePacket.advisory_checks[0].focus_command,/gate-runner-cli\.ts \S+ \S+ local-test --advisory --command-index /);
  assert.equal(baselinePacket.advisory_checks[0].frozen_commands[0].index,0);
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
  const firstResult={...e,status:'completed',result:{metadata:{sessionID:'worker'},content:'status: partial\nimplementation detail that should not stay in parent context'}};
  await hooks['execute.after'](firstResult);
  const compactFirst=JSON.parse(firstResult.result.content);
  assert.equal(compactFirst.status,'partial');
  assert.match(compactFirst.result_path,/^\.tmp\/pipelines\/runtime-test\/handoffs\/results\//);
  const persistedFirst=JSON.parse(await readFile(path.join(root,compactFirst.result_path),'utf8'));
  assert.match(persistedFirst.content,/implementation detail/);
  assert.ok(firstResult.result.content.length < persistedFirst.content.length + 200);

  // Continuing the original implementation must resume even before a fix-cycle.
  e={tool:'subagent',sessionID:'parent',id:'continuation',input:input()};
  await hooks['execute.before'](e);
  assert.equal(e.input.sessionID,'worker');
  const continuationDelta=JSON.parse(await readFile(path.join(root,handoffPathFromPrompt(e.input.prompt,'session_reuse_delta')),'utf8'));
  assert.equal(continuationDelta.continuation_kind,'same_work_item');
  assert.equal(continuationDelta.evidence_path,compactFirst.result_path);
  assert.ok(continuationDelta.required_reread.includes(compactFirst.result_path));
  const continuedPacket=await dispatchPacket(root,'runtime-test','p','implementation','wi-p','CoderAgent');
  assert.equal(continuedPacket.loop,0);
  await hooks['execute.after']({...e,status:'completed',result:{metadata:{sessionID:'worker'},content:'status: ready\ncompleted original attempt'}});

  const registryPath=path.join(root,'.tmp/pipelines/runtime-test/session-registry.json');
  const healthyRegistry=await readFile(registryPath,'utf8');
  const assertFresh=async (reason, mutate) => {
    const entries=JSON.parse(healthyRegistry); mutate(entries[0]);
    await writeFile(registryPath,JSON.stringify(entries));
    const event={tool:'subagent',sessionID:'parent',id:`fallback-${reason}`,input:input()};
    await hooks['execute.before'](event);
    assert.equal(event.input.sessionID,undefined);
    const metrics=(await readFile(path.join(root,'.tmp/pipelines/runtime-test/reuse-metrics/events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(metrics.at(-1).fallback_reason,reason);
    await writeFile(registryPath,healthyRegistry);
  };
  await assertFresh('contract_changed',entry=>{entry.continuity_key='different-scope';});
  await assertFresh('contract_changed',entry=>{delete entry.continuity_key;});
  await assertFresh('stale_state',entry=>{delete entry.state_revision;});
  await assertFresh('missing_delta',entry=>{delete entry.result_path;});
  await assertFresh('stale_evidence',entry=>{entry.result_sha256='tampered';});
  for (const status of ['error','cancelled','in_progress']) await assertFresh(status,entry=>{entry.status=status;});

  // Cancellation of a resumed worker invalidates it, even if its ID still exists.
  e={tool:'subagent',sessionID:'parent',id:'interrupted',input:input()}; await hooks['execute.before'](e);
  assert.equal(e.input.sessionID,'worker');
  await hooks['execute.after']({...e,status:'cancelled',error:{message:'interrupted'}});
  const recovery={tool:'subagent',sessionID:'parent',id:'recovery',input:input()}; await hooks['execute.before'](recovery);
  assert.equal(recovery.input.sessionID,undefined);
  await hooks['execute.after']({...recovery,status:'completed',result:{metadata:{sessionID:'worker'},content:'status: ready'}});
  await writeFile(registryPath,healthyRegistry);

  const other={tool:'subagent',sessionID:'parent',id:'other-work-item',input:{agent:'CoderAgent',sessionID:'worker',prompt:'<pipeline_work_item id="wi-other"/><pipeline_dispatch run="runtime-test" pipeline="p" stage="implementation"/>'}};
  await hooks['execute.before'](other);
  assert.equal(other.input.sessionID,undefined);

  await writeFile(path.join(root,'review.json'),'{"status":"technical_fix"}');
  run(root,['complete','runtime-test','implementation','--pipeline','p']);
  run(root,['start','runtime-test','code-review','--pipeline','p']);
  const reviewPacket = await dispatchPacket(root,'runtime-test','p','code-review','code-review','CodeReviewer');
  assert.equal(reviewPacket.review_work_items[0].id, 'wi-p');
  assert.equal(reviewPacket.reuse.eligible, false);
  assert.deepEqual(reviewPacket.advisory_checks, []);
  const reviewer={tool:'subagent',sessionID:'parent',id:'independent-review',input:{agent:'CodeReviewer',sessionID:'worker',prompt:'<pipeline_work_item id="code-review"/><pipeline_dispatch run="runtime-test" pipeline="p" stage="code-review"/>'}};
  await hooks['execute.before'](reviewer);
  assert.equal(reviewer.input.sessionID,undefined);
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
  const template='/pipeline-run <run-id> [--unattended] [--no-session-reuse]\n- `--no-session-reuse` — force fresh sessions.';
  await sessionHooks.prompt({sessionID:'parent',prompt:`/pipeline-run runtime-test --unattended --fix-cycles 10\n${template}`});
  e={tool:'subagent',sessionID:'parent',id:'template-only',input:input()};await hooks['execute.before'](e);assert.equal(e.input.sessionID,'worker');
  await assert.rejects(dispatchPacket(root,'runtime-test','p','implementation','unknown','CoderAgent'),/WORK_ITEM_IDENTITY/);
  await assert.rejects(dispatchPacket(root,'runtime-test','p','missing','wi-p','CoderAgent'),/STAGE_NOT_RUNNABLE/);
  await writeFile(path.join(root,'review.json'),'changed');
  await assert.rejects(dispatchPacket(root,'runtime-test','p','implementation','wi-p','CoderAgent'),/REPAIR_EVIDENCE_CHANGED/);
 } finally {process.chdir(previousCwd); await rm(root,{recursive:true,force:true});}
});

for (const role of ['TestEngineer','BuildAgent']) test(`${role} stays fresh for loop-zero continuations`, async () => {
 const previousCwd=process.cwd(), root=await tempProject();
 try {
  const manifest=await baseManifest(root,`baseline-${role}`,[{id:'p',stages:['implementation']}]);
  const raw=JSON.stringify({id:'wi-p',pipeline_id:'p',stage:'implementation',suggested_agent:role});
  await writeFile(path.join(root,manifest.work_items[0].path),raw); manifest.work_items[0].sha256=sha(raw);
  run(root,['init',await writeManifest(root,manifest)]); run(root,['approve',manifest.run_id]); run(root,['start',manifest.run_id,'implementation','--pipeline','p']);
  process.chdir(root);
  const hooks={};
  await runtime.setup({location:{directory:root},tool:{hook:async(name,fn)=>{hooks[name]=fn;},transform:async fn=>fn({add:()=>{}})},session:{hook:async()=>{},get:async()=>({data:{}})}});
  const input=()=>({agent:role,prompt:`<pipeline_work_item id="wi-p"/><pipeline_dispatch run="${manifest.run_id}" pipeline="p" stage="implementation"/>`});
  const first={tool:'subagent',sessionID:'parent',id:'first',input:input()}; await hooks['execute.before'](first);
  await hooks['execute.after']({...first,status:'completed',result:{metadata:{sessionID:'worker'},content:'status: partial'}});
  const next={tool:'subagent',sessionID:'parent',id:'next',input:input()}; await hooks['execute.before'](next);
  assert.equal(next.input.sessionID,undefined);
  const metrics=(await readFile(path.join(root,`.tmp/pipelines/${manifest.run_id}/reuse-metrics/events.jsonl`),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(metrics.at(-1).fallback_reason,'baseline');
 } finally {process.chdir(previousCwd);await rm(root,{recursive:true,force:true});}
});

test('runtime preflight forwards selected research roles and checks their effective access', async () => {
 const root = await tempProject();
 try {
  const registered = new Map();
  const ids = ['ContextScout', 'ExternalScout', 'StoryMapper', 'SeniorStoryReviewer', 'ArchitectureAnalyzer', 'ContractManager', 'PrioritizationEngine', 'SeniorTechnicalPlanReviewer', 'TaskManager', 'CoderAgent', 'BuildAgent', 'CodeReviewer', 'FindingsReviewer', 'QuickReviewer', 'TestEngineer', 'GateRunner', 'DocWriter', 'OpenDevopsSpecialist', 'OpenFrontendSpecialist', 'WebResearcher'];
  let denied = false;
  const parent = {id:'OpenStageOrchestrator', mode:'primary', permissions:[
    ...ids.map(resource => ({action:'subagent', resource, effect:'allow'})),
    {action:'bash',resource:'*',effect:'deny'},
    {action:'bash',resource:'$HOME/.config/opencode/node_modules/.bin/tsx $HOME/.config/opencode/skills/task-management/scripts/stage-complete-cli.ts*',effect:'allow'},
  ]};
  await runtime.setup({location:{directory:root},
   tool:{hook:async()=>{}, transform:async fn=>fn({add:t=>registered.set(t.name,t)}),
    list:async()=>['read','shell','subagent','pipeline_runtime_prepare','webfetch','gh_grep_searchGitHub'].map(id=>({id}))},
   session:{hook:async()=>{}},
   agent:{list:async()=>({data:[parent,...ids.map(id=>({id,mode:'subagent',permissions:[
    ...(['CoderAgent','TestEngineer','GateRunner'].includes(id) ? [
      {action:'bash',resource:'*',effect:'deny'},
      {action:'bash',resource:'$HOME/.config/opencode/node_modules/.bin/tsx $HOME/.config/opencode/skills/task-management/scripts/gate-runner-cli.ts * --advisory*',effect:'allow'},
    ] : []),
    ...(id === 'TestEngineer' ? [{action:'bash',resource:'pytest *',effect:'allow'}] : []),
    ...(id === 'OpenDevopsSpecialist' ? [
      {action:'bash',resource:'*',effect:'deny'},
      {action:'bash',resource:'$HOME/.config/opencode/node_modules/.bin/tsx $HOME/.config/opencode/skills/task-management/scripts/runtime-diagnostic-cli.ts *',effect:'allow'},
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

test('a repair dispatch binds its authorized repair paths into the advisory baseline scope', async () => {
 const previousCwd = process.cwd(), root = await tempProject();
 try {
  spawnSync('git',['init'],{cwd:root});
  spawnSync('git',['config','user.email','test@example.invalid'],{cwd:root});
  spawnSync('git',['config','user.name','Test'],{cwd:root});
  await mkdir(path.join(root,'src'),{recursive:true}); await mkdir(path.join(root,'test'),{recursive:true});
  await writeFile(path.join(root,'src','a.ts'),'export const a = 1;\n'); await writeFile(path.join(root,'test','a.test.ts'),'// base\n');
  spawnSync('git',['add','src','test'],{cwd:root}); spawnSync('git',['commit','-m','base'],{cwd:root});
  const manifest = await baseManifest(root,'repair-scope',[{id:'p',stages:['implementation','code-review']}]);
  manifest.allowed_change_paths=['src/**','test/**'];
  manifest.pipelines[0].executors['code-review']='review';
  manifest.pipelines[0].profile='local';
  manifest.gate_profiles={local:{'local-test':['npm test']}};
  manifest.gate_testing={local:{'local-test':{impact_groups:[{inputs:['src/**','test/**'],command_index:0}]}}};
  const workItemRaw=JSON.stringify({id:'wi-p',pipeline_id:'p',stage:'implementation',suggested_agent:'CoderAgent',allowed_change_paths:['src/**']});
  await writeFile(path.join(root,manifest.work_items[0].path),workItemRaw); manifest.work_items[0].sha256=sha(workItemRaw);
  const manifestPath=await writeManifest(root,manifest);
  run(root,['init',manifestPath]); run(root,['approve','repair-scope']); run(root,['start','repair-scope','implementation','--pipeline','p']);
  assert.equal(run(root,['complete','repair-scope','implementation','--pipeline','p']).status,0);
  assert.equal(run(root,['start','repair-scope','code-review','--pipeline','p']).status,0);
  assert.equal(run(root,['scope-check','repair-scope','code-review','test/a.test.ts','--pipeline','p']).status,0);
  const review=path.join(root,'.tmp/pipelines/repair-scope/review-1.json');
  await writeFile(review,JSON.stringify({status:'needs_revision',findings:['test gap']}));
  const charged=run(root,['fix-cycle','repair-scope','code-review','--pipeline','p','--evidence',review]);
  assert.equal(charged.status,0,charged.stderr);
  process.chdir(root);
  await writeBaseProbe(root,'repair-scope','p','local-test');
  const packet=await dispatchPacket(root,'repair-scope','p','implementation','wi-p','CoderAgent');
  assert.deepEqual(packet.work_item_scope,['src/**']);
  assert.deepEqual(packet.repair_paths,['test/a.test.ts']);
  const baseline=JSON.parse(await readFile(path.join(root,'.tmp/pipelines/repair-scope',packet.advisory_checks[0].baseline_path),'utf8'));
  assert.deepEqual(baseline.allowed_change_paths,['src/**','test/a.test.ts']);
  assert.deepEqual(baseline.repair_paths,['test/a.test.ts']);
 } finally { process.chdir(previousCwd); await rm(root,{recursive:true,force:true}); }
});

test('base probe is enforced per profile: a red base admits only a planned repair, a moved base records the gap', async () => {
 const previousCwd = process.cwd(), root = await tempProject();
 try {
  const git=(...args)=>spawnSync('git',args,{cwd:root,encoding:'utf8'});
  git('init'); git('config','user.email','test@example.invalid'); git('config','user.name','Test');
  await mkdir(path.join(root,'src'),{recursive:true});
  await writeFile(path.join(root,'src','a.ts'),'export const a = 1;\n');
  git('add','src'); git('commit','-m','base');
  const manifest = await baseManifest(root,'probe-run',[{id:'p',stages:['implementation']},{id:'q',stages:['implementation']}]);
  manifest.allowed_change_paths=['src/**','lib/**'];
  manifest.pipelines[0].profile='local'; manifest.pipelines[1].profile='other';
  manifest.gate_profiles={local:{'local-test':['npm test']},other:{'local-test':['npm test']}};
  manifest.gate_testing={local:{'local-test':{impact_groups:[{inputs:['src/**'],command_index:0}]}},other:{'local-test':{impact_groups:[{inputs:['lib/**'],command_index:0}]}}};
  for (const [index,id] of [[0,'p'],[1,'q']]) {
    const raw=JSON.stringify({id:`wi-${id}`,pipeline_id:id,stage:'implementation',suggested_agent:'CoderAgent',allowed_change_paths:[id==='p'?'src/**':'lib/**'],...(id==='p'?{baseline_repair:true}:{})});
    await writeFile(path.join(root,manifest.work_items[index].path),raw); manifest.work_items[index].sha256=sha(raw);
  }
  const manifestPath=await writeManifest(root,manifest);
  run(root,['init',manifestPath]); run(root,['approve','probe-run']);
  run(root,['start','probe-run','implementation','--pipeline','p']); run(root,['start','probe-run','implementation','--pipeline','q']);
  process.chdir(root);
  await writeBaseProbe(root,'probe-run','p','local-test','FAIL');
  const repair=await dispatchPacket(root,'probe-run','p','implementation','wi-p','CoderAgent');
  const repairBaseline=JSON.parse(await readFile(path.join(root,'.tmp/pipelines/probe-run',repair.advisory_checks[0].baseline_path),'utf8'));
  assert.deepEqual(repairBaseline.base_probe,{'local-test':'FAIL_REPAIR_PLANNED'});
  // Profile `other` has its own probe requirement even though `local` already dispatched.
  await assert.rejects(dispatchPacket(root,'probe-run','q','implementation','wi-q','CoderAgent'),/BASE_PROBE_REQUIRED/);
  await mkdir(path.join(root,'lib'),{recursive:true});
  await writeFile(path.join(root,'lib','b.ts'),'export const b = 1;\n');
  const moved=await dispatchPacket(root,'probe-run','q','implementation','wi-q','CoderAgent');
  const movedBaseline=JSON.parse(await readFile(path.join(root,'.tmp/pipelines/probe-run',moved.advisory_checks[0].baseline_path),'utf8'));
  assert.deepEqual(movedBaseline.base_probe,{'local-test':'SKIPPED_AFTER_START'});
  // A repeated dispatch of the same work item keeps the first inventory, so earlier edits stay "changed".
  const again=await dispatchPacket(root,'probe-run','q','implementation','wi-q','CoderAgent');
  const againBaseline=JSON.parse(await readFile(path.join(root,'.tmp/pipelines/probe-run',again.advisory_checks[0].baseline_path),'utf8'));
  assert.equal(againBaseline.source_digest,movedBaseline.source_digest);
  assert.equal(againBaseline.first_recorded_at,movedBaseline.recorded_at);
 } finally { process.chdir(previousCwd); await rm(root,{recursive:true,force:true}); }
});

test('a background worker is resumed only after its child session is idle, and the parent sees the decision', async () => {
 const previousCwd=process.cwd(), root=await tempProject();
 try {
  const manifest=await baseManifest(root,'background-run',[{id:'p',stages:['implementation']}]);
  const raw=JSON.stringify({id:'wi-p',pipeline_id:'p',stage:'implementation',suggested_agent:'CoderAgent'});
  await writeFile(path.join(root,manifest.work_items[0].path),raw); manifest.work_items[0].sha256=sha(raw);
  run(root,['init',await writeManifest(root,manifest)]); run(root,['approve',manifest.run_id]); run(root,['start',manifest.run_id,'implementation','--pipeline','p']);
  process.chdir(root);
  let finish; const childDone=new Promise(resolve=>{finish=resolve;});
  const hooks={};
  await runtime.setup({location:{directory:root},tool:{hook:async(name,fn)=>{hooks[name]=fn;},transform:async fn=>fn({add:()=>{}})},
    session:{hook:async()=>{},get:async()=>({data:{}}),wait:async({sessionID})=>{assert.equal(sessionID,'bg-worker'); await childDone;}}});
  const input=()=>({agent:'CoderAgent',background:true,prompt:'<pipeline_work_item id="wi-p"/><pipeline_dispatch run="background-run" pipeline="p" stage="implementation"/>'});
  const registryFile=path.join(root,'.tmp/pipelines/background-run/session-registry.json');
  const metrics=async()=>(await readFile(path.join(root,'.tmp/pipelines/background-run/reuse-metrics/events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);

  const first={tool:'subagent',sessionID:'parent',id:'first',input:input()}; await hooks['execute.before'](first);
  const ack={...first,status:'completed',result:{content:'The subagent is working in the background (sessionID: bg-worker). You will be notified automatically when it finishes.'}};
  await hooks['execute.after'](ack);
  const compact=JSON.parse(ack.result.content);
  assert.equal(compact.status,'running'); assert.equal(compact.child_running,true);
  assert.equal(compact.session_reuse,'fresh:no_prior_session');
  assert.equal(JSON.parse(await readFile(registryFile,'utf8'))[0].status,'background');

  // While the child still works, a new dispatch is refused instead of starting a second worker.
  const busy={tool:'subagent',sessionID:'parent',id:'busy',input:input()};
  await assert.rejects(hooks['execute.before'](busy),/CHILD_STILL_RUNNING: bg-worker/);

  finish(); await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(JSON.parse(await readFile(registryFile,'utf8'))[0].status,'healthy');
  const resume={tool:'subagent',sessionID:'parent',id:'resume',input:input()}; await hooks['execute.before'](resume);
  assert.equal(resume.input.sessionID,'bg-worker');
  const done={...resume,status:'completed',result:{metadata:{sessionID:'bg-worker'},content:'The subagent is working in the background (sessionID: bg-worker). You will be notified automatically when it finishes.'}};
  await hooks['execute.after'](done);
  assert.equal(JSON.parse(done.result.content).session_reuse,'resumed');

  // A watcher lost with a server restart is recovered at the next dispatch.
  const entries=JSON.parse(await readFile(registryFile,'utf8')); entries[0].status='background'; await writeFile(registryFile,JSON.stringify(entries));
  const restarted={};
  await runtime.setup({location:{directory:root},tool:{hook:async(name,fn)=>{restarted[name]=fn;},transform:async fn=>fn({add:()=>{}})},
    session:{hook:async()=>{},get:async()=>({data:{}}),wait:async()=>{}}});
  const after={tool:'subagent',sessionID:'parent',id:'after-restart',input:input()}; await restarted['execute.before'](after);
  assert.equal(after.input.sessionID,'bg-worker');
 } finally {process.chdir(previousCwd);await rm(root,{recursive:true,force:true});}
});

test('a runtime version change during a RUN is surfaced to the parent and recorded', async () => {
 const previousCwd=process.cwd(), root=await tempProject();
 try {
  const manifest=await baseManifest(root,'version-run',[{id:'p',stages:['implementation']}]);
  const raw=JSON.stringify({id:'wi-p',pipeline_id:'p',stage:'implementation',suggested_agent:'CoderAgent'});
  await writeFile(path.join(root,manifest.work_items[0].path),raw); manifest.work_items[0].sha256=sha(raw);
  run(root,['init',await writeManifest(root,manifest)]); run(root,['approve',manifest.run_id]); run(root,['start',manifest.run_id,'implementation','--pipeline','p']);
  process.chdir(root);
  await mkdir(path.join(root,'.tmp/pipelines/version-run'),{recursive:true});
  await writeFile(path.join(root,'.tmp/pipelines/version-run/runtime-version.json'),JSON.stringify({loaded:'older-runtime'}));
  const hooks={};
  await runtime.setup({location:{directory:root},tool:{hook:async(name,fn)=>{hooks[name]=fn;},transform:async fn=>fn({add:()=>{}})},session:{hook:async()=>{},get:async()=>({data:{}})}});
  const packet=await dispatchPacket(root,'version-run','p','implementation','wi-p','CoderAgent');
  const shell={tool:'shell',sessionID:'parent',id:'dispatch',status:'completed',
    input:{command:'npx tsx stage-cli.ts dispatch version-run --pipeline p --stage implementation --work-item wi-p --role CoderAgent --json'},result:{content:JSON.stringify(packet)}};
  await hooks['execute.after'](shell);
  const compact=JSON.parse(shell.result.content);
  assert.equal(compact.runtime_changed_during_run,true);
  assert.equal(compact.runtime_reload_required,undefined);
  const events=(await readFile(path.join(root,'.tmp/pipelines/version-run/reuse-metrics/events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).event,'runtime_version');
 } finally {process.chdir(previousCwd);await rm(root,{recursive:true,force:true});}
});

test('wake decision: only an active RUN with no child, no owner checkpoint and new state is woken', async () => {
  const { wakeDecision } = await import('./orchestrator-wake.mjs');
  const state = (extra = {}) => JSON.stringify({ status: 'in_progress', pipelines: { p: { status: 'in_progress', stages: { implementation: { status: 'completed' }, accept: { status: 'pending' } } } }, ...extra });
  const manifest = { pipelines: [{ id: 'p', executors: { implementation: 'agent', accept: 'owner_acceptance' } }] };
  const first = wakeDecision({ stateRaw: state(), manifest });
  assert.equal(first.wake, true);
  assert.equal(wakeDecision({ stateRaw: state(), manifest, lastFingerprint: first.fingerprint }).reason, 'no_progress_since_last_wake');
  assert.equal(wakeDecision({ stateRaw: state(), manifest, pendingChildren: 1 }).reason, 'child_running');
  assert.equal(wakeDecision({ stateRaw: JSON.stringify({ status: 'blocked' }), manifest }).wake, false);
  assert.equal(wakeDecision({ stateRaw: state({ runtime_replan: { status: 'awaiting_owner_approval' } }), manifest }).reason, 'owner_checkpoint');
  const accepting = JSON.stringify({ status: 'in_progress', pipelines: { p: { status: 'in_progress', stages: { accept: { status: 'in_progress' } } } } });
  assert.equal(wakeDecision({ stateRaw: accepting, manifest }).reason, 'owner_acceptance');
  // One lane waiting for its owner decision does not put the other lanes to sleep.
  const lanes = (q) => JSON.stringify({ status: 'in_progress', pipelines: { p: { status: 'blocked', stages: { implementation: { status: 'blocked' } } }, q } });
  assert.equal(wakeDecision({ stateRaw: lanes({ status: 'in_progress', stages: { implementation: { status: 'pending' } } }), manifest }).wake, true);
  assert.equal(wakeDecision({ stateRaw: lanes({ status: 'completed', stages: {} }), manifest }).reason, 'pipeline_blocked');
});

test('after a restart the session that drives the RUN CLI is woken without a new /pipeline-run prompt', async () => {
  const previousCwd=process.cwd(), root=await tempProject(), previousDelay=process.env.PIPELINE_WAKE_DELAY_MS;
  process.env.PIPELINE_WAKE_DELAY_MS='10';
  try {
    const runDir=path.join(root,'.tmp/pipelines/wake-run'); await mkdir(runDir,{recursive:true});
    await writeFile(path.join(runDir,'state.json'),JSON.stringify({status:'in_progress',pipelines:{}}));
    const hooks={}, synthetic=[]; let push;
    const events={[Symbol.asyncIterator](){return {next:()=>new Promise(resolve=>{push=value=>resolve({value,done:false});})};}};
    await runtime.setup({location:{directory:root},tool:{hook:async(name,fn)=>{hooks[name]=fn;},transform:async fn=>fn({add:()=>{}})},
      event:{subscribe:()=>events},
      session:{hook:async()=>{},get:async()=>({data:{}}),wait:async()=>{},synthetic:async input=>{synthetic.push(input);}}});
    process.chdir(root);
    await hooks['execute.before']({tool:'shell',sessionID:'orch',id:'c1',input:{command:'$HOME/.config/opencode/node_modules/.bin/tsx $HOME/.config/opencode/skills/task-management/scripts/stage-cli.ts waves wake-run --json'}});
    await new Promise(resolve=>setTimeout(resolve,5));
    push({type:'session.execution.succeeded',data:{sessionID:'orch'}});
    await new Promise(resolve=>setTimeout(resolve,60));
    assert.equal(synthetic.length,1);
    assert.match(synthetic[0].text,/wake-run/);
  } finally {
    if (previousDelay===undefined) delete process.env.PIPELINE_WAKE_DELAY_MS; else process.env.PIPELINE_WAKE_DELAY_MS=previousDelay;
    process.chdir(previousCwd); await rm(root,{recursive:true,force:true});
  }
});

test('an OpenStage turn that ends with nothing running is woken once', async () => {
  const previousCwd=process.cwd(), root=await tempProject(), previousDelay=process.env.PIPELINE_WAKE_DELAY_MS;
  process.env.PIPELINE_WAKE_DELAY_MS='10';
  try {
    const runDir=path.join(root,'.tmp/pipelines/wake-run'); await mkdir(runDir,{recursive:true});
    await writeFile(path.join(runDir,'state.json'),JSON.stringify({status:'in_progress',pipelines:{}}));
    const sessionHooks={}, synthetic=[]; let push;
    const events={[Symbol.asyncIterator](){return {next:()=>new Promise(resolve=>{push=value=>resolve({value,done:false});})};}};
    await runtime.setup({location:{directory:root},tool:{hook:async()=>{},transform:async fn=>fn({add:()=>{}})},
      event:{subscribe:()=>events},
      session:{hook:async(name,fn)=>{sessionHooks[name]=fn;},get:async()=>({data:{}}),wait:async()=>{},synthetic:async input=>{synthetic.push(input);}}});
    process.chdir(root);
    sessionHooks.prompt({sessionID:'orch',prompt:{text:'/pipeline-run wake-run --unattended'}});
    await new Promise(resolve=>setTimeout(resolve,5));
    push({type:'session.execution.succeeded',data:{sessionID:'orch'}});
    await new Promise(resolve=>setTimeout(resolve,60));
    assert.equal(synthetic.length,1);
    assert.match(synthetic[0].text,/<pipeline_wake\/>.*wake-run/);
    assert.equal(synthetic[0].resume,true);
    push({type:'session.execution.succeeded',data:{sessionID:'orch'}});
    await new Promise(resolve=>setTimeout(resolve,60));
    assert.equal(synthetic.length,1);
  } finally {
    if (previousDelay===undefined) delete process.env.PIPELINE_WAKE_DELAY_MS; else process.env.PIPELINE_WAKE_DELAY_MS=previousDelay;
    process.chdir(previousCwd); await rm(root,{recursive:true,force:true});
  }
});

test('a plan probe at the clean HEAD replaces the base probe; a stale PASS does not, a FAIL counts as a red base', async () => {
 const previousCwd = process.cwd(), root = await tempProject();
 try {
  const git=(...args)=>spawnSync('git',args,{cwd:root,encoding:'utf8'});
  git('init'); git('config','user.email','test@example.invalid'); git('config','user.name','Test');
  await mkdir(path.join(root,'src'),{recursive:true});
  await writeFile(path.join(root,'src','a.ts'),'export const a = 1;\n');
  git('add','src'); git('commit','-m','base');
  const head=git('rev-parse','HEAD').stdout.trim();
  const manifest = await baseManifest(root,'plan-probe-run',[{id:'p',stages:['implementation']}]);
  manifest.allowed_change_paths=['src/**'];
  manifest.pipelines[0].profile='local';
  manifest.gate_profiles={local:{'local-test':['npm test']}};
  manifest.gate_testing={local:{'local-test':{impact_groups:[{inputs:['src/**'],command_index:0}]}}};
  const raw=JSON.stringify({id:'wi-p',pipeline_id:'p',stage:'implementation',suggested_agent:'CoderAgent',allowed_change_paths:['src/**']});
  await writeFile(path.join(root,manifest.work_items[0].path),raw); manifest.work_items[0].sha256=sha(raw);
  const manifestPath=await writeManifest(root,manifest);
  run(root,['init',manifestPath]); run(root,['approve','plan-probe-run']); run(root,['start','plan-probe-run','implementation','--pipeline','p']);
  process.chdir(root);
  const probeDir=path.join(root,'planning/probes'); // the manifest sits in the run directory (here: the project root)
  await mkdir(probeDir,{recursive:true});
  const writeProbe=(overrides)=>writeFile(path.join(probeDir,'p-local-test.json'),JSON.stringify({kind:'plan_probe',status:'PASS',run_id:'plan-probe-run',pipeline_id:'p',gate:'local-test',profile:'local',head_sha:head,base_sha:head,commands_sha256:sha(JSON.stringify(['npm test'])),...overrides}));
  await writeProbe({commands_sha256:'f'.repeat(64)});
  await assert.rejects(dispatchPacket(root,'plan-probe-run','p','implementation','wi-p','CoderAgent'),/BASE_PROBE_REQUIRED/);
  await writeProbe({head_sha:'b'.repeat(40)});
  await assert.rejects(dispatchPacket(root,'plan-probe-run','p','implementation','wi-p','CoderAgent'),/BASE_PROBE_REQUIRED/);
  await writeProbe({status:'FAIL'});
  await assert.rejects(dispatchPacket(root,'plan-probe-run','p','implementation','wi-p','CoderAgent'),/BASE_RED_REPAIR_REQUIRED/);
  await writeProbe({});
  const packet=await dispatchPacket(root,'plan-probe-run','p','implementation','wi-p','CoderAgent');
  const baseline=JSON.parse(await readFile(path.join(root,'.tmp/pipelines/plan-probe-run',packet.advisory_checks[0].baseline_path),'utf8'));
  assert.deepEqual(baseline.base_probe,{'local-test':'PASS'});
 } finally { process.chdir(previousCwd); await rm(root,{recursive:true,force:true}); }
});

test('waves start independent work items together and hold back dependents and paths a live worker may change', async () => {
 const previousCwd = process.cwd(), root = await tempProject();
 try {
  const git=(...args)=>spawnSync('git',args,{cwd:root,encoding:'utf8'});
  git('init'); git('config','user.email','test@example.invalid'); git('config','user.name','Test');
  await mkdir(path.join(root,'src'),{recursive:true});
  await writeFile(path.join(root,'src','a.ts'),'export const a = 1;\n');
  git('add','src'); git('commit','-m','base');
  const manifest = await baseManifest(root,'waves-run',[{id:'p',stages:['implementation']}]);
  manifest.allowed_change_paths=['src/**'];
  const item = async (id, extra) => {
    const raw=JSON.stringify({id,pipeline_id:'p',stage:'implementation',suggested_agent:'CoderAgent',...extra});
    return {id,pipeline_id:'p',...await frozen(root,`work-items/${id}.json`,raw)};
  };
  manifest.work_items=[await item('a',{allowed_change_paths:['src/a/**']}), await item('b',{depends_on:['a'],allowed_change_paths:['src/a/x.ts']}), await item('c',{allowed_change_paths:['src/c/**']})];
  manifest.pipelines[0].work_items=['a','b','c'];
  const manifestPath=await writeManifest(root,manifest);
  run(root,['init',manifestPath]); run(root,['approve','waves-run']); run(root,['start','waves-run','implementation','--pipeline','p']);
  process.chdir(root);
  const { workItemWaves } = await import('./pipeline-dispatch.ts');
  const { writeLease, removeLease, recordStagePaths } = await import('./dispatch-leases.mjs');
  const runRoot=path.join(root,'.tmp/pipelines/waves-run');
  const wave = async () => (await workItemWaves(root,'waves-run')).stages[0];

  let current = await wave();
  assert.deepEqual(current.dispatchable,['a','c']);
  assert.deepEqual(current.waiting,[{id:'b',reason:'depends_on a'}]);

  const leaseA={run_id:'waves-run',pipeline_id:'p',stage:'implementation',work_item_id:'a',role:'CoderAgent',scope:['src/a/**']};
  writeLease(runRoot,leaseA);
  current = await wave();
  assert.deepEqual(current.running,['a']);
  assert.deepEqual(current.dispatchable,['c']);
  await assert.rejects(dispatchPacket(root,'waves-run','p','implementation','b','CoderAgent'),/DISPATCH_DEPENDENCY_PENDING: b waits for a/);

  // A path authorized at runtime for this stage joins the live lease: c may not start on it.
  recordStagePaths(runRoot,'p','implementation',['src/c/z.ts']);
  await assert.rejects(dispatchPacket(root,'waves-run','p','implementation','c','CoderAgent'),/DISPATCH_SCOPE_BUSY: c waits for a \(p\/implementation\), both change src\/c\/\*\*/);
  const busy = run(root,['scope-check','waves-run','implementation','src/a/q.ts','--pipeline','p','--json']);
  assert.match(busy.stdout,/"status": "PASS"/);

  // The worker returned: its lease is gone and the registry records it done.
  removeLease(runRoot,leaseA);
  await writeFile(path.join(runRoot,'session-registry.json'),JSON.stringify([{run_id:'waves-run',pipeline_id:'p',stage:'implementation',role:'CoderAgent',work_item_id:'a',session_id:'s-a',status:'healthy',updated_at:new Date().toISOString()}]));
  current = await wave();
  assert.deepEqual(current.done,['a']);
  assert.deepEqual(current.dispatchable,['b']);
  assert.deepEqual(current.waiting,[{id:'c',reason:'shares paths with b in this wave'}]);
  const packet = await dispatchPacket(root,'waves-run','p','implementation','b','CoderAgent');
  assert.ok(packet.write_scope.includes('src/a/x.ts') && packet.write_scope.includes('src/c/z.ts'));

  // A lease left by a dead OpenCode process says nothing about a running worker.
  writeLease(runRoot,{...leaseA,work_item_id:'b',scope:['src/a/x.ts','src/c/z.ts']});
  const file=path.join(runRoot,'checks/active-dispatches',(await import('node:fs')).readdirSync(path.join(runRoot,'checks/active-dispatches'))[0]);
  await writeFile(file,JSON.stringify({...JSON.parse(await readFile(file,'utf8')),owner_pid:2147483646}));
  current = await wave();
  assert.deepEqual(current.running,[]);
 } finally { process.chdir(previousCwd); await rm(root,{recursive:true,force:true}); }
});

test('a gate passed on a tree snapshot completes only while the lane files still match that snapshot', async () => {
 const previousCwd = process.cwd(), root = await tempProject();
 try {
  const git=(...args)=>spawnSync('git',args,{cwd:root,encoding:'utf8'});
  git('init'); git('config','user.email','test@example.invalid'); git('config','user.name','Test');
  await mkdir(path.join(root,'src'),{recursive:true});
  await writeFile(path.join(root,'src','a.ts'),'export const a = 1;\n');
  await writeFile(path.join(root,'src','b.ts'),'export const b = 1;\n');
  git('add','src'); git('commit','-m','base');
  const manifest = await baseManifest(root,'lane-run',[{id:'p',stages:['implementation','fail-fast']}]);
  manifest.allowed_change_paths=['src/**'];
  manifest.pipelines[0].executors['fail-fast']='local_gate';
  manifest.pipelines[0].profile='local';
  manifest.gate_profiles={local:{'fail-fast':['npm test']}};
  const raw=JSON.stringify({id:'wi-p',pipeline_id:'p',stage:'implementation',suggested_agent:'CoderAgent',allowed_change_paths:['src/a.ts']});
  await writeFile(path.join(root,manifest.work_items[0].path),raw); manifest.work_items[0].sha256=sha(raw);
  const manifestPath=await writeManifest(root,manifest);
  run(root,['init',manifestPath]); run(root,['approve','lane-run']);
  run(root,['start','lane-run','implementation','--pipeline','p']); run(root,['complete','lane-run','implementation','--pipeline','p']);
  run(root,['start','lane-run','fail-fast','--pipeline','p']);
  const { sourceInventory, scopedInventoryDigest } = await import('./gate-diagnostics.mjs');
  const invoke=(exe,argv)=>{ const r=spawnSync(exe,argv,{cwd:root,encoding:'utf8'}); return Promise.resolve({exit_code:r.status,stdout:r.stdout,stderr:r.stderr,truncated:false}); };
  const files=(await sourceInventory(root,invoke)).files;
  const gates=path.join(root,'.tmp/pipelines/lane-run/gates'); await mkdir(gates,{recursive:true});
  await writeFile(path.join(gates,'p-fail-fast.json'),JSON.stringify({status:'PASS',run_id:'lane-run',pipeline_id:'p',gate:'fail-fast',
    snapshot:{status:'used',commit:'c'.repeat(40),lane_scope:['src/a.ts'],lane_scope_digest:scopedInventoryDigest(files,['src/a.ts'])}}));
  // Another lane's file moving on does not matter; this lane's file does.
  await writeFile(path.join(root,'src','b.ts'),'export const b = 2;\n');
  await writeFile(path.join(root,'src','a.ts'),'export const a = 2;\n');
  const stale=spawnSync('npx',['--yes','tsx',STAGE_CLI,'complete','lane-run','fail-fast','--pipeline','p'],{cwd:root,encoding:'utf8'});
  assert.notEqual(stale.status,0); assert.match(stale.stderr,/EVIDENCE_STALE_LANE_SOURCE: local_gate p\/fail-fast/);
  await writeFile(path.join(root,'src','a.ts'),'export const a = 1;\n');
  run(root,['complete','lane-run','fail-fast','--pipeline','p']);
 } finally { process.chdir(previousCwd); await rm(root,{recursive:true,force:true}); }
});

test('a lane in its gate or review reserves its planned files, not shared runtime paths, until it is ready', async () => {
 const previousCwd = process.cwd(), root = await tempProject();
 try {
  const git=(...args)=>spawnSync('git',args,{cwd:root,encoding:'utf8'});
  git('init'); git('config','user.email','test@example.invalid'); git('config','user.name','Test');
  await mkdir(path.join(root,'src'),{recursive:true});
  await writeFile(path.join(root,'src','a.ts'),'export const a = 1;\n');
  git('add','src'); git('commit','-m','base');
  const manifest = await baseManifest(root,'reserve-run',[{id:'p',stages:['implementation','fail-fast'],ready_after_stage:'fail-fast'},{id:'q',stages:['implementation']}]);
  manifest.allowed_change_paths=['src/**'];
  manifest.generated_paths=['src/p/gen.json'];
  manifest.pipelines[0].executors['fail-fast']='local_gate';
  manifest.pipelines[0].profile='local';
  manifest.gate_profiles={local:{'fail-fast':['npm test']}};
  for (const [index, scope] of [[0,['src/p/**']],[1,['src/q/**']]]) {
    const item=manifest.work_items[index];
    const raw=JSON.stringify({id:item.id,pipeline_id:item.pipeline_id,stage:'implementation',suggested_agent:'CoderAgent',allowed_change_paths:scope});
    await writeFile(path.join(root,item.path),raw); item.sha256=sha(raw);
  }
  const manifestPath=await writeManifest(root,manifest);
  run(root,['init',manifestPath]); run(root,['approve','reserve-run']);
  run(root,['start','reserve-run','implementation','--pipeline','q']);
  run(root,['start','reserve-run','implementation','--pipeline','p']);
  run(root,['scope-check','reserve-run','implementation','src/shared/registry.ts','--pipeline','p','--json']);
  // While p is still implementing, q may be granted a path of p (no live worker holds it).
  run(root,['scope-check','reserve-run','implementation','src/p/early.ts','--pipeline','q','--json']);
  run(root,['complete','reserve-run','implementation','--pipeline','p']);
  run(root,['start','reserve-run','fail-fast','--pipeline','p']);
  const refused=spawnSync('npx',['--yes','tsx',STAGE_CLI,'scope-check','reserve-run','implementation','src/p/a.ts','--pipeline','q','--json'],{cwd:root,encoding:'utf8'});
  assert.notEqual(refused.status,0); assert.match(refused.stderr,/SCOPE_BUSY: src\/p\/a\.ts is being changed by lane p in its gate or review \(p\/gate\)/);
  run(root,['scope-check','reserve-run','implementation','src/p/gen.json','--pipeline','q','--json']);
  // A shared path scope-check granted p at runtime is not reserved: q changes it at once.
  run(root,['scope-check','reserve-run','implementation','src/shared/registry.ts','--pipeline','q','--json']);
  process.chdir(root);
  const { workItemWaves } = await import('./pipeline-dispatch.ts');
  // q's stage now also owns src/p/early.ts, which p's reservation covers: its item waits.
  const q=(await workItemWaves(root,'reserve-run','q')).stages[0];
  assert.deepEqual(q.waiting,[{id:'wi-q',reason:'src/p/early.ts is being changed by lane p in its gate or review'}]);
  await mkdir(path.join(root,'.tmp/pipelines/reserve-run/gates'),{recursive:true});
  await writeFile(path.join(root,'.tmp/pipelines/reserve-run/gates/p-fail-fast.json'),JSON.stringify({status:'PASS',run_id:'reserve-run',pipeline_id:'p',gate:'fail-fast'}));
  run(root,['complete','reserve-run','fail-fast','--pipeline','p']);
  run(root,['scope-check','reserve-run','implementation','src/p/a.ts','--pipeline','q','--json']);
 } finally { process.chdir(previousCwd); await rm(root,{recursive:true,force:true}); }
});
