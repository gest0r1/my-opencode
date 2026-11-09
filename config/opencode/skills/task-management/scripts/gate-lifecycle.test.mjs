import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runLifecycleCommand, validateLifecycle, verifyLifecycleHandoff } from './gate-lifecycle.mjs';

const commandFresh = 'bash scripts/testing/release-parity.sh fresh-install';
const commandUpgrade = 'bash scripts/testing/release-parity.sh upgrade-install';
const commands = [commandFresh, commandUpgrade];
const candidateSha = 'a'.repeat(40);
const descriptor = () => ({
  schema_version: 1,
  producer: 'bash scripts/testing/release-contour.sh',
  handoff_schema: 'example.release-contour/v2',
  recipe_digest: 'b'.repeat(64),
  exclusive_lock: 'unit-test-' + randomUUID(),
  commands: [{ command: commandFresh, operation: 'fresh' }, { command: commandUpgrade, operation: 'upgrade' }],
});
const identity = { runId: 'release-unit', pipelineId: 'delivery', gate: 'install-check',
  attempt: 1, candidateSha, frozenCommands: commands };
const arg = (args, flag) => args[args.indexOf(flag) + 1];

function fixture(options = {}) {
  const calls = [];
  const observed = [];
  let currentRef = null;
  const runInvocation = async (_exe, args) => {
    const action = args[1];
    calls.push(action);
    if (action === 'reap') return { exit_code: 0 };
    if (action === 'heartbeat') return { exit_code: options.heartbeatFails ? 2 : 0, stderr: 'LIFECYCLE_HEARTBEAT_FAILED: simulated' };
    if (action === 'down') return { exit_code: options.cleanupFails ? 1 : 0, stderr: 'OWNED_DOWN_FAILED: simulated' };
    if (action !== 'provision') throw Error('unexpected action');
    if (options.refuse) return { exit_code: 3, stderr: 'DEV_CONTOUR_RUNNING: operator must stop dev' };
    currentRef = arg(args, '--handoff-ref');
    const handoff = {
      schema: 'example.release-contour/v2', runId: arg(args, '--run-id'),
      pipelineId: arg(args, '--pipeline-id'), gate: arg(args, '--gate'),
      attempt: Number(arg(args, '--attempt')), candidateSha: arg(args, '--candidate-sha'),
      operation: arg(args, '--operation'), nonce: arg(args, '--nonce'), recipeDigest: arg(args, '--recipe-digest'),
      expiresAt: new Date(Date.now() + (options.expired ? -10000 : options.shortLived ? 15 : 600000)).toISOString(),
    };
    if (options.wrongCandidate) handoff.candidateSha = 'c'.repeat(40);
    await writeFile(currentRef, JSON.stringify(handoff), { mode: 0o600 });
    if (options.worldReadable) await chmod(currentRef, 0o644);
    return { exit_code: 0 };
  };
  const executeGate = async (env) => {
    observed.push(env);
    if (options.gateDelayMs) await new Promise(resolve => setTimeout(resolve, options.gateDelayMs));
    if (options.changeHandoff) await writeFile(currentRef, '{}', { mode: 0o600 });
    if (options.gateThrows) throw Error('simulated child failure');
    return { exit_code: options.gateFails ? 1 : 0, result: { exit_code: options.gateFails ? 1 : 0 } };
  };
  return { calls, observed, runInvocation, executeGate };
}

