import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(path, 'utf8');

test('OpenCode 2.0.21 runtime contract uses native subagent session resume', () => {
  const pkg = JSON.parse(read('config/opencode/package.json'));
  const runtime = read('config/opencode/plugins/pipeline-runtime.ts');
  const installer = read('install.sh');

  assert.equal(pkg.dependencies['@opencode/plugin'], '2.0.21');
  assert.match(installer, /OPENCODE_INSTALL_VERSION="\$\{OPENCODE_INSTALL_VERSION:-2\.0\.21\}"/);

  assert.match(runtime, /import \{ Plugin \} from "@opencode\/plugin"/);
  assert.match(runtime, /export default Plugin\.define\(/);
  assert.match(runtime, /plugin\.tool\.hook\("execute\.before"/);
  assert.match(runtime, /plugin\.tool\.hook\("execute\.after"/);
  assert.match(runtime, /event\.tool !== "subagent"/);
  assert.match(runtime, /delete input\.sessionID/);
  assert.match(runtime, /input\.sessionID = match\.session_id/);

  assert.doesNotMatch(runtime, /\btask_id\b/);
  assert.doesNotMatch(runtime, /event\.tool\s*[!=]==?\s*["']task["']/);
});

test('V2 permissions expose subagent, not legacy task routing', () => {
  const config = JSON.parse(read('config/opencode/opencode.json'));
  const rules = [
    ...(config.permissions ?? []),
    ...Object.values(config.agents ?? {}).flatMap((agent) => agent.permissions ?? []),
  ];
  assert.ok(rules.some((rule) => rule.action === 'subagent'));
  assert.equal(rules.some((rule) => rule.action === 'task'), false);
});
