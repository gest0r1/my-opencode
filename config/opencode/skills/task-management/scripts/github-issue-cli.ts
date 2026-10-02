import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

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
    throw new GitHubIssueCliError(options.genericFailure ?? `${executable} is unavailable: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new GitHubIssueCliError(options.genericFailure ?? `${executable} failed: ${detail || `exit ${String(result.status)}`}`);
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
  return repositoryFromRemote(command('git', ['remote', 'get-url', 'origin'], { cwd }));
}
function gh(args: string[], cwd: string): string { return command('gh', args, { cwd }); }
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
  try { return JSON.parse(value) as T; }
  catch { throw new GitHubIssueCliError(`invalid JSON returned by GitHub for ${label}`); }
}
function flattenPages(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new GitHubIssueCliError('GitHub comments response is not an array');
  return value.every((item) => Array.isArray(item)) ? value.flat() as unknown[] : value;
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
function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }

export function isPipelineOwnedComment(comment: Record<string, unknown>): boolean {
  const body = typeof comment.body === 'string' ? comment.body : '';
  return /<!--\s*pipeline-(?:event|artifact):[^>]+-->/i.test(body);
}

function canonicalRequirements(snapshot: Record<string, any>): Record<string, unknown> {
  const issues = Array.isArray(snapshot.issues) ? snapshot.issues : [];
  return {
    schema_version: 2,
    source_type: 'github_issues',
    repository: String(snapshot.repository ?? ''),
    issues: issues.map((issue: any) => ({
      repository: String(issue.repository ?? snapshot.repository ?? ''),
      number: Number(issue.number),
      title: typeof issue.title === 'string' ? issue.title : '',
      body: typeof issue.body === 'string' ? issue.body : '',
      state: String(issue.state ?? ''),
      comments: (Array.isArray(issue.comments) ? issue.comments : [])
        .filter((comment: Record<string, unknown>) => !isPipelineOwnedComment(comment))
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

export async function readIssues(
  issueNumbers: number[],
  options: { cwd?: string } = {},
): Promise<Record<string, any>> {
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

  const snapshot = { schema_version: 2, source_type: 'github_issues', repository, issues };
  return {
    ...snapshot,
    issue_numbers: numbers,
    requirements_sha256: requirementsSha256ForSnapshot(snapshot),
  };
}

export async function probeRequirements(
  issueNumbers: number[],
  options: { cwd?: string } = {},
): Promise<Record<string, unknown>> {
  const source = await readIssues(issueNumbers, options);
  return {
    status: 'PASS',
    repository: source.repository,
    issue_numbers: source.issue_numbers,
    source_issues: source.issues.map((issue: any) => ({
      repository: source.repository,
      number: issue.number,
      url: issue.url,
      title: issue.title,
      updated_at: issue.updated_at,
    })),
    requirements_sha256: source.requirements_sha256,
  };
}

export async function showIssues(
  issueNumbers: number[],
  options: { cwd?: string } = {},
): Promise<string> {
  const source = await readIssues(issueNumbers, options);
  const output: string[] = [
    `repository: ${source.repository}`,
    `requirements_sha256: ${source.requirements_sha256}`,
    '',
  ];
  for (const issue of source.issues) {
    output.push(`# Issue #${String(issue.number)} — ${String(issue.title ?? '')}`);
    output.push(`URL: ${String(issue.url ?? '')}`);
    output.push(`State: ${String(issue.state ?? '')}`);
    output.push(`Updated: ${String(issue.updated_at ?? '')}`, '', '## Body');
    output.push(typeof issue.body === 'string' ? issue.body : '');
    const comments = Array.isArray(issue.comments) ? issue.comments.filter((c: any) => !isPipelineOwnedComment(c)) : [];
    if (comments.length) {
      output.push('', '## Human comments');
      for (const comment of comments) {
        output.push('', `### ${String(comment.user ?? 'unknown')} — ${String(comment.updated_at ?? comment.created_at ?? '')}`);
        output.push(typeof comment.body === 'string' ? comment.body : '');
      }
    }
    output.push('');
  }
  return output.join('\n');
}

function parseArgs(args: string[]): { commandName: 'probe' | 'show'; issueNumbers: number[] } {
  const [commandName, ...rest] = args;
  if (commandName !== 'probe' && commandName !== 'show') {
    throw new GitHubIssueCliError('usage: github-issue-cli.ts probe <issue-number>... | show <issue-number>...');
  }
  const issueNumbers = rest.map(parseIssueNumber);
  if (!issueNumbers.length) throw new GitHubIssueCliError(`${commandName} requires at least one issue number`);
  return { commandName, issueNumbers };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.commandName === 'show') {
    console.log(await showIssues(parsed.issueNumbers));
    return;
  }
  console.log(JSON.stringify(await probeRequirements(parsed.issueNumbers), null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(`BLOCKED: github_issue: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
