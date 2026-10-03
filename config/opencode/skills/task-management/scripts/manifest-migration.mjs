import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { requirementsSha256ForSnapshot } from './source-requirements.mjs';

// Effective-view migration: the original manifest and its frozen byte digest
// remain unchanged. Never obtain a missing historical hash from live GitHub.
export function migrateLegacyManifest(manifest, { manifestPath, cwd = process.cwd() } = {}) {
  if (manifest?.schema_version !== 2 || manifest.source_type !== 'github_issues' ||
      manifest.source_requirements_sha256 !== undefined) return manifest;
  const fail = reason => { throw new Error(`MANIFEST_MIGRATION_REQUIRED: source_requirements_sha256: ${reason}; restore the original frozen snapshot or create a reviewed replacement RUN`); };
  const root = manifestPath ? dirname(resolve(manifestPath)) : resolve(cwd, '.tmp/pipelines', String(manifest.run_id));
  const ref = manifest.source_snapshot_file ?? 'sources/github-issues.json';
  const frozen = manifest.source_snapshot_sha256;
  if (typeof ref !== 'string' || ref.startsWith('/') || ref.includes('\\') || ref.split('/').includes('..') ||
      !/^[0-9a-f]{64}$/i.test(String(frozen ?? ''))) fail('no authenticated snapshot reference');
  let bytes, snapshot;
  try {
    const file = realpathSync(resolve(root, ref));
    if (!file.startsWith(realpathSync(root) + sep)) fail('snapshot escapes RUN directory');
    bytes = readFileSync(file);
    if (createHash('sha256').update(bytes).digest('hex') !== frozen.toLowerCase()) fail('snapshot digest mismatch');
    snapshot = JSON.parse(bytes.toString('utf8'));
  } catch (error) { fail(`snapshot unavailable or invalid: ${error.message}`); }
  const expected = manifest.source_issues?.map(x => x.number);
  if (snapshot.repository !== manifest.repository || !Array.isArray(snapshot.issues) || !expected?.length ||
      JSON.stringify(snapshot.issues.map(x => x.number)) !== JSON.stringify(expected) ||
      snapshot.issues.some(x => x.repository !== manifest.repository || typeof x.title !== 'string' ||
        typeof x.body !== 'string' || typeof x.state !== 'string' || !Array.isArray(x.comments))) fail('snapshot identity/content does not match frozen source issues');
  return { ...manifest, source_requirements_sha256: requirementsSha256ForSnapshot(snapshot) };
}
