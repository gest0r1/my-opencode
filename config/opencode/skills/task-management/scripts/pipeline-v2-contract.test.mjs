import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validateGateManifest } from './manifest-preflight.mjs';
import { planProbeCommandsSha256, planProbeMatches, validatePlanProbes } from './manifest-v2-policy.mjs';
import { planProbeInputDigest } from './plan-probe-identity.mjs';
import { withApprovalArgs } from './test-approval-args.mjs';

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

  const architecture = await frozen('planning/architecture-1.md', '# architecture\n');
  const artifacts = {
    decision_register: await frozen('decision-register.md', '# decisions\n'),
    architecture,
    work_items: await frozen('work-items/index.json', '{"items":["wi-1","wi-finalize"]}\n'),
  };
  const review = await frozen('reviews/architecture-review-1.md', '# review\n');
  const item = await frozen('work-items/wi-1.json',
    JSON.stringify({ id: 'wi-1', pipeline_id: 'app', stage: 'implementation', suggested_agent: 'CoderAgent' }) + '\n');
  const finalize = await frozen('work-items/wi-finalize.json',
    JSON.stringify({ id: 'wi-finalize', pipeline_id: 'app', stage: 'finalize', suggested_agent: 'CoderAgent' }) + '\n');

  const manifest = {
    schema_version: 2,
    work_item_output_contract_version: 1,
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
      work_items: ['wi-1', 'wi-finalize'],
      decision_ids: [],
      research_ids: [],
      contract_ids: [],
      ready_after_stage: 'functional-review',
      release_ready_after_stage: 'candidate-review',
    }],
    work_items: [{ id: 'wi-1', pipeline_id: 'app', ...item }, { id: 'wi-finalize', pipeline_id: 'app', ...finalize }],
    gate_profiles: {},
  };
  const manifestPath = path.join(runRoot, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return { root, runRoot, manifest, manifestPath, frozen };
}


async function alignFixtureWorkItems(fx) {
  // Tests that replace pipeline stages must also replace the frozen work-item map.
  // Only valid fixtures can test later gate/deploy/owner contracts meaningfully.
  const pipeline = fx.manifest.pipelines[0];
  const item = fx.manifest.work_items.find(entry => entry.id === 'wi-finalize');
  if (!item) return;
  const otherAgentStages = pipeline.stages.filter(stage =>
    stage !== 'implementation' && pipeline.executors?.[stage] === 'agent');
  if (!otherAgentStages.length) {
    pipeline.work_items = pipeline.work_items.filter(id => id !== 'wi-finalize');
    fx.manifest.work_items = fx.manifest.work_items.filter(entry => entry.id !== 'wi-finalize');
  } else if (otherAgentStages[0] !== 'finalize') {
    const content = JSON.stringify({ id: 'wi-finalize', pipeline_id: 'app',
      stage: otherAgentStages[0], suggested_agent: 'CoderAgent' }) + '\n';
    await writeFile(path.join(fx.runRoot, item.path), content);
    item.sha256 = sha(content);
  }
}


// Real disposable Git fixture: published evidence must match the local HEAD,
// selected branch and clean worktree. Never weaken that production guard for tests.
async function publishedFixtureHead(fx) {
  await writeFile(path.join(fx.root, '.gitignore'), '.tmp/\n');
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: fx.root, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  git('init', '-b', 'feature/test');
  git('config', 'user.name', 'Pipeline fixture');
  git('config', 'user.email', 'pipeline-fixture@example.invalid');
  git('add', '.');
  git('commit', '-m', 'frozen candidate fixture');
  const head = git('rev-parse', 'HEAD');
  fx.manifest.git_setup.base_sha = head;
  await writeFile(fx.manifestPath, JSON.stringify(fx.manifest, null, 2));
  return head;
}

