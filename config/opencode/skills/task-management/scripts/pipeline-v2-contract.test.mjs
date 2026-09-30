import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validateGateManifest } from './manifest-preflight.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STAGE_CLI = path.join(HERE, 'stage-cli.ts');

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function fixture(runId = 'v2-run') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pipeline-v2-'));
  const runRoot = path.join(root, '.tmp', 'pipelines', runId);
  await mkdir(runRoot, { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@11.17.0' }));
  await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n');

  const frozen = async (relative, value = relative) => {
    const file = path.join(runRoot, relative);
    await mkdir(path.dirname(file), { recursive: true });
    const content = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    await writeFile(file, content);
    return { path: relative, sha256: sha(content) };
  };

  const artifacts = {
    decision_register: await frozen('decision-register.md', '# decisions\n'),
    technology_evidence: await frozen('technology-evidence.md', '# evidence\n'),
    contract_inventory: await frozen('contract-inventory.md', '# contracts\n'),
    test_strategy: await frozen('test-strategy.md', '# tests\n'),
    accepted_risks: await frozen('accepted-risks.md', '# risks\n'),
    work_items: await frozen('work-items/index.json', '{"items":["wi-1"]}\n'),
  };
  const architecture = await frozen('planning/architecture-1.md', '# architecture\n');
  const review = await frozen('reviews/architecture-review-1.md', '# review\n');
  const item = await frozen('work-items/wi-1.json', '{"id":"wi-1"}\n');

  const manifest = {
    schema_version: 2,
    run_id: runId,
    rules_file: 'docs/pipeline-rules.md',
    rules_version: 2,
    planning_mode: 'design-freeze',
    planning_readiness: {
      design_freeze: true,
      artifact_language: 'ru',
      required_gates: ['architecture'],
      gates: {
        architecture: {
          required: true,
          status: 'ready',
          artifact: architecture,
          review,
          cycles: 1,
          blocking_decision_ids: [],
        },
      },
      required_artifacts: artifacts,
    },
    open_decisions: [],
    allowed_change_paths: ['src/**'],
    pipelines: [{
      id: 'app',
      deployable: false,
      stages: ['implementation', 'functional-review', 'candidate-review', 'finalize'],
      executors: {
        implementation: 'agent',
        'functional-review': 'review',
        'candidate-review': 'review',
        finalize: 'agent',
      },
      work_items: ['wi-1'],
      decision_ids: [],
      research_ids: [],
      contract_ids: [],
      ready_after_stage: 'functional-review',
      release_ready_after_stage: 'candidate-review',
    }],
    work_items: [{ id: 'wi-1', pipeline_id: 'app', ...item }],
    gate_profiles: {},
  };
  const manifestPath = path.join(runRoot, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return { root, runRoot, manifest, manifestPath, frozen };
}

function run(root, args) {
  return spawnSync('npx', ['--yes', 'tsx', STAGE_CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
  });
}

test('schema v2 rejects a planning gate that is not literally ready', async () => {
  const fx = await fixture('v2-needs-revision');
  fx.manifest.planning_readiness.gates.architecture.status = 'needs_revision';
  assert.throws(
    () => validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }),
    /PLANNING_GATE_NOT_READY/,
  );
});

test('schema v2 rejects changed planning evidence by SHA-256', async () => {
  const fx = await fixture('v2-evidence-hash');
  await writeFile(path.join(fx.runRoot, 'planning', 'architecture-1.md'), '# changed\n');
  assert.throws(
    () => validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }),
    /SHA-256 mismatch/,
  );
});

test('schema v2 requires an explicit executor for every stage', async () => {
  const fx = await fixture('v2-executor-coverage');
  delete fx.manifest.pipelines[0].executors.finalize;
  assert.throws(
    () => validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }),
    /EXECUTOR_STAGE_MISMATCH/,
  );
});

test('schema v2 rejects planned source mutation after candidate publication', async () => {
  const fx = await fixture('v2-source-after-publish');
  fx.manifest.pipelines[0].stages = ['implementation', 'git-verify', 'publish', 'late-docs'];
  fx.manifest.pipelines[0].executors = {
    implementation: 'agent',
    'git-verify': 'git_verify',
    publish: 'git_publish',
    'late-docs': 'agent',
  };
  assert.throws(
    () => validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }),
    /SOURCE_STAGE_AFTER_PUBLISH/,
  );
});

test('schema v2 rejects pnpm workspace gates that fall back to npm or npx --yes', async () => {
  const fx = await fixture('v2-pnpm');
  fx.manifest.pipelines[0].stages.push('fast-tests');
  fx.manifest.pipelines[0].executors['fast-tests'] = 'local_gate';
  fx.manifest.pipelines[0].profile = 'default';
  fx.manifest.gate_profiles = { default: { 'fast-tests': ['npm test'] } };
  assert.throws(
    () => validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }),
    /JS_PACKAGE_MANAGER_MISMATCH/,
  );
  fx.manifest.gate_profiles = { default: { 'fast-tests': ['npx --yes vitest run'] } };
  assert.throws(
    () => validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }),
    /DEPENDENCY_BOOTSTRAP_FORBIDDEN/,
  );
  fx.manifest.gate_profiles = { default: { 'fast-tests': ['pnpm exec vitest run'] } };
  assert.equal(
    validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }).status,
    'PASS',
  );
});

test('schema v2 allows deterministic local test/build gates before final GitHub CI', async () => {
  const fx = await fixture('v2-authoritative-ci');
  fx.manifest.pipelines[0].stages.push('tests');
  fx.manifest.pipelines[0].executors.tests = 'local_gate';
  fx.manifest.pipelines[0].profile = 'default';
  fx.manifest.gate_profiles = { default: { tests: ['pnpm test'] } };
  assert.equal(
    validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }).status,
    'PASS',
  );

  fx.manifest.pipelines[0].executors.tests = 'github_ci';
  fx.manifest.pipelines[0].stages.splice(-1, 0, 'git-verify', 'publish');
  fx.manifest.pipelines[0].executors['git-verify'] = 'git_verify';
  fx.manifest.pipelines[0].executors.publish = 'git_publish';
  delete fx.manifest.pipelines[0].profile;
  fx.manifest.gate_profiles = {};
  fx.manifest.pipelines[0].github_gates = {
    tests: {
      workflow: '.github/workflows/ci.yml',
      terminal_job: 'pipeline_ci',
      trigger: 'push',
    },
  };
  assert.equal(
    validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }).status,
    'PASS',
  );
});

