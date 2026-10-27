import { execFile } from 'node:child_process';
import { deleteApprovedSource } from './source-delete.ts';
import { moveApprovedSource } from './source-move.ts';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { gitReadEnv } from './git-readonly.mjs';
import {
  RUNTIME_SCOPE_CLASSES,
  type PipelineState,
  type RuntimeScopeExtension,
} from '../types/pipeline-state.ts';

const execFileAsync = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/i;
const BRANCH = /^(?!main$|master$)[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const RUNTIME_SCOPE_CLASS_SET = new Set<string>(RUNTIME_SCOPE_CLASSES);

type GitSetup = {
  base_sha: string;
  branch: string;
  source_sha?: string;
  checkout_paths?: string[];
  must_absent?: string[];
};
type PreservedBaseline = { head_sha: string; changed_paths: string[]; diff_sha256: string; };
type Manifest = { run_id?: string; git_setup?: GitSetup; allowed_change_paths?: string[]; freshness_sensitive_paths?: string[]; preserved_baseline?: PreservedBaseline; };
type RuntimeStateView = Pick<PipelineState, 'run_id' | 'runtime_scope_extensions'>;
type GitRuntime = { planning_base_sha: string; run_base_sha: string; merged_head_sha: string; upstream_changed_files: string[]; refreshed_at: string; };
class GateError extends Error {}

async function git(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 4 * 1024 * 1024, env: gitReadEnv() });
    return stdout.trim();
  } catch (error: any) {
    throw new GateError(`git ${args[0] ?? 'command'} failed: ${String(error?.stderr ?? error?.message ?? error).trim()}`);
  }
}
async function gitSucceeds(args: string[], cwd?: string): Promise<boolean> {
  try { await execFileAsync('git', args, { cwd, env: gitReadEnv() }); return true; } catch { return false; }
}
function safePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/') &&
    !value.includes('\\') && !value.includes('\0') &&
    !value.split('/').some((part) => part === '..' || part === '.git');
}
function assertSetup(value: unknown): asserts value is GitSetup {
  if (!value || typeof value !== 'object') throw new GateError('manifest.git_setup is required');
  const setup = value as Partial<GitSetup>;
  if (!SHA.test(setup.base_sha ?? '')) throw new GateError('git_setup.base_sha must be 40-hex SHA');
  if (!setup.branch || !BRANCH.test(setup.branch) || setup.branch.includes('..') || setup.branch.endsWith('/')) {
    throw new GateError('git_setup.branch must be a safe non-default branch');
  }
  if (setup.source_sha || setup.checkout_paths?.length) {
    throw new GateError('manual mode does not perform source checkout; prepare it before PLAN and use the resulting main base');
  }
  for (const path of setup.must_absent ?? []) {
    if (!safePath(path)) throw new GateError(`unsafe must_absent path: ${String(path)}`);
  }
}
function validScopePath(path: unknown): path is string {
  if (typeof path !== 'string' || !path) return false;
  if (path.endsWith('/**')) {
    const base = path.slice(0, -3).replace(/\/$/, '');
    return safePath(base) && !/[?*\[\]{}]/.test(base);
  }
  return safePath(path) && !/[?*\[\]{}]/.test(path);
}
function assertScope(paths: unknown): asserts paths is string[] | undefined {
  if (paths === undefined) return;
  if (!Array.isArray(paths) || paths.some((path) => !validScopePath(path))) {
    throw new GateError('allowed_change_paths supports only exact repository-relative paths or directory/** scopes');
  }
}
function matches(path: string, pattern: string): boolean {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3).replace(/\/$/, '');
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  return path === pattern;
}
function freshnessGlobal(path: string): boolean {
  const name=path.split('/').pop()??path;
  return path.startsWith('.github/')||path==='docs/pipeline-rules.md'||['package.json','pnpm-lock.yaml','package-lock.json','yarn.lock','bun.lock','bun.lockb','pyproject.toml','uv.lock','go.mod','go.sum','Cargo.toml','Cargo.lock'].includes(path)||/^tsconfig(?:\..+)?\.json$/.test(name)||/^requirements(?:\..+)?\.txt$/.test(name);
}
function sensitive(path: string): boolean {
  const name = path.split('/').pop() ?? path;
  return name === '.env' || (/^\.env\./.test(name) && name !== '.env.example') ||
    /\.(key|pem|p12|pfx|secret)$/i.test(name);
}
async function inspect(cwd: string): Promise<Record<string, unknown>> {
  const [head, branch, gitDir, commonDir, main, dirty, trackedPipeline] = await Promise.all([
    git(['rev-parse', 'HEAD'], cwd),
    git(['branch', '--show-current'], cwd),
    git(['rev-parse', '--path-format=absolute', '--git-dir'], cwd),
    git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd),
    git(['rev-parse', '--verify', 'refs/heads/main'], cwd),
    git(['status', '--porcelain', '--untracked-files=all'], cwd),
    git(['ls-files', '--', '.tmp/pipelines'], cwd),
  ]);
  return { head, branch, linked_worktree: resolve(gitDir) !== resolve(commonDir), main_sha: main,
    clean: dirty.length === 0, pipeline_artifacts_tracked: Boolean(trackedPipeline),
    directory: cwd };
}
function runtimeEvidencePath(manifestPath:string):string{return join(dirname(resolve(manifestPath)),'git-runtime.json');}
function statePathForManifest(manifestPath:string):string{return join(dirname(resolve(manifestPath)),'state.json');}
async function runtimeScopeExtensions(manifest:Manifest,manifestPath:string):Promise<RuntimeScopeExtension[]>{
  let state:RuntimeStateView;
  try{state=JSON.parse(await readFile(statePathForManifest(manifestPath),'utf8')) as RuntimeStateView;}catch{return [];}
  if(manifest.run_id&&state.run_id&&state.run_id!==manifest.run_id)throw new GateError('state.json run_id does not match manifest');
  const extensions=state.runtime_scope_extensions??[];
  for(const entry of extensions){
    if(!entry||!RUNTIME_SCOPE_CLASS_SET.has(String(entry.scope_class))||!Array.isArray(entry.paths)||entry.paths.length===0||
      entry.paths.some(path=>!validScopePath(path)||path.endsWith('/**'))){
      throw new GateError('state runtime_scope_extensions is invalid');
    }
  }
  return extensions;
}
async function effectiveScope(manifest:Manifest,manifestPath:string):Promise<{scope:string[];extensions:RuntimeScopeExtension[]}>{
  const extensions=await runtimeScopeExtensions(manifest,manifestPath);
  return {scope:[...(manifest.allowed_change_paths??[]),...extensions.flatMap(entry=>entry.paths??[])],extensions};
}
async function readRuntime(manifestPath:string,setup:GitSetup):Promise<GitRuntime|undefined>{try{const runtime=JSON.parse(await readFile(runtimeEvidencePath(manifestPath),'utf8')) as GitRuntime;if(runtime.planning_base_sha.toLowerCase()!==setup.base_sha.toLowerCase()||!SHA.test(runtime.run_base_sha))throw new GateError('git-runtime.json does not match approved planning base');return runtime;}catch(error){if(error instanceof GateError)throw error;return undefined;}}
async function writeJsonAtomic(file:string,value:unknown):Promise<void>{const tmp=`${file}.tmp-${process.pid}`;await writeFile(tmp,`${JSON.stringify(value,null,2)}\n`,'utf8');await rename(tmp,file);}
async function assertIdentity(setup: GitSetup, cwd: string, manifestPath?:string): Promise<void> {
  const info = await inspect(cwd);
  if (!info.linked_worktree) throw new GateError('current checkout must be an owner-created linked worktree (not primary/main)');
  if (info.branch !== setup.branch) throw new GateError(`selected branch mismatch: ${String(info.branch)}`);
  if (info.pipeline_artifacts_tracked) throw new GateError('.tmp/pipelines is tracked: archive/untrack safely before proceeding');
  const runtime=manifestPath?await readRuntime(manifestPath,setup):undefined;
  if(!runtime&&String(info.main_sha).toLowerCase()!==setup.base_sha.toLowerCase())throw new GateError(`STALE_PLAN: local main moved from approved base ${setup.base_sha} to ${String(info.main_sha)}; run freshness or refresh PLAN`);
  const effectiveBase=runtime?.run_base_sha??setup.base_sha;
  if(!await gitSucceeds(['merge-base','--is-ancestor',effectiveBase,'HEAD'],cwd))throw new GateError('current branch does not contain effective run base; refresh/re-plan required');
  for (const path of setup.must_absent ?? []) {
    if (await gitSucceeds(['ls-files', '--error-unmatch', '--', path], cwd)) {
      throw new GateError(`forbidden tracked path exists: ${path}`);
    }
    try {
      await lstat(join(cwd, path));
      throw new GateError(`forbidden path exists: ${path}`);
    } catch (error) {
      if (error instanceof GateError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
async function changedFiles(baseSha:string,cwd:string):Promise<string[]>{
  const outputs=await Promise.all([
    git(['diff','--name-only',baseSha,'HEAD'],cwd),
    git(['diff', '--name-only'], cwd),
    git(['diff', '--cached', '--name-only'], cwd),
    git(['ls-files', '--others', '--exclude-standard'], cwd),
  ]);
  return [...new Set(outputs.flatMap((out) => out.split('\n').filter(Boolean)))].sort();
}

async function diffSha256(baseSha:string,headSha:string,cwd:string):Promise<string>{
  const diff=await git(['diff','--raw','--full-index','--no-renames',baseSha,headSha,'--'],cwd);
  return createHash('sha256').update(diff).digest('hex');
}

async function baselineSnapshot(baseSha:string,cwd:string):Promise<PreservedBaseline>{
  if(!SHA.test(baseSha))throw new GateError('baseline base SHA must be 40-hex');
  const info=await inspect(cwd);
  if(!info.linked_worktree)throw new GateError('baseline requires an owner-created linked worktree');
  if(!info.clean)throw new GateError('baseline requires a clean tracked checkout');
  const headSha=String(info.head);
  if(!await gitSucceeds(['merge-base','--is-ancestor',baseSha,headSha],cwd)) {
    throw new GateError('baseline head does not contain the requested base SHA');
  }
  const changed=(await git(['diff','--name-only',baseSha,headSha],cwd)).split('\n').filter(Boolean).sort();
  if(changed.length===0)throw new GateError('baseline has no existing branch changes to preserve');
  for(const path of changed){
    if(!safePath(path))throw new GateError(`unsafe baseline path: ${path}`);
    if(sensitive(path))throw new GateError(`sensitive path cannot be preserved as baseline: ${path}`);
  }
  return {head_sha:headSha,changed_paths:changed,diff_sha256:await diffSha256(baseSha,headSha,cwd)};
}

async function validatePreservedBaseline(manifest:Manifest,cwd:string):Promise<Set<string>>{
  const baseline=manifest.preserved_baseline;
  if(!baseline)return new Set();
  if(!manifest.git_setup)throw new GateError('preserved baseline requires git_setup');
  if(!SHA.test(baseline.head_sha)||!/^[0-9a-f]{64}$/i.test(baseline.diff_sha256)||
      !Array.isArray(baseline.changed_paths)||baseline.changed_paths.length===0) {
    throw new GateError('preserved_baseline is invalid');
  }
  if(!await gitSucceeds(['merge-base','--is-ancestor',manifest.git_setup.base_sha,baseline.head_sha],cwd)) {
    throw new GateError('preserved baseline does not contain planning base');
  }
  if(!await gitSucceeds(['merge-base','--is-ancestor',baseline.head_sha,'HEAD'],cwd)) {
    throw new GateError('current HEAD no longer contains preserved baseline');
  }
  const actual=(await git(['diff','--name-only',manifest.git_setup.base_sha,baseline.head_sha],cwd))
    .split('\n').filter(Boolean).sort();
  const frozen=[...baseline.changed_paths].sort();
  if(JSON.stringify(actual)!==JSON.stringify(frozen)) {
    throw new GateError('preserved baseline changed-path set mismatch');
  }
  for(const path of actual){
    if(!safePath(path)||sensitive(path))throw new GateError(`invalid preserved baseline path: ${path}`);
  }
  const digest=await diffSha256(manifest.git_setup.base_sha,baseline.head_sha,cwd);
  if(digest.toLowerCase()!==baseline.diff_sha256.toLowerCase()) {
    throw new GateError('preserved baseline diff SHA-256 mismatch');
  }
  return new Set(actual);
}
async function verify(manifest:Manifest,manifestPath:string,cwd:string):Promise<string[]>{
  assertSetup(manifest.git_setup);assertScope(manifest.allowed_change_paths);assertScope(manifest.freshness_sensitive_paths);
  await assertIdentity(manifest.git_setup,cwd,manifestPath);
  const preserved=await validatePreservedBaseline(manifest,cwd);
  const runtime=await readRuntime(manifestPath,manifest.git_setup);
  const changed=await changedFiles(runtime?.run_base_sha??manifest.git_setup.base_sha,cwd);
  const {scope,extensions}=await effectiveScope(manifest,manifestPath);
  const writableChanged:string[]=[];
  for (const path of changed) {
    if (sensitive(path)) throw new GateError(`sensitive path changed: ${path}`);
    if (preserved.has(path) && manifest.preserved_baseline &&
        await gitSucceeds(['diff','--quiet',manifest.preserved_baseline.head_sha,'--',path],cwd)) {
      continue;
    }
    writableChanged.push(path);
    if (!scope.some((allowed) => matches(path, allowed))) {
      throw new GateError(`RUNTIME_SCOPE_CHECK_REQUIRED: changed path is outside effective scope: ${path}; if it is an untracked worker leftover run git-worktree-cli quarantine-strays <manifest> --apply, otherwise run stage-cli scope-check for the active technical-fix stage; do not edit manifest/state manually`);
    }
  }
  const headSha = await git(['rev-parse', 'HEAD'], cwd);
  const evidence = {
    status: 'PASS',
    run_id: manifest.run_id ?? null,
    branch: manifest.git_setup.branch,
    head_sha: headSha,
    changed_files: changed,
    writable_changed_files: writableChanged,
    effective_allowed_change_paths: scope,
    runtime_scope_extensions: extensions,
    ...(manifest.preserved_baseline ? {
      preserved_baseline_head_sha: manifest.preserved_baseline.head_sha,
      preserved_baseline_paths: manifest.preserved_baseline.changed_paths,
    } : {}),
    verified_at: new Date().toISOString(),
  };
  await writeJsonAtomic(join(dirname(resolve(manifestPath)), 'git-verify.json'), evidence);
  return changed;
}
async function updateRunBaseState(manifestPath:string,runBaseSha:string):Promise<void>{const file=join(dirname(resolve(manifestPath)),'state.json');try{const state=JSON.parse(await readFile(file,'utf8')) as Record<string,unknown>;state.run_base_sha=runBaseSha;await writeJsonAtomic(file,state);}catch{}}
async function freshness(manifest:Manifest,manifestPath:string,cwd:string,preflight=false):Promise<GitRuntime>{
  assertSetup(manifest.git_setup);assertScope(manifest.allowed_change_paths);assertScope(manifest.freshness_sensitive_paths);
  const info=await inspect(cwd);if(!info.linked_worktree||info.branch!==manifest.git_setup.branch)throw new GateError('freshness requires the approved owner-created linked worktree');if(!info.clean&&!preflight)throw new GateError('freshness requires a clean tracked checkout');await validatePreservedBaseline(manifest,cwd);
  const runtimeScope=(await effectiveScope(manifest,manifestPath)).scope;
  if(!await gitSucceeds(['merge-base','--is-ancestor',manifest.git_setup.base_sha,'HEAD'],cwd))throw new GateError('current branch no longer contains planning base');
  await git(['fetch','origin','main:refs/remotes/origin/main'],cwd);const remoteMain=await git(['rev-parse','refs/remotes/origin/main'],cwd);const previousRuntime=await readRuntime(manifestPath,manifest.git_setup);const previousBase=previousRuntime?.run_base_sha??manifest.git_setup.base_sha;
  if(!await gitSucceeds(['merge-base','--is-ancestor',previousBase,remoteMain],cwd))throw new GateError('STALE_PLAN: origin/main history diverged from approved/effective base');
  const upstreamChanged=(await git(['diff','--name-only',previousBase,remoteMain],cwd)).split('\n').filter(Boolean).sort();const scopes=[...runtimeScope,...(manifest.freshness_sensitive_paths??[]),...(manifest.preserved_baseline?.changed_paths??[])];const relevant=upstreamChanged.filter(file=>freshnessGlobal(file)||scopes.some(scope=>matches(file,scope)));if(relevant.length)throw new GateError(`STALE_PLAN: origin/main changed plan-relevant paths: ${relevant.join(', ')}`);
  if(preflight)return {planning_base_sha:manifest.git_setup.base_sha,run_base_sha:remoteMain,merged_head_sha:await git(['rev-parse','HEAD'],cwd),upstream_changed_files:upstreamChanged,refreshed_at:new Date().toISOString()};
  if(!await gitSucceeds(['merge-base','--is-ancestor',remoteMain,'HEAD'],cwd)){try{await git(['merge','--no-edit','refs/remotes/origin/main'],cwd);}catch(error){await gitSucceeds(['merge','--abort'],cwd);throw new GateError(`STALE_PLAN: safe main merge conflicted: ${error instanceof Error?error.message:String(error)}`);}}
  const mergedHead=await git(['rev-parse','HEAD'],cwd);const runtime:GitRuntime={planning_base_sha:manifest.git_setup.base_sha,run_base_sha:remoteMain,merged_head_sha:mergedHead,upstream_changed_files:upstreamChanged,refreshed_at:new Date().toISOString()};await writeJsonAtomic(runtimeEvidencePath(manifestPath),runtime);await updateRunBaseState(manifestPath,remoteMain);return runtime;
}
// Safe main sync: never resets, forces or rebases. A dirty in-scope tree is checkpointed in one commit first so the
// existing freshness merge (clean-tree, plan-relevant STALE_PLAN check, git-runtime.json, run base) can run unchanged.
async function syncMain(manifest:Manifest,manifestPath:string,cwd:string,check:boolean):Promise<Record<string,unknown>>{
  assertSetup(manifest.git_setup);assertScope(manifest.allowed_change_paths);assertScope(manifest.freshness_sensitive_paths);
  const identity=await inspect(cwd);if(!identity.linked_worktree||identity.branch!==manifest.git_setup.branch)throw new GateError('sync-main requires the approved owner-created linked worktree');
  await git(['fetch','origin','main:refs/remotes/origin/main'],cwd);const mainSha=await git(['rev-parse','refs/remotes/origin/main'],cwd);const headSha=await git(['rev-parse','HEAD'],cwd);
  const contains=await gitSucceeds(['merge-base','--is-ancestor',mainSha,'HEAD'],cwd);const clean=Boolean((await inspect(cwd)).clean);
  const action=contains?'none':clean?'merge':'checkpoint_and_merge';const base={contains_main:contains,clean,main_sha:mainSha,head_sha:headSha,action};
  if(check||action==='none')return base;
  if(action==='merge'){const runtime=await freshness(manifest,manifestPath,cwd);return {...base,head_sha:runtime.merged_head_sha,run_base_sha:runtime.run_base_sha};}
  const dirty=[...new Set((await Promise.all([git(['diff','--name-only'],cwd),git(['diff','--cached','--name-only'],cwd),git(['ls-files','--others','--exclude-standard'],cwd)])).flatMap(out=>out.split('\n').filter(Boolean)))].filter(path=>!path.startsWith('.tmp/')).sort();
  const {scope}=await effectiveScope(manifest,manifestPath);const outside=dirty.filter(path=>sensitive(path)||!scope.some(allowed=>matches(path,allowed)));
  if(outside.length)throw new GateError(`SYNC_MAIN_OUT_OF_SCOPE: ${outside.join(', ')}`);
  await freshness(manifest,manifestPath,cwd,true);
  const run=String(manifest.run_id??'run').replace(/[^A-Za-z0-9._-]/g,'-').slice(0,80);
  await git(['add','-A'],cwd);await git(['commit','-m',`pipeline(${run}): checkpoint before main sync`],cwd);
  const checkpoint=await git(['rev-parse','HEAD'],cwd);
  try{const runtime=await freshness(manifest,manifestPath,cwd);return {...base,head_sha:runtime.merged_head_sha,run_base_sha:runtime.run_base_sha,checkpoint_sha:checkpoint};}
  catch(error){throw new GateError(`${error instanceof Error?error.message:String(error)}; checkpoint commit ${checkpoint} kept (no reset)`);}
}
// PLAN-time sync, before any manifest is frozen: bring local main up to origin/main and merge it
// into the owner's PLAN branch, so a branch that fell behind main does not stop PLAN for the owner.
// It never resets, rebases or force-updates. Once a run is initialized here, sync-main <manifest>
// with its scope checks is the only sync.
async function syncPlan(cwd:string,check:boolean):Promise<Record<string,unknown>>{
  const identity=await inspect(cwd);
  if(!identity.linked_worktree||!BRANCH.test(String(identity.branch)))throw new GateError('sync-plan requires the owner-created linked worktree on a non-default branch');
  let runs:string[]=[];try{runs=await readdir(join(cwd,'.tmp','pipelines'));}catch{}
  for(const run of runs)if(await lstat(join(cwd,'.tmp','pipelines',run,'state.json')).then(()=>true,()=>false))throw new GateError(`SYNC_PLAN_AFTER_FREEZE: run ${run} is initialized; use sync-main <manifest>`);
  await git(['fetch','origin','main:refs/remotes/origin/main'],cwd);
  const originMain=await git(['rev-parse','refs/remotes/origin/main'],cwd);
  let localMain=String(identity.main_sha);
  const mainBehind=localMain!==originMain&&await gitSucceeds(['merge-base','--is-ancestor',localMain,originMain],cwd);
  const mainAhead=localMain!==originMain&&!mainBehind;
  const branchHasMain=await gitSucceeds(['merge-base','--is-ancestor',originMain,'HEAD'],cwd);
  const base={origin_main_sha:originMain,local_main_sha:localMain,local_main_diverged:mainAhead,head_sha:identity.head,contains_main:branchHasMain,clean:identity.clean};
  if(check)return {...base,action:mainBehind||!branchHasMain?'sync':'none'};
  if(mainAhead)throw new GateError(`SYNC_PLAN_LOCAL_MAIN_DIVERGED: local main ${localMain} is not an ancestor of origin/main ${originMain}`);
  if(mainBehind){
    const holder=(await git(['worktree','list','--porcelain'],cwd)).split('\n\n').find(block=>block.split('\n').includes('branch refs/heads/main'));
    const holderDir=holder?.split('\n').find(line=>line.startsWith('worktree '))?.slice(9);
    if(holderDir){
      if(await git(['status','--porcelain','--untracked-files=no'],holderDir))throw new GateError(`SYNC_PLAN_MAIN_CHECKOUT_DIRTY: ${holderDir}`);
      await git(['merge','--ff-only','refs/remotes/origin/main'],holderDir);
    }else await git(['update-ref','refs/heads/main',originMain,localMain],cwd);
    localMain=originMain;
  }
  if(branchHasMain)return {...base,action:mainBehind?'main_fast_forwarded':'none',local_main_sha:localMain};
  if(!identity.clean)throw new GateError('SYNC_PLAN_DIRTY: commit or remove tracked changes before merging main');
  if(!await gitSucceeds(['merge','--no-edit','refs/heads/main'],cwd)){
    await gitSucceeds(['merge','--abort'],cwd);
    throw new GateError('SYNC_PLAN_CONFLICT: merging main into the PLAN branch conflicts; the branch is unchanged');
  }
  return {...base,action:'merged',local_main_sha:localMain,head_sha:await git(['rev-parse','HEAD'],cwd)};
}
async function publish(manifest: Manifest, manifestPath: string, cwd: string): Promise<Record<string, unknown>> {
  assertSetup(manifest.git_setup);
  let changed = await verify(manifest, manifestPath, cwd);
  const working = await Promise.all([
    git(['diff', '--name-only'], cwd), git(['diff', '--cached', '--name-only'], cwd),
    git(['ls-files', '--others', '--exclude-standard'], cwd),
  ]);
  if (working.some((value) => value.length > 0)) {
    await git(['add', '-A'], cwd);
    await verify(manifest, manifestPath, cwd);
    const run = String(manifest.run_id ?? 'run').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
    await git(['commit', '-m', `pipeline(${run}): candidate`], cwd);
  }
  changed = await verify(manifest, manifestPath, cwd);
  const candidate = await git(['rev-parse', 'HEAD'], cwd);
  await git(['push', 'origin', `HEAD:refs/heads/${manifest.git_setup.branch}`], cwd);
  const remote = (await git(['ls-remote', '--heads', 'origin', `refs/heads/${manifest.git_setup.branch}`], cwd))
    .split(/\s+/)[0] ?? '';
  if (candidate.toLowerCase() !== remote.toLowerCase()) throw new GateError('remote candidate SHA mismatch');
  const evidencePath = join(dirname(resolve(manifestPath)), 'candidate.json');
  const evidence = { status: 'PASS', run_id: manifest.run_id ?? null, branch: manifest.git_setup.branch,
    candidate_sha: candidate, remote_sha: remote, changed_files: changed,
    published_at: new Date().toISOString() };
  await writeJsonAtomic(evidencePath, evidence);
  return { ...evidence, evidence: evidencePath };
}
// Workers sometimes leave diagnostic files (patches, diffstats, logs) in the checkout. They are
// untracked, outside every authorized path, and were not there when the RUN's first work item was
// dispatched; verify then blocks on them and no agent may delete them. This moves exactly those
// files into the run's quarantine (never deletes) so verification can continue. A file that existed
// or was last modified before the first dispatch, a tracked or in-scope path, build output, a symlink
// and a sensitive name are never touched, and only the RUN's own branch is swept.
async function quarantineStrays(manifestPath:string,cwd:string,apply:boolean):Promise<Record<string,unknown>>{
  const manifest=JSON.parse(await readFile(manifestPath,'utf8')) as Manifest;
  const runDir=dirname(resolve(manifestPath));
  const baselineDir=join(runDir,'checks','baselines');
  let first:{recorded_at:string;files:Record<string,string>}|undefined;
  for(const name of (await readdir(baselineDir).catch(()=>[] as string[])).filter(item=>item.endsWith('.json')).sort()){
    try{const baseline=JSON.parse(await readFile(join(baselineDir,name),'utf8'));if(baseline?.files&&typeof baseline.recorded_at==='string'&&(!first||baseline.recorded_at<first.recorded_at))first=baseline;}catch{}
  }
  if(!first)throw new GateError('QUARANTINE_REQUIRES_DISPATCH_BASELINE: no work item has been dispatched in this run');
  const branch=await git(['branch','--show-current'],cwd);
  if(branch!==manifest.git_setup?.branch)throw new GateError(`QUARANTINE_BRANCH_MISMATCH: checkout is on ${branch||'<detached>'}, RUN branch is ${String(manifest.git_setup?.branch)}`);
  const firstDispatch=Date.parse(first.recorded_at);
  const {scope}=await effectiveScope(manifest,manifestPath);
  const untracked=(await git(['ls-files','--others','--exclude-standard'],cwd)).split('\n').filter(Boolean).sort();
  const strays:string[]=[];
  for(const path of untracked){
    if(!safePath(path)||sensitive(path)||path.startsWith('.tmp/')||/(^|\/)(node_modules|dist|build|coverage)\//.test(path)||
       scope.some(allowed=>matches(path,allowed))||path in first.files)continue;
    const stat=await lstat(join(cwd,path)).catch(()=>undefined);
    if(stat?.isFile()&&stat.mtimeMs>=firstDispatch)strays.push(path);
  }
  if(!apply)return {mode:'dry-run',strays};
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const target=join(runDir,'quarantine',stamp);
  const moved:Array<{path:string;sha256:string}>=[];
  for(const path of strays){
    const destination=join(target,path);
    await mkdir(dirname(destination),{recursive:true});
    const digest=createHash('sha256').update(await readFile(join(cwd,path))).digest('hex');
    await rename(join(cwd,path),destination);
    moved.push({path,sha256:digest});
  }
  const evidence={status:'PASS',kind:'stray_quarantine',run_id:manifest.run_id??null,quarantine_dir:target,moved,recorded_at:new Date().toISOString()};
  if(moved.length){await mkdir(target,{recursive:true});await writeJsonAtomic(join(target,'quarantine.json'),evidence);}
  return {mode:'apply',...evidence};
}
// `--include-pre-run --paths <p>...`: moves exactly the listed untracked regular files (any mtime, in or out of
// scope) into the run quarantine with the same evidence format. All paths are validated first; one refusal moves
// nothing. Tracked files, directories, symlinks, sensitive/protected names, .tmp/pipelines, .git and missing paths
// are refused. Never deletes.
async function quarantinePreRun(manifestPath:string,cwd:string,apply:boolean,paths:string[]):Promise<Record<string,unknown>>{
  if(!paths.length)throw new GateError('QUARANTINE_PATHS_REQUIRED: --include-pre-run needs at least one path after --paths');
  const manifest=JSON.parse(await readFile(manifestPath,'utf8')) as Manifest;
  const runDir=dirname(resolve(manifestPath));
  const branch=await git(['branch','--show-current'],cwd);
  if(branch!==manifest.git_setup?.branch)throw new GateError(`QUARANTINE_BRANCH_MISMATCH: checkout is on ${branch||'<detached>'}, RUN branch is ${String(manifest.git_setup?.branch)}`);
  const requested=[...new Set(paths)].sort();
  const tracked=new Set((await git(['ls-files','-z'],cwd).catch(()=>'')).split('\0').filter(Boolean));
  for(const path of requested){
    if(!safePath(path)||path.split('/').some(part=>part===''||part==='.'))throw new GateError(`QUARANTINE_PATH_INVALID: ${path}`);
    if(path==='.tmp/pipelines'||path.startsWith('.tmp/pipelines/'))throw new GateError(`QUARANTINE_PATH_FORBIDDEN: ${path} is under .tmp/pipelines`);
    if(sensitive(path)||freshnessGlobal(path))throw new GateError(`QUARANTINE_PATH_PROTECTED: ${path}`);
    const stat=await lstat(join(cwd,path)).catch(()=>undefined);
    if(!stat)throw new GateError(`QUARANTINE_PATH_MISSING: ${path}`);
    if(stat.isSymbolicLink())throw new GateError(`QUARANTINE_PATH_SYMLINK: ${path}`);
    if(stat.isDirectory())throw new GateError(`QUARANTINE_PATH_DIRECTORY: ${path}; list files explicitly`);
    if(!stat.isFile())throw new GateError(`QUARANTINE_PATH_NOT_FILE: ${path}`);
    if(tracked.has(path))throw new GateError(`QUARANTINE_PATH_TRACKED: ${path}`);
  }
  if(!apply)return {mode:'dry-run',include_pre_run:true,strays:requested};
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const target=join(runDir,'quarantine',stamp);
  const moved:Array<{path:string;sha256:string}>=[];
  for(const path of requested){
    const destination=join(target,path);
    await mkdir(dirname(destination),{recursive:true});
    const digest=createHash('sha256').update(await readFile(join(cwd,path))).digest('hex');
    await rename(join(cwd,path),destination);
    moved.push({path,sha256:digest});
  }
  const evidence={status:'PASS',kind:'stray_quarantine',run_id:manifest.run_id??null,quarantine_dir:target,moved,recorded_at:new Date().toISOString()};
  await mkdir(target,{recursive:true});await writeJsonAtomic(join(target,'quarantine.json'),evidence);
  return {mode:'apply',include_pre_run:true,...evidence};
}
// Project tooling that lists files through the git index (`git ls-files`: generated test maps,
// release metadata) does not see files a worker created. This records exactly the untracked files
// inside the effective scope as intent-to-add entries: no content is staged, nothing is committed,
// and publish still stages the final content itself. Sensitive names and build output are skipped.
async function stageNew(manifestPath:string,cwd:string):Promise<Record<string,unknown>>{
  const manifest=JSON.parse(await readFile(manifestPath,'utf8')) as Manifest;
  const branch=await git(['branch','--show-current'],cwd);
  if(branch!==manifest.git_setup?.branch)throw new GateError(`STAGE_NEW_BRANCH_MISMATCH: checkout is on ${branch||'<detached>'}, RUN branch is ${String(manifest.git_setup?.branch)}`);
  const {scope}=await effectiveScope(manifest,manifestPath);
  const untracked=(await git(['ls-files','--others','--exclude-standard'],cwd)).split('\n').filter(Boolean).sort();
  const added=untracked.filter(path=>safePath(path)&&!sensitive(path)&&!path.startsWith('.tmp/')&&
    !/(^|\/)(node_modules|dist|build|coverage)\//.test(path)&&scope.some(allowed=>matches(path,allowed)));
  const outside=untracked.filter(path=>!added.includes(path)&&!path.startsWith('.tmp/'));
  if(added.length)await git(['add','--intent-to-add','--',...added],cwd);
  return {intent_to_add:added,skipped_outside_scope:outside};
}
async function main(): Promise<void> {
  const [command, manifestPath] = process.argv.slice(2);
  const cwd = await git(['rev-parse', '--show-toplevel']);
  if (command === 'delete' || command === 'move') {
    const args = process.argv.slice(4);
    const allowed = new Set(['--pipeline', '--stage', '--work-item', '--role', '--evidence']);
    const options = new Map<string, string>();
    for (let i = 0; i < args.length; i += 2) {
      if (!allowed.has(args[i]) || !args[i + 1] || options.has(args[i])) throw new GateError(`Invalid ${command} arguments`);
      options.set(args[i], args[i + 1]);
    }
    if (!manifestPath || [...allowed].some(key => !options.has(key))) throw new GateError(`${command} requires run-id, pipeline, stage, work-item, role and evidence`);
    const apply = command === 'delete' ? deleteApprovedSource : moveApprovedSource;
    console.log(JSON.stringify(await apply(cwd, manifestPath, options.get('--pipeline')!, options.get('--stage')!, options.get('--work-item')!, options.get('--role')!, options.get('--evidence')!)));
    return;
  }
  if (command === 'quarantine-strays' && manifestPath) {
    const extra = process.argv.slice(4);
    const pathsAt = extra.indexOf('--paths');
    const flags = pathsAt < 0 ? extra : extra.slice(0, pathsAt);
    const preRun = flags.includes('--include-pre-run');
    if (flags.some(arg => arg !== '--apply' && arg !== '--include-pre-run') || (pathsAt >= 0 && !preRun) || (preRun && pathsAt < 0)) {
      throw new GateError('usage: quarantine-strays <manifest.json> [--apply] [--include-pre-run --paths <path>...]');
    }
    if (preRun) {
      console.log(JSON.stringify({ status: 'PASS', gate: 'git_worktree', command, ...await quarantinePreRun(manifestPath, cwd, flags.includes('--apply'), extra.slice(pathsAt + 1)) }));
      return;
    }
    console.log(JSON.stringify({ status: 'PASS', gate: 'git_worktree', command, ...await quarantineStrays(manifestPath, cwd, extra.includes('--apply')) }));
    return;
  }
  if (command === 'stage-new' && manifestPath) {
    if (process.argv.length > 4) throw new GateError('usage: stage-new <manifest.json>');
    console.log(JSON.stringify({ status: 'PASS', gate: 'git_worktree', command, ...await stageNew(manifestPath, cwd) }));
    return;
  }
  if (command === 'inspect' && !manifestPath) {
    console.log(JSON.stringify({ status: 'PASS', gate: 'git_worktree', command, ...await inspect(cwd) }));
    return;
  }
  if (command === 'sync-plan') {
    const extra=process.argv.slice(3);if(extra.some(arg=>arg!=='--check'))throw new GateError('usage: sync-plan [--check]');
    console.log(JSON.stringify({ status: 'PASS', gate: 'git_worktree', command, ...await syncPlan(cwd, extra.includes('--check')) }));
    return;
  }
  if (command === 'baseline' && manifestPath) {
    console.log(JSON.stringify({ status: 'PASS', gate: 'git_worktree', command, ...await baselineSnapshot(manifestPath,cwd) }));
    return;
  }
  if (!manifestPath || !['freshness', 'adopt', 'verify', 'publish', 'sync-main'].includes(command ?? '')) {
    throw new GateError('usage: git-worktree-cli.ts inspect | sync-plan [--check] | baseline <base-sha> | freshness|adopt|verify|publish <manifest.json> | sync-main <manifest.json> [--check] | quarantine-strays <manifest.json> [--apply] [--include-pre-run --paths <path>...] | stage-new <manifest.json> | delete|move <run-id> --pipeline --stage --work-item --role --evidence; setup is disabled');
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
  assertSetup(manifest.git_setup);assertScope(manifest.allowed_change_paths);assertScope(manifest.freshness_sensitive_paths);
  let details: Record<string, unknown> = {};
  if(command==='freshness')details=await freshness(manifest,manifestPath,cwd);
  if(command==='sync-main'){
    const extra=process.argv.slice(4);if(extra.some(arg=>arg!=='--check'))throw new GateError('usage: sync-main <manifest.json> [--check]');
    details=await syncMain(manifest,manifestPath,cwd,extra.includes('--check'));
  }
  if (command === 'adopt') {
    await assertIdentity(manifest.git_setup, cwd, manifestPath);
    await validatePreservedBaseline(manifest, cwd);
    if (await git(['status', '--porcelain', '--untracked-files=all'], cwd)) {
      throw new GateError('adopt requires clean checkout; save tracked preparation before approval');
    }
    details = { main_sha: manifest.git_setup.base_sha, directory: cwd };
  }
  if (command === 'verify') details = { changed_files: await verify(manifest, manifestPath, cwd), evidence: join(dirname(resolve(manifestPath)), 'git-verify.json') };
  if (command === 'publish') details = await publish(manifest, manifestPath, cwd);
  console.log(JSON.stringify({ status: 'PASS', gate: 'git_worktree', command,
    branch: manifest.git_setup.branch, ...details }));
}
main().catch((error: unknown) => {
  console.error(`BLOCKED: git_worktree: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
