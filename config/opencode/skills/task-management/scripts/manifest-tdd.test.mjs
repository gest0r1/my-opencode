import assert from 'node:assert/strict';
import test from 'node:test';
import { validateTestFirstWorkItems } from './manifest-v2-policy.mjs';

const build = (mutate = () => {}) => {
  const records = new Map([
    ['red', { id: 'red', pipeline_id: 'app', suggested_agent: 'TestEngineer',
      stage: 'implementation', allowed_change_paths: ['tests/**'], depends_on: [] }],
    ['green', { id: 'green', pipeline_id: 'app', suggested_agent: 'CoderAgent',
      stage: 'implementation', allowed_change_paths: ['src/**'],
      test_first_work_item_id: 'red', depends_on: ['red'] }],
  ]);
  const pipelines = new Map([['app', { id: 'app', test_preparation: false,
    executors: { implementation: 'agent', review: 'review' } }]]);
  mutate(records, pipelines);
  return { records, pipelines };
};

test('a risk-based independent TestEngineer RED → CoderAgent GREEN edge is valid in the same consuming lane', () => {
  const { records, pipelines } = build();
  assert.doesNotThrow(() => validateTestFirstWorkItems(records, pipelines));
});

test('low-risk Coder without separate TestEngineer is still valid', () => {
  const { records, pipelines } = build(records => {
    records.delete('red');
    const coder = records.get('green');
    delete coder.test_first_work_item_id;
    coder.depends_on = [];
  });
  assert.doesNotThrow(() => validateTestFirstWorkItems(records, pipelines));
});

for (const [label, edit] of [
  ['missing RED reference', records => { records.get('green').test_first_work_item_id = 'unknown'; }],
  ['missing dependent edge', records => { records.get('green').depends_on = []; }],
  ['wrong RED role', records => { records.get('red').suggested_agent = 'CoderAgent'; }],
  ['wrong GREEN role', records => { records.get('green').suggested_agent = 'TestEngineer'; }],
  ['cross-pipeline RED', records => { records.get('red').pipeline_id = 'other'; }],
  ['cross-stage RED', records => { records.get('red').stage = 'other'; }],
  ['missing RED test scope', records => { records.get('red').allowed_change_paths = []; }],
]) {
  test(`rejects ${label} before RUN`, () => {
    const { records, pipelines } = build(edit);
    assert.throws(() => validateTestFirstWorkItems(records, pipelines), /TDD_TEST_FIRST_DEPENDENCY_INVALID/);
  });
}

test('rejects RED work in test_preparation and non-agent stages', () => {
  const prep = build((records, pipelines) => { pipelines.get('app').test_preparation = true; });
  assert.throws(() => validateTestFirstWorkItems(prep.records, prep.pipelines), /TDD_TEST_FIRST_DEPENDENCY_INVALID/);
  const invalid = build((records, pipelines) => { pipelines.get('app').executors.implementation = 'review'; });
  assert.throws(() => validateTestFirstWorkItems(invalid.records, invalid.pipelines), /TDD_TEST_FIRST_DEPENDENCY_INVALID/);
});
