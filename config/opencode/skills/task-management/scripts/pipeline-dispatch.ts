import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { computeRunnable, validateState } from './stage-cli-core.ts';
import { validateOwnerAmendmentEvidence } from './owner-amendment-policy.ts';
import { resolveGateTestingFile } from './gate-testing-policy.mjs';
import { sourceInventory, changedFromInventory } from './gate-diagnostics.mjs';
import { recordTestFirstBaseline, requireTestFirstBaseline, reusableTestFirstOnRepair } from './test-first-baseline.mjs';
import { gitReadEnv } from './git-readonly.mjs';
import { planProbeMatches } from './manifest-v2-policy.mjs';
import { laneDigest, laneScope, laneReservations, leaseConflict, readLeases, readStagePaths, sameDispatch } from './dispatch-leases.mjs';

const roles = new Set(['CoderAgent', 'TestEngineer', 'BuildAgent', 'CodeReviewer', 'FindingsReviewer', 'DocWriter', 'OpenDevopsSpecialist', 'OpenFrontendSpecialist']);
// A review stage runs a full CodeReviewer; FindingsReviewer (cheaper model) only re-checks findings a review already issued.
const REVIEW_ROLES = new Set(['CodeReviewer', 'FindingsReviewer']);
const RUN_WORKER_RULE_ROLES = new Set(['CoderAgent', 'TestEngineer', 'BuildAgent', 'OpenFrontendSpecialist']);
const RUN_WORKER_RULES = fileURLToPath(new URL('../run-worker-rules.md', import.meta.url));
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function scopePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false;
  const parts = value.replace(/\/\*\*$/, '').split('/');
  return !parts.includes('..') && !parts.includes('.git') && !/[?*\[\]{}]/.test(value.endsWith('/**') ? value.slice(0, -3) : value);
}

function scopeContained(child: string, parent: string): boolean {
  if (parent.endsWith('/**')) {
    const base = parent.slice(0, -3).replace(/\/$/, '');
    const childBase = child.endsWith('/**') ? child.slice(0, -3).replace(/\/$/, '') : child;
    return childBase === base || childBase.startsWith(`${base}/`);
  }
  return child === parent;
}

function checkedScope(scope: string[], effectiveScope: string[]): string[] {
  const unique = [...new Set(scope)];
  if (!unique.length || unique.some(value => !scopePath(value))) return [];
  if (unique.some(child => !effectiveScope.some(parent => scopeContained(child, parent)))) {
    throw Error('WORK_ITEM_SCOPE_OUTSIDE_EFFECTIVE_SCOPE');
  }
  return unique;
}

function coderScope(item: any, effectiveScope: string[]): string[] {
  if (!Array.isArray(item?.allowed_change_paths)) return [];
  return checkedScope(item.allowed_change_paths, effectiveScope);
}

const GATE_RUNNER = '$HOME/.config/opencode/node_modules/.bin/tsx $HOME/.config/opencode/skills/task-management/scripts/gate-runner-cli.ts';

function affectedAdvisoryChecks(manifest: any, pipeline: any, role: string) {
  if (role !== 'CoderAgent' || typeof pipeline?.profile !== 'string' || !pipeline.profile) return [];
  const profile = pipeline.profile;
  const commands = manifest.gate_profiles?.[profile];
  const testing = manifest.gate_testing?.[profile];
  if (!commands || !testing || typeof testing !== 'object') return [];
  return Object.keys(testing).sort().flatMap((gate) => {
    const impactGroups = testing?.[gate]?.impact_groups;
    if (!Array.isArray(commands?.[gate]) || commands[gate].length === 0 ||
        !Array.isArray(impactGroups) || impactGroups.length === 0) return [];
    return [{ gate, mode: 'affected' as const }];
  });
}

function inventoryInvoke(root: string, exe: string, argv: string[]) {
  if (exe !== 'git') return Promise.resolve({ exit_code: 1, stdout: '', stderr: 'unsupported executable', truncated: false });
  const result = spawnSync(exe, argv, { cwd: root, shell: false, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 30_000, env: gitReadEnv() });
  const stdout = String(result.stdout ?? '');
  return Promise.resolve({
    exit_code: result.status ?? (result.error ? 1 : 0),
    stdout,
    stderr: String(result.stderr ?? result.error?.message ?? ''),
    truncated: stdout.length >= 2 * 1024 * 1024,
  });
}

async function writeBaseline(root: string, run: string, payload: Record<string, unknown>): Promise<{path:string;sha256:string}> {
  const runRoot = resolve(root, '.tmp/pipelines', run);
  const directory = join(runRoot, 'checks', 'baselines');
  await mkdir(directory, { recursive: true });
  const identity = hash(JSON.stringify([payload.pipeline_id, payload.stage, payload.work_item_id])).slice(0, 24);
  const relative = `checks/baselines/${identity}.json`;
  const target = join(runRoot, relative);
  // A re-dispatch of the same work item (repair cycle) keeps the first dispatch's file inventory, so
  // `changed` still covers everything this work item changed and affected selection stays narrow.
  try {
    const previous = JSON.parse(await readFile(target, 'utf8'));
    if (previous?.manifest_sha256 === payload.manifest_sha256 && previous?.files && typeof previous.source_digest === 'string') {
      payload = { ...payload, files: previous.files, source_digest: previous.source_digest, first_recorded_at: previous.first_recorded_at ?? previous.recorded_at };
    }
  } catch {}
  const content = `${JSON.stringify(payload, null, 2)}\n`;
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, target);
  return { path: relative, sha256: hash(content) };
}