async function runOne(t, options = {}, command = commandFresh, desc = descriptor()) {
  const root = await mkdtemp(join(os.tmpdir(), 'lifecycle-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scratchDir = join(root, 'scratch', 'delivery-install-check-1');
  await mkdir(scratchDir, { recursive: true });
  const fx = fixture(options);
  const evidence = [];
  const run = () => runLifecycleCommand({
    descriptor: desc, frozenCommand: command, identity, scratchDir, cwd: root,
    runInvocation: fx.runInvocation, executeGate: fx.executeGate,
    onEvidence: item => evidence.push(item), heartbeatIntervalMs: options.heartbeatIntervalMs ?? 30000,
  });
  return { ...fx, run, evidence };
}

test('descriptor rejects unknown hook, changed command identity, and shell injection', () => {
  const invalid = descriptor();
  invalid.producer = 'bash scripts/testing/release-contour.sh; echo hacked';
  assert.throws(() => validateLifecycle(invalid, commands), /LIFECYCLE_DESCRIPTOR_INVALID/);
  invalid.producer = 'bash scripts/testing/release-contour.sh';
  invalid.commands[1].command = commandFresh;
  assert.throws(() => validateLifecycle(invalid, commands), /LIFECYCLE_DESCRIPTOR_INVALID/);
  invalid.commands[1].command = commandUpgrade;
  invalid.unknown = true;
  assert.throws(() => validateLifecycle(invalid, commands), /LIFECYCLE_DESCRIPTOR_INVALID/);
});

test('handoff identity and expiration are checked against frozen descriptor', () => {
  const record = {
    schema: 'example.release-contour/v2', ...identity, operation: 'fresh',
    nonce: 'nonce', recipeDigest: descriptor().recipe_digest,
    expiresAt: new Date(Date.now() + 10000).toISOString(),
  };
  assert.match(verifyLifecycleHandoff(JSON.stringify(record), record, descriptor()), /^[0-9a-f]{64}$/);
  assert.throws(() => verifyLifecycleHandoff(JSON.stringify({ ...record, expiresAt: '2020-01-01T00:00:00Z' }), record, descriptor()), /LIFECYCLE_HANDOFF_INVALID/);
  assert.throws(() => verifyLifecycleHandoff(JSON.stringify({ ...record, candidateSha: 'c'.repeat(40) }), record, descriptor()), /LIFECYCLE_HANDOFF_INVALID/);
});

test('provision -> gate with bound ref and digest -> down, no generic second run', async t => {
  const fx = await runOne(t);
  const { evidence } = await fx.run();
  assert.deepEqual(fx.calls, ['reap', 'provision', 'down']);
  assert.equal(fx.observed.length, 1);
  assert.match(fx.observed[0].RELEASE_PARITY_CONTOUR_REF, /lifecycle-handoff\.json$/);
  assert.match(fx.observed[0].RELEASE_PARITY_CONTOUR_EXPECTED_SHA256, /^[0-9a-f]{64}$/);
  assert.equal(evidence.cleanup_complete, true);
  assert.equal(evidence.status, 'PASS');
});

test('gate failure still triggers owned down and records FAIL', async t => {
  const fx = await runOne(t, { gateFails: true });
  const { evidence } = await fx.run();
  assert.equal(evidence.status, 'FAIL');
  assert.equal(evidence.cleanup_complete, true);
  assert.deepEqual(fx.calls, ['reap', 'provision', 'down']);
});

test('cleanup failure blocks an otherwise successful gate', async t => {
  const fx = await runOne(t, { cleanupFails: true });
  await assert.rejects(fx.run(), /LIFECYCLE_CLEANUP_FAILED/);
  assert.equal(fx.evidence.at(-1).status, 'BLOCKED');
  assert.equal(fx.evidence.at(-1).cleanup_complete, false);
});

test('a refusal is surfaced, gate is never run and no retry occurs', async t => {
  const fx = await runOne(t, { refuse: true });
  await assert.rejects(fx.run(), /DEV_CONTOUR_RUNNING/);
  assert.deepEqual(fx.calls, ['reap', 'provision', 'down']);
  assert.equal(fx.observed.length, 0);
});

test('expired, foreign, world-readable and changed handoffs block', async t => {
  for (const options of [{ expired: true }, { wrongCandidate: true }, { worldReadable: true }, { changeHandoff: true }]) {
    const fx = await runOne(t, options);
    await assert.rejects(fx.run(), /LIFECYCLE_HANDOFF_(INVALID|CHANGED)/);
    assert.equal(fx.calls.at(-1), 'down');
  }
});

test('a gate throw still tears down the lease', async t => {
  const fx = await runOne(t, { gateThrows: true });
  await assert.rejects(fx.run(), /simulated child failure/);
  assert.equal(fx.evidence.at(-1).cleanup_complete, true);
});

test('two commands in the SAME attempt use different handoff and lease paths', async t => {
  const root = await mkdtemp(join(os.tmpdir(), 'lifecycle-shared-attempt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scratchDir = join(root, 'scratch', 'delivery-install-check-1');
  await mkdir(scratchDir, { recursive: true });
  const fx = fixture();
  const desc = descriptor();
  const common = { descriptor: desc, identity, scratchDir, cwd: root,
    runInvocation: fx.runInvocation, executeGate: fx.executeGate };
  await runLifecycleCommand({ ...common, frozenCommand: commandFresh });
  await runLifecycleCommand({ ...common, frozenCommand: commandUpgrade });
  assert.notEqual(fx.observed[0].RELEASE_PARITY_CONTOUR_REF, fx.observed[1].RELEASE_PARITY_CONTOUR_REF);
  assert.deepEqual(fx.calls, ['reap', 'provision', 'down', 'reap', 'provision', 'down']);
});


test('heartbeat failure blocks result but never suppresses down', async t => {
  const fx = await runOne(t, { heartbeatFails: true, gateDelayMs: 35, heartbeatIntervalMs: 5 });
  await assert.rejects(fx.run(), /LIFECYCLE_HEARTBEAT_FAILED/);
  assert.equal(fx.calls.at(-1), 'down', 'teardown must run even when periodic heartbeat failed');
  assert.equal(fx.evidence.at(-1).cleanup_complete, true);
  assert.equal(fx.evidence.at(-1).status, 'BLOCKED');
});


test('handoff that expires while the gate is running cannot attest PASS', async t => {
  const fx = await runOne(t, { shortLived: true, gateDelayMs: 40 });
  await assert.rejects(fx.run(), /LIFECYCLE_HANDOFF_INVALID/);
  assert.equal(fx.calls.at(-1), 'down');
});


test('restarted supervisor can reuse the attempt number without colliding with an orphan lease file', async t => {
  const root = await mkdtemp(join(os.tmpdir(), 'lifecycle-replay-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scratchDir = join(root, 'scratch', 'same-attempt');
  await mkdir(scratchDir, { recursive: true });
  const fx = fixture();
  const common = { descriptor: descriptor(), frozenCommand: commandFresh, identity, scratchDir,
    cwd: root, runInvocation: fx.runInvocation, executeGate: fx.executeGate };
  await runLifecycleCommand(common);
  // The prior lease file is retained for recovery/audit, as after an interrupted attempt.
  await runLifecycleCommand(common);
  assert.notEqual(fx.observed[0].RELEASE_PARITY_CONTOUR_REF, fx.observed[1].RELEASE_PARITY_CONTOUR_REF);
  assert.deepEqual(fx.calls, ['reap', 'provision', 'down', 'reap', 'provision', 'down']);
});
