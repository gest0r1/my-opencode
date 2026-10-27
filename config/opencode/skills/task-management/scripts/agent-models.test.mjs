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
  'config/opencode/agent/core/openstage-orchestrator.md',
  'config/opencode/agent/meta/repo-manager.md',
  'config/opencode/agent/subagents/planning/prioritization-engine.md',
  'config/opencode/agent/subagents/system-builder/workflow-designer.md',
  'config/opencode/agent/subagents/code/coder-agent.md',
  'config/opencode/agent/subagents/code/test-engineer.md',
  'config/opencode/agent/subagents/planning/contract-manager.md',
  'config/opencode/agent/subagents/development/devops-specialist.md',
  'config/opencode/agent/subagents/core/task-manager.md',
  'config/opencode/agent/subagents/planning/story-mapper.md',
  'config/opencode/agent/subagents/system-builder/agent-generator.md',
  'config/opencode/agent/subagents/core/externalscout.md',
  'config/opencode/agent/subagents/code/findings-reviewer.md',
];

test('approved DeepSeek agents use V4.1 Flash', () => {
  for (const path of flash41) {
    assert.equal(value(path, 'model'), 'opencode-go/deepseek-v4.1-flash', path);
  }
});

test('system builder remains on V4 Pro', () => {
  for (const path of [
    'config/opencode/agent/meta/system-builder.md',
  ]) {
    assert.equal(value(path, 'model'), 'opencode-go/deepseek-v4-pro', path);
  }
});

test('GPT-6 agent assignments and reasoning levels are pinned', () => {
  const expectations = [
    ['config/opencode/agent/subagents/code/senior-story-reviewer.md', 'openai/gpt-6-luna', null],
    ['config/opencode/agent/subagents/code/reviewer.md', 'openai/gpt-6.1-sol', 'medium'],
    ['config/opencode/agent/subagents/planning/architecture-analyzer.md', 'openai/gpt-6.1-sol', 'medium'],
  ];

  for (const [path, model, reasoning] of expectations) {
    assert.equal(value(path, 'model'), model, path);
    assert.equal(value(path, 'reasoningEffort'), reasoning, path);
  }
});


test('GPT-6 agents omit temperature when reasoning is enabled', () => {
  for (const path of [
    'config/opencode/agent/subagents/code/senior-story-reviewer.md',
    'config/opencode/agent/subagents/code/reviewer.md',
    'config/opencode/agent/subagents/planning/architecture-analyzer.md',
  ]) {
    assert.equal(value(path, 'temperature'), null, path);
  }
});


test('MiMo 2.6 Flash', () => {
  for (const path of [
    "config/opencode/agent/core/build.md",
    "config/opencode/agent/subagents/code/build-agent.md",
    "config/opencode/agent/subagents/code/gate-runner.md",
    "config/opencode/agent/subagents/core/batch-executor.md",
    "config/opencode/agent/subagents/core/context-manager.md",
    "config/opencode/agent/subagents/core/contextscout.md",
    "config/opencode/agent/subagents/planning/adr-manager.md"
]) {
    assert.equal(value(path, 'model'), 'opencode-go/mimo-v2.6-flash', path);
  }
});

test('WebResearcher uses the free DeepSeek V4.1 Flash', () => {
  assert.equal(value('config/opencode/agent/subagents/core/web-researcher.md', 'model'), 'opencode/deepseek-v4.1-flash-free');
});

test('LongCat for auxiliary search and analysis', () => {
  for (const path of [
    "config/opencode/agent/subagents/core/context-retriever.md",
    "config/opencode/agent/data/data-analyst.md"
]) {
    assert.equal(value(path, 'model'), 'opencode-go/longcat-2.5-preview-free', path);
  }
});

test('Muse Contributor for text and simple responses', () => {
  for (const path of [
    "config/opencode/agent/content/copywriter.md",
    "config/opencode/agent/content/technical-writer.md",
    "config/opencode/agent/subagents/core/documentation.md",
    "config/opencode/agent/subagents/test/simple-responder.md"
]) {
    assert.equal(value(path, 'model'), 'opencode-go/muse-spark-1.3-contributor', path);
  }
});

test('title uses unlimited LongCat instead of Muse or MiMo', () => {
  const config = JSON.parse(readFileSync('config/opencode/opencode.json', 'utf8'));
  assert.ok(!config.agents, 'agent definitions must live only in Markdown');
  assert.match(readFileSync('config/opencode/agent/core/title.md', 'utf8'), /model: opencode-go\/longcat-2\.5-preview-free/);
});

test('technical plan reviewer uses Claude Opus 5.5 without OpenAI reasoning options', () => {
  const path = 'config/opencode/agent/subagents/code/senior-technical-plan-reviewer.md';
  assert.equal(value(path, 'model'), 'claude-code/claude-opus-5-5[1m]');
  assert.equal(value(path, 'reasoningEffort'), null);
});

test('architecture and technical review retain evidence-based reuse/drift checks in every mode', () => {
  for (const path of [
    'config/opencode/agent/subagents/planning/architecture-analyzer.md',
    'config/opencode/agent/subagents/code/senior-technical-plan-reviewer.md',
  ]) {
    const prompt = readFileSync(join(process.cwd(), path), 'utf8');
    for (const invariant of [
      'every mode', 'reuse_drift_analysis', 'searched paths/symbols',
      'consumers', 'canonical owner', 'sources of truth', 'equivalence',
      'cross-consumer regression', 'scope',
    ]) {
      // Reviewer says "every review mode", which carries the same invariant.
      assert.ok(invariant === 'every mode'
        ? /every (?:review )?mode/.test(prompt)
        : prompt.includes(invariant), `${path}: missing reuse/drift invariant ${invariant}`);
    }
  }
});

test('OpenStage stays on DeepSeek V4.1 Flash with the max reasoning variant', () => {
  // OpenCode 2.x joins a legacy `variant` with `model` (model#variant); the opencode-go catalog
  // offers low/high/max for this model, and max is one step above the provider default.
  const path = 'config/opencode/agent/core/openstage-orchestrator.md';
  assert.equal(value(path, 'model'), 'opencode-go/deepseek-v4.1-flash');
  assert.equal(value(path, 'variant'), 'max');
});
