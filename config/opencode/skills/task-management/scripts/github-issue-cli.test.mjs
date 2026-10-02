import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'github-issue-cli.ts');
const sha = (value) => createHash('sha256').update(value).digest('hex');

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'github-issue-cli-v2-'));
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  const posted = path.join(root, 'posted.txt');

  await writeFile(path.join(bin, 'git'), `#!/bin/sh
if [ "$*" = "remote get-url origin" ]; then
  echo "git@github.com:gest0r1/sevami.git"
  exit 0
fi
echo "unexpected git args: $*" >&2
exit 2
`);
  await chmod(path.join(bin, 'git'), 0o755);

  await writeFile(path.join(bin, 'gh'), `#!/bin/bash
set -Eeuo pipefail
if [[ "$1" == auth && "$2" == status ]]; then
  [[ "${GH_AUTH_FAIL:-0}" != 1 ]]
  exit
fi
if [[ "$1" != api ]]; then exit 2; fi
if [[ "$*" == *"--method POST"* ]]; then
  printf '%s\\n' "$*" >> "$POSTED_FILE"
  exit 0
fi
case "$*" in
  *"repos/gest0r1/sevami/issues/5/comments"*)
    body='requirement note'
    if [[ "${PIPELINE_COMMENT:-0}" == 1 ]]; then
      printf '%s\\n' '[[{"id":501,"body":"requirement note","user":{"login":"owner"},"created_at":"2026-09-26T10:00:00Z","updated_at":"2026-09-26T10:00:00Z"},{"id":502,"body":"<!-- pipeline-event:test:issue-5 -->\\nPipeline audit","user":{"login":"bot"}},{"id":503,"body":"<!-- pipeline-artifact:story:run-1:issue-5 -->\\nPipeline Story","user":{"login":"bot"}}]]'
    else
      printf '%s\\n' '[[{"id":501,"body":"requirement note","user":{"login":"owner"},"created_at":"2026-09-26T10:00:00Z","updated_at":"2026-09-26T10:00:00Z"}]]'
    fi
    ;;
  *"repos/gest0r1/sevami/issues/9/comments"*) echo '[[]]' ;;
  *"repos/gest0r1/sevami/issues/6/comments"*|*"repos/gest0r1/sevami/issues/7/comments"*|*"repos/gest0r1/sevami/issues/8/comments"*) echo '[[]]' ;;
  *"repos/gest0r1/sevami/issues/5"*)
    body="${ISSUE_BODY:-body five}"
    printf '{"number":5,"html_url":"https://github.com/gest0r1/sevami/issues/5","title":"Issue five","body":"%s","state":"open","updated_at":"2026-09-26T10:00:00Z"}\\n' "$body"
    ;;
  *"repos/gest0r1/sevami/issues/9"*) echo '{"number":9,"html_url":"https://github.com/gest0r1/sevami/issues/9","title":"Issue nine","body":"","state":"open"}' ;;
  *"repos/gest0r1/sevami/issues/6"*) echo '{"number":6,"title":"PR six","body":"","state":"open","pull_request":{"url":"x"}}' ;;
  *"repos/gest0r1/sevami/issues/7"*) echo '{"number":7,"title":"Closed seven","body":"","state":"closed"}' ;;
  *"repos/gest0r1/sevami/issues/8"*) echo 'HTTP 404' >&2; exit 1 ;;
  *) echo "unexpected gh args: $*" >&2; exit 2 ;;
esac
`);
  await chmod(path.join(bin, 'gh'), 0o755);
  return { root, bin, posted };
}

function run(root, bin, args, env = {}) {
  return spawnSync('npx', ['--yes', 'tsx', CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, POSTED_FILE: path.join(root, 'posted.txt'), ...env },
  });
}

