export class GithubActionsGateError extends Error {}

const SAFE_WORKFLOW = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/i;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SAFE_JSON_FILE = /^[A-Za-z0-9._-]+\.json$/;
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
    if (contract.mode === 'stateful') {
      if (contract.trigger !== 'workflow_dispatch') throw new GithubActionsGateError('GITHUB_STATEFUL_DEV_REQUIRES_DISPATCH');
      if (typeof contract.environment !== 'string' || !contract.environment.trim()) throw new GithubActionsGateError('GITHUB_DEV_ENVIRONMENT_REQUIRED');
      if (typeof contract.trusted_ref !== 'string' || !SAFE_REF.test(contract.trusted_ref) || contract.trusted_ref.includes('..') || contract.trusted_ref.endsWith('/')) throw new GithubActionsGateError('GITHUB_DEV_TRUSTED_REF_INVALID');
      if (typeof contract.artifact !== 'string' || !contract.artifact.trim()) throw new GithubActionsGateError('GITHUB_DEV_EVIDENCE_ARTIFACT_REQUIRED');
      if (typeof contract.evidence_file !== 'string' || !SAFE_JSON_FILE.test(contract.evidence_file)) throw new GithubActionsGateError('GITHUB_DEV_EVIDENCE_FILE_INVALID');
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

function workflowDispatchInputNames(text) {
  const lines = text.split(/\r?\n/);
  const names = new Set();
  let inDispatch = false;
  let inInputs = false;
  for (const line of lines) {
    const indent = indentation(line);
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (/^\s{2}workflow_dispatch\s*:/.test(line)) { inDispatch = true; inInputs = false; continue; }
    if (inDispatch && indent <= 2 && !/^\s{2}/.test(line)) { inDispatch = false; inInputs = false; }
    if (inDispatch && /^\s{4}inputs\s*:/.test(line)) { inInputs = true; continue; }
    if (inDispatch && inInputs) {
      if (indent <= 4) { inInputs = false; continue; }
      const match = line.match(/^\s{6}([A-Za-z_][A-Za-z0-9_-]*)\s*:/);
      if (match?.[1]) names.add(match[1]);
    }
  }
  return names;
}

function rootValue(text, key) {
  const line = text.split(/\r?\n/).find((item) => item.startsWith(key + ':'));
  return line ? unquote(line.slice(key.length + 1)) : undefined;
}

function jobEnvironment(block) {
  if (!block) return undefined;
  for (const line of block.slice(1)) {
    if (indentation(line) <= 2 && line.trim()) break;
    const match = line.match(/^\s{4}environment\s*:\s*(.+?)\s*$/);
    if (match?.[1]) return unquote(match[1]);
  }
  return undefined;
}
function actionPinIssues(text) {
  const issues = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*-?\s*uses\s*:\s*['"]?([^'"\s]+)['"]?\s*$/);
    if (!match?.[1]) continue;
    const spec = match[1];
    if (spec.startsWith('./')) continue;
    if (spec.startsWith('docker://')) {
      if (!/@sha256:[0-9a-f]{64}$/i.test(spec)) issues.push(`container action is not digest-pinned: ${spec}`);
      continue;
    }
    const at = spec.lastIndexOf('@');
    const ref = at >= 0 ? spec.slice(at + 1) : '';
    if (!/^[0-9a-f]{40}$/i.test(ref)) issues.push(`action is not commit-SHA pinned: ${spec}`);
  }
  return issues;
}

