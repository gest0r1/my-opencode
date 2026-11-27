import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { requireOwnerCheckpoint, ownerBrokerRequired, agentBrokerAction, passkeyBrokerRequired, ownerPasskeyUrl } from './owner-broker-client.mjs';

const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

type OwnerOperation = 'plan.final_manifest.approve' | 'owner.accept' | 'owner.amend' | 'plan.unfreeze' | 'plan.unfreeze.abort';

export function ownerAmendmentSnapshot(state: { run_id: string; manifest_sha256?: string },
  pipelineId: string, stage: string, revision: number, raw: string) {
  return JSON.stringify({ run_id: state.run_id, manifest_sha256: state.manifest_sha256, pipeline_id: pipelineId,
    stage, revision, evidence_sha256: sha(raw), proposal: JSON.parse(raw) });
}

export async function authorizePasskeyCheckpoint(
  input: { runId: string; workspace: string; operation: OwnerOperation; snapshot: string;
    pipelineId?: string; stage?: string; sourceSession?: string; decision?: 'approved' | 'rejected' },
): Promise<{ mode: 'broker'; id: string; sessionId: string }> {
  const { runId, workspace, operation, snapshot, pipelineId = 'all', stage = 'approval', sourceSession, decision = 'approved' } = input;
  if (operation === 'plan.final_manifest.approve' && sourceSession) {
    await agentBrokerAction({ action: 'register', run_id: runId, session_id: sourceSession, workspace });
  }
  const binding = await agentBrokerAction({ action: 'binding', run_id: runId });
  if (binding.workspace !== workspace) throw new Error('OWNER_BROKER_RUN_BINDING_MISMATCH');
  const target = { instance_id: binding.instance_id, operation, pipeline_id: pipelineId, stage };
  const active = await agentBrokerAction({ action: 'latest', ...target });
  const request = await agentBrokerAction({ action: 'prepare', ...target, previous_generation: active.generation, snapshot });
  if (request.decision !== 'pending' && request.decision !== decision) {
    throw new Error(`OWNER_APPROVAL_${String(request.decision).toUpperCase()}: ${request.request_id}`);
  }
  if (request.decision !== decision || request.current !== true) {
    throw new Error(`OWNER_APPROVAL_PENDING: ${request.request_id} operation=${operation} run=${runId} sha=${request.subject_sha256} ${ownerPasskeyUrl(request.request_id)}`);
  }
  return { mode: 'broker', id: request.request_id, sessionId: binding.session_id };
}

/** Builds a deterministic checkpoint from frozen runtime state, not owner CLI flags. */
async function buildCheckpointSubject(
  state: any,
  operation: 'plan.final_manifest.approve' | 'owner.accept',
  pipelineId = 'all',
  stage = 'approval',
) {
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
  let snapshot = raw;
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
    snapshot = JSON.stringify({ manifest_sha256: state.manifest_sha256, candidate_sha: candidateSha, pipeline_id: pipelineId, stage, proofs });
  }
  const checkpoint = {
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
  return { checkpoint, snapshot, workspace: sha(worktree) };
}

export async function buildOwnerCheckpoint(state: any, operation: 'plan.final_manifest.approve' | 'owner.accept', pipelineId = 'all', stage = 'approval') {
  return (await buildCheckpointSubject(state, operation, pipelineId, stage)).checkpoint;
}

export async function authorizeOwnerCheckpoint(
  state: any,
  operation: 'plan.final_manifest.approve' | 'owner.accept',
  pipelineId = 'all',
  stage = 'approval',
  sourceSession?: string,
  decision: 'approved' | 'rejected' = 'approved',
): Promise<{ mode: 'legacy' | 'broker'; id?: string; sessionId?: string }> {
  if (!ownerBrokerRequired()) return { mode: 'legacy' };
  if (passkeyBrokerRequired()) {
    const subject = await buildCheckpointSubject(state, operation, pipelineId, stage);
    const source = sourceSession ? { sourceSession } : {};
    return authorizePasskeyCheckpoint({ runId: subject.checkpoint.run_id, workspace: subject.workspace,
      operation, snapshot: subject.snapshot, pipelineId, stage, decision, ...source });
  }
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
  if (passkeyBrokerRequired()) {
    const subject = await buildCheckpointSubject(state, operation, pipelineId, stage);
    const receipt = await agentBrokerAction({ action: 'status', request_id: requestId });
    if (receipt.request_id !== requestId || receipt.current !== true || receipt.decision !== 'approved' ||
        receipt.run_id !== subject.checkpoint.run_id || receipt.operation !== operation || receipt.pipeline_id !== pipelineId ||
        receipt.stage !== stage || receipt.workspace !== subject.workspace || receipt.manifest_sha256 !== state.manifest_sha256 ||
        receipt.subject_sha256 !== sha(subject.snapshot) || receipt.candidate_sha !== subject.checkpoint.candidate_sha ||
        receipt.session_id !== state.approval_record?.source_session) {
      throw new Error('OWNER_BROKER_RECEIPT_INVALID');
    }
    return;
  }
  const checkpoint = await buildOwnerCheckpoint(state, operation, pipelineId, stage);
  const result = await agentBrokerAction({ action: 'status', checkpoint, request_id: requestId });
  if (result.authorized !== true || result.request_id !== requestId || result.consumed !== true) {
    throw new Error('OWNER_BROKER_RECEIPT_INVALID');
  }
}