test('schema v2 freezes CI bootstrap work item and workflow scope', async () => {
  const fx = await fixture('v2-ci-bootstrap');
  const bootstrap = await fx.frozen('work-items/wi-ci.json', '{"id":"wi-ci"}\n');
  fx.manifest.work_items.push({ id: 'wi-ci', pipeline_id: 'app', ...bootstrap });
  fx.manifest.pipelines[0].work_items.push('wi-ci');
  fx.manifest.pipelines[0].stages.push('git-verify', 'publish', 'build');
  fx.manifest.pipelines[0].executors['git-verify'] = 'git_verify';
  fx.manifest.pipelines[0].executors.publish = 'git_publish';
  fx.manifest.pipelines[0].executors.build = 'github_ci';
  fx.manifest.pipelines[0].github_gates = {
    build: {
      workflow: '.github/workflows/pipeline-ci.yml',
      terminal_job: 'pipeline_ci',
      trigger: 'push',
      bootstrap_required: true,
      bootstrap_work_item_id: 'wi-ci',
    },
  };
  assert.throws(
    () => validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }),
    /GITHUB_BOOTSTRAP_SCOPE_MISSING/,
  );
  fx.manifest.allowed_change_paths.push('.github/workflows/**');
  assert.equal(
    validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }).status,
    'PASS',
  );
});

test('schema v2 supports artifactless disposable DEV from prior exact-SHA CI evidence', async () => {
  const fx = await fixture('v2-disposable-dev');
  fx.manifest.pipelines[0].stages.push('git-verify', 'publish', 'tests', 'dev');
  fx.manifest.pipelines[0].executors['git-verify'] = 'git_verify';
  fx.manifest.pipelines[0].executors.publish = 'git_publish';
  fx.manifest.pipelines[0].executors.tests = 'github_ci';
  fx.manifest.pipelines[0].executors.dev = 'github_dev';
  fx.manifest.pipelines[0].deployable = true;
  fx.manifest.pipelines[0].decision_ids.push('decision-testing-strategy');
  fx.manifest.pipelines[0].testing_strategy = {
    mode: 'github',
    owner_decision_id: 'decision-testing-strategy',
    github_validation_stage: 'tests',
  };
  fx.manifest.pipelines[0].deployment_validation = {
    stage: 'tests',
    fresh_job: 'fresh_install',
    upgrade_job: 'upgrade_install',
  };
  fx.manifest.pipelines[0].github_gates = {
    tests: {
      workflow: '.github/workflows/ci.yml',
      terminal_job: 'pipeline_ci',
      required_jobs: ['fresh_install', 'upgrade_install'],
      trigger: 'push',
    },
    dev: {
      workflow: '.github/workflows/dev-disposable.yml',
      terminal_job: 'pipeline_dev',
      trigger: 'workflow_dispatch',
      mode: 'disposable',
      source_ci_stage: 'tests',
    },
  };
  assert.equal(
    validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }).status,
    'PASS',
  );
});

test('schema v2 protects stateful DEV behind trusted default-branch workflow', async () => {
  const fx = await fixture('v2-stateful-dev');
  fx.manifest.pipelines[0].stages.push('git-verify', 'publish', 'tests', 'dev');
  fx.manifest.pipelines[0].executors['git-verify'] = 'git_verify';
  fx.manifest.pipelines[0].executors.publish = 'git_publish';
  fx.manifest.pipelines[0].executors.tests = 'github_ci';
  fx.manifest.pipelines[0].executors.dev = 'github_dev';
  fx.manifest.pipelines[0].deployable = true;
  fx.manifest.pipelines[0].decision_ids.push('decision-testing-strategy');
  fx.manifest.pipelines[0].testing_strategy = {
    mode: 'github',
    owner_decision_id: 'decision-testing-strategy',
    github_validation_stage: 'tests',
  };
  fx.manifest.pipelines[0].deployment_validation = {
    stage: 'tests',
    fresh_job: 'fresh_install',
    upgrade_job: 'upgrade_install',
  };
  fx.manifest.pipelines[0].github_gates = {
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
    },
  };

  assert.equal(
    validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }).status,
    'PASS',
  );

  fx.manifest.allowed_change_paths.push('.github/workflows/dev.yml');
  assert.throws(
    () => validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }),
    /GITHUB_STATEFUL_DEV_WORKFLOW_MUTABLE/,
  );
});

test('schema v2 keeps new stateful DEV workflow deferred until it becomes trusted', async () => {
  const fx = await fixture('v2-stateful-bootstrap');
  const bootstrap = await fx.frozen('work-items/wi-dev.json', '{"id":"wi-dev"}\n');
  fx.manifest.work_items.push({ id: 'wi-dev', pipeline_id: 'app', ...bootstrap });
  fx.manifest.pipelines[0].work_items.push('wi-dev');
  fx.manifest.allowed_change_paths.push('.github/workflows/dev.yml');
  fx.manifest.pipelines[0].stages.push('git-verify', 'publish', 'tests');
  fx.manifest.pipelines[0].executors['git-verify'] = 'git_verify';
  fx.manifest.pipelines[0].executors.publish = 'git_publish';
  fx.manifest.pipelines[0].executors.tests = 'github_ci';
  fx.manifest.pipelines[0].deployable = true;
  fx.manifest.pipelines[0].decision_ids.push('decision-testing-strategy');
  fx.manifest.pipelines[0].testing_strategy = {
    mode: 'github',
    owner_decision_id: 'decision-testing-strategy',
    github_validation_stage: 'tests',
  };
  fx.manifest.pipelines[0].deployment_validation = {
    stage: 'tests',
    fresh_job: 'fresh_install',
    upgrade_job: 'upgrade_install',
  };
  fx.manifest.pipelines[0].github_gates = {
    tests: {
      workflow: '.github/workflows/ci.yml',
      terminal_job: 'pipeline_ci',
      required_jobs: ['fresh_install', 'upgrade_install'],
      trigger: 'push',
      artifact: 'candidate-build',
    },
  };
  fx.manifest.pipelines[0].future_github_gates = {
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
      bootstrap_required: true,
      bootstrap_work_item_id: 'wi-dev',
    },
  };

  assert.equal(
    validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }).status,
    'PASS',
  );

  fx.manifest.pipelines[0].stages.push('dev');
  fx.manifest.pipelines[0].executors.dev = 'github_dev';
  assert.throws(
    () => validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }),
    /FUTURE_GITHUB_DEV_MUST_NOT_EXECUTE_CURRENT_RUN|GITHUB_GATE_MISSING/,
  );
});

test('schema v2 serializes declared conflict groups through the DAG', async () => {
  const fx = await fixture('v2-conflict');
  const secondItem = await fx.frozen('work-items/wi-2.json', '{"id":"wi-2"}\n');
  fx.manifest.work_items.push({ id: 'wi-2', pipeline_id: 'b', ...secondItem });
  fx.manifest.pipelines[0].conflict_group = 'admin';
  fx.manifest.pipelines.push({
    id: 'b',
    deployable: false,
    stages: ['implementation'],
    executors: { implementation: 'agent' },
    work_items: ['wi-2'],
    decision_ids: [],
    research_ids: [],
    contract_ids: [],
    conflict_group: 'admin',
  });
  assert.throws(
    () => validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }),
    /CONFLICT_NOT_SERIALIZED/,
  );
  fx.manifest.pipelines[1].depends_on = ['app'];
  fx.manifest.pipelines[0].ready_after_stage = 'finalize';
  fx.manifest.pipelines[0].release_ready_after_stage = 'finalize';
  assert.equal(
    validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }).status,
    'PASS',
  );
});

