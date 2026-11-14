// Source identity captured BEFORE the independent TestEngineer writes RED tests.
// Without it, the later CoderAgent baseline silently excludes those tests from --affected.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const identity = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const sha = value => typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
const hash = value => createHash('sha256').update(value).digest('hex');

export function testFirstBaselinePath(root, runId, pipelineId, stage, workItemId) {
  if (![runId, pipelineId, stage, workItemId].every(identity)) throw Error('TDD_BASELINE_IDENTITY_INVALID');
  const file = hash(JSON.stringify([pipelineId, stage, workItemId])).slice(0, 24);
  return join(resolve(root), '.tmp', 'pipelines', runId, 'checks', 'test-first', `${file}.json`);
}

export async function recordTestFirstBaseline(root, payload) {
  const { run_id, pipeline_id, stage, work_item_id, manifest_sha256, work_item_sha256, source_digest, files } = payload;
  if (![run_id, pipeline_id, stage, work_item_id].every(identity) ||
      !sha(manifest_sha256) || !sha(work_item_sha256) || !sha(source_digest) ||
      !files || typeof files !== 'object' || Array.isArray(files)) throw Error('TDD_RED_BASELINE_INVALID');
  const path = testFirstBaselinePath(root, run_id, pipeline_id, stage, work_item_id);
  try {
    const prior = JSON.parse(await readFile(path, 'utf8'));
    if (prior.run_id === run_id && prior.pipeline_id === pipeline_id && prior.stage === stage &&
        prior.work_item_id === work_item_id && prior.manifest_sha256 === manifest_sha256 &&
        prior.work_item_sha256 === work_item_sha256 && sha(prior.source_digest) && prior.files) return prior;
    throw Error('TDD_RED_BASELINE_IDENTITY_CHANGED');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const record = { run_id, pipeline_id, stage, work_item_id, manifest_sha256,
    work_item_sha256, source_digest, files, recorded_at: new Date().toISOString() };
  await mkdir(join(resolve(root), '.tmp', 'pipelines', run_id, 'checks', 'test-first'), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`);
  await rename(temp, path);
  return record;
}

export async function requireTestFirstBaseline(root, expected) {
  const path = testFirstBaselinePath(root, expected.run_id, expected.pipeline_id, expected.stage, expected.work_item_id);
  let found;
  try { found = JSON.parse(await readFile(path, 'utf8')); }
  catch { throw Error(`TDD_RED_BASELINE_MISSING: ${expected.work_item_id}; dispatch TestEngineer first`); }
  for (const field of ['run_id', 'pipeline_id', 'stage', 'work_item_id', 'manifest_sha256', 'work_item_sha256']) {
    if (found[field] !== expected[field]) throw Error(`TDD_RED_BASELINE_STALE: ${expected.work_item_id} ${field}`);
  }
  if (!sha(found.source_digest) || !found.files || typeof found.files !== 'object' || Array.isArray(found.files) ||
      Object.values(found.files).some(digest => !sha(digest))) {
    throw Error(`TDD_RED_BASELINE_INVALID: ${expected.work_item_id}`);
  }
  return found;
}
