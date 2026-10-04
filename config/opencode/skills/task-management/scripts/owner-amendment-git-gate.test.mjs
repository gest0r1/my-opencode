import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STAGE_CLI = path.join(HERE, 'stage-cli.ts');
const GIT_CLI = path.join(HERE, 'git-worktree-cli.ts');

function run(cwd, command, args) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', env: process.env });
}

function exec(cwd, command, args) {
  const result = run(cwd, command, args);
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

function stage(cwd, args) {
  return run(cwd, 'npx', ['--yes', 'tsx', STAGE_CLI, ...args]);
}

function gitGate(cwd, args) {
  return run(cwd, 'npx', ['--yes', 'tsx', GIT_CLI, ...args]);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function frozen(root, relative, content) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
  return { path: relative, sha256: sha256(content) };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'owner-amend-git-gate-'));
  const remote = path.join(root, 'remote.git');
  const main = path.join(root, 'main');
  const worktree = path.join(root, 'worktree');
  const policyText = JSON.stringify({
    schema_version: 1,
    protected_paths: [],
    required_gates: [],
    deployment_target: {
      kind: 'opencode_host',
      transport: 'github_ssh',
      target_id: 'opencode-development-host',
      environment: 'development',
      probe_workflow: '.github/workflows/deployment-target-probe.yml',
      probe_job: 'probe_target',
      trusted_ref: 'main',
      required_environment_secrets: ['DEPLOY_SSH_KEY'],
      runner_labels: [],
      probe_timeout_seconds: 180,
    },
  }, null, 2);

  exec(root, 'git', ['init', '--bare', remote]);
  await mkdir(main);
  exec(main, 'git', ['init']);
  exec(main, 'git', ['config', 'user.name', 'Pipeline Test']);
  exec(main, 'git', ['config', 'user.email', 'pipeline@example.invalid']);
  await mkdir(path.join(main, 'src'));
  await mkdir(path.join(main, '.opencode'));
  await writeFile(path.join(main, '.gitignore'), '.tmp/\n');
  await writeFile(path.join(main, 'src/base.txt'), 'base\n');
  await writeFile(path.join(main, '.opencode/pipeline-policy.json'), policyText);
  exec(main, 'git', ['add', '.']);
  exec(main, 'git', ['commit', '-m', 'base']);
  exec(main, 'git', ['branch', '-M', 'main']);
  exec(main, 'git', ['remote', 'add', 'origin', remote]);
  exec(main, 'git', ['push', '-u', 'origin', 'main']);
  const base = exec(main, 'git', ['rev-parse', 'HEAD']);
  exec(main, 'git', ['worktree', 'add', '-b', 'feature/owner-amend', worktree, 'main']);

  const runId = 'run-owner-amend';
  const stateRoot = path.join(worktree, '.tmp', 'pipelines');
  const artifactRoot = path.join(stateRoot, runId);
  await mkdir(artifactRoot, { recursive: true });

  const architecture = await frozen(artifactRoot, 'planning/architecture.md', '# architecture\n');
  const architectureReview = await frozen(artifactRoot, 'reviews/architecture.md', '# review\n');
  const requiredArtifacts = {
    decision_register: await frozen(artifactRoot, 'decision-register.md', '# decisions\n'),
    technology_evidence: await frozen(artifactRoot, 'technology-evidence.md', '# evidence\n'),
    contract_inventory: await frozen(artifactRoot, 'contract-inventory.md', '# contracts\n'),
    work_items: await frozen(artifactRoot, 'work-items/index.json', '{"schema":2}\n'),
  };
  const workItemContent = JSON.stringify({ id: 'WI-OWNER-1', pipeline_id: 'onboarding' });
  const workItemArtifact = await frozen(artifactRoot, 'work-items/WI-OWNER-1.json', workItemContent);
  const deploymentTarget = await frozen(
    artifactRoot,
    'planning/deployment-target.json',
    JSON.stringify({
      status: 'READY',
      run_id: runId,
      kind: 'opencode_host',
      transport: 'github_ssh',
      target_id: 'opencode-development-host',
      environment: 'development',
      trusted_ref: 'main',
      workflow_run_id: 99,
      probe_job: 'probe_target',
    }, null, 2),
  );

  const manifest = {
    schema_version: 2,
    run_id: runId,
    rules_file: 'docs/pipeline-rules.md',
    rules_version: 2,
    planning_mode: 'design-freeze',
    planning_readiness: {
      design_freeze: true,
      required_gates: ['architecture'],
      gates: {
        architecture: {
          required: true,
          status: 'ready',
          cycles: 1,
          artifact: architecture,
          review: architectureReview,
          blocking_decision_ids: [],
        },
      },
      required_artifacts: requiredArtifacts,
    },
    open_decisions: [],
    planning_base_sha: base,
    allowed_change_paths: ['src/base.txt'],
    gate_profiles: {},
    git_setup: {
      base_sha: base,
      branch: 'feature/owner-amend',
      must_absent: [],
    },
    project_policy: {
      path: '.opencode/pipeline-policy.json',
      sha256: sha256(policyText),
    },
    deployment_target_check: deploymentTarget,
    pipelines: [
      {
        id: 'onboarding',
        deployable: true,
        stages: ['implementation', 'git-verify', 'publish', 'tests', 'dev', 'owner-acceptance'],
        executors: {
          implementation: 'agent',
          'git-verify': 'git_verify',
          publish: 'git_publish',
          tests: 'github_ci',
          dev: 'github_dev',
          'owner-acceptance': 'owner_acceptance',
        },
        deployment_validation: {
          stage: 'tests',
          fresh_job: 'fresh_install',
          upgrade_job: 'upgrade_install',
        },
        testing_strategy: {
          mode: 'opencode_host',
          owner_decision_id: 'decision-testing-strategy',
          github_validation_stage: 'tests',
          opencode_host_stage: 'dev',
          post_deploy_test: 'automated_then_user',
          owner_acceptance_stage: 'owner-acceptance',
        },
        github_gates: {
          tests: {
            workflow: '.github/workflows/ci.yml',
            terminal_job: 'pipeline_ci',
            required_jobs: ['fresh_install', 'upgrade_install'],
            trigger: 'push',
            artifact: 'candidate-build',
          },
          dev: {
            workflow: '.github/workflows/dev.yml',
            terminal_job: 'pipeline_dev',
            trigger: 'workflow_dispatch',
            mode: 'stateful',
            environment: 'development',
            trusted_ref: 'main',
            concurrency_group: 'development',
            target_id: 'opencode-development-host',
            source_ci_stage: 'tests',
            artifact: 'dev-evidence',
            evidence_file: 'dev-evidence.json',
          },
        },
        work_items: ['WI-OWNER-1'],
        decision_ids: ['decision-testing-strategy'],
        research_ids: [],
        contract_ids: [],
      },
    ],
    work_items: [
      {
        id: 'WI-OWNER-1',
        pipeline_id: 'onboarding',
        ...workItemArtifact,
      },
    ],
  };

  const manifestPath = path.join(artifactRoot, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { root, worktree, runId, stateRoot, artifactRoot, manifestPath, base };
}