test('schema v2 requires source-ready milestone on depended-on pipelines', async () => {
  const fx = await fixture('v2-source-ready-required');
  const secondItem = await fx.frozen('work-items/wi-2.json', '{"id":"wi-2"}\n');
  fx.manifest.work_items.push({ id: 'wi-2', pipeline_id: 'b', ...secondItem });
  delete fx.manifest.pipelines[0].ready_after_stage;
  delete fx.manifest.pipelines[0].release_ready_after_stage;
  fx.manifest.pipelines.push({
    id: 'b',
    deployable: false,
    stages: ['implementation'],
    executors: { implementation: 'agent' },
    work_items: ['wi-2'],
    decision_ids: [],
    research_ids: [],
    contract_ids: [],
    depends_on: ['app'],
  });
  assert.throws(
    () => validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }),
    /DEPENDENCY_SOURCE_READY_STAGE_REQUIRED/,
  );
});

test('schema v2 rejects source-mutating agent stages after source-ready boundary', async () => {
  const fx = await fixture('v2-source-ready-no-late-agent');
  const secondItem = await fx.frozen('work-items/wi-2.json', '{"id":"wi-2"}\n');
  fx.manifest.work_items.push({ id: 'wi-2', pipeline_id: 'b', ...secondItem });
  fx.manifest.pipelines.push({
    id: 'b',
    deployable: false,
    stages: ['implementation'],
    executors: { implementation: 'agent' },
    work_items: ['wi-2'],
    decision_ids: [],
    research_ids: [],
    contract_ids: [],
    depends_on: ['app'],
  });
  assert.throws(
    () => validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }),
    /SOURCE_STAGE_AFTER_READY_BOUNDARY/,
  );
});

test('schema v2 freezes authoritative GitHub Issue snapshot hash', async () => {
  const fx = await fixture('v2-github');
  const snapshot = await fx.frozen('sources/github-issues.json', '{"issues":[5]}\n');
  fx.manifest.source_type = 'github_issues';
  fx.manifest.repository = 'owner/repo';
  fx.manifest.source_issues = [{ repository: 'owner/repo', number: 5, url: 'https://github.com/owner/repo/issues/5', title: 'Five' }];
  fx.manifest.pipelines[0].issue_numbers = [5];
  fx.manifest.planning_base_sha = 'a'.repeat(40);
  fx.manifest.git_setup = { base_sha: 'a'.repeat(40), branch: 'feature/v2' };
  fx.manifest.source_snapshot_sha256 = snapshot.sha256;
  assert.equal(
    validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }).status,
    'PASS',
  );
  await writeFile(path.join(fx.runRoot, 'sources', 'github-issues.json'), '{"issues":[6]}\n');
  assert.throws(
    () => validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }),
    /snapshot SHA-256 mismatch/,
  );
});

test('deployable pipelines require final GitHub CI but not fresh/upgrade GitHub jobs', async () => {
  const fx = await fixture('v2-deployable-validation');
  fx.manifest.pipelines[0].deployable = true;
  fx.manifest.pipelines[0].decision_ids.push('decision-testing-strategy');
  fx.manifest.pipelines[0].testing_strategy = {
    mode: 'github',
    owner_decision_id: 'decision-testing-strategy',
    github_validation_stage: 'tests',
  };
  fx.manifest.pipelines[0].stages.push('git-verify', 'publish', 'tests');
  fx.manifest.pipelines[0].executors['git-verify'] = 'git_verify';
  fx.manifest.pipelines[0].executors.publish = 'git_publish';
  fx.manifest.pipelines[0].executors.tests = 'github_ci';
  fx.manifest.pipelines[0].github_gates = {
    tests: {
      workflow: '.github/workflows/ci.yml',
      terminal_job: 'pipeline_ci',
      trigger: 'push',
    },
  };

  assert.throws(
    () => validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }),
    /DEPLOYMENT_VALIDATION_REQUIRED/,
  );

  fx.manifest.pipelines[0].deployment_validation = { stage: 'tests' };
  assert.equal(
    validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }).status,
    'PASS',
  );

  fx.manifest.pipelines[0].deployment_validation.fresh_job = 'fresh_install';
  assert.throws(
    () => validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }),
    /DEPLOYMENT_VALIDATION_LEGACY_JOBS_INVALID/,
  );

  fx.manifest.pipelines[0].deployment_validation.upgrade_job = 'upgrade_install';
  assert.equal(
    validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }).status,
    'PASS',
  );

  fx.manifest.pipelines[0].deployment_validation = { stage: 'implementation' };
  assert.throws(
    () => validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }),
    /DEPLOYMENT_VALIDATION_REQUIRES_FINAL_GITHUB_CI/,
  );
});

test('GitHub-driven OpenCode-host deployment still requires trusted probe evidence', async () => {
  const fx = await fixture('v2-opencode-host-target');
  const pipeline = fx.manifest.pipelines[0];
  pipeline.stages = ['implementation', 'git-verify', 'publish', 'tests', 'dev', 'owner-acceptance'];
  pipeline.executors = {
    implementation: 'agent',
    'git-verify': 'git_verify',
    publish: 'git_publish',
    tests: 'github_ci',
    dev: 'github_dev',
    'owner-acceptance': 'owner_acceptance',
  };
  pipeline.deployable = true;
  pipeline.decision_ids.push('decision-testing-strategy');
  pipeline.deployment_validation = {
    stage: 'tests',
    fresh_job: 'fresh_install',
    upgrade_job: 'upgrade_install',
  };
  pipeline.testing_strategy = {
    mode: 'opencode_host',
    owner_decision_id: 'decision-testing-strategy',
    github_validation_stage: 'tests',
    opencode_host_stage: 'dev',
    post_deploy_test: 'automated_then_user',
    owner_acceptance_stage: 'owner-acceptance',
  };
  pipeline.github_gates = {
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
  };

  await mkdir(path.join(fx.root, '.opencode'), { recursive: true });
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
      required_environment_secrets: ['DEPLOY_HOST', 'DEPLOY_USER', 'DEPLOY_SSH_KEY', 'DEPLOY_KNOWN_HOSTS'],
      runner_labels: [],
      probe_timeout_seconds: 180,
    },
  }, null, 2);
  await writeFile(path.join(fx.root, '.opencode', 'pipeline-policy.json'), policyText);
  fx.manifest.project_policy = {
    path: '.opencode/pipeline-policy.json',
    sha256: sha(policyText),
  };

  assert.throws(
    () => validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }),
    /OPENCODE_HOST_TARGET_CHECK_REQUIRED|deployment_target_check/,
  );

  fx.manifest.deployment_target_check = await fx.frozen(
    'planning/deployment-target.json',
    JSON.stringify({
      status: 'READY',
      run_id: fx.manifest.run_id,
      kind: 'opencode_host',
      transport: 'github_ssh',
      target_id: 'opencode-development-host',
      environment: 'development',
      trusted_ref: 'main',
      workflow_run_id: 10,
      probe_job: 'probe_target',
    }, null, 2),
  );
  assert.equal(
    validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }).status,
    'PASS',
  );

  const targetFile = path.join(fx.runRoot, 'planning', 'deployment-target.json');
  const mismatched = JSON.parse(await readFile(targetFile, 'utf8'));
  mismatched.transport = 'self_hosted_runner';
  const mismatchedText = JSON.stringify(mismatched, null, 2);
  await writeFile(targetFile, mismatchedText);
  fx.manifest.deployment_target_check.sha256 = sha(mismatchedText);
  assert.throws(
    () => validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }),
    /OPENCODE_HOST_TARGET_EVIDENCE_MISMATCH/,
  );
});

