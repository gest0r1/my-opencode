import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

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

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/i;

async function readFrozenArtifact(
  runRoot: string,
  ref: { path?: unknown; sha256?: unknown },
  label: string,
): Promise<{ content: string; sha256: string; path: string }> {
  if (!ref || typeof ref.path !== 'string' || typeof ref.sha256 !== 'string' || !SHA256.test(ref.sha256)) {
    throw new GitHubIssueCliError(`${label} must define path + SHA-256`);
  }
  if (ref.path.startsWith('/') || ref.path.includes('..') || ref.path.includes('\\')) {
    throw new GitHubIssueCliError(`unsafe ${label} path`);
  }
  const absolute = path.resolve(runRoot, ref.path);
  if (!absolute.startsWith(`${path.resolve(runRoot)}${path.sep}`)) {
    throw new GitHubIssueCliError(`${label} path escapes run root`);
  }
  const content = await readFile(absolute, 'utf8').catch(() => {
    throw new GitHubIssueCliError(`${label} is missing: ${ref.path}`);
  });
  const actual = sha256(content);
  if (actual !== ref.sha256.toLowerCase()) throw new GitHubIssueCliError(`${label} SHA-256 mismatch`);
  return { content, sha256: actual, path: ref.path };
}

function artifactMarker(kind: 'story' | 'architecture', runId: string, issueNumber: number): string {
  return `<!-- pipeline-artifact:${kind}:${runId}:issue-${issueNumber} -->`;
}

function renderArtifactComment(
  kind: 'story' | 'architecture',
  runId: string,
  issueNumber: number,
  requirementsSha: string,
  artifact: { content: string; sha256: string },
): string {
  const title = kind === 'story' ? 'Pipeline Story' : 'Pipeline Architecture';
  const body = [
    artifactMarker(kind, runId, issueNumber),
    `## ${title}`,
    `Run: \`${runId}\``,
    `Requirements SHA-256: \`${requirementsSha}\``,
    `Artifact SHA-256: \`${artifact.sha256}\``,
    '',
    artifact.content.trim(),
  ].join('\n');
  if (Buffer.byteLength(body, 'utf8') > 60_000) {
    throw new GitHubIssueCliError(`${kind} comment for issue #${issueNumber} exceeds safe GitHub comment size`);
  }
  return body;
}

export async function checkFrozenRequirements(
  runId: string,
  options: { stateRoot?: string; cwd?: string } = {},
): Promise<Record<string, unknown>> {
  if (!RUN_ID.test(runId)) throw new GitHubIssueCliError('run-id must be path-safe');
  const cwd = options.cwd ?? process.cwd();
  const runRoot = path.resolve(options.stateRoot ?? '.tmp/pipelines', runId);
  const manifestPath = path.join(runRoot, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8').catch(() => {
    throw new GitHubIssueCliError(`manifest not found: ${manifestPath}`);
  })) as Record<string, any>;
  if (manifest.schema_version !== 2) throw new GitHubIssueCliError('pipeline manifest schema_version must be exactly 2');
  if (manifest.source_type !== 'github_issues') {
    return { status: 'PASS', run_id: runId, source_type: manifest.source_type ?? null, changed: false };
  }
  const frozen = String(manifest.source_requirements_sha256 ?? '');
  if (!SHA256.test(frozen)) throw new GitHubIssueCliError('manifest source_requirements_sha256 is missing or invalid');
  const issueNumbers = Array.isArray(manifest.source_issues)
    ? manifest.source_issues.map((issue: any) => Number(issue.number)).filter((n: number) => Number.isInteger(n) && n > 0)
    : [];
  if (!issueNumbers.length) throw new GitHubIssueCliError('github_issues manifest has no source issue numbers');
  const live = await probeRequirements(issueNumbers, { cwd });
  const liveSha = String(live.requirements_sha256 ?? '');
  if (!SHA256.test(liveSha)) throw new GitHubIssueCliError('live source requirements digest is invalid');
  if (liveSha.toLowerCase() !== frozen.toLowerCase()) {
    throw new GitHubIssueCliError(`SOURCE_REQUIREMENTS_CHANGED: frozen=${frozen.toLowerCase()} live=${liveSha.toLowerCase()}`);
  }
  return {
    status: 'PASS',
    run_id: runId,
    repository: live.repository,
    issue_numbers: live.issue_numbers,
    requirements_sha256: frozen.toLowerCase(),
    changed: false,
  };
}