async function reachOwnerAcceptanceFailure(f) {
  const invoke = (args) => stage(f.worktree, [...args, '--state-root', f.stateRoot]);
  let result = invoke(['init', f.manifestPath]);
  assert.equal(result.status, 0, result.stderr);
  result = invoke(['approve', f.runId]);
  assert.equal(result.status, 0, result.stderr);

  result = invoke(['start', f.runId, 'implementation', '--pipeline', 'onboarding']);
  assert.equal(result.status, 0, result.stderr);
  result = invoke(['complete', f.runId, 'implementation', '--pipeline', 'onboarding']);
  assert.equal(result.status, 0, result.stderr);

  result = invoke(['start', f.runId, 'git-verify', '--pipeline', 'onboarding']);
  assert.equal(result.status, 0, result.stderr);
  await writeFile(path.join(f.artifactRoot, 'git-verify.json'), JSON.stringify({
    status: 'PASS',
    run_id: f.runId,
    branch: 'feature/owner-amend',
    head_sha: f.base,
    changed_files: [],
    verified_at: new Date(Date.now() + 1000).toISOString(),
  }, null, 2));
  result = invoke(['complete', f.runId, 'git-verify', '--pipeline', 'onboarding']);
  assert.equal(result.status, 0, result.stderr);

  const candidateSha = 'c'.repeat(40);
  result = invoke(['start', f.runId, 'publish', '--pipeline', 'onboarding']);
  assert.equal(result.status, 0, result.stderr);
  await writeFile(path.join(f.artifactRoot, 'candidate.json'), JSON.stringify({
    status: 'PASS',
    run_id: f.runId,
    branch: 'feature/owner-amend',
    candidate_sha: candidateSha,
    remote_sha: candidateSha,
    published_at: new Date(Date.now() + 1000).toISOString(),
  }, null, 2));
  result = invoke(['complete', f.runId, 'publish', '--pipeline', 'onboarding']);
  assert.equal(result.status, 0, result.stderr);

  const digest = 'sha256:' + 'd'.repeat(64);
  await mkdir(path.join(f.artifactRoot, 'github'), { recursive: true });
  await writeFile(path.join(f.artifactRoot, 'github', 'onboarding-tests.json'), JSON.stringify({
    status: 'PASS',
    run_id: f.runId,
    pipeline_id: 'onboarding',
    stage: 'tests',
    executor: 'github_ci',
    repository: 'owner/repo',
    workflow: '.github/workflows/ci.yml',
    workflow_run_id: 50,
    run_attempt: 1,
    candidate_sha: candidateSha,
    head_sha: candidateSha,
    terminal_job: 'pipeline_ci',
    artifact: 'candidate-build',
    artifact_id: 90,
    artifact_digest: digest,
  }, null, 2));
  result = invoke(['start', f.runId, 'tests', '--pipeline', 'onboarding']);
  assert.equal(result.status, 0, result.stderr);
  result = invoke(['complete', f.runId, 'tests', '--pipeline', 'onboarding']);
  assert.equal(result.status, 0, result.stderr);

  await writeFile(path.join(f.artifactRoot, 'github', 'onboarding-dev.json'), JSON.stringify({
    status: 'PASS',
    run_id: f.runId,
    pipeline_id: 'onboarding',
    stage: 'dev',
    executor: 'github_dev',
    workflow: '.github/workflows/dev.yml',
    workflow_run_id: 60,
    source_ci_run_id: 50,
    candidate_sha: candidateSha,
    head_sha: 'e'.repeat(40),
    head_branch: 'main',
    terminal_job: 'pipeline_dev',
    trusted_ref: 'main',
    target_id: 'opencode-development-host',
    dev_evidence_validated: true,
    ci_artifact_id: 90,
    ci_artifact_digest: digest,
    installed_sha: candidateSha,
    smoke_result: 'PASS',
  }, null, 2));
  result = invoke(['start', f.runId, 'dev', '--pipeline', 'onboarding']);
  assert.equal(result.status, 0, result.stderr);
  result = invoke(['complete', f.runId, 'dev', '--pipeline', 'onboarding']);
  assert.equal(result.status, 0, result.stderr);

  result = invoke(['start', f.runId, 'owner-acceptance', '--pipeline', 'onboarding']);
  assert.equal(result.status, 0, result.stderr);
  result = invoke([
    'owner-accept', f.runId, 'owner-acceptance', '--pipeline', 'onboarding',
    '--result', 'fail', '--message', 'Owner requests a bounded UI correction',
  ]);
  assert.equal(result.status, 0, result.stderr);
}

