import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { artifactDigest, outputProof, validArtifactPath, verifyOutputProof } from './build-output-proof.mjs';

const ID = 'b'.repeat(64);
const manifest = 'a'.repeat(64);

test('build-output evidence proves exact source/run/producer/path/bytes and rejects stale output', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'build-output-'));
  try {
    await mkdir(join(cwd, 'dist'));
    const file = 'dist/bundle.tgz';
    const evidencePath = join(cwd, 'gate-evidence.json');
    await writeFile(join(cwd, file), 'first-artifact\n');
    const artifact = await artifactDigest(cwd, file);
    const proof = outputProof({ runId: 'run', pipelineId: 'app', gate: 'assemble',
      manifestSha: manifest, sourceDigest: ID, artifact });
    const evidence = { status: 'PASS', purpose: 'authoritative', run_id: 'run', pipeline_id: 'app',
      gate: 'assemble', manifest_sha256: manifest, source_digest: ID, build_output: proof };
    await writeFile(evidencePath, JSON.stringify(evidence));
    const input = { cwd, evidencePath, runId: 'run', pipelineId: 'app',
      producerGate: 'assemble', manifestSha: manifest, sourceDigest: ID, artifactPath: file };
    assert.deepEqual(await verifyOutputProof(input), proof);
    await assert.rejects(verifyOutputProof({ ...input, pipelineId: 'other' }), /IDENTITY_MISMATCH/);
    await assert.rejects(verifyOutputProof({ ...input, sourceDigest: 'c'.repeat(64) }), /IDENTITY_MISMATCH/);
    await assert.rejects(verifyOutputProof({ ...input, producerGate: 'different' }), /IDENTITY_MISMATCH/);
    await writeFile(join(cwd, file), 'different-artifact\n');
    await assert.rejects(verifyOutputProof(input), /ARTIFACT_CHANGED/);
    evidence.status = 'FAIL';
    await writeFile(evidencePath, JSON.stringify(evidence));
    await assert.rejects(verifyOutputProof(input), /IDENTITY_MISMATCH/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('artifact proof rejects outside paths, symlinks and missing regular outputs', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'build-output-path-'));
  const external = await mkdtemp(join(tmpdir(), 'build-output-external-'));
  try {
    await mkdir(join(cwd, 'dist'));
    await writeFile(join(external, 'outside.tgz'), 'outside');
    await symlink(join(external, 'outside.tgz'), join(cwd, 'dist/link.tgz'));
    for (const file of ['../outside.tgz', '/tmp/outside.tgz', '.tmp/outside', 'dist/../outside', '']) {
      assert.equal(validArtifactPath(file), false);
    }
    await assert.rejects(artifactDigest(cwd, 'dist/link.tgz'), /PATH_ESCAPE/);
    await assert.rejects(artifactDigest(cwd, 'dist/missing.tgz'), /MISSING/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});
