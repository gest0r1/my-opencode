import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import { sourceInventory, scopedInventoryDigest } from './gate-diagnostics.mjs';
import { gitReadEnv } from './git-readonly.mjs';
import { resolveGateTestingFile } from './gate-testing-policy.mjs';

const STAGE_CLI = fileURLToPath(new URL('./stage-cli.ts', import.meta.url));
// The config-owned tsx (config/opencode/node_modules), never the project's, which a gate may break.
const TSX = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url));
// Same literal as the dispatch packet, so GateRunner's allowlist accepts the rerun command verbatim.
const GATE_RUNNER = '$HOME/.config/opencode/node_modules/.bin/tsx $HOME/.config/opencode/skills/task-management/scripts/gate-runner-cli.ts';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class StageCompleteError extends Error {}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function gitInventory(root: string, exe: string, argv: string[]) {
  if (exe !== 'git') return Promise.resolve({ exit_code: 1, stdout: '', stderr: 'unsupported executable', truncated: false });
  const result = spawnSync(exe, argv, { cwd: root, shell: false, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 30_000, env: gitReadEnv() });
  const stdout = String(result.stdout ?? '');
  return Promise.resolve({ exit_code: result.status ?? (result.error ? 1 : 0), stdout, stderr: String(result.stderr ?? result.error?.message ?? ''), truncated: stdout.length >= 2 * 1024 * 1024 });
}

async function loadJson(path: string): Promise<any> {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new StageCompleteError(`ADVISORY_EVIDENCE_INVALID_OR_MISSING: ${path}`); }
}

function requiredAffectedGates(manifest: any, pipeline: any): string[] {
  if (!pipeline?.profile) return [];
  const commands = manifest.gate_profiles?.[pipeline.profile];
  const testing = manifest.gate_testing?.[pipeline.profile];
  if (!commands || !testing || typeof testing !== 'object') return [];
  return Object.keys(testing).filter(gate =>
    Array.isArray(commands?.[gate]) && commands[gate].length > 0 &&
    Array.isArray(testing?.[gate]?.impact_groups) && testing[gate].impact_groups.length > 0,
  ).sort();
}

async function readFrozenWorkItem(manifestFile: string, frozen: any, errorPrefix: string): Promise<any> {
  if (!frozen || typeof frozen.path !== 'string' || !/^[0-9a-f]{64}$/i.test(String(frozen.sha256 ?? ''))) {
    throw new StageCompleteError(`${errorPrefix}_INVALID: ${String(frozen?.id ?? '<unknown>')}`);
  }
  const path = resolve(dirname(manifestFile), frozen.path);
  let raw: string;
  try { raw = await readFile(path, 'utf8'); }
  catch { throw new StageCompleteError(`${errorPrefix}_MISSING: ${String(frozen.id ?? '<unknown>')}`); }
  if (hash(raw) !== frozen.sha256) throw new StageCompleteError(`${errorPrefix}_CHANGED: ${String(frozen.id ?? '<unknown>')}`);
  try { return JSON.parse(raw); }
  catch { throw new StageCompleteError(`${errorPrefix}_INVALID: ${String(frozen.id ?? '<unknown>')}`); }
}