// The base probe classifies a suite that is already red on the untouched base before any work item
// can absorb it. One probe serves every pipeline sharing the frozen profile.
//   PASS                        → dispatch.
//   FAIL                        → only after PLAN assigned the red suites to a baseline-repair work
//                                 item (`"baseline_repair": true`) on this profile; that item and the
//                                 rest of the plan then proceed, the repair lane ordered by depends_on.
//   missing/BLOCKED, clean base → BASE_PROBE_REQUIRED (the probe needs the clean checkout).
//   missing, base already moved → implementation started before the probe existed: no probe can be
//                                 taken any more, so dispatch continues and the baseline records it.
async function requireBaseProbe(root: string, run: string, manifestFile: string, manifest: any, pipeline: any, gates: string[], item: any, effectiveScope: string[]) {
  const runRoot = resolve(root, '.tmp/pipelines', run);
  const sharing = manifest.pipelines.filter((p: any) => p.profile === pipeline.profile).map((p: any) => p.id);
  const results: Record<string, string> = {};
  for (const gate of gates) {
    const statuses: string[] = [];
    for (const id of sharing) {
      try {
        const probe = JSON.parse(await readFile(join(runRoot, 'checks', `${id}-${gate}-base-probe.json`), 'utf8'));
        if (probe?.purpose === 'advisory' && probe?.base_probe) statuses.push(String(probe.status));
      } catch {}
    }
    // A plan probe of the same profile/gate stands in for the base probe: PASS only when taken at the
    // current clean HEAD, FAIL as soon as its commands are still the frozen ones.
    const commands = manifest.gate_profiles?.[pipeline.profile]?.[gate];
    for (const id of sharing) {
      try {
        const probe = JSON.parse(await readFile(join(dirname(manifestFile), 'planning', 'probes', `${id}-${gate}.json`), 'utf8'));
        if (!Array.isArray(commands) || !planProbeMatches(probe, manifest, {
          pipeline_id: pipeline.id, profile: pipeline.profile, gate, commands,
        })) continue;
        if (probe.status === 'FAIL') statuses.push('FAIL');
        else if (probe.status === 'PASS' && cleanHeadIs(root, effectiveScope, probe.head_sha)) statuses.push('PASS');
      } catch {}
    }
    if (statuses.includes('PASS')) { results[gate] = 'PASS'; continue; }
    if (statuses.includes('FAIL')) {
      if (item?.baseline_repair !== true && !(await profileHasBaselineRepair(manifestFile, manifest, sharing))) {
        throw Error(`BASE_RED_REPAIR_REQUIRED: ${gate} is red on the untouched base; revise PLAN so a work item with "baseline_repair": true owns the failing suites`);
      }
      results[gate] = 'FAIL_REPAIR_PLANNED'; continue;
    }
    if (!implementationStarted(root, manifest, effectiveScope)) {
      throw Error(`BASE_PROBE_REQUIRED: run gate-runner-cli ${run} ${pipeline.id} ${gate} --advisory --base-probe on the clean checkout before the first source dispatch of profile ${pipeline.profile}`);
    }
    results[gate] = 'SKIPPED_AFTER_START';
  }
  return results;
}

async function profileHasBaselineRepair(manifestFile: string, manifest: any, pipelineIds: string[]): Promise<boolean> {
  for (const unit of manifest.work_items ?? []) {
    if (!pipelineIds.includes(unit.pipeline_id) || typeof unit.path !== 'string') continue;
    try {
      if (JSON.parse(await readFile(resolve(dirname(manifestFile), unit.path), 'utf8'))?.baseline_repair === true) return true;
    } catch {}
  }
  return false;
}

function cleanHeadIs(root: string, effectiveScope: string[], sha: unknown): boolean {
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/i.test(sha)) return false;
  const run = (args: string[]) => spawnSync('git', args, { cwd: root, shell: false, encoding: 'utf8', timeout: 30_000, env: gitReadEnv() });
  const status = run(['status', '--porcelain', '-z', '--untracked-files=all']);
  const head = run(['rev-parse', 'HEAD']);
  if (status.status !== 0 || head.status !== 0) return false;
  const paths = String(status.stdout).split('\0').filter(Boolean).map(entry => entry.slice(3));
  return !paths.some(file => effectiveScope.some(scope => scopeContained(file, scope))) && String(head.stdout).trim().toLowerCase() === sha.toLowerCase();
}

