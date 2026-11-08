import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { recoverStageLock } from './stage-lock-cli.ts';

test('stale stage lock is recovered, absent lock is idempotent, live lock is preserved', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stage-lock-'));
  const runId = 'run-1';
  const dir = path.join(root, runId);
  await mkdir(dir, {recursive:true});
  try {
    await writeFile(path.join(dir,'.lock'), '2147483647\n');
    const recovered = await recoverStageLock(root, runId);
    assert.equal(recovered.status, 'RECOVERED');
    assert.equal(recovered.pid, 2147483647);
    await assert.rejects(readFile(path.join(dir,'.lock'),'utf8'), error => error?.code === 'ENOENT');
    assert.equal((await recoverStageLock(root, runId)).status, 'ABSENT');

    await writeFile(path.join(dir,'.lock'), `${process.pid}\n`);
    await assert.rejects(recoverStageLock(root, runId), /LOCK_ACTIVE/);
    assert.equal((await readFile(path.join(dir,'.lock'),'utf8')).trim(), String(process.pid));
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test('stale recovery guard from a crashed recovery process is reclaimed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stage-lock-'));
  const runId = 'run-recovery';
  const dir = path.join(root, runId);
  await mkdir(dir,{recursive:true});
  try {
    await writeFile(path.join(dir,'.lock.recover'),'2147483646\n');
    await writeFile(path.join(dir,'.lock'),'2147483647\n');
    const recovered = await recoverStageLock(root, runId);
    assert.equal(recovered.status, 'RECOVERED');
    await assert.rejects(readFile(path.join(dir,'.lock.recover'),'utf8'), error => error?.code === 'ENOENT');
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test('malformed lock and recovery guard fail closed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stage-lock-'));
  const lockDir = path.join(root, 'run-2');
  const guardDir = path.join(root, 'run-3');
  await mkdir(lockDir,{recursive:true});
  await mkdir(guardDir,{recursive:true});
  try {
    await writeFile(path.join(lockDir,'.lock'),'not-a-pid\n');
    await assert.rejects(recoverStageLock(root,'run-2'), /LOCK_INVALID/);
    assert.equal((await readFile(path.join(lockDir,'.lock'),'utf8')).trim(),'not-a-pid');

    await writeFile(path.join(guardDir,'.lock.recover'),'not-a-pid\n');
    await assert.rejects(recoverStageLock(root,'run-3'), /LOCK_RECOVERY_INVALID/);
    assert.equal((await readFile(path.join(guardDir,'.lock.recover'),'utf8')).trim(),'not-a-pid');
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test('runtime lock of a dead owner is reclaimed, a live owner keeps it', async () => {
  const { openRuntimeLock } = await import('./runtime-locks.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'runtime-lock-'));
  const file = path.join(root, 'target.lock');
  try {
    await writeFile(file, JSON.stringify({ lock: 'dev', run_id: 'old', pid: 2147483647 }));
    const handle = await openRuntimeLock(file);
    await handle.writeFile(JSON.stringify({ lock: 'dev', run_id: 'new', pid: process.pid }));
    await handle.close();
    assert.equal(JSON.parse(await readFile(file, 'utf8')).run_id, 'new');

    await assert.rejects(openRuntimeLock(file), error => error?.code === 'EEXIST');
    assert.equal(JSON.parse(await readFile(file, 'utf8')).pid, process.pid);

    await writeFile(file, 'not json');
    await assert.rejects(openRuntimeLock(file), error => error?.code === 'EEXIST');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a lock record with the right pid but another start time is a reused pid; the matching start time is alive', async t => {
  const { acquireLockFiles, processAlive, processStartTime } = await import('./runtime-locks.mjs');
  const { runningGates } = await import('./orchestrator-wake.mjs');
  const start = processStartTime(process.pid);
  if (process.platform !== 'linux') { t.skip('requires Linux procfs start times'); return; }
  const procSelfPid = Number((await readFile('/proc/self/stat', 'utf8')).split(' ', 1)[0]);
  if (procSelfPid !== process.pid) { t.skip('procfs belongs to a different PID namespace'); return; }
  assert.match(start, /^\d+$/);
  assert.equal(processAlive(process.pid, start), true);
  assert.equal(processAlive(process.pid, undefined), true);
  assert.equal(processAlive(process.pid, `${start}1`), false);
  const root = await mkdtemp(path.join(os.tmpdir(), 'pid-reuse-'));
  const locks = path.join(root, '.gate-locks');
  try {
    await mkdir(locks, { recursive: true });
    await writeFile(path.join(locks, 'a.lock'), JSON.stringify({ run_id: 'r', pid: process.pid, pid_start: start }));
    await writeFile(path.join(locks, 'b.lock'), JSON.stringify({ run_id: 'r', pid: process.pid, pid_start: `${start}1` }));
    await writeFile(path.join(locks, 'c.lock'), JSON.stringify({ run_id: 'r', pid: process.pid }));
    assert.equal(runningGates(root, 'r'), 2);
    const lane = await acquireLockFiles(locks, [{ file: 'b.lock', record: { run_id: 'new' } }], { pollMs: 5, maxWaitMs: 200 });
    const record = JSON.parse(await readFile(path.join(locks, 'b.lock'), 'utf8'));
    assert.equal(record.run_id, 'new');
    assert.equal(record.pid_start, start);
    await lane.release();
    await assert.rejects(acquireLockFiles(locks, [{ file: 'a.lock', record: { run_id: 'new' } }], { pollMs: 5, maxWaitMs: 50 }), /LOCK_WAIT_TIMEOUT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the heavy gate slot admits one full set at a time and narrow checks wait for it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'heavy-slot-'));
  const previous = process.env.PIPELINE_HEAVY_LOCK_DIR;
  process.env.PIPELINE_HEAVY_LOCK_DIR = root;
  try {
    const { acquireHeavySlot, waitForHeavySlot } = await import('./runtime-locks.mjs');
    assert.equal(await waitForHeavySlot({ pollMs: 10 }), 0);
    const first = await acquireHeavySlot({ gate: 'a' }, { pollMs: 10 });
    let secondAcquired = false;
    const second = acquireHeavySlot({ gate: 'b' }, { pollMs: 10 }).then((slot) => { secondAcquired = true; return slot; });
    const narrow = waitForHeavySlot({ pollMs: 10 });
    await new Promise((done) => setTimeout(done, 50));
    assert.equal(secondAcquired, false);
    await first.release();
    const slot = await second;
    assert.ok(slot.waited_ms >= 40);
    await slot.release();
    assert.ok(await narrow >= 40);
    await assert.rejects(acquireHeavySlot({ gate: 'c' }, { pollMs: 10 }).then(async (held) => {
      try { await acquireHeavySlot({ gate: 'd' }, { pollMs: 10, maxWaitMs: 30 }); } finally { await held.release(); }
    }), /HEAVY_GATE_SLOT_TIMEOUT/);
  } finally {
    if (previous === undefined) delete process.env.PIPELINE_HEAVY_LOCK_DIR; else process.env.PIPELINE_HEAVY_LOCK_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('lane gate locks and the live slot queue a second holder instead of failing it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lock-queue-'));
  const previous = process.env.PIPELINE_HEAVY_LOCK_DIR;
  process.env.PIPELINE_HEAVY_LOCK_DIR = root;
  try {
    const { acquireLockFiles, acquireLiveSlot } = await import('./runtime-locks.mjs');
    const entry = [{ file: 'lane.lock', record: { lock: 'gate:r:p:g', run_id: 'r' } }];
    const first = await acquireLockFiles(path.join(root, 'locks'), entry, { pollMs: 10 });
    assert.equal(JSON.parse(await readFile(path.join(root, 'locks', 'lane.lock'), 'utf8')).lock, 'gate:r:p:g');
    let secondHeld = false;
    const second = acquireLockFiles(path.join(root, 'locks'), entry, { pollMs: 10 }).then((held) => { secondHeld = true; return held; });
    await new Promise((done) => setTimeout(done, 50));
    assert.equal(secondHeld, false);
    await first.release();
    const held = await second;
    assert.ok(held.waited_ms >= 40);
    await assert.rejects(acquireLockFiles(path.join(root, 'locks'), entry, { pollMs: 10, maxWaitMs: 30 }), /LOCK_WAIT_TIMEOUT/);
    await held.release();

    const live = await acquireLiveSlot({ gate: 'a' }, { pollMs: 10 });
    let liveSecond = false;
    const next = acquireLiveSlot({ gate: 'b' }, { pollMs: 10 }).then((slot) => { liveSecond = true; return slot; });
    await new Promise((done) => setTimeout(done, 50));
    assert.equal(liveSecond, false);
    await live.release();
    await (await next).release();
  } finally {
    if (previous === undefined) delete process.env.PIPELINE_HEAVY_LOCK_DIR; else process.env.PIPELINE_HEAVY_LOCK_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
