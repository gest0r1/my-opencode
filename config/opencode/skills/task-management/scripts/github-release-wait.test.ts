import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  GitHubReleaseWaitError,
  classifyWorkflowRuns,
  parseGitHubReleaseTarget,
  waitForGitHubRelease,
} from './github-release-wait';

const SHA = 'a'.repeat(40);
const RELEASE_URL = `https://github.com/gest0r1/Otclick-hh/releases/download/install-${SHA}/manifest.json`;

async function fakeGh(payload: unknown): Promise<{ root: string; env: NodeJS.ProcessEnv }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'release-wait-'));
  const bin = path.join(root, 'bin');
  await mkdir(bin, { recursive: true });
  const gh = path.join(bin, 'gh');
  await writeFile(gh, `#!/usr/bin/env bash\ncat <<'JSON'\n${JSON.stringify(payload)}\nJSON\n`, 'utf8');
  await chmod(gh, 0o755);
  return { root, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` } };
}

test('release target is recognized only for the exact candidate SHA', () => {
  assert.deepEqual(parseGitHubReleaseTarget(['-fsSL', RELEASE_URL], SHA), {
    repo: 'gest0r1/Otclick-hh',
    url: RELEASE_URL,
  });
  assert.equal(parseGitHubReleaseTarget(['-fsSL', RELEASE_URL], 'b'.repeat(40)), undefined);
});

test('workflow classifier keeps active CI waiting and terminal failure failed', () => {
  assert.equal(classifyWorkflowRuns([
    { id: 1, workflow_id: 10, name: 'build', status: 'in_progress', conclusion: null },
  ]).state, 'waiting');
  assert.equal(classifyWorkflowRuns([
    { id: 2, workflow_id: 10, name: 'build', status: 'completed', conclusion: 'failure' },
  ]).state, 'failed');
  assert.equal(classifyWorkflowRuns([
    { id: 3, workflow_id: 10, name: 'build', status: 'completed', conclusion: 'success' },
  ]).state, 'success');
});

test('transient release 404 waits without owner interaction and retries the frozen curl', async () => {
  const fixture = await fakeGh({
    workflow_runs: [
      { id: 1, workflow_id: 10, name: 'Build incremental Linux install components', status: 'in_progress', conclusion: null },
    ],
  });
  let reruns = 0;
  const waited = await waitForGitHubRelease({
    candidateSha: SHA,
    executable: 'curl',
    args: ['-fsSL', RELEASE_URL],
    cwd: fixture.root,
    env: fixture.env,
    firstResult: { exit_code: 22, stdout: '', stderr: 'curl: (22) The requested URL returned error: 404' },
    rerun: async () => {
      reruns += 1;
      return { exit_code: 0, stdout: '{"ok":true}', stderr: '' };
    },
    timing: { intervalMs: 5, totalTimeoutMs: 500, ciStartGraceMs: 100, artifactGraceMs: 100 },
  });
  assert.ok(waited);
  assert.equal(reruns, 1);
  assert.equal(waited.result.exit_code, 0);
  assert.equal(waited.observations[0]?.ci_state, 'waiting');
});

test('failed producer CI stops immediately instead of polling 404 forever', async () => {
  const fixture = await fakeGh({
    workflow_runs: [
      { id: 2, workflow_id: 10, name: 'Build incremental Linux install components', status: 'completed', conclusion: 'failure' },
    ],
  });
  let reruns = 0;
  await assert.rejects(
    waitForGitHubRelease({
      candidateSha: SHA,
      executable: 'curl',
      args: ['-fsSL', RELEASE_URL],
      cwd: fixture.root,
      env: fixture.env,
      firstResult: { exit_code: 22, stdout: '', stderr: 'curl: (22) The requested URL returned error: 404' },
      rerun: async () => {
        reruns += 1;
        return { exit_code: 22, stdout: '', stderr: '404' };
      },
      timing: { intervalMs: 5, totalTimeoutMs: 500, ciStartGraceMs: 100, artifactGraceMs: 100 },
    }),
    (error: unknown) => error instanceof GitHubReleaseWaitError && error.classification === 'producer_failed',
  );
  assert.equal(reruns, 0);
});
