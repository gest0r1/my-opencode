import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
  return { schema_version: 1, groups, fallback_reasons: reasons,
    parent: {
      tool_calls: events.filter(e => e.event === 'parent_tool').length,
      read_bytes: events.filter(e => e.event === 'parent_read').reduce((a, e) => a + Number(e.bytes_read ?? 0), 0),
      compactions: events.filter(e => e.event === 'parent_compaction').length,
      child_raw_response_bytes: rawResponseBytes,
      child_visible_response_bytes: parentResponseBytes,
      child_response_bytes_saved: Math.max(0, rawResponseBytes - parentResponseBytes),
    },
    interpretation: 'Bytes are not tokens. child_visible_response_bytes measures the compact worker result retained by the parent; compare matched workloads, model/reasoning, quality and repair count.' };
}
export function exportReport(runId, output) {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw Error('Invalid run ID');
  const root = path.resolve('.tmp/pipelines', runId);
  const events = fs.readFileSync(path.join(root, 'reuse-metrics/events.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  // Explicit allowlist prevents prompts, source contents, credentials and raw tool outputs entering export.
  const allowed = ['timestamp', 'event', 'identity', 'run_id', 'pipeline_id', 'stage', 'role', 'work_item_id', 'loop', 'decision', 'fallback_reason', 'session_health', 'latency_ms', 'orientation_ms', 'prompt_bytes', 'response_bytes', 'parent_response_bytes', 'packet_bytes', 'tool_calls', 'read_calls', 'grep_calls', 'glob_calls', 'edit_calls', 'shell_calls', 'unique_files_read', 'reread_file_count', 'context_reread_ratio', 'bytes_read', 'tool', 'context_bytes', 'model_requests', 'model'];
  const safe = events.map(e => Object.fromEntries(allowed.filter(k => k in e).map(k => [k, e[k]])));
  const summary = summarize(safe);
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'events.jsonl'), safe.map(e => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'summary.csv'), 'decision,calls,failures,latency_ms,prompt_bytes,response_bytes,parent_response_bytes,read_calls,context_bytes,model_requests\n' + Object.entries(summary.groups).map(([k,v]) => [k,...Object.values(v)].join(',')).join('\n') + '\n');
  return summary;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [run, output] = process.argv.slice(2); if (!run || !output) throw Error('usage: node reuse-report.mjs RUN OUTPUT_DIR');
  console.log(JSON.stringify(exportReport(run, output)));
}
