import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { beginUnfreeze, finalizeUnfreeze, abortUnfreeze } from './pipeline-unfreeze-cli.ts';
const hash=raw=>createHash('sha256').update(raw).digest('hex');
const rootID='owner-controlled-run';
const sourceSpec={id:'source',stages:['implementation','tests'],executors:{implementation:'agent',tests:'local_gate'},depends_on:[]};
const depSpec={id:'dependent',stages:['implementation','tests'],executors:{implementation:'agent',tests:'local_gate'},depends_on:['source']};
const aloneSpec={id:'independent',stages:['implementation'],executors:{implementation:'agent'},depends_on:[]};
async function fixture(opts={}) {
  const root=await mkdtemp(join(tmpdir(),'pipeline-unfreeze-'));
  const stateRoot=join(root,'pipelines'),runDir=join(stateRoot,rootID);
  await mkdir(join(runDir,'owner'),{recursive:true});
  await mkdir(join(runDir,'planning'),{recursive:true});
  const independentSpec=opts.releaseTail ? {id:'independent',
    stages:['implementation','git_verify','local-check','git_publish','dev_deploy'],
    executors:{implementation:'agent',git_verify:'git_verify','local-check':'local_gate',git_publish:'git_publish',dev_deploy:'dev_deploy'},depends_on:[]} : aloneSpec;
  const original={schema_version:2,run_id:rootID,git_setup:{branch:'task',base_sha:'a'.repeat(40)},
    planning_readiness:{gates:{architecture:{status:'ready'}}},
    pipelines:[sourceSpec,depSpec,independentSpec],gate_profiles:{},gate_testing:{}};
  const raw=JSON.stringify(original,null,2)+'\n';
  await writeFile(join(runDir,'manifest.json'),raw);
  const runtime=(p,status)=>({id:p.id,status,stages:Object.fromEntries(p.stages.map(name=>[name,{status:'completed',completed_at:'2026-11-15T00:00:00Z'}])),stage_order:[...p.stages],depends_on:[...p.depends_on]});
  const state={schema_version:1,run_id:rootID,manifest_sha256:hash(raw),status:'in_progress',
    implementation_started_at:'2026-11-15T00:00:00Z',active_stages:[],
    pipelines:{source:runtime(sourceSpec,'completed'),dependent:runtime(depSpec,'completed'),independent:runtime(independentSpec,'completed')},
    history:[],approval_record:{subject:'final-manifest',decision:'approved',shown_manifest_sha256:hash(raw),current_manifest_sha256:hash(raw),owner_response:'Approved',run_id:rootID}};
  if(opts.active)state.pipelines.source.stages.implementation.status='in_progress';
  if(opts.repairHistory){
    Object.assign(state.pipelines.source.stages.tests,{technical_fix_cycles:3,technical_fix_limit:7,
      defect_class_history:[{cycle:3,classes:['error_a'],evidence_sha256:'b'.repeat(64)}]});
  }
  await writeFile(join(runDir,'state.json'),JSON.stringify(state,null,2)+'\n');
  await writeFile(join(runDir,'planning/architecture.md'),'original architecture\n');
  const owner={run_id:rootID,manifest_sha256:hash(raw),owner_decision:'approved',
    owner_response:'Approve unfreeze of source branch',owner_message_id:'message-123',
    owner_source_session:'session-123',affected_pipelines:['source'],
    affected_gates:['architecture'],allowed_plan_paths:['manifest.json','planning/architecture.md','planning/senior-review.json'],
    reason:'Structural architecture change after implementation began'};
  const approval=join(runDir,'owner/approve-unfreeze.json');
  await writeFile(approval,JSON.stringify(owner));
  const revise=async(params={})=>{
    const next=structuredClone(original);
    next.pipelines[0]={...sourceSpec,stages:['implementation','tests','security-review'],
      executors:{...sourceSpec.executors,'security-review':'agent'}};
    Object.assign(next,params);
    const nextRaw=JSON.stringify(next,null,2)+'\n';
    await writeFile(join(runDir,'manifest.json'),nextRaw);
    await writeFile(join(runDir,'planning/architecture.md'),'revised architecture\n');
    const senior={reviewer:'SeniorTechnicalPlanReviewer',status:'ready',reviewed_manifest_sha256:hash(nextRaw),blocking_findings:[]};
    const seniorRaw=JSON.stringify(senior);
    await writeFile(join(runDir,'planning/senior-review.json'),seniorRaw);
    const review={run_id:rootID,original_manifest_sha256:hash(raw),revised_manifest_sha256:hash(nextRaw),
      owner_decision:'approved',owner_response:'Approve revised frozen contract',
      owner_message_id:'message-456',owner_source_session:'session-123',
      review_status:'ready',reviewed_gates:['architecture'],
      architecture_changed:true,senior_technical_plan_review:'ready',independent_reviewer_id:'senior-reviewer',
      senior_technical_review_path:'planning/senior-review.json',senior_technical_review_sha256:hash(seniorRaw)};
    const file=join(runDir,'owner/final-refreeze-approval.json');
    await writeFile(file,JSON.stringify(review));
    return file;
  };
  return {root,stateRoot,runDir,approval,raw,original,state,revise};
}
test('O7: beginning requires real owner-bound evidence and no active stage',async()=>{
  const f=await fixture({active:true});
  try {await assert.rejects(beginUnfreeze(f.stateRoot,rootID,f.approval,{validateWorktree:()=>{}}),/UNFREEZE_WORKER_ACTIVE/);}
  finally{await rm(f.root,{recursive:true,force:true});}
});
test('O7: owner-authorized in-place refreeze preserves unaffected pipeline and audit',async()=>{
  const f=await fixture();
  try {
    const originalIndependent=JSON.stringify(f.state.pipelines.independent);
    const started=await beginUnfreeze(f.stateRoot,rootID,f.approval,{validateWorktree:()=>{}});
    assert.equal(started.status,'PASS');
    await assert.rejects(beginUnfreeze(f.stateRoot,rootID,f.approval,{validateWorktree:()=>{}}),/UNFREEZE_ALREADY_ACTIVE/);
    const reviewed=await f.revise();
    const finished=await finalizeUnfreeze(f.stateRoot,rootID,reviewed,{validateFrozenPlan:async()=>{},validateWorktree:()=>{}});
    assert.equal(finished.run_id,rootID);
    assert.deepEqual(finished.affected_pipelines.sort(),['dependent','source']);
    assert.deepEqual(finished.unaffected_pipelines,['independent']);
    const state=JSON.parse(await readFile(join(f.runDir,'state.json'),'utf8'));
    assert.equal(JSON.stringify(state.pipelines.independent),originalIndependent);
    assert.equal(state.pipelines.source.stages.tests.status,'pending');
    assert.equal(state.pipelines.dependent.stages.tests.status,'pending');
    assert.equal(state.pipelines.source.stages['security-review'].status,'pending');
    assert.equal(state.approval_record.current_manifest_sha256,state.manifest_sha256);
    await assert.rejects(readFile(join(f.runDir,'planning/unfreeze-active.json')),/ENOENT/);
    const audit=join(f.runDir,'planning/unfreeze-revisions',started.revision_id);
    assert.equal(hash(await readFile(join(audit,'manifest.json'),'utf8')),hash(f.raw));
    assert.equal((await readFile(join(audit,'state.json'),'utf8')).includes('"run_id": "owner-controlled-run"'),true);
  }finally{await rm(f.root,{recursive:true,force:true});}
});
test('O7: unapproved changes and stale reviewed SHA do not refreeze',async()=>{
  const f=await fixture();
  try {
    await beginUnfreeze(f.stateRoot,rootID,f.approval,{validateWorktree:()=>{}});
    const review=await f.revise();
    await writeFile(join(f.runDir,'planning/extra.md'),'undocumented edit');
    await assert.rejects(finalizeUnfreeze(f.stateRoot,rootID,review,{validateFrozenPlan:async()=>{},validateWorktree:()=>{}}),/UNFREEZE_PLAN_SCOPE_CHANGED/);
    await rm(join(f.runDir,'planning/extra.md'));
    const modified=JSON.parse(await readFile(review,'utf8'));
    modified.revised_manifest_sha256='0'.repeat(64);
    await writeFile(review,JSON.stringify(modified));
    await assert.rejects(finalizeUnfreeze(f.stateRoot,rootID,review,{validateFrozenPlan:async()=>{},validateWorktree:()=>{}}),/UNFREEZE_REVISED_OWNER_APPROVAL_OR_REVIEW_REQUIRED/);
  }finally{await rm(f.root,{recursive:true,force:true});}
});
test('O7: a published candidate cannot remain valid after refreeze',async()=>{
  const f=await fixture();
  try{
    await writeFile(join(f.runDir,'candidate.json'),'{"sha":"stale"}');
    const started=await beginUnfreeze(f.stateRoot,rootID,f.approval,{validateWorktree:()=>{}});
    const reviewed=await f.revise();
    const end=await finalizeUnfreeze(f.stateRoot,rootID,reviewed,{validateFrozenPlan:async()=>{},validateWorktree:()=>{}});
    assert.equal(end.candidate_invalidated,true);
    await assert.rejects(readFile(join(f.runDir,'candidate.json')),/ENOENT/);
    assert.equal(JSON.parse(await readFile(join(f.runDir,'planning/unfreeze-revisions',started.revision_id,'obsolete-candidate.json'))).sha,'stale');
    const current=JSON.parse(await readFile(join(f.runDir,'state.json')));
    assert.equal(current.pipelines.independent.stages.implementation.status,'completed');
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test('O7: owner can decline and abort only before any approved PLAN artifact changed',async()=>{
  const f=await fixture();
  try {
    await beginUnfreeze(f.stateRoot,rootID,f.approval,{validateWorktree:()=>{}});
    const reject=join(f.runDir,'owner/decline.json');
    await writeFile(reject,JSON.stringify({run_id:rootID,manifest_sha256:hash(f.raw),
      owner_decision:'declined',owner_response:'No changes to the current plan',
      owner_message_id:'message-789',owner_source_session:'session-123'}));
    const outcome=await abortUnfreeze(f.stateRoot,rootID,reject,{validateWorktree:()=>{}});
    assert.equal(outcome.status,'PASS');
    await assert.rejects(readFile(join(f.runDir,'planning/unfreeze-active.json')),/ENOENT/);
    await assert.rejects(abortUnfreeze(f.stateRoot,rootID,reject,{validateWorktree:()=>{}}),/UNFREEZE_NOT_STARTED/);
  } finally { await rm(f.root,{recursive:true,force:true}); }
});
test('O7: changed PLAN cannot silently roll back through unfreeze abort',async()=>{
  const f=await fixture();
  try {
    await beginUnfreeze(f.stateRoot,rootID,f.approval,{validateWorktree:()=>{}});
    await writeFile(join(f.runDir,'planning/architecture.md'),'changed');
    const reject=join(f.runDir,'owner/decline.json');
    await writeFile(reject,JSON.stringify({run_id:rootID,manifest_sha256:hash(f.raw),
      owner_decision:'declined',owner_response:'Cancel after edit',
      owner_message_id:'message-789',owner_source_session:'session-123'}));
    await assert.rejects(abortUnfreeze(f.stateRoot,rootID,reject,{validateWorktree:()=>{}}),/UNFREEZE_CANNOT_ABORT_EDITED_PLAN/);
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

test('O7: production entry refuses an unverified owner worktree',async()=>{
  const f=await fixture();
  try {
    await assert.rejects(beginUnfreeze(f.stateRoot,rootID,f.approval),/UNFREEZE_WORKTREE_INVALID|UNFREEZE_WORKTREE_BRANCH_MISMATCH|UNFREEZE_LINKED_WORKTREE_REQUIRED/);
  } finally {await rm(f.root,{recursive:true,force:true});}
});

test('O7: a reopened machine gate retains charged repair budget and defect class evidence',async()=>{
  const f=await fixture({repairHistory:true});
  try {
    await beginUnfreeze(f.stateRoot,rootID,f.approval,{validateWorktree:()=>{}});
    const review=await f.revise();
    await finalizeUnfreeze(f.stateRoot,rootID,review,{validateFrozenPlan:async()=>{},validateWorktree:()=>{}});
    const now=JSON.parse(await readFile(join(f.runDir,'state.json'),'utf8'));
    const gate=now.pipelines.source.stages.tests;
    assert.equal(gate.status,'pending');
    assert.equal(gate.technical_fix_cycles,3);
    assert.equal(gate.technical_fix_limit,7);
    assert.equal(gate.defect_class_history[0].classes[0],'error_a');
    assert.equal(gate.completed_at,undefined);
  }finally{await rm(f.root,{recursive:true,force:true});}
});
test('O7: stale candidate invalidates git_verify, full gate, publish and deploy, preserving independent source',async()=>{
  const f=await fixture({releaseTail:true});
  try{
    await writeFile(join(f.runDir,'candidate.json'),'{"sha":"old-candidate"}');
    await beginUnfreeze(f.stateRoot,rootID,f.approval,{validateWorktree:()=>{}});
    const review=await f.revise();
    await finalizeUnfreeze(f.stateRoot,rootID,review,{validateFrozenPlan:async()=>{},validateWorktree:()=>{}});
    const current=JSON.parse(await readFile(join(f.runDir,'state.json'),'utf8')).pipelines.independent;
    assert.equal(current.stages.implementation.status,'completed');
    for(const name of ['git_verify','local-check','git_publish','dev_deploy']){
      assert.equal(current.stages[name].status,'pending',name);
      assert.equal(current.stages[name].completed_at,undefined,name);
    }
  }finally{await rm(f.root,{recursive:true,force:true});}
});
