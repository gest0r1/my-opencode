import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { passkeyBrokerRequired } from './owner-broker-client.mjs';

// dev_deploy evidence. The orchestrator installs the published candidate on the owner's dev contour with
// `sudo -n /usr/local/sbin/opencode-deploy-target <deploy_target> <candidate_sha>` (the owner confirms each
// run); the helper records the outcome as root in a world-readable file. This CLI only reads that record,
// never runs sudo, and proves that exactly the candidate was installed after the stage started.
//
//   dev-deploy-cli.ts record <run-id> <stage> --pipeline <id> [--state-root <path>]

const RUN_ID = /^[A-Za-z0-9._-]+$/;
const SHA = /^[0-9a-f]{40}$/i;
const DEFAULT_DEPLOY_STATE = '/var/lib/opencode/deploy-targets';

class DevDeployError extends Error {}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function readJson(file: string, label: string): Promise<any> {
  let raw: string;
  try { raw = await readFile(file, 'utf8'); } catch { throw new DevDeployError(`${label} is missing: ${file}`); }
  try { return JSON.parse(raw); } catch { throw new DevDeployError(`${label} is not valid JSON: ${file}`); }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temp, file);
}

function contourStateDirectory() {
  return passkeyBrokerRequired() ? DEFAULT_DEPLOY_STATE : process.env.OPENCODE_DEPLOY_STATE_DIR || DEFAULT_DEPLOY_STATE;
}

async function readContourJson(file: string, label: string, expected: string) {
  if (passkeyBrokerRequired()) {
    const stateDir = await lstat(DEFAULT_DEPLOY_STATE);
    if (file !== expected || !stateDir.isDirectory() || stateDir.uid !== 0 || (stateDir.mode & 0o022) !== 0 ||
        await realpath(DEFAULT_DEPLOY_STATE) !== DEFAULT_DEPLOY_STATE) {
      throw new DevDeployError('DEV_DEPLOY_STATE_UNTRUSTED');
    }
    const entry = await lstat(file);
    if (!entry.isFile() || entry.uid !== 0 || (entry.mode & 0o022) !== 0) {
      throw new DevDeployError('DEV_DEPLOY_RECORD_UNTRUSTED');
    }
  }
  return readJson(file, label);
}

// The helper records the reported top-level SHA and its provenance. Older
// adapters may include a nested current SHA, which must agree when present.
export function currentContourSha(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DevDeployError('GATE_SERVICE_STATUS_CURRENT_SHA_MISSING');
  }
  const status = value as Record<string, unknown>;
  const current = status.sha;
  if (typeof current !== 'string' || !SHA.test(current)) {
    throw new DevDeployError('GATE_SERVICE_STATUS_CURRENT_SHA_MISSING: expected exact status.sha');
  }
  const nested = status.current;
  if (nested !== undefined) {
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) {
      throw new DevDeployError('GATE_SERVICE_STATUS_AMBIGUOUS_CURRENT');
    }
    const nestedSha = (nested as Record<string, unknown>).sha;
    if (nestedSha !== undefined &&
        (typeof nestedSha !== 'string' || !SHA.test(nestedSha) ||
         nestedSha.toLowerCase() !== current.toLowerCase())) {
      throw new DevDeployError('GATE_SERVICE_STATUS_AMBIGUOUS_CURRENT');
    }
  }
  return current.toLowerCase();
}

export function deployEvidencePath(artifactRoot: string, pipelineId: string, stage: string): string {
  return join(artifactRoot, 'deploy', `${pipelineId}-${stage}.json`);
}

// Local post-deploy smoke gates consume the existing dev-deploy evidence and
// current root-owned contour state, not an invented second deployment record.
// A completed stage alone does not prove the service still runs that candidate.
export async function verifyDeployedServiceGate(input: {
  artifactRoot: string; runId: string; pipelineId: string; stage: string;
  target: string; candidateSha: string; startedAt: string;
}): Promise<Record<string, unknown>> {
  const { artifactRoot, runId, pipelineId, stage, target, startedAt } = input;
  const candidateSha = input.candidateSha.toLowerCase();
  if (![runId, pipelineId, stage, target].every(value =>
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && !value.includes('..')) ||
      !SHA.test(candidateSha) || !Number.isFinite(Date.parse(startedAt))) {
    throw new DevDeployError('GATE_SERVICE_IDENTITY_INVALID: unsafe target/stage/candidate/baseline');
  }
  const recordedPath = deployEvidencePath(artifactRoot, pipelineId, stage);
  const evidence = await readJson(recordedPath, 'dev_deploy evidence');
  if (evidence.status !== 'PASS' || evidence.run_id !== runId || evidence.pipeline_id !== pipelineId ||
      evidence.stage !== stage || evidence.target !== target ||
      String(evidence.candidate_sha ?? '').toLowerCase() !== candidateSha) {
    throw new DevDeployError('GATE_SERVICE_EVIDENCE_MISMATCH: dev_deploy evidence is not for this run/target/candidate');
  }
  const stateDir = contourStateDirectory();
  const installRecord = join(stateDir, `${target}.json`);
  const installed = await readContourJson(installRecord, 'current contour state', installRecord);
  if (installed.key !== target || String(installed.sha ?? '').toLowerCase() !== candidateSha ||
      installed.exit_code !== 0 || !Number.isFinite(Date.parse(installed.finished_at)) ||
      Date.parse(installed.finished_at) < Date.parse(startedAt)) {
    throw new DevDeployError('GATE_SERVICE_INSTALL_CHANGED: contour no longer reports the approved deployment');
  }
  if (!installed.status_file) throw new DevDeployError('GATE_SERVICE_STATUS_MISSING: no current service status file');
  const status = await readContourJson(String(installed.status_file), 'current contour status', join(stateDir, `${target}.status.json`));
  if (currentContourSha(status) !== candidateSha) {
    throw new DevDeployError('GATE_SERVICE_STATUS_MISMATCH: current service SHA differs from published candidate');
  }
  return { status: 'PASS', run_id: runId, pipeline_id: pipelineId,
    stage, target, candidate_sha: candidateSha, installed_sha: installed.sha,
    installed_at: installed.finished_at, status_provenance: installed.status_provenance ?? 'legacy-unattributed', evidence_path: recordedPath };
}