function run(root, args) {
  const fixtureBin = path.join(root, '.fixture-bin');
  return spawnSync('npx', ['--yes', 'tsx', STAGE_CLI, ...withApprovalArgs(root, args)], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fixtureBin}${path.delimiter}${process.env.PATH ?? ''}` },
  });
}

test('PLAN live evidence requires the same pipeline, baseline HEAD, phase and preflight inputs', () => {
  const commands = ['pnpm exec vitest run --config vitest.live.ts'];
  const resource = { image: 'postgres:16@sha256:' + 'c'.repeat(64), command_indexes: [0],
    preflight_command: 'node scripts/validate.mjs --pipeline-preflight' };
  const head = 'a'.repeat(40);
  const manifest = {
    run_id: 'test-live', git_setup: { base_sha: head },
    pipelines: [
      { id: 'api', profile: 'local' }, { id: 'web', profile: 'local' },
    ],
    gate_testing: { local: { tests: { live_postgres: resource } } },
  };
  const target = { pipeline_id: 'api', profile: 'local', gate: 'tests', commands };
  const probe = {
    kind: 'plan_probe', phase: 'plan_probe', status: 'PASS', run_id: 'test-live',
    pipeline_id: 'api', profile: 'local', gate: 'tests',
    candidate_sha: null, preflight_status: 'PASS', manifest_sha256: 'b'.repeat(64),
    commands_sha256: planProbeCommandsSha256(commands), head_sha: head,
    input_digest: planProbeInputDigest(commands, resource, head),
  };
  assert.equal(planProbeMatches(probe, manifest, target), true);
  for (const mutant of [
    { pipeline_id: 'web' }, { phase: 'run' }, { candidate_sha: 'd'.repeat(40) },
    { preflight_status: 'FAIL' }, { head_sha: 'd'.repeat(40) },
    { input_digest: 'd'.repeat(64) }, { manifest_sha256: null },
  ]) assert.equal(planProbeMatches({ ...probe, ...mutant }, manifest, target), false, JSON.stringify(mutant));
  const changed = { ...manifest, gate_testing: { local: { tests: {
    live_postgres: { ...resource, image: 'postgres:17@sha256:' + 'c'.repeat(64) },
  } } } };
  assert.equal(planProbeMatches(probe, changed, target), false);
  const newBaseline = { ...manifest, git_setup: { base_sha: 'e'.repeat(40) } };
  assert.equal(planProbeMatches(probe, newBaseline, target), false);
});

test('PLAN refuses a ready Story gate without a publishable final full review', async () => {
  const fx = await fixture('story-full-approval-contract');
  const story = await fx.frozen('stories/issue-123.md', '# story\n');
  const badReview = await fx.frozen('reviews/story-review-1.md', 'status: ready\nreview_scope: delta\n');
  fx.manifest.planning_readiness.required_gates.push('stories');
  fx.manifest.planning_readiness.gates.stories = {
    required: true, status: 'ready', artifact: story, review: badReview,
    cycles: 1, blocking_decision_ids: [],
  };

  assert.throws(
    () => validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }),
    /STORY_REVIEW_NOT_FULL_READY/,
  );
  const goodReview = await fx.frozen('reviews/story-review-2.md', 'status: ready\nreview_scope: full\n');
  fx.manifest.planning_readiness.gates.stories.review = goodReview;
  assert.doesNotThrow(() => validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }));
});

test('PLAN and publication contract accept only an exact ledger-bound technical carry', async () => {
  const fx = await fixture('story-carry-contract');
  const story = await fx.frozen('stories/issue-123.md', '# existing story\n');
  const review = await fx.frozen('reviews/story-review-4.md', 'status: needs_revision\nreview_scope: full\n');
  const carry = await fx.frozen('planning/carried-story-findings.md', '# technical checks for RUN\n');
  const ledger = {
    schema: 1, run_id: fx.manifest.run_id,
    entries: [
      { kind: 'review', gate: 'stories', status: 'needs_revision', scope: 'full',
        owner_decision: false, path: review.path, sha256: review.sha256, classes: ['test-only'], at: '2026-11-04T00:00:00Z' },
      { kind: 'carry', gate: 'stories', path: carry.path, sha256: carry.sha256,
        review_sha256: review.sha256, at: '2026-11-04T00:01:00Z' },
    ],
  };
  await writeFile(path.join(fx.runRoot, 'planning', 'review-ledger.json'), JSON.stringify(ledger));
  fx.manifest.planning_readiness.required_gates.push('stories');
  fx.manifest.planning_readiness.gates.stories = { required: true, status: 'ready',
    artifact: story, review, cycles: 4, blocking_decision_ids: [] };
  fx.manifest.planning_readiness.carried_findings = [carry];
  assert.doesNotThrow(() => validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }));

  fx.manifest.planning_readiness.carried_findings = [];
  assert.throws(
    () => validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }),
    /STORY_REVIEW_NOT_FULL_READY/,
  );
  fx.manifest.planning_readiness.carried_findings = [carry];
  ledger.entries[0].owner_decision = true;
  await writeFile(path.join(fx.runRoot, 'planning', 'review-ledger.json'), JSON.stringify(ledger));
  assert.throws(
    () => validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }),
    /STORY_REVIEW_NOT_FULL_READY/,
  );
});

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
  delete fx.manifest.pipelines[0].executors.finalize;;
  await alignFixtureWorkItems(fx)
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
  await alignFixtureWorkItems(fx)
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
  const bootstrap = await fx.frozen('work-items/wi-ci.json', JSON.stringify({ id: 'wi-ci', pipeline_id: 'app', stage: 'implementation', suggested_agent: 'CoderAgent' }) + '\n');
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
      artifact: 'dev-evidence',
      evidence_file: 'dev-evidence.json',
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
  const bootstrap = await fx.frozen('work-items/wi-dev.json', JSON.stringify({ id: 'wi-dev', pipeline_id: 'app', stage: 'implementation', suggested_agent: 'CoderAgent' }) + '\n');
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
  const secondItem = await fx.frozen('work-items/wi-2.json', JSON.stringify({ id: 'wi-2', pipeline_id: 'b', stage: 'implementation', suggested_agent: 'CoderAgent' }) + '\n');
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
  const secondItem = await fx.frozen('work-items/wi-2.json', JSON.stringify({ id: 'wi-2', pipeline_id: 'b', stage: 'implementation', suggested_agent: 'CoderAgent' }) + '\n');
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
  const secondItem = await fx.frozen('work-items/wi-2.json', JSON.stringify({ id: 'wi-2', pipeline_id: 'b', stage: 'implementation', suggested_agent: 'CoderAgent' }) + '\n');
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

test('schema v2 requires semantic GitHub Issue digest without a local snapshot', async () => {
  const fx = await fixture('v2-github');
  fx.manifest.source_type = 'github_issues';
  fx.manifest.repository = 'owner/repo';
  fx.manifest.source_issues = [{ repository: 'owner/repo', number: 5, url: 'https://github.com/owner/repo/issues/5', title: 'Five' }];
  fx.manifest.pipelines[0].issue_numbers = [5];
  fx.manifest.planning_base_sha = 'a'.repeat(40);
  fx.manifest.git_setup = { base_sha: 'a'.repeat(40), branch: 'feature/v2' };

  assert.throws(
    () => validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }),
    /source_requirements_sha256/,
  );

  fx.manifest.source_requirements_sha256 = '1'.repeat(64);
  assert.equal(
    validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }).status,
    'PASS',
  );
});

test('schema v2 validates optional planning read-sets for incremental refresh', async () => {
  const fx = await fixture('v2-planning-inputs');
  fx.manifest.planning_inputs = {
    architecture: ['src/**'],
    work_items: ['src/app.ts'],
  };
  assert.equal(
    validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }).status,
    'PASS',
  );
  fx.manifest.planning_inputs.architecture = ['src/*.ts'];
  assert.throws(
    () => validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }),
    /planning_inputs\.architecture/,
  );
});

test('schema v2 validates semantic GitHub Issue requirements digest shape', async () => {
  const fx = await fixture('v2-github-semantic');
  fx.manifest.source_type = 'github_issues';
  fx.manifest.repository = 'owner/repo';
  fx.manifest.source_issues = [{ repository: 'owner/repo', number: 5, url: 'https://github.com/owner/repo/issues/5', title: 'Five' }];
  fx.manifest.pipelines[0].issue_numbers = [5];
  fx.manifest.planning_base_sha = 'a'.repeat(40);
  fx.manifest.git_setup = { base_sha: 'a'.repeat(40), branch: 'feature/v2' };
  fx.manifest.source_requirements_sha256 = '1'.repeat(64);
  assert.equal(
    validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }).status,
    'PASS',
  );
  fx.manifest.source_requirements_sha256 = 'not-a-sha';
  assert.throws(
    () => validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }),
    /source_requirements_sha256/,
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
  await alignFixtureWorkItems(fx)
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
  pipeline.stages = ['implementation', 'git-verify', 'precheck', 'publish', 'tests', 'local-deploy'];
  pipeline.executors = {
    implementation: 'agent',
    precheck: 'local_gate',
    'git-verify': 'git_verify',
    publish: 'git_publish',
    tests: 'github_ci',
    'local-deploy': 'local_gate',
  };
  await alignFixtureWorkItems(fx)
  pipeline.profile = 'default';
  fx.manifest.gate_profiles = {
    default: {
      precheck: ['pnpm test'],
      'local-deploy': ['bash install.sh --version {candidate_sha}'],
    },
  };
  pipeline.deployable = true;
  pipeline.decision_ids.push('decision-testing-strategy');
  pipeline.deployment_validation = { stage: 'tests' };
  pipeline.testing_strategy = {
    mode: 'hybrid',
    owner_decision_id: 'decision-testing-strategy',
    github_validation_stage: 'tests',
    opencode_host_stage: 'local-deploy',
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

test('a versioned run must end with publish, local candidate gate, dev_deploy and owner acceptance', async () => {
  const fx = await fixture('v2-delivery-tail');
  const pipeline = fx.manifest.pipelines[0];
  fx.manifest.release = { version: '0.6.5', milestone: { number: 14, title: 'v.0.6.5' } };
  const check = () => validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath });
  assert.throws(check, /DELIVERY_TAIL_REQUIRED: a versioned run needs exactly one deployable pipeline, found 0/);

  pipeline.stages = ['implementation', 'git-verify', 'publish', 'candidate', 'dev', 'accept'];
  pipeline.executors = { implementation: 'agent', 'git-verify': 'git_verify', publish: 'git_publish', candidate: 'local_gate', dev: 'dev_deploy', accept: 'owner_acceptance' };
  await alignFixtureWorkItems(fx)
  pipeline.profile = 'default';
  fx.manifest.gate_profiles = { default: { candidate: ['pnpm test'] } };
  pipeline.deployable = true;
  pipeline.github_ci_mode = 'off';
  pipeline.decision_ids.push('decision-testing-strategy');
  pipeline.deployment_validation = { stage: 'candidate' };
  pipeline.testing_strategy = { mode: 'hybrid', owner_decision_id: 'decision-testing-strategy', github_validation_stage: 'candidate',
    opencode_host_stage: 'dev', post_deploy_test: 'user', owner_acceptance_stage: 'accept' };
  assert.throws(check, /DEV_DEPLOY_REQUIRES_DEPLOYABLE_TARGET: v2-delivery-tail-app\/dev|DEV_DEPLOY_REQUIRES_DEPLOYABLE_TARGET/);
  fx.manifest.deploy_target = 'svd1';
  assert.equal(check().status, 'PASS');

  // The order is fixed: no dev install before the candidate is published, no acceptance before the install.
  pipeline.stages = ['implementation', 'git-verify', 'dev', 'publish', 'candidate', 'accept'];
  assert.throws(check, /DEV_DEPLOY_REQUIRES_PUBLISHED_CANDIDATE/);
  pipeline.stages = ['implementation', 'git-verify', 'publish', 'candidate', 'dev', 'accept'];
  pipeline.github_ci_mode = 'required';
  assert.throws(check, /DEPLOYMENT_VALIDATION_REQUIRES_FINAL_GITHUB_CI|DELIVERY_TAIL_REQUIRED/);
  pipeline.github_ci_mode = 'off';
  fx.manifest.release.rc_tags = true;
  assert.throws(check, /release must be \{version: "X\.Y\.Z", milestone: \{number, title\}\}/);
  delete fx.manifest.release.rc_tags;

  // The dev contour must already be described by root when the environment is checked.
  const targets = await mkdtemp(path.join(os.tmpdir(), 'deploy-targets-'));
  const previous = process.env.OPENCODE_DEPLOY_TARGETS_DIR;
  process.env.OPENCODE_DEPLOY_TARGETS_DIR = targets;
  try {
    const { checkDeployTargetConfigured } = await import('./manifest-preflight.mjs');
    assert.throws(() => checkDeployTargetConfigured(fx.manifest), /DEPLOY_TARGET_NOT_CONFIGURED: .*svd1\.conf is missing/);
    await writeFile(path.join(targets, 'svd1.conf'), 'REPO_DIR=/srv/sevami\n');
    assert.doesNotThrow(() => checkDeployTargetConfigured(fx.manifest));
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_DEPLOY_TARGETS_DIR; else process.env.OPENCODE_DEPLOY_TARGETS_DIR = previous;
    await rm(targets, { recursive: true, force: true });
  }
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
  const stateRoot = path.join(fx.root, '.tmp', 'pipelines');
  // Review dispatch validates actual Git source inventory; do not replace the
  // source-bound CodeReviewer verdict with an unproven stage completion.
  const git = spawnSync('git', ['init', '-b', 'main'], { cwd: fx.root, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);

  let result = run(fx.root, ['init', fx.manifestPath, '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);
  result = run(fx.root, ['approve', fx.manifest.run_id, '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);

  const complete = (stage) => {
    let current = run(fx.root, ['start', fx.manifest.run_id, stage, '--pipeline', 'app', '--state-root', stateRoot]);
    assert.equal(current.status, 0, current.stderr);
    let reviewEvidence = [];
    if (stage.endsWith('review')) {
      const dispatch = run(fx.root, ['dispatch', fx.manifest.run_id, '--pipeline', 'app', '--stage', stage,
        '--work-item', stage, '--role', 'CodeReviewer']);
      assert.equal(dispatch.status, 0, dispatch.stderr);
      const record = JSON.parse(readFileSync(path.join(stateRoot, fx.manifest.run_id, 'checks', 'review-dispatch', `app--${stage}.json`), 'utf8'));
      const evidence = path.join(stateRoot, fx.manifest.run_id, 'checks', `ready-${stage}.json`);
      writeFileSync(evidence, JSON.stringify({ status: 'ready', run_id: fx.manifest.run_id, pipeline_id: 'app', stage,
        review_dispatch_id: record.review_dispatch_id, review_source_digest: record.source_digest, findings: [] }));
      reviewEvidence = ['--evidence', evidence];
    }
    current = run(fx.root, ['complete', fx.manifest.run_id, stage, '--pipeline', 'app', '--state-root', stateRoot, '--json', ...reviewEvidence]);
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
  await alignFixtureWorkItems(fx)
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

  const candidateHead = await publishedFixtureHead(fx);
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

  const candidateSha = candidateHead;
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
  await alignFixtureWorkItems(fx)
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

  const candidateHead = await publishedFixtureHead(fx);
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

  const candidateSha = candidateHead;
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
  assert.match(result.stderr, /EVIDENCE_INVALID_OR_STALE|CANDIDATE_STALE_SOURCE/);

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
  await alignFixtureWorkItems(fx)
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

  const candidateHead = await publishedFixtureHead(fx);
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

  const candidateSha = candidateHead;
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

  // Owner findings on a copy of the run: the recorded FAIL is the evidence of a fix cycle that reopens
  // the whole chain, so the repair is gated, published as a new SHA and deployed again before acceptance.
  const findingsRoot = path.join(fx.root, '.tmp', 'owner-findings-state');
  await cp(stateRoot, findingsRoot, { recursive: true });
  const findings = (args) => run(fx.root, [...args, '--state-root', findingsRoot]);
  result = findings(['owner-accept', fx.manifest.run_id, 'owner-acceptance', '--pipeline', 'app', '--result', 'fail', '--message', 'кнопка не сохраняет']);
  assert.equal(result.status, 0, result.stderr);
  result = findings(['scope-check', fx.manifest.run_id, 'owner-acceptance', 'src/app.ts', '--pipeline', 'app', '--json']);
  assert.equal(result.status, 0, result.stderr);
  result = findings(['fix-cycle', fx.manifest.run_id, 'owner-acceptance', '--pipeline', 'app', '--json',
    '--evidence', path.join(fx.runRoot, 'owner', 'app-owner-acceptance.json')]);
  assert.equal(result.status, 0, result.stderr);
  const reopened = JSON.parse(result.stdout).pipelines.app.stages;
  for (const name of ['implementation', 'git-verify', 'publish', 'tests', 'dev', 'owner-acceptance']) assert.equal(reopened[name].status, 'pending', name);
  assert.equal(reopened.implementation.repair_origin_stage, 'owner-acceptance');

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

test('technical fix after publish reopens source, verify and publish before GitHub CI', async () => {
  const fx = await fixture('v2-fix-invalidates-published-chain');
  fx.manifest.pipelines[0].stages = ['implementation', 'git-verify', 'publish', 'tests'];
  fx.manifest.pipelines[0].executors = {
    implementation: 'agent',
    'git-verify': 'git_verify',
    publish: 'git_publish',
    tests: 'github_ci',
  };
  await alignFixtureWorkItems(fx)
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

  const candidateHead = await publishedFixtureHead(fx);
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
    candidate_sha: candidateHead,
    remote_sha: candidateHead,
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
  const repairEvidence = path.join(fx.runRoot, 'failed-tests.json');
  await writeFile(repairEvidence, JSON.stringify({ status: 'FAIL', run_id: fx.manifest.run_id, pipeline_id: 'app', gate: 'github_actions', stage: 'tests' }));
  result = invoke(['fix-cycle', fx.manifest.run_id, 'tests', '--pipeline', 'app', '--evidence', repairEvidence, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(result.stdout);
  assert.equal(state.pipelines.app.stages['git-verify'].status, 'pending');
  assert.equal(state.pipelines.app.stages.publish.status, 'pending');
  assert.equal(state.pipelines.app.stages.tests.status, 'pending');
  assert.equal(state.pipelines.app.stages.tests.technical_fix_cycles, 1);

  result = invoke(['next', fx.manifest.run_id, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(state.pipelines.app.stages.implementation.status, 'pending');
  assert.equal(state.pipelines.app.stages.implementation.repair_origin_stage, 'tests');
  assert.equal(state.pipelines.app.stages.implementation.technical_fix_cycles ?? 0, 0);
  assert.deepEqual(JSON.parse(result.stdout).runnable, [{ pipeline_id: 'app', stage: 'implementation' }]);
});

test('implementation continuation cannot spend a repair cycle', async () => {
  const fx = await fixture('free-implementation');
  const stateRoot = path.join(fx.root, '.tmp', 'pipelines');
  for (const args of [['init', fx.manifestPath], ['approve', fx.manifest.run_id], ['start', fx.manifest.run_id, 'implementation', '--pipeline', 'app']]) {
    const result = run(fx.root, [...args, '--state-root', stateRoot]);
    assert.equal(result.status, 0, result.stderr);
  }
  for (let continuation = 0; continuation < 3; continuation++) {
    const packet = run(fx.root, ['dispatch', fx.manifest.run_id, '--pipeline', 'app', '--stage', 'implementation', '--work-item', 'wi-1', '--role', 'CoderAgent']);
    assert.equal(packet.status, 0, packet.stderr);
    assert.equal(JSON.parse(packet.stdout).loop, 0);
  }
  const result = run(fx.root, ['fix-cycle', fx.manifest.run_id, 'implementation', '--pipeline', 'app', '--state-root', stateRoot]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /IMPLEMENTATION_CONTINUATION/);
  const state = JSON.parse(await readFile(path.join(stateRoot, fx.manifest.run_id, 'state.json'), 'utf8'));
  assert.equal(state.pipelines.app.stages.implementation.technical_fix_cycles ?? 0, 0);
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


test('PLAN rejects orphaned work items, missing dependencies, cycles and reversed order before init', async () => {
  const fx = await fixture('complete-work-item-catalog');
  const itemFile = path.join(fx.runRoot, 'work-items/wi-2.json');
  const content = JSON.stringify({id:'wi-2',pipeline_id:'app',stage:'implementation',suggested_agent:'CoderAgent',depends_on:['wi-1']});
  await writeFile(itemFile, content);
  fx.manifest.work_items.push({id:'wi-2',pipeline_id:'app',path:'work-items/wi-2.json',sha256:sha(content)});
  assert.throws(() => validateGateManifest(fx.manifest, {cwd:fx.root,manifestPath:fx.manifestPath}), /UNBOUND_WORK_ITEM/);
  fx.manifest.pipelines[0].work_items.push('wi-2');
  assert.doesNotThrow(() => validateGateManifest(fx.manifest, {cwd:fx.root,manifestPath:fx.manifestPath}));
  fx.manifest.pipelines[0].work_items.reverse();
  assert.throws(() => validateGateManifest(fx.manifest, {cwd:fx.root,manifestPath:fx.manifestPath}), /DEPENDENCY_ORDER/);
  fx.manifest.pipelines[0].work_items.reverse();
  for (const dependency of ['missing','wi-2']) {
    const data = JSON.stringify({id:'wi-2',pipeline_id:'app',stage:'implementation',suggested_agent:'CoderAgent',depends_on:[dependency]});
    await writeFile(itemFile, data); fx.manifest.work_items.find(item => item.id === 'wi-2').sha256=sha(data);
    assert.throws(() => validateGateManifest(fx.manifest, {cwd:fx.root,manifestPath:fx.manifestPath}), dependency==='missing' ? /UNKNOWN_WORK_ITEM_DEPENDENCY/ : /DEPENDENCY_CYCLE/);
  }
});

test('PLAN allows independent source lanes beside prep and enforces only named prerequisites', async () => {
  const fx = await fixture('v2-targeted-prep');
  const file = 'tests/obsolete.test.ts';
  fx.manifest.allowed_change_paths.push(file);
  const prepItem = await fx.frozen('work-items/wi-prep.json', JSON.stringify({
    id: 'wi-prep', pipeline_id: 'prep', stage: 'implementation', suggested_agent: 'TestEngineer', allowed_change_paths: [file],
  }));
  fx.manifest.work_items.push({ id: 'wi-prep', pipeline_id: 'prep', ...prepItem });
  fx.manifest.pipelines.push({
    id: 'prep', deployable: false, test_preparation: true,
    stages: ['implementation', 'review'], executors: { implementation: 'agent', review: 'review' },
    ready_after_stage: 'review', work_items: ['wi-prep'],
    decision_ids: [], research_ids: [], contract_ids: [],
  });
  fx.manifest.test_rework = [{ id: 'obsolete-inventory', action: 'update', path: file,
    reason: 'existing inventory expectation', work_item_id: 'wi-prep', required_by: [] }];
  const validate = () => validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath });
  assert.doesNotThrow(validate, 'independent app lane must not await unrelated prep');
  fx.manifest.test_rework[0].required_by = ['app'];
  assert.throws(validate, /TEST_REWORK_DEPENDENCY_MISSING/);
  fx.manifest.pipelines[0].depends_on = ['prep'];
  assert.doesNotThrow(validate);
  fx.manifest.pipelines[0].depends_on = [];
  delete fx.manifest.test_rework[0].required_by;
  assert.throws(validate, /TEST_REWORK_LANE_NOT_FIRST/, 'frozen legacy entries keep blanket contract');
  fx.manifest.test_rework[0].required_by = ['missing'];
  assert.throws(validate, /TEST_REWORK_CONSUMERS_INVALID/);
});

test('schema v2 rejects parallel pipelines whose work items may change the same paths', async () => {
  const fx = await fixture('v2-parallel-scope');
  const first = await fx.frozen('work-items/wi-1.json', JSON.stringify({ id: 'wi-1', pipeline_id: 'app', stage: 'implementation', suggested_agent: 'CoderAgent', allowed_change_paths: ['src/api/**', 'vitest.config.ts'] }));
  fx.manifest.work_items[0] = { id: 'wi-1', pipeline_id: 'app', ...first };
  const second = await fx.frozen('work-items/wi-2.json', JSON.stringify({ id: 'wi-2', pipeline_id: 'b', stage: 'implementation', suggested_agent: 'CoderAgent', allowed_change_paths: ['src/web/**', 'vitest.config.ts'] }));
  fx.manifest.work_items.push({ id: 'wi-2', pipeline_id: 'b', ...second });
  fx.manifest.pipelines.push({
    id: 'b', deployable: false, stages: ['implementation'], executors: { implementation: 'agent' },
    work_items: ['wi-2'], decision_ids: [], research_ids: [], contract_ids: [],
  });
  assert.throws(
    () => validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }),
    /PARALLEL_SCOPE_OVERLAP: app and b .*vitest\.config\.ts/,
  );
  const disjoint = await fx.frozen('work-items/wi-2.json', JSON.stringify({ id: 'wi-2', pipeline_id: 'b', stage: 'implementation', suggested_agent: 'CoderAgent', allowed_change_paths: ['src/web/**'] }));
  fx.manifest.work_items[fx.manifest.work_items.findIndex(item => item.id === 'wi-2')] = { id: 'wi-2', pipeline_id: 'b', ...disjoint };
  assert.doesNotThrow(() => validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }));
});

test('PLAN rejects two work items of one pipeline that may change the same path unless depends_on orders them', async () => {
  const fx = await fixture('v2-item-scope');
  const first = await fx.frozen('work-items/wi-1.json', JSON.stringify({ id: 'wi-1', pipeline_id: 'app', stage: 'implementation', suggested_agent: 'CoderAgent', allowed_change_paths: ['scripts/testing/**', 'src/a.ts'] }));
  fx.manifest.work_items[0] = { id: 'wi-1', pipeline_id: 'app', ...first };
  const second = await fx.frozen('work-items/wi-2.json', JSON.stringify({ id: 'wi-2', pipeline_id: 'app', stage: 'implementation', suggested_agent: 'CoderAgent', allowed_change_paths: ['scripts/testing/inventory.ts', 'src/b.ts'] }));
  fx.manifest.work_items.push({ id: 'wi-2', pipeline_id: 'app', ...second });
  fx.manifest.pipelines[0].work_items.push('wi-2');
  assert.throws(
    () => validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }),
    /WORK_ITEM_SCOPE_OVERLAP: wi-1 and wi-2 of app may both change scripts\/testing\/\*\*/,
  );
  const ordered = await fx.frozen('work-items/wi-2.json', JSON.stringify({ id: 'wi-2', pipeline_id: 'app', stage: 'implementation', suggested_agent: 'CoderAgent', depends_on: ['wi-1'], allowed_change_paths: ['scripts/testing/inventory.ts', 'src/b.ts'] }));
  fx.manifest.work_items[fx.manifest.work_items.findIndex(item => item.id === 'wi-2')] = { id: 'wi-2', pipeline_id: 'app', ...ordered };
  assert.doesNotThrow(() => validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }));
  const disjoint = await fx.frozen('work-items/wi-2.json', JSON.stringify({ id: 'wi-2', pipeline_id: 'app', stage: 'implementation', suggested_agent: 'CoderAgent', allowed_change_paths: ['src/b.ts'] }));
  fx.manifest.work_items[fx.manifest.work_items.findIndex(item => item.id === 'wi-2')] = { id: 'wi-2', pipeline_id: 'app', ...disjoint };
  assert.doesNotThrow(() => validateGateManifest(fx.manifest, { cwd: fx.root, manifestPath: fx.manifestPath }));
});

async function planProbeFixture(runId) {
  const fx = await fixture(runId);
  const fixtureBin = path.join(fx.root, '.fixture-bin');
  await mkdir(fixtureBin, { recursive: true });
  await writeFile(path.join(fixtureBin, 'pnpm'), '#!/bin/sh\nprintf "11.17.0\\n"\n', { mode: 0o755 });
  fx.manifest.pipelines[0].stages.push('fast-tests');
  fx.manifest.pipelines[0].executors['fast-tests'] = 'local_gate';
  fx.manifest.pipelines[0].profile = 'default';
  fx.manifest.gate_profiles = { default: { 'fast-tests': ['pnpm exec vitest run'] } };
  await writeFile(fx.manifestPath, JSON.stringify(fx.manifest, null, 2));
  fx.writeProbe = async (overrides = {}, pipeline = 'app') => {
    const dir = path.join(fx.runRoot, 'planning', 'probes');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${pipeline}-fast-tests.json`), JSON.stringify({
      kind: 'plan_probe', status: 'PASS', run_id: runId, pipeline_id: pipeline, gate: 'fast-tests', profile: 'default',
      head_sha: 'a'.repeat(40), base_sha: 'a'.repeat(40), commands_sha256: planProbeCommandsSha256(fx.manifest.gate_profiles.default['fast-tests']),
      ...overrides,
    }));
  };
  return fx;
}

