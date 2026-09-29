import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { linkPr, syncRun } from './pipeline-github-sync.mjs';

const DEFAULT_STATE_ROOT = '.tmp/pipelines';
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA = /^[0-9a-f]{40}$/i;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_BRANCH = /^(?!main$|master$)[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const MANAGED_START = '<!-- pipeline-github:start -->';
const MANAGED_END = '<!-- pipeline-github:end -->';

class GitHubPrCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubPrCliError';
  }
}

function command(
  executable: string,
  args: string[],
  options: { cwd?: string; input?: string; genericFailure?: string } = {},
): string {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: process.env,
    input: options.input,
  });
  if (result.error) {
    throw new GitHubPrCliError(
      options.genericFailure ?? `${executable} is unavailable: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new GitHubPrCliError(
      options.genericFailure ?? `${executable} failed: ${detail || `exit ${String(result.status)}`}`,
    );
  }
  return (result.stdout ?? '').trim();
}

function repositoryFromRemote(remote: string): string {
  const value = remote.trim().replace(/\.git$/, '');
  for (const pattern of [
    /^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/,
    /^ssh:\/\/git@github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/,
    /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/,
    /^git:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/,
  ]) {
    const match = value.match(pattern);
    if (match?.[1]) return match[1];
  }
  throw new GitHubPrCliError('origin must point to github.com owner/repo');
}

function currentRepository(cwd: string): string {
  return repositoryFromRemote(command('git', ['remote', 'get-url', 'origin'], { cwd }));
}

function gh(args: string[], cwd: string, input?: string): string {
  return command('gh', args, { cwd, input });
}

function requireGitHubAuth(cwd: string): void {
  command('gh', ['auth', 'status', '--hostname', 'github.com'], {
    cwd,
    genericFailure: 'GITHUB_AUTH_UNAVAILABLE: authenticate GitHub CLI with gh auth login',
  });
}

async function readJson(file: string, label: string): Promise<Record<string, any>> {
  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch {
    throw new GitHubPrCliError(`${label} is missing: ${file}`);
  }
  try {
    return JSON.parse(content) as Record<string, any>;
  } catch {
    throw new GitHubPrCliError(`${label} is not valid JSON: ${file}`);
  }
}

function completedIssueNumbers(state: Record<string, any>): number[] {
  if (state.source_type !== 'github_issues') throw new GitHubPrCliError('run is not github_issues sourced');
  if (state.status !== 'completed') throw new GitHubPrCliError(`run must be completed before PR creation, got ${String(state.status)}`);
  if (!REPOSITORY.test(String(state.repository ?? ''))) {
    throw new GitHubPrCliError('state repository must be owner/repo');
  }

  const mapped = new Set<number>();
  for (const pipeline of Object.values(state.pipelines ?? {}) as Array<Record<string, any>>) {
    if (pipeline.status !== 'completed') {
      throw new GitHubPrCliError(`pipeline must be completed before PR creation: ${String(pipeline.id)}`);
    }
    for (const number of pipeline.issue_numbers ?? []) {
      if (!Number.isInteger(number) || number <= 0) throw new GitHubPrCliError('invalid mapped issue number');
      mapped.add(number);
    }
  }

  const source = new Set<number>();
  for (const issue of state.source_issues ?? []) {
    if (!Number.isInteger(issue?.number) || issue.number <= 0) {
      throw new GitHubPrCliError('invalid source issue number');
    }
    source.add(issue.number);
  }
  if (source.size === 0) throw new GitHubPrCliError('github_issues run has no source issues');
  for (const number of source) {
    if (!mapped.has(number)) throw new GitHubPrCliError(`source issue #${number} is not mapped to a completed pipeline`);
  }
  for (const number of mapped) {
    if (!source.has(number)) throw new GitHubPrCliError(`mapped issue #${number} is not a frozen source issue`);
  }
  return [...source].sort((a, b) => a - b);
}

