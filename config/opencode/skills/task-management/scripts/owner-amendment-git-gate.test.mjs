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

  exec(root, 'git', ['init', '--bare', remote]);
  await mkdir(main);
  exec(main, 'git', ['init']);
  exec(main, 'git', ['config', 'user.name', 'Pipeline Test']);
  exec(main, 'git', ['config', 'user.email', 'pipeline@example.invalid']);
  await mkdir(path.join(main, 'src'));
  await writeFile(path.join(main, '.gitignore'), '.tmp/\n');
  await writeFile(path.join(main, 'src/base.txt'), 'base\n');
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
    test_strategy: await frozen(artifactRoot, 'test-strategy.md', '# tests\n'),
    accepted_risks: await frozen(artifactRoot, 'accepted-risks.md', '# risks\n'),
    work_items: await frozen(artifactRoot, 'work-items/index.json', '{"schema":2}\n'),
  };
  const workItemContent = JSON.stringify({ id: 'WI-OWNER-1', pipeline_id: 'onboarding' });
  const workItemArtifact = await frozen(artifactRoot, 'work-items/WI-OWNER-1.json', workItemContent);

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
    pipelines: [
      {
        id: 'onboarding',
        deployable: false,
        stages: ['implementation', 'owner-accept'],
        executors: {
          implementation: 'agent',
          'owner-accept': 'owner_acceptance',
        },
        work_items: ['WI-OWNER-1'],
        decision_ids: [],
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
  return { root, worktree, runId, stateRoot, artifactRoot, manifestPath };
}

test('owner-amend-apply runtime scope is accepted by git verify and remains exact', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));

  let result = stage(f.worktree, ['init', f.manifestPath, '--state-root', f.stateRoot]);
  assert.equal(result.status, 0, result.stderr);
  result = stage(f.worktree, ['approve', f.runId, '--state-root', f.stateRoot]);
  assert.equal(result.status, 0, result.stderr);

  result = stage(f.worktree, [
    'start', f.runId, 'implementation', '--pipeline', 'onboarding', '--state-root', f.stateRoot,
  ]);
  assert.equal(result.status, 0, result.stderr);
  result = stage(f.worktree, [
    'complete', f.runId, 'implementation', '--pipeline', 'onboarding', '--state-root', f.stateRoot,
  ]);
  assert.equal(result.status, 0, result.stderr);

  result = stage(f.worktree, [
    'start', f.runId, 'owner-accept', '--pipeline', 'onboarding', '--state-root', f.stateRoot,
  ]);
  assert.equal(result.status, 0, result.stderr);
  result = stage(f.worktree, [
    'owner-accept', f.runId, 'owner-accept', '--pipeline', 'onboarding', '--result', 'fail',
    '--message', 'Owner requests a bounded UI correction', '--state-root', f.stateRoot,
  ]);
  assert.equal(result.status, 0, result.stderr);

  const amendmentPath = path.join(f.artifactRoot, 'owner', 'owner-amendment.json');
  await mkdir(path.dirname(amendmentPath), { recursive: true });
  await writeFile(amendmentPath, `${JSON.stringify({
    kind: 'owner_amendment',
    status: 'ready',
    bounded: true,
    pipeline_id: 'onboarding',
    source_stage: 'owner-accept',
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
    'owner-amend-apply', f.runId, 'owner-accept', '--pipeline', 'onboarding',
    '--evidence', amendmentPath, '--state-root', f.stateRoot,
  ]);
  assert.equal(result.status, 0, result.stderr);

  const state = JSON.parse(await readFile(path.join(f.artifactRoot, 'state.json'), 'utf8'));
  assert.equal(state.runtime_scope_extensions.length, 1);
  assert.equal(state.runtime_scope_extensions[0].scope_class, 'owner_amendment');
  assert.deepEqual(state.runtime_scope_extensions[0].paths, ['src/amended.txt']);

  await writeFile(path.join(f.worktree, 'src/amended.txt'), 'owner-approved amendment\n');
  result = gitGate(f.worktree, ['verify', f.manifestPath]);
  assert.equal(result.status, 0, result.stderr);
  const verify = JSON.parse(result.stdout);
  assert.deepEqual(verify.changed_files, ['src/amended.txt']);

  await writeFile(path.join(f.worktree, 'src/outside.txt'), 'not owner approved\n');
  result = gitGate(f.worktree, ['verify', f.manifestPath]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside effective scope/);
});
