import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { migrateLegacyManifest } from './manifest-migration.mjs';
import { requirementsSha256ForSnapshot } from './source-requirements.mjs';

test('legacy RUN derives semantic hash only from authenticated frozen snapshot without rewriting manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-run-'));
  mkdirSync(join(root, 'sources'));
  const snapshot = { repository: 'owner/repo', issues: [{ repository: 'owner/repo', number: 7, title: 'story', body: 'requirements', state: 'open', comments: [] }] };
  const bytes = JSON.stringify(snapshot);
  const legacy = { schema_version: 2, source_type: 'github_issues', repository: 'owner/repo', source_issues: [{ number: 7 }], source_snapshot_sha256: createHash('sha256').update(bytes).digest('hex') };
  const manifestPath = join(root, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(legacy));
  writeFileSync(join(root, 'sources/github-issues.json'), bytes);
  const upgraded = migrateLegacyManifest(legacy, { manifestPath });
  assert.equal(upgraded.source_requirements_sha256, requirementsSha256ForSnapshot(snapshot));
  assert.equal(legacy.source_requirements_sha256, undefined);
  assert.equal(readFileSync(manifestPath, 'utf8'), JSON.stringify(legacy));
  assert.deepEqual(migrateLegacyManifest(upgraded, { manifestPath }), upgraded);
  assert.throws(() => migrateLegacyManifest({ ...legacy, source_snapshot_sha256: undefined }, { manifestPath }), /MANIFEST_MIGRATION_REQUIRED/);
  writeFileSync(join(root, 'sources/github-issues.json'), '{}');
  assert.throws(() => migrateLegacyManifest(legacy, { manifestPath }), /snapshot digest mismatch/);
  const outside = join(root, 'outside.json'); writeFileSync(outside, bytes);
  const other = mkdtempSync(join(tmpdir(), 'legacy-escape-')); mkdirSync(join(other, 'sources'));
  symlinkSync(outside, join(other, 'sources/github-issues.json'));
  assert.throws(() => migrateLegacyManifest(legacy, { manifestPath: join(other, 'manifest.json') }), /escapes/);
});

test('new RUN retains explicit hash and malformed explicit hashes are left for strict validation', () => {
  const current = { schema_version: 2, source_type: 'github_issues', source_requirements_sha256: 'a'.repeat(64) };
  assert.equal(migrateLegacyManifest(current), current);
  const invalid = { ...current, source_requirements_sha256: 'invalid' };
  assert.equal(migrateLegacyManifest(invalid), invalid);
});
