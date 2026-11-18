import assert from 'node:assert/strict';
import test from 'node:test';
import { resultContentFromEvent, subagentResultContent } from './subagent-result-content.mjs';

test('keeps plain text and text parts intact without coercion', () => {
  assert.equal(subagentResultContent('status: blocked'), 'status: blocked');
  assert.equal(subagentResultContent([{ type: 'text', text: 'status: blocked' }, { type: 'text', text: 'reason: permission' }]),
    'status: blocked\nreason: permission');
  assert.equal(resultContentFromEvent({ content: null, output: 'fallback' }), 'fallback');
});

test('preserves structured status and diagnostics for handoff', () => {
  const input = { status: 'blocked', reason: 'permission denied', artifacts: ['run/report.md'] };
  const encoded = subagentResultContent(input);
  assert.deepEqual(JSON.parse(encoded), input);
  assert.ok(!encoded.includes('[object Object]'));
  const parts = resultContentFromEvent({ content: [{ type: 'text', text: 'result' }, { type: 'text', text: 'details' }] });
  assert.equal(parts, 'result\ndetails');
});

test('handles nested structured envelopes and cyclic data without crash', () => {
  assert.equal(subagentResultContent({ content: [{ type: 'text', text: 'hello' }] }), 'hello');
  const cyc = { status: 'blocked' };
  cyc.self = cyc;
  const encoded = subagentResultContent(cyc);
  assert.ok(encoded.length > 0);
  assert.ok(!encoded.includes('[object Object]'));
});