async function expectedCoderWorkItems(state: any, manifest: any, pipeline: any, stage: string, manifestFile: string): Promise<string[]> {
  const expected = new Set<string>();
  for (const frozen of manifest.work_items ?? []) {
    if (frozen.pipeline_id !== pipeline.id || !pipeline.work_items?.includes(frozen.id)) continue;
    const item = await readFrozenWorkItem(manifestFile, frozen, 'FROZEN_WORK_ITEM');
    if (item.stage === stage && (item.suggested_agent === 'CoderAgent' || item.role === 'CoderAgent')) expected.add(frozen.id);
  }

  for (const amendment of state.owner_amendments ?? []) {
    if (amendment?.pipeline_id !== pipeline.id || amendment?.status !== 'approved') continue;
    if (typeof amendment.evidence_path !== 'string' || !/^[0-9a-f]{64}$/i.test(String(amendment.evidence_sha256 ?? ''))) {
      throw new StageCompleteError('OWNER_AMENDMENT_EVIDENCE_INVALID');
    }
    let evidenceRaw: string;
    try { evidenceRaw = await readFile(resolve(amendment.evidence_path), 'utf8'); }
    catch { throw new StageCompleteError('OWNER_AMENDMENT_EVIDENCE_MISSING'); }
    if (hash(evidenceRaw) !== amendment.evidence_sha256) throw new StageCompleteError('OWNER_AMENDMENT_EVIDENCE_CHANGED');
    let evidence: any;
    try { evidence = JSON.parse(evidenceRaw); }
    catch { throw new StageCompleteError('OWNER_AMENDMENT_EVIDENCE_INVALID'); }
    if (evidence.target_stage !== stage) continue;

    for (const frozen of amendment.work_items ?? []) {
      const item = await readFrozenWorkItem(manifestFile, frozen, 'OWNER_AMENDMENT_WORK_ITEM');
      if (item.suggested_agent === 'CoderAgent' || item.role === 'CoderAgent') expected.add(frozen.id);
    }
  }
  return [...expected].sort();
}

export async function verifyAgentAdvisoryCompletion(root: string, args: string[]): Promise<{checked:number}> {
  if (args[0] !== 'complete') return { checked: 0 };
  const runId = args[1];
  const stage = args[2];
  const pipelineId = option(args, '--pipeline');
  if (!runId || !stage || !pipelineId || !SAFE_ID.test(runId)) return { checked: 0 };

  const stateRoot = resolve(root, option(args, '--state-root') ?? '.tmp/pipelines');
  const runRoot = join(stateRoot, runId);
  const state = await loadJson(join(runRoot, 'state.json'));
  if (!state.manifest_file) return { checked: 0 };
  const manifestFile = resolve(state.manifest_file);
  const manifestRaw = await readFile(manifestFile, 'utf8');
  if (state.manifest_sha256 && hash(manifestRaw) !== state.manifest_sha256) throw new StageCompleteError('FROZEN_MANIFEST_CHANGED');
  const manifest = resolveGateTestingFile(JSON.parse(manifestRaw), manifestFile);
  const pipeline = manifest.pipelines?.find((candidate: any) => candidate.id === pipelineId);
  if (!pipeline || pipeline.executors?.[stage] !== 'agent') return { checked: 0 };
  const gates = requiredAffectedGates(manifest, pipeline);
  if (gates.length === 0) return { checked: 0 };
  const expectedItems = await expectedCoderWorkItems(state, manifest, pipeline, stage, manifestFile);

  const baselineDir = join(runRoot, 'checks', 'baselines');
  let names: string[] = [];
  try { names = (await readdir(baselineDir)).filter(name => name.endsWith('.json')); }
  catch (error: any) { if (error?.code !== 'ENOENT') throw error; }

  const baselines = [];
  for (const name of names) {
    const path = join(baselineDir, name);
    const raw = await readFile(path, 'utf8');
    let baseline: any;
    try { baseline = JSON.parse(raw); }
    catch { throw new StageCompleteError(`ADVISORY_BASELINE_INVALID: ${path}`); }
    if (baseline.run_id === runId && baseline.pipeline_id === pipelineId && baseline.stage === stage) {
      baselines.push({ path, baseline, sha256: hash(raw) });
    }
  }

  for (const workItemId of expectedItems) {
    if (!baselines.some(({ baseline }) => baseline.work_item_id === workItemId)) {
      throw new StageCompleteError(`ADVISORY_DISPATCH_BASELINE_REQUIRED: ${pipelineId}/${stage}/${workItemId}`);
    }
  }
  if (baselines.length === 0) return { checked: 0 };

  // A stage reopened by fix-cycle is completed by the repair dispatched in this loop. Bound
  // evidence of work items the repair did not redispatch is superseded: their files may have
  // changed under the repair, and the repair's own bound check covers the repaired scope.
  const runtime = state.pipelines?.[pipelineId]?.stages?.[stage];
  const originPipelineId = runtime?.repair_origin_pipeline ?? pipelineId;
  const origin = runtime?.repair_origin_stage ? state.pipelines?.[originPipelineId]?.stages?.[runtime.repair_origin_stage] : null;
  const loop = Number(origin?.technical_fix_cycles ?? 0);
  if (origin && loop > 0) {
    const current = baselines.filter(({ baseline }) => Number(baseline.loop ?? 0) === loop && baseline.repair_origin_stage === runtime.repair_origin_stage &&
      (baseline.repair_origin_pipeline ?? pipelineId) === originPipelineId);
    if (current.length === 0) throw new StageCompleteError(`ADVISORY_REPAIR_DISPATCH_REQUIRED: ${pipelineId}/${stage} loop ${loop}`);
    baselines.splice(0, baselines.length, ...current);
  }

  const inventory = await sourceInventory(root, (exe: string, argv: string[]) => gitInventory(root, exe, argv));
  if (!inventory.files) throw new StageCompleteError('ADVISORY_CURRENT_SOURCE_UNAVAILABLE');
  const checkDir = join(runRoot, 'checks');
  let evidenceNames: string[] = [];
  try { evidenceNames = (await readdir(checkDir)).filter(name => name.endsWith('.json') && !name.endsWith('-attempts.json')); }
  catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
  const evidenceRecords = [];
  for (const name of evidenceNames) {
    const path = join(checkDir, name);
    try { evidenceRecords.push({ path, evidence: JSON.parse(await readFile(path, 'utf8')) }); }
    catch { throw new StageCompleteError(`ADVISORY_EVIDENCE_INVALID: ${path}`); }
  }

  let checked = 0;
  for (const { path, baseline, sha256 } of baselines) {
    if (!Array.isArray(baseline.allowed_change_paths) || baseline.allowed_change_paths.length === 0 || !baseline.work_item_id) {
      throw new StageCompleteError(`ADVISORY_BASELINE_INCOMPLETE: ${String(baseline.work_item_id ?? '<unknown>')}`);
    }
    const currentScopedDigest = scopedInventoryDigest(inventory.files, baseline.allowed_change_paths);
    for (const gate of gates) {
      const rerun = `rerun via GateRunner: ${GATE_RUNNER} ${runId} ${pipelineId} ${gate} --advisory --affected --work-item ${baseline.work_item_id} --baseline checks/baselines/${basename(path)} --baseline-sha256 ${sha256}`;
      const matches = evidenceRecords.filter(({ evidence }) =>
        evidence.status === 'PASS' && evidence.purpose === 'advisory' &&
        evidence.run_id === runId && evidence.pipeline_id === pipelineId && evidence.dispatch_stage === stage &&
        evidence.work_item_id === baseline.work_item_id && evidence.gate === gate && evidence.baseline_sha256 === sha256);
      if (matches.length !== 1) {
        throw new StageCompleteError(`ADVISORY_PASS_REQUIRED: ${pipelineId}/${stage}/${baseline.work_item_id}/${gate}; ${rerun}`);
      }
      if (matches[0].evidence.scoped_source_digest !== currentScopedDigest) {
        throw new StageCompleteError(`ADVISORY_EVIDENCE_STALE_SOURCE: ${pipelineId}/${stage}/${baseline.work_item_id}/${gate}; ${rerun}`);
      }
      checked += 1;
    }
  }
  return { checked };
}