async function record(args: string[]): Promise<Record<string, unknown>> {
  const runId = args[1]; const stage = args[2]; const pipelineId = option(args, '--pipeline');
  if (!runId || !RUN_ID.test(runId) || !stage || !pipelineId) {
    throw new DevDeployError('usage: dev-deploy-cli.ts record <run-id> <stage> --pipeline <id> [--state-root <path>]');
  }
  const stateRoot = resolve(option(args, '--state-root') ?? '.tmp/pipelines');
  const state = await readJson(join(stateRoot, runId, 'state.json'), 'state.json');
  const manifest = await readJson(String(state.manifest_file ?? ''), 'manifest.json');
  const pipeline = manifest.pipelines?.find((item: any) => item.id === pipelineId);
  if (pipeline?.executors?.[stage] !== 'dev_deploy') throw new DevDeployError(`DEV_DEPLOY_STAGE_REQUIRED: ${pipelineId}/${stage}`);
  const runtime = state.pipelines?.[pipelineId]?.stages?.[stage];
  if (runtime?.status !== 'in_progress' || !runtime.started_at) throw new DevDeployError(`DEV_DEPLOY_NOT_IN_PROGRESS: ${pipelineId}/${stage}`);
  const target = String(manifest.deploy_target ?? '');
  if (passkeyBrokerRequired() && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(target)) throw new DevDeployError('DEV_DEPLOY_TARGET_INVALID');
  const artifactRoot = dirname(resolve(String(state.manifest_file)));
  const candidate = await readJson(join(artifactRoot, 'candidate.json'), 'candidate.json');
  const candidateSha = String(candidate.candidate_sha ?? '').toLowerCase();
  if (candidate.status !== 'PASS' || !SHA.test(candidateSha) || candidateSha !== String(candidate.remote_sha ?? '').toLowerCase()) {
    throw new DevDeployError('DEV_DEPLOY_CANDIDATE_REQUIRED: candidate.json has no published PASS candidate');
  }

  const stateDir = contourStateDirectory();
  const install = `sudo -n /usr/local/sbin/opencode-deploy-target ${target} ${candidateSha}`;
  const evidence: Record<string, any> = { status: 'FAIL', run_id: runId, pipeline_id: pipelineId, stage, target, candidate_sha: candidateSha,
    recorded_at: new Date().toISOString() };
  let failure: string | null = null;
  let installed: any = null;
  const installRecord = join(stateDir, `${target}.json`);
  try { installed = await readContourJson(installRecord, 'current contour state', installRecord); } catch (error) {
    if (error instanceof DevDeployError && error.message.endsWith('_UNTRUSTED')) throw error;
  }
  if (!installed || installed.key !== target || !installed.finished_at || Date.parse(installed.finished_at) < Date.parse(runtime.started_at)) {
    failure = `DEV_DEPLOY_NOT_RUN: no install of ${target} since the stage started; run: ${install}`;
  } else if (String(installed.sha ?? '').toLowerCase() !== candidateSha) {
    failure = `DEV_DEPLOY_OTHER_COMMIT: ${target} got ${String(installed.sha)}, not the candidate; run: ${install}`;
  } else if (installed.exit_code !== 0) {
    failure = `DEV_DEPLOY_FAILED: the installer exited ${String(installed.exit_code)}; read its output above`;
  }
  let status: any = null;
  if (!failure) {
    if (!installed.status_file || typeof installed.status_file !== 'string') {
      failure = 'DEV_DEPLOY_STATUS_MISSING: current status output is required';
    } else {
      try {
        status = await readContourJson(installed.status_file, 'current contour status', join(stateDir, `${target}.status.json`));
        const currentSha = currentContourSha(status);
        if (currentSha !== candidateSha) {
          failure = `DEV_DEPLOY_STATUS_MISMATCH: ${target} runs ${currentSha}, not ${candidateSha}`;
        }
      } catch (error) {
        failure = 'DEV_DEPLOY_STATUS_INVALID: ' + String(error instanceof Error ? error.message : error);
      }
    }
  }
  Object.assign(evidence, { status: failure ? 'FAIL' : 'PASS', installed, contour_status: status, error: failure });
  await writeJsonAtomic(deployEvidencePath(artifactRoot, pipelineId, stage), evidence);
  if (failure) throw new DevDeployError(failure);
  return { ...evidence, evidence: deployEvidencePath(artifactRoot, pipelineId, stage) };
}

async function main(args: string[]): Promise<void> {
  if (args[0] !== 'record') throw new DevDeployError('usage: dev-deploy-cli.ts record <run-id> <stage> --pipeline <id> [--state-root <path>]');
  console.log(JSON.stringify(await record(args), null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`dev-deploy-cli: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