// Started = the RUN branch moved past its base, or an authorized path differs from it. Files outside
// the RUN scope (owner scratch, planning artifacts) say nothing about implementation.
function implementationStarted(root: string, manifest: any, effectiveScope: string[]): boolean {
  const run = (args: string[]) => spawnSync('git', args, { cwd: root, shell: false, encoding: 'utf8', timeout: 30_000, env: gitReadEnv() });
  const status = run(['status', '--porcelain', '-z', '--untracked-files=all']);
  if (status.status !== 0) return false;
  const paths = String(status.stdout).split('\0').filter(Boolean).map(entry => entry.slice(3));
  if (paths.some(file => effectiveScope.some(scope => scopeContained(file, scope)))) return true;
  const base = manifest.git_setup?.base_sha;
  const head = run(['rev-parse', 'HEAD']);
  return /^[0-9a-f]{40}$/i.test(base ?? '') && head.status === 0 && String(head.stdout).trim().toLowerCase() !== base.toLowerCase();
}

// Paths a writing worker may change: its bound scope, else the item's declared paths, else the whole
// effective scope. The lease and the overlap checks use exactly this set.
function writerScope(item: any, boundScope: string[], effectiveScope: string[], stagePaths: string[] = []): string[] {
  let own = boundScope;
  if (!own.length) { try { own = coderScope(item, effectiveScope); } catch { own = []; } }
  if (!own.length) return effectiveScope;
  return [...new Set([...own, ...stagePaths])];
}

