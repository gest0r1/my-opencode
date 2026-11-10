import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeHandover, checkHandover, snapshotHandover } from './pipeline-handover.mjs';

const sha = s => createHash('sha256').update(s).digest('hex');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pipeline-handover-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const runId = 'handover-test';
  const stateRoot = join(root, '.tmp/pipelines');
  const runRoot = join(stateRoot, runId);
  await mkdir(runRoot, { recursive: true });
  const manifestRaw = JSON.stringify({ run_id: runId, pipelines: [{ id: 'app' }] }) + '\n';
  const manifestFile = join(runRoot, 'manifest.json');
  await writeFile(manifestFile, manifestRaw);
  const state = {
    run_id: runId, status: 'in_progress', manifest_file: manifestFile,
    manifest_sha256: sha(manifestRaw),
    pipelines: { app: { id: 'app', status: 'in_progress', stage_order: ['implementation', 'code-review'],
      stages: { implementation: { status: 'completed' },
        'code-review': { status: 'in_progress', technical_fix_cycles: 2, technical_fix_limit: 5 } } } },
    owner_amendments: [],
  };
  const stateFile = join(runRoot, 'state.json');
  await writeFile(stateFile, JSON.stringify(state) + '\n');
  return { root, runId, stateRoot, runRoot, stateFile, state };
}

test('handover is a small machine-state index, not a second scheduler or decision', async t => {
  const fx = await fixture(t);
  await writeFile(join(fx.runRoot, 'session-registry.json'), JSON.stringify([
    { pipeline_id: 'app', stage: 'implementation', work_item_id: 'WI1', status: 'healthy' },
    { pipeline_id: 'app', stage: 'code-review', work_item_id: 'review', role: 'CodeReviewer', status: 'background' },
  ]));
  const result = await writeHandover(fx.stateRoot, fx.runId, fx.root);
  assert.equal(result.status, 'PASS');
  const saved = JSON.parse(await readFile(result.snapshot_path, 'utf8'));
  assert.equal(saved.run_id, fx.runId);
  assert.equal(saved.manifest_sha256, fx.state.manifest_sha256);
  assert.equal(saved.pipelines[0].stages[1].fix_cycles, 2);
  assert.equal(saved.active_workers.length, 1);
  assert.match(saved.next_action, /^stage-cli next/);
  assert.equal(saved.state_source.includes('NOT permission'), true);
  assert.equal((await checkHandover(fx.stateRoot, fx.runId, fx.root)).status, 'PASS');
  assert.match(await readFile(result.summary_path, 'utf8'), /implementation: completed/);
});

test('resume marks old handover stale without treating it as authority', async t => {
  const fx = await fixture(t);
  assert.equal((await checkHandover(fx.stateRoot, fx.runId, fx.root)).status, 'MISSING');
  await writeHandover(fx.stateRoot, fx.runId, fx.root);
  fx.state.pipelines.app.stages['code-review'].technical_fix_cycles = 3;
  await writeFile(fx.stateFile, JSON.stringify(fx.state) + '\n');
  const stale = await checkHandover(fx.stateRoot, fx.runId, fx.root);
  assert.equal(stale.status, 'STALE');
  assert.equal(stale.machine_state_authoritative, true);
  await writeHandover(fx.stateRoot, fx.runId, fx.root);
  assert.equal((await checkHandover(fx.stateRoot, fx.runId, fx.root)).status, 'PASS');
});

test('invalid frozen manifest digest cannot produce an apparently authoritative handover', async t => {
  const fx = await fixture(t);
  fx.state.manifest_sha256 = 'f'.repeat(64);
  await writeFile(fx.stateFile, JSON.stringify(fx.state) + '\n');
  await assert.rejects(snapshotHandover(fx.stateRoot, fx.runId, fx.root), /HANDOVER_FROZEN_MANIFEST_CHANGED/);
  await assert.rejects(writeHandover(fx.stateRoot, fx.runId, fx.root), /HANDOVER_FROZEN_MANIFEST_CHANGED/);
});