// A review stage closes only on a full CodeReviewer review: FindingsReviewer verifies issued findings and
// the repair delta, and its ready verdict leads to the closing full review rather than to completion.
export async function verifyReviewClosing(root: string, args: string[]): Promise<void> {
  const runId = args[1];
  const stage = args[2];
  const pipelineId = option(args, '--pipeline');
  if (args[0] !== 'complete' || !runId || !stage || !pipelineId || !SAFE_ID.test(runId)) return;
  const stateRoot = resolve(root, option(args, '--state-root') ?? '.tmp/pipelines');
  let record: any;
  try { record = JSON.parse(await readFile(join(stateRoot, runId, 'checks', 'review-dispatch', `${pipelineId}--${stage}.json`), 'utf8')); }
  catch { return; }
  if (record?.role === 'FindingsReviewer') throw new StageCompleteError(`REVIEW_CLOSING_FULL_REQUIRED: ${pipelineId}/${stage}; dispatch a full CodeReviewer before completing the review`);
}

function stageCli(args: string[]) {
  const result = spawnSync(TSX, [STAGE_CLI, ...args], { cwd: process.cwd(), shell: false, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) throw result.error;
  return result;
}

async function complete(args: string[]): Promise<string> {
  // No separate evidence pass here: canonical completeStage enforces every
  // required proof before changing RUN state, including direct core entrypoints.
  const result = stageCli(['complete', ...args.slice(1)]);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new StageCompleteError(`STAGE_COMPLETE_DELEGATE_FAILED: ${result.status ?? 'unknown'}`);
  }
  return result.stdout;
}

