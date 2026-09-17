import { spawn } from 'node:child_process';

type InvocationResult = {
  exit_code: number;
  stdout: string;
  stderr: string;
};

type WorkflowRun = {
  id?: number;
  workflow_id?: number;
  name?: string;
  path?: string;
  status?: string;
  conclusion?: string | null;
  html_url?: string;
  created_at?: string;
};

export type ReleaseWaitObservation = {
  attempt: number;
  observed_at: string;
  ci_state: 'waiting' | 'success' | 'failed' | 'missing';
  workflows: Array<{
    name: string;
    status: string;
    conclusion: string | null;
    url?: string;
  }>;
  next_retry_seconds?: number;
};

export class GitHubReleaseWaitError extends Error {
  readonly classification:
    | 'producer_failed'
    | 'ci_not_observed'
    | 'wait_timeout'
    | 'artifact_missing_after_success'
    | 'ci_inspection_failed'
    | 'release_check_failed';
  readonly observations: ReleaseWaitObservation[];
  readonly lastResult: InvocationResult;

  constructor(
    classification: GitHubReleaseWaitError['classification'],
    message: string,
    observations: ReleaseWaitObservation[],
    lastResult: InvocationResult,
  ) {
    super(message);
    this.name = 'GitHubReleaseWaitError';
    this.classification = classification;
    this.observations = observations;
    this.lastResult = lastResult;
  }
}

type ReleaseTarget = {
  repo: string;
  url: string;
};

type Timing = {
  intervalMs: number;
  totalTimeoutMs: number;
  ciStartGraceMs: number;
  artifactGraceMs: number;
};

const DEFAULT_TIMING: Timing = {
  intervalMs: 60_000,
  totalTimeoutMs: 90 * 60_000,
  ciStartGraceMs: 5 * 60_000,
  artifactGraceMs: 10 * 60_000,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function is404(result: InvocationResult): boolean {
  return result.exit_code !== 0 && /(?:error:\s*404|\b404\b)/i.test(result.stderr);
}

export function parseGitHubReleaseTarget(args: string[], candidateSha: string): ReleaseTarget | undefined {
  for (const arg of args) {
    if (!arg.startsWith('https://github.com/')) continue;
    let url: URL;
    try {
      url = new URL(arg);
    } catch {
      continue;
    }
    if (url.hostname !== 'github.com') continue;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 6 || parts[2] !== 'releases' || parts[3] !== 'download') continue;
    const [owner, repo] = parts;
    if (!owner || !repo) continue;
    if (!url.pathname.includes(candidateSha)) continue;
    return { repo: `${owner}/${repo}`, url: arg };
  }
  return undefined;
}

function latestRuns(runs: WorkflowRun[]): WorkflowRun[] {
  const latest = new Map<string, WorkflowRun>();
  for (const run of runs) {
    const key = String(run.workflow_id ?? `${run.name ?? ''}:${run.path ?? ''}`);
    const previous = latest.get(key);
    const runOrder = Number(run.id ?? 0);
    const previousOrder = Number(previous?.id ?? 0);
    if (!previous || runOrder >= previousOrder) latest.set(key, run);
  }
  return [...latest.values()];
}

export function classifyWorkflowRuns(runs: WorkflowRun[]): {
  state: ReleaseWaitObservation['ci_state'];
  runs: WorkflowRun[];
} {
  const current = latestRuns(runs);
  if (current.length === 0) return { state: 'missing', runs: [] };
  const active = current.some((run) => run.status !== 'completed');
  if (active) return { state: 'waiting', runs: current };
  if (current.some((run) => run.conclusion === 'success')) return { state: 'success', runs: current };
  return { state: 'failed', runs: current };
}

function runProcess(exe: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<InvocationResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ exit_code: code ?? 1, stdout, stderr }));
  });
}