test('hybrid uses local post-CI deployment without GitHub-to-host probe', async () => {
  const fx = await fixture('v2-hybrid-local-cd');
  const pipeline = fx.manifest.pipelines[0];
  pipeline.stages = ['implementation', 'git-verify', 'precheck', 'publish', 'tests', 'dev'];
  pipeline.executors = {
    implementation: 'agent',
    precheck: 'local_gate',
    'git-verify': 'git_verify',
    publish: 'git_publish',
    tests: 'github_ci',
    dev: 'local_gate',
  };
  pipeline.profile = 'default';
  fx.manifest.gate_profiles = {
    default: {
      precheck: ['pnpm test'],
      dev: ['pnpm test'],
    },
  };
  pipeline.deployable = true;
  pipeline.decision_ids.push('decision-testing-strategy');
  pipeline.deployment_validation = { stage: 'tests' };
  pipeline.testing_strategy = {
    mode: 'hybrid',
    owner_decision_id: 'decision-testing-strategy',
    github_validation_stage: 'tests',
    opencode_host_stage: 'dev',
    post_deploy_test: 'automated',
  };
  pipeline.github_gates = {
    tests: {
      workflow: '.github/workflows/ci.yml',
      terminal_job: 'pipeline_ci',
      trigger: 'push',
    },
  };

  assert.equal(
    validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }).status,
    'PASS',
  );
});

test('schema v2 freezes optional project policy and enforces protected paths', async () => {
  const fx = await fixture('v2-policy');
  await mkdir(path.join(fx.root, '.opencode'), { recursive: true });
  const policyText = JSON.stringify({ schema_version: 1, protected_paths: ['protected/**'], required_gates: [] }, null, 2);
  await writeFile(path.join(fx.root, '.opencode', 'pipeline-policy.json'), policyText);
  fx.manifest.project_policy = { path: '.opencode/pipeline-policy.json', sha256: sha(policyText) };
  assert.equal(
    validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }).status,
    'PASS',
  );
  fx.manifest.allowed_change_paths.push('protected/file.ts');
  assert.throws(
    () => validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }),
    /PROTECTED_PATH_IN_SCOPE/,
  );
});