function assertCandidate(candidate: Record<string, any>): { branch: string; candidateSha: string } {
  if (candidate.status !== 'PASS') throw new GitHubPrCliError('candidate.json does not record PASS');
  const branch = String(candidate.branch ?? '');
  const candidateSha = String(candidate.candidate_sha ?? '');
  const remoteSha = String(candidate.remote_sha ?? '');
  if (!SAFE_BRANCH.test(branch) || branch.includes('..') || branch.endsWith('/')) {
    throw new GitHubPrCliError('candidate branch is unsafe or targets the default branch');
  }
  if (!SHA.test(candidateSha) || candidateSha.toLowerCase() !== remoteSha.toLowerCase()) {
    throw new GitHubPrCliError('candidate SHA does not match published remote SHA');
  }
  return { branch, candidateSha };
}

async function assertFinalDeploymentValidation(
  runDir: string,
  state: Record<string, any>,
  candidateSha: string,
): Promise<void> {
  const manifestFile = String(state.manifest_file ?? '');
  if (!manifestFile) throw new GitHubPrCliError('state manifest_file is missing');
  const manifest = await readJson(manifestFile, 'manifest.json');
  for (const pipeline of manifest.pipelines ?? []) {
    if (pipeline?.deployable !== true) continue;
    const stage = pipeline?.deployment_validation?.stage;
    if (typeof stage !== 'string' || !stage) {
      throw new GitHubPrCliError(`deployable pipeline has no deployment validation stage: ${String(pipeline?.id)}`);
    }
    const executor = pipeline?.executors?.[stage];
    if (executor !== 'github_ci' && executor !== 'github_dev') {
      throw new GitHubPrCliError(`deployment validation is not a GitHub gate: ${String(pipeline?.id)}/${stage}`);
    }
    const evidence = await readJson(
      path.join(runDir, 'github', `${String(pipeline.id)}-${stage}.json`),
      `deployment validation evidence ${String(pipeline.id)}/${stage}`,
    );
    if (evidence.status !== 'PASS' ||
        String(evidence.candidate_sha ?? '').toLowerCase() !== candidateSha.toLowerCase()) {
      throw new GitHubPrCliError(
        `FINAL_CANDIDATE_VALIDATION_REQUIRED: ${String(pipeline.id)}/${stage} must PASS candidate ${candidateSha}`,
      );
    }
  }
}

export function managedPrBlock(runId: string, candidateSha: string, issueNumbers: number[]): string {
  return [
    MANAGED_START,
    '## Pipeline delivery',
    '',
    `Run: \`${runId}\``,
    `Candidate: \`${candidateSha}\``,
    '',
    'Completed mapped issues:',
    ...issueNumbers.map((number) => `- #${number}`),
    '',
    ...issueNumbers.map((number) => `Closes #${number}`),
    MANAGED_END,
  ].join('\n');
}

export function upsertManagedBlock(existingBody: string, block: string): string {
  const start = existingBody.indexOf(MANAGED_START);
  const end = existingBody.indexOf(MANAGED_END);
  if ((start >= 0) !== (end >= 0) || (start >= 0 && end < start)) {
    throw new GitHubPrCliError('existing PR contains a malformed pipeline-managed block');
  }
  if (start >= 0 && end >= 0) {
    const after = end + MANAGED_END.length;
    return `${existingBody.slice(0, start).trimEnd()}${existingBody.slice(0, start).trim() ? '\n\n' : ''}${block}${existingBody.slice(after).trim() ? `\n\n${existingBody.slice(after).trimStart()}` : ''}`;
  }
  return existingBody.trim() ? `${existingBody.trimEnd()}\n\n${block}` : block;
}

function parsePrList(value: string): Array<Record<string, any>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new GitHubPrCliError('gh pr list returned invalid JSON');
  }
  if (!Array.isArray(parsed)) throw new GitHubPrCliError('gh pr list did not return an array');
  return parsed as Array<Record<string, any>>;
}

