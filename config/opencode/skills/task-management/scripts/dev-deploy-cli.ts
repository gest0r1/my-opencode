import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

// dev_deploy evidence. The orchestrator installs the published candidate on the owner's dev contour with
// `sudo -n /usr/local/sbin/opencode-deploy-target <deploy_target> <candidate_sha>` (the owner confirms each
// run); the helper records the outcome as root in a world-readable file. This CLI only reads that record,
// never runs sudo, and proves that exactly the candidate was installed after the stage started.
//
//   dev-deploy-cli.ts record <run-id> <stage> --pipeline <id> [--state-root <path>]

const RUN_ID = /^[A-Za-z0-9._-]+$/;
const SHA = /^[0-9a-f]{40}$/i;

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
  const stateDir = process.env.OPENCODE_DEPLOY_STATE_DIR || '/var/lib/opencode/deploy-targets';
  const installed = await readJson(join(stateDir, target + '.json'), 'current contour state');
  if (installed.key !== target || String(installed.sha ?? '').toLowerCase() !== candidateSha ||
      installed.exit_code !== 0 || !Number.isFinite(Date.parse(installed.finished_at)) ||
      Date.parse(installed.finished_at) < Date.parse(startedAt)) {
    throw new DevDeployError('GATE_SERVICE_INSTALL_CHANGED: contour no longer reports the approved deployment');
  }
  if (!installed.status_file) throw new DevDeployError('GATE_SERVICE_STATUS_MISSING: no current service status file');
  const status = await readJson(String(installed.status_file), 'current contour status');
  if (!JSON.stringify(status).toLowerCase().includes(candidateSha)) {
    throw new DevDeployError('GATE_SERVICE_STATUS_MISMATCH: service status does not name the installed candidate');
  }
  return { status: 'PASS', run_id: runId, pipeline_id: pipelineId,
    stage, target, candidate_sha: candidateSha, installed_sha: installed.sha,
    installed_at: installed.finished_at, evidence_path: recordedPath };
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
  const artifactRoot = dirname(resolve(String(state.manifest_file)));
  const candidate = await readJson(join(artifactRoot, 'candidate.json'), 'candidate.json');
  const candidateSha = String(candidate.candidate_sha ?? '').toLowerCase();
  if (candidate.status !== 'PASS' || !SHA.test(candidateSha) || candidateSha !== String(candidate.remote_sha ?? '').toLowerCase()) {
    throw new DevDeployError('DEV_DEPLOY_CANDIDATE_REQUIRED: candidate.json has no published PASS candidate');
  }

  const stateDir = process.env.OPENCODE_DEPLOY_STATE_DIR || '/var/lib/opencode/deploy-targets';
  const install = `sudo -n /usr/local/sbin/opencode-deploy-target ${target} ${candidateSha}`;
  const evidence: Record<string, any> = { status: 'FAIL', run_id: runId, pipeline_id: pipelineId, stage, target, candidate_sha: candidateSha,
    recorded_at: new Date().toISOString() };
  let failure: string | null = null;
  let installed: any = null;
  try { installed = JSON.parse(await readFile(join(stateDir, `${target}.json`), 'utf8')); } catch {}
  if (!installed || installed.key !== target || !installed.finished_at || Date.parse(installed.finished_at) < Date.parse(runtime.started_at)) {
    failure = `DEV_DEPLOY_NOT_RUN: no install of ${target} since the stage started; run: ${install}`;
  } else if (String(installed.sha ?? '').toLowerCase() !== candidateSha) {
    failure = `DEV_DEPLOY_OTHER_COMMIT: ${target} got ${String(installed.sha)}, not the candidate; run: ${install}`;
  } else if (installed.exit_code !== 0) {
    failure = `DEV_DEPLOY_FAILED: the installer exited ${String(installed.exit_code)}; read its output above`;
  }
  let status: any = null;
  if (!failure && installed.status_file) {
    try { status = JSON.parse(await readFile(String(installed.status_file), 'utf8')); } catch {}
    // The contour reports what runs there; it must name the candidate.
    if (!status || !JSON.stringify(status).toLowerCase().includes(candidateSha)) {
      failure = `DEV_DEPLOY_STATUS_MISMATCH: the installer status of ${target} does not report ${candidateSha}`;
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
