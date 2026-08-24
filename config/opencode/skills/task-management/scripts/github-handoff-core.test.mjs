import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./github-handoff-cli.ts', import.meta.url));
const toolWrapper = fileURLToPath(new URL('../../../tool/github_handoff.ts', import.meta.url));

function exec(command, args, cwd, envExtra = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_NO_WARNINGS: '1', ...envExtra },
  }).trim();
}

function git(cwd, ...args) {
  return exec('git', args, cwd);
}

function runCli(cwd, ...args) {
  return exec(process.execPath, ['--experimental-strip-types', cli, ...args], cwd);
}

function runCliWithEnv(cwd, envExtra, ...args) {
  return exec(process.execPath, ['--experimental-strip-types', cli, ...args], cwd, envExtra);
}

function runCliWithoutProjectRoot(cwd, ...args) {
  const { PIPELINE_PROJECT_ROOT: _ignored, ...env } = process.env;
  return execFileSync(process.execPath, ['--experimental-strip-types', cli, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, NODE_NO_WARNINGS: '1' },
  }).trim();
}

function runCliWithProjectRoot(cwd, projectRoot, ...args) {
  return exec(process.execPath, ['--experimental-strip-types', cli, '--project-root', projectRoot, ...args], cwd);
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

function runCliFailureWithEnv(cwd, envExtra, ...args) {
  try {
    runCliWithEnv(cwd, envExtra, ...args);
    assert.fail(`Expected CLI failure: ${args.join(' ')}`);
  } catch (error) {
    const stderr = String(error?.stderr ?? '').trim();
    assert.ok(stderr, 'CLI failure must emit structured stderr');
    return JSON.parse(stderr);
  }
}

function runCliFailureWithProjectRoot(cwd, projectRoot, ...args) {
  try {
    runCliWithProjectRoot(cwd, projectRoot, ...args);
    assert.fail(`Expected CLI failure: ${args.join(' ')}`);
  } catch (error) {
    const stderr = String(error?.stderr ?? '').trim();
    assert.ok(stderr, 'CLI failure must emit structured stderr');
    return JSON.parse(stderr);
  }
}

function fixture(runId = 'run-1', allowedFixScope = ['src/**']) {
  const root = mkdtempSync(join(tmpdir(), 'github-handoff-'));
  const remote = join(root, 'remote.git');
  const work = join(root, 'work');

  mkdirSync(work, { recursive: true });
  git(root, 'init', '--bare', remote);
  git(work, 'init', '-b', 'gpt');
  git(work, 'config', 'user.name', 'Handoff Test');
  git(work, 'config', 'user.email', 'handoff-test@example.invalid');

  writeFileSync(join(work, '.gitignore'), '.tmp/\n', 'utf8');
  writeFileSync(join(work, 'app.txt'), 'source\n', 'utf8');
  git(work, 'add', '.gitignore', 'app.txt');
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
        run_id: runId,
        source_branch: 'gpt',
        source_sha: sourceSha,
        pipeline_id: 'validation',
        rules_file: 'docs/pipeline-rules.md',
        rules_version: 2,
        validation_stages: ['build', 'tests'],
        allowed_fix_scope: allowedFixScope,
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

// --- Existing tests ---

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

// --- Project-root resolution tests ---

test('probe works from nested cwd when project_root points to worktree', () => {
  const { work, sourceSha } = fixture();
  const nested = join(work, 'src', 'deep', 'nested');
  mkdirSync(nested, { recursive: true });

  const probe = JSON.parse(runCliWithEnv(nested, { PIPELINE_PROJECT_ROOT: work }, 'probe', 'run-1', 'test-handoff'));
  assert.equal(probe.status, 'visible');
  assert.equal(probe.handoff_branch, 'handoff/test-handoff');
});

test('prepare works from nested cwd via PIPELINE_PROJECT_ROOT env', () => {
  const { work, sourceSha } = fixture();
  const nested = join(work, 'src', 'deep');
  mkdirSync(nested, { recursive: true });

  const prepared = JSON.parse(
    runCliWithEnv(nested, { PIPELINE_PROJECT_ROOT: work }, 'prepare', 'run-1', 'test-handoff'),
  );
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.source_sha, sourceSha);
  assert.equal(git(work, 'branch', '--show-current'), 'pipeline/run-1');
});

test('nested cwd discovers project root when no override is provided', () => {
  const { work } = fixture();
  const nested = join(work, 'src', 'deep', 'nested');
  mkdirSync(nested, { recursive: true });

  const probe = JSON.parse(runCliWithoutProjectRoot(nested, 'probe', 'run-1', 'test-handoff'));
  assert.equal(probe.status, 'visible');
  assert.equal(probe.handoff_branch, 'handoff/test-handoff');
});

test('explicit project_root outside cwd works for probe', () => {
  const { work } = fixture();
  const outsideDir = mkdtempSync(join(tmpdir(), 'handoff-outside-'));

  const probe = JSON.parse(runCliWithProjectRoot(outsideDir, work, 'probe', 'run-1', 'test-handoff'));
  assert.equal(probe.status, 'visible');
});

test('explicit project_root takes precedence over conflicting environment root', () => {
  const selected = fixture();
  const ignored = fixture();
  const outsideDir = mkdtempSync(join(tmpdir(), 'handoff-outside-'));

  const prepared = JSON.parse(
    exec(
      process.execPath,
      ['--experimental-strip-types', cli, '--project-root', selected.work, 'prepare', 'run-1', 'test-handoff'],
      outsideDir,
      { PIPELINE_PROJECT_ROOT: ignored.work },
    ),
  );

  assert.equal(prepared.status, 'prepared');
  assert.ok(existsSync(join(selected.work, '.tmp', 'pipelines', 'run-1', 'github-handoff.json')));
  assert.equal(existsSync(join(ignored.work, '.tmp', 'pipelines', 'run-1', 'github-handoff.json')), false);
});

test('invalid project_root returns INVALID_PROJECT_ROOT', () => {
  const notGit = mkdtempSync(join(tmpdir(), 'not-a-git-'));
  const failure = runCliFailureWithProjectRoot(notGit, notGit, 'probe', 'run-1', 'test-handoff');
  assert.equal(failure.status, 'blocked');
  assert.equal(failure.error_code, 'INVALID_PROJECT_ROOT');
  assert.match(failure.error, /Not a Git repository/);
});

test('state stored under project root, not cwd', () => {
  const { work, sourceSha } = fixture();
  const nested = join(work, 'sub', 'dir');
  mkdirSync(nested, { recursive: true });

  const prepared = JSON.parse(
    runCliWithEnv(nested, { PIPELINE_PROJECT_ROOT: work }, 'prepare', 'run-1', 'test-handoff'),
  );
  assert.equal(prepared.status, 'prepared');

  const runtimePath = join(work, '.tmp', 'pipelines', 'run-1', 'github-handoff.json');
  const manifestPath = join(work, '.tmp', 'pipelines', 'run-1', 'github-validation-manifest.json');
  assert.ok(existsSync(runtimePath), 'runtime under project root');
  assert.ok(existsSync(manifestPath), 'manifest under project root');

  const runtime = JSON.parse(readFileSync(runtimePath, 'utf8'));
  assert.equal(runtime.source_sha, sourceSha);
});

test('per-project state isolation: two projects get separate state dirs', () => {
  const proj1 = fixture('run-A');
  const proj2 = fixture('run-B');

  const prep1 = JSON.parse(
    runCliWithEnv(proj1.work, { PIPELINE_PROJECT_ROOT: proj1.work }, 'prepare', 'run-A', 'test-handoff'),
  );
  const prep2 = JSON.parse(
    runCliWithEnv(proj2.work, { PIPELINE_PROJECT_ROOT: proj2.work }, 'prepare', 'run-B', 'test-handoff'),
  );
  assert.equal(prep1.status, 'prepared');
  assert.equal(prep2.status, 'prepared');

  const state1 = join(proj1.work, '.tmp', 'pipelines', 'run-A', 'github-handoff.json');
  const state2 = join(proj2.work, '.tmp', 'pipelines', 'run-B', 'github-handoff.json');
  assert.ok(existsSync(state1), 'project 1 state exists');
  assert.ok(existsSync(state2), 'project 2 state exists');

  const r1 = JSON.parse(readFileSync(state1, 'utf8'));
  const r2 = JSON.parse(readFileSync(state2, 'utf8'));
  assert.notEqual(state1, state2, 'state paths are project-specific');
  assert.equal(r1.handoff.source_sha, proj1.sourceSha, 'project 1 state belongs to project 1');
  assert.equal(r2.handoff.source_sha, proj2.sourceSha, 'project 2 state belongs to project 2');
});

test('Git commands use resolved project root, not process cwd', () => {
  const { work } = fixture();
  const nested = join(work, 'deep', 'nested');
  mkdirSync(nested, { recursive: true });

  const prepared = JSON.parse(
    runCliWithEnv(nested, { PIPELINE_PROJECT_ROOT: work }, 'prepare', 'run-1', 'test-handoff'),
  );
  assert.equal(prepared.status, 'prepared');

  const branch = git(work, 'branch', '--show-current');
  assert.equal(branch, 'pipeline/run-1', 'branch set on project root worktree');

  const head = git(work, 'rev-parse', 'HEAD');
  assert.equal(head, prepared.source_sha, 'HEAD points to source SHA on project root');
});

test('status works with resolved project root from different cwd', () => {
  const { work, sourceSha } = fixture();
  const nested = join(work, 'a', 'b');
  mkdirSync(nested, { recursive: true });

  runCliWithEnv(nested, { PIPELINE_PROJECT_ROOT: work }, 'prepare', 'run-1', 'test-handoff');

  const status = JSON.parse(
    runCliWithEnv(nested, { PIPELINE_PROJECT_ROOT: work }, 'status', 'run-1'),
  );
  assert.equal(status.source_sha, sourceSha);
  assert.equal(status.current_branch, 'pipeline/run-1');
  assert.equal(status.worktree_clean, true);
});

test('publish uses explicit project_root from outside cwd', () => {
  const { work } = fixture();
  const outsideDir = mkdtempSync(join(tmpdir(), 'handoff-outside-'));
  const nested = join(work, 'src');
  mkdirSync(nested, { recursive: true });

  runCli(work, 'prepare', 'run-1', 'test-handoff');
  writeFileSync(join(nested, 'fix.txt'), 'validated\n', 'utf8');

  const published = JSON.parse(
    exec(
      process.execPath,
      ['--experimental-strip-types', cli, '--project-root', work, 'publish', 'run-1'],
      outsideDir,
    ),
  );

  assert.equal(published.status, 'published');
  assert.equal(published.fixes_committed, true);
  assert.equal(git(work, 'rev-parse', 'origin/gpt'), git(work, 'rev-parse', 'HEAD'));
});

test('publish preserves unstaged apps path from porcelain status', () => {
  const { work } = fixture('run-1', ['apps/**']);
  const apps = join(work, 'apps');
  mkdirSync(apps, { recursive: true });

  runCli(work, 'prepare', 'run-1', 'test-handoff');
  writeFileSync(join(apps, 'profile.txt'), 'validated\n', 'utf8');

  const published = JSON.parse(runCli(work, 'publish', 'run-1'));
  assert.equal(published.status, 'published');
  assert.deepEqual(published.changed_files, ['apps/profile.txt']);
});

test('tool wrapper has project_root optional param in all tools', () => {
  const source = readFileSync(toolWrapper, 'utf8');
  assert.match(source, /project_root.*tool\.schema\.string\(\)\.optional\(\)/);
});
