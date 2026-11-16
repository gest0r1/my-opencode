import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync('config/opencode/plugins/pipeline-runtime.ts', 'utf8');
const installer = readFileSync('scripts/install-opencode-generation.sh', 'utf8');
const navigator = readFileSync('config/opencode/PIPELINE.md', 'utf8');

test('V2 runtime fingerprint references canonical installed layout', () => {
  assert.match(source, /new URL\("\.\.\/commands\/pipeline-run\.md"/);
  assert.match(source, /new URL\("\.\.\/agents\/OpenStageOrchestrator\.md"/);
  assert.doesNotMatch(source, /new URL\("\.\.\/command\/pipeline-run\.md"/);
  assert.doesNotMatch(source, /new URL\("\.\.\/agent\/core\/openstage-orchestrator\.md"/);
  assert.match(source, /missingRuntimeFiles\(\)/);
  assert.match(source, /runtime_missing_required_files/);
});
test('staged generation must reject absent runtime inputs', () => {
  for (const key of ['commands/pipeline-run.md', 'agents/OpenStageOrchestrator.md', 'skills/task-management/run-worker-rules.md']) {
    assert.ok(installer.includes(key), 'missing precommit staging assertion: ' + key);
  }
  assert.match(installer, /required V2 runtime file missing/);
  assert.ok(existsSync('config/opencode/command/pipeline-run.md'));
  assert.ok(existsSync('config/opencode/agent/core/openstage-orchestrator.md'));
  assert.match(readFileSync('config/opencode/agent/core/openstage-orchestrator.md', 'utf8'), /^---\nname: OpenStageOrchestrator/m);
});
test('installed navigator links canonical commands', () => {
  assert.match(navigator, /\(commands\/pipeline-plan\.md\)/);
  assert.match(navigator, /\(commands\/pipeline-run\.md\)/);
  assert.doesNotMatch(navigator, /\(command\/pipeline-run\.md\)/);
});
