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
    'planning/deployment-target\\.json', 'rules/\\*\\*',
  ]) {
    assert.match(yaml, new RegExp('\\.tmp/pipelines/\\*\\*/' + path + '"?:\\s*deny'));
  }
});

test('deployment mode is owner-selected, local-first, and OpenStage has no raw deployment shell', async () => {
  const plan = await text('config/opencode/command/pipeline-plan.md');
  const run = await text('config/opencode/command/pipeline-run.md');
  const yaml = frontmatter(await text('config/opencode/agent/core/openstage-orchestrator.md'));
  assert.match(plan, /must not choose it/i);
  assert.match(plan, /github.*opencode_host.*hybrid/s);
  assert.match(plan, /git_verify[\s\S]*local fail-fast[\s\S]*git_publish[\s\S]*GitHub CI/i);
  assert.match(plan, /hybrid[\s\S]*post-CI[\s\S]*local_gate/i);
  assert.match(run, /stage-cli owner-accept/);
  assert.match(run, /hybrid[\s\S]*post-CI[\s\S]*local_gate/i);
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

test('pipeline contracts use an initial three-cycle budget with owner-controlled extensions', async () => {
  const plan = await text('config/opencode/command/pipeline-plan.md');
  const run = await text('config/opencode/command/pipeline-run.md');
  const orchestrator = await text('config/opencode/agent/core/openstage-orchestrator.md');
  const rules = await text('config/opencode/skills/task-management/pipeline-rules.default.md');
  const reviewer = await text('config/opencode/agent/subagents/code/senior-technical-plan-reviewer.md');

  assert.match(plan, /up to \*\*3 cycles\*\*/);
  assert.match(run, /initial automatic budget is \*\*3 technical_fix cycles/i);
  assert.match(run, /stage-cli fix-budget-add/);
  assert.match(run, /stage-cli runtime-replan-propose/);
  assert.match(run, /stage-cli runtime-replan-approve/);
  assert.match(run, /explicit owner approval even under `--unattended`/i);
  assert.match(orchestrator, /initial fix budget is 3 cycles/i);
  assert.match(orchestrator, /Never infer approval from `--unattended`/i);
  assert.match(rules, /initial automatic technical-fix budget is \*\*3 per stage\/work-item\*\*/i);
  assert.match(reviewer, /ready_for_owner_approval/);
  assert.match(reviewer, /needs_owner_clarification/);
  assert.match(plan, /gate advances only on literal `status: ready`/i);
});


test('RUN finishes the active fix cycle before budget checkpoint and never auto-selects runtime replan', async () => {
  const run = await text('config/opencode/command/pipeline-run.md');
  const orchestrator = await text('config/opencode/agent/core/openstage-orchestrator.md');
  const rules = await text('config/opencode/skills/task-management/pipeline-rules.default.md');

  assert.match(run, /already started.*CodeReviewer\/review result.*N\/N/is);
  assert.match(run, /Budget exhaustion is checked only when.*next.*source-changing repair/is);
  assert.match(run, /runtime replan.*only on explicit owner intent/is);
  assert.match(run, /owner says only.*\+N.*fix-budget-add.*do not add architecture review implicitly/is);

  assert.match(orchestrator, /already-started cycle must finish through its frozen downstream review\/gates/i);
  assert.match(orchestrator, /executor=`review`.*CodeReviewer/i);
  assert.match(orchestrator, /Budget exhaustion matters only when.*next.*fix-cycle/is);
  assert.match(orchestrator, /runtime replan.*only when the owner explicitly requests/i);
  assert.match(orchestrator, /plain owner `\+N` grant must not trigger architecture review/i);

  assert.match(rules, /does not interrupt an already-started repair/i);
  assert.match(rules, /executor=`review` runs CodeReviewer/i);
  assert.match(rules, /runtime replan may be offered.*only on explicit owner request/is);
  assert.match(rules, /plain `\+N` grant means continue the current approach/is);
});


test('pipeline contracts require source-ready scheduling and artifactless integrated delivery', async () => {
  const plan = await text('config/opencode/command/pipeline-plan.md');
  const run = await text('config/opencode/command/pipeline-run.md');
  const status = await text('config/opencode/command/pipeline-status.md');
  const rules = await text('config/opencode/skills/task-management/pipeline-rules.default.md');
  const orchestrator = await text('config/opencode/agent/core/openstage-orchestrator.md');

  assert.match(plan, /ready_after_stage.*source-ready boundary/is);
  assert.match(plan, /terminal DAG sink.*cumulative product/is);
  assert.match(plan, /artifactless.*MUST NOT use `actions\/upload-artifact`/is);
  assert.match(run, /dependency is satisfied.*ready_after_stage/is);
  assert.match(run, /late CI\/CD\/infrastructure blocker.*does not freeze downstream source work/is);
  assert.match(run, /artifactless.*candidate_sha.*required-job evidence/is);
  assert.match(rules, /terminal DAG sink owns the single integrated publish\/validation chain/is);
  assert.match(status, /integrated candidate/i);
  assert.match(orchestrator, /single integrated publish\/CI\/DEV chain/i);
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


test('rules drift is adopted from the current file for both rule sources', async () => {
  const run = await text('config/opencode/command/pipeline-run.md');
  const orchestrator = await text('config/opencode/agent/core/openstage-orchestrator.md');
  const rules = await text('config/opencode/skills/task-management/pipeline-rules.default.md');

  assert.match(run, /Rules are live external policy/i);
  assert.match(run, /changed rules hash\/version is not a blocker/i);
  assert.match(orchestrator, /changed rules version\/SHA metadata is adopted automatically/i);
  assert.match(rules, /project-local .* and distribution .* follow the same lifecycle/is);
  assert.match(rules, /does not BLOCK by itself/i);
  assert.doesNotMatch(run, /DEFAULT_RULES_SNAPSHOT_REQUIRED|stage-cli rules-refresh/);
});

test('pipeline agents cannot edit project or distribution rules', async () => {
  for (const file of [
    'config/opencode/agent/subagents/core/stage-orchestrator.md',
    'config/opencode/agent/subagents/code/coder-agent.md',
    'config/opencode/agent/subagents/code/test-engineer.md',
    'config/opencode/agent/subagents/core/documentation.md',
    'config/opencode/agent/subagents/development/devops-specialist.md',
  ]) {
    const yaml = frontmatter(await text(file));
    assert.match(yaml, /["']docs\/pipeline-rules\.md["']:\s*deny/, file);
    assert.match(yaml, /["']\*\*\/pipeline-rules\.default\.md["']:\s*deny/, file);
  }

  const config = JSON.parse(await text('config/opencode/opencode.json'));
  assert.equal(config.agent.CoderAgent.permission.edit['docs/pipeline-rules.md'], 'deny');
  assert.equal(config.agent.CoderAgent.permission.edit['**/pipeline-rules.default.md'], 'deny');
});


test('RUN authorizes bounded runtime scope before consuming technical-fix cycles', async () => {
  const plan = await text('config/opencode/command/pipeline-plan.md');
  const run = await text('config/opencode/command/pipeline-run.md');
  const orchestrator = await text('config/opencode/agent/core/openstage-orchestrator.md');
  const rules = await text('config/opencode/skills/task-management/pipeline-rules.default.md');
  const reviewer = await text('config/opencode/agent/subagents/code/senior-technical-plan-reviewer.md');

  assert.match(plan, /base.*allowed_change_paths/i);
  assert.match(plan, /Do not attempt to enumerate every future test/i);
  assert.match(run, /stage-cli scope-check/);
  assert.match(run, /TECHNICAL_SCOPE_REVIEW_REQUIRED/);
  assert.match(run, /stage-cli scope-extend/);
  assert.match(run, /Only after scope preflight PASS call `stage-cli fix-cycle/i);
  assert.match(run, /inside the \*\*same\*\* cycle/i);
  assert.match(orchestrator, /scope-check/);
  assert.match(orchestrator, /scope-extend/);
  assert.match(rules, /machine-owned effective scope/i);
  assert.match(reviewer, /runtime-scope-review-<n>\.json/);
});