test('PLAN probe is required for supported local gates and bound to run, gate, profile and frozen commands', async () => {
  const fx = await planProbeFixture('v2-plan-probe');
  const check = () => validatePlanProbes(fx.manifest, { manifestPath: fx.manifestPath, cwd: fx.root });
  assert.throws(check, /PLAN_PROBE_REQUIRED: app\/fast-tests.*gate-runner-cli\.ts --plan-probe .*manifest\.json app fast-tests/);
  await fx.writeProbe();
  assert.doesNotThrow(check);
  assert.equal(planProbeCommandsSha256(['a']), sha(JSON.stringify(['a'])));
  for (const override of [{ commands_sha256: 'b'.repeat(64) }, { run_id: 'other' }, { gate: 'tests' }, { profile: 'other' }, { kind: 'base_probe' }, { status: 'BLOCKED' }, { status: 'FAIL' }]) {
    await fx.writeProbe(override);
    assert.throws(check, /PLAN_PROBE_REQUIRED/, JSON.stringify(override));
  }
});

test('a FAIL plan probe passes only with a baseline_repair work item on the profile', async () => {
  const fx = await planProbeFixture('v2-plan-probe-red');
  await fx.writeProbe({ status: 'FAIL' });
  const check = () => validatePlanProbes(fx.manifest, { manifestPath: fx.manifestPath, cwd: fx.root });
  assert.throws(check, /PLAN_PROBE_REQUIRED/);
  const repaired = await fx.frozen('work-items/wi-1.json', JSON.stringify({ id: 'wi-1', pipeline_id: 'app', stage: 'implementation', suggested_agent: 'CoderAgent', baseline_repair: true }));
  fx.manifest.work_items[0] = { id: 'wi-1', pipeline_id: 'app', ...repaired };
  assert.doesNotThrow(check);
});

