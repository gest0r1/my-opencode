import {
  parseWorkflowYaml,
  workflowEvents,
  workflowJob,
  workflowPermissions,
} from './github-workflow-yaml.mjs';

export class GithubActionsGateError extends Error {}

const SAFE_WORKFLOW = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/i;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SAFE_JSON_FILE = /^[A-Za-z0-9._-]+\.json$/;
const JOB_ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/i;
const READ_ONLY_PERMISSION = new Set(['read', 'none']);

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function stringArray(value) {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.map(String);
  return [String(value)];
}

function globToRegExp(pattern) {
  let output = '^';
  const special = /[\\^$.*+?()[\]{}|]/;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        output += '.*';
        index += 1;
      } else {
        output += '[^/]*';
      }
    } else if (char === '?') {
      output += '[^/]';
    } else {
      output += special.test(char) ? '\\' + char : char;
    }
  }
  return new RegExp(output + '$');
}

function pushConfig(workflow) {
  const on = workflow?.on;
  return object(on)?.push;
}

function pushAcceptsBranch(workflow, branch) {
  const push = pushConfig(workflow);
  if (push === undefined) return workflowEvents(workflow).includes('push');
  const config = object(push);
  if (!config) return true;
  if (config.paths !== undefined || config['paths-ignore'] !== undefined) return false;
  const branches = stringArray(config.branches);
  const ignored = stringArray(config['branches-ignore']);
  const matches = (pattern) => {
    try { return globToRegExp(pattern).test(branch); }
    catch { return false; }
  };
  return (branches.length === 0 || branches.some(matches)) && !ignored.some(matches);
}

function walk(value, visit, path = []) {
  visit(value, path);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visit, [...path, index]));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) walk(item, visit, [...path, key]);
  }
}

function actionPinIssues(workflow) {
  const issues = [];
  walk(workflow, (value, path) => {
    if (path[path.length - 1] !== 'uses' || typeof value !== 'string') return;
    const spec = value;
    if (spec.startsWith('./')) return;
    if (spec.startsWith('docker://')) {
      if (!/@sha256:[0-9a-f]{64}$/i.test(spec)) issues.push(`container action is not digest-pinned: ${spec}`);
      return;
    }
    const at = spec.lastIndexOf('@');
    const ref = at >= 0 ? spec.slice(at + 1) : '';
    if (!/^[0-9a-f]{40}$/i.test(ref)) issues.push(`action is not commit-SHA pinned: ${spec}`);
  });
  return issues;
}

