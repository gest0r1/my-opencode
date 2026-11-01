import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../scripts/retire-opencode-agent-copies.mjs', import.meta.url));

function agent(file, name) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\nname: ${name}\nmode: subagent\n---\n`);
}

test('configuration upgrade retires StageOrchestrator but preserves user agents', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-opencode-agents-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  const target = path.join(dir, 'target');

  agent(path.join(source, 'core', 'openagent.md'), 'OpenAgent');
  agent(path.join(target, 'OpenAgent.md'), 'OpenAgent');
  agent(path.join(target, 'StageOrchestrator.md'), 'StageOrchestrator');
  agent(path.join(target, 'subagents', 'core', 'stage-orchestrator.md'), 'StageOrchestrator');
  agent(path.join(target, 'UserAgent.md'), 'UserAgent');
  agent(path.join(target, 'nested', 'Other.md'), 'Other');

  execFileSync(process.execPath, [script, source, target], { stdio: 'pipe' });

  assert.equal(fs.existsSync(path.join(target, 'OpenAgent.md')), false, 'managed agent copy retired for replacement');
  assert.equal(fs.existsSync(path.join(target, 'StageOrchestrator.md')), false, 'flat retired ID removed');
  assert.equal(fs.existsSync(path.join(target, 'subagents', 'core', 'stage-orchestrator.md')), false, 'legacy nested copy removed');
  assert.equal(fs.existsSync(path.join(target, 'UserAgent.md')), true, 'unmanaged user agent preserved');
  assert.equal(fs.existsSync(path.join(target, 'nested', 'Other.md')), true, 'unrelated nested user agent preserved');
});
