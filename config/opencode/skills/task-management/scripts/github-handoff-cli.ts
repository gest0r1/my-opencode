import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

const STATE_ROOT = '.tmp/pipelines';
const HANDOFF_FILE = '.opencode/pipeline-handoff.json';
const SHA_RE = /^[0-9a-f]{40}$/i;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

class HandoffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandoffError';
  }
}

type ValidationCommands = {
  build?: string[];
  deploy?: string[];
  test?: string[];
  smoke?: string[];
};

type GithubHandoff = {
  schema_version: 1;
  provider: 'github';
  handoff_id: string;
  run_id: string;
  repository?: string;
  source_branch: string;
  source_sha: string;
  pipeline_id: string;
  rules_file: string;
  rules_version: number;
  validation_stages: string[];
  acceptance?: string[];
  allowed_fix_scope?: string[];
  validation?: ValidationCommands;
};

type HandoffRuntime = {
  schema_version: 1;
  mode: 'github-validation';
  handoff: GithubHandoff;
  handoff_ref: string;
  source_remote_ref: string;
  working_branch: string;
  prepared_at: string;
  source_sha: string;
  validated_sha?: string;
  published_at?: string;
};

function git(args: string[], options: { trim?: boolean } = {}): string {
  try {
    const out = execFileSync('git', args, {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return options.trim === false ? out : out.trim();
  } catch (error: any) {
    const stderr = String(error?.stderr ?? '').trim();
    throw new HandoffError(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
}

function assertId(value: string, label: string): void {
  if (!ID_RE.test(value)) throw new HandoffError(`Invalid ${label}: ${value}`);
}

function assertBranch(value: string): void {
  if (!BRANCH_RE.test(value) || value.includes('..') || value.includes('//') || value.endsWith('/') || value.endsWith('.')) {
    throw new HandoffError(`Invalid source_branch: ${value}`);
  }
  git(['check-ref-format', '--branch', value]);
}

function assertSha(value: string): void {
  if (!SHA_RE.test(value)) throw new HandoffError(`Invalid source_sha: ${value}`);
}

function normalizeRepository(remote: string): string | undefined {
  const value = remote.trim().replace(/\.git$/, '');
  const ssh = value.match(/^git@github\.com:([^/]+\/[^/]+)$/i);
  if (ssh?.[1]) return ssh[1];
  const https = value.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)$/i);
  if (https?.[1]) return https[1];
  return undefined;
}

function assertHandoff(value: unknown, expectedRun: string, expectedId: string): GithubHandoff {
  if (!value || typeof value !== 'object') throw new HandoffError('Handoff must be an object');
  const h = value as Partial<GithubHandoff>;
  if (
    h.schema_version !== 1 ||
    h.provider !== 'github' ||
    h.handoff_id !== expectedId ||
    h.run_id !== expectedRun ||
    typeof h.source_branch !== 'string' ||
    typeof h.source_sha !== 'string' ||
    typeof h.pipeline_id !== 'string' ||
    typeof h.rules_file !== 'string' ||
    typeof h.rules_version !== 'number' ||
    !Number.isInteger(h.rules_version) ||
    !Array.isArray(h.validation_stages) ||
    h.validation_stages.length === 0 ||
    h.validation_stages.some((stage) => typeof stage !== 'string' || !stage.trim())
  ) {
    throw new HandoffError(
      'Handoff must define schema_version=1, provider=github, matching handoff_id/run_id, source_branch, source_sha, pipeline_id, rules_file, rules_version and validation_stages',
    );
  }
  assertBranch(h.source_branch);
  assertSha(h.source_sha);
  if (h.allowed_fix_scope && (!Array.isArray(h.allowed_fix_scope) || h.allowed_fix_scope.some((p) => typeof p !== 'string'))) {
    throw new HandoffError('allowed_fix_scope must be an array of paths');
  }
  for (const pattern of h.allowed_fix_scope ?? []) {
    if (pattern.includes('*') && !pattern.endsWith('/**')) {
      throw new HandoffError(`allowed_fix_scope supports only exact paths or trailing /**: ${pattern}`);
    }
  }
  for (const commands of Object.values(h.validation ?? {})) {
    if (!Array.isArray(commands) || commands.some((cmd) => typeof cmd !== 'string' || !cmd.trim())) {
      throw new HandoffError('validation command groups must be arrays of non-empty strings');
    }
  }
  return h as GithubHandoff;
}

function stateDir(runId: string): string {
  return resolve(STATE_ROOT, runId);
}

function runtimePath(runId: string): string {
  return join(stateDir(runId), 'github-handoff.json');
}

function validationManifestPath(runId: string): string {
  return join(stateDir(runId), 'github-validation-manifest.json');
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readRuntime(runId: string): Promise<HandoffRuntime> {
  try {
    return JSON.parse(await readFile(runtimePath(runId), 'utf8')) as HandoffRuntime;
  } catch {
    throw new HandoffError(`GitHub handoff runtime not found: ${runId}`);
  }
}

function requireGitRepository(): void {
  if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') {
    throw new HandoffError('Current directory is not a Git worktree');
  }
}

function requireCleanWorktree(): void {
  const dirty = git(['status', '--porcelain=v1', '--untracked-files=all']);
  if (dirty) throw new HandoffError(`Worktree must be clean before GitHub handoff:\n${dirty}`);
}

function verifyRepository(handoff: GithubHandoff): void {
  if (!handoff.repository) return;
  const origin = git(['remote', 'get-url', 'origin']);
  const actual = normalizeRepository(origin);
  if (!actual) throw new HandoffError(`Cannot normalize origin as GitHub repository: ${origin}`);
  if (actual.toLowerCase() !== handoff.repository.toLowerCase()) {
    throw new HandoffError(`Repository mismatch: handoff=${handoff.repository}, origin=${actual}`);
  }
}

function isAncestor(ancestor: string, descendant: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd: process.cwd(),
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function scopeAllows(file: string, patterns: string[]): boolean {
  const normalized = file.replace(/^\.\//, '');
  return patterns.some((pattern) => {
    const p = pattern.replace(/^\.\//, '');
    if (p.endsWith('/**')) {
      const prefix = p.slice(0, -3).replace(/\/$/, '');
      return normalized === prefix || normalized.startsWith(`${prefix}/`);
    }
    return normalized === p;
  });
}

function changedFiles(): string[] {
  const output = git(['status', '--porcelain=v1', '--untracked-files=all']);
  if (!output) return [];
  return output
    .split('\n')
    .map((line) => line.slice(3).trim())
    .map((file) => (file.includes(' -> ') ? file.split(' -> ').pop() ?? file : file))
    .filter(Boolean);
}

function rejectSensitiveFiles(files: string[]): void {
  const sensitive = files.filter((file) => {
    const base = file.toLowerCase();
    return (
      base.includes('/.git/') ||
      base.startsWith('.git/') ||
      /(^|\/)\.env($|\.)/.test(base) ||
      /\.(key|pem|p12|pfx|secret)$/i.test(base) ||
      /(^|\/)(secrets?|credentials?)(\.|\/|$)/i.test(base)
    );
  });
  if (sensitive.length) throw new HandoffError(`Refusing to publish sensitive paths: ${sensitive.join(', ')}`);
}

async function prepare(runId: string, handoffId: string): Promise<unknown> {
  assertId(runId, 'run-id');
  assertId(handoffId, 'handoff-id');
  requireGitRepository();
  requireCleanWorktree();

  const handoffBranch = `handoff/${handoffId}`;
  const handoffRef = `refs/remotes/origin/${handoffBranch}`;
  git(['fetch', '--prune', 'origin', `refs/heads/${handoffBranch}:${handoffRef}`]);

  let raw: string;
  try {
    raw = git(['show', `${handoffRef}:${HANDOFF_FILE}`], { trim: false });
  } catch {
    throw new HandoffError(`Handoff ref must contain ${HANDOFF_FILE}: ${handoffBranch}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HandoffError(`Invalid JSON in ${handoffBranch}:${HANDOFF_FILE}`);
  }
  const handoff = assertHandoff(parsed, runId, handoffId);
  verifyRepository(handoff);

  const sourceRemoteRef = `refs/remotes/origin/${handoff.source_branch}`;
  git(['fetch', '--prune', 'origin', `refs/heads/${handoff.source_branch}:${sourceRemoteRef}`]);
  const remoteSha = git(['rev-parse', sourceRemoteRef]);
  if (remoteSha.toLowerCase() !== handoff.source_sha.toLowerCase()) {
    throw new HandoffError(
      `Source branch moved after handoff: expected=${handoff.source_sha}, origin/${handoff.source_branch}=${remoteSha}`,
    );
  }
  if (!isAncestor(handoff.source_sha, handoffRef)) {
    throw new HandoffError(`Handoff ref is not based on source_sha: ${handoff.source_sha}`);
  }

  const workingBranch = `pipeline/${runId}`;
  git(['switch', '-C', workingBranch, handoff.source_sha]);
  const head = git(['rev-parse', 'HEAD']);
  if (head.toLowerCase() !== handoff.source_sha.toLowerCase()) {
    throw new HandoffError(`Checkout verification failed: HEAD=${head}, source_sha=${handoff.source_sha}`);
  }

  const runtime: HandoffRuntime = {
    schema_version: 1,
    mode: 'github-validation',
    handoff,
    handoff_ref: handoffRef,
    source_remote_ref: sourceRemoteRef,
    working_branch: workingBranch,
    prepared_at: new Date().toISOString(),
    source_sha: handoff.source_sha,
  };
  await writeJson(runtimePath(runId), runtime);

  const validationManifest = {
    schema_version: 1,
    run_id: runId,
    rules_file: handoff.rules_file,
    rules_version: handoff.rules_version,
    planning_mode: 'github-validation',
    planning_readiness: 'ready',
    github_handoff: {
      handoff_id: handoff.handoff_id,
      source_branch: handoff.source_branch,
      source_sha: handoff.source_sha,
    },
    pipelines: [
      {
        id: handoff.pipeline_id,
        stages: handoff.validation_stages,
      },
    ],
  };
  await writeJson(validationManifestPath(runId), validationManifest);

  return {
    status: 'prepared',
    run_id: runId,
    handoff_id: handoffId,
    pipeline_id: handoff.pipeline_id,
    source_branch: handoff.source_branch,
    source_sha: handoff.source_sha,
    working_branch: workingBranch,
    validation_stages: handoff.validation_stages,
    validation_manifest: validationManifestPath(runId),
    runtime: runtimePath(runId),
  };
}

async function publish(runId: string): Promise<unknown> {
  assertId(runId, 'run-id');
  requireGitRepository();
  const runtime = await readRuntime(runId);
  const { handoff } = runtime;
  const branch = git(['branch', '--show-current']);
  if (branch !== runtime.working_branch) {
    throw new HandoffError(`Wrong working branch: expected=${runtime.working_branch}, actual=${branch || '(detached)'}`);
  }

  const files = changedFiles();
  rejectSensitiveFiles(files);
  if (files.length) {
    const scope = handoff.allowed_fix_scope ?? [];
    if (!scope.length) throw new HandoffError('Fixes exist but allowed_fix_scope is empty');
    const outside = files.filter((file) => !scopeAllows(file, scope));
    if (outside.length) throw new HandoffError(`Changed files outside allowed_fix_scope: ${outside.join(', ')}`);
    git(['add', '--', ...files]);
    git(['commit', '-m', `fix: validation ${runId}`]);
  }

  const head = git(['rev-parse', 'HEAD']);
  if (!isAncestor(runtime.source_sha, head)) {
    throw new HandoffError(`Validated HEAD is not descended from source_sha: ${runtime.source_sha}`);
  }

  git(['fetch', '--prune', 'origin', `refs/heads/${handoff.source_branch}:${runtime.source_remote_ref}`]);
  const remoteSha = git(['rev-parse', runtime.source_remote_ref]);
  if (!isAncestor(remoteSha, head)) {
    throw new HandoffError(
      `Remote source branch changed independently; refusing non-fast-forward publish: remote=${remoteSha}, local=${head}`,
    );
  }

  git(['push', 'origin', `HEAD:refs/heads/${handoff.source_branch}`]);
  git(['fetch', 'origin', `refs/heads/${handoff.source_branch}:${runtime.source_remote_ref}`]);
  const verifiedRemote = git(['rev-parse', runtime.source_remote_ref]);
  if (verifiedRemote.toLowerCase() !== head.toLowerCase()) {
    throw new HandoffError(`Push verification failed: local=${head}, remote=${verifiedRemote}`);
  }

  runtime.validated_sha = head;
  runtime.published_at = new Date().toISOString();
  await writeJson(runtimePath(runId), runtime);

  return {
    status: 'published',
    run_id: runId,
    handoff_id: handoff.handoff_id,
    source_sha: runtime.source_sha,
    validated_sha: head,
    source_branch: handoff.source_branch,
    fixes_committed: files.length > 0,
    changed_files: files,
  };
}

async function status(runId: string): Promise<unknown> {
  assertId(runId, 'run-id');
  const runtime = await readRuntime(runId);
  const head = git(['rev-parse', 'HEAD']);
  const branch = git(['branch', '--show-current']);
  return {
    ...runtime,
    current_head: head,
    current_branch: branch,
    worktree_clean: changedFiles().length === 0,
    state_exists: await exists(join(stateDir(runId), 'state.json')),
    validation_manifest: validationManifestPath(runId),
  };
}

function usage(): never {
  throw new HandoffError(
    [
      'Usage:',
      '  github-handoff-cli.ts prepare <run-id> <handoff-id>',
      '  github-handoff-cli.ts publish <run-id>',
      '  github-handoff-cli.ts status <run-id>',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const [command, runId, handoffId, ...extra] = process.argv.slice(2);
  if (!command || !runId || extra.length) usage();
  let result: unknown;
  if (command === 'prepare') {
    if (!handoffId) usage();
    result = await prepare(runId, handoffId);
  } else if (command === 'publish') {
    if (handoffId) usage();
    result = await publish(runId);
  } else if (command === 'status') {
    if (handoffId) usage();
    result = await status(runId);
  } else {
    usage();
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ status: 'blocked', error: message })}\n`);
  process.exitCode = 1;
});