export async function publishPlanningArtifacts(
  runId: string,
  options: { stateRoot?: string; cwd?: string } = {},
): Promise<Record<string, unknown>> {
  if (!RUN_ID.test(runId)) throw new GitHubIssueCliError('run-id must be path-safe');
  const cwd = options.cwd ?? process.cwd();
  const runRoot = path.resolve(options.stateRoot ?? '.tmp/pipelines', runId);
  const manifestPath = path.join(runRoot, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8').catch(() => {
    throw new GitHubIssueCliError(`manifest not found: ${manifestPath}`);
  })) as Record<string, any>;
  if (manifest.schema_version !== 2) throw new GitHubIssueCliError('pipeline manifest schema_version must be exactly 2');
  if (manifest.source_type !== 'github_issues') {
    return { status: 'PASS', run_id: runId, source_type: manifest.source_type ?? null, published: 0 };
  }
  if (!SHA256.test(String(manifest.source_requirements_sha256 ?? ''))) {
    throw new GitHubIssueCliError('manifest source_requirements_sha256 is missing or invalid');
  }
  const issueNumbers = Array.isArray(manifest.source_issues)
    ? manifest.source_issues.map((issue: any) => Number(issue.number)).filter((n: number) => Number.isInteger(n) && n > 0)
    : [];
  if (!issueNumbers.length) throw new GitHubIssueCliError('github_issues manifest has no source issue numbers');

  const live = await readIssues(issueNumbers, { cwd });
  const frozenRequirements = String(manifest.source_requirements_sha256).toLowerCase();
  if (String(live.requirements_sha256).toLowerCase() !== frozenRequirements) {
    throw new GitHubIssueCliError(
      `SOURCE_REQUIREMENTS_CHANGED: frozen=${frozenRequirements} live=${String(live.requirements_sha256)}`,
    );
  }

  const architectureRef = manifest.planning_readiness?.gates?.architecture?.artifact;
  const architecture = await readFrozenArtifact(runRoot, architectureRef, 'architecture');
  let published = 0;
  let existing = 0;

  for (const number of issueNumbers) {
    const sourceIssue = live.issues.find((issue: any) => Number(issue.number) === number);
    const comments = Array.isArray(sourceIssue?.comments) ? sourceIssue.comments : [];
    const storyPath = path.join(runRoot, 'stories', `issue-${number}.md`);
    const storyContent = await readFile(storyPath, 'utf8').catch(() => undefined);
    const artifacts: Array<{ kind: 'story' | 'architecture'; content: string; sha256: string }> = [];
    if (storyContent !== undefined) {
      artifacts.push({ kind: 'story', content: storyContent, sha256: sha256(storyContent) });
    }
    artifacts.push({ kind: 'architecture', content: architecture.content, sha256: architecture.sha256 });

    for (const artifact of artifacts) {
      const marker = artifactMarker(artifact.kind, runId, number);
      if (comments.some((comment: any) => typeof comment.body === 'string' && comment.body.includes(marker))) {
        existing += 1;
        continue;
      }
      const body = renderArtifactComment(
        artifact.kind,
        runId,
        number,
        frozenRequirements,
        artifact,
      );
      gh([
        'api', '--method', 'POST',
        `repos/${live.repository}/issues/${number}/comments`,
        '-H', 'X-GitHub-Api-Version: 2022-11-28',
        '-f', `body=${body}`,
      ], cwd);
      published += 1;
    }
  }
  return { status: 'PASS', run_id: runId, repository: live.repository, published, existing };
}

function parseArgs(args: string[]): {
  commandName: 'probe' | 'show' | 'check' | 'publish-plan';
  issueNumbers: number[];
  runId?: string;
  stateRoot?: string;
} {
  const [commandName, ...rest] = args;
  if (commandName === 'check' || commandName === 'publish-plan') {
    const runId = rest[0];
    if (!runId) throw new GitHubIssueCliError(`${commandName} requires run-id`);
    let stateRoot: string | undefined;
    for (let i = 1; i < rest.length; i += 1) {
      if (rest[i] !== '--state-root' || !rest[i + 1]) {
        throw new GitHubIssueCliError('usage: github-issue-cli.ts check|publish-plan <run-id> [--state-root <path>]');
      }
      stateRoot = rest[++i];
    }
    return { commandName, runId, issueNumbers: [], stateRoot };
  }
  if (commandName !== 'probe' && commandName !== 'show') {
    throw new GitHubIssueCliError(
      'usage: github-issue-cli.ts probe <issue-number>... | show <issue-number>... | check <run-id> [--state-root <path>] | publish-plan <run-id> [--state-root <path>]',
    );
  }
  const issueNumbers = rest.map(parseIssueNumber);
  if (!issueNumbers.length) throw new GitHubIssueCliError(`${commandName} requires at least one issue number`);
  return { commandName, issueNumbers };
}
async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.commandName === 'check') {
    console.log(JSON.stringify(await checkFrozenRequirements(parsed.runId!, { stateRoot: parsed.stateRoot }), null, 2));
    return;
  }
  if (parsed.commandName === 'publish-plan') {
    console.log(JSON.stringify(await publishPlanningArtifacts(parsed.runId!, { stateRoot: parsed.stateRoot }), null, 2));
    return;
  }
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
