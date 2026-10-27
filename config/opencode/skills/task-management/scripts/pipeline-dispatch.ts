import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { computeRunnable, validateState } from './stage-cli-core.ts';
import { validateOwnerAmendmentEvidence } from './owner-amendment-policy.ts';
import { resolveGateTestingFile } from './gate-testing-policy.mjs';
import { sourceInventory } from './gate-diagnostics.mjs';
import { gitReadEnv } from './git-readonly.mjs';
import { planProbeCommandsSha256 } from './manifest-v2-policy.mjs';

const roles = new Set(['CoderAgent', 'TestEngineer', 'BuildAgent', 'CodeReviewer', 'FindingsReviewer', 'DocWriter', 'OpenDevopsSpecialist', 'OpenFrontendSpecialist']);
// A review stage runs a full CodeReviewer; FindingsReviewer (cheaper model) only re-checks findings a review already issued.
const REVIEW_ROLES = new Set(['CodeReviewer', 'FindingsReviewer']);
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

const GATE_RUNNER = 'npx --yes tsx $HOME/.config/opencode/skills/task-management/scripts/gate-runner-cli.ts';

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
        if (probe?.kind !== 'plan_probe' || probe.run_id !== run || probe.profile !== pipeline.profile || probe.gate !== gate ||
            !Array.isArray(commands) || probe.commands_sha256 !== planProbeCommandsSha256(commands)) continue;
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

// The last reviewer dispatched on a review stage; completion requires it to be a full CodeReviewer.
export function reviewDispatchPath(root: string, run: string, pipelineId: string, stage: string): string {
  return join(root, '.tmp/pipelines', run, 'checks', 'review-dispatch', `${pipelineId}--${stage}.json`);
}

async function recordReviewDispatch(root: string, run: string, pipelineId: string, stage: string, role: string, loop: number) {
  const target = reviewDispatchPath(root, run, pipelineId, stage);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify({ run_id: run, pipeline_id: pipelineId, stage, role, loop, recorded_at: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  await rename(temporary, target);
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
  const revision = hash(JSON.stringify({ manifest: state.manifest_sha256, runtime, repairRuntime, effectiveScope, ownerAmendments: relevantAmendments }));
  const baseChecks = affectedAdvisoryChecks(manifest, pipeline, role);
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
    ? [...new Set([...itemScope, ...checkedScope(repairPaths, effectiveScope)])] : itemScope;
  let advisoryChecks: Array<Record<string, unknown>> = [];
  if (baseChecks.length) {
    const baseProbe = await requireBaseProbe(root, run, state.manifest_file, manifest, pipeline, baseChecks.map(check => check.gate), item, effectiveScope);
    const inventory = await sourceInventory(root, (exe: string, argv: string[]) => inventoryInvoke(root, exe, argv));
    if (!inventory.files || !inventory.digest) throw Error('ADVISORY_BASELINE_UNAVAILABLE');
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
      source_digest: inventory.digest,
      files: inventory.files,
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
      frozen_commands: (manifest.gate_profiles[pipeline.profile][check.gate] as string[]).map((command, index) => ({ index, command })) }));
  }
  if (executor === 'review') await recordReviewDispatch(root, run, pipelineId, stage, role, Number(runtime?.technical_fix_cycles ?? 0));
  return { run_id: run, pipeline_id: pipelineId, stage, executor, role, work_item_id: workItemId,
    work_item_path: workItemPath, work_item_sha256: frozen.sha256, authoritative_paths: [state.manifest_file, state.rules_file, ...referencePaths, ...amendmentEvidence],
    review_work_items: stageReview ? [...manifest.work_items.filter((w: any) => pipeline.work_items.includes(w.id)), ...amendmentItems].map((w: any) => ({ id: w.id, path: resolve(dirname(state.manifest_file), w.path), sha256: w.sha256 })) : undefined,
    context_paths: (item.context_files ?? []).map((p: string) => resolve(root, p)), reference_paths: (item.reference_files ?? []).map((p: string) => resolve(root, p)),
    decision_ids: item.decision_ids ?? pipeline.decision_ids ?? [], research_ids: item.research_ids ?? pipeline.research_ids ?? [], contract_ids: item.contract_ids ?? pipeline.contract_ids ?? [],
    effective_scope: effectiveScope, work_item_scope: itemScope, repair_paths: repairPaths, state_revision: revision, loop: repairRuntime?.technical_fix_cycles ?? 0,
    repair_origin_stage: runtime?.repair_origin_stage,
    repair_origin_pipeline: runtime?.repair_origin_stage ? (runtime.repair_origin_pipeline ?? pipelineId) : undefined,
    evidence_paths: [...new Set(evidencePaths)],
    advisory_checks: advisoryChecks,
    reuse: { eligible: executor === 'agent' && ['CoderAgent', 'TestEngineer', 'BuildAgent'].includes(role) },
    marker: `<pipeline_work_item id="${workItemId}"/>` };
}