test('pipelines sharing profile and gate share one plan probe; runtime and candidate gates need none', async () => {
  const fx = await planProbeFixture('v2-plan-probe-shared');
  const second = await fx.frozen('work-items/wi-2.json', JSON.stringify({ id: 'wi-2', pipeline_id: 'b', stage: 'implementation', suggested_agent: 'CoderAgent', allowed_change_paths: ['src/b/**'] }));
  fx.manifest.work_items.push({ id: 'wi-2', pipeline_id: 'b', ...second });
  fx.manifest.pipelines.push({ id: 'b', deployable: false, profile: 'default', stages: ['implementation', 'fast-tests'],
    executors: { implementation: 'agent', 'fast-tests': 'local_gate' }, work_items: ['wi-2'], decision_ids: [], research_ids: [], contract_ids: [] });
  await fx.writeProbe({}, 'b');
  assert.doesNotThrow(() => validatePlanProbes(fx.manifest, { manifestPath: fx.manifestPath, cwd: fx.root }));
  fx.manifest.pipelines[0].stages.push('runtime-smoke', 'install-check');
  fx.manifest.pipelines[0].executors['runtime-smoke'] = 'local_gate';
  fx.manifest.pipelines[0].executors['install-check'] = 'local_gate';
  fx.manifest.gate_profiles.default['runtime-smoke'] = ['pnpm exec vitest run smoke'];
  fx.manifest.gate_profiles.default['install-check'] = ['pnpm exec echo {candidate_sha}'];
  assert.doesNotThrow(() => validatePlanProbes(fx.manifest, { manifestPath: fx.manifestPath, cwd: fx.root }));
});

