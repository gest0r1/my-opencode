import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_STATE_ROOT = '.tmp/pipelines';
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ISSUE_NUMBER = /^[1-9][0-9]*$/;

class GitHubIssueCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubIssueCliError';
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
    throw new GitHubIssueCliError(
      options.genericFailure ?? `${executable} is unavailable: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new GitHubIssueCliError(
      options.genericFailure ?? `${executable} failed: ${detail || `exit ${String(result.status)}`}`,
    );
  }
  return (result.stdout ?? '').trim();
}

export function repositoryFromRemote(remote: string): string {
  const value = remote.trim().replace(/\.git$/, '');
  const patterns = [
    /^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/,
    /^ssh:\/\/git@github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/,
    /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/,
    /^git:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.[1]) return match[1];
  }
  throw new GitHubIssueCliError('origin must point to github.com owner/repo');
}

function currentRepository(cwd: string): string {
  const remote = command('git', ['remote', 'get-url', 'origin'], { cwd });
  return repositoryFromRemote(remote);
}

function gh(args: string[], cwd: string): string {
  return command('gh', args, { cwd });
}

function requireGitHubAuth(cwd: string): void {
  command('gh', ['auth', 'status', '--hostname', 'github.com'], {
    cwd,
    genericFailure: 'GITHUB_AUTH_UNAVAILABLE: authenticate GitHub CLI with gh auth login',
  });
}

function parseIssueNumber(value: string): number {
  if (!ISSUE_NUMBER.test(value)) throw new GitHubIssueCliError(`invalid issue number: ${value}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new GitHubIssueCliError(`invalid issue number: ${value}`);
  return number;
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new GitHubIssueCliError(`invalid JSON returned by GitHub for ${label}`);
  }
}

function flattenPages(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new GitHubIssueCliError('GitHub comments response is not an array');
  if (value.every((item) => Array.isArray(item))) return value.flat() as unknown[];
  return value;
}

