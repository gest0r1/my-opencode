import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertContextScoutPlanningPath } from './contextscout-path-check.mjs';

const RUN = 'plan-20261104';
const PREFIX = `.tmp/pipelines/${RUN}/planning/`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pipeline-contextscout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.tmp/pipelines', RUN, 'planning'), { recursive: true });
  return root;
}

test('accepts multiple current-run planning files, including nested drift/research', async t => {
  const root = await fixture(t);
  for (const file of ['context-packet.md', 'inventory.md', 'drift/delivery-and-phone.md', 'research/reuse/map.json']) {
    const result = await assertContextScoutPlanningPath({ root, runId: RUN, artifactPath: PREFIX + file });
    assert.equal(result.status, 'PASS');
    assert.equal(result.allowed_scope, PREFIX + '**');
  }
  await writeFile(join(root, PREFIX, 'inventory.md'), 'existing content');
  assert.equal((await assertContextScoutPlanningPath({ root, runId: RUN, artifactPath: PREFIX + 'inventory.md' })).status, 'PASS');
});

test('rejects traversal, absolute, foreign-run and non-planning destinations', async t => {
  const root = await fixture(t);
  for (const target of [
    '.tmp/pipelines/other/planning/inventory.md',
    '.tmp/pipelines/plan-20261104/state.json',
    '.tmp/pipelines/plan-20261104/manifest.json',
    '.tmp/pipelines/plan-20261104/gates/check.json',
    PREFIX + '../state.json',
    PREFIX + 'drift/../../state.json',
    PREFIX + './inventory.md',
    PREFIX + 'drift//inventory.md',
    PREFIX + '',
    '/tmp/other.md',
    'C:\\temp\\evil.md',
    PREFIX + 'drift\\file.md',
  ]) {
    await assert.rejects(
      assertContextScoutPlanningPath({ root, runId: RUN, artifactPath: target }),
      error => error.message.includes('CONTEXTSCOUT_PATH_DENIED') && error.message.includes(target) &&
        error.message.includes(PREFIX + '**'), target
    );
  }
  await assert.rejects(
    assertContextScoutPlanningPath({ root, runId: '..', artifactPath: PREFIX + 'inventory.md' }),
    /CONTEXTSCOUT_PATH_DENIED/
  );
});

test('does not authorize reserved machine-owned planning evidence', async t => {
  const root = await fixture(t);
  for (const file of [
    'revision.json', 'revisions.jsonl', 'review-ledger.json', 'source-requirements.json',
    'deployment-target.json', 'refresh-impact.json', 'probes/app-unit.json',
    'checks/tree.json', 'handoffs/child.json', 'gates/build.json',
    'state.json', 'manifest.json', '.env', 'drift/credentials.key', 'research/private.secret',
  ]) {
    await assert.rejects(
      assertContextScoutPlanningPath({ root, runId: RUN, artifactPath: PREFIX + file }),
      /machine-owned planning evidence/
    );
  }
});

test('rejects existing parent or destination symlinks and non-directory ancestors', async t => {
  const root = await fixture(t);
  const planning = join(root, '.tmp/pipelines', RUN, 'planning');
  await mkdir(join(root, 'elsewhere'));
  await symlink(join(root, 'elsewhere'), join(planning, 'drift'));
  await assert.rejects(
    assertContextScoutPlanningPath({ root, runId: RUN, artifactPath: PREFIX + 'drift/inventory.md' }),
    /symbolic link/
  );
  await symlink(join(root, 'elsewhere', 'not-there.md'), join(planning, 'link.md'));
  await assert.rejects(
    assertContextScoutPlanningPath({ root, runId: RUN, artifactPath: PREFIX + 'link.md' }),
    /symbolic link/
  );
  await writeFile(join(planning, 'plain.md'), 'x');
  await assert.rejects(
    assertContextScoutPlanningPath({ root, runId: RUN, artifactPath: PREFIX + 'plain.md/deeper.md' }),
    /non-directory parent/
  );
});
