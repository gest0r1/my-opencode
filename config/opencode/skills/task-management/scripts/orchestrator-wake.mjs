// Decides whether an idle OpenStage session must be woken. A turn that ends while the RUN still
// has runnable work, no child is running and no owner checkpoint is open is a stall: the model
// announced a next step and stopped. One wake per state fingerprint: if the woken turn changes
// nothing, the session stays idle until the state or the owner moves.
import { createHash } from 'node:crypto';

export const WAKE_MARKER = '<pipeline_wake/>';
export const RUN_PROMPT = /\/pip(?:e)?line-run\s+([A-Za-z0-9._-]+)/;

export function wakeText(runId) {
  return `${WAKE_MARKER} Automatic pipeline wake: your last turn ended while RUN \`${runId}\` is active, no child or check is running and no owner checkpoint is open. Run \`stage-cli next ${runId} --json\` and continue under pipeline-run rules. If you are genuinely waiting for the owner, say so in one line and stop.`;
}

export function wakeDecision({ stateRaw, manifest, pendingChildren = 0, lastFingerprint = null }) {
  if (pendingChildren > 0) return { wake: false, reason: 'child_running' };
  if (!stateRaw) return { wake: false, reason: 'no_state' };
  let state;
  try { state = JSON.parse(stateRaw); } catch { return { wake: false, reason: 'state_unreadable' }; }
  if (state.status !== 'in_progress') return { wake: false, reason: `run_${state.status ?? 'unknown'}` };
  if (/"awaiting_owner_(?:clarification|approval)"/.test(stateRaw)) return { wake: false, reason: 'owner_checkpoint' };
  for (const [pipelineId, pipeline] of Object.entries(state.pipelines ?? {})) {
    if (['blocked', 'failed'].includes(pipeline?.status)) return { wake: false, reason: `pipeline_${pipeline.status}` };
    const executors = manifest?.pipelines?.find(item => item.id === pipelineId)?.executors ?? {};
    for (const [stage, runtime] of Object.entries(pipeline?.stages ?? {})) {
      if (['blocked', 'failed'].includes(runtime?.status)) return { wake: false, reason: `stage_${runtime.status}` };
      if (runtime?.status === 'in_progress' && executors[stage] === 'owner_acceptance') return { wake: false, reason: 'owner_acceptance' };
    }
  }
  const fingerprint = createHash('sha256').update(stateRaw).digest('hex');
  if (fingerprint === lastFingerprint) return { wake: false, reason: 'no_progress_since_last_wake' };
  return { wake: true, reason: 'stalled', fingerprint };
}