function normalizeComment(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new GitHubIssueCliError('invalid GitHub issue comment');
  const comment = value as Record<string, any>;
  return {
    id: comment.id,
    url: comment.html_url ?? comment.url ?? null,
    user: comment.user?.login ?? null,
    body: typeof comment.body === 'string' ? comment.body : '',
    created_at: comment.created_at ?? null,
    updated_at: comment.updated_at ?? null,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function isPipelineAuditComment(comment: Record<string, unknown>): boolean {
  const body = typeof comment.body === 'string' ? comment.body : '';
  return /<!--\s*pipeline-event:[^>]+-->/i.test(body);
}

function canonicalRequirements(snapshot: Record<string, any>): Record<string, unknown> {
  const issues = Array.isArray(snapshot.issues) ? snapshot.issues : [];
  return {
    schema_version: 1,
    source_type: 'github_issues',
    repository: String(snapshot.repository ?? ''),
    issues: issues.map((issue: any) => ({
      repository: String(issue.repository ?? snapshot.repository ?? ''),
      number: Number(issue.number),
      title: typeof issue.title === 'string' ? issue.title : '',
      body: typeof issue.body === 'string' ? issue.body : '',
      state: String(issue.state ?? ''),
      comments: (Array.isArray(issue.comments) ? issue.comments : [])
        .filter((comment: Record<string, unknown>) => !isPipelineAuditComment(comment))
        .map((comment: Record<string, unknown>) => ({
          id: comment.id ?? null,
          user: comment.user ?? null,
          body: typeof comment.body === 'string' ? comment.body : '',
          created_at: comment.created_at ?? null,
          updated_at: comment.updated_at ?? null,
        })),
    })),
  };
}

export function requirementsSha256ForSnapshot(snapshot: Record<string, any>): string {
  return sha256(JSON.stringify(canonicalRequirements(snapshot)));
}

export async function probeRequirements(
  issueNumbers: number[],
  options: { cwd?: string } = {},
): Promise<Record<string, unknown>> {
  const numbers = [...new Set(issueNumbers)];
  if (numbers.length === 0) throw new GitHubIssueCliError('at least one issue number is required');
  const cwd = options.cwd ?? process.cwd();
  const repository = currentRepository(cwd);
  requireGitHubAuth(cwd);
  const issues: Record<string, unknown>[] = [];
  for (const number of numbers) {
    const endpoint = `repos/${repository}/issues/${number}`;
    const issue = parseJson<Record<string, any>>(
      gh(['api', endpoint, '-H', 'X-GitHub-Api-Version: 2022-11-28'], cwd),
      `issue #${number}`,
    );
    if (issue.pull_request) throw new GitHubIssueCliError(`#${number} is a pull request, not an issue`);
    if (issue.state !== 'open') throw new GitHubIssueCliError(`#${number} is not open (state=${String(issue.state)})`);
    const pages = parseJson<unknown>(
      gh(['api', '--paginate', '--slurp', `${endpoint}/comments`, '-H', 'X-GitHub-Api-Version: 2022-11-28'], cwd),
      `comments for issue #${number}`,
    );
    issues.push({
      repository,
      number,
      url: issue.html_url ?? `https://github.com/${repository}/issues/${number}`,
      title: typeof issue.title === 'string' ? issue.title : '',
      body: typeof issue.body === 'string' ? issue.body : '',
      state: issue.state,
      updated_at: issue.updated_at ?? null,
      comments: flattenPages(pages).map(normalizeComment),
    });
  }
  const snapshot = { schema_version: 1, source_type: 'github_issues', repository, issues };
  return {
    status: 'PASS',
    repository,
    issue_numbers: numbers,
    requirements_sha256: requirementsSha256ForSnapshot(snapshot),
  };
}


async function writeJsonAtomic(file: string, value: unknown): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(temp, content, 'utf8');
  await rename(temp, file);
  return sha256(content);
}

export async function fetchIssues(
  runId: string,
  issueNumbers: number[],
  options: { stateRoot?: string; cwd?: string } = {},
): Promise<Record<string, unknown>> {
  if (!RUN_ID.test(runId)) throw new GitHubIssueCliError('run-id must be path-safe');
  const numbers = [...new Set(issueNumbers)];
  if (numbers.length === 0) throw new GitHubIssueCliError('at least one issue number is required');

  const cwd = options.cwd ?? process.cwd();
  const stateRoot = options.stateRoot ?? DEFAULT_STATE_ROOT;
  const repository = currentRepository(cwd);
  requireGitHubAuth(cwd);

  const issues: Record<string, unknown>[] = [];
  for (const number of numbers) {
    const endpoint = `repos/${repository}/issues/${number}`;
    const issue = parseJson<Record<string, any>>(
      gh(['api', endpoint, '-H', 'X-GitHub-Api-Version: 2022-11-28'], cwd),
      `issue #${number}`,
    );
    if (issue.pull_request) throw new GitHubIssueCliError(`#${number} is a pull request, not an issue`);
    if (issue.state !== 'open') throw new GitHubIssueCliError(`#${number} is not open (state=${String(issue.state)})`);

    const pages = parseJson<unknown>(
      gh([
        'api',
        '--paginate',
        '--slurp',
        `${endpoint}/comments`,
        '-H',
        'X-GitHub-Api-Version: 2022-11-28',
      ], cwd),
      `comments for issue #${number}`,
    );
    const comments = flattenPages(pages).map(normalizeComment);

    issues.push({
      repository,
      number,
      url: issue.html_url ?? `https://github.com/${repository}/issues/${number}`,
      title: typeof issue.title === 'string' ? issue.title : '',
      body: typeof issue.body === 'string' ? issue.body : '',
      state: issue.state,
      updated_at: issue.updated_at ?? null,
      comments,
    });
  }

  const requirementsSha256 = requirementsSha256ForSnapshot({
    schema_version: 1,
    source_type: 'github_issues',
    repository,
    issues,
  });
  const snapshot = {
    schema_version: 1,
    source_type: 'github_issues',
    repository,
    fetched_at: new Date().toISOString(),
    requirements_sha256: requirementsSha256,
    issues,
  };
  const output = path.join(path.resolve(stateRoot), runId, 'sources', 'github-issues.json');
  const snapshotSha256 = await writeJsonAtomic(output, snapshot);
  return {
    status: 'PASS',
    run_id: runId,
    repository,
    issue_numbers: numbers,
    snapshot: output,
    snapshot_sha256: snapshotSha256,
    requirements_sha256: requirementsSha256,
  };
}

interface ParsedArgs {
  commandName: 'fetch' | 'show';
  runId: string;
  issueNumbers: number[];
  stateRoot: string;
}

function parseArgs(args: string[]): ParsedArgs {
  const [commandName, runId, ...rest] = args;
  if ((commandName !== 'fetch' && commandName !== 'show') || !runId) {
    throw new GitHubIssueCliError(
      'usage: github-issue-cli.ts fetch <run-id> <issue-number>... [--state-root <path>] | show <run-id> [issue-number...] [--state-root <path>]',
    );
  }
  const issueNumbers: number[] = [];
  let stateRoot = DEFAULT_STATE_ROOT;
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === '--state-root') {
      const next = rest[++index];
      if (!next) throw new GitHubIssueCliError('--state-root requires a path');
      stateRoot = next;
    } else if (value?.startsWith('--')) {
      throw new GitHubIssueCliError(`unknown option: ${value}`);
    } else if (value) {
      issueNumbers.push(parseIssueNumber(value));
    }
  }
  if (commandName === 'fetch' && issueNumbers.length === 0) {
    throw new GitHubIssueCliError('fetch requires at least one issue number');
  }
  return { commandName, runId, issueNumbers, stateRoot };
}

