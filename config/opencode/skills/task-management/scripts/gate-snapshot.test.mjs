import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'gate-runner-cli.ts');
const sha256 = value => createHash('sha256').update(value).digest('hex');

// A git checkout with a two-command gate whose fake pnpm reads src/ in its working directory. The
// script it runs is passed in by each test; it gets the original checkout as ORIGINAL_ROOT.
async function snapshotFixture(script, gate = 'build') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gate-snapshot-'));
  const stateRoot = path.join(root, '.tmp', 'pipelines');
  const runId = 'snap-run';
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'bin'));
  await writeFile(path.join(root, '.gitignore'), '.tmp/\n.env*\n.local-config/\n.snapshots/\n.locks/\nnode_modules/\n');
  await writeFile(path.join(root, 'src/value.txt'), 'base\n');
  await writeFile(path.join(root, 'src/other.txt'), 'base\n');
  // Reuse identity requires a real bounded project manager route, not merely a
  // fake PATH binary: exact packageManager, manager package and local vitest.
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'snapshot-fixture', packageManager: 'pnpm@1.0.0' }));
  await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n');
  await mkdir(path.join(root, 'node_modules/pnpm/bin'), { recursive: true });
  await mkdir(path.join(root, 'node_modules/vitest/bin'), { recursive: true });
  await mkdir(path.join(root, 'node_modules/.bin'), { recursive: true });
  await writeFile(path.join(root, 'node_modules/pnpm/package.json'), JSON.stringify({ name: 'pnpm', version: '1.0.0' }));
  await writeFile(path.join(root, 'node_modules/vitest/package.json'), JSON.stringify({ name: 'vitest', version: '1.0.0' }));
  await writeFile(path.join(root, 'node_modules/vitest/bin/vitest.mjs'), '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });
  await writeFile(path.join(root, 'node_modules/pnpm/bin/pnpm.cjs'), `#!/usr/bin/env node\nif (process.argv[2] === '--version') { console.log('1.0.0'); process.exit(0); }\n${script}\n`, { mode: 0o755 });
  await symlink('../node_modules/pnpm/bin/pnpm.cjs', path.join(root, 'bin/pnpm'));
  await symlink('../vitest/bin/vitest.mjs', path.join(root, 'node_modules/.bin/vitest'));
  assert.equal(git('init').status, 0);
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  git('add', '.'); assert.equal(git('commit', '-m', 'base').status, 0);
  const manifest = {
    schema_version: 1, run_id: runId,
    git_setup: { base_sha: git('rev-parse', 'HEAD').stdout.trim() },
    pipelines: [{ id: 'app', stages: [gate], profile: 'default', executors: { [gate]: 'local_gate' } }],
    gate_profiles: { default: { [gate]: [
      'pnpm exec vitest run --config vitest.unit.ts --passWithNoTests=false',
      'pnpm exec vitest run --config vitest.web.ts --passWithNoTests=false',
    ] } },
    gate_testing: { default: { [gate]: { ...(gate === 'release-check' ? { input_kind: 'tree' } : {}), impact_groups: [
      { inputs: ['src/value.txt'], command_index: 0 },
      { inputs: ['src/other.txt'], command_index: 1 },
    ] } } },
  };
  await mkdir(path.join(stateRoot, runId), { recursive: true });
  const content = JSON.stringify(manifest);
  const manifestFile = path.join(stateRoot, runId, 'manifest.json');
  await writeFile(manifestFile, content);
  await writeFile(path.join(stateRoot, runId, 'state.json'), JSON.stringify({ run_id: runId, status: 'in_progress', manifest_file: manifestFile, manifest_sha256: sha256(content) }));
  const snapshots = path.join(root, '.tmp', 'snapshots');
  const runGate = ({ reuse = false } = {}) => {
    const env = { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, PIPELINE_GATE_SNAPSHOT: '1',
      PIPELINE_SNAPSHOT_DIR: snapshots, ORIGINAL_ROOT: root, PIPELINE_HEAVY_LOCK_DIR: path.join(root, '.tmp', 'locks') };
    // NODE_PATH was supplied by the review runner loader, not by this
    // project's actual gate environment. Do not leak its untracked tool path.
    delete env.NODE_PATH;
    return spawnSync(process.execPath, [RUNNER, runId, 'app', gate, '--state-root', stateRoot, ...(reuse ? [] : ['--no-reuse'])], {
      cwd: root, encoding: 'utf8', env,
    });
  };
  return { root, stateRoot, runId, git, runGate, evidence: async () => JSON.parse(await readFile(path.join(stateRoot, runId, `gates/app-${gate}.json`), 'utf8')) };
}

