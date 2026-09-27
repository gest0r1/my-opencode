import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import {
  GithubActionsGateError,
  assertGithubGateContract,
  classifyMissingWorkflow,
  inspectWorkflowText,
  selectStatefulWorkflowRun,
  selectWorkflowRun,
  validateDevEvidence,
  validateWorkflowResult,
} from './github-actions-gate-core.mjs';

type Executor = 'github_ci' | 'github_dev';
type GateContract = {
  workflow: string;
  terminal_job: string;
  trigger: 'push' | 'workflow_dispatch';
  artifact?: string;
  environment?: string;
  mode?: 'disposable' | 'stateful';
  source_ci_stage?: string;
  trusted_ref?: string;
  evidence_file?: string;
  bootstrap_required?: boolean;
  bootstrap_work_item_id?: string;
  timeout_seconds?: number;
};
type PipelineSpec = {
  id: string;
  stages: string[];
  executors?: Record<string, string>;
  github_gates?: Record<string, GateContract>;
};
type Manifest = {
  run_id: string;
  repository?: string;
  git_setup?: { branch?: string };
  pipelines: PipelineSpec[];
};
type Candidate = {
  status: string;
  branch: string;
  candidate_sha: string;
  remote_sha: string;
};
type State = {
  run_id: string;
  manifest_file?: string;
  manifest_sha256?: string;
};

const SHA = /^[0-9a-f]{40}$/i;
const DEFAULT_STATE_ROOT = '.tmp/pipelines';

class CliError extends Error {}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function has(args: string[], name: string): boolean {
  return args.includes(name);
}

function command(exe: string, args: string[], cwd = process.cwd()): string {
  const result = spawnSync(exe, args, {
    cwd,
    shell: false,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || result.status).trim().slice(0, 1000);
    throw new CliError(`${exe} ${args.join(' ')} failed: ${detail}`);
  }
  return String(result.stdout ?? '');
}

function ghJson(args: string[]): any {
  const raw = command('gh', args);
  try { return JSON.parse(raw); }
  catch { throw new CliError(`gh returned invalid JSON: ${raw.slice(0, 300)}`); }
}

function parseRepository(remote: string): string {
  const value = remote.trim();
  const ssh = value.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (ssh?.[1]) return ssh[1];
  const https = value.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (https?.[1]) return https[1];
  throw new CliError('origin is not a github.com repository');
}

function repository(manifest?: Manifest): string {
  if (manifest?.repository) return manifest.repository;
  return parseRepository(command('git', ['remote', 'get-url', 'origin']));
}

async function exists(path: string): Promise<boolean> {
  try { await access(path, constants.R_OK); return true; }
  catch { return false; }
}

async function loadRun(runId: string, stateRoot: string): Promise<{
  state: State;
  manifest: Manifest;
  runRoot: string;
  manifestFile: string;
}> {
  const stateDirectory = resolve(stateRoot, runId);
  const state = JSON.parse(await readFile(join(stateDirectory, 'state.json'), 'utf8')) as State;
  if (state.run_id !== runId || !state.manifest_file) throw new CliError('run state has no frozen manifest');
  const manifestFile = resolve(state.manifest_file);
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as Manifest;
  if (manifest.run_id !== runId) throw new CliError('manifest run_id mismatch');
  const runRoot = dirname(manifestFile);
  return { state, manifest, runRoot, manifestFile };
}

function resolveGate(manifest: Manifest, pipelineId: string, stage: string): {
  pipeline: PipelineSpec;
  executor: Executor;
  contract: GateContract;
} {
  const pipeline = manifest.pipelines.find((item) => item.id === pipelineId);
  if (!pipeline) throw new CliError(`pipeline not found: ${pipelineId}`);
  if (!pipeline.stages.includes(stage)) throw new CliError(`stage not found: ${pipelineId}/${stage}`);
  const executor = pipeline.executors?.[stage];
  if (executor !== 'github_ci' && executor !== 'github_dev') {
    throw new CliError(`stage executor is not a GitHub gate: ${pipelineId}/${stage}=${String(executor)}`);
  }
  const contract = pipeline.github_gates?.[stage];
  try { assertGithubGateContract(contract, executor); }
  catch (error) { throw new CliError(error instanceof Error ? error.message : String(error)); }
  return { pipeline, executor, contract: contract as GateContract };
}

async function inspectFile(contract: GateContract, executor: Executor, context: { candidateBranch?: string } = {}): Promise<any> {
  const workflow = resolve(contract.workflow);
  if (!(await exists(workflow))) return classifyMissingWorkflow(contract, executor);
  const text = await readFile(workflow, 'utf8');
  return inspectWorkflowText(text, contract, executor, context);
}

