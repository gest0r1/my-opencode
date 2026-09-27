export class GithubActionsGateError extends Error {}

const SAFE_WORKFLOW = /^\.github\/workflows\/[A-Za-z0-9._/-]+\.ya?ml$/i;
const JOB_ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function indentation(line) {
  return (line.match(/^\s*/) ?? [''])[0].length;
}

function unquote(value) {
  return value.trim().replace(/^['"]|['"]$/g, '');
}

export function assertGithubGateContract(contract, executor = 'github_ci') {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    throw new GithubActionsGateError('GITHUB_GATE_CONTRACT_MISSING');
  }
  if (typeof contract.workflow !== 'string' || !SAFE_WORKFLOW.test(contract.workflow) || contract.workflow.includes('..')) {
    throw new GithubActionsGateError('GITHUB_WORKFLOW_INVALID');
  }
  if (typeof contract.terminal_job !== 'string' || !JOB_ID.test(contract.terminal_job)) {
    throw new GithubActionsGateError('GITHUB_TERMINAL_JOB_INVALID');
  }
  if (!['push', 'workflow_dispatch'].includes(contract.trigger)) {
    throw new GithubActionsGateError('GITHUB_TRIGGER_INVALID');
  }
  if (contract.timeout_seconds !== undefined &&
      (!Number.isInteger(contract.timeout_seconds) || contract.timeout_seconds < 30 || contract.timeout_seconds > 7200)) {
    throw new GithubActionsGateError('GITHUB_TIMEOUT_INVALID');
  }
  if (executor === 'github_dev') {
    if (!['disposable', 'stateful'].includes(contract.mode)) {
      throw new GithubActionsGateError('GITHUB_DEV_MODE_INVALID');
    }
    if (typeof contract.source_ci_stage !== 'string' || !contract.source_ci_stage) {
      throw new GithubActionsGateError('GITHUB_DEV_SOURCE_CI_INVALID');
    }
    if (contract.mode === 'stateful' && (typeof contract.environment !== 'string' || !contract.environment.trim())) {
      throw new GithubActionsGateError('GITHUB_DEV_ENVIRONMENT_REQUIRED');
    }
  }
  return contract;
}

function eventNames(text) {
  const lines = text.split(/\r?\n/);
  const events = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/^on\s*:/.test(line)) continue;
    const inline = line.replace(/^on\s*:\s*/, '').trim();
    if (inline.startsWith('[') && inline.endsWith(']')) {
      for (const value of inline.slice(1, -1).split(',')) {
        const event = unquote(value);
        if (event) events.add(event);
      }
      return events;
    }
    if (inline) {
      events.add(unquote(inline));
      return events;
    }
    for (let j = i + 1; j < lines.length; j += 1) {
      const nested = lines[j];
      if (!nested.trim() || nested.trim().startsWith('#')) continue;
      if (indentation(nested) === 0) break;
      const match = nested.match(/^\s{2}([A-Za-z_][A-Za-z0-9_-]*)\s*:/);
      if (match?.[1]) events.add(match[1]);
    }
    return events;
  }
  return events;
}

function jobBlock(text, jobId) {
  const lines = text.split(/\r?\n/);
  let jobsIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^jobs\s*:\s*(?:#.*)?$/.test(lines[i])) {
      jobsIndex = i;
      break;
    }
  }
  if (jobsIndex < 0) return undefined;

  let start = -1;
  for (let i = jobsIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (indentation(line) === 0) break;
    const match = line.match(/^\s{2}([A-Za-z_][A-Za-z0-9_-]*)\s*:/);
    if (match?.[1] === jobId) {
      start = i;
      break;
    }
  }
  if (start < 0) return undefined;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (indentation(line) === 0) {
      end = i;
      break;
    }
    if (/^\s{2}[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(line)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end);
}

function jobDisplayName(block, jobId) {
  if (!block) return undefined;
  for (const line of block.slice(1)) {
    if (indentation(line) <= 2 && line.trim()) break;
    const match = line.match(/^\s{4}name\s*:\s*(.+?)\s*$/);
    if (match?.[1]) return unquote(match[1]);
  }
  return jobId;
}

