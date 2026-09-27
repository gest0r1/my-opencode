import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const RUN_ID = /^[A-Za-z0-9._-]+$/;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SAFE_WORKFLOW = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/i;
const JOB_ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

class DeploymentTargetError extends Error {}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function writeJsonAtomic(file: string, value: unknown): Promise<string> {
  await mkdir(dirname(file), { recursive: true });
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const temp = `${file}.tmp-${process.pid}`;
  await writeFile(temp, content, 'utf8');
  await rename(temp, file);
  return sha256(content);
}

function command(exe: string, args: string[]): string {
  const result = spawnSync(exe, args, {
    shell: false,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error?.code === 'ENOENT') throw new DeploymentTargetError(`${exe.toUpperCase()}_EXECUTABLE_NOT_FOUND`);
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || result.status).trim().replace(/\s+/g, ' ').slice(0, 700);
    throw new DeploymentTargetError(`${exe} command failed: ${detail}`);
  }
  return String(result.stdout ?? '');
}

function ghJson(args: string[]): any {
  const raw = command('gh', args);
  try { return JSON.parse(raw); }
  catch { throw new DeploymentTargetError('GH_INVALID_JSON'); }
}

function parseRepository(remote: string): string {
  const value = remote.trim();
  const ssh = value.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (ssh?.[1]) return ssh[1];
  const https = value.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (https?.[1]) return https[1];
  throw new DeploymentTargetError('ORIGIN_IS_NOT_GITHUB');
}

function repository(): string {
  return parseRepository(command('git', ['remote', 'get-url', 'origin']));
}

function validateTarget(target: any): any {
  if (!target || target.kind !== 'opencode_host') {
    throw new DeploymentTargetError('OPENCODE_HOST_TARGET_REQUIRED');
  }
  if (!['github_ssh', 'self_hosted_runner'].includes(target.transport)) {
    throw new DeploymentTargetError('OPENCODE_HOST_TRANSPORT_INVALID');
  }
  if (typeof target.environment !== 'string' || !target.environment.trim()) {
    throw new DeploymentTargetError('OPENCODE_HOST_ENVIRONMENT_REQUIRED');
  }
  if (typeof target.probe_workflow !== 'string' || !SAFE_WORKFLOW.test(target.probe_workflow)) {
    throw new DeploymentTargetError('OPENCODE_HOST_PROBE_WORKFLOW_INVALID');
  }
  if (typeof target.probe_job !== 'string' || !JOB_ID.test(target.probe_job)) {
    throw new DeploymentTargetError('OPENCODE_HOST_PROBE_JOB_INVALID');
  }
  if (typeof target.trusted_ref !== 'string' || !SAFE_REF.test(target.trusted_ref) ||
      target.trusted_ref.includes('..') || target.trusted_ref.endsWith('/')) {
    throw new DeploymentTargetError('OPENCODE_HOST_TRUSTED_REF_INVALID');
  }
  const timeout = target.probe_timeout_seconds ?? 180;
  if (!Number.isInteger(timeout) || timeout < 30 || timeout > 900) {
    throw new DeploymentTargetError('OPENCODE_HOST_PROBE_TIMEOUT_INVALID');
  }
  const secrets = target.required_environment_secrets ?? [];
  if (!Array.isArray(secrets) || secrets.some((name: unknown) => typeof name !== 'string' || !SECRET_NAME.test(name)) ||
      new Set(secrets).size !== secrets.length) {
    throw new DeploymentTargetError('OPENCODE_HOST_SECRET_NAMES_INVALID');
  }
  if (target.transport === 'github_ssh' && secrets.length === 0) {
    throw new DeploymentTargetError('OPENCODE_HOST_SSH_SECRETS_REQUIRED');
  }
  const labels = target.runner_labels ?? [];
  if (!Array.isArray(labels) || labels.some((label: unknown) => typeof label !== 'string' || !String(label).trim())) {
    throw new DeploymentTargetError('OPENCODE_HOST_RUNNER_LABELS_INVALID');
  }
  if (target.transport === 'self_hosted_runner' && labels.length === 0) {
    throw new DeploymentTargetError('OPENCODE_HOST_RUNNER_LABELS_REQUIRED');
  }
  return { ...target, probe_timeout_seconds: timeout, required_environment_secrets: secrets, runner_labels: labels };
}

