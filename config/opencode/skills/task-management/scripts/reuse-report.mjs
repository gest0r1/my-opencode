import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const USAGE_KEYS = ['input', 'output', 'reasoning', 'cache_read', 'cache_write', 'cost'];
const emptyUsage = () => Object.fromEntries(USAGE_KEYS.map(key => [key, 0]));
export function summarize(events) {
  const rows = events.filter(e => e.event === 'subagent_complete');
  const groups = {};
  for (const row of rows) {
    const key = ['fresh', 'reuse'].includes(row.decision) ? row.decision : 'unknown';
    const value = groups[key] ??= { calls: 0, failures: 0, latency_ms: 0, prompt_bytes: 0, response_bytes: 0, parent_response_bytes: 0, read_calls: 0, context_bytes: 0, model_requests: 0 };
    value.calls++; value.failures += row.session_health === 'error' ? 1 : 0;
    for (const metric of ['latency_ms', 'prompt_bytes', 'response_bytes', 'read_calls', 'context_bytes', 'model_requests']) value[metric] += Number(row[metric] ?? 0);
    value.parent_response_bytes += Number(row.parent_response_bytes ?? row.response_bytes ?? 0);
  }
  const reasons = {};
  for (const e of events.filter(e => e.event === 'reuse_decision' && e.fallback_reason)) reasons[e.fallback_reason] = (reasons[e.fallback_reason] ?? 0) + 1;
  const rawResponseBytes = rows.reduce((a, e) => a + Number(e.response_bytes ?? 0), 0);
  const parentResponseBytes = rows.reduce((a, e) => a + Number(e.parent_response_bytes ?? e.response_bytes ?? 0), 0);
  const gateRuns = events.filter(e => e.event === 'gate_run');
  const gates = {};
  for (const row of gateRuns) {
    const key = `${row.purpose ?? 'unknown'}:${row.mode ?? 'unknown'}`;
    const value = gates[key] ??= { runs: 0, reused: 0, interrupted: 0, failed: 0, duration_ms: 0, commands_run: 0 };
    value.runs++; value.reused += row.reused ? 1 : 0; value.interrupted += row.status === 'INTERRUPTED' ? 1 : 0;
    value.failed += ['FAIL', 'BLOCKED'].includes(row.status) ? 1 : 0;
    value.duration_ms += Number(row.duration_ms ?? 0); value.commands_run += Number(row.commands_run ?? 0);
  }
  // Agent session reuse and gate evidence reuse are different mechanisms with different costs:
  // keep them in separate sections and never add them up.
  const agents = {
    eligible_decisions: events.filter(e => e.event === 'reuse_decision').length,
    resumed: events.filter(e => e.event === 'reuse_decision' && e.decision === 'reuse').length,
    background_children: rows.filter(e => e.background === true).length,
    background_settled: events.filter(e => e.event === 'background_child_settled').length,
  };
  const runtime = {
    reload_required: events.filter(e => e.event === 'runtime_version' && e.runtime_reload_required).length,
    changed_during_run: events.filter(e => e.event === 'runtime_version' && e.runtime_changed_during_run).length,
  };
  // Token and cost per role: events carry per-session deltas, so plain sums are exact. The
  // orchestrator's own spend comes from parent_usage on each child completion.
  const usage = { by_role: {}, by_model: {}, total: emptyUsage() };
  const addUsage = (role, delta) => {
    if (!delta) return;
    for (const bucket of [usage.by_role[role] ??= emptyUsage(), usage.by_model[delta.model ?? 'unknown'] ??= emptyUsage(), usage.total]) {
      for (const key of USAGE_KEYS) bucket[key] += Number(delta[key] ?? 0);
    }
  };
  for (const e of events) {
    if (['subagent_complete', 'background_child_settled'].includes(e.event)) addUsage(e.role ?? 'unknown', e.usage);
    if (e.event === 'subagent_complete') addUsage('OpenStageOrchestrator', e.parent_usage);
  }
  return { schema_version: 3, groups, agents, fallback_reasons: reasons, gates, runtime, usage,
    parent: {
      tool_calls: events.filter(e => e.event === 'parent_tool').length,
      read_bytes: events.filter(e => e.event === 'parent_read').reduce((a, e) => a + Number(e.bytes_read ?? 0), 0),
      compactions: events.filter(e => e.event === 'parent_compaction').length,
      child_raw_response_bytes: rawResponseBytes,
      child_visible_response_bytes: parentResponseBytes,
      child_response_bytes_saved: Math.max(0, rawResponseBytes - parentResponseBytes),
    },
    interpretation: 'groups/agents: subagent session reuse; gates: gate evidence reuse, measured separately. Bytes are not tokens. child_visible_response_bytes measures the compact worker result retained by the parent; compare matched workloads, model/reasoning, quality and repair count.' };
}
export function exportReport(runId, output) {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw Error('Invalid run ID');
  const root = path.resolve('.tmp/pipelines', runId);
  const readLines = file => { try { return fs.readFileSync(path.join(root, file), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
  const events = [...readLines('reuse-metrics/events.jsonl'), ...readLines('reuse-metrics/gates.jsonl')];
  // Explicit allowlist prevents prompts, source contents, credentials and raw tool outputs entering export.
  const allowed = ['timestamp', 'event', 'identity', 'run_id', 'pipeline_id', 'stage', 'role', 'work_item_id', 'loop', 'decision', 'fallback_reason', 'session_health', 'latency_ms', 'orientation_ms', 'prompt_bytes', 'response_bytes', 'parent_response_bytes', 'packet_bytes', 'tool_calls', 'read_calls', 'grep_calls', 'glob_calls', 'edit_calls', 'shell_calls', 'unique_files_read', 'reread_file_count', 'context_reread_ratio', 'bytes_read', 'tool', 'context_bytes', 'model_requests', 'model', 'gate', 'purpose', 'mode', 'status', 'duration_ms', 'commands_run', 'reused', 'background', 'runtime_reload_required', 'runtime_changed_during_run', 'usage', 'parent_usage'];
  const safe = events.map(e => Object.fromEntries(allowed.filter(k => k in e).map(k => [k, e[k]])));
  const summary = summarize(safe);
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'events.jsonl'), safe.map(e => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'summary.csv'), 'decision,calls,failures,latency_ms,prompt_bytes,response_bytes,parent_response_bytes,read_calls,context_bytes,model_requests\n' + Object.entries(summary.groups).map(([k,v]) => [k,...Object.values(v)].join(',')).join('\n') + '\n');
  fs.writeFileSync(path.join(output, 'usage.csv'), `role,${USAGE_KEYS.join(',')}\n` + Object.entries(summary.usage.by_role).map(([k, v]) => [k, ...USAGE_KEYS.map(key => v[key])].join(',')).join('\n') + '\n');
  fs.writeFileSync(path.join(output, 'gates.csv'), 'purpose_mode,runs,reused,interrupted,failed,duration_ms,commands_run\n' + Object.entries(summary.gates).map(([k,v]) => [k,...Object.values(v)].join(',')).join('\n') + '\n');
  return summary;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [run, output] = process.argv.slice(2); if (!run || !output) throw Error('usage: node reuse-report.mjs RUN OUTPUT_DIR');
  console.log(JSON.stringify(exportReport(run, output)));
}