test('owner-amend-apply runtime scope is accepted by git verify and remains exact', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await reachOwnerAcceptanceFailure(f);

  const amendmentPath = path.join(f.artifactRoot, 'owner', 'owner-amendment.json');
  await writeFile(amendmentPath, `${JSON.stringify({
    kind: 'owner_amendment',
    status: 'ready',
    bounded: true,
    pipeline_id: 'onboarding',
    source_stage: 'owner-acceptance',
    target_stage: 'implementation',
    work_item_id: 'WI-OWNER-1',
    new_work_item_required: false,
    summary: 'Allow one exact implementation path requested by owner acceptance',
    paths: ['src/amended.txt'],
    work_items: [],
    requirements_changed: true,
    acceptance_criteria_changed: true,
    business_intent_changed: false,
    external_contract_changed: false,
    security_boundary_changed: false,
    destructive_change: false,
  }, null, 2)}\n`, 'utf8');

  let result = stage(f.worktree, [
    'owner-amend-apply', f.runId, 'owner-acceptance', '--pipeline', 'onboarding',
    '--evidence', amendmentPath, '--state-root', f.stateRoot,
  ]);
  assert.equal(result.status, 0, result.stderr);

  const state = JSON.parse(await readFile(path.join(f.artifactRoot, 'state.json'), 'utf8'));
  assert.equal(state.runtime_scope_extensions.length, 1);
  assert.equal(state.runtime_scope_extensions[0].scope_class, 'owner_amendment');
  assert.deepEqual(state.runtime_scope_extensions[0].paths, ['src/amended.txt']);
  assert.equal(state.pipelines.onboarding.stages.implementation.status, 'pending');
  assert.equal(state.pipelines.onboarding.stages['git-verify'].status, 'pending');
  assert.equal(state.pipelines.onboarding.stages.publish.status, 'pending');
  assert.equal(state.pipelines.onboarding.stages.tests.status, 'pending');
  assert.equal(state.pipelines.onboarding.stages.dev.status, 'pending');
  assert.equal(state.pipelines.onboarding.stages['owner-acceptance'].status, 'pending');

  await writeFile(path.join(f.worktree, 'src/amended.txt'), 'owner-approved amendment\n');
  result = gitGate(f.worktree, ['verify', f.manifestPath]);
  assert.equal(result.status, 0, result.stderr);
  const verify = JSON.parse(result.stdout);
  assert.deepEqual(verify.changed_files, ['src/amended.txt']);
  const verifyEvidence = JSON.parse(await readFile(path.join(f.artifactRoot, 'git-verify.json'), 'utf8'));
  assert.equal(verifyEvidence.runtime_scope_extensions[0].scope_class, 'owner_amendment');
  assert.ok(verifyEvidence.effective_allowed_change_paths.includes('src/amended.txt'));

  await writeFile(path.join(f.worktree, 'src/outside.txt'), 'not owner approved\n');
  result = gitGate(f.worktree, ['verify', f.manifestPath]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside effective scope/);
});
