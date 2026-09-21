import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
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
type Manifest = {
  run_id?: string;
  git_setup?: GitSetup;
  allowed_change_paths?: string[];
};
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
  // No implicit fetch, checkout, branch creation or file transplantation in manual mode.
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
function sensitive(path: string): boolean {
  const name = path.split('/').pop() ?? path;
  return name === '.env' || (/^\.env\./.test(name) && name !== '.env.example') ||
    /\.(key|pem|p12|pfx|secret)$/i.test(name);
}
async function inspect(cwd: string): Promise<Record<string, unknown>> {
  const [head, branch, linked, main, dirty, trackedPipeline] = await Promise.all([
    git(['rev-parse', 'HEAD'], cwd),
    git(['branch', '--show-current'], cwd),
    git(['rev-parse', '--is-linked-worktree'], cwd),
    git(['rev-parse', '--verify', 'refs/heads/main'], cwd),
    git(['status', '--porcelain', '--untracked-files=all'], cwd),
    git(['ls-files', '--', '.tmp/pipelines'], cwd),
  ]);
  return { head, branch, linked_worktree: linked === 'true', main_sha: main,
    clean: dirty.length === 0, pipeline_artifacts_tracked: Boolean(trackedPipeline),
    directory: cwd };
}
async function assertIdentity(setup: GitSetup, cwd: string): Promise<void> {
  const info = await inspect(cwd);
  if (!info.linked_worktree) throw new GateError('current checkout must be an owner-created linked worktree (not primary/main)');
  if (info.branch !== setup.branch) throw new GateError(`selected branch mismatch: ${String(info.branch)}`);
  if (info.pipeline_artifacts_tracked) throw new GateError('.tmp/pipelines is tracked: archive/untrack safely before proceeding');
  if (String(info.main_sha).toLowerCase() !== setup.base_sha.toLowerCase()) {
    throw new GateError(`STALE_PLAN: main moved from approved base ${setup.base_sha} to ${String(info.main_sha)}; preserve old run, refresh PLAN and obtain new approval`);
  }
  if (!await gitSucceeds(['merge-base', '--is-ancestor', setup.base_sha, 'HEAD'], cwd)) {
    throw new GateError('current branch does not contain approved main base; owner must update worktree and re-plan');
  }
  for (const path of setup.must_absent ?? []) {
    if (await gitSucceeds(['ls-files', '--error-unmatch', '--', path], cwd)) {
      throw new GateError(`forbidden tracked path exists: ${path}`);
    }
    try {
      const { lstat } = await import('node:fs/promises');
      await lstat(join(cwd, path));
      throw new GateError(`forbidden path exists: ${path}`);
    } catch (error) {
      if (error instanceof GateError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
async function changedFiles(setup: GitSetup, cwd: string): Promise<string[]> {
  const outputs = await Promise.all([
    git(['diff', '--name-only', setup.base_sha, 'HEAD'], cwd),
    git(['diff', '--name-only'], cwd),
    git(['diff', '--cached', '--name-only'], cwd),
    git(['ls-files', '--others', '--exclude-standard'], cwd),
  ]);
  return [...new Set(outputs.flatMap((out) => out.split('\n').filter(Boolean)))].sort();
}
async function verify(manifest: Manifest, cwd: string): Promise<string[]> {
  assertSetup(manifest.git_setup);
  assertScope(manifest.allowed_change_paths);
  await assertIdentity(manifest.git_setup, cwd);
  const changed = await changedFiles(manifest.git_setup, cwd);
  const scope = manifest.allowed_change_paths ?? [];
  for (const path of changed) {
    if (sensitive(path)) throw new GateError(`sensitive path changed: ${path}`);
    if (!scope.some((allowed) => matches(path, allowed))) {
      throw new GateError(`changed path is outside approved scope: ${path}`);
    }
  }
  return changed;
}
async function publish(manifest: Manifest, manifestPath: string, cwd: string): Promise<Record<string, unknown>> {
  assertSetup(manifest.git_setup);
  let changed = await verify(manifest, cwd);
  const working = await Promise.all([
    git(['diff', '--name-only'], cwd), git(['diff', '--cached', '--name-only'], cwd),
    git(['ls-files', '--others', '--exclude-standard'], cwd),
  ]);
  if (working.some((value) => value.length > 0)) {
    await git(['add', '-A'], cwd);
    await verify(manifest, cwd);
    const run = String(manifest.run_id ?? 'run').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
    await git(['commit', '-m', `pipeline(${run}): candidate`], cwd);
  }
  changed = await verify(manifest, cwd);
  const candidate = await git(['rev-parse', 'HEAD'], cwd);
  await git(['push', 'origin', `HEAD:refs/heads/${manifest.git_setup.branch}`], cwd);
  const remote = (await git(['ls-remote', '--heads', 'origin', `refs/heads/${manifest.git_setup.branch}`], cwd))
    .split(/\s+/)[0] ?? '';
  if (candidate.toLowerCase() !== remote.toLowerCase()) throw new GateError('remote candidate SHA mismatch');
  const evidencePath = join(dirname(resolve(manifestPath)), 'candidate.json');
  const evidence = { status: 'PASS', branch: manifest.git_setup.branch,
    candidate_sha: candidate, remote_sha: remote, changed_files: changed,
    published_at: new Date().toISOString() };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return { ...evidence, evidence: evidencePath };
}
async function main(): Promise<void> {
  const [command, manifestPath] = process.argv.slice(2);
  const cwd = await git(['rev-parse', '--show-toplevel']);
  if (command === 'inspect' && !manifestPath) {
    console.log(JSON.stringify({ status: 'PASS', gate: 'git_worktree', command, ...await inspect(cwd) }));
    return;
  }
  if (!manifestPath || !['adopt', 'verify', 'publish'].includes(command ?? '')) {
    throw new GateError('usage: git-worktree-cli.ts inspect | adopt|verify|publish <manifest.json>; setup is disabled');
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
  assertSetup(manifest.git_setup);
  assertScope(manifest.allowed_change_paths);
  let details: Record<string, unknown> = {};
  if (command === 'adopt') {
    await assertIdentity(manifest.git_setup, cwd);
    if (await git(['status', '--porcelain', '--untracked-files=all'], cwd)) {
      throw new GateError('adopt requires clean checkout; save tracked preparation before approval');
    }
    details = { main_sha: manifest.git_setup.base_sha, directory: cwd };
  }
  if (command === 'verify') details = { changed_files: await verify(manifest, cwd) };
  if (command === 'publish') details = await publish(manifest, manifestPath, cwd);
  console.log(JSON.stringify({ status: 'PASS', gate: 'git_worktree', command,
    branch: manifest.git_setup.branch, ...details }));
}
main().catch((error: unknown) => {
  console.error(`BLOCKED: git_worktree: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