async function fetchRuns(repo: string, candidateSha: string, cwd: string, env: NodeJS.ProcessEnv): Promise<WorkflowRun[]> {
  const endpoint = `repos/${repo}/actions/runs?head_sha=${candidateSha}&per_page=100`;
  const result = await runProcess('gh', ['api', endpoint], cwd, env);
  if (result.exit_code !== 0) {
    throw new Error(result.stderr.trim() || `gh api exited ${result.exit_code}`);
  }
  const payload = JSON.parse(result.stdout) as { workflow_runs?: WorkflowRun[] };
  return Array.isArray(payload.workflow_runs) ? payload.workflow_runs : [];
}

function summarize(runs: WorkflowRun[]): ReleaseWaitObservation['workflows'] {
  return runs.map((run) => ({
    name: run.name ?? run.path ?? `workflow-${run.workflow_id ?? 'unknown'}`,
    status: run.status ?? 'unknown',
    conclusion: run.conclusion ?? null,
    ...(run.html_url ? { url: run.html_url } : {}),
  }));
}

export async function waitForGitHubRelease(options: {
  candidateSha: string;
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  firstResult: InvocationResult;
  rerun: () => Promise<InvocationResult>;
  onWaiting?: (observation: ReleaseWaitObservation) => Promise<void>;
  timing?: Partial<Timing>;
}): Promise<{ result: InvocationResult; observations: ReleaseWaitObservation[] } | undefined> {
  if (options.executable !== 'curl' || !is404(options.firstResult)) return undefined;
  const target = parseGitHubReleaseTarget(options.args, options.candidateSha);
  if (!target) return undefined;

  const timing = { ...DEFAULT_TIMING, ...(options.timing ?? {}) };
  const startedAt = Date.now();
  let successObservedAt: number | undefined;
  let result = options.firstResult;
  let attempt = 1;
  const observations: ReleaseWaitObservation[] = [];

  while (true) {
    const now = Date.now();
    if (now - startedAt >= timing.totalTimeoutMs) {
      throw new GitHubReleaseWaitError('wait_timeout', 'timed out waiting for GitHub Actions/release readiness', observations, result);
    }

    let classified: ReturnType<typeof classifyWorkflowRuns>;
    try {
      classified = classifyWorkflowRuns(await fetchRuns(target.repo, options.candidateSha, options.cwd, options.env));
    } catch (error) {
      throw new GitHubReleaseWaitError(
        'ci_inspection_failed',
        `cannot inspect GitHub Actions for ${target.repo}@${options.candidateSha}: ${String((error as Error)?.message ?? error)}`,
        observations,
        result,
      );
    }

    const observation: ReleaseWaitObservation = {
      attempt,
      observed_at: new Date().toISOString(),
      ci_state: classified.state,
      workflows: summarize(classified.runs),
    };

    if (classified.state === 'failed') {
      observations.push(observation);
      throw new GitHubReleaseWaitError('producer_failed', 'GitHub Actions for the exact candidate SHA completed without a successful run', observations, result);
    }

    if (classified.state === 'missing' && now - startedAt >= timing.ciStartGraceMs) {
      observations.push(observation);
      throw new GitHubReleaseWaitError('ci_not_observed', 'no GitHub Actions run appeared for the exact candidate SHA within the CI start grace period', observations, result);
    }

    if (classified.state === 'success') {
      successObservedAt ??= now;
      if (now - successObservedAt >= timing.artifactGraceMs) {
        observations.push(observation);
        throw new GitHubReleaseWaitError('artifact_missing_after_success', 'GitHub Actions succeeded but the candidate release remained unavailable past the artifact grace period', observations, result);
      }
    }

    observation.next_retry_seconds = Math.ceil(timing.intervalMs / 1000);
    observations.push(observation);
    await options.onWaiting?.(observation);
    await sleep(timing.intervalMs);

    result = await options.rerun();
    attempt += 1;
    if (result.exit_code === 0) return { result, observations };
    if (!is404(result)) {
      throw new GitHubReleaseWaitError('release_check_failed', 'release check changed from transient 404 to another failure', observations, result);
    }
  }
}
