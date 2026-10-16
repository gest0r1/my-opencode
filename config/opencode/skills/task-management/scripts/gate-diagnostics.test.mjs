import assert from 'node:assert/strict';
import test from 'node:test';
import { failureSummary, outputTail } from './gate-diagnostics.mjs';

const passing = Array.from({ length: 200 }, (_, i) => ` ✓ |live-node| apps/api/test/error-${i}-live.test.ts > rejects failed login`).join('\n');
const stdout = `\u001b[32m${passing}\u001b[0m\n\n⎯⎯⎯ Failed Suites 1 ⎯⎯⎯\n\n FAIL  |live-node| packages/db/test/schema-equivalence-live.test.ts\nError: beforeAll timed out\n\n Test Files  1 failed | 35 passed (36)\n      Tests  484 passed | 6 skipped (490)\n   Duration  404.5s\n`;

test('failure summary keeps the failure section and closing summary, not passing lines', () => {
  const summary = failureSummary(stdout, '');
  assert.ok(summary.every(line => !line.includes('✓')));
  assert.ok(summary.some(line => line.includes('FAIL  |live-node| packages/db/test/schema-equivalence-live.test.ts')));
  assert.ok(summary.includes('Error: beforeAll timed out'));
  assert.ok(summary.some(line => line.includes('Test Files  1 failed')));
});

test('output tail is an ANSI-free array of the last non-empty lines', () => {
  const tail = outputTail(stdout, 'stderr line', 5);
  assert.equal(tail.length, 5);
  assert.equal(tail.at(-1), 'stderr line');
  assert.ok(tail.every(line => !line.includes('\u001b')));
});
