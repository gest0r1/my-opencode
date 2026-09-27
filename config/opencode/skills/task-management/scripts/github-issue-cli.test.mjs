import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'github-issue-cli.ts');

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'github-issue-cli-'));
  const bin = path.join(root, 'bin');
  await mkdir(bin);

  const git = path.join(bin, 'git');
  await writeFile(git, `#!/bin/sh
if [ "$*" = "remote get-url origin" ]; then
  echo "git@github.com:gest0r1/sevami.git"
  exit 0
fi
echo "unexpected git args: $*" >&2
exit 2
`);
  await chmod(git, 0o755);

  const gh = path.join(bin, 'gh');
  await writeFile(gh, `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  if [ "\${GH_AUTH_FAIL:-0}" = "1" ]; then exit 1; fi
  exit 0
fi
case "$*" in
  *"repos/gest0r1/sevami/issues/5/comments"*)
    echo '[[{"id":501,"html_url":"https://github.com/gest0r1/sevami/issues/5#issuecomment-501","body":"requirement note","user":{"login":"owner"},"created_at":"2026-09-26T10:00:00Z","updated_at":"2026-09-26T10:00:00Z"}]]'
    ;;
  *"repos/gest0r1/sevami/issues/9/comments"*)
    echo '[[]]'
    ;;
  *"repos/gest0r1/sevami/issues/6/comments"*|*"repos/gest0r1/sevami/issues/7/comments"*|*"repos/gest0r1/sevami/issues/8/comments"*)
    echo '[[]]'
    ;;
  *"repos/gest0r1/sevami/issues/5"*)
    echo '{"number":5,"html_url":"https://github.com/gest0r1/sevami/issues/5","title":"Issue five","body":"body five","state":"open","updated_at":"2026-09-26T10:00:00Z"}'
    ;;
  *"repos/gest0r1/sevami/issues/9"*)
    echo '{"number":9,"html_url":"https://github.com/gest0r1/sevami/issues/9","title":"Issue nine","body":"","state":"open","updated_at":"2026-09-26T11:00:00Z"}'
    ;;
  *"repos/gest0r1/sevami/issues/6"*)
    echo '{"number":6,"title":"PR six","body":"","state":"open","pull_request":{"url":"x"}}'
    ;;
  *"repos/gest0r1/sevami/issues/7"*)
    echo '{"number":7,"title":"Closed seven","body":"","state":"closed"}'
    ;;
  *"repos/gest0r1/sevami/issues/8"*)
    echo "HTTP 404" >&2
    exit 1
    ;;
  *)
    echo "unexpected gh args: $*" >&2
    exit 2
    ;;
esac
`);
  await chmod(gh, 0o755);
  return { root, bin };
}

function run(root, bin, args, extraEnv = {}) {
  return spawnSync('npx', ['--yes', 'tsx', CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...extraEnv },
  });
}

test('fetch writes normalized authoritative snapshot and deduplicates issue numbers', async () => {
  const { root, bin } = await fixture();
  const result = run(root, bin, ['fetch', 'run-1', '5', '5', '9']);
  assert.equal(result.status, 0, result.stderr);

  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'PASS');
  assert.equal(output.repository, 'gest0r1/sevami');
  assert.deepEqual(output.issue_numbers, [5, 9]);
  assert.match(output.snapshot_sha256, /^[0-9a-f]{64}$/);

  const snapshot = JSON.parse(
    await readFile(path.join(root, '.tmp', 'pipelines', 'run-1', 'sources', 'github-issues.json'), 'utf8'),
  );
  assert.equal(snapshot.repository, 'gest0r1/sevami');
  assert.equal(snapshot.issues.length, 2);
  assert.equal(snapshot.issues[0].title, 'Issue five');
  assert.equal(snapshot.issues[0].comments[0].body, 'requirement note');
});

test('fetch blocks pull requests, closed issues and GitHub lookup failures', async () => {
  for (const [number, expected] of [
    ['6', /pull request, not an issue/],
    ['7', /is not open/],
    ['8', /gh failed: HTTP 404/],
  ]) {
    const { root, bin } = await fixture();
    const result = run(root, bin, ['fetch', `run-${number}`, number]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
  }
});

test('fetch fails closed when GitHub CLI authentication is unavailable', async () => {
  const { root, bin } = await fixture();
  const result = run(root, bin, ['fetch', 'run-auth', '5'], { GH_AUTH_FAIL: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /GITHUB_AUTH_UNAVAILABLE/);
});

test('repository parser rejects non-GitHub origin without calling the API', async () => {
  const { root, bin } = await fixture();
  await writeFile(path.join(bin, 'git'), `#!/bin/sh
echo "ssh://git@example.invalid/owner/repo.git"
`);
  await chmod(path.join(bin, 'git'), 0o755);
  const result = run(root, bin, ['fetch', 'run-origin', '5']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /origin must point to github\.com/);
});


test('show reads the authoritative snapshot without mutating it and preserves long body text', async () => {
  const { root, bin } = await fixture();
  let result = run(root, bin, ['fetch', 'run-show', '5']);
  assert.equal(result.status, 0, result.stderr);
  const snapshotPath = path.join(root, '.tmp', 'pipelines', 'run-show', 'sources', 'github-issues.json');
  const before = await readFile(snapshotPath, 'utf8');

  result = run(root, bin, ['show', 'run-show', '5']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Issue #5 — Issue five/);
  assert.match(result.stdout, /body five/);
  assert.match(result.stdout, /requirement note/);
  assert.match(result.stdout, /sha256: [0-9a-f]{64}/);

  const after = await readFile(snapshotPath, 'utf8');
  assert.equal(after, before);
});

test('show fails closed for an issue absent from the frozen snapshot', async () => {
  const { root, bin } = await fixture();
  const fetched = run(root, bin, ['fetch', 'run-show-missing', '5']);
  assert.equal(fetched.status, 0, fetched.stderr);
  const result = run(root, bin, ['show', 'run-show-missing', '9']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not present in the authoritative snapshot/);
});
