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

function permissionDenied(yaml, key) {
  const scalar = new RegExp(`^\\s*${key}:\\s*deny\\s*$`, 'm');
  const mapping = new RegExp(`${key}:\\s*\\n\\s+["']?\\*["']?:\\s*deny`, 'm');
  return scalar.test(yaml) || mapping.test(yaml);
}

test('canonical pipeline agents do not depend on Caveman or unsupported write permissions', async () => {
  for (const file of AGENTS) {
    const content = await text(file);
    const yaml = frontmatter(content);
    assert.doesNotMatch(content, /Mandatory Caveman|skill\(name=["']caveman["']\)/i, file);
    assert.doesNotMatch(yaml, /^\s*write\s*:/m, `${file}: OpenCode file mutation permission is edit`);
  }
});

test('OpenStage owns orchestration directly and registry does not require BatchExecutor', async () => {
  const orchestrator = await text('config/opencode/agent/core/openstage-orchestrator.md');
  const orchestratorYaml = frontmatter(orchestrator);
  const run = await text('config/opencode/command/pipeline-run.md');
  assert.doesNotMatch(orchestratorYaml, /BatchExecutor|batch-executor/i);
  assert.match(orchestrator, /Do not invoke `BatchExecutor`/);
  assert.match(run, /Не делегируй orchestration в\s+BatchExecutor/i);

  const metadata = JSON.parse(await text('config/opencode/config/agent-metadata.json'));
  const dependencies = metadata.agents['open-stage-orchestrator'].dependencies ?? [];
  assert.ok(!dependencies.includes('subagent:batch-executor'), 'OpenStage registry must not declare BatchExecutor');
});

test('canonical pipeline leaves product priority with the owner', async () => {
  const orchestratorYaml = frontmatter(await text('config/opencode/agent/core/openstage-orchestrator.md'));
  const plan = await text('config/opencode/command/pipeline-plan.md');

  assert.doesNotMatch(orchestratorYaml, /^\s*(?:prioritization-engine|PrioritizationEngine):\s*allow\s*$/m);
  assert.match(plan, /Product\/backlog priority не является частью PLAN/);
  assert.match(plan, /`PrioritizationEngine` не вызывай/);
});

test('OpenChamber pipeline bootstrap requires an isolated worktree session', async () => {
  const pipeline = await text('config/opencode/command/pipeline.md');
  assert.match(pipeline, /openchamber.*session\.create/is);
  assert.match(pipeline, /isolated worktree session/i);
  assert.match(pipeline, /`worktree`/);
  assert.match(pipeline, /`branch`/);
  assert.match(pipeline, /`prompt`: `\/pipeline-plan \$ARGUMENTS`/);
  assert.match(pipeline, /не включай Goal Mode/i);
  assert.doesNotMatch(pipeline, /git-worktree-cli\.ts setup/);
});

test('canonical plan freezes linked worktree identity and hands off to pipeline-start', async () => {
  const plan = await text('config/opencode/command/pipeline-plan.md');
  assert.match(plan, /"workspace_mode": "linked_worktree"/);
  assert.match(plan, /linked_worktree: true/);
  assert.match(plan, /\/pipeline-start \{run-id\}/);
  assert.match(plan, /pipeline-init-cli\.ts <manifest>/);
});

test('pipeline-start verifies without mutation and dispatches Goal execution in the same worktree', async () => {
  const start = await text('config/opencode/command/pipeline-start.md');
  assert.match(start, /git-worktree-cli\.ts capability/);
  assert.doesNotMatch(start, /```text\s*\ngit-worktree-cli\.ts adopt/);
  assert.match(start, /Одноразовый `git-worktree-cli\.ts adopt` принадлежит только `\/pipeline-run`/);
  assert.match(start, /`goal: true`/);
  assert.match(start, /`prompt`: `\/pipeline-run <run-id> --unattended`/);
  assert.match(start, /не передавай `worktree` и `branch`/);
});

test('pipeline-run adopts linked worktree and never falls back to setup', async () => {
  const run = await text('config/opencode/command/pipeline-run.md');
  assert.match(run, /git_setup\.workspace_mode == linked_worktree/);
  assert.match(run, /git-worktree-cli\.ts adopt <manifest>/);
  assert.match(run, /Никогда не делай fallback к `setup`/);
});

test('read-only discovery agent cannot write runtime artifacts', async () => {
  const yaml = frontmatter(await text('config/opencode/agent/subagents/core/contextscout.md'));
  assert.ok(permissionDenied(yaml, 'edit'), 'ContextScout edit permission must deny');
  assert.doesNotMatch(yaml, /\.tmp\/\*\*:\s*allow/);
  assert.ok(permissionDenied(yaml, 'bash'), 'ContextScout bash permission must deny');
  assert.ok(permissionDenied(yaml, 'task'), 'ContextScout task permission must deny');
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
