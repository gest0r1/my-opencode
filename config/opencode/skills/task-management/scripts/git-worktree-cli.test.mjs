import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT_CLI = path.join(HERE, 'git-worktree-cli.ts');

function exec(cwd, command, args) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: process.env });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

function runGate(cwd, args) {
  return spawnSync('npx', ['--yes', 'tsx', GIT_CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: process.env,
  });
}

async function makeRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-worktree-gate-'));
  const remote = path.join(root, 'remote.git');
  const repo = path.join(root, 'repo');
  await mkdir(repo, { recursive: true });
  exec(root, 'git', ['init', '--bare', remote]);
  exec(repo, 'git', ['init']);
  exec(repo, 'git', ['config', 'user.name', 'Pipeline Test']);
  exec(repo, 'git', ['config', 'user.email', 'pipeline@example.invalid']);
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await writeFile(path.join(repo, 'src', 'base.txt'), 'base\n', 'utf8');
  exec(repo, 'git', ['add', '.']);
  exec(repo, 'git', ['commit', '-m', 'base']);
  exec(repo, 'git', ['branch', '-M', 'main']);
  exec(repo, 'git', ['remote', 'add', 'origin', remote]);
  exec(repo, 'git', ['push', '-u', 'origin', 'main']);
  const baseSha = exec(repo, 'git', ['rev-parse', 'HEAD']);
  return { root, remote, repo, baseSha };
}

test('verify blocks files outside approved scope and publish records exact candidate SHA', async () => {
  const fixture = await makeRepository();
  const manifest = {
    schema_version: 1,
    run_id: 'scope-run',
    allowed_change_paths: ['src/**'],
    git_setup: {
      base_sha: fixture.baseSha,
      branch: 'feature/scope-run',
      must_absent: ['forbidden-generated.txt'],
    },
  };
  const manifestPath = path.join(fixture.root, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  let result = runGate(fixture.repo, ['setup', manifestPath]);
  assert.equal(result.status, 0, result.stderr);

  await writeFile(path.join(fixture.repo, 'src', 'allowed.txt'), 'allowed\n', 'utf8');
  result = runGate(fixture.repo, ['verify', manifestPath]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).changed_files, ['src/allowed.txt']);

  await writeFile(path.join(fixture.repo, 'outside.txt'), 'not allowed\n', 'utf8');
  result = runGate(fixture.repo, ['verify', manifestPath]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside approved scope/);
  await rm(path.join(fixture.repo, 'outside.txt'));

  result = runGate(fixture.repo, ['publish', manifestPath]);
  assert.equal(result.status, 0, result.stderr);
  const published = JSON.parse(result.stdout);
  assert.match(published.candidate_sha, /^[0-9a-f]{40}$/);
  assert.equal(published.candidate_sha, published.remote_sha);

  const remoteLine = exec(fixture.repo, 'git', [
    'ls-remote', '--heads', 'origin', 'refs/heads/feature/scope-run',
  ]);
  assert.equal(remoteLine.split(/\s+/)[0], published.candidate_sha);

  const evidence = JSON.parse(await readFile(path.join(fixture.root, 'candidate.json'), 'utf8'));
  assert.equal(evidence.status, 'PASS');
  assert.equal(evidence.candidate_sha, published.candidate_sha);
  assert.deepEqual(evidence.changed_files, ['src/allowed.txt']);
});

test('setup refuses checkout paths outside allowed change scope before branch mutation', async () => {
  const fixture = await makeRepository();

  await writeFile(path.join(fixture.repo, 'other.txt'), 'source\n', 'utf8');
  exec(fixture.repo, 'git', ['add', 'other.txt']);
  exec(fixture.repo, 'git', ['commit', '-m', 'source commit']);
  const sourceSha = exec(fixture.repo, 'git', ['rev-parse', 'HEAD']);
  exec(fixture.repo, 'git', ['push', 'origin', 'HEAD:refs/heads/source']);
  exec(fixture.repo, 'git', ['reset', '--hard', fixture.baseSha]);

  const manifest = {
    run_id: 'bad-checkout-run',
    allowed_change_paths: ['src/**'],
    git_setup: {
      base_sha: fixture.baseSha,
      branch: 'feature/bad-checkout',
      source_sha: sourceSha,
      checkout_paths: ['other.txt'],
    },
  };
  const manifestPath = path.join(fixture.root, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const result = runGate(fixture.repo, ['setup', manifestPath]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checkout path is outside allowed_change_paths/);
  assert.equal(exec(fixture.repo, 'git', ['branch', '--show-current']), 'main');
  assert.equal(exec(fixture.repo, 'git', ['rev-parse', 'HEAD']), fixture.baseSha);
});

test('adopt accepts an existing linked worktree and refuses the primary checkout', async () => {
  const fixture = await makeRepository();
  const linked = path.join(fixture.root, 'pipeline-worktree');
  exec(fixture.repo, 'git', ['worktree', 'add', '-b', 'pipeline/adopt-run', linked, fixture.baseSha]);

  const manifest = {
    schema_version: 1,
    run_id: 'adopt-run',
    allowed_change_paths: ['src/**'],
    git_setup: {
      base_sha: fixture.baseSha,
      branch: 'pipeline/adopt-run',
      workspace_mode: 'linked_worktree',
    },
  };
  const manifestPath = path.join(fixture.root, 'adopt-manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  let result = runGate(linked, ['adopt', manifestPath]);
  assert.equal(result.status, 0, result.stderr);
  const adopted = JSON.parse(result.stdout);
  assert.equal(adopted.linked_worktree, true);
  assert.equal(adopted.branch, 'pipeline/adopt-run');

  result = runGate(fixture.repo, ['adopt', manifestPath]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a linked git worktree/);
});

test('linked-worktree manifest cannot fall back to legacy setup', async () => {
  const fixture = await makeRepository();
  const manifest = {
    run_id: 'linked-no-setup',
    allowed_change_paths: ['src/**'],
    git_setup: {
      base_sha: fixture.baseSha,
      branch: 'pipeline/linked-no-setup',
      workspace_mode: 'linked_worktree',
    },
  };
  const manifestPath = path.join(fixture.root, 'linked-manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const result = runGate(fixture.repo, ['setup', manifestPath]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must use adopt/);
  assert.equal(exec(fixture.repo, 'git', ['branch', '--show-current']), 'main');
});
