import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/i;
const BRANCH = /^(?!main$|master$)[A-Za-z0-9][A-Za-z0-9._/-]*$/;

type GitSetup = {
  base_sha: string;
  branch: string;
  source_sha?: string;
  checkout_paths?: string[];
  must_absent?: string[];
};
type PreservedBaseline = { head_sha: string; changed_paths: string[]; diff_sha256: string; };
type Manifest = { run_id?: string; git_setup?: GitSetup; allowed_change_paths?: string[]; freshness_sensitive_paths?: string[]; preserved_baseline?: PreservedBaseline; };
type GitRuntime = { planning_base_sha: string; run_base_sha: string; merged_head_sha: string; upstream_changed_files: string[]; refreshed_at: string; };
class GateError extends Error {}

async function git(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  } catch (error: any) {
    throw new GateError(`git ${args[0] ?? 'command'} failed: ${String(error?.stderr ?? error?.message ?? error).trim()}`);
  }
}
async function gitSucceeds(args: string[], cwd?: string): Promise<boolean> {
  try { await execFileAsync('git', args, { cwd }); return true; } catch { return false; }
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
function assertScope(paths: unknown): asserts paths is string[] | undefined {
  if (paths === undefined) return;
  if (!Array.isArray(paths) || paths.some((path) =>
    !safePath(typeof path === 'string' && path.endsWith('/**') ? path.slice(0, -3) : path))) {
    throw new GateError('allowed_change_paths must contain safe repository-relative paths');
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
  const diff=await git(['diff','--binary','--full-index','--no-ext-diff',baseSha,headSha,'--'],cwd);
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
  const scope = manifest.allowed_change_paths ?? [];
  const writableChanged:string[]=[];
  for (const path of changed) {
    if (sensitive(path)) throw new GateError(`sensitive path changed: ${path}`);
    if (preserved.has(path) && manifest.preserved_baseline &&
        await gitSucceeds(['diff','--quiet',manifest.preserved_baseline.head_sha,'HEAD','--',path],cwd)) {
      continue;
    }
    writableChanged.push(path);
    if (!scope.some((allowed) => matches(path, allowed))) {
      throw new GateError(`changed path is outside approved scope: ${path}`);
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
async function freshness(manifest:Manifest,manifestPath:string,cwd:string):Promise<Record<string,unknown>>{
  assertSetup(manifest.git_setup);assertScope(manifest.allowed_change_paths);assertScope(manifest.freshness_sensitive_paths);
  const info=await inspect(cwd);if(!info.linked_worktree||info.branch!==manifest.git_setup.branch)throw new GateError('freshness requires the approved owner-created linked worktree');if(!info.clean)throw new GateError('freshness requires a clean tracked checkout');await validatePreservedBaseline(manifest,cwd);
  if(!await gitSucceeds(['merge-base','--is-ancestor',manifest.git_setup.base_sha,'HEAD'],cwd))throw new GateError('current branch no longer contains planning base');
  await git(['fetch','origin','main:refs/remotes/origin/main'],cwd);const remoteMain=await git(['rev-parse','refs/remotes/origin/main'],cwd);const previousRuntime=await readRuntime(manifestPath,manifest.git_setup);const previousBase=previousRuntime?.run_base_sha??manifest.git_setup.base_sha;
  if(!await gitSucceeds(['merge-base','--is-ancestor',previousBase,remoteMain],cwd))throw new GateError('STALE_PLAN: origin/main history diverged from approved/effective base');
  const upstreamChanged=(await git(['diff','--name-only',previousBase,remoteMain],cwd)).split('\n').filter(Boolean).sort();const scopes=[...(manifest.allowed_change_paths??[]),...(manifest.freshness_sensitive_paths??[]),...(manifest.preserved_baseline?.changed_paths??[])];const relevant=upstreamChanged.filter(file=>freshnessGlobal(file)||scopes.some(scope=>matches(file,scope)));if(relevant.length)throw new GateError(`STALE_PLAN: origin/main changed plan-relevant paths: ${relevant.join(', ')}`);
  if(!await gitSucceeds(['merge-base','--is-ancestor',remoteMain,'HEAD'],cwd)){try{await git(['merge','--no-edit','refs/remotes/origin/main'],cwd);}catch(error){await gitSucceeds(['merge','--abort'],cwd);throw new GateError(`STALE_PLAN: safe main merge conflicted: ${error instanceof Error?error.message:String(error)}`);}}
  const mergedHead=await git(['rev-parse','HEAD'],cwd);const runtime:GitRuntime={planning_base_sha:manifest.git_setup.base_sha,run_base_sha:remoteMain,merged_head_sha:mergedHead,upstream_changed_files:upstreamChanged,refreshed_at:new Date().toISOString()};await writeJsonAtomic(runtimeEvidencePath(manifestPath),runtime);await updateRunBaseState(manifestPath,remoteMain);return runtime;
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
async function main(): Promise<void> {
  const [command, manifestPath] = process.argv.slice(2);
  const cwd = await git(['rev-parse', '--show-toplevel']);
  if (command === 'inspect' && !manifestPath) {
    console.log(JSON.stringify({ status: 'PASS', gate: 'git_worktree', command, ...await inspect(cwd) }));
    return;
  }
  if (command === 'baseline' && manifestPath) {
    console.log(JSON.stringify({ status: 'PASS', gate: 'git_worktree', command, ...await baselineSnapshot(manifestPath,cwd) }));
    return;
  }
  if (!manifestPath || !['freshness', 'adopt', 'verify', 'publish'].includes(command ?? '')) {
    throw new GateError('usage: git-worktree-cli.ts inspect | baseline <base-sha> | freshness|adopt|verify|publish <manifest.json>; setup is disabled');
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
  assertSetup(manifest.git_setup);assertScope(manifest.allowed_change_paths);assertScope(manifest.freshness_sensitive_paths);
  let details: Record<string, unknown> = {};
  if(command==='freshness')details=await freshness(manifest,manifestPath,cwd);
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