export async function showIssues(
  runId: string,
  issueNumbers: number[],
  options: { stateRoot?: string } = {},
): Promise<string> {
  if (!RUN_ID.test(runId)) throw new GitHubIssueCliError('run-id must be path-safe');
  const stateRoot = options.stateRoot ?? DEFAULT_STATE_ROOT;
  const file = path.join(path.resolve(stateRoot), runId, 'sources', 'github-issues.json');
  const content = await readFile(file, 'utf8').catch(() => {
    throw new GitHubIssueCliError(`authoritative snapshot not found: ${file}`);
  });
  const snapshot = parseJson<Record<string, any>>(content, 'authoritative issue snapshot');
  const requested = new Set(issueNumbers);
  const issues = Array.isArray(snapshot.issues)
    ? snapshot.issues.filter((issue: any) => requested.size === 0 || requested.has(Number(issue.number)))
    : [];
  if (requested.size > 0) {
    const found = new Set(issues.map((issue: any) => Number(issue.number)));
    for (const number of requested) {
      if (!found.has(number)) throw new GitHubIssueCliError(`issue #${number} is not present in the authoritative snapshot`);
    }
  }
  const output: string[] = [
    `snapshot: ${file}`,
    `sha256: ${sha256(content)}`,
    `repository: ${String(snapshot.repository ?? '')}`,
    '',
  ];
  for (const issue of issues) {
    output.push(`# Issue #${String(issue.number)} — ${String(issue.title ?? '')}`);
    output.push(`URL: ${String(issue.url ?? '')}`);
    output.push(`State: ${String(issue.state ?? '')}`);
    output.push(`Updated: ${String(issue.updated_at ?? '')}`);
    output.push('');
    output.push('## Body');
    output.push(typeof issue.body === 'string' ? issue.body : '');
    const comments = Array.isArray(issue.comments) ? issue.comments : [];
    if (comments.length) {
      output.push('');
      output.push('## Comments');
      for (const comment of comments) {
        output.push('');
        output.push(`### ${String(comment.user ?? 'unknown')} — ${String(comment.updated_at ?? comment.created_at ?? '')}`);
        output.push(typeof comment.body === 'string' ? comment.body : '');
      }
    }
    output.push('');
  }
  return output.join('\n');
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.commandName === 'show') {
    console.log(await showIssues(parsed.runId, parsed.issueNumbers, { stateRoot: parsed.stateRoot }));
    return;
  }
  console.log(JSON.stringify(await fetchIssues(parsed.runId, parsed.issueNumbers, {
    stateRoot: parsed.stateRoot,
  }), null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(`BLOCKED: github_issue: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
