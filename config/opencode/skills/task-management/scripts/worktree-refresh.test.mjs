import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worktree-refresh.sh');
const shell = (cwd, args = []) => spawnSync('bash', [SCRIPT, ...args], { cwd, encoding: 'utf8' });
function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'refresh-worktree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  const main = path.join(root, 'main');
  const b = path.join(root, 'B');
  const upstream = path.join(root, 'upstream');
  git(root, 'init', '--bare', remote);
  await mkdir(main);
  git(main, 'init');
  git(main, 'config', 'user.name', 'Refresh Test');
  git(main, 'config', 'user.email', 'refresh@example.invalid');
  await mkdir(path.join(main, 'src'));
  await writeFile(path.join(main, '.gitignore'), '.tmp/\n');
  await writeFile(path.join(main, 'src/base.txt'), 'base\n');
  git(main, 'add', '.');
  git(main, 'commit', '-m', 'base');
  git(main, 'branch', '-M', 'main');
  git(main, 'remote', 'add', 'origin', remote);
  git(main, 'push', '-u', 'origin', 'main');
  git(main, 'worktree', 'add', '-b', 'feature/B', b, 'main');
  const dir = path.join(b, '.tmp/pipelines/run-b');
  await mkdir(path.join(dir, 'planning'), { recursive: true });
  const historical = JSON.stringify({ run_id: 'run-b', git_setup: {
    branch: 'feature/B', base_sha: git(main, 'rev-parse', 'HEAD') } }, null, 2) + '\n';
  await writeFile(path.join(dir, 'manifest.json'), historical);
  await writeFile(path.join(dir, 'planning/research.md'), 'Preserve research\n');
  await writeFile(path.join(dir, 'planning/.hidden-evidence'), 'hidden important context\n');
  await writeFile(path.join(dir, 'state.json'), '{"status":"approved"}\n');
  git(root, 'clone', '-b', 'main', remote, upstream);
  git(upstream, 'config', 'user.name', 'Other Test');
  git(upstream, 'config', 'user.email', 'other@example.invalid');
  return { root, remote, main, b, upstream, historical, dir };
}
async function mergeA(f, file = 'A.txt', content = 'merged A\n') {
  await writeFile(path.join(f.upstream, 'src', file), content);
  git(f.upstream, 'add', '.');
  git(f.upstream, 'commit', '-m', 'owner merge A');
  git(f.upstream, 'push', 'origin', 'main');
  return git(f.upstream, 'rev-parse', 'HEAD');
}

test('one-command B refresh updates local main, preserves all evidence including hidden files, and never edits old manifest', async (t) => {
  const f = await fixture(t);
  const newMain = await mergeA(f);
  const before = git(f.b, 'rev-parse', 'HEAD');
  let result = shell(f.b, ['--check']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CHECK PASS/);
  assert.equal(git(f.main, 'rev-parse', 'HEAD'), before, '--check cannot fetch/merge');
  result = shell(f.b);
  assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
  assert.match(result.stdout, /REFRESH PASS/);
  assert.match(result.stdout, /NEXT: run pipeline-refresh-cli apply/);
  assert.equal(git(f.main, 'rev-parse', 'HEAD'), newMain);
  assert.equal(git(f.b, 'rev-parse', 'HEAD'), newMain);
  assert.equal(git(f.b, 'branch', '--show-current'), 'feature/B');
  assert.equal(await readFile(path.join(f.dir, 'manifest.json'), 'utf8'), f.historical);
  assert.equal(await readFile(path.join(f.dir, 'planning/research.md'), 'utf8'), 'Preserve research\n');
  assert.equal(await readFile(path.join(f.dir, 'planning/.hidden-evidence'), 'utf8'), 'hidden important context\n');
  const archiveMatch = result.stdout.match(/^SNAPSHOT: (.*)$/m);
  assert.ok(archiveMatch, result.stdout);
  const archive = archiveMatch[1];
  assert.ok(archive.startsWith(path.join(f.main, '.git', 'pipeline-backups')), archive);
  assert.ok((await stat(archive)).size > 0);
  assert.ok((await stat(`${archive}.sha256`)).size > 0);
  const archiveManifest = spawnSync('tar', ['-xOf', archive, '.tmp/pipelines/run-b/manifest.json'], { encoding: 'utf8' });
  assert.equal(archiveManifest.status, 0, archiveManifest.stderr);
  assert.equal(archiveManifest.stdout, f.historical);
  assert.equal(git(f.b, 'status', '--porcelain'), '');
});