test('stage state exposes ready and release_ready milestones before completed', async () => {
  const fx = await fixture('v2-milestones');
  const stateRoot = path.join(fx.root, '.tmp', 'pipelines-state');

  let result = run(fx.root, ['init', fx.manifestPath, '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);
  result = run(fx.root, ['approve', fx.manifest.run_id, '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);

  const complete = (stage) => {
    let current = run(fx.root, ['start', fx.manifest.run_id, stage, '--pipeline', 'app', '--state-root', stateRoot]);
    assert.equal(current.status, 0, current.stderr);
    current = run(fx.root, ['complete', fx.manifest.run_id, stage, '--pipeline', 'app', '--state-root', stateRoot, '--json']);
    assert.equal(current.status, 0, current.stderr);
    return JSON.parse(current.stdout);
  };

  complete('implementation');
  let state = complete('functional-review');
  assert.equal(state.pipelines.app.status, 'ready');

  state = complete('candidate-review');
  assert.equal(state.pipelines.app.status, 'release_ready');

  state = complete('finalize');
  assert.equal(state.pipelines.app.status, 'completed');
  assert.equal(state.status, 'completed');

  const frozenManifest = await readFile(fx.manifestPath, 'utf8');
  assert.ok(frozenManifest.includes('"schema_version": 2'));
});


test('stage validate rejects planning evidence mutated after init', async () => {
  const fx = await fixture('v2-state-evidence-freeze');
  const stateRoot = path.join(fx.root, '.tmp', 'state-freeze');

  let result = run(fx.root, ['init', fx.manifestPath, '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);

  await writeFile(path.join(fx.runRoot, 'planning', 'architecture-1.md'), '# mutated after init\n');

  result = run(fx.root, ['validate', fx.manifest.run_id, '--state-root', stateRoot]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Frozen planning evidence validation failed.*SHA-256 mismatch/s);
});


test('artifact hashing CLI returns run-relative SHA-256 without mutation', async () => {
  const fx = await fixture('v2-artifact-hash-cli');
  const target = path.join(fx.runRoot, 'decision-register.md');
  const before = await readFile(target, 'utf8');

  const result = run(fx.root, [
    'artifacts',
    fx.manifest.run_id,
    'decision-register.md',
    'planning/architecture-1.md',
    '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'PASS');
  assert.deepEqual(output.artifacts.map((item) => item.path), [
    'decision-register.md',
    'planning/architecture-1.md',
  ]);
  assert.match(output.artifacts[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(await readFile(target, 'utf8'), before);
});

test('project policy CLI reports immutable path and SHA-256', async () => {
  const fx = await fixture('v2-policy-cli');
  await mkdir(path.join(fx.root, '.opencode'), { recursive: true });
  const policyText = JSON.stringify({
    schema_version: 1,
    protected_paths: ['protected/**'],
    required_gates: [{ stage: 'docs-validate', when_paths: ['docs/**'] }],
  }, null, 2);
  await writeFile(path.join(fx.root, '.opencode', 'pipeline-policy.json'), policyText);

  const result = run(fx.root, ['policy', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'PASS');
  assert.equal(output.path, '.opencode/pipeline-policy.json');
  assert.equal(output.sha256, sha(policyText));
  assert.deepEqual(output.protected_paths, ['protected/**']);
});


test('stage-cli refuses github_ci completion without exact candidate evidence', async () => {
  const fx = await fixture('v2-github-evidence');
  fx.manifest.pipelines[0].stages = ['implementation', 'git-verify', 'publish', 'tests'];
  fx.manifest.pipelines[0].executors = { implementation: 'agent', 'git-verify': 'git_verify', publish: 'git_publish', tests: 'github_ci' };
  fx.manifest.pipelines[0].github_gates = {
    tests: {
      workflow: '.github/workflows/ci.yml',
      terminal_job: 'pipeline_ci',
      trigger: 'push',
    },
  };
  delete fx.manifest.pipelines[0].ready_after_stage;
  delete fx.manifest.pipelines[0].release_ready_after_stage;
  fx.manifest.git_setup = { base_sha: 'a'.repeat(40), branch: 'feature/test' };
  await writeFile(fx.manifestPath, JSON.stringify(fx.manifest, null, 2));

  const stateRoot = path.join(fx.root, '.tmp', 'github-evidence-state');
  let result = run(fx.root, ['init', fx.manifestPath, '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);
  result = run(fx.root, ['approve', fx.manifest.run_id, '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);

  result = run(fx.root, ['start', fx.manifest.run_id, 'implementation', '--pipeline', 'app', '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);
  result = run(fx.root, ['complete', fx.manifest.run_id, 'implementation', '--pipeline', 'app', '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);

  result = run(fx.root, ['start', fx.manifest.run_id, 'git-verify', '--pipeline', 'app', '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);
  await writeFile(path.join(fx.runRoot, 'git-verify.json'), JSON.stringify({
    status: 'PASS',
    run_id: fx.manifest.run_id,
    branch: 'feature/test',
    head_sha: 'b'.repeat(40),
    changed_files: ['src/app.ts'],
    verified_at: new Date(Date.now() + 1000).toISOString(),
  }, null, 2));
  result = run(fx.root, ['complete', fx.manifest.run_id, 'git-verify', '--pipeline', 'app', '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);

  const candidateSha = 'c'.repeat(40);
  result = run(fx.root, ['start', fx.manifest.run_id, 'publish', '--pipeline', 'app', '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);
  await writeFile(path.join(fx.runRoot, 'candidate.json'), JSON.stringify({
    status: 'PASS',
    run_id: fx.manifest.run_id,
    branch: 'feature/test',
    candidate_sha: candidateSha,
    remote_sha: candidateSha,
    published_at: new Date(Date.now() + 1000).toISOString(),
  }, null, 2));
  result = run(fx.root, ['complete', fx.manifest.run_id, 'publish', '--pipeline', 'app', '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);

  result = run(fx.root, ['start', fx.manifest.run_id, 'tests', '--pipeline', 'app', '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);
  result = run(fx.root, ['complete', fx.manifest.run_id, 'tests', '--pipeline', 'app', '--state-root', stateRoot]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /EVIDENCE_MISSING/);

  await mkdir(path.join(fx.runRoot, 'github'), { recursive: true });
  await writeFile(path.join(fx.runRoot, 'github', 'app-tests.json'), JSON.stringify({
    status: 'PASS',
    run_id: fx.manifest.run_id,
    pipeline_id: 'app',
    stage: 'tests',
    executor: 'github_ci',
    repository: 'owner/repo',
    workflow: '.github/workflows/ci.yml',
    workflow_run_id: 10,
    run_attempt: 1,
    candidate_sha: candidateSha,
    head_sha: candidateSha,
    terminal_job: 'pipeline_ci',
  }, null, 2));

  result = run(fx.root, ['complete', fx.manifest.run_id, 'tests', '--pipeline', 'app', '--state-root', stateRoot, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).pipelines.app.status, 'completed');
});

test('stage-cli accepts artifactless stateful DEV evidence bound to exact source CI and installed SHA', async () => {
  const fx = await fixture('v2-stateful-dev-evidence');
  fx.manifest.pipelines[0].stages = ['implementation', 'git-verify', 'publish', 'tests', 'dev'];
  fx.manifest.pipelines[0].executors = {
    implementation: 'agent',
    'git-verify': 'git_verify',
    publish: 'git_publish',
    tests: 'github_ci',
    dev: 'github_dev',
  };
  fx.manifest.pipelines[0].deployable = true;
  fx.manifest.pipelines[0].decision_ids.push('decision-testing-strategy');
  fx.manifest.pipelines[0].testing_strategy = {
    mode: 'github',
    owner_decision_id: 'decision-testing-strategy',
    github_validation_stage: 'tests',
  };
  fx.manifest.pipelines[0].deployment_validation = {
    stage: 'tests',
    fresh_job: 'fresh_install',
    upgrade_job: 'upgrade_install',
  };
  fx.manifest.pipelines[0].github_gates = {
    tests: {
      workflow: '.github/workflows/ci.yml',
      terminal_job: 'pipeline_ci',
      required_jobs: ['fresh_install', 'upgrade_install'],
      trigger: 'push',
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
    },
  };
  delete fx.manifest.pipelines[0].ready_after_stage;
  delete fx.manifest.pipelines[0].release_ready_after_stage;
  fx.manifest.git_setup = { base_sha: 'a'.repeat(40), branch: 'feature/test' };
  await writeFile(fx.manifestPath, JSON.stringify(fx.manifest, null, 2));

  const stateRoot = path.join(fx.root, '.tmp', 'stateful-dev-state');
  let result = run(fx.root, ['init', fx.manifestPath, '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);
  result = run(fx.root, ['approve', fx.manifest.run_id, '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);

  result = run(fx.root, ['start', fx.manifest.run_id, 'implementation', '--pipeline', 'app', '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);
  result = run(fx.root, ['complete', fx.manifest.run_id, 'implementation', '--pipeline', 'app', '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);

  result = run(fx.root, ['start', fx.manifest.run_id, 'git-verify', '--pipeline', 'app', '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);
  await writeFile(path.join(fx.runRoot, 'git-verify.json'), JSON.stringify({
    status: 'PASS',
    run_id: fx.manifest.run_id,
    branch: 'feature/test',
    head_sha: 'b'.repeat(40),
    changed_files: ['src/app.ts'],
    verified_at: new Date(Date.now() + 1000).toISOString(),
  }, null, 2));
  result = run(fx.root, ['complete', fx.manifest.run_id, 'git-verify', '--pipeline', 'app', '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);

  const candidateSha = 'e'.repeat(40);
  result = run(fx.root, ['start', fx.manifest.run_id, 'publish', '--pipeline', 'app', '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);
  await writeFile(path.join(fx.runRoot, 'candidate.json'), JSON.stringify({
    status: 'PASS',
    run_id: fx.manifest.run_id,
    branch: 'feature/test',
    candidate_sha: candidateSha,
    remote_sha: candidateSha,
    published_at: new Date(Date.now() + 1000).toISOString(),
  }, null, 2));
  result = run(fx.root, ['complete', fx.manifest.run_id, 'publish', '--pipeline', 'app', '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);

  await mkdir(path.join(fx.runRoot, 'github'), { recursive: true });
  await writeFile(path.join(fx.runRoot, 'github', 'app-tests.json'), JSON.stringify({
    status: 'PASS',
    run_id: fx.manifest.run_id,
    pipeline_id: 'app',
    stage: 'tests',
    executor: 'github_ci',
    workflow: '.github/workflows/ci.yml',
    workflow_run_id: 50,
    run_attempt: 1,
    candidate_sha: candidateSha,
    head_sha: candidateSha,
    terminal_job: 'pipeline_ci',
  }, null, 2));

  result = run(fx.root, ['start', fx.manifest.run_id, 'tests', '--pipeline', 'app', '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);
  result = run(fx.root, ['complete', fx.manifest.run_id, 'tests', '--pipeline', 'app', '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);

  const republishedSha = 'f'.repeat(40);
  await writeFile(path.join(fx.runRoot, 'candidate.json'), JSON.stringify({
    status: 'PASS',
    run_id: fx.manifest.run_id,
    branch: 'feature/test',
    candidate_sha: republishedSha,
    remote_sha: republishedSha,
    published_at: new Date(Date.now() + 2000).toISOString(),
  }, null, 2));
  result = run(fx.root, ['start', fx.manifest.run_id, 'dev', '--pipeline', 'app', '--state-root', stateRoot]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /EVIDENCE_INVALID_OR_STALE/);

  await writeFile(path.join(fx.runRoot, 'candidate.json'), JSON.stringify({
    status: 'PASS',
    run_id: fx.manifest.run_id,
    branch: 'feature/test',
    candidate_sha: candidateSha,
    remote_sha: candidateSha,
    published_at: new Date(Date.now() + 1000).toISOString(),
  }, null, 2));
  result = run(fx.root, ['start', fx.manifest.run_id, 'dev', '--pipeline', 'app', '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);
  await writeFile(path.join(fx.runRoot, 'github', 'app-dev.json'), JSON.stringify({
    status: 'PASS',
    run_id: fx.manifest.run_id,
    pipeline_id: 'app',
    stage: 'dev',
    executor: 'github_dev',
    workflow: '.github/workflows/dev.yml',
    workflow_run_id: 60,
    source_ci_run_id: 50,
    candidate_sha: candidateSha,
    head_sha: 'f'.repeat(40),
    head_branch: 'main',
    terminal_job: 'pipeline_dev',
    trusted_ref: 'main',
    target_id: 'opencode-development-host',
    dev_evidence_validated: true,
    installed_sha: 'd'.repeat(40),
  }, null, 2));
  result = run(fx.root, ['complete', fx.manifest.run_id, 'dev', '--pipeline', 'app', '--state-root', stateRoot]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /EVIDENCE_INVALID_OR_STALE/);

  const valid = JSON.parse(await readFile(path.join(fx.runRoot, 'github', 'app-dev.json'), 'utf8'));
  valid.installed_sha = candidateSha;
  await writeFile(path.join(fx.runRoot, 'github', 'app-dev.json'), JSON.stringify(valid, null, 2));
  result = run(fx.root, ['complete', fx.manifest.run_id, 'dev', '--pipeline', 'app', '--state-root', stateRoot, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).pipelines.app.status, 'completed');
});

test('owner acceptance cannot be completed by model-style generic complete', async () => {
  const fx = await fixture('v2-owner-acceptance');
  const pipeline = fx.manifest.pipelines[0];
  pipeline.stages = ['implementation', 'git-verify', 'publish', 'tests', 'dev', 'owner-acceptance'];
  pipeline.executors = {
    implementation: 'agent',
    'git-verify': 'git_verify',
    publish: 'git_publish',
    tests: 'github_ci',
    dev: 'github_dev',
    'owner-acceptance': 'owner_acceptance',
  };
  pipeline.deployable = true;
  pipeline.decision_ids.push('decision-testing-strategy');
  pipeline.deployment_validation = {
    stage: 'tests',
    fresh_job: 'fresh_install',
    upgrade_job: 'upgrade_install',
  };
  pipeline.testing_strategy = {
    mode: 'opencode_host',
    owner_decision_id: 'decision-testing-strategy',
    github_validation_stage: 'tests',
    opencode_host_stage: 'dev',
    post_deploy_test: 'automated_then_user',
    owner_acceptance_stage: 'owner-acceptance',
  };
  pipeline.github_gates = {
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
  };
  delete pipeline.ready_after_stage;
  delete pipeline.release_ready_after_stage;
  fx.manifest.git_setup = { base_sha: 'a'.repeat(40), branch: 'feature/test' };

  await mkdir(path.join(fx.root, '.opencode'), { recursive: true });
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
  await writeFile(path.join(fx.root, '.opencode', 'pipeline-policy.json'), policyText);
  fx.manifest.project_policy = { path: '.opencode/pipeline-policy.json', sha256: sha(policyText) };
  fx.manifest.deployment_target_check = await fx.frozen(
    'planning/deployment-target.json',
    JSON.stringify({
      status: 'READY',
      run_id: fx.manifest.run_id,
      kind: 'opencode_host',
      transport: 'github_ssh',
      target_id: 'opencode-development-host',
      environment: 'development',
      trusted_ref: 'main',
      workflow_run_id: 99,
      probe_job: 'probe_target',
    }, null, 2),
  );
  await writeFile(fx.manifestPath, JSON.stringify(fx.manifest, null, 2));

  const stateRoot = path.join(fx.root, '.tmp', 'owner-acceptance-state');
  const invoke = (args) => run(fx.root, [...args, '--state-root', stateRoot]);
  let result = invoke(['init', fx.manifestPath]);
  assert.equal(result.status, 0, result.stderr);
  result = invoke(['approve', fx.manifest.run_id]);
  assert.equal(result.status, 0, result.stderr);

  result = invoke(['start', fx.manifest.run_id, 'implementation', '--pipeline', 'app']);
  assert.equal(result.status, 0, result.stderr);
  result = invoke(['complete', fx.manifest.run_id, 'implementation', '--pipeline', 'app']);
  assert.equal(result.status, 0, result.stderr);

  result = invoke(['start', fx.manifest.run_id, 'git-verify', '--pipeline', 'app']);
  assert.equal(result.status, 0, result.stderr);
  await writeFile(path.join(fx.runRoot, 'git-verify.json'), JSON.stringify({
    status: 'PASS',
    run_id: fx.manifest.run_id,
    branch: 'feature/test',
    head_sha: 'b'.repeat(40),
    changed_files: ['src/app.ts'],
    verified_at: new Date(Date.now() + 1000).toISOString(),
  }, null, 2));
  result = invoke(['complete', fx.manifest.run_id, 'git-verify', '--pipeline', 'app']);
  assert.equal(result.status, 0, result.stderr);

  const candidateSha = 'c'.repeat(40);
  result = invoke(['start', fx.manifest.run_id, 'publish', '--pipeline', 'app']);
  assert.equal(result.status, 0, result.stderr);
  await writeFile(path.join(fx.runRoot, 'candidate.json'), JSON.stringify({
    status: 'PASS',
    run_id: fx.manifest.run_id,
    branch: 'feature/test',
    candidate_sha: candidateSha,
    remote_sha: candidateSha,
    published_at: new Date(Date.now() + 1000).toISOString(),
  }, null, 2));
  result = invoke(['complete', fx.manifest.run_id, 'publish', '--pipeline', 'app']);
  assert.equal(result.status, 0, result.stderr);

  const digest = 'sha256:' + 'd'.repeat(64);
  await mkdir(path.join(fx.runRoot, 'github'), { recursive: true });
  await writeFile(path.join(fx.runRoot, 'github', 'app-tests.json'), JSON.stringify({
    status: 'PASS',
    run_id: fx.manifest.run_id,
    pipeline_id: 'app',
    stage: 'tests',
    executor: 'github_ci',
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
  result = invoke(['start', fx.manifest.run_id, 'tests', '--pipeline', 'app']);
  assert.equal(result.status, 0, result.stderr);
  result = invoke(['complete', fx.manifest.run_id, 'tests', '--pipeline', 'app']);
  assert.equal(result.status, 0, result.stderr);

  await writeFile(path.join(fx.runRoot, 'github', 'app-dev.json'), JSON.stringify({
    status: 'PASS',
    run_id: fx.manifest.run_id,
    pipeline_id: 'app',
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
  }, null, 2));
  result = invoke(['start', fx.manifest.run_id, 'dev', '--pipeline', 'app']);
  assert.equal(result.status, 0, result.stderr);
  result = invoke(['complete', fx.manifest.run_id, 'dev', '--pipeline', 'app']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /EVIDENCE_INVALID_OR_STALE/);

  const devEvidence = JSON.parse(await readFile(path.join(fx.runRoot, 'github', 'app-dev.json'), 'utf8'));
  devEvidence.smoke_result = 'PASS';
  await writeFile(path.join(fx.runRoot, 'github', 'app-dev.json'), JSON.stringify(devEvidence, null, 2));
  result = invoke(['complete', fx.manifest.run_id, 'dev', '--pipeline', 'app']);
  assert.equal(result.status, 0, result.stderr);

  result = invoke(['start', fx.manifest.run_id, 'owner-acceptance', '--pipeline', 'app']);
  assert.equal(result.status, 0, result.stderr);

  result = invoke(['complete', fx.manifest.run_id, 'owner-acceptance', '--pipeline', 'app']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OWNER_ACCEPTANCE_REQUIRES_EXPLICIT_OWNER_RESULT/);

  result = invoke(['fail', fx.manifest.run_id, 'owner-acceptance', '--pipeline', 'app']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OWNER_ACCEPTANCE_REQUIRES_EXPLICIT_OWNER_RESULT/);

  result = invoke([
    'owner-accept', fx.manifest.run_id, 'owner-acceptance', '--pipeline', 'app',
    '--result', 'pass', '--message', 'owner tested deployed candidate',
  ]);
  assert.equal(result.status, 0, result.stderr);

  result = invoke(['status', fx.manifest.run_id, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).pipelines.app.status, 'completed');
  const evidence = JSON.parse(await readFile(path.join(fx.runRoot, 'owner', 'app-owner-acceptance.json'), 'utf8'));
  assert.equal(evidence.status, 'PASS');
  assert.equal(evidence.gate, 'owner_acceptance');
});

test('technical fix after publish reopens verify and publish before GitHub CI', async () => {
  const fx = await fixture('v2-fix-invalidates-published-chain');
  fx.manifest.pipelines[0].stages = ['implementation', 'git-verify', 'publish', 'tests'];
  fx.manifest.pipelines[0].executors = {
    implementation: 'agent',
    'git-verify': 'git_verify',
    publish: 'git_publish',
    tests: 'github_ci',
  };
  fx.manifest.pipelines[0].github_gates = {
    tests: {
      workflow: '.github/workflows/ci.yml',
      terminal_job: 'pipeline_ci',
      trigger: 'push',
    },
  };
  delete fx.manifest.pipelines[0].ready_after_stage;
  delete fx.manifest.pipelines[0].release_ready_after_stage;
  fx.manifest.git_setup = { base_sha: 'a'.repeat(40), branch: 'feature/test' };
  await writeFile(fx.manifestPath, JSON.stringify(fx.manifest, null, 2));

  const stateRoot = path.join(fx.root, '.tmp', 'fix-invalidation-state');
  const invoke = (args) => run(fx.root, [...args, '--state-root', stateRoot]);
  let result = invoke(['init', fx.manifestPath]);
  assert.equal(result.status, 0, result.stderr);
  result = invoke(['approve', fx.manifest.run_id]);
  assert.equal(result.status, 0, result.stderr);

  result = invoke(['start', fx.manifest.run_id, 'implementation', '--pipeline', 'app']);
  assert.equal(result.status, 0, result.stderr);
  result = invoke(['complete', fx.manifest.run_id, 'implementation', '--pipeline', 'app']);
  assert.equal(result.status, 0, result.stderr);

  result = invoke(['start', fx.manifest.run_id, 'git-verify', '--pipeline', 'app']);
  assert.equal(result.status, 0, result.stderr);
  await writeFile(path.join(fx.runRoot, 'git-verify.json'), JSON.stringify({
    status: 'PASS',
    run_id: fx.manifest.run_id,
    branch: 'feature/test',
    head_sha: 'b'.repeat(40),
    changed_files: ['src/app.ts'],
    verified_at: new Date(Date.now() + 1000).toISOString(),
  }, null, 2));
  result = invoke(['complete', fx.manifest.run_id, 'git-verify', '--pipeline', 'app']);
  assert.equal(result.status, 0, result.stderr);

  result = invoke(['start', fx.manifest.run_id, 'publish', '--pipeline', 'app']);
  assert.equal(result.status, 0, result.stderr);
  await writeFile(path.join(fx.runRoot, 'candidate.json'), JSON.stringify({
    status: 'PASS',
    run_id: fx.manifest.run_id,
    branch: 'feature/test',
    candidate_sha: 'c'.repeat(40),
    remote_sha: 'c'.repeat(40),
    published_at: new Date(Date.now() + 1000).toISOString(),
  }, null, 2));
  result = invoke(['complete', fx.manifest.run_id, 'publish', '--pipeline', 'app']);
  assert.equal(result.status, 0, result.stderr);

  result = invoke(['start', fx.manifest.run_id, 'tests', '--pipeline', 'app']);
  assert.equal(result.status, 0, result.stderr);
  result = invoke(['fail', fx.manifest.run_id, 'tests', '--pipeline', 'app']);
  assert.equal(result.status, 0, result.stderr);

  result = invoke(['scope-check', fx.manifest.run_id, 'tests', 'src/app.ts', '--pipeline', 'app', '--json']);
  assert.equal(result.status, 0, result.stderr);
  result = invoke(['fix-cycle', fx.manifest.run_id, 'tests', '--pipeline', 'app', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(result.stdout);
  assert.equal(state.pipelines.app.stages['git-verify'].status, 'pending');
  assert.equal(state.pipelines.app.stages.publish.status, 'pending');
  assert.equal(state.pipelines.app.stages.tests.status, 'pending');
  assert.equal(state.pipelines.app.stages.tests.technical_fix_cycles, 1);

  result = invoke(['next', fx.manifest.run_id, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).runnable, [{ pipeline_id: 'app', stage: 'git-verify' }]);
});

test('new init and pre-approval checks reject v1 while historical v1 status remains readable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pipeline-v1-readonly-'));
  const stateRoot = path.join(root, '.tmp', 'pipelines');
  const manifestPath = path.join(root, 'manifest.json');
  const manifest = {
    schema_version: 1,
    run_id: 'legacy-v1',
    rules_file: 'docs/pipeline-rules.md',
    rules_version: 2,
    pipelines: [{ id: 'app', stages: ['implementation'] }],
    gate_profiles: {},
  };
  const manifestText = JSON.stringify(manifest, null, 2);
  await writeFile(manifestPath, manifestText);

  let result = run(root, ['plan-run-preflight', manifestPath, '--environment']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /NEW_PLAN_SCHEMA_V2_REQUIRED/);

  result = run(root, ['init', manifestPath, '--state-root', stateRoot]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /NEW_PLAN_SCHEMA_V2_REQUIRED/);

  const rulesPath = path.join(HERE, '..', 'pipeline-rules.default.md');
  const rulesText = await readFile(rulesPath, 'utf8');
  const rulesVersion = Number(rulesText.match(/rules_version:\s*(\d+)/)?.[1]);
  const legacyRoot = path.join(stateRoot, manifest.run_id);
  await mkdir(legacyRoot, { recursive: true });
  await writeFile(path.join(legacyRoot, 'state.json'), JSON.stringify({
    schema_version: 1,
    run_id: manifest.run_id,
    manifest_file: manifestPath,
    manifest_sha256: sha(manifestText),
    rules_file: rulesPath,
    rules_source: 'opencode_default',
    rules_version: rulesVersion,
    rules_sha256: sha(rulesText),
    status: 'approved',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    active_stages: [],
    pipelines: {
      app: {
        id: 'app',
        status: 'approved',
        stages: { implementation: { status: 'pending' } },
        stage_order: ['implementation'],
        depends_on: [],
      },
    },
    history: [],
  }, null, 2));

  result = run(root, ['status', manifest.run_id, '--state-root', stateRoot, '--json']);
  assert.equal(result.status, 0, result.stderr);
  result = run(root, ['run-preflight', manifest.run_id, '--state-root', stateRoot]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /LEGACY_V1_REPLAN_REQUIRED/);
});

test('technical fix counter permits exactly three cycles and blocks the fourth', async () => {
  const fx = await fixture('v2-fix-cycle-limit');
  const stateRoot = path.join(fx.root, '.tmp', 'fix-cycle-state');

  let result = run(fx.root, ['init', fx.manifestPath, '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);
  result = run(fx.root, ['approve', fx.manifest.run_id, '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);
  result = run(fx.root, ['start', fx.manifest.run_id, 'implementation', '--pipeline', 'app', '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);

  for (let cycle = 1; cycle <= 3; cycle += 1) {
    result = run(fx.root, [
      'scope-check', fx.manifest.run_id, 'implementation', 'src/app.ts', '--pipeline', 'app',
      '--state-root', stateRoot, '--json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    result = run(fx.root, [
      'fix-cycle', fx.manifest.run_id, 'implementation', '--pipeline', 'app',
      '--state-root', stateRoot, '--json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(result.stdout);
    assert.equal(state.pipelines.app.stages.implementation.technical_fix_cycles, cycle);
  }

  result = run(fx.root, [
    'scope-check', fx.manifest.run_id, 'implementation', 'src/app.ts', '--pipeline', 'app',
    '--state-root', stateRoot,
  ]);
  assert.equal(result.status, 0, result.stderr);
  result = run(fx.root, [
    'fix-cycle', fx.manifest.run_id, 'implementation', '--pipeline', 'app',
    '--state-root', stateRoot,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TECHNICAL_FIX_LIMIT_EXCEEDED/);
});


test('stage-cli supersede creates a fresh draft with lineage but never copies runtime state or machine evidence', async () => {
  const fx = await fixture('v2-supersede-old');
  let result = run(fx.root, ['init', fx.manifestPath]);
  assert.equal(result.status, 0, result.stderr);
  result = run(fx.root, ['approve', fx.manifest.run_id]);
  assert.equal(result.status, 0, result.stderr);

  await writeFile(path.join(fx.runRoot, 'candidate.json'), JSON.stringify({ status: 'PASS', candidate_sha: 'a'.repeat(40) }));
  await mkdir(path.join(fx.runRoot, 'github'), { recursive: true });
  await writeFile(path.join(fx.runRoot, 'github', 'app-tests.json'), '{"status":"FAIL"}\n');
  await mkdir(path.join(fx.runRoot, 'gates'), { recursive: true });
  await writeFile(path.join(fx.runRoot, 'gates', 'app-fast.json'), '{"status":"PASS"}\n');

  const nextRun = 'v2-supersede-new';
  result = run(fx.root, [
    'supersede', fx.manifest.run_id, nextRun,
    '--reason', 'BASELINE_SCOPE_MISMATCH',
    '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'PASS');
  assert.equal(output.old_run_id, fx.manifest.run_id);
  assert.equal(output.new_run_id, nextRun);
  assert.equal(output.state_copied, false);
  assert.equal(output.machine_evidence_copied, false);

  const nextRoot = path.join(fx.root, '.tmp', 'pipelines', nextRun);
  const nextManifestPath = path.join(nextRoot, 'manifest.json');
  const nextManifest = JSON.parse(await readFile(nextManifestPath, 'utf8'));
  assert.equal(nextManifest.run_id, nextRun);
  assert.deepEqual(nextManifest.lineage, {
    change_class: 'supersede',
    supersedes: fx.manifest.run_id,
    reason_code: 'BASELINE_SCOPE_MISMATCH',
  });
  assert.equal(await readFile(path.join(nextRoot, 'planning', 'architecture-1.md'), 'utf8'), '# architecture\n');
  await assert.rejects(readFile(path.join(nextRoot, 'state.json'), 'utf8'));
  await assert.rejects(readFile(path.join(nextRoot, 'candidate.json'), 'utf8'));
  await assert.rejects(readFile(path.join(nextRoot, 'github', 'app-tests.json'), 'utf8'));
  await assert.rejects(readFile(path.join(nextRoot, 'gates', 'app-fast.json'), 'utf8'));

  const oldState = JSON.parse(await readFile(path.join(fx.runRoot, 'state.json'), 'utf8'));
  assert.equal(oldState.superseded_by, nextRun);
  assert.equal(oldState.supersede_reason, 'BASELINE_SCOPE_MISMATCH');

  result = run(fx.root, ['next', fx.manifest.run_id, '--json']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RUN_SUPERSEDED/);
  result = run(fx.root, ['start', fx.manifest.run_id, 'implementation', '--pipeline', 'app']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RUN_SUPERSEDED/);

  result = run(fx.root, ['plan-run-preflight', nextManifestPath, '--environment']);
  assert.equal(result.status, 0, result.stderr);
});


test('schema v2 validates preserved baseline shape and reason-coded lineage', async () => {
  const fx = await fixture('v2-baseline-lineage');
  fx.manifest.git_setup = { base_sha: 'a'.repeat(40), branch: 'feature/existing' };
  fx.manifest.preserved_baseline = {
    head_sha: 'b'.repeat(40),
    changed_paths: ['src/z.ts', 'src/a.ts'],
    diff_sha256: 'c'.repeat(64),
  };
  assert.throws(
    () => validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }),
    /PRESERVED_BASELINE_PATHS_NOT_SORTED/,
  );

  fx.manifest.preserved_baseline.changed_paths = ['src/a.ts', 'src/z.ts'];
  fx.manifest.lineage = {
    change_class: 'supersede',
    supersedes: 'older-run',
    reason_code: 'NOT_A_REASON',
  };
  assert.throws(
    () => validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }),
    /PIPELINE_LINEAGE_INVALID/,
  );

  fx.manifest.lineage.reason_code = 'BASELINE_SCOPE_MISMATCH';
  assert.equal(
    validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }).status,
    'PASS',
  );
});
