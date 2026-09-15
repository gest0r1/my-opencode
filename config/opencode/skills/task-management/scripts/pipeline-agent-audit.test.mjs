import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../../..');

const AGENTS = [
  'config/opencode/agent/core/openstage-orchestrator.md',
  'config/opencode/agent/subagents/core/contextscout.md',
  'config/opencode/agent/subagents/core/externalscout.md',
  'config/opencode/agent/subagents/core/task-manager.md',
  'config/opencode/agent/subagents/core/documentation.md',
  'config/opencode/agent/subagents/planning/story-mapper.md',
  'config/opencode/agent/subagents/planning/architecture-analyzer.md',
  'config/opencode/agent/subagents/planning/contract-manager.md',
  'config/opencode/agent/subagents/planning/prioritization-engine.md',
  'config/opencode/agent/subagents/code/senior-story-reviewer.md',
  'config/opencode/agent/subagents/code/senior-technical-plan-reviewer.md',
  'config/opencode/agent/subagents/code/coder-agent.md',
  'config/opencode/agent/subagents/code/test-engineer.md',
  'config/opencode/agent/subagents/code/build-agent.md',
  'config/opencode/agent/subagents/code/reviewer.md',
  'config/opencode/agent/subagents/development/devops-specialist.md',
  'config/opencode/agent/subagents/development/frontend-specialist.md',
];

async function text(relative) {
  return readFile(path.join(ROOT, relative), 'utf8');
}

function frontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  assert.ok(match?.[1], 'agent must have YAML frontmatter');
  return match[1];
}

test('canonical pipeline agents do not depend on Caveman or unsupported write permissions', async () => {
  for (const file of AGENTS) {
    const content = await text(file);
    const yaml = frontmatter(content);
    assert.doesNotMatch(content, /Mandatory Caveman|skill\(name=["']caveman["']\)/i, file);
    assert.doesNotMatch(yaml, /^\s*write\s*:/m, `${file}: OpenCode file mutation permission is edit`);
  }
});

test('OpenStage owns orchestration directly and canonical run does not use BatchExecutor', async () => {
  const orchestrator = await text('config/opencode/agent/core/openstage-orchestrator.md');
  const run = await text('config/opencode/command/pipeline-run.md');
  assert.doesNotMatch(orchestrator, /BatchExecutor|batch-executor/i);
  assert.doesNotMatch(run, /BatchExecutor|batch-executor/i);

  const metadata = JSON.parse(await text('config/opencode/config/agent-metadata.json'));
  const dependencies = metadata.agents['open-stage-orchestrator'].dependencies ?? [];
  assert.ok(!dependencies.includes('subagent:batch-executor'), 'OpenStage registry must not declare BatchExecutor');
});

test('read-only discovery agent cannot write runtime artifacts', async () => {
  const yaml = frontmatter(await text('config/opencode/agent/subagents/core/contextscout.md'));
  assert.match(yaml, /edit:\s*\n\s+["']?\*["']?:\s*deny/m);
  assert.doesNotMatch(yaml, /\.tmp\/\*\*:\s*allow/);
  assert.match(yaml, /bash:\s*\n\s+["']?\*["']?:\s*deny/m);
  assert.match(yaml, /task:\s*\n\s+["']?\*["']?:\s*deny/m);
});

test('execution agents cannot re-orchestrate the pipeline', async () => {
  const coderYaml = frontmatter(await text('config/opencode/agent/subagents/code/coder-agent.md'));
  assert.doesNotMatch(coderYaml, /TestEngineer|tester|reviewer|BuildAgent|OpenDevopsSpecialist/i);

  for (const file of [
    'config/opencode/agent/subagents/code/test-engineer.md',
    'config/opencode/agent/subagents/core/documentation.md',
    'config/opencode/agent/subagents/development/devops-specialist.md',
    'config/opencode/agent/subagents/development/frontend-specialist.md',
  ]) {
    const content = await text(file);
    assert.doesNotMatch(content, /approval_gates|Request approval before|Get approval between|approval before implementation/i, file);
  }
});

test('DevOps agent cannot directly mutate runtime infrastructure', async () => {
  const yaml = frontmatter(await text('config/opencode/agent/subagents/development/devops-specialist.md'));
  for (const destructive of [
    /docker compose up .*allow/i,
    /docker compose down .*allow/i,
    /docker compose restart .*allow/i,
    /kubectl apply .*allow/i,
    /terraform apply .*allow/i,
  ]) {
    assert.doesNotMatch(yaml, destructive);
  }
});
