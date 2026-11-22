import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { requireOwnerCheckpoint, ownerBrokerRequired, agentBrokerAction } from './owner-broker-client.mjs';

const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

/** Builds a deterministic checkpoint from frozen runtime state, not owner CLI flags. */
export async function buildOwnerCheckpoint(
  state: any,
  operation: 'plan.final_manifest.approve' | 'owner.accept',
  pipelineId = 'all',
  stage = 'approval',
): Promise<Record<string, unknown>> {
  if (!state.manifest_file || !/^[a-f0-9]{64}$/.test(String(state.manifest_sha256 || ''))) {
    throw new Error('OWNER_CHECKPOINT_FROZEN_MANIFEST_REQUIRED');
  }
  const root = dirname(resolve(state.manifest_file));
  const raw = await readFile(state.manifest_file, 'utf8');
  if (sha(raw) !== state.manifest_sha256) throw new Error('OWNER_CHECKPOINT_MANIFEST_STALE');
  const run = String(state.run_id ?? '');
  const created = String(state.created_at ?? '');
  const worktree = String(state.worktree_root ?? '');
  const runInstanceId = sha([run, created, worktree].join('\u0000'));
  let candidateSha = '';
  let subjectSha = state.manifest_sha256;
  if (operation === 'owner.accept') {
    const candidate = JSON.parse(await readFile(join(root, 'candidate.json'), 'utf8'));
    candidateSha = String(candidate.candidate_sha || '').toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(candidateSha) && !/^[a-f0-9]{64}$/.test(candidateSha)) {
      throw new Error('OWNER_CHECKPOINT_CANDIDATE_REQUIRED');
    }
    // Broker tuple requires sha256 bytes; git SHA-1 is represented in an
    // unambiguous SHA-256 digest while preserving the source revision value.
    const proofs: Array<{ pipeline: string; stage: string; evidence: unknown; artifacts: Array<{ path: string; sha256: string }> }> = [];
    const pipeline: any = state.pipelines?.[pipelineId];
    if (!pipeline) throw new Error('OWNER_CHECKPOINT_PIPELINE_MISSING');
    const stageOrder = Array.isArray(pipeline.stage_order) ? pipeline.stage_order : Object.keys(pipeline.stages || {});
    if (!stageOrder.includes(stage)) throw new Error('OWNER_CHECKPOINT_STAGE_MISSING');
    for (const name of stageOrder) {
      if (name === stage) break; // owner acceptance never hashes its own outcome
      const entry: any = pipeline.stages?.[name];
      if (!entry || !['completed','skipped'].includes(entry.status)) {
        throw new Error('OWNER_CHECKPOINT_PREREQUISITES_INCOMPLETE');
      }
      const artifacts: Array<{ path: string; sha256: string }> = [];
      for (const artifact of entry.evidence?.artifacts || []) {
        if (typeof artifact !== 'string') throw new Error('OWNER_CHECKPOINT_INVALID_ARTIFACT');
        const filename = resolve(isAbsolute(artifact) ? artifact : join(root, artifact));
        if (filename === root || !filename.startsWith(root + sep)) {
          throw new Error('OWNER_CHECKPOINT_ARTIFACT_OUTSIDE_RUN');
        }
        artifacts.push({ path: filename.slice(root.length + 1), sha256: sha(await readFile(filename)) });
      }
      proofs.push({ pipeline: pipelineId, stage: name, evidence: entry.evidence || null, artifacts });
    }
    subjectSha = sha(JSON.stringify({ manifestSha: state.manifest_sha256, candidateSha, pipelineId, stage, proofs }));
  }
  return {
    run_instance_id: runInstanceId,
    run_id: run,
    operation,
    pipeline_id: pipelineId,
    stage,
    generation: 1,
    manifest_sha256: state.manifest_sha256,
    subject_sha256: subjectSha,
    candidate_sha: candidateSha,
  };
}

export async function authorizeOwnerCheckpoint(
  state: any,
  operation: 'plan.final_manifest.approve' | 'owner.accept',
  pipelineId = 'all',
  stage = 'approval',
): Promise<{ mode: 'legacy' | 'broker'; id?: string }> {
  if (!ownerBrokerRequired()) return { mode: 'legacy' };
  return requireOwnerCheckpoint(await buildOwnerCheckpoint(state, operation, pipelineId, stage));
}

/** A mutable state.json is never an authority. Verify receipt against
 * broker's root-owned ledger before accepting projected owner success.
 */
export async function verifyOwnerCheckpointReceipt(
  state: any, operation: 'plan.final_manifest.approve' | 'owner.accept',
  requestId: string | undefined, pipelineId = 'all', stage = 'approval',
): Promise<void> {
  if (!ownerBrokerRequired()) return;
  if (!/^[a-f0-9]{32}$/.test(String(requestId || ''))) {
    throw new Error('OWNER_BROKER_RECEIPT_REQUIRED');
  }
  const checkpoint = await buildOwnerCheckpoint(state, operation, pipelineId, stage);
  const result = await agentBrokerAction({ action: 'status', checkpoint, request_id: requestId });
  if (result.authorized !== true || result.request_id !== requestId || result.consumed !== true) {
    throw new Error('OWNER_BROKER_RECEIPT_INVALID');
  }
}