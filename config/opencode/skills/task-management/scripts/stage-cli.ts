import { dispatchPacket } from './pipeline-dispatch.ts';
import { candidateEvidenceMatches } from './github-actions-gate-core.mjs';
// Stable CLI entry point. Keep core stage/DAG/state implementation untouched and
// reject non-executable machine gates BEFORE init creates any state or approve mutates it.
export * from './stage-cli-core.ts';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { applyOwnerAmendment, runCli } from './stage-cli-core.ts';
import { prepareProjectTooling } from './project-tooling.mjs';
import { preflightFile } from './manifest-preflight.mjs';
import { freezeGateTesting } from './gate-testing-freeze.mjs';
import { runGenerator } from './generator-cli.mjs';
import { gitReadEnv } from './git-readonly.mjs';
import { validateOwnerAmendmentForApply } from './owner-amendment-policy.ts';

function stateRootFromArgs(args: string[]): string {
  const index = args.indexOf('--state-root');
  return index < 0 ? '.tmp/pipelines' : (args[index + 1] ?? '.tmp/pipelines');
}

function optionFromArgs(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

async function readJsonEvidence(path: string, label: string): Promise<any> {
  let raw: string;
  try { raw = await readFile(path, 'utf8'); }
  catch { throw new Error(`EVIDENCE_MISSING: ${label}: ${path}`); }
  try { return JSON.parse(raw); }
  catch { throw new Error(`EVIDENCE_INVALID_JSON: ${label}: ${path}`); }
}

function gitValue(args: string[]): string | undefined {
  const result = spawnSync('git', args, { shell: false, encoding: 'utf8', env: gitReadEnv() });
  if (result.status !== 0 || result.error) return undefined;
  return String(result.stdout ?? '').trim();
}

async function enforcePublishedEvidenceCurrent(args: string[]): Promise<void> {
  if (!['start', 'complete'].includes(args[0] ?? '')) return;
  const runId = args[1];
  const stage = args[2];
  const pipelineId = optionFromArgs(args, '--pipeline');
  if (!runId || !stage || !pipelineId) return;

  const stateRoot = resolve(stateRootFromArgs(args));
  let state: any;
  try { state = JSON.parse(await readFile(join(stateRoot, runId, 'state.json'), 'utf8')); }
  catch { return; }
  if (!state.manifest_file) return;

  const manifestFile = resolve(state.manifest_file);
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  if (manifest.schema_version !== 2) return;
  const targetPipeline = manifest.pipelines?.find((item: any) => item.id === pipelineId);
  const targetExecutor = targetPipeline?.executors?.[stage];
  if (targetExecutor !== 'github_ci' && targetExecutor !== 'github_dev' && targetExecutor !== 'owner_acceptance') {
    return;
  }

  const published = (manifest.pipelines ?? []).some((pipeline: any) =>
    (pipeline.stages ?? []).some((stage: string) =>
      pipeline.executors?.[stage] === 'git_publish' &&
      state.pipelines?.[pipeline.id]?.stages?.[stage]?.status === 'completed'));
  if (!published) return;

  const artifactRoot = dirname(manifestFile);
  const candidate = await readJsonEvidence(join(artifactRoot, 'candidate.json'), 'candidate');
  if (candidate.status !== 'PASS' ||
      String(candidate.candidate_sha ?? '').toLowerCase() !== String(candidate.remote_sha ?? '').toLowerCase()) {
    throw new Error('EVIDENCE_INVALID: published candidate is missing or remote SHA differs');
  }

  const gitHead = gitValue(['rev-parse', 'HEAD']);
  if (gitHead !== undefined) {
    const gitBranch = gitValue(['branch', '--show-current']);
    const dirty = gitValue(['status', '--porcelain', '--untracked-files=all']);
    if (String(gitHead).toLowerCase() !== String(candidate.candidate_sha).toLowerCase() ||
        gitBranch !== candidate.branch || dirty !== '') {
      throw new Error('CANDIDATE_STALE_SOURCE: working tree no longer equals published candidate; verify and publish a new candidate');
    }
  }

  for (const pipeline of manifest.pipelines ?? []) {
    if (pipeline.deployable !== true) continue;
    for (const stage of pipeline.stages ?? []) {
      const runtime = state.pipelines?.[pipeline.id]?.stages?.[stage];
      if (runtime?.status !== 'completed') continue;
      const executor = pipeline.executors?.[stage];
      if (executor !== 'github_ci' && executor !== 'github_dev') continue;

      const contract = pipeline.github_gates?.[stage];
      const evidence = await readJsonEvidence(
        join(artifactRoot, 'github', pipeline.id + '-' + stage + '.json'),
        pipeline.id + '/' + stage,
      );
      const common = evidence.status === 'PASS' &&
        evidence.run_id === runId &&
        evidence.pipeline_id === pipeline.id &&
        evidence.stage === stage &&
        evidence.executor === executor &&
        evidence.workflow === contract?.workflow &&
        evidence.terminal_job === contract?.terminal_job &&
        String(evidence.candidate_sha ?? '').toLowerCase() === String(candidate.candidate_sha).toLowerCase();
      if (!common) throw new Error('EVIDENCE_INVALID_OR_STALE: ' + executor + ' ' + pipeline.id + '/' + stage);

      if (executor === 'github_ci') {
        const artifactValid = !contract?.artifact ||
          (evidence.artifact === contract.artifact && /^sha256:[0-9a-f]{64}$/i.test(String(evidence.artifact_digest ?? '')));
        if (!candidateEvidenceMatches(evidence, contract, candidate.candidate_sha, manifest.repository, candidate.branch) || !artifactValid) {
          throw new Error('EVIDENCE_INVALID_OR_STALE: github_ci ' + pipeline.id + '/' + stage);
        }
        continue;
      }

      const sourceStage = contract?.source_ci_stage;
      const source = sourceStage
        ? await readJsonEvidence(join(artifactRoot, 'github', pipeline.id + '-' + sourceStage + '.json'), pipeline.id + '/' + sourceStage)
        : undefined;
      const requiresAutomatedPostDeploy =
        ['opencode_host', 'hybrid'].includes(String(pipeline.testing_strategy?.mode ?? '')) &&
        ['automated', 'automated_then_user'].includes(String(pipeline.testing_strategy?.post_deploy_test ?? ''));
      const sourceContract = sourceStage ? pipeline.github_gates?.[sourceStage] : undefined;
      const legacyArtifactValid = !sourceContract?.artifact ||
        (Number.isInteger(Number(source?.artifact_id)) &&
         Number(evidence.ci_artifact_id) === Number(source?.artifact_id) &&
         /^sha256:[0-9a-f]{64}$/i.test(String(source?.artifact_digest ?? '')) &&
         String(evidence.ci_artifact_digest ?? '').toLowerCase() === String(source?.artifact_digest ?? '').toLowerCase());
      const devCommon = evidence.dev_evidence_validated === true &&
        (!requiresAutomatedPostDeploy || evidence.smoke_result === 'PASS') &&
        (!contract?.target_id || evidence.target_id === contract.target_id) &&
        String(evidence.installed_sha ?? '').toLowerCase() === String(candidate.candidate_sha).toLowerCase() &&
        source?.status === 'PASS' &&
        String(source?.candidate_sha ?? '').toLowerCase() === String(candidate.candidate_sha).toLowerCase() &&
        Number.isInteger(Number(source?.workflow_run_id)) &&
        legacyArtifactValid &&
        Number(evidence.source_ci_run_id) === Number(source?.workflow_run_id);
      const devIdentity = contract?.mode === 'stateful'
        ? evidence.trusted_ref === contract?.trusted_ref &&
          String(evidence.head_branch ?? '').toLowerCase() === String(contract?.trusted_ref ?? '').toLowerCase()
        : String(evidence.head_sha ?? '').toLowerCase() === String(candidate.candidate_sha).toLowerCase();
      if (!devCommon || !devIdentity) {
        throw new Error('EVIDENCE_INVALID_OR_STALE: github_dev ' + pipeline.id + '/' + stage);
      }
    }
  }
}

async function rejectDirectOwnerAcceptanceTransition(args: string[]): Promise<void> {
  if (!['complete', 'fail', 'block', 'resume'].includes(args[0] ?? '')) return;
  const runId = args[1];
  const stage = args[2];
  const pipelineId = optionFromArgs(args, '--pipeline');
  if (!runId || !stage || !pipelineId) return;

  const stateRoot = resolve(stateRootFromArgs(args));
  let state: any;
  try { state = JSON.parse(await readFile(join(stateRoot, runId, 'state.json'), 'utf8')); }
  catch { return; }
  if (!state.manifest_file) return;
  const manifest = JSON.parse(await readFile(resolve(state.manifest_file), 'utf8'));
  const pipeline = manifest.pipelines?.find((item: any) => item.id === pipelineId);
  if (pipeline?.executors?.[stage] === 'owner_acceptance') {
    throw new Error(`OWNER_ACCEPTANCE_REQUIRES_EXPLICIT_OWNER_RESULT: ${pipelineId}/${stage}`);
  }
}

async function ownerAcceptance(args: string[]): Promise<boolean> {
  if (args[0] !== 'owner-accept') return false;
  const runId = args[1];
  const stage = args[2];
  const pipelineId = optionFromArgs(args, '--pipeline');
  const result = optionFromArgs(args, '--result');
  const message = optionFromArgs(args, '--message');
  if (!runId || !stage || !pipelineId || !['pass', 'fail'].includes(result ?? '')) {
    throw new Error('usage: stage-cli owner-accept <run-id> <stage> --pipeline <id> --result pass|fail [--message <text>]');
  }

  const stateRoot = resolve(stateRootFromArgs(args));
  const state = JSON.parse(await readFile(join(stateRoot, runId, 'state.json'), 'utf8'));
  if (!state.manifest_file) throw new Error('Frozen manifest is missing');
  const manifestFile = resolve(state.manifest_file);
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  const pipeline = manifest.pipelines?.find((item: any) => item.id === pipelineId);
  if (!pipeline || pipeline.executors?.[stage] !== 'owner_acceptance') {
    throw new Error(`OWNER_ACCEPTANCE_STAGE_REQUIRED: ${pipelineId}/${stage}`);
  }
  if (state.pipelines?.[pipelineId]?.stages?.[stage]?.status !== 'in_progress') {
    throw new Error(`OWNER_ACCEPTANCE_NOT_IN_PROGRESS: ${pipelineId}/${stage}`);
  }

  await enforcePublishedEvidenceCurrent(['complete', runId, stage, '--pipeline', pipelineId, '--state-root', stateRoot]);
  const evidencePath = join(dirname(manifestFile), 'owner', `${pipelineId}-${stage}.json`);
  await mkdir(dirname(evidencePath), { recursive: true });
  const evidence = {
    status: result === 'pass' ? 'PASS' : 'FAIL',
    gate: 'owner_acceptance',
    run_id: runId,
    pipeline_id: pipelineId,
    stage,
    message: message ?? null,
    recorded_at: new Date().toISOString(),
  };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

  const common = [runId, stage, '--pipeline', pipelineId, '--state-root', stateRoot, '--evidence', evidencePath];
  if (result === 'pass') await runCli(['complete', ...common, ...(message ? ['--message', message] : [])]);
  else await runCli(['block', ...common, ...(message ? ['--message', message] : [])]);
  return true;
}

async function enforceCompletionEvidence(args: string[]): Promise<string[]> {
  if (args[0] !== 'complete') return args;
  const runId = args[1];
  const stage = args[2];
  if (!runId || !stage) return args;

  const stateRoot = resolve(stateRootFromArgs(args));
  const state = JSON.parse(await readFile(join(stateRoot, runId, 'state.json'), 'utf8'));
  if (!state.manifest_file) return args;
  const manifestFile = resolve(state.manifest_file);
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  if (manifest.schema_version !== 2) return args;

  const requestedPipeline = optionFromArgs(args, '--pipeline');
  const pipeline = requestedPipeline
    ? manifest.pipelines?.find((item: any) => item.id === requestedPipeline)
    : manifest.pipelines?.length === 1 ? manifest.pipelines[0] : undefined;
  if (!pipeline) throw new Error('pipeline_id is required to enforce completion evidence');
  const executor = pipeline.executors?.[stage];
  if (!executor) throw new Error(`EXECUTOR_MISSING: ${pipeline.id}/${stage}`);

  const artifactRoot = dirname(manifestFile);
  let evidencePath: string | undefined;

  if (executor === 'owner_acceptance') {
    throw new Error(`OWNER_ACCEPTANCE_REQUIRES_EXPLICIT_OWNER_RESULT: ${pipeline.id}/${stage}`);
  } else if (executor === 'local_gate') {
    evidencePath = join(stateRoot, runId, 'gates', `${pipeline.id}-${stage}.json`);
    const evidence = await readJsonEvidence(evidencePath, `${pipeline.id}/${stage}`);
    if (evidence.status !== 'PASS' || evidence.run_id !== runId ||
        evidence.pipeline_id !== pipeline.id || evidence.gate !== stage) {
      throw new Error(`EVIDENCE_INVALID: local_gate ${pipeline.id}/${stage}`);
    }
    if (evidence.candidate_sha) {
      const candidate = await readJsonEvidence(join(artifactRoot, 'candidate.json'), 'candidate');
      if (candidate.status !== 'PASS' ||
          String(candidate.candidate_sha).toLowerCase() !== String(evidence.candidate_sha).toLowerCase()) {
        throw new Error(`EVIDENCE_STALE_SHA: local_gate ${pipeline.id}/${stage}`);
      }
    }
  } else if (executor === 'github_ci' || executor === 'github_dev') {
    evidencePath = join(artifactRoot, 'github', `${pipeline.id}-${stage}.json`);
    const evidence = await readJsonEvidence(evidencePath, `${pipeline.id}/${stage}`);
    const contract = pipeline.github_gates?.[stage];
    const candidate = await readJsonEvidence(join(artifactRoot, 'candidate.json'), 'candidate');
    if (candidate.status !== 'PASS' ||
        String(candidate.candidate_sha).toLowerCase() !== String(candidate.remote_sha).toLowerCase()) {
      throw new Error('EVIDENCE_INVALID: candidate SHA is not published');
    }
    const commonValid = evidence.status === 'PASS' && evidence.run_id === runId &&
      evidence.pipeline_id === pipeline.id && evidence.stage === stage &&
      evidence.executor === executor && evidence.workflow === contract?.workflow &&
      evidence.terminal_job === contract?.terminal_job &&
      String(evidence.candidate_sha).toLowerCase() === String(candidate.candidate_sha).toLowerCase();
    const requiresAutomatedPostDeploy =
      ['opencode_host', 'hybrid'].includes(String(pipeline.testing_strategy?.mode ?? '')) &&
      ['automated', 'automated_then_user'].includes(String(pipeline.testing_strategy?.post_deploy_test ?? ''));
    const executorSpecificValid = executor === 'github_dev'
      ? evidence.dev_evidence_validated === true &&
        (!requiresAutomatedPostDeploy || evidence.smoke_result === 'PASS') &&
        (!contract?.target_id || evidence.target_id === contract.target_id) &&
        String(evidence.installed_sha ?? '').toLowerCase() === String(candidate.candidate_sha).toLowerCase() &&
        (contract?.mode === 'stateful'
          ? evidence.trusted_ref === contract?.trusted_ref &&
            String(evidence.head_branch ?? '').toLowerCase() === String(contract?.trusted_ref ?? '').toLowerCase()
          : String(evidence.head_sha ?? '').toLowerCase() === String(candidate.candidate_sha).toLowerCase())
      : candidateEvidenceMatches(evidence, contract, candidate.candidate_sha, manifest.repository, candidate.branch) &&
        (!contract?.artifact ||
          (evidence.artifact === contract.artifact && /^sha256:[0-9a-f]{64}$/i.test(String(evidence.artifact_digest ?? ''))));
    if (!commonValid || !executorSpecificValid) {
      throw new Error(`EVIDENCE_INVALID_OR_STALE: ${executor} ${pipeline.id}/${stage}`);
    }
    if (executor === 'github_dev') {
      const sourceStage = contract?.source_ci_stage;
      if (!sourceStage) throw new Error(`EVIDENCE_INVALID: github_dev source_ci_stage missing`);
      const source = await readJsonEvidence(
        join(artifactRoot, 'github', `${pipeline.id}-${sourceStage}.json`),
        `${pipeline.id}/${sourceStage}`,
      );
      const sourceContract = pipeline.github_gates?.[sourceStage];
      const legacyArtifactValid = !sourceContract?.artifact ||
        (Number.isInteger(Number(source.artifact_id)) &&
         Number(evidence.ci_artifact_id) === Number(source.artifact_id) &&
         /^sha256:[0-9a-f]{64}$/i.test(String(source.artifact_digest ?? '')) &&
         String(evidence.ci_artifact_digest ?? '').toLowerCase() === String(source.artifact_digest ?? '').toLowerCase());
      if (source.status !== 'PASS' ||
          String(source.candidate_sha).toLowerCase() !== String(candidate.candidate_sha).toLowerCase() ||
          !Number.isInteger(Number(source.workflow_run_id)) ||
          !legacyArtifactValid ||
          Number(evidence.source_ci_run_id) !== Number(source.workflow_run_id)) {
        throw new Error(`EVIDENCE_INVALID_OR_STALE: github_dev source CI mismatch`);
      }
    }
  } else if (executor === 'git_verify') {
    evidencePath = join(artifactRoot, 'git-verify.json');
    const evidence = await readJsonEvidence(evidencePath, 'git_verify');
    const runtime = state.pipelines?.[pipeline.id]?.stages?.[stage];
    if (evidence.status !== 'PASS' || evidence.run_id !== runId ||
        evidence.branch !== manifest.git_setup?.branch ||
        !runtime?.started_at || !evidence.verified_at ||
        Date.parse(evidence.verified_at) < Date.parse(runtime.started_at)) {
      throw new Error(`EVIDENCE_INVALID_OR_STALE: git_verify ${pipeline.id}/${stage}`);
    }
  } else if (executor === 'git_publish') {
    evidencePath = join(artifactRoot, 'candidate.json');
    const candidate = await readJsonEvidence(evidencePath, 'candidate');
    const runtime = state.pipelines?.[pipeline.id]?.stages?.[stage];
    if (candidate.status !== 'PASS' ||
        candidate.run_id !== runId ||
        candidate.branch !== manifest.git_setup?.branch ||
        String(candidate.candidate_sha).toLowerCase() !== String(candidate.remote_sha).toLowerCase() ||
        !runtime?.started_at || !candidate.published_at ||
        Date.parse(candidate.published_at) < Date.parse(runtime.started_at)) {
      throw new Error('EVIDENCE_INVALID_OR_STALE: git_publish candidate is not verified for this stage');
    }
  }

  if (evidencePath && !args.includes('--evidence')) return [...args, '--evidence', evidencePath];
  return args;
}

async function main(args: string[]): Promise<void> {
  const [command, identifier] = args;
  if (command === 'dispatch') {
    if (!identifier) throw new Error('run-id is required');
    const allowed = new Set(['--pipeline', '--stage', '--work-item', '--role']);
    for (let i = 2; i < args.length; i++) {
      if (args[i] === '--json') continue;
      if (!allowed.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Invalid dispatch arguments');
      i++;
    }
    const packet = await dispatchPacket(process.cwd(), identifier, optionFromArgs(args, '--pipeline') ?? '', optionFromArgs(args, '--stage') ?? '', optionFromArgs(args, '--work-item') ?? '', optionFromArgs(args, '--role') ?? '');
    console.log(JSON.stringify(packet));
    return;
  }
  if (command === 'owner-accept') {
    await ownerAcceptance(args);
    return;
  }
  if (command === 'owner-amend-apply') {
    const stage = args[2];
    const pipelineId = optionFromArgs(args, '--pipeline');
    const evidence = optionFromArgs(args, '--evidence');
    if (!identifier || !stage || !pipelineId || !evidence) {
      throw new Error('usage: stage-cli owner-amend-apply <run-id> <owner-stage> --pipeline <id> --evidence <owner-amendment.json>');
    }
    const stateRoot = resolve(stateRootFromArgs(args));
    const validated = await validateOwnerAmendmentForApply({
      stateRoot,
      runId: identifier,
      pipelineId,
      sourceStage: stage,
      evidencePath: evidence,
    });
    const state = await applyOwnerAmendment(
      stateRoot,
      identifier,
      stage,
      validated.absoluteEvidencePath,
      pipelineId,
    );
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  if (command === 'prepare-environment') {
    if (!identifier || args.length !== 2) throw new Error('usage: stage-cli prepare-environment <manifest.json>');
    await preflightFile(resolve(identifier));
    const tooling = prepareProjectTooling(process.cwd());
    const preflight = await preflightFile(resolve(identifier), { environment: true });
    console.log(JSON.stringify({tooling, preflight}));
    return;
  }
  if (command === 'generate') {
    const id = args[2];
    const extra = args.slice(3);
    const unknown = extra.filter((arg, index) => arg !== '--check-only' && arg !== '--state-root' && extra[index - 1] !== '--state-root');
    if (!identifier || !id || unknown.length) {
      throw new Error('usage: stage-cli generate <run-id> <generator-id> [--check-only]');
    }
    const result = runGenerator({ stateRoot: resolve(stateRootFromArgs(args)), runId: identifier, id, checkOnly: args.includes('--check-only') });
    console.log(JSON.stringify(result));
    if (result.status !== 'PASS') process.exitCode = 1;
    return;
  }
  if (command === 'gate-testing-freeze') {
    const profile = optionFromArgs(args, '--profile');
    const gate = optionFromArgs(args, '--gate');
    const source = optionFromArgs(args, '--source');
    const commands = optionFromArgs(args, '--commands');
    const ignored = optionFromArgs(args, '--ignored');
    if (!identifier || !profile || !gate || !source || !commands) {
      throw new Error('usage: stage-cli gate-testing-freeze <manifest.json> --profile <p> --gate <g> --source <repo impact map.json> --commands <repo command array.json> [--ignored <repo ignored rules.json>]');
    }
    console.log(JSON.stringify(freezeGateTesting({ manifestPath: identifier, profile, gate, source, commands, ignored })));
    return;
  }
  if (command === 'preflight') {
    if (!identifier || args.some((arg, index) => index > 1 && arg !== '--environment')) {
      throw new Error('usage: stage-cli preflight <manifest.json> [--environment]');
    }
    const result = await preflightFile(resolve(identifier), { environment: args.includes('--environment') });
    console.log(JSON.stringify(result));
    return;
  }
  if (command === 'init') {
    if (!identifier) throw new Error('manifest path is required');
    // No state files are created until every gate and the actual pytest executable
    // have passed validation. Python dependencies are never installed implicitly.
    await preflightFile(resolve(identifier), { environment: true });
  }
  if (command === 'approve') {
    if (!identifier) throw new Error('run-id is required');
    const state = JSON.parse(await readFile(join(resolve(stateRootFromArgs(args)), identifier, 'state.json'), 'utf8'));
    if (!state.manifest_file) throw new Error('approved manifest path is missing');
    await preflightFile(state.manifest_file, { environment: true });
  }
  await enforcePublishedEvidenceCurrent(args);
  await rejectDirectOwnerAcceptanceTransition(args);
  await runCli(await enforceCompletionEvidence(args));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`stage-cli: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
