import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'dev-deploy-cli.ts');
const SHA = 'a'.repeat(40);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dev-deploy-'));
  const runDir = path.join(root, '.tmp/pipelines/run-1');
  const deployState = path.join(root, 'deploy-state');
  await mkdir(runDir, { recursive: true }); await mkdir(deployState);
  const manifestFile = path.join(runDir, 'manifest.json');
  await writeFile(manifestFile, JSON.stringify({ schema_version: 2, run_id: 'run-1', deploy_target: 'svd1',
    pipelines: [{ id: 'sink', stages: ['dev'], executors: { dev: 'dev_deploy' } }] }));
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  await writeFile(path.join(runDir, 'state.json'), JSON.stringify({ run_id: 'run-1', manifest_file: manifestFile,
    pipelines: { sink: { stages: { dev: { status: 'in_progress', started_at: startedAt } } } } }));
  await writeFile(path.join(runDir, 'candidate.json'), JSON.stringify({ status: 'PASS', candidate_sha: SHA, remote_sha: SHA }));
  const install = async (record, status) => {
    if (status !== undefined) await writeFile(path.join(deployState, 'svd1.status.json'), JSON.stringify(status));
    await writeFile(path.join(deployState, 'svd1.json'), JSON.stringify({ key: 'svd1', ref: SHA, sha: SHA, exit_code: 0,
      started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
      status_file: status === undefined ? null : path.join(deployState, 'svd1.status.json'), ...record }));
  };
  const record = () => spawnSync('npx', ['--yes', 'tsx', CLI, 'record', 'run-1', 'dev', '--pipeline', 'sink'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, OPENCODE_DEPLOY_STATE_DIR: deployState } });
  const evidence = async () => JSON.parse(await readFile(path.join(runDir, 'deploy/sink-dev.json'), 'utf8'));
  return { root, startedAt, install, record, evidence };
}

test('dev_deploy evidence proves the candidate itself was installed after the stage started', async () => {
  const fx = await fixture();
  try {
    let result = fx.record();
    assert.notEqual(result.status, 0); assert.match(result.stderr, /DEV_DEPLOY_NOT_RUN: .*sudo -n \/usr\/local\/sbin\/opencode-deploy-target svd1 a{40}/);
    assert.equal((await fx.evidence()).status, 'FAIL');

    await fx.install({ finished_at: new Date(Date.now() - 3_600_000).toISOString() });
    assert.match(fx.record().stderr, /DEV_DEPLOY_NOT_RUN/, 'an install before the stage started does not count');

    await fx.install({ sha: 'b'.repeat(40) });
    assert.match(fx.record().stderr, /DEV_DEPLOY_OTHER_COMMIT/);

    await fx.install({ exit_code: 3 });
    assert.match(fx.record().stderr, /DEV_DEPLOY_FAILED: the installer exited 3/);

    await fx.install({}, { version: '0.6.5', sha: 'c'.repeat(40) });
    assert.match(fx.record().stderr, /DEV_DEPLOY_STATUS_MISMATCH/);

    await fx.install({}, { version: '0.6.5', sha: SHA });
    result = fx.record();
    assert.equal(result.status, 0, result.stderr);
    const evidence = await fx.evidence();
    assert.equal(evidence.status, 'PASS'); assert.equal(evidence.candidate_sha, SHA);
    assert.deepEqual(evidence.contour_status, { version: '0.6.5', sha: SHA });
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});
