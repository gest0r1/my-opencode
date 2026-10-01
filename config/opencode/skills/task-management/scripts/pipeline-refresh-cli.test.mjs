import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'pipeline-refresh-cli.ts');

function runCommand(exe, args, cwd) {
  const result = spawnSync(exe, args, { cwd, encoding: 'utf8', env: process.env });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return String(result.stdout ?? '').trim();
}

function git(cwd, ...args) {
  return runCommand('git', args, cwd);
}

async function fixture(runId = 'refresh-run') {
  const main = await mkdtemp(path.join(os.tmpdir(), 'pipeline-refresh-main-'));
  const b = `${main}-b`;
  git(main, 'init', '-b', 'main');
  git(main, 'config', 'user.name', 'Refresh Test');
  git(main, 'config', 'user.email', 'refresh@example.invalid');
  await mkdir(path.join(main, 'src'), { recursive: true });
  await mkdir(path.join(main, 'docs'), { recursive: true });
  await writeFile(path.join(main, '.gitignore'), '.tmp/\n');
  await writeFile(path.join(main, 'src', 'input.ts'), 'export const value = 1;\n');
  await writeFile(path.join(main, 'docs', 'pipeline-rules.md'), '# rules\n');
  git(main, 'add', '.');
  git(main, 'commit', '-m', 'base');
  const base = git(main, 'rev-parse', 'HEAD');
  git(main, 'worktree', 'add', '-b', 'feature/refresh', b);

  const runRoot = path.join(b, '.tmp', 'pipelines', runId);
  await mkdir(path.join(runRoot, 'planning'), { recursive: true });
  await writeFile(path.join(runRoot, 'planning', 'architecture.md'), '# architecture\n');
  const manifest = {
    schema_version: 2,
    run_id: runId,
    planning_mode: 'design-freeze',
    git_setup: { base_sha: base, branch: 'feature/refresh' },
    planning_base_sha: base,
    allowed_change_paths: ['src/**'],
    freshness_sensitive_paths: ['src/**'],
    planning_inputs: {
      architecture: ['src/**'],
      work_items: ['src/**'],
    },
    planning_readiness: {
      design_freeze: true,
      required_gates: ['architecture'],
      gates: {
        architecture: {
          required: true,
          status: 'ready',
          artifact: { path: 'planning/architecture.md', sha256: '0'.repeat(64) },
          blocking_decision_ids: [],
        },
      },
    },
    pipelines: [{ id: 'app', stages: ['implementation'], executors: { implementation: 'agent' } }],
  };
  await writeFile(path.join(runRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(path.join(runRoot, 'state.json'), JSON.stringify({
    run_id: runId,
    status: 'approved',
    active_stages: [],
  }, null, 2));

  return { main, b, base, runId, runRoot };
}

function invoke(cwd, args) {
  const result = spawnSync('npx', ['--yes', 'tsx', CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: process.env,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

async function advanceMain(fx, relative, content) {
  const file = path.join(fx.main, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  git(fx.main, 'add', relative);
  git(fx.main, 'commit', '-m', `change ${relative}`);
  const newBase = git(fx.main, 'rev-parse', 'HEAD');
  git(fx.b, 'merge', '--no-edit', 'main');
  return newBase;
}

test('preflight blocks an active RUN before any refresh mutation', async () => {
  const fx = await fixture('active-run');
  await writeFile(path.join(fx.runRoot, 'state.json'), JSON.stringify({
    run_id: fx.runId,
    status: 'in_progress',
    active_stages: ['app/implementation'],
  }, null, 2));

  const result = spawnSync('npx', ['--yes', 'tsx', CLI, 'preflight', fx.runId], {
    cwd: fx.b,
    encoding: 'utf8',
    env: process.env,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RUN_ACTIVE/);
  assert.equal(git(fx.b, 'rev-parse', 'HEAD'), fx.base);
});

test('NO_IMPACT adopts new run base without creating a new run', async () => {
  const fx = await fixture('no-impact');
  const newBase = await advanceMain(fx, 'docs/other.md', '# unrelated\n');

  const output = invoke(fx.b, ['apply', fx.runId]);
  assert.equal(output.classification, 'NO_IMPACT');
  assert.equal(output.action, 'reuse_approved_run');
  assert.equal(output.approval_reused, true);
  assert.equal(output.new_base_sha, newBase);

  const runtime = JSON.parse(await readFile(path.join(fx.runRoot, 'git-runtime.json'), 'utf8'));
  assert.equal(runtime.run_base_sha, newBase);
  const state = JSON.parse(await readFile(path.join(fx.runRoot, 'state.json'), 'utf8'));
  assert.equal(state.run_base_sha, newBase);
});

test('BOUNDED_IMPACT is copied by CLI and invalidates only affected gate', async () => {
  const fx = await fixture('bounded');
  const newBase = await advanceMain(fx, 'src/input.ts', 'export const value = 2;\n');

  const output = invoke(fx.b, ['apply', fx.runId]);
  assert.equal(output.classification, 'BOUNDED_IMPACT');
  assert.equal(output.action, 'revalidate_affected_gates');
  assert.equal(output.copied_by_cli, true);
  assert.deepEqual(output.affected_gates, ['architecture']);
  assert.equal(output.rebuild_work_items, true);

  const newRoot = path.join(fx.b, '.tmp', 'pipelines', output.new_run_id);
  const cloned = JSON.parse(await readFile(path.join(newRoot, 'manifest.json'), 'utf8'));
  assert.equal(cloned.git_setup.base_sha, newBase);
  assert.equal(cloned.planning_base_sha, newBase);
  assert.equal(cloned.lineage.supersedes, fx.runId);
  assert.equal(cloned.lineage.reason_code, 'MAIN_DRIFT_REPLAN');
  assert.equal(cloned.planning_readiness.gates.architecture.status, 'needs_revision');
  assert.equal(await readFile(path.join(newRoot, 'planning', 'architecture.md'), 'utf8'), '# architecture\n');

  await assert.rejects(readFile(path.join(newRoot, 'state.json'), 'utf8'));
  await assert.rejects(readFile(path.join(newRoot, 'candidate.json'), 'utf8'));

  const oldState = JSON.parse(await readFile(path.join(fx.runRoot, 'state.json'), 'utf8'));
  assert.equal(oldState.superseded_by, output.new_run_id);
});

test('STRUCTURAL_IMPACT does not copy a replacement run', async () => {
  const fx = await fixture('structural');
  await advanceMain(fx, 'docs/pipeline-rules.md', '# changed rules\n');

  const output = invoke(fx.b, ['apply', fx.runId]);
  assert.equal(output.classification, 'STRUCTURAL_IMPACT');
  assert.equal(output.action, 'full_replan');
  assert.match(output.reasons.join(','), /structural_path:docs\/pipeline-rules\.md/);
});
