import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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

type Manifest = { git_setup?: GitSetup };

class GateError extends Error {}

function assertRelativePath(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') || value.split('/').includes('..')) {
    throw new GateError(`${field} must be a repository-relative path`);
  }
}

function assertSetup(value: unknown): asserts value is GitSetup {
  if (!value || typeof value !== 'object') throw new GateError('manifest.git_setup is required');
  const setup = value as Partial<GitSetup>;
  if (!SHA.test(setup.base_sha ?? '')) throw new GateError('git_setup.base_sha must be a 40-hex SHA');
  if (typeof setup.branch !== 'string' || !BRANCH.test(setup.branch) || setup.branch.includes('..') || setup.branch.endsWith('/')) {
    throw new GateError('git_setup.branch is unsafe or protected');
  }
  if (setup.source_sha !== undefined && !SHA.test(setup.source_sha)) throw new GateError('git_setup.source_sha must be a 40-hex SHA');
  for (const path of setup.checkout_paths ?? []) assertRelativePath(path, 'git_setup.checkout_paths[]');
  for (const path of setup.must_absent ?? []) assertRelativePath(path, 'git_setup.must_absent[]');
  if (setup.source_sha && (!Array.isArray(setup.checkout_paths) || setup.checkout_paths.length === 0)) {
    throw new GateError('git_setup.source_sha requires non-empty checkout_paths');
  }
}

async function git(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 2 * 1024 * 1024 });
    return stdout.trim();
  } catch (error: any) {
    const detail = String(error?.stderr ?? error?.message ?? error).trim();
    throw new GateError(`git ${args[0] ?? 'command'} failed${detail ? `: ${detail}` : ''}`);
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
  if (setup.source_sha) await git(['rev-parse', '--verify', `${setup.source_sha}^{commit}`], cwd);
}

async function assertAbsent(setup: GitSetup, cwd: string): Promise<void> {
  for (const path of setup.must_absent ?? []) {
    const present = await git(['ls-files', '--error-unmatch', '--', path], cwd)
      .then(() => true)
      .catch(() => false);
    if (present) throw new GateError(`forbidden path is present: ${path}`);
  }
}

async function setupWorktree(setup: GitSetup, cwd: string): Promise<void> {
  await assertCleanAndBase(setup, cwd);
  const existing = await git(['show-ref', '--verify', '--quiet', `refs/heads/${setup.branch}`], cwd)
    .then(() => true)
    .catch(() => false);
  if (existing) throw new GateError(`task branch already exists: ${setup.branch}`);
  await git(['switch', '-c', setup.branch, setup.base_sha], cwd);
  if (setup.source_sha) await git(['checkout', setup.source_sha, '--', ...(setup.checkout_paths ?? [])], cwd);
  await assertAbsent(setup, cwd);
}

async function verify(setup: GitSetup, cwd: string): Promise<void> {
  const branch = await git(['branch', '--show-current'], cwd);
  if (branch !== setup.branch) throw new GateError(`current branch does not match approved branch (${branch || 'detached'})`);
  await assertAbsent(setup, cwd);
}

async function main(): Promise<void> {
  const [command, manifestPath] = process.argv.slice(2);
  if ((command !== 'capability' && command !== 'setup' && command !== 'verify') || !manifestPath) {
    throw new GateError('usage: git-worktree-cli.ts capability|setup|verify <manifest.json>');
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
  assertSetup(manifest.git_setup);
  const cwd = await rootDir();
  if (command === 'capability') await assertCleanAndBase(manifest.git_setup, cwd);
  if (command === 'setup') await setupWorktree(manifest.git_setup, cwd);
  if (command === 'verify') await verify(manifest.git_setup, cwd);
  console.log(JSON.stringify({ status: 'PASS', gate: 'git_worktree', command, branch: manifest.git_setup.branch }));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`BLOCKED: git_worktree: ${message}`);
  process.exitCode = 1;
});