test('probe reads live issues, deduplicates numbers and returns semantic digest', async () => {
  const { root, bin } = await fixture();
  const result = run(root, bin, ['probe', '5', '5', '9']);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.issue_numbers, [5, 9]);
  assert.equal(output.repository, 'gest0r1/sevami');
  assert.match(output.requirements_sha256, /^[0-9a-f]{64}$/);
  assert.equal(output.source_issues.length, 2);
});

test('semantic digest ignores pipeline audit/planning comments but detects human edits', async () => {
  const { root, bin } = await fixture();
  let result = run(root, bin, ['probe', '5']);
  assert.equal(result.status, 0, result.stderr);
  const base = JSON.parse(result.stdout).requirements_sha256;

  result = run(root, bin, ['probe', '5'], { PIPELINE_COMMENT: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).requirements_sha256, base);

  result = run(root, bin, ['probe', '5'], { PIPELINE_COMMENT: '1', ISSUE_BODY: 'human changed requirement' });
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(JSON.parse(result.stdout).requirements_sha256, base);
});

test('show reads live authoritative body and human comments', async () => {
  const { root, bin } = await fixture();
  const result = run(root, bin, ['show', '5'], { PIPELINE_COMMENT: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Issue #5/);
  assert.match(result.stdout, /body five/);
  assert.match(result.stdout, /requirement note/);
  assert.doesNotMatch(result.stdout, /Pipeline Story|Pipeline audit/);
});

test('probe blocks PRs, closed issues, lookup failures and missing auth', async () => {
  for (const [number, expected] of [['6', /pull request/], ['7', /not open/], ['8', /gh failed/]]) {
    const { root, bin } = await fixture();
    const result = run(root, bin, ['probe', number]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
  }
  const { root, bin } = await fixture();
  const auth = run(root, bin, ['probe', '5'], { GH_AUTH_FAIL: '1' });
  assert.notEqual(auth.status, 0);
  assert.match(auth.stderr, /GITHUB_AUTH_UNAVAILABLE/);
});

test('check rejects changed requirements and publish-plan posts frozen Story/Architecture once', async () => {
  const { root, bin, posted } = await fixture();
  let result = run(root, bin, ['probe', '5']);
  assert.equal(result.status, 0, result.stderr);
  const requirements = JSON.parse(result.stdout).requirements_sha256;
  const runRoot = path.join(root, '.tmp', 'pipelines', 'run-1');
  await mkdir(path.join(runRoot, 'stories'), { recursive: true });
  await mkdir(path.join(runRoot, 'planning'), { recursive: true });
  const story = '# Story\\nAC one\\n';
  const architecture = '# Architecture\\nTests and risks\\n';
  await writeFile(path.join(runRoot, 'stories', 'issue-5.md'), story);
  await writeFile(path.join(runRoot, 'planning', 'architecture.md'), architecture);
  await writeFile(path.join(runRoot, 'manifest.json'), JSON.stringify({
    schema_version: 2,
    run_id: 'run-1',
    source_type: 'github_issues',
    repository: 'gest0r1/sevami',
    source_issues: [{ repository: 'gest0r1/sevami', number: 5, url: 'x', title: 'Issue five' }],
    source_requirements_sha256: requirements,
    planning_readiness: {
      gates: {
        architecture: {
          required: true,
          status: 'ready',
          artifact: { path: 'planning/architecture.md', sha256: sha(architecture) },
        },
      },
    },
  }, null, 2));

  result = run(root, bin, ['check', 'run-1']);
  assert.equal(result.status, 0, result.stderr);
  result = run(root, bin, ['check', 'run-1'], { ISSUE_BODY: 'changed' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SOURCE_REQUIREMENTS_CHANGED/);

  result = run(root, bin, ['publish-plan', 'run-1']);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.published, 2);
  const postedText = await readFile(posted, 'utf8');
  assert.match(postedText, /pipeline-artifact:story:run-1:issue-5/);
  assert.match(postedText, /pipeline-artifact:architecture:run-1:issue-5/);
});
