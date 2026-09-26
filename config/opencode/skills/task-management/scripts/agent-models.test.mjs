import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

function frontmatter(path) {
  const text = readFileSync(join(process.cwd(), path), 'utf8');
  const match = text.match(/^---\s*\n([\s\S]*?)\n---/);
  assert.ok(match, `${path}: missing frontmatter`);
  return match[1];
}

function value(path, key) {
  const fm = frontmatter(path);
  const match = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return match ? match[1].trim() : null;
}

const flash41 = [
  'config/opencode/agent/content/copywriter.md',
  'config/opencode/agent/content/technical-writer.md',
  'config/opencode/agent/core/openstage-orchestrator.md',
  'config/opencode/agent/meta/repo-manager.md',
  'config/opencode/agent/subagents/planning/prioritization-engine.md',
  'config/opencode/agent/subagents/system-builder/workflow-designer.md',
  'config/opencode/agent/subagents/test/simple-responder.md',
  'config/opencode/agent/subagents/code/coder-agent.md',
  'config/opencode/agent/subagents/code/test-engineer.md',
  'config/opencode/agent/subagents/planning/contract-manager.md',
  'config/opencode/agent/subagents/development/devops-specialist.md',
  'config/opencode/agent/subagents/core/task-manager.md',
  'config/opencode/agent/subagents/planning/story-mapper.md',
  'config/opencode/agent/subagents/system-builder/agent-generator.md',
];

test('approved DeepSeek agents use V4.1 Flash', () => {
  for (const path of flash41) {
    assert.equal(value(path, 'model'), 'opencode-go/deepseek-v4.1-flash', path);
  }
});

test('V4 Pro agents remain on V4 Pro', () => {
  for (const path of [
    'config/opencode/agent/data/data-analyst.md',
    'config/opencode/agent/meta/system-builder.md',
  ]) {
    assert.equal(value(path, 'model'), 'opencode-go/deepseek-v4-pro', path);
  }
});

test('GPT-6 agent assignments and reasoning levels are pinned', () => {
  const expectations = [
    ['config/opencode/agent/subagents/code/senior-story-reviewer.md', 'openai/gpt-6-luna', null],
    ['config/opencode/agent/subagents/code/reviewer.md', 'openai/gpt-6-sol', 'low'],
    ['config/opencode/agent/subagents/code/senior-technical-plan-reviewer.md', 'openai/gpt-6-sol', 'low'],
    ['config/opencode/agent/subagents/planning/architecture-analyzer.md', 'openai/gpt-6-sol', 'medium'],
  ];

  for (const [path, model, reasoning] of expectations) {
    assert.equal(value(path, 'model'), model, path);
    assert.equal(value(path, 'reasoningEffort'), reasoning, path);
  }
});
