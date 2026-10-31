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
  [[ "\${GH_AUTH_FAIL:-0}" != 1 ]]
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
    if [[ "\${MOCK_ARTIFACT_COMMENTS:-}" != '' ]]; then
      node -e '
        const extra = JSON.parse(process.env.MOCK_ARTIFACT_COMMENTS);
        const req = { id: 501, body: "requirement note", user: { login: "owner" },
          created_at: "2026-09-26T10:00:00Z", updated_at: "2026-09-26T10:00:00Z" };
        process.stdout.write(JSON.stringify([[req, ...extra.map((body, n) => ({
          id: 600 + n, body, user: { login: "bot" },
        }))]]));
      '
    elif [[ "\${PIPELINE_COMMENT:-0}" == 1 ]]; then
      printf '%s\\n' '[[{"id":501,"body":"requirement note","user":{"login":"owner"},"created_at":"2026-09-26T10:00:00Z","updated_at":"2026-09-26T10:00:00Z"},{"id":502,"body":"<!-- pipeline-event:test:issue-5 -->\\nPipeline audit","user":{"login":"bot"}},{"id":503,"body":"<!-- pipeline-artifact:story:run-1:issue-5 -->\\nPipeline Story","user":{"login":"bot"}}]]'
    else
      printf '%s\\n' '[[{"id":501,"body":"requirement note","user":{"login":"owner"},"created_at":"2026-09-26T10:00:00Z","updated_at":"2026-09-26T10:00:00Z"}]]'
    fi
    ;;
  *"repos/gest0r1/sevami/issues/9/comments"*) echo '[[]]' ;;
  *"repos/gest0r1/sevami/issues/6/comments"*|*"repos/gest0r1/sevami/issues/7/comments"*|*"repos/gest0r1/sevami/issues/8/comments"*) echo '[[]]' ;;
  *"repos/gest0r1/sevami/issues/5"*)
    body="\${ISSUE_BODY:-body five}"
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
  assert.ok(postedText.includes('pipeline-artifact:story:run-1:issue-5:sha-' + sha(story)));
  assert.ok(postedText.includes('pipeline-artifact:architecture:run-1:issue-5:sha-' + sha(architecture)));
});

test('a long Markdown document splits on sections into balanced pieces that fit one comment', async () => {
  const { splitMarkdown, MAX_COMMENT_CHARS } = await import('./github-issue-cli.ts');
  assert.ok(MAX_COMMENT_CHARS > 60_000 && MAX_COMMENT_CHARS <= 65_536);
  const section = (n) => `## Раздел ${n}\n\n${'Архитектурное решение. '.repeat(400)}\n`;
  const doc = `# Архитектура\n\n${Array.from({ length: 12 }, (_, i) => section(i + 1)).join('\n')}`;
  const parts = splitMarkdown(doc, 30_000);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.length <= 30_000));
  // Sections are kept whole when they fit: every part after the first starts at a heading.
  assert.ok(parts.slice(1).every((part) => part.startsWith('## Раздел')));
  assert.equal(parts.join('').replace(/\s/g, '').length, doc.replace(/\s/g, '').length);
  // A code block cut in two is closed and reopened, so each part renders on its own.
  const code = `## Код\n\n\`\`\`ts\n${'const x = 1;\n'.repeat(4000)}\`\`\`\n`;
  for (const part of splitMarkdown(code, 20_000)) assert.equal((part.match(/^```/gm) ?? []).length % 2, 0);
});

test('publish-plan posts a long Cyrillic architecture as numbered comments under the GitHub size limit', async () => {
  const { root, bin, posted } = await fixture();
  let result = run(root, bin, ['probe', '5']);
  assert.equal(result.status, 0, result.stderr);
  const requirements = JSON.parse(result.stdout).requirements_sha256;
  const runRoot = path.join(root, '.tmp', 'pipelines', 'run-1');
  await mkdir(path.join(runRoot, 'planning'), { recursive: true });
  // ~100 000 characters: twice the old byte limit for Cyrillic text.
  const architecture = `# Архитектура\n\n${Array.from({ length: 10 }, (_, i) => `## Раздел ${i + 1}\n\n${'Решение по компоненту и рискам. '.repeat(300)}\n`).join('\n')}`;
  await writeFile(path.join(runRoot, 'planning', 'architecture.md'), architecture);
  await writeFile(path.join(runRoot, 'manifest.json'), JSON.stringify({
    schema_version: 2, run_id: 'run-1', source_type: 'github_issues', repository: 'gest0r1/sevami',
    source_issues: [{ repository: 'gest0r1/sevami', number: 5, url: 'x', title: 'Issue five' }],
    source_requirements_sha256: requirements,
    planning_readiness: { gates: { architecture: { required: true, status: 'ready',
      artifact: { path: 'planning/architecture.md', sha256: sha(architecture) } } } },
  }, null, 2));
  result = run(root, bin, ['publish-plan', 'run-1']);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.published, 2);
  const postedText = await readFile(posted, 'utf8');
  assert.ok(postedText.includes('pipeline-artifact:architecture:run-1:issue-5:sha-' + sha(architecture) + ':part-1-of-2'));
  assert.ok(postedText.includes('pipeline-artifact:architecture:run-1:issue-5:sha-' + sha(architecture) + ':part-2-of-2'));
  assert.match(postedText, /Pipeline Architecture \(2\/2\)/);
  for (const body of postedText.split(/(?=api --method POST)/).filter(Boolean)) assert.ok(body.length < 65_536);
});


