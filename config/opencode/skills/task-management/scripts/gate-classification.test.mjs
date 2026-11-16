import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyGate } from './gate-classification.mjs';

test('explicit frozen tree kind wins over legacy release name', () => {
  const result = classifyGate('release-check', { input_kind: 'tree' }, ['node --test']);
  assert.equal(result.runtime, false);
  assert.equal(result.snapshotAllowed, true);
  assert.equal(result.reuseAllowed, true);
  assert.equal(result.advisoryAllowed, true);
});

test('candidate, contour, build outputs, service, lifecycle and artifacts are conservative', () => {
  const cases = [
    [{ input_kind: 'candidate' }, ['node --test']],
    [{ input_kind: 'candidate-contour' }, ['node --test']],
    [{ input_kind: 'build-output' }, ['node --test']],
    [{ input_kind: 'deployed-service' }, ['node --test']],
    [{ input_kind: 'tree', lifecycle: { kind: 'install' } }, ['node --test']],
    [{ input_kind: 'tree', artifact_output: true }, ['node --test']],
    [{ input_kind: 'tree' }, ['check {candidate_sha}']],
  ];
  for (const [config, commands] of cases) {
    const result = classifyGate('release-check', config, commands);
    assert.equal(result.runtime, true);
    assert.equal(result.snapshotAllowed, false);
    assert.equal(result.reuseAllowed, false);
    assert.equal(result.advisoryAllowed, false);
  }
});

test('untyped and unknown legacy gates fail conservatively', () => {
  assert.equal(classifyGate('release-check', undefined, []).runtime, true);
  assert.equal(classifyGate('install-smoke', {}, []).runtime, true);
  assert.equal(classifyGate('ordinary-test', { input_kind: 'future-unknown' }, []).runtime, true);
  assert.equal(classifyGate('ordinary-test', undefined, []).runtime, false);
});