function probeActions(repo: string): { accessible: true; enabled?: boolean } {
  ghJson(['api', `repos/${repo}/actions/workflows?per_page=1`]);
  try {
    const permissions = ghJson(['api', `repos/${repo}/actions/permissions`]);
    return { accessible: true, enabled: permissions?.enabled !== false };
  } catch {
    // Repository-admin permission is not required for pipeline execution.
    // A successful workflows listing proves Actions API access; inability to read
    // the admin-only permissions endpoint must not create a false blocker.
    return { accessible: true };
  }
}

async function inspectCommand(args: string[]): Promise<void> {
  const workflow = args[1];
  const terminalJob = args[2];
  const trigger = (option(args, '--trigger') ?? 'push') as GateContract['trigger'];
  const executor = (option(args, '--executor') ?? 'github_ci') as Executor;
  const contract: GateContract = {
    workflow,
    terminal_job: terminalJob,
    trigger,
    ...(option(args, '--artifact') ? { artifact: option(args, '--artifact') } : {}),
    ...(option(args, '--mode') ? { mode: option(args, '--mode') as GateContract['mode'] } : {}),
    ...(option(args, '--source-ci-stage') ? { source_ci_stage: option(args, '--source-ci-stage') } : {}),
    ...(option(args, '--environment') ? { environment: option(args, '--environment') } : {}),
    ...(option(args, '--trusted-ref') ? { trusted_ref: option(args, '--trusted-ref') } : {}),
    ...(option(args, '--evidence-file') ? { evidence_file: option(args, '--evidence-file') } : {}),
  };
  try {
    const repo = repository();
    const actions = probeActions(repo);
    if (actions.enabled === false) {
      console.log(JSON.stringify({
        status: 'BLOCKED',
        repository: repo,
        workflow,
        terminal_job: terminalJob,
        reason: 'GITHUB_ACTIONS_DISABLED',
      }, null, 2));
      return;
    }
    const candidateBranch = command('git', ['branch', '--show-current']).trim() || undefined;
    const result = await inspectFile(contract, executor, { candidateBranch });
    console.log(JSON.stringify({ ...result, repository: repo, actions_accessible: true, candidate_branch: candidateBranch ?? null }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({
      status: 'BLOCKED',
      workflow,
      terminal_job: terminalJob,
      reason: error instanceof Error ? error.message : String(error),
    }, null, 2));
  }
}

async function validateCommand(runId: string, pipelineId: string, stage: string, stateRoot: string): Promise<any> {
  const { manifest } = await loadRun(runId, stateRoot);
  const { executor, contract } = resolveGate(manifest, pipelineId, stage);
  const result = await inspectFile(contract, executor, { candidateBranch: manifest.git_setup?.branch });
  if (result.status !== 'READY') {
    throw new CliError(`GITHUB_WORKFLOW_NOT_READY: ${result.status}: ${(result.issues ?? []).join('; ')}`);
  }
  return {
    status: 'PASS',
    gate: 'github_actions_validate',
    run_id: runId,
    pipeline_id: pipelineId,
    stage,
    executor,
    ...result,
  };
}

async function readCandidate(runRoot: string, manifest: Manifest): Promise<Candidate> {
  const candidate = JSON.parse(await readFile(join(runRoot, 'candidate.json'), 'utf8')) as Candidate;
  if (candidate.status !== 'PASS' || !SHA.test(candidate.candidate_sha) || !SHA.test(candidate.remote_sha)) {
    throw new CliError('candidate evidence is missing or invalid');
  }
  if (candidate.candidate_sha.toLowerCase() !== candidate.remote_sha.toLowerCase()) {
    throw new CliError('candidate SHA does not match remote SHA');
  }
  if (manifest.git_setup?.branch && candidate.branch !== manifest.git_setup.branch) {
    throw new CliError('candidate branch does not match frozen manifest');
  }
  return candidate;
}

async function sourceCiEvidence(runRoot: string, pipelineId: string, contract: GateContract, candidateSha: string): Promise<any> {
  if (!contract.source_ci_stage) return undefined;
  const path = join(runRoot, 'github', `${pipelineId}-${contract.source_ci_stage}.json`);
  const evidence = JSON.parse(await readFile(path, 'utf8'));
  if (evidence.status !== 'PASS' || String(evidence.candidate_sha).toLowerCase() !== candidateSha.toLowerCase()) {
    throw new CliError('source CI evidence is missing, failed or belongs to another candidate SHA');
  }
  return evidence;
}

function workflowId(path: string): string {
  return basename(path);
}

function listRuns(repo: string, workflow: string, branch: string): any[] {
  const endpoint = `repos/${repo}/actions/workflows/${encodeURIComponent(workflowId(workflow))}/runs?branch=${encodeURIComponent(branch)}&per_page=100`;
  return ghJson(['api', endpoint])?.workflow_runs ?? [];
}

function fetchRun(repo: string, id: number): any {
  return ghJson(['api', `repos/${repo}/actions/runs/${id}`]);
}

function fetchJobs(repo: string, id: number): any[] {
  return ghJson(['api', `repos/${repo}/actions/runs/${id}/jobs?filter=latest&per_page=100`])?.jobs ?? [];
}

function fetchArtifacts(repo: string, id: number): any[] {
  return ghJson(['api', `repos/${repo}/actions/runs/${id}/artifacts?per_page=100`])?.artifacts ?? [];
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitForRun(
  repo: string,
  runId: string,
  pipeline: PipelineSpec,
  contract: GateContract,
  candidate: Candidate,
  sourceCi: any,
): Promise<any> {
  const timeoutMs = (contract.timeout_seconds ?? 900) * 1000;
  const pollMs = Math.max(250, Number(process.env.GITHUB_ACTIONS_GATE_POLL_MS ?? 5000));
  const deadline = Date.now() + timeoutMs;

  if (contract.mode === 'stateful') {
    if (!contract.trusted_ref || !contract.source_ci_stage) throw new CliError('stateful DEV trusted/source contract is missing');
    const sourceContract = pipeline.github_gates?.[contract.source_ci_stage];
    if (!sourceContract?.artifact) throw new CliError('stateful DEV source CI artifact contract is missing');
    const before = listRuns(repo, contract.workflow, contract.trusted_ref).map((item) => Number(item.id));
    command('gh', [
      'workflow', 'run', workflowId(contract.workflow),
      '--repo', repo,
      '--ref', contract.trusted_ref,
      '-f', `candidate_sha=${candidate.candidate_sha}`,
      '-f', `ci_run_id=${sourceCi.workflow_run_id}`,
      '-f', `ci_artifact=${sourceContract.artifact}`,
      '-f', `pipeline_run_id=${runId}`,
    ]);
    while (Date.now() < deadline) {
      const selected = selectStatefulWorkflowRun(
        listRuns(repo, contract.workflow, contract.trusted_ref),
        {
          trustedRef: contract.trusted_ref,
          correlation: runId,
          candidateSha: candidate.candidate_sha,
          excludeIds: before,
        },
      );
      if (selected) {
        const current = fetchRun(repo, Number(selected.id));
        if (current.status === 'completed') return current;
      }
      await sleep(pollMs);
    }
    throw new CliError(`GITHUB_DEV_RUN_TIMEOUT: workflow=${contract.workflow} sha=${candidate.candidate_sha}`);
  }

  if (contract.trigger === 'workflow_dispatch') {
    const dispatchArgs = [
      'workflow', 'run', workflowId(contract.workflow),
      '--repo', repo,
      '--ref', candidate.branch,
      '-f', 'candidate_sha=' + candidate.candidate_sha,
    ];
    if (contract.mode === 'disposable') {
      if (!sourceCi || !contract.source_ci_stage) throw new CliError('disposable DEV source CI evidence is missing');
      const sourceContract = pipeline.github_gates?.[contract.source_ci_stage];
      if (!sourceContract?.artifact) throw new CliError('disposable DEV source CI artifact contract is missing');
      dispatchArgs.push(
        '-f', 'ci_run_id=' + sourceCi.workflow_run_id,
        '-f', 'ci_artifact=' + sourceContract.artifact,
        '-f', 'pipeline_run_id=' + runId,
      );
    }
    command('gh', dispatchArgs);
  }

  while (Date.now() < deadline) {
    const selected = selectWorkflowRun(listRuns(repo, contract.workflow, candidate.branch), {
      candidateSha: candidate.candidate_sha,
      branch: candidate.branch,
      event: contract.trigger,
    });
    if (selected) {
      const current = fetchRun(repo, Number(selected.id));
      if (current.status === 'completed') return current;
    }
    await sleep(pollMs);
  }
  throw new CliError(`GITHUB_RUN_TIMEOUT: workflow=${contract.workflow} sha=${candidate.candidate_sha}`);
}

async function verifyDevEvidence(
  repo: string,
  run: any,
  contract: GateContract,
  candidateSha: string,
  sourceCiRunId: number,
): Promise<any> {
  if (!contract.artifact || !contract.evidence_file) throw new CliError('DEV evidence contract is missing');
  const directory = await mkdtemp(join(tmpdir(), 'pipeline-dev-evidence-'));
  try {
    command('gh', [
      'run', 'download', String(run.id),
      '--repo', repo,
      '--name', contract.artifact,
      '--dir', directory,
    ]);
    const file = join(directory, contract.evidence_file);
    const data = JSON.parse(await readFile(file, 'utf8'));
    try {
      return validateDevEvidence(data, { candidateSha, ciRunId: sourceCiRunId });
    } catch (error) {
      throw new CliError(error instanceof Error ? error.message : String(error));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runGate(runId: string, pipelineId: string, stage: string, stateRoot: string): Promise<any> {
  const { manifest, runRoot } = await loadRun(runId, stateRoot);
  const { executor, contract } = resolveGate(manifest, pipelineId, stage);
  const validation = await inspectFile(contract, executor, { candidateBranch: manifest.git_setup?.branch });
  if (validation.status !== 'READY') {
    throw new CliError(`GITHUB_WORKFLOW_NOT_READY: ${validation.status}: ${(validation.issues ?? []).join('; ')}`);
  }

  const candidate = await readCandidate(runRoot, manifest);
  const repo = repository(manifest);
  const sourceCi = executor === 'github_dev'
    ? await sourceCiEvidence(runRoot, pipelineId, contract, candidate.candidate_sha)
    : undefined;
  const run = await waitForRun(repo, runId, resolveGate(manifest, pipelineId, stage).pipeline, contract, candidate, sourceCi);
  const jobs = fetchJobs(repo, Number(run.id));
  const artifacts = fetchArtifacts(repo, Number(run.id));
  let result;
  try {
    result = validateWorkflowResult({
      run,
      jobs,
      artifacts,
      contract,
      candidateSha: candidate.candidate_sha,
      terminalJobName: validation.terminal_job_name,
      executor,
      sourceCiRunId: sourceCi?.workflow_run_id,
    });
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error));
  }

  const devEvidence = executor === 'github_dev'
    ? await verifyDevEvidence(
        repo,
        run,
        contract,
        candidate.candidate_sha,
        Number(sourceCi?.workflow_run_id),
      )
    : undefined;

  const evidence = {
    ...result,
    gate: 'github_actions',
    run_id: runId,
    pipeline_id: pipelineId,
    stage,
    executor,
    repository: repo,
    workflow: contract.workflow,
    branch: candidate.branch,
    environment: contract.environment ?? null,
    mode: contract.mode ?? null,
    trusted_ref: contract.trusted_ref ?? null,
    ...(devEvidence ? { dev_evidence_validated: true, installed_sha: devEvidence.installed_sha, smoke_result: devEvidence.smoke_result } : {}),
    recorded_at: new Date().toISOString(),
  };
  const evidenceFile = join(runRoot, 'github', `${pipelineId}-${stage}.json`);
  await mkdir(dirname(evidenceFile), { recursive: true });
  await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return { ...evidence, evidence: evidenceFile };
}

async function showCommand(runId: string, pipelineId: string, stage: string, stateRoot: string): Promise<void> {
  const { runRoot } = await loadRun(runId, stateRoot);
  const file = join(runRoot, 'github', `${pipelineId}-${stage}.json`);
  console.log(await readFile(file, 'utf8'));
}

function usage(): string {
  return [
    'usage:',
    '  github-actions-gate-cli.ts inspect <workflow> <terminal-job> [--trigger push|workflow_dispatch] [--artifact <name>] [--executor github_ci|github_dev] [--mode disposable|stateful] [--environment <name>] [--trusted-ref <ref>] [--evidence-file <file>]',
    '  github-actions-gate-cli.ts validate <run-id> <pipeline-id> <stage-id> [--state-root <path>]',
    '  github-actions-gate-cli.ts run <run-id> <pipeline-id> <stage-id> [--state-root <path>]',
    '  github-actions-gate-cli.ts show <run-id> <pipeline-id> <stage-id> [--state-root <path>]',
  ].join('\n');
}

async function main(args: string[]): Promise<void> {
  const commandName = args[0];
  if (commandName === 'inspect') {
    if (!args[1] || !args[2]) throw new CliError(usage());
    await inspectCommand(args);
    return;
  }
  const runId = args[1];
  const pipelineId = args[2];
  const stage = args[3];
  if (!runId || !pipelineId || !stage) throw new CliError(usage());
  const stateRoot = option(args, '--state-root') ?? DEFAULT_STATE_ROOT;
  if (commandName === 'validate') {
    console.log(JSON.stringify(await validateCommand(runId, pipelineId, stage, stateRoot), null, 2));
    return;
  }
  if (commandName === 'run') {
    console.log(JSON.stringify(await runGate(runId, pipelineId, stage, stateRoot), null, 2));
    return;
  }
  if (commandName === 'show') {
    await showCommand(runId, pipelineId, stage, stateRoot);
    return;
  }
  throw new CliError(usage());
}

export { inspectFile, resolveGate, validateCommand, runGate };

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`BLOCKED: github_actions_gate: ${message}`);
    process.exitCode = 1;
  });
}
