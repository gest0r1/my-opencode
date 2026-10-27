import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { summarize, exportReport } from './reuse-report.mjs';
test('reuse export drops sensitive content and keeps comparable measurements', () => {
 const previous=process.cwd(), root=fs.mkdtempSync(path.join(os.tmpdir(),'reuse-report-'));
 try {
  process.chdir(root);fs.mkdirSync('.tmp/pipelines/run/reuse-metrics',{recursive:true});
  const events=[{event:'subagent_complete',decision:'reuse',session_health:'error',latency_ms:12,prompt_bytes:30,response_bytes:500,parent_response_bytes:80,context_bytes:120,model_requests:2,session_id:'private-session',prompt:'SECRET',files_read:['private-path']},{event:'reuse_decision',fallback_reason:'session_unavailable'},{event:'parent_compaction'}];
  fs.writeFileSync('.tmp/pipelines/run/reuse-metrics/events.jsonl',events.map(JSON.stringify).join('\n'));
  const summary=exportReport('run','output');assert.equal(summary.groups.reuse.failures,1);assert.equal(summary.groups.reuse.context_bytes,120);assert.equal(summary.groups.reuse.parent_response_bytes,80);assert.equal(summary.parent.child_raw_response_bytes,500);assert.equal(summary.parent.child_visible_response_bytes,80);assert.equal(summary.parent.child_response_bytes_saved,420);assert.equal(summary.parent.compactions,1);
  assert.doesNotMatch(fs.readFileSync('output/events.jsonl','utf8'),/SECRET|private-session|private-path/);
  assert.equal(summarize([{event:'subagent_complete',decision:'=BAD()'}]).groups.unknown.calls,1);
  assert.throws(()=>exportReport('../escape','output'),/Invalid run ID/);
 } finally {process.chdir(previous);fs.rmSync(root,{recursive:true,force:true});}
});

test('gate timeline summarizes reused, interrupted and executed gate runs', async () => {
  const { summarize } = await import('./reuse-report.mjs');
  const summary = summarize([
    { event: 'gate_run', purpose: 'advisory', mode: 'affected', status: 'PASS', duration_ms: 1200000, commands_run: 12, reused: false },
    { event: 'gate_run', purpose: 'authoritative', mode: 'complete', status: 'PASS', duration_ms: 900, commands_run: 0, reused: true },
    { event: 'gate_run', purpose: 'advisory', mode: 'affected', status: 'INTERRUPTED', duration_ms: 120000, commands_run: 4, reused: false },
  ]);
  assert.deepEqual(summary.gates['advisory:affected'], { runs: 2, reused: 0, interrupted: 1, failed: 0, duration_ms: 1320000, commands_run: 16 });
  assert.deepEqual(summary.gates['authoritative:complete'], { runs: 1, reused: 1, interrupted: 0, failed: 0, duration_ms: 900, commands_run: 0 });
});

test('agent reuse, background children and runtime changes are reported apart from gate reuse', () => {
  const summary = summarize([
    { event: 'reuse_decision', decision: 'fresh', fallback_reason: 'no_prior_session' },
    { event: 'subagent_complete', decision: 'fresh', background: true, session_health: 'background' },
    { event: 'background_child_settled', session_health: 'healthy' },
    { event: 'reuse_decision', decision: 'reuse' },
    { event: 'runtime_version', runtime_reload_required: true, runtime_changed_during_run: false },
    { event: 'gate_run', purpose: 'advisory', mode: 'affected', status: 'PASS', reused: true },
  ]);
  assert.deepEqual(summary.agents, { eligible_decisions: 2, resumed: 1, background_children: 1, background_settled: 1 });
  assert.deepEqual(summary.runtime, { reload_required: 1, changed_during_run: 0 });
  assert.equal(summary.gates['advisory:affected'].reused, 1);
});

test('token and cost usage is summed per role and model from per-session deltas', () => {
  const summary = summarize([
    { event: 'subagent_complete', role: 'CodeReviewer', usage: { model: 'go/deepseek', input: 100, output: 10, reasoning: 5, cache_read: 50, cache_write: 0, cost: 0.02 },
      parent_usage: { model: 'go/opus', input: 1000, output: 20, reasoning: 0, cache_read: 900, cache_write: 10, cost: 0.1 } },
    { event: 'subagent_complete', role: 'CodeReviewer', usage: { model: 'go/deepseek', input: 40, output: 4, reasoning: 0, cache_read: 0, cache_write: 0, cost: 0.01 }, parent_usage: null },
    { event: 'subagent_complete', role: 'CoderAgent', background: true, usage: null },
    { event: 'background_child_settled', role: 'CoderAgent', usage: { model: 'go/kimi', input: 7, output: 3, reasoning: 0, cache_read: 0, cache_write: 0, cost: 0 } },
  ]);
  assert.deepEqual(summary.usage.by_role.CodeReviewer, { input: 140, output: 14, reasoning: 5, cache_read: 50, cache_write: 0, cost: 0.03 });
  assert.equal(summary.usage.by_role.OpenStageOrchestrator.input, 1000);
  assert.equal(summary.usage.by_role.CoderAgent.output, 3);
  assert.equal(summary.usage.by_model['go/deepseek'].input, 140);
  assert.equal(summary.usage.total.input, 1147);
});