function containsSecretReference(workflow) {
  let found = false;
  walk(workflow, (value) => {
    if (typeof value === 'string' && /\$\{\{\s*secrets\./.test(value)) found = true;
  });
  return found;
}

function containsSecretsInherit(workflow) {
  let found = false;
  walk(workflow, (value, path) => {
    if (path[path.length - 1] === 'secrets' && String(value) === 'inherit') found = true;
  });
  return found;
}

function containsContinueOnError(workflow) {
  let found = false;
  walk(workflow, (value, path) => {
    if (path[path.length - 1] === 'continue-on-error' && value === true) found = true;
  });
  return found;
}

function permissionIssues(value, label) {
  const permissions = workflowPermissions(value);
  if (!permissions) return [`${label} permissions must be explicit`];
  if (permissions['*']) {
    if (permissions['*'] === 'read-all') return [];
    return [`${label} permissions must be read-all or an explicit read-only map`];
  }
  const issues = [];
  for (const [scope, level] of Object.entries(permissions)) {
    if (!READ_ONLY_PERMISSION.has(level)) issues.push(`${label} permission must be read-only: ${scope}=${level}`);
  }
  return issues;
}

function jobDisplayName(job, jobId) {
  return typeof job?.name === 'string' && job.name.trim() ? job.name.trim() : jobId;
}

function workflowDispatchInputs(workflow) {
  const dispatch = object(object(workflow?.on)?.workflow_dispatch);
  const inputs = object(dispatch?.inputs);
  return inputs ? new Set(Object.keys(inputs)) : new Set();
}

function jobEnvironment(job) {
  if (typeof job?.environment === 'string') return job.environment;
  return typeof object(job?.environment)?.name === 'string' ? object(job.environment).name : undefined;
}

function actionSteps(workflow, actionPrefix) {
  const hits = [];
  const jobs = object(workflow?.jobs) ?? {};
  for (const [jobId, jobValue] of Object.entries(jobs)) {
    const job = object(jobValue);
    const steps = Array.isArray(job?.steps) ? job.steps : [];
    for (const stepValue of steps) {
      const step = object(stepValue);
      if (typeof step?.uses === 'string' && step.uses.startsWith(actionPrefix)) hits.push({ jobId, step });
    }
  }
  return hits;
}

function referencesInput(workflow, input) {
  let found = false;
  const needle = `inputs.${input}`;
  walk(workflow, (value) => {
    if (typeof value === 'string' && value.includes(needle)) found = true;
  });
  return found;
}

function statefulConcurrency(workflow) {
  const value = workflow?.concurrency;
  if (typeof value === 'string') return { group: value, cancelInProgress: undefined };
  const config = object(value);
  if (!config) return undefined;
  return {
    group: typeof config.group === 'string' ? config.group : undefined,
    cancelInProgress: config['cancel-in-progress'],
  };
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
  if (contract.required_jobs !== undefined &&
      (!Array.isArray(contract.required_jobs) || contract.required_jobs.length === 0 ||
       contract.required_jobs.some((job) => typeof job !== 'string' || !JOB_ID.test(job)) ||
       new Set(contract.required_jobs).size !== contract.required_jobs.length)) {
    throw new GithubActionsGateError('GITHUB_REQUIRED_JOBS_INVALID');
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
    if (contract.trigger !== 'workflow_dispatch') {
      throw new GithubActionsGateError('GITHUB_DEV_REQUIRES_DISPATCH');
    }
    if (typeof contract.artifact !== 'string' || !contract.artifact.trim()) {
      throw new GithubActionsGateError('GITHUB_DEV_EVIDENCE_ARTIFACT_REQUIRED');
    }
    if (typeof contract.evidence_file !== 'string' || !SAFE_JSON_FILE.test(contract.evidence_file)) {
      throw new GithubActionsGateError('GITHUB_DEV_EVIDENCE_FILE_INVALID');
    }
    if (contract.mode === 'stateful') {
      if (typeof contract.environment !== 'string' || !contract.environment.trim()) {
        throw new GithubActionsGateError('GITHUB_DEV_ENVIRONMENT_REQUIRED');
      }
      if (typeof contract.trusted_ref !== 'string' || !SAFE_REF.test(contract.trusted_ref) ||
          contract.trusted_ref.includes('..') || contract.trusted_ref.endsWith('/')) {
        throw new GithubActionsGateError('GITHUB_DEV_TRUSTED_REF_INVALID');
      }
      if (typeof contract.concurrency_group !== 'string' || !contract.concurrency_group.trim()) {
        throw new GithubActionsGateError('GITHUB_DEV_CONCURRENCY_GROUP_REQUIRED');
      }
    } else if (contract.trusted_ref !== undefined || contract.environment !== undefined ||
               contract.concurrency_group !== undefined) {
      throw new GithubActionsGateError('GITHUB_DISPOSABLE_DEV_MUST_NOT_USE_TRUSTED_ENVIRONMENT');
    }
  }
  return contract;
}

export function inspectWorkflowText(text, contract, executor = 'github_ci', context = {}) {
  assertGithubGateContract(contract, executor);
  let workflow;
  try { workflow = parseWorkflowYaml(text); }
  catch (error) {
    throw new GithubActionsGateError(`GITHUB_WORKFLOW_YAML_INVALID: ${error instanceof Error ? error.message : String(error)}`);
  }

  const issues = [];
  const events = workflowEvents(workflow);
  if (!events.includes(contract.trigger)) issues.push('missing trigger: ' + contract.trigger);
  if (executor === 'github_ci' && events.includes('pull_request_target')) {
    issues.push('pull_request_target is forbidden for candidate CI');
  }

  if (executor === 'github_ci') {
    issues.push(...permissionIssues(workflow.permissions, 'root'));
    for (const [jobId, jobValue] of Object.entries(object(workflow.jobs) ?? {})) {
      const job = object(jobValue);
      if (job?.permissions !== undefined) issues.push(...permissionIssues(job.permissions, `job ${jobId}`));
    }
  } else if (workflow.permissions === undefined) {
    issues.push('explicit root permissions are required');
  }

  if (containsSecretsInherit(workflow)) issues.push('secrets: inherit is forbidden in pipeline GitHub gates');
  if (containsContinueOnError(workflow)) issues.push('continue-on-error: true is forbidden in authoritative gates');
  for (const issue of actionPinIssues(workflow)) issues.push(issue);

  if (executor === 'github_ci' && containsSecretReference(workflow)) {
    issues.push('candidate CI must not reference repository/environment secrets');
  }

  if (executor === 'github_ci' && contract.trigger === 'push' && context.candidateBranch) {
    const push = object(object(workflow.on)?.push);
    if (push && (push.paths !== undefined || push['paths-ignore'] !== undefined)) {
      issues.push('authoritative candidate push CI must not use paths/paths-ignore filters');
    }
    if (!pushAcceptsBranch(workflow, context.candidateBranch)) {
      issues.push('push trigger does not include candidate branch: ' + context.candidateBranch);
    }
  }

  const terminal = workflowJob(workflow, contract.terminal_job);
  if (!terminal) issues.push('terminal job not found: ' + contract.terminal_job);
  const terminalJobName = jobDisplayName(terminal, contract.terminal_job);

  const requiredJobNames = [];
  for (const jobId of contract.required_jobs ?? []) {
    const job = workflowJob(workflow, jobId);
    if (!job) {
      issues.push('required job not found: ' + jobId);
      continue;
    }
    requiredJobNames.push(jobDisplayName(job, jobId));
  }

  if (contract.artifact) {
    const upload = actionSteps(workflow, 'actions/upload-artifact@').some(({ step }) => {
      const withArgs = object(step.with);
      return String(withArgs?.name ?? '') === contract.artifact;
    });
    if (!upload) issues.push('declared artifact is not uploaded: ' + contract.artifact);
  }

  if (executor === 'github_dev') {
    const inputs = workflowDispatchInputs(workflow);
    for (const required of ['candidate_sha', 'ci_run_id', 'ci_artifact', 'ci_artifact_digest', 'pipeline_run_id']) {
      if (!inputs.has(required)) issues.push('missing workflow_dispatch input: ' + required);
    }
    for (const required of ['ci_run_id', 'ci_artifact', 'ci_artifact_digest']) {
      if (!referencesInput(workflow, required)) issues.push('DEV must consume workflow input: ' + required);
    }
    if (actionSteps(workflow, 'actions/download-artifact@').length === 0 && !referencesInput(workflow, 'ci_run_id')) {
      issues.push('DEV must download the source CI artifact');
    }
    const devUpload = actionSteps(workflow, 'actions/upload-artifact@').some(({ step }) => {
      const withArgs = object(step.with);
      return String(withArgs?.name ?? '') === contract.artifact &&
        String(withArgs?.path ?? '').includes(contract.evidence_file);
    });
    if (!devUpload) issues.push('DEV must upload the declared evidence artifact/file');

    if (contract.mode === 'stateful') {
      const runName = String(workflow['run-name'] ?? '');
      if (!runName.includes('inputs.pipeline_run_id') || !runName.includes('inputs.candidate_sha')) {
        issues.push('stateful DEV run-name must include inputs.pipeline_run_id and inputs.candidate_sha');
      }
      const environment = jobEnvironment(terminal);
      if (environment !== contract.environment) issues.push('terminal job environment must equal ' + contract.environment);
      const concurrency = statefulConcurrency(workflow);
      if (!concurrency || concurrency.group !== contract.concurrency_group || concurrency.cancelInProgress !== false) {
        issues.push('stateful DEV concurrency must use frozen group with cancel-in-progress: false');
      }
      const candidateCheckout = actionSteps(workflow, 'actions/checkout@').some(({ step }) =>
        String(object(step.with)?.ref ?? '').includes('inputs.candidate_sha'));
      if (candidateCheckout) issues.push('stateful DEV must not checkout candidate source');
    } else if (containsSecretReference(workflow)) {
      issues.push('disposable DEV must not reference repository/environment secrets');
    }
  }

  return {
    status: issues.length ? 'INCOMPATIBLE' : 'READY',
    workflow: contract.workflow,
    trigger: contract.trigger,
    terminal_job: contract.terminal_job,
    terminal_job_name: terminalJobName,
    required_job_names: requiredJobNames,
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
    required_jobs: contract.required_jobs ?? [],
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

export function validateDevEvidence(data, { candidateSha, ciRunId, ciArtifactDigest }) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new GithubActionsGateError('GITHUB_DEV_EVIDENCE_INVALID');
  if (data.status !== 'PASS') throw new GithubActionsGateError('GITHUB_DEV_EVIDENCE_FAILED');
  if (String(data.candidate_sha ?? '').toLowerCase() !== String(candidateSha).toLowerCase()) throw new GithubActionsGateError('GITHUB_DEV_EVIDENCE_CANDIDATE_MISMATCH');
  if (String(data.installed_sha ?? '').toLowerCase() !== String(candidateSha).toLowerCase()) throw new GithubActionsGateError('GITHUB_DEV_EVIDENCE_INSTALLED_SHA_MISMATCH');
  if (Number(data.ci_run_id) !== Number(ciRunId)) throw new GithubActionsGateError('GITHUB_DEV_EVIDENCE_CI_RUN_MISMATCH');
  if (String(data.ci_artifact_digest ?? '').toLowerCase() !== String(ciArtifactDigest ?? '').toLowerCase()) {
    throw new GithubActionsGateError('GITHUB_DEV_EVIDENCE_ARTIFACT_DIGEST_MISMATCH');
  }
  return {
    status: 'PASS',
    candidate_sha: data.candidate_sha,
    installed_sha: data.installed_sha,
    ci_run_id: Number(data.ci_run_id),
    ci_artifact_digest: data.ci_artifact_digest,
    smoke_result: data.smoke_result ?? null,
  };
}

export function validateWorkflowResult({
  run,
  jobs,
  artifacts,
  contract,
  candidateSha,
  terminalJobName,
  requiredJobNames = [],
  executor,
  sourceCiRunId,
}) {
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
  const required = [...new Set([expectedJobName, ...requiredJobNames])];
  const jobIds = {};
  for (const name of required) {
    const job = (jobs ?? []).find((item) => item?.name === name);
    if (!job) throw new GithubActionsGateError(`GITHUB_REQUIRED_JOB_MISSING: ${name}`);
    if (job.status !== 'completed' || job.conclusion !== 'success') {
      throw new GithubActionsGateError(`GITHUB_REQUIRED_JOB_FAILED: ${name} status=${String(job.status)} conclusion=${String(job.conclusion)}`);
    }
    jobIds[name] = job.id;
  }

  let artifact;
  if (contract.artifact) {
    artifact = (artifacts ?? []).find((item) => item?.name === contract.artifact && item?.expired !== true);
    if (!artifact) throw new GithubActionsGateError(`GITHUB_ARTIFACT_MISSING: ${contract.artifact}`);
    if (!SHA256_DIGEST.test(String(artifact.digest ?? ''))) {
      throw new GithubActionsGateError(`GITHUB_ARTIFACT_DIGEST_MISSING: ${contract.artifact}`);
    }
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
    terminal_job_id: jobIds[expectedJobName],
    required_job_names: requiredJobNames,
    required_job_ids: jobIds,
    ...(contract.artifact ? {
      artifact: contract.artifact,
      artifact_id: artifact.id,
      artifact_digest: artifact.digest,
    } : {}),
    ...(sourceCiRunId ? { source_ci_run_id: sourceCiRunId } : {}),
  };
}
