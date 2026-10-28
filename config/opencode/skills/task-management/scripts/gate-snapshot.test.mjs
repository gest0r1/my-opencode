import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'gate-runner-cli.ts');
const sha256 = value => createHash('sha256').update(value).digest('hex');

// A git checkout with a two-command gate whose fake pnpm reads src/ in its working directory. The
// script it runs is passed in by each test; it gets the original checkout as ORIGINAL_ROOT.
async function snapshotFixture(script) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gate-snapshot-'));
  const stateRoot = path.join(root, '.tmp', 'pipelines');
  const runId = 'snap-run';
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'bin'));
  await writeFile(path.join(root, '.gitignore'), '.tmp/\n.env*\n.snapshots/\n.locks/\n');
  await writeFile(path.join(root, 'src/value.txt'), 'base\n');
  await writeFile(path.join(root, 'src/other.txt'), 'base\n');
  await writeFile(path.join(root, 'bin/pnpm'), `#!/usr/bin/env node\n${script}\n`, { mode: 0o755 });
  assert.equal(git('init').status, 0);
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  git('add', '.'); assert.equal(git('commit', '-m', 'base').status, 0);
  const manifest = {
    schema_version: 1, run_id: runId,
    git_setup: { base_sha: git('rev-parse', 'HEAD').stdout.trim() },
    pipelines: [{ id: 'app', stages: ['build'], profile: 'default' }],
    gate_profiles: { default: { build: [
      'pnpm exec vitest run --config vitest.unit.ts --passWithNoTests=false',
      'pnpm exec vitest run --config vitest.web.ts --passWithNoTests=false',
    ] } },
    gate_testing: { default: { build: { impact_groups: [
      { inputs: ['src/value.txt'], command_index: 0 },
      { inputs: ['src/other.txt'], command_index: 1 },
    ] } } },
  };
  await mkdir(path.join(stateRoot, runId), { recursive: true });
  const content = JSON.stringify(manifest);
  const manifestFile = path.join(stateRoot, runId, 'manifest.json');
  await writeFile(manifestFile, content);
  await writeFile(path.join(stateRoot, runId, 'state.json'), JSON.stringify({ run_id: runId, status: 'in_progress', manifest_file: manifestFile, manifest_sha256: sha256(content) }));
  const snapshots = path.join(root, '.snapshots');
  const runGate = () => spawnSync('npx', ['--yes', 'tsx', RUNNER, runId, 'app', 'build', '--state-root', stateRoot, '--no-reuse'], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, PIPELINE_GATE_SNAPSHOT: '1', PIPELINE_SNAPSHOT_DIR: snapshots, ORIGINAL_ROOT: root, PIPELINE_HEAVY_LOCK_DIR: path.join(root, '.locks') },
  });
  return { root, stateRoot, runId, git, runGate, evidence: async () => JSON.parse(await readFile(path.join(stateRoot, runId, 'gates/app-build.json'), 'utf8')) };
}

test('a full gate runs on a snapshot of the working tree and leaves the checkout untouched', async () => {
  const fx = await snapshotFixture(`
const fs = require('node:fs'); const path = require('node:path');
fs.appendFileSync(path.join(process.env.PIPELINE_SCRATCH_DIR, 'seen.jsonl'), JSON.stringify({ cwd: process.cwd(),
  value: fs.readFileSync('src/value.txt', 'utf8'), added: fs.existsSync('src/added.txt'), env: fs.existsSync('.env.local'),
  state: fs.existsSync('.tmp/pipelines/snap-run/state.json') }) + '\\n');`);
  try {
    await writeFile(path.join(fx.root, 'src/value.txt'), 'uncommitted\n');
    await writeFile(path.join(fx.root, 'src/added.txt'), 'new\n');
    await writeFile(path.join(fx.root, '.env.local'), 'LOCAL=1\n');
    const statusBefore = fx.git('status', '--porcelain').stdout;
    const result = fx.runGate();
    assert.equal(result.status, 0, result.stderr);
    const evidence = await fx.evidence();
    assert.equal(evidence.status, 'PASS');
    assert.equal(evidence.snapshot.status, 'used');
    assert.match(evidence.snapshot.commit, /^[0-9a-f]{40}$/);
    const seen = (await readFile(path.join(evidence.scratch_dir, 'seen.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(seen.length, 2);
    for (const entry of seen) {
      assert.notEqual(entry.cwd, fx.root);
      assert.deepEqual({ ...entry, cwd: undefined }, { cwd: undefined, value: 'uncommitted\n', added: true, env: true, state: true });
    }
    await assert.rejects(access(seen[0].cwd));
    assert.equal(fx.git('status', '--porcelain').stdout, statusBefore);
    assert.equal(fx.git('worktree', 'list').stdout.trim().split('\n').length, 1);
    assert.equal(fx.git('rev-parse', 'HEAD').stdout.trim(), JSON.parse(await readFile(path.join(fx.stateRoot, fx.runId, 'manifest.json'), 'utf8')).git_setup.base_sha);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test('a snapshot failure reached by changes made meanwhile reruns on a fresh snapshot instead of standing', async () => {
  // The first command fails on "bad" and, as another worker would, fixes the original checkout meanwhile.
  const fx = await snapshotFixture(`
const fs = require('node:fs'); const path = require('node:path');
const unit = process.argv.includes('vitest.unit.ts');
if (unit && fs.readFileSync('src/value.txt', 'utf8').startsWith('bad')) {
  fs.writeFileSync(path.join(process.env.ORIGINAL_ROOT, 'src/value.txt'), 'good\\n');
  console.error('FAIL value is bad'); process.exit(1);
}`);
  try {
    await writeFile(path.join(fx.root, 'src/value.txt'), 'bad\n');
    const result = fx.runGate();
    assert.equal(result.status, 0, result.stderr);
    const evidence = await fx.evidence();
    assert.equal(evidence.status, 'PASS');
    assert.deepEqual(evidence.snapshot.rerun.first_attempt.failed_commands, [0]);
    assert.deepEqual(evidence.snapshot.rerun.first_attempt.changed_paths, ['src/value.txt']);
    assert.deepEqual(evidence.snapshot.rerun.commands, [0, 1]);
    assert.notEqual(evidence.snapshot.rerun.first_attempt.commit, evidence.snapshot.commit);
    assert.deepEqual(evidence.results.map(item => [item.command_index, item.exit_code]), [[0, 0], [1, 0]]);
    assert.equal(fx.git('worktree', 'list').stdout.trim().split('\n').length, 1);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test('a snapshot failure stands when nothing changed meanwhile reaches the failed command', async () => {
  const fx = await snapshotFixture(`
const fs = require('node:fs'); const path = require('node:path');
if (process.argv.includes('vitest.unit.ts')) {
  fs.writeFileSync(path.join(process.env.ORIGINAL_ROOT, 'src/other.txt'), 'changed elsewhere\\n');
  console.error('FAIL value invariant'); process.exit(1);
}`);
  try {
    const result = fx.runGate();
    assert.equal(result.status, 1);
    const evidence = await fx.evidence();
    assert.equal(evidence.status, 'FAIL');
    assert.equal(evidence.snapshot.failure_check, 'changes since the snapshot do not reach the failed commands');
    assert.deepEqual(evidence.snapshot.changed_since, ['src/other.txt']);
    assert.equal(evidence.snapshot.rerun, undefined);
    assert.equal(fx.git('worktree', 'list').stdout.trim().split('\n').length, 1);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});
