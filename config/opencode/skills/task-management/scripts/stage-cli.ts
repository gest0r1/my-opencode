// Stable CLI entry point. Keep core stage/DAG/state implementation untouched and
// reject non-executable machine gates BEFORE init creates any state or approve mutates it.
export * from './stage-cli-core.ts';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runCli } from './stage-cli-core.ts';
import { preflightFile } from './manifest-preflight.mjs';

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
  const result = spawnSync('git', args, { shell: false, encoding: 'utf8' });
  if (result.status !== 0 || result.error) return undefined;
  return String(result.stdout ?? '').trim();
}

async function enforcePublishedEvidenceCurrent(args: string[]): Promise<void> {
  if (!['validate', 'next', 'start', 'complete', 'resume'].includes(args[0] ?? '')) return;
  const runId = args[1];
  if (!runId) return;

  const stateRoot = resolve(stateRootFromArgs(args));
  let state: any;
  try { state = JSON.parse(await readFile(join(stateRoot, runId, 'state.json'), 'utf8')); }
  catch { return; }
  if (!state.manifest_file) return;

  const manifestFile = resolve(state.manifest_file);
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  if (manifest.schema_version !== 2) return;

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
        if (String(evidence.head_sha ?? '').toLowerCase() !== String(candidate.candidate_sha).toLowerCase()) {
          throw new Error('EVIDENCE_INVALID_OR_STALE: github_ci ' + pipeline.id + '/' + stage);
        }
        continue;
      }

      const sourceStage = contract?.source_ci_stage;
      const source = sourceStage
        ? await readJsonEvidence(join(artifactRoot, 'github', pipeline.id + '-' + sourceStage + '.json'), pipeline.id + '/' + sourceStage)
        : undefined;
      const devCommon = evidence.dev_evidence_validated === true &&
        String(evidence.installed_sha ?? '').toLowerCase() === String(candidate.candidate_sha).toLowerCase() &&
        source?.status === 'PASS' &&
        String(source?.candidate_sha ?? '').toLowerCase() === String(candidate.candidate_sha).toLowerCase() &&
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

  if (executor === 'local_gate') {
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
    const executorSpecificValid = executor === 'github_dev'
      ? evidence.dev_evidence_validated === true &&
        String(evidence.installed_sha ?? '').toLowerCase() === String(candidate.candidate_sha).toLowerCase() &&
        (contract?.mode === 'stateful'
          ? evidence.trusted_ref === contract?.trusted_ref &&
            String(evidence.head_branch ?? '').toLowerCase() === String(contract?.trusted_ref ?? '').toLowerCase()
          : String(evidence.head_sha ?? '').toLowerCase() === String(candidate.candidate_sha).toLowerCase())
      : String(evidence.head_sha ?? '').toLowerCase() === String(candidate.candidate_sha).toLowerCase();
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
      if (source.status !== 'PASS' ||
          String(source.candidate_sha).toLowerCase() !== String(candidate.candidate_sha).toLowerCase() ||
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
  await runCli(await enforceCompletionEvidence(args));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`stage-cli: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
