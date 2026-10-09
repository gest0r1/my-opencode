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