export async function publishPullRequest(
  runId: string,
  options: { stateRoot?: string; cwd?: string } = {},
): Promise<Record<string, unknown>> {
  if (!RUN_ID.test(runId)) throw new GitHubPrCliError('run-id must be path-safe');
  const cwd = options.cwd ?? process.cwd();
  const stateRoot = path.resolve(options.stateRoot ?? DEFAULT_STATE_ROOT);
  const runDir = path.join(stateRoot, runId);
  const state = await readJson(path.join(runDir, 'state.json'), 'state.json');
  const issueNumbers = completedIssueNumbers(state);
  const repository = String(state.repository);
  if (currentRepository(cwd) !== repository) {
    throw new GitHubPrCliError(`current origin does not match frozen repository ${repository}`);
  }

  const candidate = assertCandidate(await readJson(path.join(runDir, 'candidate.json'), 'candidate.json'));
  await assertFinalDeploymentValidation(runDir, state, candidate.candidateSha);
  requireGitHubAuth(cwd);

  const sync = await syncRun(runId, { stateRoot });
  if (sync.pending !== 0) {
    throw new GitHubPrCliError(`GitHub status comments are still pending: ${String(sync.pending)}`);
  }

  const list = parsePrList(gh([
    'pr', 'list',
    '--repo', repository,
    '--state', 'open',
    '--head', candidate.branch,
    '--base', 'main',
    '--json', 'number,title,body,headRefName,baseRefName,url',
    '--limit', '2',
  ], cwd));
  if (list.length > 1) throw new GitHubPrCliError('multiple open PRs exist for the candidate branch');

  const block = managedPrBlock(runId, candidate.candidateSha, issueNumbers);
  let prNumber: number;
  let prUrl: string | undefined;

  if (list.length === 1) {
    const existing = list[0];
    prNumber = Number(existing.number);
    if (!Number.isInteger(prNumber) || prNumber <= 0) throw new GitHubPrCliError('existing PR has invalid number');
    const body = upsertManagedBlock(typeof existing.body === 'string' ? existing.body : '', block);
    gh(['pr', 'edit', String(prNumber), '--repo', repository, '--body-file', '-'], cwd, body);
    prUrl = typeof existing.url === 'string' ? existing.url : undefined;
  } else {
    const title = `pipeline(${runId}): deliver completed issues`;
    const output = gh([
      'pr', 'create',
      '--repo', repository,
      '--base', 'main',
      '--head', candidate.branch,
      '--title', title,
      '--body-file', '-',
    ], cwd, block);
    const match = output.match(/\/pull\/(\d+)(?:\b|$)/);
    if (!match?.[1]) throw new GitHubPrCliError('unable to determine created PR number');
    prNumber = Number(match[1]);
    prUrl = output.split(/\s+/).find((part) => /\/pull\/\d+/.test(part));
  }

  const linked = await linkPr(runId, prNumber, { stateRoot });
  if (linked.pending !== 0) {
    throw new GitHubPrCliError(`PR link comments are still pending: ${String(linked.pending)}`);
  }

  return {
    status: 'PASS',
    run_id: runId,
    repository,
    branch: candidate.branch,
    candidate_sha: candidate.candidateSha,
    pr_number: prNumber,
    pr_url: prUrl ?? null,
    issue_numbers: issueNumbers,
    merged: false,
  };
}

function parseArgs(args: string[]): { runId: string; stateRoot: string } {
  const [commandName, runId, ...rest] = args;
  if (commandName !== 'create' || !runId) {
    throw new GitHubPrCliError('usage: github-pr-cli.ts create <run-id> [--state-root <path>]');
  }
  let stateRoot = DEFAULT_STATE_ROOT;
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === '--state-root') {
      const next = rest[++index];
      if (!next) throw new GitHubPrCliError('--state-root requires a path');
      stateRoot = next;
    } else if (value?.startsWith('--')) {
      throw new GitHubPrCliError(`unknown option: ${value}`);
    } else if (value) {
      throw new GitHubPrCliError(`unexpected argument: ${value}`);
    }
  }
  return { runId, stateRoot };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  console.log(JSON.stringify(await publishPullRequest(parsed.runId, {
    stateRoot: parsed.stateRoot,
  }), null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(`BLOCKED: github_pr: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
