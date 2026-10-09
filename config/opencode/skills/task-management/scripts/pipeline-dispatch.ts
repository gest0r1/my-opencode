import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { computeRunnable, validateState } from './stage-cli-core.ts';
import { validateOwnerAmendmentEvidence } from './owner-amendment-policy.ts';
import { sourceInventory } from './gate-diagnostics.mjs';

const roles = new Set(['CoderAgent', 'TestEngineer', 'BuildAgent', 'CodeReviewer', 'DocWriter', 'OpenDevopsSpecialist', 'OpenFrontendSpecialist']);
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
  const result = spawnSync(exe, argv, { cwd: root, shell: false, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 30_000 });
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
  const content = `${JSON.stringify(payload, null, 2)}\n`;
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, target);
  return { path: relative, sha256: hash(content) };
}

export async function dispatchPacket(root: string, run: string, pipelineId: string, stage: string, workItemId: string, role: string) {
  if (!/^[A-Za-z0-9._-]+$/.test(run)) throw Error('INVALID_RUN_ID');
  const state = await validateState(join(root, '.tmp/pipelines'), run);
  if (state.superseded_by || !state.manifest_file || !['approved', 'in_progress', 'ready', 'release_ready', 'blocked', 'failed'].includes(state.status)) throw Error('RUN_NOT_DISPATCHABLE');
  const manifest = JSON.parse(await readFile(state.manifest_file, 'utf8'));
  const pipeline = manifest.pipelines.find((p: { id: string }) => p.id === pipelineId);
  const runtime = state.pipelines[pipelineId]?.stages[stage];
  if (!pipeline || (!computeRunnable(state).some(p => p.pipeline_id === pipelineId && p.stage === stage) && runtime?.status !== 'in_progress')) throw Error('STAGE_NOT_RUNNABLE');
  const executor = pipeline.executors[stage];
  const repairRuntime = runtime?.repair_origin_stage
    ? state.pipelines[pipelineId].stages[runtime.repair_origin_stage] : runtime;
  if (!['agent', 'review'].includes(executor) || !roles.has(role) || (executor === 'review' && role !== 'CodeReviewer')) throw Error('INVALID_DISPATCH_ROLE');

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
  let advisoryChecks: Array<Record<string, unknown>> = [];
  if (baseChecks.length) {
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
      allowed_change_paths: itemScope,
      source_digest: inventory.digest,
      files: inventory.files,
      recorded_at: new Date().toISOString(),
    });
    advisoryChecks = baseChecks.map(check => ({ ...check, work_item_id: workItemId, baseline_path: baseline.path, baseline_sha256: baseline.sha256 }));
  }
  return { run_id: run, pipeline_id: pipelineId, stage, executor, role, work_item_id: workItemId,
    work_item_path: workItemPath, work_item_sha256: frozen.sha256, authoritative_paths: [state.manifest_file, state.rules_file, ...referencePaths, ...amendmentEvidence],
    review_work_items: stageReview ? [...manifest.work_items.filter((w: any) => pipeline.work_items.includes(w.id)), ...amendmentItems].map((w: any) => ({ id: w.id, path: resolve(dirname(state.manifest_file), w.path), sha256: w.sha256 })) : undefined,
    context_paths: (item.context_files ?? []).map((p: string) => resolve(root, p)), reference_paths: (item.reference_files ?? []).map((p: string) => resolve(root, p)),
    decision_ids: item.decision_ids ?? pipeline.decision_ids ?? [], research_ids: item.research_ids ?? pipeline.research_ids ?? [], contract_ids: item.contract_ids ?? pipeline.contract_ids ?? [],
    effective_scope: effectiveScope, work_item_scope: itemScope, repair_paths: [...new Set([...(repairRuntime?.repair_paths ?? []), ...amendmentPaths])], state_revision: revision, loop: repairRuntime?.technical_fix_cycles ?? 0,
    repair_origin_stage: runtime?.repair_origin_stage,
    evidence_paths: [...new Set(evidencePaths)],
    advisory_checks: advisoryChecks,
    reuse: { eligible: executor === 'agent' && ['CoderAgent', 'TestEngineer', 'BuildAgent'].includes(role) },
    marker: `<pipeline_work_item id="${workItemId}"/>` };
}
