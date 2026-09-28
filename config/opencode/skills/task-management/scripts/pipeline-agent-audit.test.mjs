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
  assert.match(run, /never delegate orchestration to BatchExecutor/i);

  const metadata = JSON.parse(await text('config/opencode/config/agent-metadata.json'));
  const dependencies = metadata.agents['open-stage-orchestrator'].dependencies ?? [];
  assert.ok(!dependencies.includes('subagent:batch-executor'), 'OpenStage registry must not declare BatchExecutor');
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


test('implementation agents can author workflow files but cannot run raw GitHub or SSH lifecycle commands', async () => {
  for (const file of [
    'config/opencode/agent/subagents/code/coder-agent.md',
    'config/opencode/agent/subagents/development/devops-specialist.md',
  ]) {
    const yaml = frontmatter(await text(file));
    assert.match(yaml, /edit:\s*\n\s+["']?\*["']?:\s*allow/, file);
    assert.match(yaml, /bash:\s*\n\s+["']?\*["']?:\s*deny/, file);
    assert.doesNotMatch(yaml, /["'](?:gh|ssh)\s+\*["']:\s*allow/i, file);
  }
});

test('OpenStage exposes only deterministic GitHub lifecycle commands', async () => {
  const yaml = frontmatter(await text('config/opencode/agent/core/openstage-orchestrator.md'));
  for (const required of [
    /github-issue-cli\.ts\*": allow/,
    /github-pr-cli\.ts\*": allow/,
    /github-actions-gate-cli\.ts\*": allow/,
    /deployment-target-cli\.ts\*": allow/,
    /pipeline-github-sync\.mjs\*": allow/,
  ]) {
    assert.match(yaml, required);
  }
  assert.doesNotMatch(yaml, /["']gh\s+\*["']:\s*allow/i);
  assert.doesNotMatch(yaml, /["']ssh\s+\*["']:\s*allow/i);
  assert.doesNotMatch(yaml, /gh\s+pr\s+merge/i);
});


test('planning agents do not delegate nested subagents', async () => {
  for (const file of [
    'config/opencode/agent/subagents/planning/story-mapper.md',
    'config/opencode/agent/subagents/planning/architecture-analyzer.md',
    'config/opencode/agent/subagents/planning/contract-manager.md',
    'config/opencode/agent/subagents/core/task-manager.md',
    'config/opencode/agent/subagents/core/documentation.md',
  ]) {
    const yaml = frontmatter(await text(file));
    assert.ok(permissionDenied(yaml, 'task'), `${file}: nested task delegation must be denied`);
  }
});

test('OpenStage cannot edit deterministic pipeline state or machine evidence', async () => {
  const yaml = frontmatter(await text('config/opencode/agent/core/openstage-orchestrator.md'));
  for (const path of [
    'state\\.json', 'candidate\\.json', 'git-verify\\.json', 'git-runtime\\.json',
    'github/\\*\\*', 'gates/\\*\\*', 'owner/\\*\\*', 'sources/github-issues\\.json',
    'planning/deployment-target\\.json',
  ]) {
    assert.match(yaml, new RegExp('\\.tmp/pipelines/\\*\\*/' + path + '"?:\\s*deny'));
  }
});

test('deployment testing mode is an explicit owner choice and OpenStage has no raw SSH/GitHub shell', async () => {
  const plan = await text('config/opencode/command/pipeline-plan.md');
  const run = await text('config/opencode/command/pipeline-run.md');
  const yaml = frontmatter(await text('config/opencode/agent/core/openstage-orchestrator.md'));
  assert.match(plan, /must not choose it/i);
  assert.match(plan, /github.*opencode_host.*hybrid/s);
  assert.match(run, /stage-cli owner-accept/);
  assert.doesNotMatch(yaml, /["']ssh\s+\*["']:\s*allow/i);
  assert.doesNotMatch(yaml, /["']gh\s+\*["']:\s*allow/i);
});

test('canonical RUN requires deterministic v2 run-preflight before next', async () => {
  const run = await text('config/opencode/command/pipeline-run.md');
  const orchestrator = await text('config/opencode/agent/core/openstage-orchestrator.md');
  assert.match(run, /stage-cli run-preflight <run-id>/);
  assert.match(run, /LEGACY_V1_REPLAN_REQUIRED/);
  assert.match(orchestrator, /stage-cli run-preflight/);
});

test('pipeline contracts pin three technical-fix cycles and literal ready planning gates', async () => {
  const plan = await text('config/opencode/command/pipeline-plan.md');
  const run = await text('config/opencode/command/pipeline-run.md');
  const orchestrator = await text('config/opencode/agent/core/openstage-orchestrator.md');
  const rules = await text('config/opencode/skills/task-management/pipeline-rules.default.md');

  assert.match(plan, /up to \*\*3 cycles\*\*/);
  assert.match(run, /Maximum \*\*3 automatic technical_fix cycles/);
  assert.match(run, /stage-cli fix-cycle/);
  assert.match(orchestrator, /up to 3 autonomous revision\/rerun cycles/);
  assert.match(rules, /maximum automatic technical-fix cycles are \*\*3 per stage\/work-item\*\*/i);
  assert.match(plan, /gate advances only on literal `status: ready`/i);
});


test('PLAN proves v2 run viability and baseline scope before owner approval', async () => {
  const plan = await text('config/opencode/command/pipeline-plan.md');
  assert.match(plan, /stage-cli\.ts plan-run-preflight/);
  assert.match(plan, /git-worktree-cli\.ts adopt/);
  assert.match(plan, /git-worktree-cli\.ts verify/);
  assert.match(plan, /git-worktree-cli\.ts baseline <planning-base-sha>/);
  assert.match(plan, /preserved_baseline/);
});

test('RUN uses deterministic publication and CI diagnostics before owner shell intervention', async () => {
  const run = await text('config/opencode/command/pipeline-run.md');
  const orchestrator = await text('config/opencode/agent/core/openstage-orchestrator.md');
  assert.match(run, /publish.*owns staging.*candidate commit.*non-force push/is);
  assert.match(run, /diagnose.*per-job.*\.log/is);
  assert.match(run, /log \.\.\. --job\|--job-id/i);
  assert.match(orchestrator, /GitHub `run\/diagnose\/log` owns CI evidence and logs/i);
  assert.match(orchestrator, /never ask the owner to fetch or reshape evidence/i);
});


test('GitHub gate reliability keeps pre-terminal evidence and real negative live coverage', async () => {
  const run = await text('config/opencode/command/pipeline-run.md');
  const rules = await text('config/opencode/skills/task-management/pipeline-rules.default.md');
  const live = await text('.github/workflows/pipeline-live-smoke.yml');
  const negative = await text('.github/workflows/pipeline-gate-live-failure-fixture.yml');
  const contracts = await text('.github/workflows/pipeline-contracts.yml');

  assert.match(run, /FAIL\/BLOCKED.*canonical.*phase/is);
  assert.match(rules, /canonical BLOCKED evidence/i);
  assert.match(rules, /failure_phase/);
  assert.match(live, /Dispatch intentional failure and require canonical FAIL evidence/);
  assert.match(live, /Assert live failure diagnostics and redaction/);
  assert.match(negative, /Intentional fixture failure/);
  assert.match(contracts, /github-actions-gate-runtime\.test\.mjs/);
});
