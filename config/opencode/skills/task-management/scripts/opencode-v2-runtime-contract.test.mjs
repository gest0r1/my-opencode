import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(path, 'utf8');

test('installed agent prompts use native V2 delegation fields', () => {
  function walk(root) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const file = `${root}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else if (file.endsWith('.md')) {
        const body = read(file).split('\n---').slice(1).join('\n---');
        assert.doesNotMatch(body, /\btask\(|\bsubagent_type\s*[=:]/, file);
      }
    }
  }
  walk('config/opencode/agent');
  assert.equal(existsSync('config/opencode/agent/subagents/core/stage-orchestrator.md'), false,
    'retired stage-orchestrator agent must remain absent');
});

test('OpenCode 2.2.5 runtime contract retains native subagent session resume', () => {
  const pkg = JSON.parse(read('config/opencode/package.json'));
  const runtime = read('config/opencode/plugins/pipeline-runtime.ts');
  const installer = read('install.sh');

  assert.equal(pkg.dependencies['@opencode/plugin'], '2.2.5');
  assert.match(installer, /OPENCODE_INSTALL_VERSION="\$\{OPENCODE_INSTALL_VERSION:-2\.2\.5\}"/);

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


test('V2 global config is portable and has no active legacy home skill roots', () => {
  const config = JSON.parse(read('config/opencode/opencode.json'));
  const serialized = JSON.stringify(config);

  assert.doesNotMatch(serialized, /\/home\/guber\//);
  assert.doesNotMatch(serialized, /\.opencode\/skills\//);

  assert.equal(config.agents, undefined, 'distribution agents have one Markdown source');
  const build = read('config/opencode/agent/core/build.md').split('\n---')[0];
  assert.doesNotMatch(build, /\/home\/guber\/|\.opencode\/skills\//);
  const external = /^  external_directory:\n((?:    [^\n]*\n)*)/m.exec(build)?.[1] ?? '';
  assert.ok(external.includes('"$HOME/.local/share/opencode/tool-output/*": allow'));
  assert.ok(external.includes('"$HOME/.config/opencode/skills/task-management/*": allow'));
  assert.match(build, /^  doom_loop: ask$/m);

  assert.equal(
    config.mcp?.servers?.yadisk?.command?.[0],
    '{env:HOME}/.local/bin/yadisk-mcp',
  );

  assert.equal(typeof config.model, 'string');
  assert.match(config.model, /^[^/]+\/.+/);
  const title = read('config/opencode/agent/core/title.md');
  assert.match(title, /^model: [^/]+\/.+$/m);
  assert.match(title, /^mode: primary$/m);
  assert.match(title, /^hidden: true$/m);
  assert.match(title, /You are a title generator/);
});