// Stages that need nothing between `start` and their dispatch or gate run. git_verify waits for
// sync-main, publication, CI, deploy and owner stages keep their own preparation, so they are
// returned as waiting rather than started.
const AUTO_START_EXECUTORS = new Set(['agent', 'review', 'local_gate']);

// advance = complete + GitHub sync + next + start of every runnable stage that needs no preparation:
// one call per transition instead of four. The completion checks are the same as `complete`.
async function advance(args: string[]): Promise<void> {
  const runId = args[1];
  if (!runId || !SAFE_ID.test(runId) || !args[2] || !option(args, '--pipeline')) {
    throw new StageCompleteError('usage: stage-complete-cli.ts advance <run-id> <stage> --pipeline <id> [stage-cli options]');
  }
  await complete(['complete', ...args.slice(1)]);
  const rootArgs = option(args, '--state-root') ? ['--state-root', option(args, '--state-root')!] : [];
  const stateRoot = resolve(process.cwd(), option(args, '--state-root') ?? '.tmp/pipelines');
  const state = JSON.parse(await readFile(join(stateRoot, runId, 'state.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(state.manifest_file, 'utf8'));
  const executorOf = (pipelineId: string, stage: string) =>
    String(manifest.pipelines?.find((pipeline: any) => pipeline.id === pipelineId)?.executors?.[stage] ?? 'unknown');
  const queued = stageCli(['next', runId, '--json', ...rootArgs]);
  if (queued.status !== 0) throw new StageCompleteError(`STAGE_NEXT_FAILED: ${queued.stderr.trim()}`);
  const started: Array<Record<string, string>> = [];
  const waiting: Array<Record<string, string>> = [];
  for (const item of JSON.parse(queued.stdout).runnable ?? []) {
    const executor = executorOf(item.pipeline_id, item.stage);
    if (!AUTO_START_EXECUTORS.has(executor)) { waiting.push({ ...item, executor }); continue; }
    const start = stageCli(['start', runId, item.stage, '--pipeline', item.pipeline_id, ...rootArgs]);
    if (start.status !== 0) waiting.push({ ...item, executor, start_error: start.stderr.trim() });
    else started.push({ ...item, executor });
  }
  // Work items that can start now in every agent stage: the orchestrator dispatches exactly these.
  const waves = stageCli(['waves', runId, '--json']);
  const dispatchNow = waves.status === 0
    ? (JSON.parse(waves.stdout).stages ?? []).filter((entry: any) => entry.dispatchable.length)
      .map((entry: any) => ({ pipeline_id: entry.pipeline_id, stage: entry.stage, work_items: entry.dispatchable }))
    : [];
  let github: Record<string, unknown>;
  try {
    const { syncRun } = await import('./pipeline-github-sync.mjs');
    github = await syncRun(runId, { stateRoot });
  } catch (error) {
    github = { status: 'RETRY', error: error instanceof Error ? error.message : String(error) };
  }
  const run = JSON.parse(await readFile(join(stateRoot, runId, 'state.json'), 'utf8'));
  console.log(JSON.stringify({ status: 'PASS', run_id: runId, run_status: run.status,
    completed: { pipeline_id: option(args, '--pipeline'), stage: args[2] }, started, waiting, dispatch_now: dispatchNow, github_sync: github }, null, 2));
}

async function main(args: string[]): Promise<void> {
  if (args[0] === 'advance') return advance(args);
  if (args[0] !== 'complete') throw new StageCompleteError('usage: stage-complete-cli.ts complete|advance <run-id> <stage> --pipeline <id> [stage-cli options]');
  process.stdout.write(await complete(args));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`stage-complete-cli: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
