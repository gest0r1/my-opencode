import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./github-handoff-cli.ts', import.meta.url));
const toolWrapper = fileURLToPath(new URL('../../../tool/github_handoff.ts', import.meta.url));

function exec(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  }).trim();
}

function git(cwd, ...args) {
  return exec('git', args, cwd);
}

function runCli(cwd, ...args) {
  return exec(process.execPath, ['--experimental-strip-types', cli, ...args], cwd);
}

function runCliFailure(cwd, ...args) {
  try {
    runCli(cwd, ...args);
    assert.fail(`Expected CLI failure: ${args.join(' ')}`);
  } catch (error) {
    const stderr = String(error?.stderr ?? '').trim();
    assert.ok(stderr, 'CLI failure must emit structured stderr');
    return JSON.parse(stderr);
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'github-handoff-'));
  const remote = join(root, 'remote.git');
  const work = join(root, 'work');

  mkdirSync(work, { recursive: true });
  git(root, 'init', '--bare', remote);
  git(work, 'init', '-b', 'gpt');
  git(work, 'config', 'user.name', 'Handoff Test');
  git(work, 'config', 'user.email', 'handoff-test@example.invalid');

  writeFileSync(join(work, 'app.txt'), 'source\n', 'utf8');
  git(work, 'add', 'app.txt');
  git(work, 'commit', '-m', 'source');
  const sourceSha = git(work, 'rev-parse', 'HEAD');
  git(work, 'remote', 'add', 'origin', remote);
  git(work, 'push', '-u', 'origin', 'gpt');

  git(work, 'switch', '-c', 'handoff/test-handoff');
  mkdirSync(join(work, '.opencode'), { recursive: true });
  writeFileSync(
    join(work, '.opencode', 'pipeline-handoff.json'),
    `${JSON.stringify(
      {
        schema_version: 1,
        provider: 'github',
        handoff_id: 'test-handoff',
        run_id: 'run-1',
        source_branch: 'gpt',
        source_sha: sourceSha,
        pipeline_id: 'validation',
        rules_file: 'docs/pipeline-rules.md',
        rules_version: 2,
        validation_stages: ['build', 'tests'],
        allowed_fix_scope: ['src/**'],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  git(work, 'add', '.opencode/pipeline-handoff.json');
  git(work, 'commit', '-m', 'handoff');
  git(work, 'push', 'origin', 'handoff/test-handoff');
  git(work, 'switch', 'gpt');

  return { root, remote, work, sourceSha };
}

test('custom tool imports the core directly and does not require bun subprocess', () => {
  const source = readFileSync(toolWrapper, 'utf8');
  assert.match(source, /github-handoff-core\.ts/);
  assert.doesNotMatch(source, /execFileSync\(['"]bun['"]/);
});

test('probe sees exact handoff ref and prepare checks out exact source SHA', () => {
  const { work, sourceSha } = fixture();

  const probe = JSON.parse(runCli(work, 'probe', 'run-1', 'test-handoff'));
  assert.equal(probe.status, 'visible');
  assert.equal(probe.handoff_branch, 'handoff/test-handoff');
  assert.match(probe.remote_sha, /^[0-9a-f]{40}$/);

  const prepared = JSON.parse(runCli(work, 'prepare', 'run-1', 'test-handoff'));
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.source_sha, sourceSha);
  assert.equal(git(work, 'branch', '--show-current'), 'pipeline/run-1');
  assert.equal(git(work, 'rev-parse', 'HEAD'), sourceSha);

  const runtime = JSON.parse(readFileSync(join(work, '.tmp/pipelines/run-1/github-handoff.json'), 'utf8'));
  const manifest = JSON.parse(
    readFileSync(join(work, '.tmp/pipelines/run-1/github-validation-manifest.json'), 'utf8'),
  );
  assert.equal(runtime.source_sha, sourceSha);
  assert.deepEqual(manifest.pipelines[0].stages, ['build', 'tests']);
});

test('missing handoff ref returns explicit REMOTE_REF_NOT_FOUND', () => {
  const { work } = fixture();
  const failure = runCliFailure(work, 'probe', 'run-404', 'missing-handoff');
  assert.equal(failure.status, 'blocked');
  assert.equal(failure.error_code, 'REMOTE_REF_NOT_FOUND');
  assert.match(failure.error, /not visible through Git credentials/);
});

test('prepare blocks when source branch moved after immutable handoff', () => {
  const { work } = fixture();

  writeFileSync(join(work, 'app.txt'), 'source moved\n', 'utf8');
  git(work, 'add', 'app.txt');
  git(work, 'commit', '-m', 'move source');
  git(work, 'push', 'origin', 'gpt');

  assert.equal(
    existsSync(join(work, '.opencode', 'pipeline-handoff.json')),
    false,
    'handoff file must not exist on the gpt worktree',
  );

  const failure = runCliFailure(work, 'prepare', 'run-1', 'test-handoff');
  assert.equal(failure.status, 'blocked');
  assert.equal(failure.error_code, 'SOURCE_BRANCH_MOVED');
  assert.match(failure.error, /Source branch moved after handoff/);
});
