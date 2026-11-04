import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../../..');
const text = relative => readFile(path.join(ROOT, relative), 'utf8');

function frontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  assert.ok(match?.[1]);
  return match[1];
}

function has(yaml, pattern) {
  return new RegExp(pattern, 'm').test(yaml);
}

test('planning and review agents can write their run-scoped artifacts', async () => {
  const broad = [
    'config/opencode/agent/subagents/core/externalscout.md',
    'config/opencode/agent/subagents/core/task-manager.md',
    'config/opencode/agent/subagents/planning/story-mapper.md',
    'config/opencode/agent/subagents/planning/architecture-analyzer.md',
    'config/opencode/agent/subagents/planning/contract-manager.md',
    'config/opencode/agent/subagents/planning/prioritization-engine.md',
    'config/opencode/agent/subagents/code/senior-story-reviewer.md',
    'config/opencode/agent/subagents/code/senior-technical-plan-reviewer.md',
    'config/opencode/agent/subagents/code/reviewer.md',
  ];
  for (const file of broad) {
    const yaml = frontmatter(await text(file));
    assert.ok(has(yaml, '\\.tmp/pipelines/\\*\\*.*allow'), `${file} must write run-scoped artifacts`);
  }

  const context = frontmatter(await text('config/opencode/agent/subagents/core/contextscout.md'));
  assert.ok(has(context, '\\.tmp/pipelines/\\*\\*/planning/\\*\\*.*allow'), 'ContextScout must write the whole planning subtree');
  assert.ok(!has(context, '\\.tmp/pipelines/\\*\\*/planning/context-packet\\.md.*allow'), 'single-file permission must not return');
  for (const artifact of ['revision.json', 'revisions.jsonl', 'review-ledger.json', 'source-requirements.json', 'deployment-target.json', 'refresh-impact.json']) {
    assert.ok(context.includes(`planning/${artifact}": deny`), `${artifact} is machine-owned`);
  }
  assert.ok(context.includes('planning/probes/**": deny'), 'PLAN probes are machine-owned');
  const web = frontmatter(await text('config/opencode/agent/subagents/core/web-researcher.md'));
  assert.ok(has(web, '\\.tmp/pipelines/\\*\\*/planning/research/\\*\\*.*allow'));
});

test('execution agents cannot edit machine-owned pipeline artifacts directly', async () => {
  for (const file of [
    'config/opencode/agent/subagents/code/coder-agent.md',
    'config/opencode/agent/subagents/code/test-engineer.md',
    'config/opencode/agent/subagents/development/devops-specialist.md',
  ]) {
    const yaml = frontmatter(await text(file));
    assert.ok(has(yaml, '\\.tmp/pipelines/\\*\\*.*deny'), `${file} must deny direct pipeline artifact edits`);
  }

  for (const file of [
    'config/opencode/agent/subagents/code/build-agent.md',
    'config/opencode/agent/subagents/core/documentation.md',
    'config/opencode/agent/subagents/development/frontend-specialist.md',
  ]) {
    const yaml = frontmatter(await text(file));
    assert.ok(!has(yaml, '\\.tmp/pipelines/\\*\\*.*allow'), `${file} must not own pipeline artifacts`);
  }
});
