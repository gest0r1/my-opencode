import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

const HANDOFF_FILE = '.opencode/pipeline-handoff.json';
const SHA_RE = /^[0-9a-f]{40}$/i;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

const ENV_KEY = 'PIPELINE_PROJECT_ROOT';

export function resolveProjectRoot(explicit?: string, env?: string, cwd?: string): string {
  const start = explicit ?? env ?? (cwd ?? process.cwd());
  try {
    const toplevel = execFileSync('git', ['-C', start, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return toplevel;
  } catch {
    throw new HandoffError(
      'INVALID_PROJECT_ROOT',
      `Not a Git repository: ${start}`,
      { tried: start },
    );
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

type ProcessFailure = {
  status?: number | null;
  code?: string;
  signal?: string | null;
  stderr?: string;
  stdout?: string;
  message?: string;
};

export class HandoffError extends Error {
  code: string;
  details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'HandoffError';
    this.code = code;
    this.details = details;
  }
}

function failureDetails(error: any): ProcessFailure {
  return {
    status: typeof error?.status === 'number' ? error.status : undefined,
    code: typeof error?.code === 'string' ? error.code : undefined,
    signal: typeof error?.signal === 'string' ? error.signal : undefined,
    stderr: String(error?.stderr ?? '').trim() || undefined,
    stdout: String(error?.stdout ?? '').trim() || undefined,
    message: typeof error?.message === 'string' ? error.message : undefined,
  };
}

function git(args: string[], options: { trim?: boolean; errorCode?: string; cwd: string }): string {
  try {
    const out = execFileSync('git', args, {
      cwd: options.cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return options.trim === false ? out : out.trim();
  } catch (error: any) {
    const details = failureDetails(error);
    const reason = details.stderr || details.stdout || details.message || 'unknown git error';
    throw new HandoffError(
      options.errorCode ?? 'GIT_COMMAND_FAILED',
      `git ${args.join(' ')} failed: ${reason}`,
      { command: ['git', ...args], ...details },
    );
  }
}

function assertId(value: string, label: string): void {
  if (!ID_RE.test(value)) throw new HandoffError('INVALID_ID', `Invalid ${label}: ${value}`);
}

function assertBranch(value: string, root: string): void {
  if (!BRANCH_RE.test(value) || value.includes('..') || value.includes('//') || value.endsWith('/') || value.endsWith('.')) {
    throw new HandoffError('INVALID_SOURCE_BRANCH', `Invalid source_branch: ${value}`);
  }
  git(['check-ref-format', '--branch', value], { errorCode: 'INVALID_SOURCE_BRANCH', cwd: root });
}

function assertSha(value: string): void {
  if (!SHA_RE.test(value)) throw new HandoffError('INVALID_SOURCE_SHA', `Invalid source_sha: ${value}`);
}

function normalizeRepository(remote: string): string | undefined {
  const value = remote.trim().replace(/\.git$/, '');
  const ssh = value.match(/^git@github\.com:([^/]+\/[^/]+)$/i);
  if (ssh?.[1]) return ssh[1];
  const sshUrl = value.match(/^ssh:\/\/git@github\.com\/([^/]+\/[^/]+)$/i);
  if (sshUrl?.[1]) return sshUrl[1];
  const https = value.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)$/i);
  if (https?.[1]) return https[1];
  return undefined;
}

function assertHandoff(value: unknown, expectedRun: string, expectedId: string, root: string): GithubHandoff {
  if (!value || typeof value !== 'object') throw new HandoffError('HANDOFF_INVALID', 'Handoff must be an object');
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
      'HANDOFF_INVALID',
      'Handoff must define schema_version=1, provider=github, matching handoff_id/run_id, source_branch, source_sha, pipeline_id, rules_file, rules_version and validation_stages',
    );
  }
  assertBranch(h.source_branch, root);
  assertSha(h.source_sha);
  if (h.allowed_fix_scope && (!Array.isArray(h.allowed_fix_scope) || h.allowed_fix_scope.some((p) => typeof p !== 'string'))) {
    throw new HandoffError('HANDOFF_INVALID', 'allowed_fix_scope must be an array of paths');
  }
  for (const pattern of h.allowed_fix_scope ?? []) {
    if (pattern.includes('*') && !pattern.endsWith('/**')) {
      throw new HandoffError(
        'HANDOFF_INVALID',
        `allowed_fix_scope supports only exact paths or trailing /**: ${pattern}`,
      );
    }
  }
  for (const commands of Object.values(h.validation ?? {})) {
    if (!Array.isArray(commands) || commands.some((cmd) => typeof cmd !== 'string' || !cmd.trim())) {
      throw new HandoffError('HANDOFF_INVALID', 'validation command groups must be arrays of non-empty strings');
    }
  }
  return h as GithubHandoff;
}

function stateDir(projectRoot: string, runId: string): string {
  return resolve(projectRoot, '.tmp/pipelines', runId);
}

function runtimePath(projectRoot: string, runId: string): string {
  return join(stateDir(projectRoot, runId), 'github-handoff.json');
}

function validationManifestPath(projectRoot: string, runId: string): string {
  return join(stateDir(projectRoot, runId), 'github-validation-manifest.json');
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

async function readRuntime(projectRoot: string, runId: string): Promise<HandoffRuntime> {
  try {
    return JSON.parse(await readFile(runtimePath(projectRoot, runId), 'utf8')) as HandoffRuntime;
  } catch {
    throw new HandoffError('HANDOFF_RUNTIME_NOT_FOUND', `GitHub handoff runtime not found: ${runId}`);
  }
}

function requireGitRepository(cwd: string): void {
  if (git(['rev-parse', '--is-inside-work-tree'], { cwd }) !== 'true') {
    throw new HandoffError('NOT_GIT_WORKTREE', 'Current directory is not a Git worktree');
  }
}

function requireCleanWorktree(cwd: string): void {
  const dirty = git(['status', '--porcelain=v1', '--untracked-files=all'], { cwd });
  if (dirty) throw new HandoffError('DIRTY_WORKTREE', `Worktree must be clean before GitHub handoff:\n${dirty}`);
}

function verifyRepository(handoff: GithubHandoff, cwd: string): void {
  if (!handoff.repository) return;
  const origin = git(['remote', 'get-url', 'origin'], { errorCode: 'ORIGIN_NOT_FOUND', cwd });
  const actual = normalizeRepository(origin);
  if (!actual) {
    throw new HandoffError('ORIGIN_NOT_GITHUB', `Cannot normalize origin as GitHub repository: ${origin}`);
  }
  if (actual.toLowerCase() !== handoff.repository.toLowerCase()) {
    throw new HandoffError(
      'REPOSITORY_MISMATCH',
      `Repository mismatch: handoff=${handoff.repository}, origin=${actual}`,
    );
  }
}

function isAncestor(ancestor: string, descendant: string, cwd: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd,
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

function changedFiles(cwd: string): string[] {
  const output = git(['status', '--porcelain=v1', '--untracked-files=all'], { cwd, trim: false });
  if (!output) return [];
  return output
    .trimEnd()
    .split('\n')
    .map((line) => line.substring(3).trim())
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
  if (sensitive.length) {
    throw new HandoffError('SENSITIVE_PATH', `Refusing to publish sensitive paths: ${sensitive.join(', ')}`);
  }
}

function lsRemoteExact(ref: string, cwd: string): { ref: string; sha: string } {
  try {
    const output = execFileSync('git', ['ls-remote', '--exit-code', 'origin', ref], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const rows = output.split('\n').filter(Boolean);
    if (rows.length !== 1) {
      throw new HandoffError('REMOTE_REF_AMBIGUOUS', `Expected exactly one remote ref for ${ref}, got ${rows.length}`);
    }
    const [sha, actualRef] = rows[0].split(/\s+/, 2);
    if (!sha || !actualRef || actualRef !== ref || !SHA_RE.test(sha)) {
      throw new HandoffError('REMOTE_REF_INVALID', `Invalid ls-remote response for ${ref}: ${rows[0]}`);
    }
    return { ref: actualRef, sha };
  } catch (error: any) {
    if (error instanceof HandoffError) throw error;
    const details = failureDetails(error);
    if (details.status === 2) {
      throw new HandoffError(
        'REMOTE_REF_NOT_FOUND',
        `Remote ref is not visible through Git credentials: ${ref}`,
        { ref, ...details },
      );
    }
    const reason = details.stderr || details.stdout || details.message || 'unknown git ls-remote error';
    throw new HandoffError(
      'REMOTE_ACCESS_FAILED',
      `Cannot query origin for ${ref}: ${reason}`,
      { ref, ...details },
    );
  }
}

function fetchExact(remoteRef: string, localRef: string, cwd: string): string {
  git(
    ['fetch', '--prune', 'origin', `+${remoteRef}:${localRef}`],
    { errorCode: 'GIT_FETCH_FAILED', cwd },
  );
  return git(['rev-parse', localRef], { errorCode: 'FETCHED_REF_NOT_FOUND', cwd });
}

export async function probeHandoff(runId: string, handoffId: string, projectRoot?: string): Promise<unknown> {
  assertId(runId, 'run-id');
  assertId(handoffId, 'handoff-id');
  const root = resolveProjectRoot(projectRoot, process.env[ENV_KEY]);
  requireGitRepository(root);
  const origin = git(['remote', 'get-url', 'origin'], { errorCode: 'ORIGIN_NOT_FOUND', cwd: root });
  const handoffBranch = `handoff/${handoffId}`;
  const remoteRef = `refs/heads/${handoffBranch}`;
  const visible = lsRemoteExact(remoteRef, root);
  return {
    status: 'visible',
    run_id: runId,
    handoff_id: handoffId,
    origin,
    repository: normalizeRepository(origin) ?? null,
    handoff_branch: handoffBranch,
    remote_ref: visible.ref,
    remote_sha: visible.sha,
  };
}

export async function prepareHandoff(runId: string, handoffId: string, projectRoot?: string): Promise<unknown> {
  assertId(runId, 'run-id');
  assertId(handoffId, 'handoff-id');
  const root = resolveProjectRoot(projectRoot, process.env[ENV_KEY]);
  requireGitRepository(root);
  requireCleanWorktree(root);

  const handoffBranch = `handoff/${handoffId}`;
  const handoffRemoteRef = `refs/heads/${handoffBranch}`;
  const handoffRef = `refs/remotes/origin/${handoffBranch}`;
  const remoteHandoff = lsRemoteExact(handoffRemoteRef, root);
  const fetchedHandoffSha = fetchExact(handoffRemoteRef, handoffRef, root);
  if (fetchedHandoffSha.toLowerCase() !== remoteHandoff.sha.toLowerCase()) {
    throw new HandoffError(
      'HANDOFF_FETCH_SHA_MISMATCH',
      `Fetched handoff SHA mismatch: remote=${remoteHandoff.sha}, local=${fetchedHandoffSha}`,
    );
  }

  let raw: string;
  try {
    raw = git(['show', `${handoffRef}:${HANDOFF_FILE}`], { trim: false, errorCode: 'HANDOFF_FILE_NOT_FOUND', cwd: root });
  } catch (error) {
    if (error instanceof HandoffError) {
      throw new HandoffError(
        'HANDOFF_FILE_NOT_FOUND',
        `Handoff ref must contain ${HANDOFF_FILE}: ${handoffBranch}`,
        error.details,
      );
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HandoffError('HANDOFF_JSON_INVALID', `Invalid JSON in ${handoffBranch}:${HANDOFF_FILE}`);
  }
  const handoff = assertHandoff(parsed, runId, handoffId, root);
  verifyRepository(handoff, root);

  const sourceRemoteBranchRef = `refs/heads/${handoff.source_branch}`;
  const sourceRemoteRef = `refs/remotes/origin/${handoff.source_branch}`;
  const remoteSource = lsRemoteExact(sourceRemoteBranchRef, root);
  if (remoteSource.sha.toLowerCase() !== handoff.source_sha.toLowerCase()) {
    throw new HandoffError(
      'SOURCE_BRANCH_MOVED',
      `Source branch moved after handoff: expected=${handoff.source_sha}, origin/${handoff.source_branch}=${remoteSource.sha}`,
    );
  }
  const fetchedSourceSha = fetchExact(sourceRemoteBranchRef, sourceRemoteRef, root);
  if (fetchedSourceSha.toLowerCase() !== handoff.source_sha.toLowerCase()) {
    throw new HandoffError(
      'SOURCE_FETCH_SHA_MISMATCH',
      `Fetched source SHA mismatch: expected=${handoff.source_sha}, local=${fetchedSourceSha}`,
    );
  }
  if (!isAncestor(handoff.source_sha, handoffRef, root)) {
    throw new HandoffError('HANDOFF_NOT_DESCENDANT', `Handoff ref is not based on source_sha: ${handoff.source_sha}`);
  }

  const workingBranch = `pipeline/${runId}`;
  git(['switch', '-C', workingBranch, handoff.source_sha], { errorCode: 'PIPELINE_CHECKOUT_FAILED', cwd: root });
  const head = git(['rev-parse', 'HEAD'], { cwd: root });
  if (head.toLowerCase() !== handoff.source_sha.toLowerCase()) {
    throw new HandoffError('CHECKOUT_SHA_MISMATCH', `Checkout verification failed: HEAD=${head}, source_sha=${handoff.source_sha}`);
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
  await writeJson(runtimePath(root, runId), runtime);

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
  await writeJson(validationManifestPath(root, runId), validationManifest);

  return {
    status: 'prepared',
    run_id: runId,
    handoff_id: handoffId,
    pipeline_id: handoff.pipeline_id,
    source_branch: handoff.source_branch,
    source_sha: handoff.source_sha,
    handoff_sha: remoteHandoff.sha,
    working_branch: workingBranch,
    validation_stages: handoff.validation_stages,
    validation_manifest: validationManifestPath(root, runId),
    runtime: runtimePath(root, runId),
  };
}

export async function publishHandoff(runId: string, projectRoot?: string): Promise<unknown> {
  assertId(runId, 'run-id');
  const root = resolveProjectRoot(projectRoot, process.env[ENV_KEY]);
  requireGitRepository(root);
  const runtime = await readRuntime(root, runId);
  const { handoff } = runtime;
  const branch = git(['branch', '--show-current'], { cwd: root });
  if (branch !== runtime.working_branch) {
    throw new HandoffError(
      'WRONG_WORKING_BRANCH',
      `Wrong working branch: expected=${runtime.working_branch}, actual=${branch || '(detached)'}`,
    );
  }

  const files = changedFiles(root);
  rejectSensitiveFiles(files);
  if (files.length) {
    const scope = handoff.allowed_fix_scope ?? [];
    if (!scope.length) throw new HandoffError('FIX_SCOPE_EMPTY', 'Fixes exist but allowed_fix_scope is empty');
    const outside = files.filter((file) => !scopeAllows(file, scope));
    if (outside.length) {
      throw new HandoffError('FIX_OUTSIDE_SCOPE', `Changed files outside allowed_fix_scope: ${outside.join(', ')}`);
    }
    git(['add', '--', ...files], { errorCode: 'FIX_STAGE_FAILED', cwd: root });
    git(['commit', '-m', `fix: validation ${runId}`], { errorCode: 'FIX_COMMIT_FAILED', cwd: root });
  }

  const head = git(['rev-parse', 'HEAD'], { cwd: root });
  if (!isAncestor(runtime.source_sha, head, root)) {
    throw new HandoffError('VALIDATED_NOT_DESCENDANT', `Validated HEAD is not descended from source_sha: ${runtime.source_sha}`);
  }

  const sourceRemoteBranchRef = `refs/heads/${handoff.source_branch}`;
  const remoteSource = lsRemoteExact(sourceRemoteBranchRef, root);
  const fetchedRemoteSha = fetchExact(sourceRemoteBranchRef, runtime.source_remote_ref, root);
  if (fetchedRemoteSha.toLowerCase() !== remoteSource.sha.toLowerCase()) {
    throw new HandoffError(
      'SOURCE_FETCH_SHA_MISMATCH',
      `Fetched source SHA mismatch: remote=${remoteSource.sha}, local=${fetchedRemoteSha}`,
    );
  }
  if (!isAncestor(remoteSource.sha, head, root)) {
    throw new HandoffError(
      'SOURCE_DIVERGED',
      `Remote source branch changed independently; refusing non-fast-forward publish: remote=${remoteSource.sha}, local=${head}`,
    );
  }

  git(['push', 'origin', `HEAD:refs/heads/${handoff.source_branch}`], { errorCode: 'PUBLISH_PUSH_FAILED', cwd: root });
  const verifiedRemote = lsRemoteExact(sourceRemoteBranchRef, root).sha;
  if (verifiedRemote.toLowerCase() !== head.toLowerCase()) {
    throw new HandoffError('PUBLISH_VERIFY_FAILED', `Push verification failed: local=${head}, remote=${verifiedRemote}`);
  }
  fetchExact(sourceRemoteBranchRef, runtime.source_remote_ref, root);

  runtime.validated_sha = head;
  runtime.published_at = new Date().toISOString();
  await writeJson(runtimePath(root, runId), runtime);

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

export async function statusHandoff(runId: string, projectRoot?: string): Promise<unknown> {
  assertId(runId, 'run-id');
  const root = resolveProjectRoot(projectRoot, process.env[ENV_KEY]);
  const runtime = await readRuntime(root, runId);
  const head = git(['rev-parse', 'HEAD'], { cwd: root });
  const branch = git(['branch', '--show-current'], { cwd: root });
  return {
    ...runtime,
    current_head: head,
    current_branch: branch,
    worktree_clean: changedFiles(root).length === 0,
    state_exists: await exists(join(stateDir(root, runId), 'state.json')),
    validation_manifest: validationManifestPath(root, runId),
  };
}

export function formatHandoffError(error: unknown): Record<string, unknown> {
  if (error instanceof HandoffError) {
    return {
      status: 'blocked',
      error_code: error.code,
      error: error.message,
      ...(error.details ? { details: error.details } : {}),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    status: 'blocked',
    error_code: 'HANDOFF_UNEXPECTED_ERROR',
    error: message,
  };
}