function sessionRegistry(root: string, run: string): any[] {
  try {
    const value = JSON.parse(readFileSync(join(root, '.tmp/pipelines', run, 'session-registry.json'), 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

// A result from a previous wave does not complete work reopened by an owner amendment or repair.
// The stage start time is the wave boundary; it is persisted in machine state, not inferred from
// a previous child session. No extra tool call is needed to check it.
function workItemDone(state: any, registry: any[], pipelineId: string, workItemId: string, stage?: string, manifest?: any): boolean {
  const runtime = stage ? state.pipelines[pipelineId]?.stages?.[stage] : undefined;
  if (stage && runtime?.status === 'completed') return true;
  const waveStartedAt = stage ? Date.parse(String(runtime?.started_at ?? '')) : NaN;
  if (stage && !Number.isFinite(waveStartedAt)) return false;
  const results = registry.filter(entry =>
    entry.pipeline_id === pipelineId && entry.work_item_id === workItemId &&
    (!stage || entry.stage === stage) && ['healthy', 'stale'].includes(entry.status));
  if (results.some(entry =>
    !stage || (Number.isFinite(Date.parse(String(entry.updated_at ?? ''))) &&
      Date.parse(String(entry.updated_at)) >= waveStartedAt))) return true;
  // Reopening a code-only repair must not repeatedly pay TestEngineer to recreate
  // unchanged RED tests. A source/contract owner amendment or test-scope repair is not reusable.
  if (!manifest || !stage || !runtime?.repair_origin_stage || !results.length || !state.manifest_file) return false;
  const origin = state.pipelines[runtime.repair_origin_pipeline ?? pipelineId]?.stages?.[runtime.repair_origin_stage];
  const unit = manifest.work_items.find((entry: any) => entry.id === workItemId && entry.pipeline_id === pipelineId);
  if (!unit) return false;
  const testItem = workItemRecord(manifest, state.manifest_file, unit);
  if (testItem.suggested_agent !== 'TestEngineer') return false;
  const consumers = manifest.work_items.filter((entry: any) => entry.pipeline_id === pipelineId)
    .map((entry: any) => workItemRecord(manifest, state.manifest_file, entry));
  return reusableTestFirstOnRepair({ testWorkItemId: workItemId, testItem,
    consumerItems: consumers, repairPaths: origin?.repair_paths, sessionRegistry: results,
    pipelineId, stage });
}

function pendingDependency(state: any, manifest: any, registry: any[], item: any, leases: any[]): string | null {
  for (const dependency of Array.isArray(item?.depends_on) ? item.depends_on : []) {
    const unit = manifest.work_items.find((w: any) => w.id === dependency);
    if (!unit) continue;
    const stage = workItemStage(manifest, unit);
    if (leases.some((lease: any) => lease.pipeline_id === unit.pipeline_id && lease.work_item_id === dependency)) return dependency;
    if (!workItemDone(state, registry, unit.pipeline_id, dependency, stage, manifest)) return dependency;
  }
  return null;
}

function workItemRecord(manifest: any, manifestFile: string, unit: any): any {
  try { return JSON.parse(readFileSync(resolve(dirname(manifestFile), unit.path), 'utf8')); } catch { return {}; }
}

function workItemStage(manifest: any, unit: any): string | undefined {
  const pipeline = manifest.pipelines.find((p: any) => p.id === unit.pipeline_id);
  const agentStages = Object.entries(pipeline?.executors ?? {}).filter(([, executor]) => executor === 'agent').map(([stage]) => stage);
  return agentStages.length === 1 ? agentStages[0] : undefined;
}

// Machine plan of the next wave: for every agent stage that is runnable or in progress, the work items
// that can start now (dependencies done, no overlap with a running worker or with each other), the
// running ones, the done ones and the waiting ones with their reason.
export async function workItemWaves(root: string, run: string, pipelineFilter?: string) {
  if (!/^[A-Za-z0-9._-]+$/.test(run)) throw Error('INVALID_RUN_ID');
  const state = await validateState(join(root, '.tmp/pipelines'), run);
  if (!state.manifest_file) throw Error('RUN_NOT_DISPATCHABLE');
  const manifest = JSON.parse(await readFile(state.manifest_file, 'utf8'));
  const runRoot = join(root, '.tmp/pipelines', run);
  const leases = readLeases(runRoot, { state });
  const reservations = laneReservations(state, manifest, dirname(state.manifest_file), runRoot);
  const registry = sessionRegistry(root, run);
  const effectiveScope = [...new Set([...(manifest.allowed_change_paths ?? []), ...(state.runtime_scope_extensions ?? []).flatMap((e: any) => e.paths)])];
  const runnable = computeRunnable(state);
  const stages: any[] = [];
  const planned: Array<{ pipeline_id: string; stage: string; work_item_id: string; scope: string[] }> = [];
  for (const pipeline of manifest.pipelines) {
    if (pipelineFilter && pipeline.id !== pipelineFilter) continue;
    for (const [stage, executor] of Object.entries(pipeline.executors ?? {})) {
      if (executor !== 'agent') continue;
      const runtime = state.pipelines[pipeline.id]?.stages?.[stage];
      if (runtime?.status !== 'in_progress' && !runnable.some(r => r.pipeline_id === pipeline.id && r.stage === stage)) continue;
      const amendments = (state.owner_amendments ?? []).filter((a: any) => a.pipeline_id === pipeline.id);
      const amendmentItems = amendments.flatMap((a: any) => a.work_items ?? []);
      // Match actual per-item owner amendment scopes without an extra CLI call or per-item
      // filesystem pass. Stale evidence must not make the preview promise unsafe dispatch.
      const amendmentPathsByItem = new Map<string, string[]>();
      let amendmentEvidenceInvalid = false;
      for (const amendment of amendments) {
        try {
          const content = readFileSync(resolve(amendment.evidence_path), 'utf8');
          if (hash(content) !== amendment.evidence_sha256) throw Error('OWNER_AMENDMENT_EVIDENCE_CHANGED');
          const evidence = JSON.parse(content);
          const ids = [evidence.work_item_id, ...(evidence.work_items ?? []).map((unit: any) => unit.id)]
            .filter((id: unknown): id is string => typeof id === 'string');
          for (const id of ids) amendmentPathsByItem.set(id,
            [...new Set([...(amendmentPathsByItem.get(id) ?? []), ...(amendment.paths ?? [])])]);
        } catch { amendmentEvidenceInvalid = true; }
      }
      const units = [...manifest.work_items.filter((w: any) => pipeline.work_items.includes(w.id)), ...amendmentItems];
      const entry: any = { pipeline_id: pipeline.id, stage, status: runtime?.status ?? 'pending', dispatchable: [], running: [], done: [], waiting: [] };
      for (const unit of units) {
        const item = workItemRecord(manifest, state.manifest_file, unit);
        if (item.stage !== undefined && item.stage !== stage) continue;
        const self = { pipeline_id: pipeline.id, stage, work_item_id: unit.id };
        if (leases.some((lease: any) => sameDispatch(lease, self))) { entry.running.push(unit.id); continue; }
        if (workItemDone(state, registry, pipeline.id, unit.id, stage, manifest)) { entry.done.push(unit.id); continue; }
        const dependency = pendingDependency(state, manifest, registry, item, leases);
        if (dependency) { entry.waiting.push({ id: unit.id, reason: `depends_on ${dependency}` }); continue; }
        if (amendmentEvidenceInvalid) {
          entry.waiting.push({ id: unit.id, reason: 'OWNER_AMENDMENT_EVIDENCE_INVALID: revalidate approved amendment' });
          continue;
        }
        // The wave planner must include the same borrowed repair paths and current per-item
        // amendment paths as actual dispatch, never stale repair paths from the old review.
        const repairRuntime = runtime?.repair_origin_stage
          ? state.pipelines[runtime.repair_origin_pipeline ?? pipeline.id]?.stages[runtime.repair_origin_stage] : runtime;
        const repairScope = checkedScope([...(repairRuntime?.repair_paths ?? []),
          ...(amendmentPathsByItem.get(unit.id) ?? [])], effectiveScope);
        let ownScope: string[];
        try { ownScope = coderScope(item, effectiveScope); }
        catch {
          // The preview must not reserve *less* than dispatch when an item is invalid.
          // Fail closed: malformed/legacy work-item metadata conservatively uses the full scope.
          ownScope = effectiveScope;
        }
        const scope = writerScope(item, [...new Set([...ownScope, ...repairScope])], effectiveScope,
          readStagePaths(runRoot, pipeline.id, stage));
        const busy = leaseConflict([...leases, ...reservations.filter((lane: any) => lane.pipeline_id !== pipeline.id)], self, scope);
        if (busy) { entry.waiting.push({ id: unit.id, reason: `${busy.path} is being changed by ${busy.lease.work_item_id}` }); continue; }
        const sibling = planned.find(other => leaseConflict([other], self, scope));
        if (sibling) { entry.waiting.push({ id: unit.id, reason: `shares paths with ${sibling.work_item_id} in this wave` }); continue; }
        planned.push({ ...self, scope });
        entry.dispatchable.push(unit.id);
      }
      stages.push(entry);
    }
  }
  return { run_id: run, stages };
}

// The last reviewer dispatched on a review stage; completion requires it to be a full CodeReviewer.
export function reviewDispatchPath(root: string, run: string, pipelineId: string, stage: string): string {
  return join(root, '.tmp/pipelines', run, 'checks', 'review-dispatch', `${pipelineId}--${stage}.json`);
}

async function recordReviewDispatch(root: string, run: string, pipelineId: string, stage: string, role: string,
  loop: number, manifest: any, manifestFile: string) {
  const runRoot = join(root, '.tmp/pipelines', run);
  const pipeline = manifest.pipelines.find((item: any) => item.id === pipelineId);
  // A sink review sees interactions across source lanes; a source-lane review owns only
  // its local files. Both are pinned to the bytes the reviewer was dispatched to see.
  const scope = pipeline?.depends_on?.length ? [] : laneScope(manifest, dirname(manifestFile), runRoot, pipelineId);
  const inventory = await sourceInventory(root, (exe: string, argv: string[]) => inventoryInvoke(root, exe, argv), scope);
  if (!inventory.files || !inventory.digest) throw Error('REVIEW_SOURCE_INVENTORY_UNAVAILABLE');
  const sourceDigest = scope.length
    ? laneDigest(inventory.files, scope, manifest.generated_paths ?? []) : inventory.digest;
  if (!sourceDigest) throw Error('REVIEW_SOURCE_INVENTORY_UNAVAILABLE');
  const recordedAt = new Date().toISOString();
  const reviewDispatchId = hash(JSON.stringify([run, pipelineId, stage, role, loop, sourceDigest, recordedAt]));
  const record = { run_id: run, pipeline_id: pipelineId, stage, role, loop,
    source_scope: scope, source_digest: sourceDigest, review_dispatch_id: reviewDispatchId,
    recorded_at: recordedAt };
  const target = reviewDispatchPath(root, run, pipelineId, stage);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  await rename(temporary, target);
  return { review_dispatch_id: reviewDispatchId, review_source_digest: sourceDigest };
}

export async function dispatchPacket(root: string, run: string, pipelineId: string, stage: string, workItemId: string, role: string) {
  if (!/^[A-Za-z0-9._-]+$/.test(run)) throw Error('INVALID_RUN_ID');
  const state = await validateState(join(root, '.tmp/pipelines'), run);
  if (state.superseded_by || !state.manifest_file || !['approved', 'in_progress', 'ready', 'release_ready', 'blocked', 'failed'].includes(state.status)) throw Error('RUN_NOT_DISPATCHABLE');
  const manifest = resolveGateTestingFile(JSON.parse(await readFile(state.manifest_file, 'utf8')), state.manifest_file);
  const pipeline = manifest.pipelines.find((p: { id: string }) => p.id === pipelineId);
  const runtime = state.pipelines[pipelineId]?.stages[stage];
  if (!pipeline || (!computeRunnable(state).some(p => p.pipeline_id === pipelineId && p.stage === stage) && runtime?.status !== 'in_progress')) throw Error('STAGE_NOT_RUNNABLE');
  const executor = pipeline.executors[stage];
  // Cross-lane repair: the lane agent stage borrows the evidence/paths/loop of the sink gate in repair_origin_pipeline.
  const repairRuntime = runtime?.repair_origin_stage
    ? state.pipelines[runtime.repair_origin_pipeline ?? pipelineId]?.stages[runtime.repair_origin_stage] : runtime;
  if (!['agent', 'review'].includes(executor) || !roles.has(role) || (executor === 'review' && !REVIEW_ROLES.has(role)) || (executor !== 'review' && role === 'FindingsReviewer')) throw Error('INVALID_DISPATCH_ROLE');
  if (role === 'FindingsReviewer' && !(Number(runtime?.technical_fix_cycles ?? 0) > 0 && runtime?.repair_evidence)) throw Error('FINDINGS_REVIEW_NEEDS_ISSUED_FINDINGS');

  const amendmentRecords = (state.owner_amendments ?? []).filter((a: any) => a.pipeline_id === pipelineId);
  const amendmentItems = amendmentRecords.flatMap((a: any) => a.work_items ?? []);
  const stageReview = executor === 'review' && workItemId === stage;
  const frozen = stageReview ? { id: stage, pipeline_id: pipelineId, path: '', sha256: state.manifest_sha256 } : manifest.work_items.find((w: { id: string }) => w.id === workItemId) ?? amendmentItems.find((w: any) => w.id === workItemId);
  if (!frozen || frozen.pipeline_id !== pipelineId || (!stageReview && !pipeline.work_items.includes(workItemId) && !amendmentItems.some((w: any) => w.id === workItemId))) throw Error('WORK_ITEM_IDENTITY_MISMATCH');
  const workItemPath = stageReview ? state.manifest_file : resolve(dirname(state.manifest_file), frozen.path);
  const raw = await readFile(workItemPath, 'utf8');
  if (hash(raw) !== frozen.sha256) throw Error('WORK_ITEM_CHANGED');
  const item = stageReview ? {} : JSON.parse(raw);
  if (item.role && item.role !== role) throw Error('WORK_ITEM_ROLE_MISMATCH');
  if (!stageReview && item.stage !== undefined && item.stage !== stage) throw Error('WORK_ITEM_STAGE_MISMATCH');
  if (!stageReview && item.suggested_agent !== undefined && item.suggested_agent !== role) throw Error('WORK_ITEM_ROLE_MISMATCH');

  const amendmentEvidence: string[] = [];
  const relevantAmendments: any[] = [];
  const amendmentPaths: string[] = [];
  let runtimeAmendmentMatch = false;
  for (const amendment of amendmentRecords as any[]) {
    const file = resolve(amendment.evidence_path);
    let amendmentRaw: string;
    try {
      amendmentRaw = await readFile(file, 'utf8');
    } catch {
      throw Error('OWNER_AMENDMENT_EVIDENCE_MISSING');
    }
    if (hash(amendmentRaw) !== amendment.evidence_sha256) throw Error('OWNER_AMENDMENT_EVIDENCE_CHANGED');
    let evidence: unknown;
    try {
      evidence = JSON.parse(amendmentRaw);
    } catch {
      throw Error('OWNER_AMENDMENT_EVIDENCE_INVALID');
    }
    let validated;
    try {
      validated = validateOwnerAmendmentEvidence(evidence, manifest, pipelineId, amendment.source_stage, amendmentRecords.filter((a: any) => a.revision < amendment.revision).flatMap((a: any) => a.work_items ?? []));
    } catch (error) {
      throw Error(error instanceof Error ? error.message : 'OWNER_AMENDMENT_EVIDENCE_INVALID');
    }
    const normalize = (units: any[]) => units.map(({id,pipeline_id,path,sha256}) => ({id,pipeline_id,path,sha256}));
    if (JSON.stringify(normalize(validated.work_items)) !== JSON.stringify(normalize(amendment.work_items ?? []))) throw Error('OWNER_AMENDMENT_WORK_ITEM_IDENTITY_CHANGED');
    const relevant = stageReview || validated.work_item_id === workItemId || validated.work_items.some(w => w.id === workItemId);
    if (relevant) {
      if (!stageReview && validated.target_stage !== stage) throw Error('OWNER_AMENDMENT_TARGET_STAGE_MISMATCH');
      amendmentEvidence.push(file);
      relevantAmendments.push(amendment);
      amendmentPaths.push(...validated.paths);
      runtimeAmendmentMatch ||= !stageReview;
    }
  }

  const effectiveScope = [...new Set([...(manifest.allowed_change_paths ?? []), ...(state.runtime_scope_extensions ?? []).flatMap(e => e.paths)])];
  const refs = manifest.planning_readiness?.required_artifacts ?? {};
  const gates = Object.values(manifest.planning_readiness?.gates ?? {}).flatMap((g: any) => [g.artifact, g.review]).filter(Boolean);
  const referencePaths = [...Object.values(refs), ...gates].flatMap((v) => v && typeof v === 'object' && 'path' in v && typeof v.path === 'string' ? [resolve(dirname(state.manifest_file!), v.path)] : []);
  const evidencePaths = Object.values(state.pipelines[pipelineId].stages)
    .filter((s: any) => s.evidence && ['failed', 'blocked'].includes(s.evidence.status))
    .sort((a: any, b: any) => a.evidence.recorded_at.localeCompare(b.evidence.recorded_at))
    .flatMap((s: any) => s.evidence.artifacts ?? []).map((p: string) => resolve(root, p));
  if (repairRuntime?.repair_evidence) {
    const file = resolve(root, repairRuntime.repair_evidence.path);
    if (hash(await readFile(file, 'utf8')) !== repairRuntime.repair_evidence.sha256) throw Error('REPAIR_EVIDENCE_CHANGED');
    evidencePaths.push(file);
  }
  // Only an explicitly paired TestEngineer produces the RED-before-source baseline.
  // Do not charge an extra inventory to unrelated TestEngineer work items.
  const isIndependentRed = role === 'TestEngineer' && pipeline.work_items.some((id: string) => {
    const unit = manifest.work_items.find((candidate: any) => candidate.id === id);
    if (!unit) return false;
    const consumer = JSON.parse(readFileSync(resolve(dirname(state.manifest_file), unit.path), 'utf8'));
    return consumer.suggested_agent === 'CoderAgent' && consumer.stage === stage &&
      consumer.test_first_work_item_id === workItemId;
  });
  if (isIndependentRed) {
    const beforeRed = await sourceInventory(root, (exe: string, argv: string[]) => inventoryInvoke(root, exe, argv));
    if (!beforeRed.files || !beforeRed.digest) throw Error('TDD_RED_SOURCE_INVENTORY_UNAVAILABLE');
    await recordTestFirstBaseline(root, { run_id: run, pipeline_id: pipelineId, stage,
      work_item_id: workItemId, work_item_sha256: frozen.sha256,
      manifest_sha256: state.manifest_sha256, source_digest: beforeRed.digest, files: beforeRed.files });
  }
  const revision = hash(JSON.stringify({ manifest: state.manifest_sha256, runtime, repairRuntime, effectiveScope, ownerAmendments: relevantAmendments }));
  const baseChecks = affectedAdvisoryChecks(manifest, pipeline, role);
  let redBaseline: any = null;
  let redScope: string[] = [];
  if (role === 'CoderAgent' && typeof item.test_first_work_item_id === 'string') {
    const testUnit = manifest.work_items.find((unit: any) => unit.id === item.test_first_work_item_id);
    if (!testUnit || testUnit.pipeline_id !== pipelineId) throw Error('TDD_RED_WORK_ITEM_NOT_FROZEN');
    const testItem = JSON.parse(await readFile(resolve(dirname(state.manifest_file), testUnit.path), 'utf8'));
    if (testItem.suggested_agent !== 'TestEngineer' || testItem.stage !== stage ||
        !Array.isArray(item.depends_on) || !item.depends_on.includes(testUnit.id)) {
      throw Error('TDD_RED_WORK_ITEM_DEPENDENCY_INVALID');
    }
    if (!baseChecks.length) throw Error('TDD_GREEN_AFFECTED_CHECK_REQUIRED: give the consuming lane a frozen affected test profile');
    redScope = checkedScope(testItem.allowed_change_paths ?? [], effectiveScope);
    if (!redScope.length) throw Error('TDD_RED_SCOPE_MISSING');
    redBaseline = await requireTestFirstBaseline(root, { run_id: run, pipeline_id: pipelineId,
      stage, work_item_id: testUnit.id, work_item_sha256: testUnit.sha256,
      manifest_sha256: state.manifest_sha256 });
  }
  let itemScope = role === 'CoderAgent' ? coderScope(item, effectiveScope) : [];
  if (role === 'CoderAgent' && baseChecks.length > 0 && itemScope.length === 0 && runtimeAmendmentMatch) {
    itemScope = checkedScope(amendmentPaths, effectiveScope);
  }
  if (role === 'CoderAgent' && baseChecks.length > 0 && itemScope.length === 0 && item.stage === undefined) {
    // Compatibility for already-frozen v2 work items created before per-work-item scope binding.
    itemScope = checkedScope(effectiveScope, effectiveScope);
  }
  if (role === 'CoderAgent' && baseChecks.length > 0 && itemScope.length === 0) throw Error('WORK_ITEM_ADVISORY_SCOPE_MISSING');
  // A repair may touch authorized paths outside the work item's own scope. The bound check must
  // see those edits: they select affected suites, change the no-progress fingerprint and make an
  // earlier PASS stale. Otherwise a PASS stays "fresh" after the repaired files change.
  const repairPaths = [...new Set([...(repairRuntime?.repair_paths ?? []), ...amendmentPaths])];
  const boundScope = role === 'CoderAgent' && itemScope.length > 0
    ? [...new Set([...itemScope, ...redScope, ...checkedScope(repairPaths, effectiveScope)])] : itemScope;
  // Writers never start on paths another live worker may change, nor before their dependencies return.
  const writeScope = executor === 'agent' ? writerScope(item, boundScope, effectiveScope, readStagePaths(join(root, '.tmp/pipelines', run), pipelineId, stage)) : [];
  if (executor === 'agent' && !stageReview) {
    const leases = readLeases(join(root, '.tmp/pipelines', run), { state });
    const dependency = pendingDependency(state, manifest, sessionRegistry(root, run), item, leases);
    if (dependency) throw Error(`DISPATCH_DEPENDENCY_PENDING: ${workItemId} waits for ${dependency}; run stage-cli waves ${run} for what can start now`);
    const reserved = laneReservations(state, manifest, dirname(state.manifest_file), join(root, '.tmp/pipelines', run)).filter((lane: any) => lane.pipeline_id !== pipelineId);
    const busy = leaseConflict([...leases, ...reserved], { pipeline_id: pipelineId, stage, work_item_id: workItemId }, writeScope);
    if (busy) throw Error(`DISPATCH_SCOPE_BUSY: ${workItemId} waits for ${busy.lease.work_item_id} (${busy.lease.pipeline_id}/${busy.lease.stage}), both change ${busy.path}; run stage-cli waves ${run} for what can start now`);
  }
  let advisoryChecks: Array<Record<string, unknown>> = [];
  if (baseChecks.length) {
    const baseProbe = await requireBaseProbe(root, run, state.manifest_file, manifest, pipeline, baseChecks.map(check => check.gate), item, effectiveScope);
    const inventory = await sourceInventory(root, (exe: string, argv: string[]) => inventoryInvoke(root, exe, argv));
    if (!inventory.files || !inventory.digest) throw Error('ADVISORY_BASELINE_UNAVAILABLE');
    // A CoderAgent dispatch happens after TestEngineer has already written RED tests.
    // Compare against BEFORE those tests to make --affected pick up their exact files.
    if (redBaseline) {
      const testChanges = changedFromInventory(inventory.files, redBaseline.files, redScope);
      if (!testChanges?.length) throw Error('TDD_RED_TEST_CHANGE_MISSING: TestEngineer must deliver executable tests first');
    }
    const baseline = await writeBaseline(root, run, {
      schema_version: 1,
      run_id: run,
      pipeline_id: pipelineId,
      stage,
      work_item_id: workItemId,
      manifest_sha256: state.manifest_sha256,
      state_revision: revision,
      allowed_change_paths: boundScope,
      repair_paths: repairPaths,
      // The repair loop this dispatch serves: completion of a reopened stage needs bound evidence
      // only from the current loop, not from work items the repair did not redispatch.
      loop: repairRuntime?.technical_fix_cycles ?? 0,
      repair_origin_stage: runtime?.repair_origin_stage ?? null,
      repair_origin_pipeline: runtime?.repair_origin_stage ? (runtime.repair_origin_pipeline ?? pipelineId) : null,
      base_probe: baseProbe,
      source_digest: redBaseline?.source_digest ?? inventory.digest,
      files: redBaseline?.files ?? inventory.files,
      recorded_at: new Date().toISOString(),
    });
    // Exact allowlisted invocations (literal `$HOME`, matching CoderAgent's bash permission): the
    // worker executes them verbatim instead of reconstructing a command that the allowlist rejects.
    advisoryChecks = baseChecks.map(check => ({ ...check, work_item_id: workItemId, baseline_path: baseline.path, baseline_sha256: baseline.sha256,
      command: `${GATE_RUNNER} ${run} ${pipelineId} ${check.gate} --advisory --affected --work-item ${workItemId} --baseline ${baseline.path} --baseline-sha256 ${baseline.sha256}`,
      focus_command: `${GATE_RUNNER} ${run} ${pipelineId} ${check.gate} --advisory --command-index <frozen_commands[].index> --test-file <repo-relative vitest file>`,
      // Foreground with a long timeout: the worker sees the exit itself. A background shell wakes
      // only the child session, so its completion never reached the parent.
      shell: { background: false, timeout: 3_600_000 },
      frozen_commands: (manifest.gate_profiles[pipeline.profile][check.gate] as string[]).map((command, index) => ({ index, command })),
      ...(redBaseline ? { test_first_work_item_id: item.test_first_work_item_id } : {}) }));
  }
  const reviewProof = executor === 'review'
    ? await recordReviewDispatch(root, run, pipelineId, stage, role, Number(runtime?.technical_fix_cycles ?? 0), manifest, state.manifest_file)
    : undefined;
  return { run_id: run, pipeline_id: pipelineId, stage, executor, role, work_item_id: workItemId,
    // The orchestrator passes a path; only the targeted worker reads these stage rules.
    ...(executor === 'agent' && RUN_WORKER_RULE_ROLES.has(role) ? { run_stage_rules_path: RUN_WORKER_RULES } : {}),
    work_item_path: workItemPath, work_item_sha256: frozen.sha256, authoritative_paths: [state.manifest_file, state.rules_file, ...referencePaths, ...amendmentEvidence],
    ...(reviewProof ?? {}),
    review_work_items: stageReview ? [...manifest.work_items.filter((w: any) => pipeline.work_items.includes(w.id)), ...amendmentItems].map((w: any) => ({ id: w.id, path: resolve(dirname(state.manifest_file), w.path), sha256: w.sha256 })) : undefined,
    context_paths: (item.context_files ?? []).map((p: string) => resolve(root, p)), reference_paths: (item.reference_files ?? []).map((p: string) => resolve(root, p)),
    decision_ids: item.decision_ids ?? pipeline.decision_ids ?? [], research_ids: item.research_ids ?? pipeline.research_ids ?? [], contract_ids: item.contract_ids ?? pipeline.contract_ids ?? [],
    effective_scope: effectiveScope, work_item_scope: itemScope, write_scope: writeScope, repair_paths: repairPaths, state_revision: revision, loop: repairRuntime?.technical_fix_cycles ?? 0,
    repair_origin_stage: runtime?.repair_origin_stage,
    repair_origin_pipeline: runtime?.repair_origin_stage ? (runtime.repair_origin_pipeline ?? pipelineId) : undefined,
    evidence_paths: [...new Set(evidencePaths)],
    advisory_checks: advisoryChecks,
    reuse: { eligible: executor === 'agent' && ['CoderAgent', 'TestEngineer', 'BuildAgent'].includes(role) },
    marker: `<pipeline_work_item id="${workItemId}"/>` };
}