export function inspectWorkflowText(text, contract, executor = 'github_ci') {
  assertGithubGateContract(contract, executor);
  if (typeof text !== 'string') throw new GithubActionsGateError('workflow text must be a string');

  const issues = [];
  const events = eventNames(text);
  if (!events.has(contract.trigger)) issues.push(`missing trigger: ${contract.trigger}`);
  if (executor === 'github_ci' && events.has('pull_request_target')) {
    issues.push('pull_request_target is forbidden for candidate CI');
  }
  if (/^\s*permissions\s*:\s*write-all\s*$/mi.test(text)) {
    issues.push('permissions: write-all is forbidden');
  }
  if (/^\s*secrets\s*:\s*inherit\s*$/mi.test(text)) {
    issues.push('secrets: inherit is forbidden in pipeline GitHub gates');
  }

  const terminal = jobBlock(text, contract.terminal_job);
  if (!terminal) issues.push(`terminal job not found: ${contract.terminal_job}`);
  const terminalJobName = jobDisplayName(terminal, contract.terminal_job);

  return {
    status: issues.length ? 'INCOMPATIBLE' : 'READY',
    workflow: contract.workflow,
    trigger: contract.trigger,
    terminal_job: contract.terminal_job,
    terminal_job_name: terminalJobName ?? contract.terminal_job,
    events: [...events].sort(),
    issues,
  };
}

export function classifyMissingWorkflow(contract, executor = 'github_ci') {
  assertGithubGateContract(contract, executor);
  return {
    status: 'MISSING',
    workflow: contract.workflow,
    trigger: contract.trigger,
    terminal_job: contract.terminal_job,
    issues: ['workflow file is missing'],
  };
}

export function selectWorkflowRun(runs, { candidateSha, branch, event }) {
  if (!Array.isArray(runs)) throw new GithubActionsGateError('workflow runs must be an array');
  const matches = runs.filter((run) =>
    String(run?.head_sha ?? '').toLowerCase() === String(candidateSha).toLowerCase() &&
    (!branch || run?.head_branch === branch) &&
    (!event || run?.event === event));
  matches.sort((a, b) => {
    const attempt = Number(b?.run_attempt ?? 0) - Number(a?.run_attempt ?? 0);
    if (attempt) return attempt;
    return Number(b?.id ?? 0) - Number(a?.id ?? 0);
  });
  return matches[0];
}

export function validateWorkflowResult({ run, jobs, artifacts, contract, candidateSha, terminalJobName, executor, sourceCiRunId }) {
  assertGithubGateContract(contract, executor);
  if (!run) throw new GithubActionsGateError('GITHUB_RUN_NOT_FOUND');
  if (String(run.head_sha ?? '').toLowerCase() !== String(candidateSha).toLowerCase()) {
    throw new GithubActionsGateError('GITHUB_RUN_SHA_MISMATCH');
  }
  if (run.status !== 'completed') throw new GithubActionsGateError(`GITHUB_RUN_NOT_COMPLETE: ${String(run.status)}`);
  if (run.conclusion !== 'success') throw new GithubActionsGateError(`GITHUB_RUN_FAILED: ${String(run.conclusion)}`);

  const expectedJobName = terminalJobName || contract.terminal_job;
  const job = (jobs ?? []).find((item) => item?.name === expectedJobName);
  if (!job) throw new GithubActionsGateError(`GITHUB_TERMINAL_JOB_MISSING: ${expectedJobName}`);
  if (job.status !== 'completed' || job.conclusion !== 'success') {
    throw new GithubActionsGateError(`GITHUB_TERMINAL_JOB_FAILED: ${expectedJobName} status=${String(job.status)} conclusion=${String(job.conclusion)}`);
  }

  let artifact;
  if (contract.artifact) {
    artifact = (artifacts ?? []).find((item) => item?.name === contract.artifact && item?.expired !== true);
    if (!artifact) throw new GithubActionsGateError(`GITHUB_ARTIFACT_MISSING: ${contract.artifact}`);
  }

  return {
    status: 'PASS',
    workflow_run_id: run.id,
    run_attempt: run.run_attempt ?? 1,
    candidate_sha: candidateSha,
    head_sha: run.head_sha,
    head_branch: run.head_branch,
    event: run.event,
    conclusion: run.conclusion,
    terminal_job: contract.terminal_job,
    terminal_job_name: expectedJobName,
    terminal_job_id: job.id,
    ...(contract.artifact ? { artifact: contract.artifact, artifact_id: artifact.id } : {}),
    ...(sourceCiRunId ? { source_ci_run_id: sourceCiRunId } : {}),
  };
}
