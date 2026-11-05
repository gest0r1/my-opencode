// Bind a generated build artifact to the existing local-gate PASS evidence.
// This module does not publish artifacts or introduce a second build runner.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const SHA256 = /^[0-9a-f]{64}$/;
const SHA40 = /^[0-9a-f]{40}$/i;

export function validArtifactPath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 512 &&
    !isAbsolute(path) && !path.includes('\\') && !/[\0\r\n*?\[\]{}]/.test(path) &&
    path.split('/').every(part => part && part !== '.' && part !== '..' && part !== '.git' && part !== '.tmp');
}

export async function artifactDigest(root, path) {
  if (!validArtifactPath(path)) throw new Error('BUILD_OUTPUT_PATH_INVALID');
  const rootReal = await realpath(root);
  const location = resolve(rootReal, path);
  const real = await realpath(location).catch(() => { throw new Error('BUILD_OUTPUT_MISSING: ' + path); });
  const rel = relative(rootReal, real);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw new Error('BUILD_OUTPUT_PATH_ESCAPE: ' + path);
  }
  const info = await lstat(location);
  if (!info.isFile()) throw new Error('BUILD_OUTPUT_NOT_REGULAR: ' + path);
  // A symlink may be overwritten externally; require an ordinary file.
  const hash = createHash('sha256');
  let bytes = 0;
  await new Promise((done, fail) => {
    const stream = createReadStream(location);
    stream.on('data', chunk => { bytes += chunk.length; hash.update(chunk); });
    stream.on('end', done);
    stream.on('error', fail);
  });
  // Detect replaced file identity while its bytes were streamed.
  const after = await lstat(location);
  if (info.ino !== after.ino || info.dev !== after.dev || info.size !== after.size || info.mtimeMs !== after.mtimeMs) {
    throw new Error('BUILD_OUTPUT_CHANGED_DURING_HASH: ' + path);
  }
  return { path, sha256: hash.digest('hex'), bytes };
}

export function outputProof({ runId, pipelineId, gate, manifestSha, sourceDigest, artifact }) {
  if (!runId || !pipelineId || !gate || !SHA256.test(manifestSha ?? '') ||
      !SHA256.test(sourceDigest ?? '') || !validArtifactPath(artifact?.path) ||
      !SHA256.test(artifact?.sha256 ?? '') || !Number.isSafeInteger(artifact?.bytes) || artifact.bytes < 0) {
    throw new Error('BUILD_OUTPUT_PRODUCER_INVALID');
  }
  return { schema_version: 1, run_id: runId, pipeline_id: pipelineId,
    producer_gate: gate, manifest_sha256: manifestSha, source_digest: sourceDigest,
    artifact };
}

export async function verifyOutputProof({ cwd, evidencePath, runId, pipelineId, producerGate, manifestSha, sourceDigest, artifactPath }) {
  const raw = await readFile(evidencePath, 'utf8').catch(() => { throw new Error('BUILD_OUTPUT_PROOF_MISSING'); });
  let evidence;
  try { evidence = JSON.parse(raw); } catch { throw new Error('BUILD_OUTPUT_PROOF_INVALID_JSON'); }
  const proof = evidence?.build_output;
  if (evidence?.status !== 'PASS' || evidence?.purpose !== 'authoritative' ||
      evidence?.run_id !== runId || evidence?.pipeline_id !== pipelineId || evidence?.gate !== producerGate ||
      evidence?.manifest_sha256 !== manifestSha || evidence?.source_digest !== sourceDigest ||
      proof?.schema_version !== 1 || proof?.run_id !== runId || proof?.pipeline_id !== pipelineId ||
      proof?.producer_gate !== producerGate || proof?.manifest_sha256 !== manifestSha ||
      proof?.source_digest !== sourceDigest || proof?.artifact?.path !== artifactPath ||
      !SHA256.test(proof?.artifact?.sha256 ?? '') || !Number.isSafeInteger(proof?.artifact?.bytes)) {
    throw new Error('BUILD_OUTPUT_PROOF_IDENTITY_MISMATCH');
  }
  const current = await artifactDigest(cwd, artifactPath);
  if (current.sha256 !== proof.artifact.sha256 || current.bytes !== proof.artifact.bytes) {
    throw new Error('BUILD_OUTPUT_ARTIFACT_CHANGED');
  }
  return proof;
}
