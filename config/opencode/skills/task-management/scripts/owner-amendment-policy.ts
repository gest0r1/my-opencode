import { readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

export interface OwnerAmendmentEvidence {
  kind: 'owner_amendment';
  status: 'ready';
  bounded: true;
  pipeline_id: string;
  source_stage: string;
  target_stage: string;
  work_item_id: string;
  new_work_item_required?: boolean;
  summary?: string;
  paths: string[];
  work_items: Array<{ id: string; pipeline_id: string; path: string; sha256: string }>;
  requirements_changed: boolean;
  acceptance_criteria_changed: boolean;
  business_intent_changed: false;
  external_contract_changed: false;
  security_boundary_changed: false;
  destructive_change: false;
}

function safeRepoPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false;
  const parts = value.split('/');
  return !parts.includes('..') && !parts.includes('.git');
}

function safeRuntimePath(value: unknown): value is string {
  return safeRepoPath(value) && !/[?*\[\]{}]/.test(value);
}

function assertExplicitBoolean(evidence: Record<string, unknown>, field: string): void {
  if (typeof evidence[field] !== 'boolean') {
    throw new Error(`OWNER_AMENDMENT_INVALID: ${field} must be explicit true|false`);
  }
}

export function validateOwnerAmendmentEvidence(
  evidence: unknown,
  manifest: any,
  pipelineId: string,
  sourceStage: string,
  priorWorkUnits: any[] = [],
): OwnerAmendmentEvidence {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new Error('OWNER_AMENDMENT_INVALID: evidence must be a JSON object');
  }
  const item = evidence as Record<string, unknown>;
  if (item.kind !== 'owner_amendment' || item.status !== 'ready' || item.bounded !== true) {
    throw new Error('OWNER_AMENDMENT_INVALID: ready bounded owner amendment evidence required');
  }
  if (item.pipeline_id !== pipelineId || item.source_stage !== sourceStage) {
    throw new Error('OWNER_AMENDMENT_INVALID: pipeline_id/source_stage does not match the owner checkpoint');
  }

  for (const field of [
    'requirements_changed',
    'acceptance_criteria_changed',
    'business_intent_changed',
    'external_contract_changed',
    'security_boundary_changed',
    'destructive_change',
  ]) assertExplicitBoolean(item, field);

  if (!Array.isArray(item.work_items)) throw new Error('OWNER_AMENDMENT_INVALID: work_items must be an array');
  const ids = new Set<string>();
  for (const work of item.work_items as any[]) {
    if (!work || typeof work.id !== 'string' || !work.id || ids.has(work.id) ||
        work.pipeline_id !== pipelineId || !safeRuntimePath(work.path) || !work.path.startsWith('work-items/') ||
        !/^[0-9a-f]{64}$/i.test(String(work.sha256 ?? '')) || (manifest?.work_items ?? []).concat(priorWorkUnits).some((w: any) => w.id === work.id)) {
      throw new Error('OWNER_AMENDMENT_INVALID: invalid or duplicate runtime work unit');
    }
    ids.add(work.id);
  }

  if (
    item.business_intent_changed !== false ||
    item.external_contract_changed !== false ||
    item.security_boundary_changed !== false ||
    item.destructive_change !== false
  ) {
    throw new Error('FULL_REPLAN_REQUIRED: owner amendment crosses a structural PLAN boundary');
  }

  const pipeline = manifest?.pipelines?.find((candidate: any) => candidate?.id === pipelineId);
  if (!pipeline) throw new Error(`OWNER_AMENDMENT_INVALID: pipeline not found: ${pipelineId}`);
  if (typeof item.work_item_id !== 'string' || !item.work_item_id) {
    throw new Error('OWNER_AMENDMENT_INVALID: work_item_id is required');
  }
  const frozenWorkItem = (manifest?.work_items ?? []).concat(priorWorkUnits).find((candidate: any) => candidate?.id === item.work_item_id);
  if ((!frozenWorkItem || frozenWorkItem.pipeline_id !== pipelineId || !pipeline.work_items?.includes(item.work_item_id) && !priorWorkUnits.some(w => w.id === item.work_item_id)) && !ids.has(item.work_item_id)) {
    throw new Error('OWNER_AMENDMENT_INVALID: work_item_id must be frozen or explicitly supplied as an approved runtime work unit');
  }

  if (typeof item.target_stage !== 'string' || !pipeline.stages?.includes(item.target_stage) || pipeline.executors?.[item.target_stage] !== 'agent') {
    throw new Error('OWNER_AMENDMENT_INVALID: target_stage must be an existing agent stage');
  }
  if (!Array.isArray(item.paths) || item.paths.length === 0 || item.paths.some((path) => !safeRuntimePath(path))) {
    throw new Error('OWNER_AMENDMENT_INVALID: paths must be a non-empty array of exact safe repository paths');
  }
  if (new Set(item.paths).size !== item.paths.length) {
    throw new Error('OWNER_AMENDMENT_INVALID: paths must be unique');
  }

  return item as unknown as OwnerAmendmentEvidence;
}

export async function validateOwnerAmendmentForApply(input: {
  stateRoot: string;
  runId: string;
  pipelineId: string;
  sourceStage: string;
  evidencePath: string;
}): Promise<{ evidence: OwnerAmendmentEvidence; absoluteEvidencePath: string }> {
  const runRoot = resolve(input.stateRoot, input.runId);
  const absoluteEvidencePath = resolve(input.evidencePath);
  const rel = relative(runRoot, absoluteEvidencePath);
  if (!rel || rel.startsWith('..') || rel.startsWith('/') || rel.includes('\\')) {
    throw new Error('OWNER_AMENDMENT_INVALID: evidence must live inside the current run directory');
  }

  const state = JSON.parse(await readFile(join(runRoot, 'state.json'), 'utf8')) as any;
  if (!state.manifest_file) throw new Error('OWNER_AMENDMENT_INVALID: frozen manifest is missing');
  const manifest = JSON.parse(await readFile(resolve(state.manifest_file), 'utf8')) as any;
  let raw: string;
  try {
    raw = await readFile(absoluteEvidencePath, 'utf8');
  } catch {
    throw new Error(`OWNER_AMENDMENT_INVALID: evidence not found: ${input.evidencePath}`);
  }
  let evidence: unknown;
  try {
    evidence = JSON.parse(raw);
  } catch {
    throw new Error('OWNER_AMENDMENT_INVALID: evidence is not valid JSON');
  }

  return {
    evidence: validateOwnerAmendmentEvidence(evidence, manifest, input.pipelineId, input.sourceStage, (state.owner_amendments ?? []).flatMap((a: any) => a.work_items ?? [])),
    absoluteEvidencePath,
  };
}
