import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyAgentAdvisoryCompletion } from './stage-complete-cli.ts';
import { sourceInventory, scopedInventoryDigest } from './gate-diagnostics.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const invoke = root => (exe, argv) => {
  const result = spawnSync(exe, argv, { cwd: root, shell: false, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  return Promise.resolve({ exit_code: result.status ?? 1, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? ''), truncated: false });
};

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stage-complete-'));
  spawnSync('git', ['init'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  await mkdir(path.join(root, 'src', 'a'), { recursive: true });
  await mkdir(path.join(root, 'src', 'b'), { recursive: true });
  await writeFile(path.join(root, 'src', 'a', 'a.ts'), 'export const a = 1;\n');
  await writeFile(path.join(root, 'src', 'b', 'b.ts'), 'export const b = 1;\n');
  spawnSync('git', ['add', 'src'], { cwd: root });
  spawnSync('git', ['commit', '-m', 'base'], { cwd: root });

  const runId = 'run-1';
  const runRoot = path.join(root, '.tmp', 'pipelines', runId);
  const workDir = path.join(runRoot, 'work-items');
  const baselineDir = path.join(runRoot, 'checks', 'baselines');
  await mkdir(workDir, { recursive: true });
  await mkdir(baselineDir, { recursive: true });

  const item = {
    id: 'wi-1', pipeline_id: 'app', stage: 'implementation', suggested_agent: 'CoderAgent',
    allowed_change_paths: ['src/a/**'],
  };
  const itemRaw = `${JSON.stringify(item, null, 2)}\n`;
  await writeFile(path.join(workDir, 'wi-1.json'), itemRaw);
  const manifest = {
    schema_version: 2,
    run_id: runId,
    pipelines: [{ id: 'app', stages: ['implementation'], executors: { implementation: 'agent' }, work_items: ['wi-1'], profile: 'local' }],
    work_items: [{ id: 'wi-1', pipeline_id: 'app', path: 'work-items/wi-1.json', sha256: sha(itemRaw) }],
    gate_profiles: { local: { tests: ['npm test'] } },
    gate_testing: { local: { tests: { impact_groups: [{ inputs: ['src/a/**'], command_index: 0 }] } } },
  };
  const manifestRaw = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestFile = path.join(runRoot, 'manifest.json');
  await writeFile(manifestFile, manifestRaw);
  await writeFile(path.join(runRoot, 'state.json'), JSON.stringify({ run_id: runId, manifest_file: manifestFile, manifest_sha256: sha(manifestRaw) }));
  return { root, runRoot, runId, manifest, manifestFile };
}

test('agent completion requires bound PASS and only invalidates on work-item scoped source changes', async () => {
  const fx = await fixture();
  const args = ['complete', fx.runId, 'implementation', '--pipeline', 'app'];
  await assert.rejects(verifyAgentAdvisoryCompletion(fx.root, args), /ADVISORY_DISPATCH_BASELINE_REQUIRED/);

  const baselineInventory = await sourceInventory(fx.root, invoke(fx.root));
  const baseline = {
    schema_version: 1, run_id: fx.runId, pipeline_id: 'app', stage: 'implementation', work_item_id: 'wi-1',
    manifest_sha256: sha(await (await import('node:fs/promises')).readFile(fx.manifestFile, 'utf8')),
    allowed_change_paths: ['src/a/**'], source_digest: baselineInventory.digest, files: baselineInventory.files,
  };
  const baselineRaw = `${JSON.stringify(baseline, null, 2)}\n`;
  const baselinePath = path.join(fx.runRoot, 'checks', 'baselines', 'wi-1.json');
  await writeFile(baselinePath, baselineRaw);

  await writeFile(path.join(fx.root, 'src', 'a', 'a.ts'), 'export const a = 2;\n');
  await assert.rejects(verifyAgentAdvisoryCompletion(fx.root, args), /ADVISORY_PASS_REQUIRED/);

  const current = await sourceInventory(fx.root, invoke(fx.root));
  const scoped = scopedInventoryDigest(current.files, ['src/a/**']);
  const evidence = {
    status: 'PASS', purpose: 'advisory', run_id: fx.runId, pipeline_id: 'app', gate: 'tests',
    work_item_id: 'wi-1', dispatch_stage: 'implementation', baseline_sha256: sha(baselineRaw),
    scoped_source_digest: scoped,
  };
  await writeFile(path.join(fx.runRoot, 'checks', 'app-tests-wi-1.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  assert.equal((await verifyAgentAdvisoryCompletion(fx.root, args)).checked, 1);

  await writeFile(path.join(fx.root, 'src', 'b', 'b.ts'), 'export const b = 2;\n');
  assert.equal((await verifyAgentAdvisoryCompletion(fx.root, args)).checked, 1);

  await writeFile(path.join(fx.root, 'src', 'a', 'a.ts'), 'export const a = 3;\n');
  await assert.rejects(verifyAgentAdvisoryCompletion(fx.root, args), /ADVISORY_EVIDENCE_STALE_SOURCE/);
});
