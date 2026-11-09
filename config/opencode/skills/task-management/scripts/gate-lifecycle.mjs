// Generic, frozen repository lifecycle hook for candidate-contour gates.
// Infrastructure ownership, credential admission and survivor reclamation belong to the repository producer.
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, isAbsolute, sep } from 'node:path';
import os from 'node:os';
import { acquireLockFiles } from './runtime-locks.mjs';
import { tokenizeGateCommand } from './gate-command-policy.mjs';

const SHA = /^[0-9a-f]{40}$/i;
const DIGEST = /^[0-9a-f]{64}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SCHEMA = /^[A-Za-z][A-Za-z0-9._/-]{1,127}$/;
const sha256 = value => createHash('sha256').update(value).digest('hex');

function reject(message) { throw new Error('LIFECYCLE_DESCRIPTOR_INVALID: ' + message); }
function plainObject(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value, allowed, label) {
  if (!plainObject(value) || Object.keys(value).some(key => !allowed.includes(key))) reject(label);
}
function safeScript(value) {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.startsWith('-') &&
    !value.includes('\\') && !/[\x00-\x1f*?\[\]{}]/.test(value) &&
    !value.split('/').some(part => part === '..' || part === '.git' || !part);
}
export function lifecycleProducerTokens(command) {
  let argv;
  try { argv = tokenizeGateCommand(command); } catch { reject('producer command cannot use shell composition'); }
  if (argv.length === 2 && argv[0] === 'bash' && safeScript(argv[1]) && argv[1].endsWith('.sh')) return argv;
  if (argv.length === 2 && argv[0] === 'node' && safeScript(argv[1]) && /\.(mjs|js)$/.test(argv[1])) return argv;
  if (argv.length === 4 && argv[0] === 'node' && argv[1] === '--import' && argv[2] === 'tsx' &&
      safeScript(argv[3]) && argv[3].endsWith('.ts')) return argv;
  reject('producer must be one exact repository-local bash/node entry without arbitrary arguments');
}
export function validateLifecycle(config, commands) {
  exactKeys(config, ['schema_version', 'producer', 'handoff_schema', 'recipe_digest', 'exclusive_lock', 'commands'], 'unknown keys');
  if (config.schema_version !== 1 || typeof config.producer !== 'string' || !SCHEMA.test(config.handoff_schema ?? '') ||
      !DIGEST.test(config.recipe_digest ?? '') || !ID.test(config.exclusive_lock ?? '') ||
      !Array.isArray(config.commands) || config.commands.length !== commands.length ||
      new Set(commands).size !== commands.length) reject('version, schema, recipe, lock or command cardinality');
  lifecycleProducerTokens(config.producer);
  const seen = new Set();
  for (const item of config.commands) {
    exactKeys(item, ['command', 'operation'], 'command mapping');
    if (typeof item.command !== 'string' || !commands.includes(item.command) || seen.has(item.command) ||
        !['fresh', 'upgrade'].includes(item.operation)) reject('operation must bind a unique frozen command identity');
    seen.add(item.command);
  }
}
async function protectedFile(path, { contents = true } = {}) {
  if (!isAbsolute(path)) throw new Error('LIFECYCLE_HANDOFF_INVALID: reference must be absolute');
  if (!Number.isInteger(constants.O_NOFOLLOW)) throw new Error('LIFECYCLE_HANDOFF_INVALID: O_NOFOLLOW is required');
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && info.uid !== process.getuid()) ||
        (contents && info.size > 1024 * 1024)) {
      throw new Error('unsafe contour reference');
    }
    return contents ? await handle.readFile('utf8') : null;
  } catch {
    throw new Error('LIFECYCLE_HANDOFF_INVALID: reference missing, unsafe or unreadable');
  } finally { await handle?.close(); }
}
export function verifyLifecycleHandoff(raw, identity, descriptor) {
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error('LIFECYCLE_HANDOFF_INVALID: JSON'); }
  if (!plainObject(data) || data.schema !== descriptor.handoff_schema ||
      data.runId !== identity.runId || data.pipelineId !== identity.pipelineId ||
      data.gate !== identity.gate || data.attempt !== identity.attempt ||
      data.candidateSha !== identity.candidateSha || data.operation !== identity.operation ||
      data.nonce !== identity.nonce || data.recipeDigest !== descriptor.recipe_digest ||
      !SHA.test(data.candidateSha ?? '') ||
      typeof data.expiresAt !== 'string' || !Number.isFinite(Date.parse(data.expiresAt)) ||
      Date.parse(data.expiresAt) <= Date.now()) {
    throw new Error('LIFECYCLE_HANDOFF_INVALID: foreign, expired or inconsistent contour');
  }
  return sha256(raw);
}
async function protectedReference(path) {
  try { await protectedFile(path, { contents: false }); } catch { throw new Error('LIFECYCLE_INCIDENT_COPY_INVALID: protected reference required'); }
}
const shortError = result => {
  // Only an explicit leading machine refusal code may cross the producer boundary; never log its raw output.
  const first = (result?.stderr ?? '').split(/\r?\n/)[0].trim();
  return /^[A-Z][A-Z0-9_]{2,63}(?::|$)/.test(first) ? first.split(':')[0] : 'LIFECYCLE_PRODUCER_FAILED';
};