test('publish-plan SHA idempotence, version replacement and old comments', async () => {
  const { root, bin } = await fixture();
  const probe = run(root, bin, ['probe', '5']);
  assert.equal(probe.status, 0, probe.stderr);
  const runRoot = path.join(root, '.tmp', 'pipelines', 'run-1');
  await mkdir(path.join(runRoot, 'stories'), { recursive: true });
  await mkdir(path.join(runRoot, 'planning'), { recursive: true });
  const story = '# Original Story\nAC 1\n', architecture = '# Architecture\nData model\n';
  await writeFile(path.join(runRoot, 'stories', 'issue-5.md'), story);
  await writeFile(path.join(runRoot, 'planning', 'architecture.md'), architecture);
  await writeFile(path.join(runRoot, 'manifest.json'), JSON.stringify({
    schema_version: 2, run_id: 'run-1', source_type: 'github_issues', repository: 'gest0r1/sevami',
    source_issues: [{ number: 5 }], source_requirements_sha256: JSON.parse(probe.stdout).requirements_sha256,
    planning_readiness: { gates: { architecture: { artifact: { path: 'planning/architecture.md',
      sha256: sha(architecture) } } } },
  }));
  const marker = (kind, digest) => '<!-- pipeline-artifact:' + kind + ':run-1:issue-5:sha-' + digest + ' -->';
  const current = [marker('story', sha(story)), marker('architecture', sha(architecture))];
  let r = run(root, bin, ['publish-plan', 'run-1'], { MOCK_ARTIFACT_COMMENTS: JSON.stringify(current) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).published, 0);
  assert.equal(JSON.parse(r.stdout).existing, 2);
  await writeFile(path.join(runRoot, 'stories', 'issue-5.md'), '# Updated Story\nAC 2\n');
  r = run(root, bin, ['publish-plan', 'run-1'], { MOCK_ARTIFACT_COMMENTS: JSON.stringify(current) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).published, 1);
  assert.equal(JSON.parse(r.stdout).existing, 1);
  const legacy = ['<!-- pipeline-artifact:story:run-1:issue-5 -->',
    '<!-- pipeline-artifact:architecture:run-1:issue-5 -->'];
  r = run(root, bin, ['publish-plan', 'run-1'], { MOCK_ARTIFACT_COMMENTS: JSON.stringify(legacy) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).published, 2);
  const source = run(root, bin, ['probe', '5'], { MOCK_ARTIFACT_COMMENTS: JSON.stringify(current) });
  assert.equal(source.status, 0, source.stderr);
  assert.equal(JSON.parse(source.stdout).requirements_sha256, JSON.parse(probe.stdout).requirements_sha256);
});

