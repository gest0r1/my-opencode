import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { linkPr, syncRun } from './pipeline-github-sync.mjs';
import { passkeyBrokerRequired, agentBrokerAction } from './owner-broker-client.mjs';
import { validateState } from './stage-cli-core.ts';

const DEFAULT_STATE_ROOT = '.tmp/pipelines';
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA = /^[0-9a-f]{40}$/i;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_BRANCH = /^(?!main$|master$)[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const MANAGED_START = '<!-- pipeline-github:start -->';
const MANAGED_END = '<!-- pipeline-github:end -->';

async function verifyProtectedDelivery(stateRoot: string, runId: string, candidate: string) {
  if (!passkeyBrokerRequired()) return;
  const state = await validateState(stateRoot, runId);
  if (state.status !== 'completed' || !state.manifest_file) throw new Error('OWNER_BROKER_DELIVERY_NOT_READY');
  const manifest = await readJson(state.manifest_file, 'manifest.json');
  for (const pipeline of manifest.pipelines) {
    for (const stage of pipeline.stages) {
      if (pipeline.executors?.[stage] !== 'owner_acceptance') continue;
      const runtime = state.pipelines?.[pipeline.id]?.stages?.[stage];
      if (runtime?.status !== 'completed') throw new Error('OWNER_BROKER_ACCEPTANCE_REQUIRED');
      const requestId = (runtime.evidence as Record<string, unknown> | null)?.owner_approval_request_id;
      const receipt = await agentBrokerAction({ action: 'status', request_id: requestId });
      if (receipt.current !== true || receipt.decision !== 'approved' || receipt.candidate_sha !== candidate.toLowerCase()) {
        throw new Error('OWNER_BROKER_DELIVERY_CANDIDATE_MISMATCH');
      }
    }
  }
}

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
  if (state.status !== 'completed') throw new GitHubPrCliError(`run must be completed before PR creation, got ${String(state.status)}`);
  if (!REPOSITORY.test(String(state.repository ?? ''))) {
    throw new GitHubPrCliError('state repository must be owner/repo');
  }
  // A RUN planned from an issue list rather than a GitHub handoff still delivers through a PR: it closes
  // the listed issues of its own repository, without the handoff's per-pipeline mapping.
  if (state.source_type !== 'github_issues') {
    return [...new Set((state.source_issues ?? [])
      .filter((issue: any) => issue?.repository === state.repository && Number.isInteger(issue?.number) && issue.number > 0)
      .map((issue: any) => issue.number as number))].sort((a, b) => a - b);
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
    // An owner-skipped validation stage is the owner's recorded decision, not a PASS to verify.
    if (state?.pipelines?.[String(pipeline.id)]?.stages?.[stage]?.status === 'skipped') continue;
    const localValidation = executor === 'local_gate' && pipeline?.github_ci_mode === 'off';
    if (executor !== 'github_ci' && executor !== 'github_dev' && !localValidation) {
      throw new GitHubPrCliError(`deployment validation is not a GitHub gate: ${String(pipeline?.id)}/${stage}`);
    }
    const evidence = await readJson(
      localValidation ? path.join(runDir, 'gates', `${String(pipeline.id)}-${stage}.json`) : path.join(runDir, 'github', `${String(pipeline.id)}-${stage}.json`),
      `deployment validation evidence ${String(pipeline.id)}/${stage}`,
    );
    if (localValidation) {
      if (evidence.status !== 'PASS' || evidence.purpose !== 'authoritative' ||
          (evidence.candidate_sha && String(evidence.candidate_sha).toLowerCase() !== candidateSha.toLowerCase())) {
        throw new GitHubPrCliError(`FINAL_CANDIDATE_VALIDATION_REQUIRED: ${String(pipeline.id)}/${stage} must PASS locally`);
      }
      continue;
    }
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
  await verifyProtectedDelivery(stateRoot, runId, candidate.candidateSha);
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

  if (state.source_type === 'github_issues') {
    const linked = await linkPr(runId, prNumber, { stateRoot });
    if (linked.pending !== 0) {
      throw new GitHubPrCliError(`PR link comments are still pending: ${String(linked.pending)}`);
    }
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

// Final release tag, set once after the owner merged the PR with a merge commit: vX.Y.Z goes on the
// exact candidate that passed every gate (it is a parent of the merge commit, so it is on main's
// history). Nothing is rebuilt. A squash or rebase merge produced different commits than the ones
// tested, so it is refused. The milestone is closed when none of its issues is still open.
export async function releaseAfterMerge(runId: string, options: { stateRoot?: string; cwd?: string } = {}): Promise<Record<string, unknown>> {
  if (!RUN_ID.test(runId)) throw new GitHubPrCliError('run-id must be path-safe');
  const cwd = options.cwd ?? process.cwd();
  const stateRoot = path.resolve(options.stateRoot ?? DEFAULT_STATE_ROOT);
  const runDir = path.join(stateRoot, runId);
  const state = await readJson(path.join(runDir, 'state.json'), 'state.json');
  const manifest = await readJson(String(state.manifest_file ?? ''), 'manifest.json');
  const version = String(manifest.release?.version ?? '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new GitHubPrCliError('RELEASE_NOT_VERSIONED: the manifest has no release.version from a milestone');
  const repository = currentRepository(cwd);
  if (state.repository && state.repository !== repository) throw new GitHubPrCliError(`current origin does not match frozen repository ${String(state.repository)}`);
  const candidate = assertCandidate(await readJson(path.join(runDir, 'candidate.json'), 'candidate.json'));
  await verifyProtectedDelivery(stateRoot, runId, candidate.candidateSha);
  requireGitHubAuth(cwd);
  const recorded = (state.issue_results ?? []).map((item: any) => item?.pr_number).find((value: unknown) => Number.isInteger(value));
  const pr = JSON.parse(gh(['pr', 'view', recorded ? String(recorded) : candidate.branch, '--repo', repository,
    '--json', 'number,state,headRefOid,mergeCommit'], cwd));
  if (pr.state !== 'MERGED') throw new GitHubPrCliError(`RELEASE_PR_NOT_MERGED: PR #${String(pr.number)} is ${String(pr.state)}`);
  if (String(pr.headRefOid).toLowerCase() !== candidate.candidateSha.toLowerCase()) {
    throw new GitHubPrCliError(`RELEASE_CANDIDATE_MISMATCH: PR #${String(pr.number)} head ${String(pr.headRefOid)} is not the tested candidate ${candidate.candidateSha}`);
  }
  const mergeSha = String(pr.mergeCommit?.oid ?? '');
  command('git', ['fetch', '--quiet', '--tags', 'origin', 'main:refs/remotes/origin/main'], { cwd });
  const parents = command('git', ['rev-list', '--parents', '-n', '1', mergeSha], { cwd }).split(/\s+/).slice(1).map((sha) => sha.toLowerCase());
  if (mergeSha.toLowerCase() !== candidate.candidateSha.toLowerCase() && !parents.includes(candidate.candidateSha.toLowerCase())) {
    throw new GitHubPrCliError(`RELEASE_NEEDS_MERGE_COMMIT: ${mergeSha} does not contain the tested candidate as a commit; merge PRs with a merge commit`);
  }
  const tag = `v${version}`;
  const existing = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], { cwd, encoding: 'utf8' });
  if (existing.status === 0) {
    if (existing.stdout.trim().toLowerCase() !== candidate.candidateSha.toLowerCase()) {
      throw new GitHubPrCliError(`RELEASE_TAG_EXISTS: ${tag} points at ${existing.stdout.trim()}, not the candidate`);
    }
  } else {
    command('git', ['tag', '-a', tag, candidate.candidateSha, '-m', `Release ${tag} (PR #${String(pr.number)}, run ${runId})`], { cwd });
    command('git', ['push', 'origin', `refs/tags/${tag}`], { cwd });
  }
  let milestone: Record<string, unknown> | null = null;
  const number = manifest.release?.milestone?.number;
  if (Number.isInteger(number)) {
    try {
      const info = JSON.parse(gh(['api', `repos/${repository}/milestones/${String(number)}`], cwd));
      if (info.state === 'open' && Number(info.open_issues) === 0) gh(['api', '--method', 'PATCH', `repos/${repository}/milestones/${String(number)}`, '-f', 'state=closed'], cwd);
      milestone = { number, closed: info.state === 'closed' || Number(info.open_issues) === 0, open_issues: Number(info.open_issues) };
    } catch (error) {
      milestone = { number, closed: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const result = { status: 'PASS', run_id: runId, tag, candidate_sha: candidate.candidateSha, merge_sha: mergeSha, pr_number: pr.number, milestone, released_at: new Date().toISOString() };
  await writeFile(path.join(runDir, 'release.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function parseArgs(args: string[]): { commandName: 'create' | 'release'; runId: string; stateRoot: string } {
  const [commandName, runId, ...rest] = args;
  if ((commandName !== 'create' && commandName !== 'release') || !runId) {
    throw new GitHubPrCliError('usage: github-pr-cli.ts create|release <run-id> [--state-root <path>]');
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
  return { commandName, runId, stateRoot };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.commandName === 'release') {
    console.log(JSON.stringify(await releaseAfterMerge(parsed.runId, { stateRoot: parsed.stateRoot }), null, 2));
    return;
  }
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
