import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planProbeInputDigest, requirePlanProbeManifestPath } from './plan-probe-identity.mjs';

const head = 'a'.repeat(40), otherHead = 'b'.repeat(40);
const command = ['pnpm exec vitest run --config vitest.live.config.ts'];
const pg = { image: 'postgres:16@sha256:' + 'c'.repeat(64), command_indexes: [0],
  preflight_command: 'pnpm exec tsx scripts/testing/live-pg-preflight.ts --pipeline-preflight' };

test('PLAN live input digest freezes HEAD, gate command, image, indexes, cheap validator', () => {
  const original = planProbeInputDigest(command, pg, head);
  assert.match(original, /^[a-f0-9]{64}$/);
  assert.equal(planProbeInputDigest([...command], { ...pg }, head), original);
  for (const [nextCommands, nextPg, nextHead] of [
    [['pnpm exec vitest run other'], pg, head],
    [command, { ...pg, image: 'postgres:17@sha256:' + 'c'.repeat(64) }, head],
    [command, { ...pg, command_indexes: [1] }, head],
    [command, { ...pg, preflight_command: 'node scripts/check.mjs --pipeline-preflight' }, head],
    [command, pg, otherHead],
  ]) assert.notEqual(planProbeInputDigest(nextCommands, nextPg, nextHead), original);
  assert.throws(() => planProbeInputDigest(command, pg, 'bad'), /PLAN_PROBE_INPUT_INVALID/);
});

test('PLAN manifest must be the physical file of one run, not alias/foreign/symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'probe-path-'));
  try {
    const folder = join(root, '.tmp', 'pipelines', 'run-01');
    mkdirSync(folder, { recursive: true });
    const manifest = join(folder, 'manifest.json');
    writeFileSync(manifest, '{}');
    assert.equal(requirePlanProbeManifestPath(manifest, 'run-01'), manifest);
    assert.throws(() => requirePlanProbeManifestPath(manifest, 'other-run'), /OUT_OF_RUN/);
    assert.throws(() => requirePlanProbeManifestPath(manifest, '../run'), /RUN_ID_INVALID/);
    const alias = join(folder, 'alternate.json');
    symlinkSync(manifest, alias);
    assert.throws(() => requirePlanProbeManifestPath(alias, 'run-01'), /OUT_OF_RUN/);
    const linkedRun = join(root, '.tmp', 'pipelines', 'linked-run');
    symlinkSync(folder, linkedRun);
    assert.throws(() => requirePlanProbeManifestPath(join(linkedRun, 'manifest.json'), 'linked-run'), /SYMLINK_ESCAPE/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