function globMatch(pattern: string, value: string): boolean {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') { source += '.*'; index += 1; }
      else source += '[^/]*';
    } else if (char === '?') source += '[^/]';
    else source += /[\\^$.*+?()[\]{}|]/.test(char) ? '\\' + char : char;
  }
  return new RegExp(source + '$').test(value);
}

function validateEnvironment(repo: string, target: any): Record<string, unknown> {
  const environment = ghJson(['api', `repos/${repo}/environments/${encodeURIComponent(target.environment)}`]);
  const branchPolicy = environment?.deployment_branch_policy;
  if (!branchPolicy ||
      (branchPolicy.protected_branches !== true && branchPolicy.custom_branch_policies !== true)) {
    throw new DeploymentTargetError('OPENCODE_HOST_ENVIRONMENT_BRANCH_RESTRICTION_REQUIRED');
  }
  if (branchPolicy?.protected_branches === true) {
    const branch = ghJson(['api', `repos/${repo}/branches/${encodeURIComponent(target.trusted_ref)}`]);
    if (branch?.protected !== true) {
      throw new DeploymentTargetError(`OPENCODE_HOST_TRUSTED_REF_NOT_PROTECTED: ${target.trusted_ref}`);
    }
  }
  if (branchPolicy?.custom_branch_policies === true) {
    const policies = ghJson([
      'api',
      `repos/${repo}/environments/${encodeURIComponent(target.environment)}/deployment-branch-policies?per_page=100`,
    ])?.branch_policies ?? [];
    if (!policies.some((policy: any) => typeof policy?.name === 'string' && globMatch(policy.name, target.trusted_ref))) {
      throw new DeploymentTargetError(`OPENCODE_HOST_TRUSTED_REF_NOT_ALLOWED: ${target.trusted_ref}`);
    }
  }

  let secretNames: string[];
  try {
    const result = ghJson([
      'api',
      `repos/${repo}/environments/${encodeURIComponent(target.environment)}/secrets?per_page=100`,
    ]);
    secretNames = (result?.secrets ?? []).map((secret: any) => String(secret?.name ?? '')).filter(Boolean);
  } catch (error) {
    if (target.required_environment_secrets.length) {
      throw new DeploymentTargetError(
        `OPENCODE_HOST_ENVIRONMENT_SECRETS_UNREADABLE: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    secretNames = [];
  }
  const missingSecrets = target.required_environment_secrets.filter((name: string) => !secretNames.includes(name));
  if (missingSecrets.length) {
    throw new DeploymentTargetError(`OPENCODE_HOST_ENVIRONMENT_SECRETS_MISSING: ${missingSecrets.join(',')}`);
  }

  return {
    environment_id: environment?.id ?? null,
    environment: target.environment,
    trusted_ref: target.trusted_ref,
    required_secret_names: target.required_environment_secrets,
    configured_required_secret_names: target.required_environment_secrets.filter((name: string) => secretNames.includes(name)),
    deployment_branch_policy: branchPolicy ?? null,
  };
}

function workflowId(path: string): string {
  return basename(path);
}

function listRuns(repo: string, workflow: string, ref: string): any[] {
  return ghJson([
    'api',
    `repos/${repo}/actions/workflows/${encodeURIComponent(workflowId(workflow))}/runs?branch=${encodeURIComponent(ref)}&event=workflow_dispatch&per_page=100`,
  ])?.workflow_runs ?? [];
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function dispatchProbe(repo: string, runId: string, target: any): Promise<Record<string, unknown>> {
  const before = new Set(listRuns(repo, target.probe_workflow, target.trusted_ref).map((run) => Number(run.id)));
  command('gh', [
    'workflow', 'run', workflowId(target.probe_workflow),
    '--repo', repo,
    '--ref', target.trusted_ref,
    '-f', `pipeline_run_id=${runId}`,
  ]);

  const deadline = Date.now() + target.probe_timeout_seconds * 1000;
  while (Date.now() < deadline) {
    const runs = listRuns(repo, target.probe_workflow, target.trusted_ref)
      .filter((run) => !before.has(Number(run.id)))
      .sort((a, b) => Number(b.id) - Number(a.id));
    for (const run of runs) {
      const current = ghJson(['api', `repos/${repo}/actions/runs/${run.id}`]);
      if (current.status !== 'completed') continue;
      if (current.conclusion !== 'success') {
        throw new DeploymentTargetError(`OPENCODE_HOST_PROBE_FAILED: run=${current.id} conclusion=${String(current.conclusion)}`);
      }
      const jobs = ghJson(['api', `repos/${repo}/actions/runs/${current.id}/jobs?filter=latest&per_page=100`])?.jobs ?? [];
      const job = jobs.find((item: any) => item?.name === target.probe_job);
      if (!job) throw new DeploymentTargetError(`OPENCODE_HOST_PROBE_JOB_MISSING: ${target.probe_job}`);
      if (job.status !== 'completed' || job.conclusion !== 'success') {
        throw new DeploymentTargetError(
          `OPENCODE_HOST_PROBE_JOB_FAILED: ${target.probe_job} status=${String(job.status)} conclusion=${String(job.conclusion)}`,
        );
      }
      return {
        workflow: target.probe_workflow,
        workflow_run_id: current.id,
        run_attempt: current.run_attempt ?? 1,
        head_branch: current.head_branch,
        head_sha: current.head_sha,
        event: current.event,
        probe_job: target.probe_job,
        probe_job_id: job.id,
      };
    }
    await sleep(3000);
  }
  throw new DeploymentTargetError(`OPENCODE_HOST_PROBE_TIMEOUT: ${target.probe_workflow}`);
}

async function evaluate(runId: string, policyPath: string): Promise<Record<string, unknown>> {
  if (!RUN_ID.test(runId)) throw new DeploymentTargetError('INVALID_RUN_ID');
  let policy: any;
  try { policy = JSON.parse(await readFile(resolve(policyPath), 'utf8')); }
  catch (error) {
    throw new DeploymentTargetError(`DEPLOYMENT_POLICY_UNREADABLE: ${error instanceof Error ? error.message : String(error)}`);
  }
  const target = validateTarget(policy?.deployment_target);
  const repo = repository();
  const environment = validateEnvironment(repo, target);
  const probe = await dispatchProbe(repo, runId, target);

  return {
    status: 'READY',
    run_id: runId,
    policy: policyPath,
    repository: repo,
    checked_at: new Date().toISOString(),
    kind: 'opencode_host',
    transport: target.transport,
    environment: target.environment,
    trusted_ref: target.trusted_ref,
    runner_labels: target.runner_labels,
    ...environment,
    ...probe,
  };
}

async function inspect(runId: string, policyPath: string): Promise<Record<string, unknown>> {
  const evidence = await evaluate(runId, policyPath);
  const relative = 'planning/deployment-target.json';
  const file = resolve('.tmp', 'pipelines', runId, relative);
  const digest = await writeJsonAtomic(file, evidence);
  return { ...evidence, artifact: { path: relative, sha256: digest } };
}

async function check(runId: string, policyPath: string): Promise<Record<string, unknown>> {
  return evaluate(runId, policyPath);
}

async function main(args: string[]): Promise<void> {
  const [commandName, runId] = args;
  if (!['inspect', 'check'].includes(commandName ?? '') || !runId) {
    throw new DeploymentTargetError('usage: deployment-target-cli.ts inspect|check <run-id> [--policy <path>]');
  }
  const policy = option(args, '--policy') ?? '.opencode/pipeline-policy.json';
  const result = commandName === 'inspect' ? await inspect(runId, policy) : await check(runId, policy);
  console.log(JSON.stringify(result, null, 2));
}

export { check, inspect, validateTarget };

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`BLOCKED: deployment_target: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
