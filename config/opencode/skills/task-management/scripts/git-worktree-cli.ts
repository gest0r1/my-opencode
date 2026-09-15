import { execFile } from 'node:child_process';
import { lstat, readFile, writeFile } from 'node:fs/promises';
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

function assertRelativePath(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').includes('..') ||
    value.split('/').includes('.git')
  ) {
    throw new GateError(`${field} must be a safe repository-relative path`);
  }
}

function assertSetup(value: unknown): asserts value is GitSetup {
  if (!value || typeof value !== 'object') throw new GateError('manifest.git_setup is required');
  const setup = value as Partial<GitSetup>;
  if (!SHA.test(setup.base_sha ?? '')) throw new GateError('git_setup.base_sha must be a 40-hex SHA');
  if (
    typeof setup.branch !== 'string' ||
    !BRANCH.test(setup.branch) ||
    setup.branch.includes('..') ||
    setup.branch.endsWith('/')
  ) {
    throw new GateError('git_setup.branch is unsafe or protected');
  }
  if (setup.source_sha !== undefined && !SHA.test(setup.source_sha)) {
    throw new GateError('git_setup.source_sha must be a 40-hex SHA');
  }
  for (const path of setup.checkout_paths ?? []) assertRelativePath(path, 'git_setup.checkout_paths[]');
  for (const path of setup.must_absent ?? []) assertRelativePath(path, 'git_setup.must_absent[]');
  if (setup.source_sha && (!Array.isArray(setup.checkout_paths) || setup.checkout_paths.length === 0)) {
    throw new GateError('git_setup.source_sha requires non-empty checkout_paths');
  }
}

function assertAllowedChangePaths(value: unknown): asserts value is string[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new GateError('allowed_change_paths must be an array');
  for (const path of value) {
    if (typeof path !== 'string' || !path) throw new GateError('allowed_change_paths must contain strings');
    const normalized = path.endsWith('/**') ? path.slice(0, -3) : path;
    assertRelativePath(normalized, 'allowed_change_paths[]');
  }
}

function pathMatches(path: string, scope: string): boolean {
  if (scope.endsWith('/**')) {
    const prefix = scope.slice(0, -3).replace(/\/$/, '');
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  return path === scope;
}

function isSensitivePath(path: string): boolean {
  const name = path.split('/').pop() ?? path;
  if (name === '.env' || (/^\.env\./.test(name) && name !== '.env.example')) return true;
  return /\.(?:key|pem|p12|pfx|secret)$/i.test(name);
}

async function git(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  } catch (error: any) {
    const detail = String(error?.stderr ?? error?.message ?? error).trim();
    throw new GateError(`git ${args[0] ?? 'command'} failed${detail ? `: ${detail}` : ''}`);
  }
}

