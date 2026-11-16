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
  'config/opencode/agent/subagents/core/web-researcher.md',
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
    /pipeline-replan-cli\.ts\*": allow/,
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
    'planning/deployment-target\\.json', 'refresh-impact\\.json',
    'planning/refresh-impact\\.json', 'rules/\\*\\*',
  ]) {
    assert.match(yaml, new RegExp('\\.tmp/pipelines/\\*\\*/' + path + '"?:\\s*deny'));
  }
});

test('deployment mode is owner-selected, local-first, and OpenStage has no raw deployment shell', async () => {
  const plan = await text('config/opencode/command/pipeline-plan.md');
  const run = await text('config/opencode/command/pipeline-run.md');
  const yaml = frontmatter(await text('config/opencode/agent/core/openstage-orchestrator.md'));
  assert.match(plan, /must not choose it/i);
  assert.match(plan, /git_verify[\s\S]*local fail-fast[\s\S]*git_publish[\s\S]*candidate gate[\s\S]*dev_deploy[\s\S]*owner_acceptance/i);
  assert.match(plan, /mode: "hybrid"/);
  assert.match(run, /stage-cli owner-accept/);
  assert.match(run, /`dev_deploy`[\s\S]*sudo -n \/usr\/local\/sbin\/opencode-deploy-target <deploy_target> <candidate_sha>/);
  assert.match(run, /Never install another way/);
  assert.doesNotMatch(yaml, /["']ssh\s+\*["']:\s*allow/i);
  assert.doesNotMatch(yaml, /["']gh\s+\*["']:\s*allow/i);
});

test('canonical RUN requires deterministic v2 run-preflight before next', async () => {
  const run = await text('config/opencode/command/pipeline-run.md');
  const orchestrator = await text('config/opencode/agent/core/openstage-orchestrator.md');
  assert.match(run, /stage-cli run-preflight <run-id>/);
  assert.match(run, /LEGACY_V1_REPLAN_REQUIRED/);
});

test('pipeline contracts use a five-cycle shared repair budget with owner-controlled overrides', async () => {
  const plan = await text('config/opencode/command/pipeline-plan.md');
  const run = await text('config/opencode/command/pipeline-run.md');
  const status = await text('config/opencode/command/pipeline-status.md');
  const orchestrator = await text('config/opencode/agent/core/openstage-orchestrator.md');
  const rules = await text('config/opencode/skills/task-management/pipeline-rules.default.md');
  const reviewer = await text('config/opencode/agent/subagents/code/senior-technical-plan-reviewer.md');
  const codeReviewer = await text('config/opencode/agent/subagents/code/reviewer.md');

  assert.match(plan, /Up to \*\*3 autonomous revisions\*\*/); // planning-gate revision budget remains separate
  // The ledger, not the orchestrator, counts planning reviews; recurring classes need research first.
  assert.match(plan, /stage-cli plan-review <run-id> <gate> --evidence <review>/);
  assert.match(plan, /research_then_rework/);
  assert.match(plan, /--carry <file>/);
  assert.match(plan, /review_scope: full/);
  assert.doesNotMatch(plan, /owner-continue/);
  assert.match(orchestrator, /planning\/review-ledger\.json": deny/);
  // A recurring defect class stops the RUN patch loop for research and a class review.
  assert.match(run, /CLASS_REVIEW_REQUIRED/);
  assert.match(run, /stage-cli class-review-record <run-id> <stage> --pipeline <id> --evidence <class-review\.json>/);
  assert.match(run, /NEW research/);
  assert.doesNotMatch(run, /CLASS_RECURRENCE_AFTER_REWORK/);
  assert.match(codeReviewer, /`defect_class` key/);
  assert.match(reviewer, /missing_prior_art/);
  assert.match(plan, /--fix-cycles <5\.\.20>/);
  assert.match(run, /default automatic budget is \*\*5 cycles per review\/final machine gate\*\*/i);
  assert.match(run, /stage-cli fix-budget-set/);
  assert.match(run, /stage-cli fix-budget-add/);
  assert.match(run, /stage-cli security-fix-check/);
  assert.match(run, /--repair-class security_fix/);
  assert.match(run, /stage-cli runtime-replan-propose/);
  assert.match(run, /stage-cli runtime-replan-approve/);
  assert.match(run, /`--unattended` never supplies runtime-replan approval/i);
  assert.match(rules, /Implementation continuations and advisory tests have no budget/i);
  // Session reuse is reported honestly and measured at the end of every RUN.
  assert.match(run, /`session_reuse`: `resumed` or `fresh:<reason>`/);
  assert.match(run, /runtime_reload_required: true/);
  assert.match(run, /Never dispatch a reviewer \(fresh or "the same one"\) to persist/);
  assert.match(run, /Closing a RUN[\s\S]*reuse-report\.mjs <run-id>/);
  assert.match(orchestrator, /scripts\/reuse-report\.mjs \*": allow/);
  assert.match(rules, /severity alone never forces a stop/i);
  assert.match(status, /правила счёта — по RUN-команде/);
  assert.match(reviewer, /ready_for_owner_approval/);
  assert.match(reviewer, /needs_owner_clarification/);
  assert.match(codeReviewer, /technical_fix \| security_fix \| replan/);
  assert.match(codeReviewer, /"privilege_expansion": false/);
  assert.match(plan, /gate advances only on literal `status: ready`/i);
});


test('RUN finishes the active repair cycle before budget checkpoint and never auto-selects runtime replan', async () => {
  const run = await text('config/opencode/command/pipeline-run.md');
  const orchestrator = await text('config/opencode/agent/core/openstage-orchestrator.md');
  const rules = await text('config/opencode/skills/task-management/pipeline-rules.default.md');

  assert.match(run, /cycle already started.*finish through that review\/gate.*N\/N/is);
  assert.match(run, /Budget exhaustion is checked only when.*next.*source-changing repair/is);
  assert.match(run, /Runtime replan this block.*only on explicit owner intent/is);
  assert.match(run, /explicit `\+N`.*fix-budget-add/is);


  assert.match(rules, /does not interrupt an already-started repair/i);
  assert.match(rules, /executor=`review` runs CodeReviewer/i);
  assert.match(rules, /runtime replan may be offered.*only on explicit owner request/is);
  assert.match(rules, /plain `\+N` grant means continue the current approach/is);
});


test('pipeline contracts require source-ready scheduling, local fail-fast, and artifactless final CI', async () => {
  const plan = await text('config/opencode/command/pipeline-plan.md');
  const run = await text('config/opencode/command/pipeline-run.md');
  const status = await text('config/opencode/command/pipeline-status.md');
  const rules = await text('config/opencode/skills/task-management/pipeline-rules.default.md');
  const orchestrator = await text('config/opencode/agent/core/openstage-orchestrator.md');

  assert.match(plan, /ready_after_stage.*source-ready boundary/is);
  assert.match(plan, /terminal DAG sink[\s\S]*local fail-fast[\s\S]*git_publish[\s\S]*dev_deploy/i);
  assert.match(plan, /GitHub Actions are not used/);
  assert.match(plan, /DELIVERY_TAIL_REQUIRED/);
  assert.match(run, /dependency is satisfied.*ready_after_stage/is);
  assert.match(run, /late CI\/CD\/infrastructure blocker.*does not freeze downstream source work/is);
  assert.match(run, /artifactless.*candidate_sha.*required-job evidence/is);
  assert.match(rules, /terminal DAG sink owns the single integrated publish\/validation chain/is);
  assert.match(rules, /after `git_verify` and before `git_publish`/i);
  assert.match(status, /integrated candidate/i);
});

test('PLAN proves v2 run viability and baseline scope before owner approval', async () => {
  const plan = await text('config/opencode/command/pipeline-plan.md');
  const cli = await text('config/opencode/skills/task-management/scripts/stage-cli.ts');
  assert.match(plan, /stage-cli\.ts plan-check \.tmp\/pipelines\/\{run-id\}\/manifest\.json/);
  assert.match(plan, /stage-cli\.ts plan-start \.tmp\/pipelines\/\{run-id\}\/manifest\.json/);
  assert.match(cli, /'plan-run-preflight', manifest, '--environment'[\s\S]*'adopt', manifest[\s\S]*'verify', manifest/);
  assert.match(plan, /git-worktree-cli\.ts baseline <planning-base-sha>/);
  assert.match(plan, /preserved_baseline/);
});

test('RUN uses deterministic publication and CI diagnostics before owner shell intervention', async () => {
  const run = await text('config/opencode/command/pipeline-run.md');
  const orchestrator = await text('config/opencode/agent/core/openstage-orchestrator.md');
  assert.match(run, /publish.*owns staging.*candidate commit.*non-force push/is);
  assert.match(run, /diagnose.*per-job.*\.log/is);
  assert.match(run, /log \.\.\. --job\|--job-id/i);
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
  assert.match(rules, /project-local .* and distribution .* follow the same lifecycle/is);
  assert.match(rules, /does not BLOCK by itself/i);
  assert.doesNotMatch(run, /DEFAULT_RULES_SNAPSHOT_REQUIRED|stage-cli rules-refresh/);
});

test('pipeline agents cannot edit project or distribution rules', async () => {
  for (const file of [
    'config/opencode/agent/subagents/code/coder-agent.md',
    'config/opencode/agent/subagents/code/test-engineer.md',
    'config/opencode/agent/subagents/core/documentation.md',
    'config/opencode/agent/subagents/development/devops-specialist.md',
  ]) {
    const yaml = frontmatter(await text(file));
    if (/edit:\s*deny/.test(yaml)) continue;
    assert.match(yaml, /["']?docs\/pipeline-rules\.md["']?:\s*deny/, file);
    assert.match(yaml, /["']\*\*\/pipeline-rules\.default\.md["']:\s*deny/, file);
  }

  const yaml = frontmatter(await text('config/opencode/agent/subagents/code/coder-agent.md'));
  assert.match(yaml, /["']?docs\/pipeline-rules\.md["']?:\s*deny/);
  assert.match(yaml, /["']\*\*\/pipeline-rules\.default\.md["']:\s*deny/);
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
  assert.match(rules, /machine-owned effective scope/i);
  assert.match(reviewer, /runtime-scope-review-<n>\.json/);
});


test('parent keeps pipeline transport file-backed and orchestration-only', async () => {
  const parent = await text('config/opencode/agent/core/openstage-orchestrator.md');
  assert.match(parent, /At entry load only the active installed command/);
  assert.match(parent, /commands\/pipeline-\{plan,run,replan,status,release,quick\}/);
  assert.match(parent, /context\/transport rules below own what crosses the parent conversation boundary/i);
  assert.match(parent, /do not read that packet in the parent/i);
  assert.match(parent, /detail_required=false/);
  assert.match(parent, /Never invent `sessionID`/);
});

test('shell-running workers keep every command in the foreground until it finishes', async () => {
  for (const relative of [
    'config/opencode/agent/subagents/code/coder-agent.md',
    'config/opencode/agent/subagents/code/test-engineer.md',
    'config/opencode/agent/subagents/code/build-agent.md',
  ]) {
    const content = (await text(relative)).replace(/\s+/g, ' ');
    assert.match(content, /Every shell command runs in the foreground with `timeout: 3600000`/, relative);
    assert.match(content, /never end your turn while a command you started is still running/, relative);
  }
});

test('PLAN instructions carry test rework, plan probe and checkpoint rules', async () => {
  const flat = async (p) => (await text(p)).replace(/\s+/g, ' ');
  const plan = await flat('config/opencode/command/pipeline-plan.md');
  for (const re of [/test_rework: \[\{id, path, action, reason, work_item_id, required_by\}\]/, /`test_preparation:\s*true/, /never raise timeouts/i,
    /--plan-probe/, /planning\/probes\//, /PLAN_PROBE_REQUIRED/, /TEST_REWORK_\*/, /pre-publish/, /PIPELINE_SCRATCH_DIR/,
    /real production entry/, /openchamber_render/, /awaitAnswer/, /only the artifact's author agent edits it/]) {
    assert.match(plan, re);
  }
  assert.doesNotMatch(plan, /RUN may add concrete test\/support paths inside an already-approved/);
  const arch = await flat('config/opencode/agent/subagents/planning/architecture-analyzer.md');
  assert.match(arch, /Repair checkpoint mode/);
  assert.match(arch, /no_change \| apply_within_requirements \| requirements_change/);
  assert.match(arch, /architecture-review-record/);
  const reviewer = await flat('config/opencode/agent/subagents/code/senior-technical-plan-reviewer.md');
  assert.match(reviewer, /test rework completeness/);
  assert.match(reviewer, /Do not demand contradictory test splitting/);
  assert.match(reviewer, /PASS `planning\/probes\//);
  assert.match(await flat('config/opencode/agent/subagents/code/senior-story-reviewer.md'), /Never demand further atomisation/);
  assert.match(await flat('config/opencode/agent/subagents/core/task-manager.md'), /`test_preparation: true` lane/);
  assert.match(await flat('config/opencode/agent/subagents/core/contextscout.md'), /one level up/);
});

const flatRun = async (relative) => (await text(relative)).replace(/\s+/g, ' ');

test('RUN instructions carry architecture checkpoint, cross-lane repair, bounded diagnostics and Russian owner messages', async () => {
  const run = await flatRun('config/opencode/command/pipeline-run.md');
  const orch = await text('config/opencode/agent/core/openstage-orchestrator.md');
  assert.match(run, /architecture_review_due.*ARCHITECTURE_REVIEW_REQUIRED.*architecture-review-record/i);
  assert.match(run, /apply_within_requirements.*requirements_change.*Unrelated runnable lanes continue/i);
  assert.match(run, /--repair-pipeline <lane>/);
  assert.match(run, /--include-pre-run --paths/);
  assert.match(run, /OpenStage runs short sequential commands itself in the foreground/);
  assert.match(run, /explicit limit: at most N shell calls and M minutes/);
  assert.match(run, /always in Russian/);
  assert.match(run, /ask once/);
  assert.match(run, /openchamber_render/);
  assert.match(run, /gh issue create --repo .* --body-file \.tmp\/pipelines\/<run-id>\//);
  // Creating a follow-up Issue is an external write and must request owner permission.
  // It is no longer implicitly authorized by a prior discussion of the finding.
  assert.match(orch, /"gh issue create --repo \* --title \* --body-file \.tmp\/pipelines\/\*": ask/);
  assert.match(orch, /"gh issue create -R \* -t \* -F \.tmp\/pipelines\/\*": ask/);
  assert.doesNotMatch(orch, /"gh \*"/);
  const reviewer = await flatRun('config/opencode/agent/subagents/code/reviewer.md');
  assert.match(reviewer, /enumerate the whole class across the reviewed change/);
  assert.match(reviewer, /name the class and list the instances still remaining/i);
  assert.match(await flatRun('config/opencode/agent/subagents/code/coder-agent.md'), /Never raise a test time limit/);
  assert.match(await flatRun('config/opencode/agent/subagents/code/gate-runner.md'), /obey them/);
});

test('OpenStage cannot run the legacy supersede clone that closes a RUN irreversibly', async () => {
  const text = await readFile('config/opencode/agent/core/openstage-orchestrator.md', 'utf8');
  const lines = text.split('\n');
  const allow = lines.findIndex(line => line.includes('scripts/stage-cli.ts*": allow'));
  for (const prefix of ['$HOME/.config/opencode/node_modules/.bin/tsx', 'npx --yes tsx', 'npx tsx']) {
    const deny = lines.findIndex(line => line.includes(`"${prefix} $HOME/.config/opencode/skills/task-management/scripts/stage-cli.ts supersede*": deny`));
    assert.ok(deny > allow && allow >= 0, `${prefix} supersede deny must follow the stage-cli allow`);
  }
});
