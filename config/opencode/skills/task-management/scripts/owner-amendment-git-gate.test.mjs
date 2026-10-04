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
    work_items: await frozen(artifactRoot, 'work-items/index.json', '{"schema":2}\n'),
  };
  const workItemArtifact = await frozen(
    artifactRoot,
    'work-items/WI-OWNER-1.json',
    JSON.stringify({ id: 'WI-OWNER-1', pipeline_id: 'onboarding' }),
  );
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
    pipelines: [{
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
    }],
    work_items: [{
      id: 'WI-OWNER-1',
      pipeline_id: 'onboarding',
      ...workItemArtifact,
    }],
  };

  const manifestPath = path.join(artifactRoot, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { root, worktree, runId, stateRoot, artifactRoot, manifestPath };
}

test('owner-amend-apply output is accepted by git verify and stays exact-path bounded', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));

  let result = stage(f.worktree, ['init', f.manifestPath, '--state-root', f.stateRoot]);
  assert.equal(result.status, 0, result.stderr);
  result = stage(f.worktree, ['approve', f.runId, '--state-root', f.stateRoot]);
  assert.equal(result.status, 0, result.stderr);

  // This test isolates the machine handoff from an already-failed owner checkpoint.
  // The explicit owner acceptance lifecycle itself is covered by pipeline-v2-contract.test.mjs.
  const statePath = path.join(f.artifactRoot, 'state.json');
  const before = JSON.parse(await readFile(statePath, 'utf8'));
  before.status = 'blocked';
  before.current_stage = 'onboarding/owner-acceptance';
  before.pipelines.onboarding.status = 'blocked';
  before.pipelines.onboarding.current_stage = 'owner-acceptance';
  before.pipelines.onboarding.stages['owner-acceptance'].status = 'blocked';
  before.pipelines.onboarding.stages['owner-acceptance'].message = 'owner requested bounded correction';
  await writeFile(statePath, `${JSON.stringify(before, null, 2)}\n`, 'utf8');

  const amendmentPath = path.join(f.artifactRoot, 'owner', 'owner-amendment.json');
  await mkdir(path.dirname(amendmentPath), { recursive: true });
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

  result = stage(f.worktree, [
    'owner-amend-apply', f.runId, 'owner-acceptance', '--pipeline', 'onboarding',
    '--evidence', amendmentPath, '--state-root', f.stateRoot,
  ]);
  assert.equal(result.status, 0, result.stderr);

  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.runtime_scope_extensions.length, 1);
  assert.equal(state.runtime_scope_extensions[0].scope_class, 'owner_amendment');
  assert.deepEqual(state.runtime_scope_extensions[0].paths, ['src/amended.txt']);
  assert.equal(state.pipelines.onboarding.stages.implementation.status, 'pending');
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