async function gitSucceeds(args: string[], cwd?: string): Promise<boolean> {
  try {
    await execFileAsync('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

async function rootDir(): Promise<string> {
  return git(['rev-parse', '--show-toplevel']);
}

async function assertCleanAndBase(setup: GitSetup, cwd: string): Promise<void> {
  if (await git(['status', '--porcelain'], cwd)) throw new GateError('worktree is not clean');
  const head = await git(['rev-parse', 'HEAD'], cwd);
  if (head.toLowerCase() !== setup.base_sha.toLowerCase()) {
    throw new GateError(`HEAD does not match approved base_sha (${head})`);
  }
  await git(['rev-parse', '--verify', `${setup.base_sha}^{commit}`], cwd);
}

async function sourceAvailable(setup: GitSetup, cwd: string): Promise<boolean> {
  if (!setup.source_sha) return true;
  return gitSucceeds(['rev-parse', '--verify', `${setup.source_sha}^{commit}`], cwd);
}

async function ensureSource(setup: GitSetup, cwd: string): Promise<void> {
  if (!setup.source_sha || (await sourceAvailable(setup, cwd))) return;
  await git(['fetch', '--no-tags', '--depth=1', 'origin', setup.source_sha], cwd);
  await git(['rev-parse', '--verify', `${setup.source_sha}^{commit}`], cwd);
}

async function assertCheckoutPathsExist(setup: GitSetup, cwd: string): Promise<void> {
  if (!setup.source_sha) return;
  for (const path of setup.checkout_paths ?? []) {
    const exists = await gitSucceeds(['cat-file', '-e', `${setup.source_sha}:${path}`], cwd);
    if (!exists) throw new GateError(`checkout path not found in source_sha: ${path}`);
  }
}

async function assertAbsent(setup: GitSetup, cwd: string): Promise<void> {
  for (const path of setup.must_absent ?? []) {
    try {
      await lstat(join(cwd, path));
      throw new GateError(`forbidden path is present: ${path}`);
    } catch (error) {
      if (error instanceof GateError) throw error;
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') throw new GateError(`cannot verify forbidden path ${path}: ${String(error)}`);
    }
  }
}

async function changedFiles(cwd: string): Promise<string[]> {
  const outputs = await Promise.all([
    git(['diff', '--name-only'], cwd),
    git(['diff', '--cached', '--name-only'], cwd),
    git(['ls-files', '--others', '--exclude-standard'], cwd),
  ]);
  return [...new Set(outputs.flatMap((value) => value.split('\n').filter(Boolean)))].sort();
}

function effectiveScope(manifest: Manifest): string[] {
  if (manifest.allowed_change_paths?.length) return manifest.allowed_change_paths;
  return manifest.git_setup?.checkout_paths ?? [];
}

async function verifyScope(manifest: Manifest, cwd: string): Promise<string[]> {
  assertSetup(manifest.git_setup);
  assertAllowedChangePaths(manifest.allowed_change_paths);
  const branch = await git(['branch', '--show-current'], cwd);
  if (branch !== manifest.git_setup.branch) {
    throw new GateError(`current branch does not match approved branch (${branch || 'detached'})`);
  }
  await assertAbsent(manifest.git_setup, cwd);

  const changed = await changedFiles(cwd);
  const scope = effectiveScope(manifest);
  if (changed.length > 0 && scope.length === 0) {
    throw new GateError('changed files exist but allowed_change_paths is empty');
  }
  for (const path of changed) {
    if (isSensitivePath(path)) throw new GateError(`sensitive path changed: ${path}`);
    if (!scope.some((allowed) => pathMatches(path, allowed))) {
      throw new GateError(`changed path is outside approved scope: ${path}`);
    }
  }
  return changed;
}

async function capability(setup: GitSetup, cwd: string): Promise<{ source_local: boolean }> {
  await assertCleanAndBase(setup, cwd);
  await assertAbsent(setup, cwd);
  return { source_local: await sourceAvailable(setup, cwd) };
}

async function setupWorktree(manifest: Manifest, cwd: string): Promise<void> {
  assertSetup(manifest.git_setup);
  assertAllowedChangePaths(manifest.allowed_change_paths);
  const setup = manifest.git_setup;
  await assertCleanAndBase(setup, cwd);
  await assertAbsent(setup, cwd);
  const existing = await gitSucceeds(['show-ref', '--verify', '--quiet', `refs/heads/${setup.branch}`], cwd);
  if (existing) throw new GateError(`task branch already exists: ${setup.branch}`);

  await ensureSource(setup, cwd);
  await assertCheckoutPathsExist(setup, cwd);
  if (setup.checkout_paths?.length && manifest.allowed_change_paths?.length) {
    for (const path of setup.checkout_paths) {
      if (!manifest.allowed_change_paths.some((scope) => pathMatches(path, scope))) {
        throw new GateError(`checkout path is outside allowed_change_paths: ${path}`);
      }
    }
  }

  await git(['switch', '-c', setup.branch, setup.base_sha], cwd);
  if (setup.source_sha) await git(['checkout', setup.source_sha, '--', ...(setup.checkout_paths ?? [])], cwd);
  await verifyScope(manifest, cwd);
}

async function publishCandidate(manifest: Manifest, manifestPath: string, cwd: string): Promise<Record<string, unknown>> {
  assertSetup(manifest.git_setup);
  const changed = await verifyScope(manifest, cwd);
  if (changed.length > 0) {
    await git(['add', '-A'], cwd);
    await verifyScope(manifest, cwd);
    const runId = String(manifest.run_id ?? 'run').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
    await git(['commit', '-m', `pipeline(${runId}): candidate`], cwd);
  }

  const candidateSha = await git(['rev-parse', 'HEAD'], cwd);
  await git(['push', 'origin', `HEAD:refs/heads/${manifest.git_setup.branch}`], cwd);
  const remoteLine = await git(['ls-remote', '--heads', 'origin', `refs/heads/${manifest.git_setup.branch}`], cwd);
  const remoteSha = remoteLine.split(/\s+/)[0] ?? '';
  if (remoteSha.toLowerCase() !== candidateSha.toLowerCase()) {
    throw new GateError(`remote SHA mismatch after publish: local=${candidateSha} remote=${remoteSha || 'missing'}`);
  }

  const evidencePath = join(dirname(resolve(manifestPath)), 'candidate.json');
  const evidence = {
    status: 'PASS',
    branch: manifest.git_setup.branch,
    candidate_sha: candidateSha,
    remote_sha: remoteSha,
    changed_files: changed,
    published_at: new Date().toISOString(),
  };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return { ...evidence, evidence: evidencePath };
}

async function main(): Promise<void> {
  const [command, manifestPath] = process.argv.slice(2);
  const cwd = await rootDir();

  if (command === 'inspect' && !manifestPath) {
    const head = await git(['rev-parse', 'HEAD'], cwd);
    const branch = await git(['branch', '--show-current'], cwd);
    const dirty = Boolean(await git(['status', '--porcelain'], cwd));
    const branches = (await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], cwd))
      .split('\n')
      .filter(Boolean);
    console.log(JSON.stringify({ status: 'PASS', gate: 'git_worktree', command, head, branch, clean: !dirty, branches }));
    return;
  }

  if (!manifestPath || !['capability', 'setup', 'verify', 'publish'].includes(command ?? '')) {
    throw new GateError('usage: git-worktree-cli.ts inspect | capability|setup|verify|publish <manifest.json>');
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
  assertSetup(manifest.git_setup);
  assertAllowedChangePaths(manifest.allowed_change_paths);

  let details: Record<string, unknown> = {};
  if (command === 'capability') details = await capability(manifest.git_setup, cwd);
  if (command === 'setup') await setupWorktree(manifest, cwd);
  if (command === 'verify') details = { changed_files: await verifyScope(manifest, cwd) };
  if (command === 'publish') details = await publishCandidate(manifest, manifestPath, cwd);
  console.log(
    JSON.stringify({
      status: 'PASS',
      gate: 'git_worktree',
      command,
      branch: manifest.git_setup.branch,
      ...details,
    }),
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`BLOCKED: git_worktree: ${message}`);
  process.exitCode = 1;
});