test('plan-run-preflight and run-preflight enforce the plan probe', async () => {
  const fx = await planProbeFixture('v2-plan-probe-cli');
  let result = run(fx.root, ['plan-run-preflight', fx.manifestPath]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PLAN_PROBE_REQUIRED: app\/fast-tests/);
  await fx.writeProbe();
  result = run(fx.root, ['plan-run-preflight', fx.manifestPath]);
  assert.equal(result.status, 0, result.stderr);
  const stateRoot = path.join(fx.root, '.tmp', 'pipelines');
  result = run(fx.root, ['init', fx.manifestPath, '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);
  result = run(fx.root, ['run-preflight', 'v2-plan-probe-cli', '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);
  await fx.writeProbe({ commands_sha256: 'c'.repeat(64) });
  result = run(fx.root, ['run-preflight', 'v2-plan-probe-cli', '--state-root', stateRoot]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PLAN_PROBE_REQUIRED/);
  // A resumed RUN whose source agent stage already started cannot reproduce the untouched base,
  // so its run-preflight no longer asks for a plan probe.
  assert.equal(run(fx.root, ['approve', 'v2-plan-probe-cli', '--state-root', stateRoot]).status, 0);
  result = run(fx.root, ['start', 'v2-plan-probe-cli', 'implementation', '--pipeline', 'app', '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);
  result = run(fx.root, ['run-preflight', 'v2-plan-probe-cli', '--state-root', stateRoot]);
  assert.equal(result.status, 0, result.stderr);
});

test('plan-check runs preflight, adopt and verify in order and stops at the first failure', async () => {
  const fx = await planProbeFixture('v2-plan-check');
  let result = run(fx.root, ['plan-check', fx.manifestPath]);
  assert.notEqual(result.status, 0);
  let out = JSON.parse(result.stdout);
  assert.equal(out.failed_step, 'plan-run-preflight');
  assert.deepEqual(out.steps, []);
  assert.match(out.error, /PLAN_PROBE_REQUIRED: app\/fast-tests/);
  await fx.writeProbe();
  result = run(fx.root, ['plan-check', fx.manifestPath]);
  assert.notEqual(result.status, 0);
  out = JSON.parse(result.stdout);
  assert.deepEqual(out.steps, [{ step: 'plan-run-preflight', status: 'PASS' }]);
  assert.equal(out.failed_step, 'adopt');
  assert.equal(run(fx.root, ['plan-check', fx.manifestPath, '--bogus']).status, 1);
});
