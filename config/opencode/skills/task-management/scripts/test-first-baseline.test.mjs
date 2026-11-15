import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { recordTestFirstBaseline, requireTestFirstBaseline, testFirstBaselinePath, reusableTestFirstOnRepair } from './test-first-baseline.mjs';
import { changedFromInventory } from './gate-diagnostics.mjs';
import { selectAffectedCommands } from './gate-testing-policy.mjs';

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);
function fixture() {
  return { run_id: 'run-tdd', pipeline_id: 'app', stage: 'implementation',
    work_item_id: 'test-red', work_item_sha256: A, manifest_sha256: B,
    source_digest: C, files: { 'src/orders.ts': A, 'test/existing.test.ts': A, 'src/unrelated.ts': A } };
}
async function root(t) {
  const p = await mkdtemp(join(tmpdir(), 'test-first-'));
  t.after(() => rm(p, { recursive: true, force: true }));
  return p;
}

test('captures earliest source identity before RED and preserves it on repeated TestEngineer dispatch', async t => {
  const folder = await root(t);
  const payload = fixture();
  const first = await recordTestFirstBaseline(folder, payload);
  assert.deepEqual(first.files, payload.files);
  const later = await recordTestFirstBaseline(folder, { ...payload, files: { 'test/new.test.ts': A }, source_digest: A });
  assert.equal(later.source_digest, C, 'a follow-up dispatch cannot overwrite the pre-RED baseline');
  const ready = await requireTestFirstBaseline(folder, payload);
  assert.deepEqual(ready.files, payload.files);
});

test('red baseline cannot be missing, stale, out of the run, or supplied with another work item', async t => {
  const folder = await root(t);
  const payload = fixture();
  await assert.rejects(requireTestFirstBaseline(folder, payload), /TDD_RED_BASELINE_MISSING/);
  assert.throws(() => testFirstBaselinePath(folder, '../bad', 'app', 'implementation', 'test-red'), /TDD_BASELINE_IDENTITY_INVALID/);
  await recordTestFirstBaseline(folder, payload);
  await assert.rejects(requireTestFirstBaseline(folder, { ...payload, manifest_sha256: A }), /TDD_RED_BASELINE_STALE/);
  await assert.rejects(requireTestFirstBaseline(folder, { ...payload, work_item_sha256: B }), /TDD_RED_BASELINE_STALE/);
  await assert.rejects(requireTestFirstBaseline(folder, { ...payload, work_item_id: 'other' }), /TDD_RED_BASELINE_MISSING/);
});

test('bound Coder affected check includes TestEngineer-created RED test, but not unrelated lane files', async t => {
  const folder = await root(t);
  const payload = fixture();
  await recordTestFirstBaseline(folder, payload);
  const before = (await requireTestFirstBaseline(folder, payload)).files;
  const afterRED = { ...before, 'test/new-orders.test.ts': B, 'src/unrelated.ts': B };
  const afterGREEN = { ...afterRED, 'src/orders.ts': C };
  const pairScope = ['test/**', 'src/orders.ts'];
  const changed = changedFromInventory(afterGREEN, before, pairScope);
  assert.deepEqual(changed, ['src/orders.ts', 'test/new-orders.test.ts']);
  const commands = ['pnpm exec vitest run --config vitest.app.ts', 'pnpm exec vitest run --config vitest.unrelated.ts'];
  const map = { impact_groups: [
    { inputs: ['src/orders.ts', 'test/**'], command_index: 0,
      test_files: ['test/existing.test.ts'] },
    { inputs: ['src/unrelated.ts'], command_index: 1, test_files: ['test/unrelated.test.ts'] },
  ] };
  const selected = selectAffectedCommands(commands, map, changed, [], { isNew: path => path === 'test/new-orders.test.ts' });
  assert.deepEqual(selected.selected.map(entry => entry.index), [0]);
  assert.ok(selected.selected[0].test_files.includes('test/new-orders.test.ts'), 'the new RED test must be executed in the GREEN check');
});

test('do not infer a GREEN proof from a Coder-only baseline captured after tests', () => {
  const beforeRED = { 'src/orders.ts': A };
  const afterRED = { ...beforeRED, 'test/new-orders.test.ts': B };
  const afterGREEN = { ...afterRED, 'src/orders.ts': C };
  assert.deepEqual(changedFromInventory(afterGREEN, afterRED, ['test/**', 'src/orders.ts']), ['src/orders.ts']);
  assert.deepEqual(changedFromInventory(afterGREEN, beforeRED, ['test/**', 'src/orders.ts']), ['src/orders.ts', 'test/new-orders.test.ts']);
});

test('reuses an existing TestEngineer RED result only for independent code-only repair', () => {
  const base = { testWorkItemId: 'red', testItem: {
    pipeline_id: 'app', stage: 'implementation', suggested_agent: 'TestEngineer',
    allowed_change_paths: ['test/**'] },
  consumerItems: [{ pipeline_id: 'app', stage: 'implementation',
    suggested_agent: 'CoderAgent', test_first_work_item_id: 'red' }],
  pipelineId: 'app', stage: 'implementation', repairPaths: ['src/orders.ts'],
  sessionRegistry: [{ pipeline_id: 'app', stage: 'implementation', work_item_id: 'red', status: 'healthy' }] };
  assert.equal(reusableTestFirstOnRepair(base), true);
  assert.equal(reusableTestFirstOnRepair({ ...base, repairPaths: ['test/orders.test.ts'] }), false);
  assert.equal(reusableTestFirstOnRepair({ ...base, repairPaths: [] }), false);
  assert.equal(reusableTestFirstOnRepair({ ...base, consumerItems: [] }), false);
  assert.equal(reusableTestFirstOnRepair({ ...base, sessionRegistry: [] }), false);
  assert.equal(reusableTestFirstOnRepair({ ...base, testItem: { ...base.testItem, stage: 'other' } }), false);
});