function eventBranchRules(text, event) {
  const lines = text.split(/\r?\n/);
  let eventStart = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (new RegExp('^\\s{2}' + event + '\\s*:').test(lines[i])) { eventStart = i; break; }
  }
  if (eventStart < 0) return { branches: [], ignore: [] };
  const block = [];
  for (let i = eventStart + 1; i < lines.length; i += 1) {
    if (lines[i].trim() && indentation(lines[i]) <= 2) break;
    block.push(lines[i]);
  }
  const readList = (key) => {
    for (let i = 0; i < block.length; i += 1) {
      const inline = block[i].match(new RegExp('^\\s{4}' + key + '\\s*:\\s*\\[(.*)\\]\\s*
  assertGithubGateContract(contract, executor);
  if (typeof text !== 'string') throw new GithubActionsGateError('workflow text must be a string');

  const issues = [];
  const events = eventNames(text);
  if (!events.has(contract.trigger)) issues.push(`missing trigger: ${contract.trigger}`);
  if (executor === 'github_ci' && events.has('pull_request_target')) {
    issues.push('pull_request_target is forbidden for candidate CI');
  }
  if (!/^permissions\s*:/m.test(text)) {
    issues.push('explicit root permissions are required');
  }
  if (/^\s*permissions\s*:\s*write-all\s*$/mi.test(text)) {
    issues.push('permissions: write-all is forbidden');
  }
  if (/^\s*secrets\s*:\s*inherit\s*$/mi.test(text)) {
    issues.push('secrets: inherit is forbidden in pipeline GitHub gates');
  }
  if (/^\s*continue-on-error\s*:\s*true\s*$/mi.test(text)) {
    issues.push('continue-on-error: true is forbidden in authoritative gates');
  }
  for (const issue of actionPinIssues(text)) issues.push(issue);
  if (executor === 'github_ci' && /\$\{\{\s*secrets\./.test(text)) {
    issues.push('candidate CI must not reference repository/environment secrets');
  }
  if (executor === 'github_ci' && contract.trigger === 'push' &&
      context.candidateBranch && !pushAcceptsBranch(text, context.candidateBranch)) {
    issues.push(`push trigger does not include candidate branch: ${context.candidateBranch}`);
  }
  if (contract.artifact &&
      (!/actions\/upload-artifact@/i.test(text) || !text.includes(contract.artifact))) {
    issues.push(`declared artifact is not uploaded: ${contract.artifact}`);
  }

  const terminal = jobBlock(text, contract.terminal_job);
  if (!terminal) issues.push(`terminal job not found: ${contract.terminal_job}`);
  const terminalJobName = jobDisplayName(terminal, contract.terminal_job);

  if (executor === 'github_dev' && contract.mode === 'stateful') {
    const inputs = workflowDispatchInputNames(text);
    for (const required of ['candidate_sha', 'ci_run_id', 'ci_artifact', 'pipeline_run_id']) {
      if (!inputs.has(required)) issues.push(`missing workflow_dispatch input: ${required}`);
    }
    const runName = rootValue(text, 'run-name') ?? '';
    if (!/inputs\.pipeline_run_id/.test(runName) || !/inputs\.candidate_sha/.test(runName)) issues.push('stateful DEV run-name must include inputs.pipeline_run_id and inputs.candidate_sha');
    const environment = jobEnvironment(terminal);
    if (environment !== contract.environment) issues.push(`terminal job environment must equal ${contract.environment}`);
    if (!/inputs\.ci_run_id/.test(text) || !/inputs\.ci_artifact/.test(text)) issues.push('stateful DEV must consume source CI run/artifact inputs');
    if (!/(actions\/download-artifact|gh\s+run\s+download)/.test(text)) issues.push('stateful DEV must download the source CI artifact');
    if (!/actions\/upload-artifact/.test(text) || !text.includes(contract.artifact) || !text.includes(contract.evidence_file)) issues.push('stateful DEV must upload the declared DEV evidence artifact/file');
    if (/actions\/checkout[\s\S]{0,500}ref:\s*\$\{\{\s*inputs\.candidate_sha\s*\}\}/m.test(text)) issues.push('stateful DEV must not checkout candidate source');
  }

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

export function selectStatefulWorkflowRun(runs, { trustedRef, event = 'workflow_dispatch', correlation, candidateSha, excludeIds = [] }) {
  if (!Array.isArray(runs)) throw new GithubActionsGateError('workflow runs must be an array');
  const excluded = new Set(excludeIds.map((value) => Number(value)));
  const shortSha = String(candidateSha ?? '').slice(0, 12);
  const matches = runs.filter((run) => {
    const title = String(run?.display_title ?? run?.name ?? '');
    return !excluded.has(Number(run?.id)) && run?.head_branch === trustedRef && run?.event === event &&
      (!correlation || title.includes(correlation)) &&
      (!candidateSha || title.includes(String(candidateSha)) || (shortSha && title.includes(shortSha)));
  });
  matches.sort((a, b) => Number(b?.id ?? 0) - Number(a?.id ?? 0));
  return matches[0];
}

export function validateDevEvidence(data, { candidateSha, ciRunId }) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new GithubActionsGateError('GITHUB_DEV_EVIDENCE_INVALID');
  if (data.status !== 'PASS') throw new GithubActionsGateError('GITHUB_DEV_EVIDENCE_FAILED');
  if (String(data.candidate_sha ?? '').toLowerCase() !== String(candidateSha).toLowerCase()) throw new GithubActionsGateError('GITHUB_DEV_EVIDENCE_CANDIDATE_MISMATCH');
  if (String(data.installed_sha ?? '').toLowerCase() !== String(candidateSha).toLowerCase()) throw new GithubActionsGateError('GITHUB_DEV_EVIDENCE_INSTALLED_SHA_MISMATCH');
  if (Number(data.ci_run_id) !== Number(ciRunId)) throw new GithubActionsGateError('GITHUB_DEV_EVIDENCE_CI_RUN_MISMATCH');
  return { status: 'PASS', candidate_sha: data.candidate_sha, installed_sha: data.installed_sha, ci_run_id: Number(data.ci_run_id), smoke_result: data.smoke_result ?? null };
}
export function validateWorkflowResult({ run, jobs, artifacts, contract, candidateSha, terminalJobName, executor, sourceCiRunId }) {
  assertGithubGateContract(contract, executor);
  if (!run) throw new GithubActionsGateError('GITHUB_RUN_NOT_FOUND');
  if (executor === 'github_dev' && contract.mode === 'stateful') {
    if (run.head_branch !== contract.trusted_ref) throw new GithubActionsGateError('GITHUB_DEV_TRUSTED_REF_MISMATCH');
  } else if (String(run.head_sha ?? '').toLowerCase() !== String(candidateSha).toLowerCase()) {
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
));
      if (inline) return inline[1].split(',').map((v) => unquote(v)).filter(Boolean);
      if (new RegExp('^\\s{4}' + key + '\\s*:\\s*
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

  if (executor === 'github_dev' && contract.mode === 'stateful') {
    const inputs = workflowDispatchInputNames(text);
    for (const required of ['candidate_sha', 'ci_run_id', 'ci_artifact', 'pipeline_run_id']) {
      if (!inputs.has(required)) issues.push(`missing workflow_dispatch input: ${required}`);
    }
    const runName = rootValue(text, 'run-name') ?? '';
    if (!/inputs\.pipeline_run_id/.test(runName) || !/inputs\.candidate_sha/.test(runName)) issues.push('stateful DEV run-name must include inputs.pipeline_run_id and inputs.candidate_sha');
    const environment = jobEnvironment(terminal);
    if (environment !== contract.environment) issues.push(`terminal job environment must equal ${contract.environment}`);
    if (!/inputs\.ci_run_id/.test(text) || !/inputs\.ci_artifact/.test(text)) issues.push('stateful DEV must consume source CI run/artifact inputs');
    if (!/(actions\/download-artifact|gh\s+run\s+download)/.test(text)) issues.push('stateful DEV must download the source CI artifact');
    if (!/actions\/upload-artifact/.test(text) || !text.includes(contract.artifact) || !text.includes(contract.evidence_file)) issues.push('stateful DEV must upload the declared DEV evidence artifact/file');
    if (/actions\/checkout[\s\S]{0,500}ref:\s*\$\{\{\s*inputs\.candidate_sha\s*\}\}/m.test(text)) issues.push('stateful DEV must not checkout candidate source');
  }

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

export function selectStatefulWorkflowRun(runs, { trustedRef, event = 'workflow_dispatch', correlation, candidateSha, excludeIds = [] }) {
  if (!Array.isArray(runs)) throw new GithubActionsGateError('workflow runs must be an array');
  const excluded = new Set(excludeIds.map((value) => Number(value)));
  const shortSha = String(candidateSha ?? '').slice(0, 12);
  const matches = runs.filter((run) => {
    const title = String(run?.display_title ?? run?.name ?? '');
    return !excluded.has(Number(run?.id)) && run?.head_branch === trustedRef && run?.event === event &&
      (!correlation || title.includes(correlation)) &&
      (!candidateSha || title.includes(String(candidateSha)) || (shortSha && title.includes(shortSha)));
  });
  matches.sort((a, b) => Number(b?.id ?? 0) - Number(a?.id ?? 0));
  return matches[0];
}

export function validateDevEvidence(data, { candidateSha, ciRunId }) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new GithubActionsGateError('GITHUB_DEV_EVIDENCE_INVALID');
  if (data.status !== 'PASS') throw new GithubActionsGateError('GITHUB_DEV_EVIDENCE_FAILED');
  if (String(data.candidate_sha ?? '').toLowerCase() !== String(candidateSha).toLowerCase()) throw new GithubActionsGateError('GITHUB_DEV_EVIDENCE_CANDIDATE_MISMATCH');
  if (String(data.installed_sha ?? '').toLowerCase() !== String(candidateSha).toLowerCase()) throw new GithubActionsGateError('GITHUB_DEV_EVIDENCE_INSTALLED_SHA_MISMATCH');
  if (Number(data.ci_run_id) !== Number(ciRunId)) throw new GithubActionsGateError('GITHUB_DEV_EVIDENCE_CI_RUN_MISMATCH');
  return { status: 'PASS', candidate_sha: data.candidate_sha, installed_sha: data.installed_sha, ci_run_id: Number(data.ci_run_id), smoke_result: data.smoke_result ?? null };
}
export function validateWorkflowResult({ run, jobs, artifacts, contract, candidateSha, terminalJobName, executor, sourceCiRunId }) {
  assertGithubGateContract(contract, executor);
  if (!run) throw new GithubActionsGateError('GITHUB_RUN_NOT_FOUND');
  if (executor === 'github_dev' && contract.mode === 'stateful') {
    if (run.head_branch !== contract.trusted_ref) throw new GithubActionsGateError('GITHUB_DEV_TRUSTED_REF_MISMATCH');
  } else if (String(run.head_sha ?? '').toLowerCase() !== String(candidateSha).toLowerCase()) {
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
).test(block[i])) {
        const values = [];
        for (let j = i + 1; j < block.length; j += 1) {
          const item = block[j].match(/^\s{6}-\s*(.+?)\s*$/);
          if (!item) break;
          values.push(unquote(item[1]));
        }
        return values;
      }
    }
    return [];
  };
  return { branches: readList('branches'), ignore: readList('branches-ignore') };
}

function globMatches(value, pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') { source += '.*'; i += 1; continue; }
    if (ch === '*') { source += '[^/]*'; continue; }
    if (ch === '?') { source += '[^/]'; continue; }
    source += ch.replace(/[\\^$.*+?()[\]{}|]/g, '\\export function inspectWorkflowText(text, contract, executor = 'github_ci', context = {}) {');
  }
  return new RegExp('^' + source + '
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

  if (executor === 'github_dev' && contract.mode === 'stateful') {
    const inputs = workflowDispatchInputNames(text);
    for (const required of ['candidate_sha', 'ci_run_id', 'ci_artifact', 'pipeline_run_id']) {
      if (!inputs.has(required)) issues.push(`missing workflow_dispatch input: ${required}`);
    }
    const runName = rootValue(text, 'run-name') ?? '';
    if (!/inputs\.pipeline_run_id/.test(runName) || !/inputs\.candidate_sha/.test(runName)) issues.push('stateful DEV run-name must include inputs.pipeline_run_id and inputs.candidate_sha');
    const environment = jobEnvironment(terminal);
    if (environment !== contract.environment) issues.push(`terminal job environment must equal ${contract.environment}`);
    if (!/inputs\.ci_run_id/.test(text) || !/inputs\.ci_artifact/.test(text)) issues.push('stateful DEV must consume source CI run/artifact inputs');
    if (!/(actions\/download-artifact|gh\s+run\s+download)/.test(text)) issues.push('stateful DEV must download the source CI artifact');
    if (!/actions\/upload-artifact/.test(text) || !text.includes(contract.artifact) || !text.includes(contract.evidence_file)) issues.push('stateful DEV must upload the declared DEV evidence artifact/file');
    if (/actions\/checkout[\s\S]{0,500}ref:\s*\$\{\{\s*inputs\.candidate_sha\s*\}\}/m.test(text)) issues.push('stateful DEV must not checkout candidate source');
  }

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

export function selectStatefulWorkflowRun(runs, { trustedRef, event = 'workflow_dispatch', correlation, candidateSha, excludeIds = [] }) {
  if (!Array.isArray(runs)) throw new GithubActionsGateError('workflow runs must be an array');
  const excluded = new Set(excludeIds.map((value) => Number(value)));
  const shortSha = String(candidateSha ?? '').slice(0, 12);
  const matches = runs.filter((run) => {
    const title = String(run?.display_title ?? run?.name ?? '');
    return !excluded.has(Number(run?.id)) && run?.head_branch === trustedRef && run?.event === event &&
      (!correlation || title.includes(correlation)) &&
      (!candidateSha || title.includes(String(candidateSha)) || (shortSha && title.includes(shortSha)));
  });
  matches.sort((a, b) => Number(b?.id ?? 0) - Number(a?.id ?? 0));
  return matches[0];
}

export function validateDevEvidence(data, { candidateSha, ciRunId }) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new GithubActionsGateError('GITHUB_DEV_EVIDENCE_INVALID');
  if (data.status !== 'PASS') throw new GithubActionsGateError('GITHUB_DEV_EVIDENCE_FAILED');
  if (String(data.candidate_sha ?? '').toLowerCase() !== String(candidateSha).toLowerCase()) throw new GithubActionsGateError('GITHUB_DEV_EVIDENCE_CANDIDATE_MISMATCH');
  if (String(data.installed_sha ?? '').toLowerCase() !== String(candidateSha).toLowerCase()) throw new GithubActionsGateError('GITHUB_DEV_EVIDENCE_INSTALLED_SHA_MISMATCH');
  if (Number(data.ci_run_id) !== Number(ciRunId)) throw new GithubActionsGateError('GITHUB_DEV_EVIDENCE_CI_RUN_MISMATCH');
  return { status: 'PASS', candidate_sha: data.candidate_sha, installed_sha: data.installed_sha, ci_run_id: Number(data.ci_run_id), smoke_result: data.smoke_result ?? null };
}
export function validateWorkflowResult({ run, jobs, artifacts, contract, candidateSha, terminalJobName, executor, sourceCiRunId }) {
  assertGithubGateContract(contract, executor);
  if (!run) throw new GithubActionsGateError('GITHUB_RUN_NOT_FOUND');
  if (executor === 'github_dev' && contract.mode === 'stateful') {
    if (run.head_branch !== contract.trusted_ref) throw new GithubActionsGateError('GITHUB_DEV_TRUSTED_REF_MISMATCH');
  } else if (String(run.head_sha ?? '').toLowerCase() !== String(candidateSha).toLowerCase()) {
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
).test(value);
}

function pushAcceptsBranch(text, branch) {
  if (!branch) return true;
  const rules = eventBranchRules(text, 'push');
  if (rules.ignore.some((pattern) => globMatches(branch, pattern))) return false;
  if (!rules.branches.length) return true;
  return rules.branches.some((pattern) => globMatches(branch, pattern));
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

  if (executor === 'github_dev' && contract.mode === 'stateful') {
    const inputs = workflowDispatchInputNames(text);
    for (const required of ['candidate_sha', 'ci_run_id', 'ci_artifact', 'pipeline_run_id']) {
      if (!inputs.has(required)) issues.push(`missing workflow_dispatch input: ${required}`);
    }
    const runName = rootValue(text, 'run-name') ?? '';
    if (!/inputs\.pipeline_run_id/.test(runName) || !/inputs\.candidate_sha/.test(runName)) issues.push('stateful DEV run-name must include inputs.pipeline_run_id and inputs.candidate_sha');
    const environment = jobEnvironment(terminal);
    if (environment !== contract.environment) issues.push(`terminal job environment must equal ${contract.environment}`);
    if (!/inputs\.ci_run_id/.test(text) || !/inputs\.ci_artifact/.test(text)) issues.push('stateful DEV must consume source CI run/artifact inputs');
    if (!/(actions\/download-artifact|gh\s+run\s+download)/.test(text)) issues.push('stateful DEV must download the source CI artifact');
    if (!/actions\/upload-artifact/.test(text) || !text.includes(contract.artifact) || !text.includes(contract.evidence_file)) issues.push('stateful DEV must upload the declared DEV evidence artifact/file');
    if (/actions\/checkout[\s\S]{0,500}ref:\s*\$\{\{\s*inputs\.candidate_sha\s*\}\}/m.test(text)) issues.push('stateful DEV must not checkout candidate source');
  }

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

export function selectStatefulWorkflowRun(runs, { trustedRef, event = 'workflow_dispatch', correlation, candidateSha, excludeIds = [] }) {
  if (!Array.isArray(runs)) throw new GithubActionsGateError('workflow runs must be an array');
  const excluded = new Set(excludeIds.map((value) => Number(value)));
  const shortSha = String(candidateSha ?? '').slice(0, 12);
  const matches = runs.filter((run) => {
    const title = String(run?.display_title ?? run?.name ?? '');
    return !excluded.has(Number(run?.id)) && run?.head_branch === trustedRef && run?.event === event &&
      (!correlation || title.includes(correlation)) &&
      (!candidateSha || title.includes(String(candidateSha)) || (shortSha && title.includes(shortSha)));
  });
  matches.sort((a, b) => Number(b?.id ?? 0) - Number(a?.id ?? 0));
  return matches[0];
}

export function validateDevEvidence(data, { candidateSha, ciRunId }) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new GithubActionsGateError('GITHUB_DEV_EVIDENCE_INVALID');
  if (data.status !== 'PASS') throw new GithubActionsGateError('GITHUB_DEV_EVIDENCE_FAILED');
  if (String(data.candidate_sha ?? '').toLowerCase() !== String(candidateSha).toLowerCase()) throw new GithubActionsGateError('GITHUB_DEV_EVIDENCE_CANDIDATE_MISMATCH');
  if (String(data.installed_sha ?? '').toLowerCase() !== String(candidateSha).toLowerCase()) throw new GithubActionsGateError('GITHUB_DEV_EVIDENCE_INSTALLED_SHA_MISMATCH');
  if (Number(data.ci_run_id) !== Number(ciRunId)) throw new GithubActionsGateError('GITHUB_DEV_EVIDENCE_CI_RUN_MISMATCH');
  return { status: 'PASS', candidate_sha: data.candidate_sha, installed_sha: data.installed_sha, ci_run_id: Number(data.ci_run_id), smoke_result: data.smoke_result ?? null };
}
export function validateWorkflowResult({ run, jobs, artifacts, contract, candidateSha, terminalJobName, executor, sourceCiRunId }) {
  assertGithubGateContract(contract, executor);
  if (!run) throw new GithubActionsGateError('GITHUB_RUN_NOT_FOUND');
  if (executor === 'github_dev' && contract.mode === 'stateful') {
    if (run.head_branch !== contract.trusted_ref) throw new GithubActionsGateError('GITHUB_DEV_TRUSTED_REF_MISMATCH');
  } else if (String(run.head_sha ?? '').toLowerCase() !== String(candidateSha).toLowerCase()) {
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
