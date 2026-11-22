import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { requireOwnerCheckpoint, ownerBrokerRequired } from './owner-broker-client.mjs';

const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

/** Builds a deterministic checkpoint from frozen runtime state, not owner CLI flags. */
export async function authorizeOwnerCheckpoint(
  state: any,
  operation: 'plan.final_manifest.approve' | 'owner.accept',
  pipelineId = 'all',
  stage = 'approval',
): Promise<{ mode: 'legacy' | 'broker'; id?: string }> {
  if (!ownerBrokerRequired()) return { mode: 'legacy' };
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
    for (const [id, pipeline] of Object.entries(state.pipelines || {})) {
      for (const [name, runtime] of Object.entries((pipeline as any).stages || {})) {
        const entry: any = runtime;
        if (!['completed','skipped'].includes(entry.status)) continue;
        const artifacts: Array<{ path: string; sha256: string }> = [];
        const rawArtifacts = entry.evidence?.artifacts || [];
        for (const candidatePath of rawArtifacts) {
          if (typeof candidatePath !== 'string') throw new Error('OWNER_CHECKPOINT_INVALID_ARTIFACT');
          const filename = resolve(isAbsolute(candidatePath) ? candidatePath : join(root, candidatePath));
          if (filename !== root && filename.startsWith(root + sep)) {
            artifacts.push({ path: filename.slice(root.length + 1), sha256: sha(await readFile(filename)) });
          } else throw new Error('OWNER_CHECKPOINT_ARTIFACT_OUTSIDE_RUN');
        }
        proofs.push({ pipeline: id, stage: name, evidence: entry.evidence || null, artifacts });
      }
    }
    subjectSha = sha(JSON.stringify({ manifestSha: state.manifest_sha256, candidateSha, pipelineId, stage, proofs }));
  }
  return requireOwnerCheckpoint({
    run_instance_id: runInstanceId,
    run_id: run,
    operation,
    pipeline_id: pipelineId,
    stage,
    generation: 1,
    manifest_sha256: state.manifest_sha256,
    subject_sha256: subjectSha,
    candidate_sha: candidateSha,
  });
}