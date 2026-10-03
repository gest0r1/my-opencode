import { readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { computeRunnable, validateState } from './stage-cli-core.ts';
import { validateOwnerAmendmentEvidence } from './owner-amendment-policy.ts';

const roles = new Set(['CoderAgent', 'TestEngineer', 'BuildAgent', 'CodeReviewer', 'DocWriter', 'OpenDevopsSpecialist', 'OpenFrontendSpecialist']);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export async function dispatchPacket(root: string, run: string, pipelineId: string, stage: string, workItemId: string, role: string) {
  if (!/^[A-Za-z0-9._-]+$/.test(run)) throw Error('INVALID_RUN_ID');
  const state = await validateState(join(root, '.tmp/pipelines'), run);
  if (state.superseded_by || !state.manifest_file || !['approved', 'in_progress', 'ready', 'release_ready', 'blocked', 'failed'].includes(state.status)) throw Error('RUN_NOT_DISPATCHABLE');
  const manifest = JSON.parse(await readFile(state.manifest_file, 'utf8'));
  const pipeline = manifest.pipelines.find((p: { id: string }) => p.id === pipelineId);
  const runtime = state.pipelines[pipelineId]?.stages[stage];
  if (!pipeline || (!computeRunnable(state).some(p => p.pipeline_id === pipelineId && p.stage === stage) && runtime?.status !== 'in_progress')) throw Error('STAGE_NOT_RUNNABLE');
  const executor = pipeline.executors[stage];
  if (!['agent', 'review'].includes(executor) || !roles.has(role) || (executor === 'review' && role !== 'CodeReviewer')) throw Error('INVALID_DISPATCH_ROLE');

  // Owner amendments are overlays on existing frozen work items only. Keep this
  // deterministic guard even though owner-amend-apply validates the same rule:
  // imported/legacy/tampered state must never make a new runtime work item executable.
  const amendmentRecords = (state.owner_amendments ?? []).filter((a: any) => a.pipeline_id === pipelineId);
  if (amendmentRecords.some((a: any) => (a.work_items ?? []).length > 0)) {
    throw Error('FULL_REPLAN_REQUIRED_NEW_WORK_ITEM');
  }

  const frozen = manifest.work_items.find((w: { id: string }) => w.id === workItemId);
  if (!frozen || !pipeline.work_items.includes(workItemId) || frozen.pipeline_id !== pipelineId) throw Error('WORK_ITEM_IDENTITY_MISMATCH');
  const workItemPath = resolve(dirname(state.manifest_file), frozen.path);
  const raw = await readFile(workItemPath, 'utf8');
  if (hash(raw) !== frozen.sha256) throw Error('WORK_ITEM_CHANGED');
  const item = JSON.parse(raw);
  if (item.role && item.role !== role) throw Error('WORK_ITEM_ROLE_MISMATCH');

  const amendmentEvidence: string[] = [];
  const relevantAmendments: any[] = [];
  const amendmentPaths: string[] = [];
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
      validated = validateOwnerAmendmentEvidence(evidence, manifest, pipelineId, amendment.source_stage);
    } catch (error) {
      throw Error(error instanceof Error ? error.message : 'OWNER_AMENDMENT_EVIDENCE_INVALID');
    }
    if (validated.work_item_id === workItemId) {
      amendmentEvidence.push(file);
      relevantAmendments.push(amendment);
      amendmentPaths.push(...validated.paths);
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
  if (runtime?.repair_evidence) {
    const file = resolve(root, runtime.repair_evidence.path);
    if (hash(await readFile(file, 'utf8')) !== runtime.repair_evidence.sha256) throw Error('REPAIR_EVIDENCE_CHANGED');
    evidencePaths.push(file);
  }
  const revision = hash(JSON.stringify({ manifest: state.manifest_sha256, runtime, effectiveScope, ownerAmendments: relevantAmendments }));
  return { run_id: run, pipeline_id: pipelineId, stage, executor, role, work_item_id: workItemId,
    work_item_path: workItemPath, work_item_sha256: frozen.sha256, authoritative_paths: [state.manifest_file, state.rules_file, ...referencePaths, ...amendmentEvidence],
    context_paths: (item.context_files ?? []).map((p: string) => resolve(root, p)), reference_paths: (item.reference_files ?? []).map((p: string) => resolve(root, p)),
    decision_ids: item.decision_ids ?? pipeline.decision_ids ?? [], research_ids: item.research_ids ?? pipeline.research_ids ?? [], contract_ids: item.contract_ids ?? pipeline.contract_ids ?? [],
    effective_scope: effectiveScope, repair_paths: [...new Set([...(runtime?.repair_paths ?? []), ...amendmentPaths])], state_revision: revision, loop: runtime?.technical_fix_cycles ?? 0,
    evidence_paths: [...new Set(evidencePaths)],
    reuse: { eligible: executor === 'agent' && ['CoderAgent', 'TestEngineer', 'BuildAgent'].includes(role) },
    marker: `<pipeline_work_item id="${workItemId}"/>` };
}
