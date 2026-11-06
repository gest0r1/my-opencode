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

test('current service status requires exact running sha, never desired/history/requested mentions', async () => {
  const fx = await fixture();
  const state = path.join(fx.root, 'deploy-state');
  const previous = process.env.OPENCODE_DEPLOY_STATE_DIR;
  const wrong = 'b'.repeat(40);
  process.env.OPENCODE_DEPLOY_STATE_DIR = state;
  try {
    const { currentContourSha, verifyDeployedServiceGate } = await import('./dev-deploy-cli.ts');
    const status = { sha: SHA, version: 'dev' };
    await fx.install({}, status);
    assert.equal(fx.record().status, 0, 'record accepts top-level current sha');
    const input = { artifactRoot: path.join(fx.root, '.tmp/pipelines/run-1'),
      runId: 'run-1', pipelineId: 'sink', stage: 'dev', target: 'svd1',
      candidateSha: SHA, startedAt: fx.startedAt };
    assert.equal((await verifyDeployedServiceGate(input)).status, 'PASS');
    assert.equal(currentContourSha({ sha: SHA.toUpperCase() }), SHA);

    await fx.install({}, { sha: wrong, requested_sha: SHA, message: 'installed ' + SHA });
    assert.match(fx.record().stderr, /DEV_DEPLOY_STATUS_MISMATCH/);
    await assert.rejects(verifyDeployedServiceGate(input), /GATE_SERVICE_STATUS_MISMATCH/);

    await fx.install({}, { current: { sha: wrong }, requested_sha: SHA });
    assert.match(fx.record().stderr, /DEV_DEPLOY_STATUS_INVALID/);
    await assert.rejects(verifyDeployedServiceGate(input), /GATE_SERVICE_STATUS_CURRENT_SHA_MISSING/);

    await fx.install({}, { sha: SHA, current: { sha: wrong }, requested_sha: SHA });
    assert.match(fx.record().stderr, /GATE_SERVICE_STATUS_AMBIGUOUS_CURRENT/);
    await assert.rejects(verifyDeployedServiceGate(input), /GATE_SERVICE_STATUS_AMBIGUOUS_CURRENT/);

    await fx.install({}, { sha: SHA });
    await assert.rejects(verifyDeployedServiceGate({ ...input, target: 'svd2' }), /EVIDENCE_MISMATCH|missing/);
    await fx.install({}, { sha: SHA, current: { sha: SHA } });
    assert.equal(fx.record().status, 0);

    await fx.install({}, undefined);
    assert.match(fx.record().stderr, /DEV_DEPLOY_STATUS_MISSING/);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_DEPLOY_STATE_DIR;
    else process.env.OPENCODE_DEPLOY_STATE_DIR = previous;
    await rm(fx.root, { recursive: true, force: true });
  }
});
