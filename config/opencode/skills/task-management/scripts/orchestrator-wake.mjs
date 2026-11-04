// Decides whether an idle OpenStage session must be woken. A turn that ends while the RUN still
// has runnable work, no child is running and no owner checkpoint is open is a stall: the model
// announced a next step and stopped. One wake per state fingerprint: if the woken turn changes
// nothing, the session stays idle until the state or the owner moves.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { processAlive } from './runtime-locks.mjs';

export const WAKE_MARKER = '<pipeline_wake/>';
export const RUN_PROMPT = /^\s*\/pip(?:e)?line-run[ \t]+([A-Za-z0-9._-]+)(?=[ \t\r\n]|$)([^\r\n]*)/;

export function wakeText(runId) {
  return `${WAKE_MARKER} Automatic pipeline wake: your last turn ended while RUN \`${runId}\` is active, no child, worker lease or gate is running and no owner checkpoint is open. Run \`stage-cli next ${runId} --json\` and continue under pipeline-run rules. If you are genuinely waiting for the owner, say so in one line and stop.`;
}

export function wakeDecision({ stateRaw, manifest, pendingChildren = 0, runningWork = 0, lastFingerprint = null }) {
  if (pendingChildren > 0) return { wake: false, reason: 'child_running' };
  // Leases and gate locks are files with a live owner: they survive an OpenCode restart and a child the
  // runtime did not see start, and they are what `stage-cli waves` reports as running.
  if (runningWork > 0) return { wake: false, reason: 'work_running' };
  if (!stateRaw) return { wake: false, reason: 'no_state' };
  let state;
  try { state = JSON.parse(stateRaw); } catch { return { wake: false, reason: 'state_unreadable' }; }
  if (state.status !== 'in_progress') return { wake: false, reason: `run_${state.status ?? 'unknown'}` };
  if (/"awaiting_owner_(?:clarification|approval)"/.test(stateRaw)) return { wake: false, reason: 'owner_checkpoint' };
  // A blocked or failed lane waits for its owner decision; the RUN keeps every other lane going, so
  // only a RUN where no open lane is left unblocked stays asleep.
  let stopped = null; let open = 0;
  for (const [pipelineId, pipeline] of Object.entries(state.pipelines ?? {})) {
    const executors = manifest?.pipelines?.find(item => item.id === pipelineId)?.executors ?? {};
    let blocked = ['blocked', 'failed'].includes(pipeline?.status) ? `pipeline_${pipeline.status}` : null;
    for (const [stage, runtime] of Object.entries(pipeline?.stages ?? {})) {
      if (['blocked', 'failed'].includes(runtime?.status)) blocked ??= `stage_${runtime.status}`;
      if (runtime?.status === 'in_progress' && executors[stage] === 'owner_acceptance') return { wake: false, reason: 'owner_acceptance' };
    }
    if (blocked) stopped ??= blocked;
    else if (!['completed', 'ready', 'release_ready'].includes(pipeline?.status)) open += 1;
  }
  if (stopped && open === 0) return { wake: false, reason: stopped };
  // Fingerprint only scheduling/decision facts. updated_at, GitHub audit outbox,
  // scope probes and diagnostics can change without any runnable progress; hashing
  // raw state causes a new synthetic wake for each such maintenance write.
  const scheduling = {
    run_id: state.run_id,
    status: state.status,
    superseded_by: state.superseded_by,
    deferred_decisions: (state.deferred_decisions ?? []).map(item => [item.id, item.status]),
    pipelines: Object.entries(state.pipelines ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([id, pipeline]) => [
      id, pipeline.status, pipeline.current_stage,
      Object.entries(pipeline.stages ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([stage, runtime]) => [
        stage, runtime.status, runtime.technical_fix_cycles, runtime.architecture_review_due,
        runtime.class_review_due, runtime.runtime_replans?.at(-1)?.status,
      ]),
    ]),
  };
  const fingerprint = createHash('sha256').update(JSON.stringify(scheduling)).digest('hex');
  if (fingerprint === lastFingerprint) return { wake: false, reason: 'no_progress_since_last_wake' };
  return { wake: true, reason: 'stalled', fingerprint };
}

// Gate runs of this RUN still alive: each holds its lane lock in <state-root>/.gate-locks with its pid.
export function runningGates(stateRoot, runId) {
  let names = [];
  try { names = readdirSync(join(stateRoot, '.gate-locks')).filter(name => name.endsWith('.lock')); } catch { return 0; }
  let count = 0;
  for (const name of names) {
    try {
      const lock = JSON.parse(readFileSync(join(stateRoot, '.gate-locks', name), 'utf8'));
      if (lock.run_id !== runId || !Number.isSafeInteger(lock.pid)) continue;
      if (processAlive(lock.pid, lock.pid_start)) count += 1;
    } catch {}
  }
  return count;
}