test('publish-plan supports Story-only and technical-only plans', async () => {
  const { root, bin } = await fixture();
  const probe = run(root, bin, ['probe', '5']);
  assert.equal(probe.status, 0, probe.stderr);
  const runRoot = path.join(root, '.tmp', 'pipelines', 'run-1');
  await mkdir(runRoot, { recursive: true });
  await writeFile(path.join(runRoot, 'manifest.json'), JSON.stringify({
    schema_version: 2, run_id: 'run-1', source_type: 'github_issues', repository: 'gest0r1/sevami',
    source_issues: [{ number: 5 }], source_requirements_sha256: JSON.parse(probe.stdout).requirements_sha256,
    planning_readiness: { gates: {} },
  }));
  let r = run(root, bin, ['publish-plan', 'run-1']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).published, 0);
  await mkdir(path.join(runRoot, 'stories'), { recursive: true });
  await writeFile(path.join(runRoot, 'stories', 'issue-5.md'), '# Story\nAC\n');
  r = run(root, bin, ['publish-plan', 'run-1']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).published, 1);
});

test('milestone lists its open issues, takes the version from its name and blocks an unusable version', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'github-issue-milestone-'));
  const bin = path.join(root, 'bin'); await mkdir(bin);
  const git = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const remote = path.join(root, 'remote.git'); const work = path.join(root, 'work');
  git(root, 'init', '--bare', '-b', 'main', remote); await mkdir(work);
  git(work, 'init', '-b', 'main'); git(work, 'config', 'user.email', 't@example.invalid'); git(work, 'config', 'user.name', 'T');
  await writeFile(path.join(work, 'VERSION'), '0.6.4\n'); git(work, 'add', '.'); git(work, 'commit', '-m', 'base');
  git(work, 'tag', 'v0.6.4'); git(work, 'remote', 'add', 'origin', remote); git(work, 'push', '-q', 'origin', 'main', '--tags');
  // The CLI reads the repository from origin's github.com URL; every other git call reaches the local remote.
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  await writeFile(path.join(bin, 'git'), `#!/bin/sh\nif [ "$*" = "remote get-url origin" ]; then echo git@github.com:o/r.git; exit 0; fi\nexec ${realGit} "$@"\n`);
  await chmod(path.join(bin, 'git'), 0o755);
  await writeFile(path.join(bin, 'gh'), `#!/bin/bash
if [[ "$1" == auth ]]; then exit 0; fi
case "$*" in
  *milestones*) echo '[[{"number":7,"title":"v.0.6.5"},{"number":6,"title":"v.0.6.4"},{"number":5,"title":"next"}]]' ;;
  *milestone=7*) echo '[[{"number":12,"title":"b"},{"number":11,"title":"a"},{"number":13,"title":"pr","pull_request":{}}]]' ;;
  *milestone=6*) echo '[[{"number":20,"title":"c"}]]' ;;
  *milestone=5*) echo '[[{"number":21,"title":"d"}]]' ;;
  *) exit 2 ;;
esac
`);
  await chmod(path.join(bin, 'gh'), 0o755);
  const milestone = (name) => spawnSync('npx', ['--yes', 'tsx', CLI, 'milestone', name], { cwd: work, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });

  let result = milestone('v.0.6.5');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  let out = JSON.parse(result.stdout);
  assert.equal(out.version, '0.6.5');
  assert.deepEqual(out.issue_numbers, [11, 12]);
  assert.deepEqual(out.conflicts, []);

  result = milestone('6');
  assert.equal(result.status, 1);
  out = JSON.parse(result.stdout);
  assert.equal(out.status, 'BLOCKED');
  assert.deepEqual(out.conflicts, ['VERSION_TAGGED: tag v0.6.4 already exists', 'VERSION_BEHIND_MAIN: main VERSION is 0.6.4, milestone asks for 0.6.4']);

  out = JSON.parse(milestone('next').stdout);
  assert.match(out.conflicts[0], /^MILESTONE_NOT_SEMVER/);
});