export async function runLifecycleCommand({
  descriptor, frozenCommand, identity, scratchDir, cwd, runInvocation, executeGate, onEvidence,
  timeoutSeconds = 1800,
}) {
  validateLifecycle(descriptor, identity.frozenCommands);
  const binding = descriptor.commands.find(entry => entry.command === frozenCommand);
  if (!binding) reject('unknown command identity');
  const operation = binding.operation;
  const nonce = randomBytes(24).toString('hex');
  const attemptId = { runId: identity.runId, pipelineId: identity.pipelineId, gate: identity.gate,
    attempt: identity.attempt, candidateSha: identity.candidateSha, operation, nonce };
  const producer = lifecycleProducerTokens(descriptor.producer);
  const attemptRoot = resolve(scratchDir);
  if (!isAbsolute(scratchDir) || !attemptRoot.includes(sep + 'scratch' + sep)) {
    throw new Error('LIFECYCLE_SCRATCH_INVALID: expected runner-owned attempt directory');
  }
  // Multiple frozen commands share one gate attempt but must never share their lease or handoff.
  const root = join(attemptRoot, 'lifecycle-' + sha256(frozenCommand).slice(0, 16));
  const handoffRef = join(root, 'lifecycle-handoff.json');
  const leaseRef = join(root, 'lifecycle-lease.json');
  const incidentCopy = process.env.RELEASE_PARITY_INCIDENT_COPY;
  if (incidentCopy) await protectedReference(incidentCopy);
  const lockDir = join(os.homedir(), '.cache', 'opencode-pipeline', 'lifecycle-locks');
  const lock = await acquireLockFiles(lockDir, [{
    file: sha256(descriptor.exclusive_lock) + '.lock',
    record: { lock: descriptor.exclusive_lock, run_id: identity.runId, pipeline_id: identity.pipelineId, gate: identity.gate },
  }]);
  const evidence = { command: frozenCommand, operation, attempt: identity.attempt, recipe_digest: descriptor.recipe_digest,
    status: 'BLOCKED', handoff_sha256: null, cleanup_complete: false, reap: null };
  let error;
  let gateResult;
  let pulse;
  let heartbeatPromise = Promise.resolve();
  let leaseCreated = false;
  const producerCall = async (action, argv, cleanup = false) => {
    const result = await runInvocation(producer[0], [...producer.slice(1), action, ...argv], cwd,
      { PIPELINE_RUN_ID: identity.runId, PIPELINE_ID: identity.pipelineId, PIPELINE_GATE: identity.gate,
        PIPELINE_GATE_ATTEMPT: String(identity.attempt), CANDIDATE_SHA: identity.candidateSha,
        PIPELINE_SCRATCH_DIR: root, PIPELINE_LIFECYCLE_NONCE: nonce, PIPELINE_LIFECYCLE_RECIPE_SHA256: descriptor.recipe_digest,
        RELEASE_PARITY_CONTOUR_REF: undefined, RELEASE_PARITY_CONTOUR_EXPECTED_SHA256: undefined },
      action === 'provision' ? timeoutSeconds : 180, cleanup);
    if (result.exit_code !== 0) throw new Error(shortError(result) + ': ' + action + ' refused');
    return result;
  };
  try {
    // Reap is producer-owned: it must never destroy an unexpired, live holder.
    await producerCall('reap', ['--expired'], true);
    evidence.reap = 'PASS';
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(leaseRef, JSON.stringify({ schema: 'opencode.lifecycle-lease/v1',
      runId: identity.runId, pipelineId: identity.pipelineId, gate: identity.gate,
      attempt: identity.attempt, candidateSha: identity.candidateSha, operation, nonce,
      recipeDigest: descriptor.recipe_digest, pid: process.pid, createdAt: new Date().toISOString() }) + '\n',
      { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    leaseCreated = true;
    await producerCall('provision', [
      '--operation', operation, '--handoff-ref', handoffRef, '--lease-ref', leaseRef,
      '--run-id', identity.runId, '--pipeline-id', identity.pipelineId, '--gate', identity.gate,
      '--attempt', String(identity.attempt), '--candidate-sha', identity.candidateSha,
      '--nonce', nonce, '--recipe-digest', descriptor.recipe_digest,
    ]);
    const raw = await protectedFile(handoffRef);
    evidence.handoff_sha256 = verifyLifecycleHandoff(raw, attemptId, descriptor);
    pulse = setInterval(() => {
      heartbeatPromise = heartbeatPromise.then(async () => {
        await producerCall('heartbeat', ['--lease-ref', leaseRef], true);
        await producerCall('reap', ['--expired'], true);
      });
      heartbeatPromise.catch(() => undefined);
    }, 30000);
    gateResult = await executeGate({
      PIPELINE_SCRATCH_DIR: root,
      RELEASE_PARITY_CONTOUR_REF: handoffRef,
      RELEASE_PARITY_CONTOUR_EXPECTED_SHA256: evidence.handoff_sha256,
      PIPELINE_LIFECYCLE_HANDOFF_SHA256: evidence.handoff_sha256,
    });
    await heartbeatPromise;
    const after = await protectedFile(handoffRef);
    if (sha256(after) !== evidence.handoff_sha256) {
      throw new Error('LIFECYCLE_HANDOFF_CHANGED: contour changed during verification');
    }
    // Time-bound identity must remain valid until the gate has finished.
    verifyLifecycleHandoff(after, attemptId, descriptor);
    // A PASS is only final after a successful owned-only teardown.
    evidence.status = gateResult.exit_code === 0 ? 'PASS' : 'FAIL';
  } catch (failure) { error = failure; }
  finally {
    if (pulse) clearInterval(pulse);
    try {
      await heartbeatPromise;
      // Down is mandatory whenever the lease exists, even if provision itself failed.
      // A refusal during startup reap has allocated nothing and must retain its original error code.
      if (leaseCreated) await producerCall('down', ['--lease-ref', leaseRef], true);
      evidence.cleanup_complete = true;
    } catch (cleanupError) {
      evidence.cleanup_complete = false;
      evidence.status = 'BLOCKED';
      error = new Error('LIFECYCLE_CLEANUP_FAILED: ' + String(cleanupError instanceof Error ? cleanupError.message : cleanupError));
    }
    try { await lock.release(); }
    finally { onEvidence?.(evidence); }
  }
  if (error) throw error;
  return { gateResult, evidence };
}
