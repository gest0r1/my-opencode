import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configFingerprint, checkGeneration } from '../scripts/opencode-generation-state.mjs';

test('fingerprint covers managed source and installer code while unrelated commits are no-op', () => {
  const entry = { path: 'config/opencode/opencode.json', type: 'blob', mode: '100644', sha: 'a'.repeat(40) };
  const base = { tree: [entry] };
  assert.equal(configFingerprint(base), configFingerprint({ tree: [entry, { ...entry, path: 'README.md' }] }));
  assert.notEqual(configFingerprint(base), configFingerprint({ tree: [{ ...entry, sha: 'b'.repeat(40) }] }));
  assert.notEqual(configFingerprint(base), configFingerprint({ tree: [entry, { ...entry, path: 'scripts/install-opencode-generation.sh' }] }));
  assert.throws(() => configFingerprint({ ...base, truncated: true }), /Incomplete/);
});
test('receipt detects managed content/mode drift, missing files and different home without owning user files', () => {
  const home = mkdtempSync(join(tmpdir(), 'generation-receipt-'));
  mkdirSync(join(home, '.config/opencode'), { recursive: true });
  const file = join(home, '.config/opencode/opencode.json'), receipt = join(home, 'receipt.json');
  writeFileSync(file, '{}'); chmodSync(file, 0o600);
  writeFileSync(receipt, JSON.stringify({ schema_version: 1, repo: 'owner/repo', fingerprint: 'test', home, files: [{ path: '.config/opencode/opencode.json', sha256: createHash('sha256').update('{}').digest('hex'), mode: 0o600 }] }));
  assert.equal(checkGeneration(receipt, 'owner/repo', 'test', home), true);
  writeFileSync(join(home, '.config/opencode/custom.md'), 'owner content');
  assert.equal(checkGeneration(receipt, 'owner/repo', 'test', home), true);
  assert.equal(checkGeneration(receipt, 'owner/repo', 'changed', home), false);
  chmodSync(file, 0o644); assert.equal(checkGeneration(receipt, 'owner/repo', 'test', home), false);
  chmodSync(file, 0o600); writeFileSync(file, '{"changed":true}'); assert.equal(checkGeneration(receipt, 'owner/repo', 'test', home), false);
});
