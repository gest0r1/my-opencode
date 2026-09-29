import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'github-pr-cli.ts');
const SHA = '1111111111111111111111111111111111111111';

async function fixture({ existing = false, status = 'completed', deployable = false, validationSha = SHA } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'github-pr-cli-'));
  const bin = path.join(root, 'bin');
  const runDir = path.join(root, '.tmp', 'pipelines', 'run-1');
  await mkdir(bin);
  await mkdir(runDir, { recursive: true });

  const manifestFile = path.join(runDir, 'manifest.json');
  await writeFile(manifestFile, JSON.stringify({
    schema_version: 2,
    run_id: 'run-1',
    pipelines: [{
      id: 'api',
      deployable,
      stages: deployable ? ['tests'] : [],
      executors: deployable ? { tests: 'github_ci' } : {},
      ...(deployable ? {
        deployment_validation: { stage: 'tests', fresh_job: 'fresh-install', upgrade_job: 'upgrade-install' },
      } : {}),
    }],
  }, null, 2));

  if (deployable) {
    await mkdir(path.join(runDir, 'github'), { recursive: true });
    await writeFile(path.join(runDir, 'github', 'api-tests.json'), JSON.stringify({
      status: 'PASS',
      candidate_sha: validationSha,
    }, null, 2));
  }

  await writeFile(path.join(runDir, 'state.json'), JSON.stringify({
    schema_version: 1,
    run_id: 'run-1',
    source_type: 'github_issues',
    repository: 'gest0r1/sevami',
    manifest_file: manifestFile,
    source_issues: [
      { repository: 'gest0r1/sevami', number: 5, url: 'https://github.com/gest0r1/sevami/issues/5', title: 'five' },
      { repository: 'gest0r1/sevami', number: 6, url: 'https://github.com/gest0r1/sevami/issues/6', title: 'six' },
    ],
    status,
    rules_file: 'docs/pipeline-rules.md',
    rules_version: 2,
    rules_sha256: 'x',
    created_at: '2026-09-26T10:00:00Z',
    updated_at: '2026-09-26T10:00:00Z',
    pipelines: {
      api: {
        id: 'api',
        status: status === 'completed' ? 'completed' : status,
        stages: {},
        stage_order: [],
        depends_on: [],
        issue_numbers: [6, 5],
      },
    },
    issue_results: [
      { repository: 'gest0r1/sevami', number: 5, status: 'pending' },
      { repository: 'gest0r1/sevami', number: 6, status: 'pending' },
    ],
    github_outbox: [],
    history: [],
  }, null, 2));

  await writeFile(path.join(runDir, 'candidate.json'), JSON.stringify({
    status: 'PASS',
    branch: 'feature/run-1',
    candidate_sha: SHA,
    remote_sha: SHA,
  }, null, 2));

  const git = path.join(bin, 'git');
  await writeFile(git, `#!/bin/sh
if [ "$*" = "remote get-url origin" ]; then
  echo "https://github.com/gest0r1/sevami.git"
  exit 0
fi
echo "unexpected git args: $*" >&2
exit 2
`);
  await chmod(git, 0o755);

  const gh = path.join(bin, 'gh');
  await writeFile(gh, `#!/bin/sh
echo "$*" >> "$GH_LOG"
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  if [ "\${EXISTING_PR:-0}" = "1" ]; then
    echo '[{"number":77,"title":"Human title","body":"Human notes","headRefName":"feature/run-1","baseRefName":"main","url":"https://github.com/gest0r1/sevami/pull/77"}]'
  else
    echo '[]'
  fi
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  cat > "$PR_BODY"
  echo "https://github.com/gest0r1/sevami/pull/42"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "edit" ]; then
  cat > "$PR_BODY"
  echo "https://github.com/gest0r1/sevami/pull/77"
  exit 0
fi
case "$*" in
  *"api --paginate repos/gest0r1/sevami/issues/"*"--jq .[].body"*)
    exit 0
    ;;
  *"api --method POST repos/gest0r1/sevami/issues/"*)
    echo '{}' 
    exit 0
    ;;
esac
echo "unexpected gh args: $*" >&2
exit 2
`);
  await chmod(gh, 0o755);

  const ghLog = path.join(root, 'gh.log');
  const prBody = path.join(root, 'pr-body.md');
  return { root, bin, ghLog, prBody, existing };
}

function run(f, extraEnv = {}) {
  return spawnSync('npx', ['--yes', 'tsx', CLI, 'create', 'run-1'], {
    cwd: f.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${f.bin}:${process.env.PATH}`,
      GH_LOG: f.ghLog,
      PR_BODY: f.prBody,
      EXISTING_PR: f.existing ? '1' : '0',
      ...extraEnv,
    },
  });
}

test('creates one PR to main with closing keywords from frozen completed issue mapping', async () => {
  const f = await fixture();
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.pr_number, 42);
  assert.deepEqual(output.issue_numbers, [5, 6]);
  assert.equal(output.merged, false);

  const body = await readFile(f.prBody, 'utf8');
  assert.match(body, /Closes #5/);
  assert.match(body, /Closes #6/);
  assert.match(body, /Run: `run-1`/);
  assert.match(body, new RegExp(SHA));

  const log = await readFile(f.ghLog, 'utf8');
  assert.match(log, /pr create .*--base main .*--head feature\/run-1/);
  assert.doesNotMatch(log, /pr merge/);

  const state = JSON.parse(
    await readFile(path.join(f.root, '.tmp', 'pipelines', 'run-1', 'state.json'), 'utf8'),
  );
  assert.deepEqual(state.issue_results.map((item) => [item.number, item.status, item.pr_number]), [
    [5, 'done', 42],
    [6, 'done', 42],
  ]);
  const event = state.github_outbox.find((item) => item.kind === 'pr_link');
  assert.equal(event.pr_number, 42);
  assert.deepEqual(event.delivered_issue_numbers.sort((a, b) => a - b), [5, 6]);
});

test('updates the managed block on an existing branch PR without overwriting human body text', async () => {
  const f = await fixture({ existing: true });
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.pr_number, 77);

  const body = await readFile(f.prBody, 'utf8');
  assert.match(body, /^Human notes/);
  assert.match(body, /<!-- pipeline-github:start -->/);
  assert.match(body, /Closes #5/);
  assert.match(body, /Closes #6/);

  const log = await readFile(f.ghLog, 'utf8');
  assert.match(log, /pr edit 77/);
  assert.doesNotMatch(log, /pr create/);
  assert.doesNotMatch(log, /pr merge/);
});

test('blocks PR creation until the run is completed', async () => {
  const f = await fixture({ status: 'in_progress' });
  const result = run(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /run must be completed before PR creation/);
  await assert.rejects(readFile(f.ghLog, 'utf8'));
});

test('blocks PR when deployable validation belongs to an older candidate SHA', async () => {
  const f = await fixture({ deployable: true, validationSha: '2'.repeat(40) });
  const result = run(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FINAL_CANDIDATE_VALIDATION_REQUIRED/);
  await assert.rejects(readFile(f.ghLog, 'utf8'));
});

test('allows PR when deployable validation matches the final cumulative candidate SHA', async () => {
  const f = await fixture({ deployable: true, validationSha: SHA });
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.candidate_sha, SHA);
});

