import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readLeases } from './dispatch-leases.mjs';
import process from 'node:process';

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA = /^[0-9a-f]{64}$/i;
const sha = content => createHash('sha256').update(content).digest('hex');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const optionalJson = async file => {
  try { return await json(file); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
};

// stage-cli init records the original *absolute* frozen manifest path. It may be in
// .tmp/pipelines/<run>, a planning folder or the project root. Its SHA binds identity.
function verifiedManifestPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) throw Error('HANDOVER_MANIFEST_PATH_INVALID');
  return resolve(value);
}

function gitHead(cwd) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', timeout: 5_000 });
  const value = String(result.stdout ?? '').trim();
  return result.status === 0 && /^[0-9a-f]{40}$/i.test(value) ? value : null;
}

// The snapshot is only a compact INDEX into machine state; it never overrides stage-cli.
export async function snapshotHandover(stateRoot, runId, cwd = process.cwd()) {
  if (!RUN_ID.test(runId)) throw Error('INVALID_RUN_ID');
  const runRoot = resolve(stateRoot, runId);
  const stateFile = join(runRoot, 'state.json');
  const stateRaw = await readFile(stateFile, 'utf8');
  const state = JSON.parse(stateRaw);
  if (state.run_id !== runId || !state.manifest_file || !SHA.test(String(state.manifest_sha256 ?? ''))) {
    throw Error('HANDOVER_STATE_IDENTITY_INVALID');
  }
  const manifestFile = verifiedManifestPath(state.manifest_file);
  const manifestRaw = await readFile(manifestFile, 'utf8');
  if (sha(manifestRaw) !== state.manifest_sha256) throw Error('HANDOVER_FROZEN_MANIFEST_CHANGED');
  const manifest = JSON.parse(manifestRaw);
  if (manifest.run_id !== runId) throw Error('HANDOVER_MANIFEST_IDENTITY_INVALID');
  const candidate = await optionalJson(join(runRoot, 'candidate.json'));
  const registry = await optionalJson(join(runRoot, 'session-registry.json'));
  // Live leases are the dispatch authority; the session registry alone may not yet
  // contain a just-started child. Read both without polling.
  const leases = readLeases(runRoot, { state });
  const workers = [...leases, ...(Array.isArray(registry) ? registry : [])
    .filter(item => item && ['in_progress', 'background'].includes(item.status))]
    .filter((item, index, all) => index === all.findIndex(other =>
      other.pipeline_id === item.pipeline_id && other.stage === item.stage &&
      other.work_item_id === item.work_item_id))
    .map(item => ({ pipeline_id: item.pipeline_id, stage: item.stage, role: item.role,
      work_item_id: item.work_item_id, status: item.status ?? 'leased' }));
  const pipelines = Object.entries(state.pipelines ?? {}).map(([id, lane]) => ({
    id, status: lane.status,
    stages: (lane.stage_order ?? Object.keys(lane.stages ?? {})).map(name => {
      const item = lane.stages?.[name] ?? {};
      return { name, status: item.status,
        ...(Number.isInteger(item.technical_fix_cycles) ? { fix_cycles: item.technical_fix_cycles } : {}),
        ...(Number.isInteger(item.technical_fix_limit) ? { fix_limit: item.technical_fix_limit } : {}),
        ...(item.architecture_review_due ? { architecture_review_due: true } : {}),
        ...(item.class_review_due?.length ? { class_review_due: item.class_review_due } : {}),
        ...(typeof item.message === 'string' ? { message: item.message.slice(0, 450) } : {}),
        ...(item.evidence?.artifacts ? { evidence_paths: item.evidence.artifacts.slice(0, 8) } : {}),
      };
    }),
  }));
  const amendments = (state.owner_amendments ?? []).map(item => ({
    revision: item.revision, pipeline_id: item.pipeline_id,
    evidence_path: item.evidence_path, evidence_sha256: item.evidence_sha256,
  }));
  const openDecisions = (state.deferred_decisions ?? [])
    .filter(item => item.status !== 'approved')
    .map(item => ({ id: item.id, pipeline_id: item.pipeline_id, status: item.status, before_stage: item.before_stage }));
  const candidateSha = candidate?.status === 'PASS' && candidate.run_id === runId &&
    /^[0-9a-f]{40}$/i.test(String(candidate.candidate_sha ?? '')) ? candidate.candidate_sha : null;
  return {
    version: 1, run_id: runId, state_sha256: sha(stateRaw),
    manifest_sha256: state.manifest_sha256, status: state.status,
    run_base_sha: state.run_base_sha ?? null, head_sha: gitHead(cwd),
    candidate_sha: candidateSha, pipelines, active_workers: workers,
    owner_amendments: amendments, deferred_decisions: openDecisions,
    // This is a pointer to the authoritative scheduler, not a second scheduling decision.
    next_action: 'stage-cli next ' + runId + ' --json',
    state_source: 'stage-cli; handover is NOT permission, approval or completion evidence',
  };
}

