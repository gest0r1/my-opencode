import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { runtimeFiles, fingerprintRuntimeFiles, missingRuntimeFiles } from '../config/opencode/plugins/runtime-version-files.mjs';

const source = readFileSync('config/opencode/plugins/pipeline-runtime.ts', 'utf8');
const installer = readFileSync('scripts/install-opencode-generation.sh', 'utf8');
const navigator = readFileSync('config/opencode/PIPELINE.md', 'utf8');

test('V2 runtime identifies its actual source checkout in direct import tests', () => {
  assert.match(source, /runtimeFiles\(import.meta.url\)/);
  const files = runtimeFiles(pathToFileURL(path.resolve('config/opencode/plugins/pipeline-runtime.ts')).href);
  assert.ok(files.some(x => x.endsWith('/command/pipeline-run.md')));
  assert.ok(files.some(x => x.endsWith('/agent/core/openstage-orchestrator.md')));
  assert.deepEqual(missingRuntimeFiles(files), []);
});
test('staged generation rejects absent runtime inputs', () => {
  for (const key of ['commands/pipeline-run.md', 'agents/OpenStageOrchestrator.md', 'skills/task-management/run-worker-rules.md', 'plugins/runtime-version-files.mjs']) {
    assert.ok(installer.includes(key), 'missing precommit staging assertion: ' + key);
  }
  assert.match(installer, /required V2 runtime file missing/);
  assert.ok(existsSync('config/opencode/command/pipeline-run.md'));
  assert.ok(existsSync('config/opencode/agent/core/openstage-orchestrator.md'));
});
test('materialized V2 path fingerprint detects command and agent byte changes and missing required inputs', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'installed-v2-runtime-'));
  const relative = [
    'plugins/pipeline-runtime.ts', 'plugins/runtime-version-files.mjs',
    'skills/task-management/scripts/pipeline-dispatch.ts', 'skills/task-management/run-worker-rules.md',
    'commands/pipeline-run.md', 'agents/OpenStageOrchestrator.md',
  ];
  try {
    for (const rel of relative) {
      const file = path.join(root, rel);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, 'original ' + rel);
    }
    const files = runtimeFiles(pathToFileURL(path.join(root, 'plugins/pipeline-runtime.ts')).href);
    assert.deepEqual(files.map(f => path.relative(root, f)).sort(), relative.sort());
    assert.deepEqual(missingRuntimeFiles(files), []);
    const first = fingerprintRuntimeFiles(files);
    writeFileSync(path.join(root, 'commands/pipeline-run.md'), 'command changed');
    const second = fingerprintRuntimeFiles(files);
    assert.notEqual(second, first);
    writeFileSync(path.join(root, 'agents/OpenStageOrchestrator.md'), 'agent changed');
    const third = fingerprintRuntimeFiles(files);
    assert.notEqual(third, second);
    unlinkSync(path.join(root, 'commands/pipeline-run.md'));
    assert.deepEqual(missingRuntimeFiles(files), [path.join(root, 'commands/pipeline-run.md')]);
    assert.notEqual(fingerprintRuntimeFiles(files), third);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('installed navigator links canonical V2 commands', () => {
  assert.match(navigator, /\(commands\/pipeline-plan\.md\)/);
  assert.match(navigator, /\(commands\/pipeline-run\.md\)/);
  assert.doesNotMatch(navigator, /\(command\/pipeline-run\.md\)/);
});