test('a full gate runs on a snapshot of the working tree and leaves the checkout untouched', async () => {
  const fx = await snapshotFixture(`
const fs = require('node:fs'); const path = require('node:path');
fs.appendFileSync(path.join(process.env.PIPELINE_SCRATCH_DIR, 'seen.jsonl'), JSON.stringify({ cwd: process.cwd(),
  value: fs.readFileSync('src/value.txt', 'utf8'), added: fs.existsSync('src/added.txt'), env: fs.existsSync('.env.local'),
  nested: fs.readFileSync('.local-config/nested/mode.txt', 'utf8'),
  state: fs.existsSync('.tmp/pipelines/snap-run/state.json') }) + '\\n');`);
  try {
    await writeFile(path.join(fx.root, 'src/value.txt'), 'uncommitted\n');
    await writeFile(path.join(fx.root, 'src/added.txt'), 'new\n');
    await writeFile(path.join(fx.root, '.env.local'), 'LOCAL=1\n');
    await mkdir(path.join(fx.root, '.local-config/nested'), { recursive: true });
    await writeFile(path.join(fx.root, '.local-config/nested/mode.txt'), 'snapshot-visible');
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
      assert.deepEqual({ ...entry, cwd: undefined }, { cwd: undefined, value: 'uncommitted\n', added: true, env: true, nested: 'snapshot-visible', state: true });
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

test('a gate that passed on an earlier snapshot repeats only the commands later changes reach', async () => {
  const fx = await snapshotFixture(`
const fs = require('node:fs'); const path = require('node:path');
fs.mkdirSync(path.join(process.env.ORIGINAL_ROOT, '.tmp'), { recursive: true });
fs.appendFileSync(path.join(process.env.ORIGINAL_ROOT, '.tmp/calls.log'), (process.argv.includes('vitest.unit.ts') ? 'unit' : 'web') + '\\n');`);
  try {
    assert.equal(fx.runGate().status, 0);
    const first = await fx.evidence();
    assert.ok(first.environment_digest, `reuse test requires a verified baseline identity: ${JSON.stringify({ reason: first.reuse_disabled_reason, diagnostics: first.diagnostics })}`);
    await writeFile(path.join(fx.root, 'src/other.txt'), 'moved on\n');
    const result = fx.runGate({ reuse: true });
    assert.equal(result.status, 0, result.stderr);
    const evidence = await fx.evidence();
    assert.equal(evidence.status, 'PASS');
    assert.deepEqual(evidence.snapshot.reused_by_impact, { from_commit: first.snapshot.commit, changed_paths: ['src/other.txt'], commands: [0] });
    assert.ok(evidence.results[0].reused_from); assert.equal(evidence.results[1].reused_from, undefined);
    assert.deepEqual((await readFile(path.join(fx.root, '.tmp/calls.log'), 'utf8')).trim().split('\n'), ['unit', 'web', 'web']);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test('the lane proof leaves generated files out and a reservation leaves them free', async () => {
  const { laneDigest, leaseConflict } = await import('./dispatch-leases.mjs');
  const files = { 'src/a.ts': 'a', 'src/gen.json': 'g1', 'docs/x.md': 'x' };
  const digest = laneDigest(files, ['src/**'], ['src/gen.json']);
  assert.equal(laneDigest({ ...files, 'src/gen.json': 'g2' }, ['src/**'], ['src/gen.json']), digest);
  assert.notEqual(laneDigest({ ...files, 'src/a.ts': 'b' }, ['src/**'], ['src/gen.json']), digest);
  const lane = { pipeline_id: 'p', stage: 'gate', work_item_id: 'lane p in its gate or review', scope: ['src/**'], exclude: ['src/gen.json'] };
  const self = { pipeline_id: 'q', stage: 'implementation', work_item_id: 'q1' };
  assert.equal(leaseConflict([lane], self, ['src/gen.json']), null);
  assert.equal(leaseConflict([lane], self, ['src/a.ts']).path, 'src/a.ts');
});

test('a snapshot links the checkout dependency trees and permission bits do not change the source digest', async () => {
  const fx = await snapshotFixture(`
const fs = require('node:fs'); const path = require('node:path');
fs.appendFileSync(path.join(process.env.PIPELINE_SCRATCH_DIR, 'seen.jsonl'), JSON.stringify({ cwd: process.cwd(),
  link: fs.existsSync('apps/web/node_modules/@app/contracts/index.js'), dep: fs.existsSync('node_modules/dep/index.js') }) + '\\n');`);
  try {
    await writeFile(path.join(fx.root, '.gitignore'), '.tmp/\n.env*\n.snapshots/\n.locks/\nnode_modules/\n');
    await mkdir(path.join(fx.root, 'packages/contracts'), { recursive: true });
    await writeFile(path.join(fx.root, 'packages/contracts/index.js'), 'export {}\n');
    await mkdir(path.join(fx.root, 'node_modules/dep'), { recursive: true });
    await writeFile(path.join(fx.root, 'node_modules/dep/index.js'), 'module.exports = 1\n');
    await mkdir(path.join(fx.root, 'apps/web/node_modules/@app'), { recursive: true });
    spawnSync('ln', ['-s', '../../../../packages/contracts', path.join(fx.root, 'apps/web/node_modules/@app/contracts')]);
    fx.git('add', '.'); fx.git('commit', '-m', 'workspace');
    spawnSync('chmod', ['666', path.join(fx.root, 'src/value.txt')]);
    const result = fx.runGate();
    assert.equal(result.status, 0, result.stderr);
    const evidence = await fx.evidence();
    assert.deepEqual(evidence.snapshot.dependency_trees.sort(), ['apps/web/node_modules', 'node_modules']);
    const seen = (await readFile(path.join(evidence.scratch_dir, 'seen.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    for (const entry of seen) assert.deepEqual([entry.link, entry.dep], [true, true]);
    // The digest of the checkout (mode 666) equals the snapshot's (fresh checkout, mode 644).
    const { sourceInventory } = await import('./gate-diagnostics.mjs');
    const invoke = (exe, argv) => { const r = spawnSync(exe, argv, { cwd: fx.root, encoding: 'utf8' }); return Promise.resolve({ exit_code: r.status, stdout: r.stdout, stderr: r.stderr, truncated: false }); };
    assert.equal((await sourceInventory(fx.root, invoke)).digest, evidence.source_digest);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test('--in-place runs the gate in the checkout without an environment prefix', async () => {
  const fx = await snapshotFixture(`
const fs = require('node:fs'); const path = require('node:path');
fs.appendFileSync(path.join(process.env.PIPELINE_SCRATCH_DIR, 'seen.jsonl'), JSON.stringify({ cwd: process.cwd() }) + '\\n');`);
  try {
    const result = spawnSync(process.execPath, [RUNNER, fx.runId, 'app', 'build', '--state-root', fx.stateRoot, '--in-place'], {
      cwd: fx.root, encoding: 'utf8', env: { ...process.env, PATH: `${path.join(fx.root, 'bin')}:${process.env.PATH}`, PIPELINE_HEAVY_LOCK_DIR: path.join(fx.root, '.locks') } });
    assert.equal(result.status, 0, result.stderr);
    const evidence = await fx.evidence();
    assert.equal(evidence.snapshot, null);
    const seen = (await readFile(path.join(evidence.scratch_dir, 'seen.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(seen[0].cwd, fx.root);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test('typed release-check uses isolated tree snapshot despite gate name', async () => {
  const fx = await snapshotFixture(`
const fs = require('node:fs');
if (process.cwd() === process.env.ORIGINAL_ROOT) process.exit(41);
if (!fs.existsSync('.tmp/pipelines/snap-run/state.json')) process.exit(42);
fs.appendFileSync(process.env.PIPELINE_SCRATCH_DIR + '/isolated.log', process.cwd() + '\\n');
`, 'release-check');
  try {
    const result = fx.runGate();
    assert.equal(result.status, 0, result.stderr);
    const evidence = await fx.evidence();
    assert.equal(evidence.status, 'PASS');
    assert.equal(evidence.snapshot.status, 'used');
    assert.ok(evidence.scratch_dir);
    assert.deepEqual(evidence.results.map(item => [item.command_index, item.exit_code]), [[0, 0], [1, 0]]);
    const isolated = (await readFile(path.join(evidence.scratch_dir, 'isolated.log'), 'utf8')).trim().split('\n');
    assert.equal(isolated.length, 2);
    for (const cwd of isolated) assert.notEqual(cwd, fx.root);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});
