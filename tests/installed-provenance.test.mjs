import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { sourceProvenance, verifyProvenance } from '../scripts/installed-provenance.mjs';

function withFixture(run) {
  const root = mkdtempSync(path.join(tmpdir(), 'v2-provenance-'));
  try {
    for (const item of ['plugins/pipeline-runtime.ts', 'commands/pipeline-run.md', 'agents/OpenStageOrchestrator.md', 'AGENTS.md']) {
      mkdirSync(path.dirname(path.join(root, item)), { recursive: true });
      writeFileSync(path.join(root, item), 'original ' + item);
    }
    return run(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test('round trip source to installed V2 checks exact file bytes', () => withFixture(root => {
  const record = sourceProvenance(root, {
    repository: 'gest0r1/my-opencode',
    revision: 'a'.repeat(40), release: '2.2.7', installedAt: '2026-11-16T00:00:00Z',
  });
  assert.equal(record.source_revision, 'a'.repeat(40));
  assert.equal(record.layout, 'opencode-v2-plural');
  assert.equal(verifyProvenance(root, record).status, 'verified');
  assert.ok(record.files.every(x => !path.isAbsolute(x.path)));
  writeFileSync(path.join(root, 'commands/pipeline-run.md'), 'changed');
  assert.equal(verifyProvenance(root, record).status, 'mismatch');
}));
test('unknown revision and legacy receipt never fabricate a source SHA', () => withFixture(root => {
  const record = sourceProvenance(root, { repository: 'gest0r1/my-opencode', revision: '/home/other/repo', release: '2.2.7' });
  assert.equal(record.source_revision, null);
  assert.equal(verifyProvenance(root, record).status, 'unknown');
  assert.equal(verifyProvenance(root, { schema_version: 1 }).status, 'unknown');
}));
test('stale and missing provenance files report nonzero verification status', () => withFixture(root => {
  const cli = path.resolve('scripts/installed-provenance.mjs');
  const missing = spawnSync(process.execPath, [cli, 'verify', root], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.match(missing.stdout, /"status":"unknown"/);
  const write = spawnSync(process.execPath, [cli, 'write', root, 'gest0r1/my-opencode', 'b'.repeat(40), '2.2.7'], { encoding: 'utf8' });
  assert.equal(write.status, 0, write.stderr);
  const record = JSON.parse(readFileSync(path.join(root, '.runtime-source.json')));
  assert.equal(record.provenance_status, 'verified-source-revision');
  assert.equal(spawnSync(process.execPath, [cli, 'verify', root]).status, 0);
}));

test('managed V2 files cannot disappear from provenance via symlink substitution', () => withFixture(root => {
  const record = sourceProvenance(root, { revision: 'c'.repeat(40), release: '2.2.7' });
  const file = path.join(root, 'commands/pipeline-run.md');
  unlinkSync(file);
  symlinkSync('/nonexistent/attacker/pipeline-run.md', file);
  assert.equal(verifyProvenance(root, record).status, 'mismatch');
  assert.throws(() => sourceProvenance(root, { revision: 'c'.repeat(40) }), /PROVENANCE_SYMLINK_NOT_ALLOWED/);
}));
