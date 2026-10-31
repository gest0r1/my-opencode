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
    author_association: comment.author_association ?? null,
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

export function canonicalRequirements(snapshot: Record<string, any>): Record<string, unknown> {
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
      comments: (Array.isArray(issue.comments) ? issue.comments : [])
        .filter((comment: Record<string, unknown>) => !isPipelineOwnedComment(comment))
        .map((comment: Record<string, unknown>) => ({
          id: comment.id ?? null,
          user: comment.user ?? null,
          body: typeof comment.body === 'string' ? comment.body : '',
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


export async function verifyOwnerApprovals(manifestPath: string, options: { cwd?: string } = {}): Promise<Record<string, unknown>> {
  const absolute = path.resolve(manifestPath);
  const root = path.dirname(absolute);
  const manifest = parseJson<Record<string, any>>(await readFile(absolute, 'utf8'), 'manifest');
  if (manifest.schema_version !== 2)
    return { status: 'PASS', checked: false, reason: 'legacy PLAN' };
  const ready = manifest.planning_readiness ?? {};
  const fail = (message: string): never => { throw new GitHubIssueCliError('OWNER_APPROVAL_INVALID: ' + message); };
  const storyGate = Object.keys(ready.gates ?? {}).find(name => /stor/i.test(name) && ready.required_gates?.includes(name));
  if (!storyGate) {
    const storyNames = await readdir(path.join(root, 'stories')).catch(() => []);
    const deltaNames = await readdir(path.join(root, 'planning/story-deltas')).catch(() => []);
    if (storyNames.some(name => /^issue-[0-9]+\.md$/.test(name)) ||
        deltaNames.some(name => /^issue-[0-9]+-[^.]+\.md$/.test(name))) fail('behavior artifacts exist without Story gate');
    return { status: 'PASS', checked: false, reason: 'technical-only PLAN' };
  }
  if (manifest.source_type !== 'github_issues')
    fail('non-GitHub Story approvals require an independently verifiable user-message source, which is not configured');
  const ref = ready.required_artifacts?.owner_approvals;
  if (ref?.path !== 'planning/owner-approvals.json' || !/^[a-f0-9]{64}$/i.test(String(ref?.sha256 ?? '')))
    fail('missing frozen approval index');
  const raw = await readFile(path.join(root, ref.path), 'utf8').catch(() => fail('approval index missing'));
  if (sha256(raw) !== String(ref.sha256).toLowerCase()) fail('approval index SHA mismatch');
  const index = parseJson<Record<string, any>>(raw, 'approval index');
  if (index.schema_version !== 1 || index.run_id !== manifest.run_id ||
      !Array.isArray(index.entries) || !index.entries.length) fail('invalid index shape/run');
  const issues = (manifest.source_issues ?? []).map((item: any) => Number(item.number));
  if (!issues.length) fail('no frozen issues');
  const live = await readIssues(issues, options);
  if (live.repository !== manifest.repository ||
      live.requirements_sha256 !== manifest.source_requirements_sha256) fail('requirements/source changed');
  const storyReviewRef = ready.gates[storyGate]?.review;
  if (!storyReviewRef?.path || !storyReviewRef.sha256) fail('full baseline Story review missing');
  const storyReview = await readFile(path.join(root, storyReviewRef.path), 'utf8').catch(() => fail('Story review missing'));
  if (sha256(storyReview) !== String(storyReviewRef.sha256).toLowerCase() ||
      !/status:\s*ready/i.test(storyReview) || !/review_scope:\s*full/i.test(storyReview))
    fail('baseline review not full and ready');
  const ledger = await readFile(path.join(root, 'planning/review-ledger.json'), 'utf8')
    .then(JSON.parse).catch(() => fail('review ledger missing'));
  const reviewed = (ledger.entries ?? []).filter((entry: any) =>
    entry.kind === 'review' && entry.gate === storyGate && entry.sha256 === storyReviewRef.sha256).at(-1);
  if (!reviewed || reviewed.status !== 'ready' || reviewed.scope !== 'full' ||
      !Number.isFinite(Date.parse(String(reviewed.at)))) fail('full ready review not recorded with valid timestamp');
  const architectureReview = (ledger.entries ?? []).filter((entry: any) =>
    entry.kind === 'review' && entry.gate === 'architecture' && entry.status === 'ready' &&
    entry.scope === 'full').at(-1);
  const records = new Map<string, any>();
  const technicalGate = Object.keys(ready.gates ?? {}).find(key => /technical/i.test(key));
  for (const row of index.entries) {
    if (!row || !issues.includes(row.issue_number) ||
        !['baseline', 'delta'].includes(row.kind) ||
        !Number.isSafeInteger(row.comment_id) || row.comment_id < 1 ||
        !['approve', 'reject'].includes(row.decision) ||
        !/^[a-f0-9]{64}$/i.test(String(row.sha256 ?? '')) ||
        typeof row.artifact_path !== 'string') fail('malformed decision entry');
    const expectedBaseline = 'stories/issue-' + row.issue_number + '.md';
    const deltaPattern = new RegExp('^planning/story-deltas/issue-' + row.issue_number + '-[A-Za-z0-9_.-]+\\.md$');
    if ((row.kind === 'baseline' && (row.artifact_path !== expectedBaseline || row.decision !== 'approve')) ||
        (row.kind === 'delta' && !deltaPattern.test(row.artifact_path))) fail('unsafe story/delta path');
    if (records.has(row.artifact_path)) fail('duplicate decision entry');
    const content = await readFile(path.join(root, row.artifact_path), 'utf8').catch(() => fail('missing artifact'));
    if (sha256(content) !== row.sha256.toLowerCase()) fail('artifact SHA changed');
    if (row.kind === 'baseline') {
      if (!storyReview.includes(row.artifact_path) || !storyReview.includes(row.sha256))
        fail('Story not bound to reviewed baseline');
    } else if (row.decision === 'approve') {
      const architecture = ready.gates.architecture?.artifact;
      const technical = ready.gates[technicalGate ?? ''];
      if (!architecture?.sha256 || row.architecture_sha256 !== architecture.sha256)
        fail('delta not bound to frozen architecture');
      if (!technical?.review?.path || technical.status !== 'ready') fail('required technical review missing');
      const techText = await readFile(path.join(root, technical.review.path), 'utf8')
        .catch(() => fail('technical review unavailable'));
      if (sha256(techText) !== String(technical.review.sha256).toLowerCase() ||
          !techText.includes(row.sha256)) fail('independent technical review did not check delta SHA');
    }
    const actual = latestApprovalEntry(live.issues, manifest.run_id, row.issue_number, row.artifact_path);
    if (!actual || Number(actual.comment.id) !== row.comment_id ||
        actual.sha256.toLowerCase() !== row.sha256.toLowerCase() ||
        actual.decision !== row.decision) fail('owner decision absent, revoked or stale');
    const decisionTime = Date.parse(String(actual.comment.created_at));
    if (!Number.isFinite(decisionTime)) fail('owner approval has invalid GitHub timestamp');
    if (row.kind === 'baseline' && decisionTime < Date.parse(reviewed.at))
      fail('owner approval predates the full Story review');
    // An architecture gate may have an authored artifact but no separate review evidence.
    // Require chronology only when that independent review actually exists; the SHA-linked
    // architecture artifact and mandatory technical delta review are always checked above.
    if (row.kind === 'delta' && row.decision === 'approve' &&
        ready.gates.architecture?.review &&
        (!architectureReview || !Number.isFinite(Date.parse(String(architectureReview.at))) ||
         decisionTime < Date.parse(String(architectureReview.at))))
      fail('owner delta approval predates the reviewed architecture');
    records.set(row.artifact_path, row);
  }
  const storyFiles = await readdir(path.join(root, 'stories')).catch(() => fail('Stories directory missing'));
  for (const name of storyFiles)
    if (/^issue-[1-9][0-9]*\.md$/.test(name) && !records.has('stories/' + name))
      fail('unapproved baseline Story ' + name);
  const deltaFiles = await readdir(path.join(root, 'planning/story-deltas')).catch(() => []);
  for (const name of deltaFiles)
    if (/^issue-[1-9][0-9]*-[A-Za-z0-9_.-]+\.md$/.test(name) &&
        !records.has('planning/story-deltas/' + name)) fail('unapproved delta ' + name);
  return { status: 'PASS', checked: true, verified_entries: records.size };
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

function artifactMarker(kind: 'story' | 'architecture', runId: string, issueNumber: number, artifactSha: string, part?: { index: number; total: number }): string {
  const suffix = part ? `:part-${part.index}-of-${part.total}` : '';
  return `<!-- pipeline-artifact:${kind}:${runId}:issue-${issueNumber}:sha-${artifactSha}${suffix} -->`;
}

// GitHub rejects a comment body above 65 536 characters (characters, not UTF-8 bytes, so
// Cyrillic text gets the same room as Latin). Stay a little below it.
export const MAX_COMMENT_CHARS = 65_000;

// Split Markdown into pieces of at most `budget` characters: whole `#`/`##` sections first,
// then paragraphs, then lines; a fenced code block cut in two is closed and reopened.
export function splitMarkdown(content: string, budget: number): string[] {
  const units: string[] = [];
  const pushUnit = (text: string, separators: RegExp[]) => {
    if (text.length <= budget || !separators.length) {
      for (let offset = 0; offset < text.length; offset += budget) units.push(text.slice(offset, offset + budget));
      return;
    }
    const [separator, ...rest] = separators;
    const pieces = text.split(separator).filter((piece) => piece.length > 0);
    if (pieces.length <= 1) return pushUnit(text, rest);
    for (const piece of pieces) pushUnit(piece, rest);
  };
  pushUnit(content, [/(?=^#{1,2} )/m, /(?<=\n\n)/, /(?<=\n)/]);

  const chunks: string[] = [];
  let current = '';
  for (const unit of units) {
    if (current && current.length + unit.length > budget) { chunks.push(current); current = ''; }
    current += unit;
  }
  if (current) chunks.push(current);

  // Keep every chunk's code fences balanced so each comment renders on its own.
  const fence = '```';
  let open = false;
  return chunks.map((chunk) => {
    let text = open ? `${fence}\n${chunk}` : chunk;
    const fences = (chunk.match(/^```/gm) ?? []).length;
    if (fences % 2 === 1) open = !open;
    if (open) text = `${text.replace(/\n?$/, '\n')}${fence}`;
    return text.trim();
  });
}

function renderArtifactComments(
  kind: 'story' | 'architecture',
  runId: string,
  issueNumber: number,
  requirementsSha: string,
  artifact: { content: string; sha256: string },
): Array<{ marker: string; body: string }> {
  const title = kind === 'story' ? 'Pipeline Story' : 'Pipeline Architecture';
  const header = (marker: string, heading: string) => [
    marker,
    `## ${heading}`,
    `Run: \`${runId}\``,
    `Requirements SHA-256: \`${requirementsSha}\``,
    `Artifact SHA-256: \`${artifact.sha256}\``,
    '',
  ].join('\n');
  const content = artifact.content.trim();
  const single = artifactMarker(kind, runId, issueNumber, artifact.sha256);
  const singleBody = `${header(single, title)}\n${content}`;
  if (singleBody.length <= MAX_COMMENT_CHARS) return [{ marker: single, body: singleBody }];

  // Reserve room for the longest header (part numbers up to 999) and the fence repair.
  const reserve = header(artifactMarker(kind, runId, issueNumber, artifact.sha256, { index: 999, total: 999 }), `${title} (999/999)`).length + 16;
  const parts = splitMarkdown(content, MAX_COMMENT_CHARS - reserve);
  return parts.map((part, offset) => {
    const position = { index: offset + 1, total: parts.length };
    const marker = artifactMarker(kind, runId, issueNumber, artifact.sha256, position);
    const body = `${header(marker, `${title} (${position.index}/${position.total})`)}\n${part}`;
    if (body.length > MAX_COMMENT_CHARS) {
      throw new GitHubIssueCliError(`${kind} comment part ${position.index} for issue #${issueNumber} exceeds GitHub comment size`);
    }
    return { marker, body };
  });
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
  const { acceptedReconciliations } = await import('./reconcile-evidence.ts');
  const state = await readFile(path.join(runRoot, 'state.json'), 'utf8').then(JSON.parse).catch((error) => { if (error.code === 'ENOENT') return undefined; throw error; });
  const records = await acceptedReconciliations(runRoot, state, sha256(await readFile(manifestPath, 'utf8')));
  const frozen = String(records.at(-1)?.source_requirements_sha256 ?? manifest.source_requirements_sha256 ?? '');
  if (!SHA256.test(frozen)) throw new GitHubIssueCliError('manifest source_requirements_sha256 is missing or invalid');
  const issueNumbers = Array.isArray(manifest.source_issues)
    ? manifest.source_issues.map((issue: any) => Number(issue.number)).filter((n: number) => Number.isInteger(n) && n > 0)
    : [];
  if (!issueNumbers.length) throw new GitHubIssueCliError('github_issues manifest has no source issue numbers');
  const live = await probeRequirements(issueNumbers, { cwd });
  const liveSha = String(live.requirements_sha256 ?? '');
  if (!SHA256.test(liveSha)) throw new GitHubIssueCliError('live source requirements digest is invalid');
  if (liveSha.toLowerCase() !== frozen.toLowerCase()) {
    throw new GitHubIssueCliError(`SOURCE_REQUIREMENTS_CHANGED: reconcile required; frozen=${frozen.toLowerCase()} live=${liveSha.toLowerCase()}`);
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
  // A technical-only or Story-only PLAN may not need an architecture gate.
  const architecture = architectureRef ? await readFrozenArtifact(runRoot, architectureRef, 'architecture') : undefined;
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
    if (architecture) artifacts.push({ kind: 'architecture', content: architecture.content, sha256: architecture.sha256 });

    const hasMarker = (marker: string) => comments.some((comment: any) => typeof comment.body === 'string' && comment.body.includes(marker));
    for (const artifact of artifacts) {
      // Exact version marker: reuse same SHA, append a new comment for a changed SHA.
      // Historical unversioned comments remain visible but do not suppress a new version.
      if (hasMarker(artifactMarker(artifact.kind, runId, number, artifact.sha256))) {
        existing += 1;
        continue;
      }
      // A long document goes out as numbered parts; a rerun adds only the missing ones.
      for (const { marker, body } of renderArtifactComments(artifact.kind, runId, number, frozenRequirements, artifact)) {
        if (hasMarker(marker)) {
          existing += 1;
          continue;
        }
        gh([
          'api', '--method', 'POST',
          `repos/${live.repository}/issues/${number}/comments`,
          '-H', 'X-GitHub-Api-Version: 2022-11-28',
          '-f', `body=${body}`,
        ], cwd);
        published += 1;
      }
    }
  }
  return { status: 'PASS', run_id: runId, repository: live.repository, published, existing };
}

// Version comes from the milestone name only (`v.0.6.4`, `v0.6.4`, `0.6.4` -> 0.6.4): PLAN never asks
// the owner for it. Anything that makes that version unusable stops PLAN with the reason, and the
// owner fixes the milestone instead of discussing versions inside the pipeline.
export function versionFromMilestone(title: string): string | undefined {
  return /^v?\.?(\d+\.\d+\.\d+)$/i.exec(title.trim())?.[1];
}

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number); const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

export async function milestoneRequirements(name: string, options: { cwd?: string; stateRoot?: string } = {}) {
  const cwd = options.cwd ?? process.cwd();
  requireGitHubAuth(cwd);
  const repository = currentRepository(cwd);
  const milestones = flattenPages(parseJson<unknown>(gh(['api', '--paginate', '--slurp', `repos/${repository}/milestones?state=all&per_page=100`], cwd), 'milestones')) as any[];
  const milestone = milestones.find((item) => String(item.title) === name || String(item.number) === name);
  if (!milestone) throw new GitHubIssueCliError(`MILESTONE_NOT_FOUND: ${name}`);
  const issues = (flattenPages(parseJson<unknown>(gh(['api', '--paginate', '--slurp',
    `repos/${repository}/issues?milestone=${Number(milestone.number)}&state=open&per_page=100`], cwd), 'milestone issues')) as any[])
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({ number: Number(issue.number), title: String(issue.title ?? '') }))
    .sort((a, b) => a.number - b.number);
  const version = versionFromMilestone(String(milestone.title));
  const conflicts: string[] = [];
  if (!version) conflicts.push(`MILESTONE_NOT_SEMVER: "${String(milestone.title)}" does not name a version like v0.6.5`);
  if (!issues.length) conflicts.push('MILESTONE_EMPTY: no open issues');
  if (version) {
    command('git', ['fetch', '--quiet', '--tags', 'origin', 'main:refs/remotes/origin/main'], { cwd });
    if (gitSucceeds(['rev-parse', '--verify', '--quiet', `refs/tags/v${version}`], cwd)) conflicts.push(`VERSION_TAGGED: tag v${version} already exists`);
    const mainVersion = gitOutput(['show', 'refs/remotes/origin/main:VERSION'], cwd)?.trim().replace(/^v/, '');
    if (mainVersion && /^\d+\.\d+\.\d+$/.test(mainVersion) && compareVersions(mainVersion, version) >= 0) {
      conflicts.push(`VERSION_BEHIND_MAIN: main VERSION is ${mainVersion}, milestone asks for ${version}`);
    }
    const root = path.resolve(cwd, options.stateRoot ?? '.tmp/pipelines');
    for (const run of await readdir(root).catch(() => [] as string[])) {
      const manifest = await readFile(path.join(root, run, 'manifest.json'), 'utf8').then((raw) => JSON.parse(raw), () => undefined);
      const state = await readFile(path.join(root, run, 'state.json'), 'utf8').then((raw) => JSON.parse(raw), () => undefined);
      if (manifest?.release?.version === version && state && state.status !== 'completed' && !state.superseded_by) {
        conflicts.push(`VERSION_TAKEN: run ${run} already plans ${version}`);
      }
    }
  }
  return { status: conflicts.length ? 'BLOCKED' : 'PASS', repository, milestone: { number: Number(milestone.number), title: String(milestone.title) },
    version: version ?? null, issue_numbers: issues.map((issue) => issue.number), issues, conflicts };
}

function gitSucceeds(args: string[], cwd: string): boolean {
  return spawnSync('git', args, { cwd, encoding: 'utf8' }).status === 0;
}
function gitOutput(args: string[], cwd: string): string | undefined {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout : undefined;
}

function parseArgs(args: string[]): {
  commandName: 'probe' | 'show' | 'check' | 'publish-plan' | 'milestone';
  issueNumbers: number[];
  runId?: string;
  stateRoot?: string;
  milestone?: string;
} {
  const [commandName, ...rest] = args;
  if (commandName === 'milestone') {
    if (rest.length !== 1 || !rest[0]) throw new GitHubIssueCliError('usage: github-issue-cli.ts milestone <title|number>');
    return { commandName, issueNumbers: [], milestone: rest[0] };
  }
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
      'usage: github-issue-cli.ts probe <issue-number>... | show <issue-number>... | milestone <title|number> | check <run-id> [--state-root <path>] | publish-plan <run-id> [--state-root <path>]',
    );
  }
  const issueNumbers = rest.map(parseIssueNumber);
  if (!issueNumbers.length) throw new GitHubIssueCliError(`${commandName} requires at least one issue number`);
  return { commandName, issueNumbers };
}
async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.commandName === 'milestone') {
    const result = await milestoneRequirements(parsed.milestone!);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'PASS') process.exitCode = 1;
    return;
  }
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