test('published B history is preserved with merge rather than rebase/force-push', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.b, 'src/B.txt'), 'owned B code\n');
  git(f.b, 'add', '.');
  git(f.b, 'commit', '-m', 'existing B preparation');
  const existingB = git(f.b, 'rev-parse', 'HEAD');
  git(f.b, 'push', '-u', 'origin', 'feature/B');
  const newMain = await mergeA(f);
  const result = shell(f.b);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  git(f.b, 'merge-base', '--is-ancestor', existingB, 'HEAD');
  git(f.b, 'merge-base', '--is-ancestor', newMain, 'HEAD');
  assert.equal(git(f.b, 'rev-parse', 'refs/remotes/origin/feature/B'), existingB,
    'no publication or force-push');
});

test('dirty checkout and primary main are rejected before Git mutation or snapshot', async (t) => {
  const f = await fixture(t);
  await mergeA(f);
  let result = shell(f.main);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /linked worktree|non-default branch/);
  await writeFile(path.join(f.b, 'untracked.txt'), 'do not lose\n');
  result = shell(f.b);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /B is dirty/);
  assert.equal(git(f.main, 'rev-parse', 'HEAD'), git(f.b, 'rev-parse', 'HEAD'));
  assert.equal(await readFile(path.join(f.b, 'untracked.txt'), 'utf8'), 'do not lose\n');
});

test('a merge conflict preserves the original planning snapshot and does not force cleanup', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.b, 'src/base.txt'), 'B changed base\n');
  git(f.b, 'add', '.');
  git(f.b, 'commit', '-m', 'B changes shared file');
  await mergeA(f, 'base.txt', 'A changed base\n');
  const result = shell(f.b);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /REFRESH FAILED/);
  assert.match(result.stderr, /Snapshot: .*pipelines\.tar/);
  const snapshot = result.stderr.match(/Snapshot: ([^\n]+pipelines\.tar)/)?.[1];
  assert.ok(snapshot);
  assert.ok((await stat(snapshot)).size > 0);
  assert.equal(await readFile(path.join(f.dir, 'manifest.json'), 'utf8'), f.historical);
  assert.match(git(f.b, 'status', '--porcelain'), /UU src\/base\.txt/);
  assert.equal(git(f.b, 'branch', '--show-current'), 'feature/B');
});

test('incoming main tracking pipeline evidence is rejected before either branch is updated', async (t) => {
  const f = await fixture(t);
  const oldMain = git(f.main, 'rev-parse', 'HEAD');
  const trackedPath = path.join(f.upstream, '.tmp/pipelines/unexpected/manifest.json');
  await mkdir(path.dirname(trackedPath), { recursive: true });
  await writeFile(trackedPath, 'tracked conflicting evidence\n');
  git(f.upstream, 'add', '-f', '.tmp/pipelines/unexpected/manifest.json');
  git(f.upstream, 'commit', '-m', 'accidental tracked plan in A');
  git(f.upstream, 'push', 'origin', 'main');
  const result = shell(f.b);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /incoming origin\/main tracks \.tmp\/pipelines/);
  assert.equal(git(f.main, 'rev-parse', 'HEAD'), oldMain);
  assert.equal(git(f.b, 'rev-parse', 'HEAD'), oldMain);
  assert.equal(await readFile(path.join(f.dir, 'manifest.json'), 'utf8'), f.historical);
  assert.match(result.stdout, /SNAPSHOT VERIFIED/);
});
