// Owner-authorized, recoverable in-place structural PLAN unfreeze.
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, relative, sep, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { hasActiveStages, implementationStarted } from './plan-lifecycle.ts';
import { readLeases } from './dispatch-leases.mjs';

const hash = raw => createHash('sha256').update(raw).digest('hex');
const idValid = value => typeof value === 'string' && /^[a-zA-Z0-9][\w.-]{0,127}$/.test(value);
const safeRelative = value => typeof value === 'string' && value.length > 0 &&
  !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') &&
  !value.split('/').some(x => x === '..' || x === '.' || x === '');
async function fileJSON(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function optional(file) { try { return await fileJSON(file); } catch(e) { if(e.code==='ENOENT')return null; throw e; } }
async function atomic(file, object) {
  const temp = file + '.tmp-' + process.pid;
  await fs.writeFile(temp,JSON.stringify(object,null,2)+'\n',{flag:'wx'});
  await fs.rename(temp,file);
}
function inside(root,file) {
  const absolute=resolve(file);
  if (!absolute.startsWith(root+sep)) throw Error('UNFREEZE_EVIDENCE_OUTSIDE_RUN');
  return absolute;
}
async function runRoot(stateRoot,run) {
  if(!idValid(run))throw Error('UNFREEZE_RUN_ID_INVALID');
  const root=resolve(stateRoot,run);
  const state=await fileJSON(join(root,'state.json'));
  const manifestRaw=await fs.readFile(join(root,'manifest.json'),'utf8');
  const manifest=JSON.parse(manifestRaw);
  if (state.run_id!==run || manifest.run_id!==run || manifest.schema_version!==2)throw Error('UNFREEZE_RUN_MISMATCH');
  return {root,state,manifest,manifestRaw,manifestHash:hash(manifestRaw)};
}
function inFlight(root,state) {
  if(hasActiveStages(state))throw Error('UNFREEZE_WORKER_ACTIVE');
  if(readLeases(root,{state}).length)throw Error('UNFREEZE_DISPATCH_LEASE_ACTIVE');
}
function ownerAuthorization(evidence,run,sha) {
  if(evidence?.run_id!==run||evidence?.manifest_sha256!==sha ||
      evidence?.owner_decision!=='approved' ||
      typeof evidence.owner_response!=='string'||!evidence.owner_response.trim() ||
      typeof evidence.owner_message_id!=='string'||!evidence.owner_message_id.trim() ||
      typeof evidence.owner_source_session!=='string'||!evidence.owner_source_session.trim()) throw Error('UNFREEZE_OWNER_APPROVAL_REQUIRED');
  const paths=evidence.allowed_plan_paths;
  const ids=evidence.affected_pipelines;
  if(!Array.isArray(paths)||!paths.length||paths.some(x=>!safeRelative(x)||!(/^(?:stories\/|planning\/|work-items\/|manifest\.json$)/.test(x)))) throw Error('UNFREEZE_ALLOWED_PLAN_PATHS_INVALID');
  if(!paths.includes('manifest.json')||!Array.isArray(ids)||!ids.length||ids.some(x=>!idValid(x))||new Set(ids).size!==ids.length)throw Error('UNFREEZE_AFFECTED_SCOPE_INVALID');
  if(!Array.isArray(evidence.affected_gates)||!evidence.affected_gates.length ||
      evidence.affected_gates.some(x=>!idValid(x))) throw Error('UNFREEZE_PLANNING_GATES_REQUIRED');
  if(typeof evidence.reason!=='string'||!evidence.reason.trim())throw Error('UNFREEZE_REASON_REQUIRED');
}
async function acquire(root,fn) {
  const path=join(root,'.lock');
  const handle=await fs.open(path,'wx');
  try { await handle.writeFile(String(process.pid)); return await fn(); }
  finally { await handle.close(); await fs.rm(path,{force:true}); }
}
async function inventory(root) {
  const entries={};
  const walk=async(relativeDir)=>{
    const abs=join(root,relativeDir);
    for(const item of await fs.readdir(abs,{withFileTypes:true}).catch(e=>e.code==='ENOENT'?[]:Promise.reject(e))){
      const path=relativeDir?relativeDir+'/'+item.name:item.name;
      if(path.startsWith('planning/unfreeze-revisions/')||path==='planning/unfreeze-active.json'||
         path.startsWith('planning/unfreeze-review-'))continue;
      if(item.isSymbolicLink())throw Error('UNFREEZE_PLANNING_SYMLINK: '+path);
      if(item.isDirectory())await walk(path);
      else if(item.isFile())entries[path]=hash(await fs.readFile(join(root,path)));
    }
  };
  await walk('stories');
  await walk('planning');
  await walk('work-items');
  return entries;
}
async function snapshot(root,version,c) {
  const dir=join(root,'planning/unfreeze-revisions',version);
  await fs.mkdir(dir,{recursive:true});
  for(const [name,content] of [
    ['manifest.json',c.manifestRaw],
    ['state.json',JSON.stringify(c.state,null,2)+'\n'],
  ]){
    const target=join(dir,name);
    try { await fs.writeFile(target,content,{flag:'wx'}); }
    catch(error) {
      if(error.code!=='EEXIST'||await fs.readFile(target,'utf8')!==content)
        throw Error('UNFREEZE_IMMUTABLE_AUDIT_CONFLICT: '+name);
    }
  }
  return dir;
}
export async function beginUnfreeze(stateRoot,run,evidencePath) {
  const c=await runRoot(stateRoot,run);
  return acquire(c.root,async()=>{
    const t=await runRoot(stateRoot,run);
    if(t.state.manifest_sha256!==t.manifestHash)throw Error('UNFREEZE_MANIFEST_STALE');
    if(!implementationStarted(t.state,t.manifest))throw Error('UNFREEZE_USE_EXISTING_REVISE_BEFORE_IMPLEMENTATION');
    if(await optional(join(t.root,'planning/unfreeze-active.json')))throw Error('UNFREEZE_ALREADY_ACTIVE');
    inFlight(t.root,t.state);
    const evidenceAbsolute=inside(t.root,evidencePath);
    const evidenceRaw=await fs.readFile(evidenceAbsolute,'utf8');
    const evidence=JSON.parse(evidenceRaw);
    ownerAuthorization(evidence,run,t.manifestHash);
    const pre=await inventory(t.root);
    const version=hash(JSON.stringify([run,t.manifestHash,hash(evidenceRaw)])).slice(0,24);
    await snapshot(t.root,version,t);
    const record={schema_version:1,run_id:run,revision_id:version,original_manifest_sha256:t.manifestHash,
      original_state_sha256:hash(JSON.stringify(t.state,null,2)+'\n'),authorization_sha256:hash(evidenceRaw),
      authorization_path:relative(t.root,evidenceAbsolute),original_planning_files:pre,
      started_at:new Date().toISOString()};
    await fs.writeFile(join(t.root,'planning/unfreeze-active.json'),JSON.stringify(record,null,2)+'\n',{flag:'wx'});
    return {status:'PASS',action:'unfreeze_in_place',run_id:run,revision_id:version,
      affected_pipelines:evidence.affected_pipelines,affected_gates:evidence.affected_gates};
  });
}
function dependencyClosure(manifest,changed) {
  const affected=new Set(changed);
  let updated=true;
  while(updated){
    updated=false;
    for(const p of manifest.pipelines){
      if(!affected.has(p.id) && (p.depends_on??[]).some(id=>affected.has(id))){
        affected.add(p.id);updated=true;
      }
    }
  }
  return affected;
}
function equivalent(a,b){return JSON.stringify(a)===JSON.stringify(b);}
async function defaultFrozenPlanValidator(manifestFile) {
  // The production CLI must not accept a manually written 'ready' label as evidence
  // that PLAN source references, artifacts, commands, reviews and freeze proofs are valid.
  const { preflightFile }=await import('./manifest-preflight.mjs');
  const { assertPlanReviewLedger }=await import('./plan-review.ts');
  const manuscript=await fileJSON(manifestFile);
  await preflightFile(manifestFile,{environment:false,cwd:process.cwd()});
  assertPlanReviewLedger(manuscript,manifestFile);
}
function pendingPipeline(spec,prior) {
  const stages=Object.fromEntries(spec.stages.map(stage=>[stage,{
    status:'pending',
    ...(!['agent','owner_acceptance','git_publish'].includes(spec.executors?.[stage]) ? {technical_fix_limit:prior?.stages?.[stage]?.technical_fix_limit??5}:{}),
  }]));
  return {id:spec.id,status:'approved',stages,stage_order:[...spec.stages],
    depends_on:[...(spec.depends_on??[])],
    ...(spec.issue_numbers?.length?{issue_numbers:[...spec.issue_numbers]}:{}),
    ...(spec.ready_after_stage?{ready_after_stage:spec.ready_after_stage}:{}),
    ...(spec.release_ready_after_stage?{release_ready_after_stage:spec.release_ready_after_stage}:{}),
  };
}
export async function finalizeUnfreeze(stateRoot,run,reviewPath, { validateFrozenPlan = defaultFrozenPlanValidator } = {}) {
  const c=await runRoot(stateRoot,run);
  return acquire(c.root,async()=>{
    const t=await runRoot(stateRoot,run);
    const markerPath=join(t.root,'planning/unfreeze-active.json');
    const marker=await optional(markerPath);
    if(!marker||marker.run_id!==run)throw Error('UNFREEZE_NOT_STARTED');
    const oldRaw=await fs.readFile(join(t.root,'planning/unfreeze-revisions',marker.revision_id,'manifest.json'),'utf8');
    if(hash(oldRaw)!==marker.original_manifest_sha256)throw Error('UNFREEZE_AUDIT_CORRUPT');
    const previousManifest=JSON.parse(oldRaw);
    const authRaw=await fs.readFile(inside(t.root,join(t.root,marker.authorization_path)),'utf8');
    if(hash(authRaw)!==marker.authorization_sha256)throw Error('UNFREEZE_APPROVAL_CHANGED');
    const auth=JSON.parse(authRaw);
    ownerAuthorization(auth,run,marker.original_manifest_sha256);
    inFlight(t.root,t.state);
    if(t.state.manifest_sha256===t.manifestHash && t.manifestHash!==marker.original_manifest_sha256) {
      if(t.state.unfreeze_revision?.revision_id!==marker.revision_id)throw Error('UNFREEZE_COMMITTED_STATE_MISMATCH');
      const finalized=await optional(join(t.root,'planning/unfreeze-revisions',marker.revision_id,'finalization.json'));
      if(!finalized||finalized.new_manifest_sha256!==t.manifestHash)throw Error('UNFREEZE_FINALIZATION_AUDIT_MISSING');
      if(finalized.candidate_invalidated && existsSync(join(t.root,'candidate.json')))
        await fs.rename(join(t.root,'candidate.json'),join(t.root,'planning/unfreeze-revisions',marker.revision_id,'obsolete-candidate.json'));
      if(existsSync(join(t.root,'git-verify.json')))
        await fs.rename(join(t.root,'git-verify.json'),join(t.root,'planning/unfreeze-revisions',marker.revision_id,'obsolete-git-verify.json'));
      await fs.rm(markerPath);
      return {status:'PASS',action:'recovered_finalized_unfreeze',run_id:run,revision_id:marker.revision_id};
    }
    if(t.state.manifest_sha256!==marker.original_manifest_sha256)throw Error('UNFREEZE_STATE_CHANGED');
    if(t.manifestHash===marker.original_manifest_sha256)throw Error('UNFREEZE_MANIFEST_NOT_CHANGED');
    if(!Array.isArray(t.manifest.pipelines)||!t.manifest.pipelines.length||
       t.manifest.pipelines.some(p=>!idValid(p.id)||!Array.isArray(p.stages)||!p.stages.length||p.stages.some(s=>!idValid(s))))
      throw Error('UNFREEZE_NEW_MANIFEST_INVALID');
    const reviewRaw=await fs.readFile(inside(t.root,reviewPath),'utf8');
    const review=JSON.parse(reviewRaw);
    if(review.run_id!==run||review.original_manifest_sha256!==marker.original_manifest_sha256||
       review.revised_manifest_sha256!==t.manifestHash||
       review.owner_decision!=='approved'||!review.owner_response?.trim()||
       !review.owner_message_id?.trim()||!review.owner_source_session?.trim()||
       review.review_status!=='ready')throw Error('UNFREEZE_REVISED_OWNER_APPROVAL_OR_REVIEW_REQUIRED');
    const before=marker.original_planning_files;
    const after=await inventory(t.root);
    const changedPaths=[...new Set([...Object.keys(before),...Object.keys(after)])].filter(p=>before[p]!==after[p]);
    if(changedPaths.some(p=>!auth.allowed_plan_paths.some(allowed=>allowed===p||
      (allowed.endsWith('/**')&&p.startsWith(allowed.slice(0,-2))))))throw Error('UNFREEZE_PLAN_SCOPE_CHANGED');
    const oldIds=new Map(previousManifest.pipelines.map(p=>[p.id,p]));
    const newIds=new Map(t.manifest.pipelines.map(p=>[p.id,p]));
    const changedSpecs=[...new Set([...oldIds.keys(),...newIds.keys()])].filter(id=>!equivalent(oldIds.get(id),newIds.get(id)));
    if(changedSpecs.some(id=>!auth.affected_pipelines.includes(id)))throw Error('UNFREEZE_UNAPPROVED_PIPELINE_DELTA');
    const direct=new Set(auth.affected_pipelines);
    // Work-item edits are contract changes even when the pipeline's stages are unchanged.
    const oldItems=new Map((previousManifest.work_items??[]).map(item=>[item.id,item]));
    const newItems=new Map((t.manifest.work_items??[]).map(item=>[item.id,item]));
    for(const id of new Set([...oldItems.keys(),...newItems.keys()])){
      const before=oldItems.get(id),after=newItems.get(id);
      if(equivalent(before,after))continue;
      const owner=after?.pipeline_id??before?.pipeline_id;
      if(!idValid(owner)||!auth.affected_pipelines.includes(owner))throw Error('UNFREEZE_UNAPPROVED_WORK_ITEM_DELTA');
      direct.add(owner);
    }
    // Gate profile/test policy edits may affect *any* pipeline referencing that shared profile.
    const sharedChanged=!equivalent(previousManifest.gate_profiles,t.manifest.gate_profiles)||
      !equivalent(previousManifest.gate_testing,t.manifest.gate_testing);
    const globalChanged=['planning_scope','planning_inputs','source_issues','source_requirements_sha256',
      'rules_version','project_policy','allowed_change_paths','git_setup','source_type'].some(k=>!equivalent(previousManifest[k],t.manifest[k]));
    if(sharedChanged)for(const p of t.manifest.pipelines){
      if(!equivalent(previousManifest.gate_profiles?.[p.profile],t.manifest.gate_profiles?.[p.profile])||
         !equivalent(previousManifest.gate_testing?.[p.profile],t.manifest.gate_testing?.[p.profile]))direct.add(p.id);
    }
    if(globalChanged)for(const p of t.manifest.pipelines)direct.add(p.id);
    if([...direct].some(id=>!auth.affected_pipelines.includes(id)))throw Error('UNFREEZE_UNAPPROVED_SHARED_DELTA');
    const affected=dependencyClosure(t.manifest,direct);
    const reviewed=new Set(review.reviewed_gates??[]);
    if(auth.affected_gates.some(gate=>!reviewed.has(gate)||t.manifest.planning_readiness?.gates?.[gate]?.status!=='ready')) throw Error('UNFREEZE_AFFECTED_REVIEW_NOT_READY');
    if(review.architecture_changed===true) {
      if(review.senior_technical_plan_review!=='ready' || !review.independent_reviewer_id ||
         !safeRelative(review.senior_technical_review_path) ||
         !/^[a-f0-9]{64}$/.test(review.senior_technical_review_sha256??''))
        throw Error('UNFREEZE_SENIOR_TECHNICAL_REVIEW_REQUIRED');
      const seniorRaw=await fs.readFile(inside(t.root,join(t.root,review.senior_technical_review_path)),'utf8');
      const senior=JSON.parse(seniorRaw);
      if(hash(seniorRaw)!==review.senior_technical_review_sha256 ||
        senior.reviewer!=='SeniorTechnicalPlanReviewer' ||
        senior.status!=='ready' || senior.reviewed_manifest_sha256!==t.manifestHash ||
        (senior.blocking_findings??[]).length>0)
        throw Error('UNFREEZE_SENIOR_TECHNICAL_REVIEW_INVALID');
    }
    if(review.changed_story===true && review.story_review!=='ready')throw Error('UNFREEZE_STORY_REVIEW_REQUIRED');
    await validateFrozenPlan(join(t.root,'manifest.json'));

    // An existing global published candidate cannot prove the new manifest; invalidate every
    // post-publish consumer, preserving all old proof files as historical evidence only.
    const candidateExists=existsSync(join(t.root,'candidate.json'));
    const nextPipelines={};
    for(const spec of t.manifest.pipelines){
      const prior=t.state.pipelines?.[spec.id];
      nextPipelines[spec.id]=affected.has(spec.id)||!prior?pendingPipeline(spec,prior):prior;
      if(candidateExists&&!affected.has(spec.id)){
        const publish=spec.stages.find(stage=>spec.executors?.[stage]==='git_publish');
        if(publish){
          const first=spec.stages.indexOf(publish);
          for(const stage of spec.stages.slice(first)){
            const old=nextPipelines[spec.id].stages[stage];
            nextPipelines[spec.id].stages[stage]={status:'pending',...(old.technical_fix_limit?{technical_fix_limit:old.technical_fix_limit}:{})};
          }
          nextPipelines[spec.id].status='approved';
        }
      }
    }
    const nextState={...t.state,manifest_sha256:t.manifestHash,pipelines:nextPipelines,status:'in_progress',
      reconciliations:[], // Previous records are SHA-bound to the old manifest; keep audit files, not active trust.
      active_stages:[],current_stage:undefined,
      approval_record:{subject:'final-manifest',run_id:run,decision:'approved',shown_manifest_sha256:t.manifestHash,
        current_manifest_sha256:t.manifestHash,owner_response:review.owner_response,message_id:review.owner_message_id,
        source_session:review.owner_source_session,recorded_at:new Date().toISOString()},
      unfreeze_revision:{revision_id:marker.revision_id,original_manifest_sha256:marker.original_manifest_sha256,
        new_manifest_sha256:t.manifestHash,affected_pipelines:[...affected],review_sha256:hash(reviewRaw),
        recorded_at:new Date().toISOString()},updated_at:new Date().toISOString()};
    // Evidence is historical; stage state is invalidated by the affected closure. For safety
    // this procedure also invalidates the candidate identity whenever a candidate exists.
    const finalizationFile=join(t.root,'planning/unfreeze-revisions',marker.revision_id,'finalization.json');
    const finalization={new_manifest_sha256:t.manifestHash,affected_pipelines:[...affected],review_sha256:hash(reviewRaw),
      changed_paths:changedPaths,candidate_invalidated:candidateExists};
    const priorFinalization=await optional(finalizationFile);
    if(priorFinalization&&!equivalent(priorFinalization,finalization))throw Error('UNFREEZE_FINALIZATION_CONFLICT');
    if(!priorFinalization)await fs.writeFile(finalizationFile,JSON.stringify(finalization,null,2)+'\n',{flag:'wx'});
    await atomic(join(t.root,'state.json'),nextState);
    if(candidateExists)await fs.rename(join(t.root,'candidate.json'),
      join(t.root,'planning/unfreeze-revisions',marker.revision_id,'obsolete-candidate.json'));
    if(existsSync(join(t.root,'git-verify.json')))
      await fs.rename(join(t.root,'git-verify.json'),join(t.root,'planning/unfreeze-revisions',marker.revision_id,'obsolete-git-verify.json'));
    await fs.rm(markerPath);
    return {status:'PASS',action:'re_frozen_in_place',run_id:run,revision_id:marker.revision_id,
      affected_pipelines:[...affected],unaffected_pipelines:t.manifest.pipelines.map(p=>p.id).filter(id=>!affected.has(id)),
      candidate_invalidated:candidateExists};
  });
}
async function main(){
  const [command,run,...args]=process.argv.slice(2);
  const option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
  const stateRoot=option('--state-root')??'.tmp/pipelines';
  const evidence=option('--evidence');
  const options=new Set(['--evidence','--state-root']);
  for(let i=0;i<args.length;i+=2){
    if(!options.has(args[i])||!args[i+1]||args[i+1].startsWith('--'))
      throw Error('UNFREEZE_ARGUMENTS_INVALID: unattended/unknown options are forbidden');
  }
  if(!run||!evidence||!['begin','finalize'].includes(command))
    throw Error('Usage: pipeline-unfreeze-cli begin|finalize RUN --evidence FILE [--state-root PATH]');
  console.log(JSON.stringify(command==='begin'?await beginUnfreeze(stateRoot,run,evidence):
    await finalizeUnfreeze(stateRoot,run,evidence),null,2));
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href)main().catch(e=>{console.error(String(e));process.exitCode=1;});