function summary(snapshot) {
  const rows = ['# RUN ' + snapshot.run_id,
    'State: ' + snapshot.status + '; HEAD: ' + (snapshot.head_sha ?? 'unknown') +
      '; candidate: ' + (snapshot.candidate_sha ?? 'none'),
    'Manifest SHA-256: ' + snapshot.manifest_sha256,
    'State SHA-256: ' + snapshot.state_sha256, ''];
  for (const lane of snapshot.pipelines) {
    rows.push('## ' + lane.id + ' — ' + lane.status);
    for (const stage of lane.stages) {
      const cycle = stage.fix_cycles == null ? '' : ' fix ' + stage.fix_cycles + '/' + (stage.fix_limit ?? '?');
      const blockers = stage.message ? ' — ' + stage.message.replace(/\n/g, ' ') : '';
      rows.push('- ' + stage.name + ': ' + stage.status + cycle + blockers);
    }
  }
  rows.push('', 'Active child sessions: ' + snapshot.active_workers.length,
    'Pending owner decisions: ' + snapshot.deferred_decisions.length,
    'Next authoritative query: ' + snapshot.next_action,
    '', 'IMPORTANT: reread stage-cli next, existing evidence and current permissions on resume.');
  return rows.join('\n') + '\n';
}

export async function writeHandover(stateRoot, runId, cwd = process.cwd()) {
  const snapshot = await snapshotHandover(stateRoot, runId, cwd);
  const dir = join(resolve(stateRoot, runId), 'handoffs', 'context');
  await mkdir(dir, { recursive: true });
  const output = join(dir, 'current.json'), mdOutput = join(dir, 'current.md');
  const temp = output + '.tmp-' + process.pid, mdTemp = mdOutput + '.tmp-' + process.pid;
  await writeFile(temp, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, output);
  await writeFile(mdTemp, summary(snapshot), { mode: 0o600 });
  await rename(mdTemp, mdOutput);
  return { status: 'PASS', run_id: runId, snapshot_path: output, summary_path: mdOutput,
    state_sha256: snapshot.state_sha256, manifest_sha256: snapshot.manifest_sha256 };
}

export async function checkHandover(stateRoot, runId, cwd = process.cwd()) {
  const current = await snapshotHandover(stateRoot, runId, cwd);
  const file = join(resolve(stateRoot, runId), 'handoffs', 'context', 'current.json');
  const previous = await optionalJson(file);
  const matches = previous?.run_id === current.run_id &&
    previous?.state_sha256 === current.state_sha256 &&
    previous?.manifest_sha256 === current.manifest_sha256;
  return { status: !previous ? 'MISSING' : matches ? 'PASS' : 'STALE',
    run_id: runId, snapshot_path: file, state_sha256: current.state_sha256,
    next_action: current.next_action, machine_state_authoritative: true };
}

async function main() {
  const args = process.argv.slice(2);
  const runId = args[0];
  const rootAt = args.indexOf('--state-root');
  const stateRoot = rootAt === -1 ? '.tmp/pipelines' : args[rootAt + 1];
  if (!runId || !RUN_ID.test(runId) || !stateRoot) throw Error('Usage: node pipeline-handover.mjs RUN [--check] [--state-root PATH]');
  const output = args.includes('--check')
    ? await checkHandover(stateRoot, runId) : await writeHandover(stateRoot, runId);
  console.log(JSON.stringify(output));
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => { console.error(String(error)); process.exitCode = 1; });
}
