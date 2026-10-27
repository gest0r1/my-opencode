import { link, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';

// A runtime lock whose owner process is gone (a cancelled probe, a killed session) is reclaimed
// here instead of stopping the gate until someone deletes it by hand. A live or unreadable owner
// keeps the lock. The stale file is renamed before removal so two reclaimers cannot both win.
export async function openRuntimeLock(file) {
  try {
    return await open(file, 'wx');
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let raw;
    let owner;
    try { raw = await readFile(file, 'utf8'); owner = JSON.parse(raw); } catch { throw error; }
    const pid = owner?.pid;
    if (!Number.isSafeInteger(pid) || pid <= 0 || runtimeLockOwnerAlive(pid)) throw error;
    const stale = `${file}.stale-${pid}-${process.pid}`;
    try { await rename(file, stale); } catch (renameError) {
      if (renameError?.code !== 'ENOENT') throw renameError;
      throw error;
    }
    if (await readFile(stale, 'utf8') !== raw) {
      // Another process reclaimed the lock between our read and rename; put its live lock back.
      await link(stale, file).catch(() => undefined);
      await rm(stale, { force: true });
      throw error;
    }
    await rm(stale, { force: true });
    return await open(file, 'wx');
  }
}

function runtimeLockOwnerAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

// Heavy test sets (final gates, coordinator checks, base and plan probes) share one machine-wide
// slot. On a loaded machine they were timing out against each other and against workers' checks,
// and each timeout cost a repair cycle. A full set waits for the slot; a narrow worker check never
// takes it but waits while a full set holds it. The slot lives outside any worktree, so parallel
// runs on the same machine see each other.
const HEAVY_POLL_MS = 1000;
const HEAVY_MAX_WAIT_MS = 2 * 60 * 60 * 1000;

function heavySlotFile() {
  const dir = process.env.PIPELINE_HEAVY_LOCK_DIR || join(os.homedir(), '.cache', 'opencode-pipeline');
  return join(dir, 'heavy-gate.lock');
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export async function acquireHeavySlot(owner, { pollMs = HEAVY_POLL_MS, maxWaitMs = HEAVY_MAX_WAIT_MS } = {}) {
  const file = heavySlotFile();
  await mkdir(dirname(file), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      const handle = await openRuntimeLock(file);
      await handle.writeFile(JSON.stringify({ ...owner, pid: process.pid, acquired_at: new Date().toISOString() }));
      await handle.close();
      return { waited_ms: Date.now() - started, release: () => rm(file, { force: true }) };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (Date.now() - started > maxWaitMs) throw new Error(`HEAVY_GATE_SLOT_TIMEOUT: ${file} held longer than ${Math.round(maxWaitMs / 60000)} min`);
      await sleep(pollMs);
    }
  }
}

export async function waitForHeavySlot({ pollMs = HEAVY_POLL_MS, maxWaitMs = HEAVY_MAX_WAIT_MS } = {}) {
  const file = heavySlotFile();
  const started = Date.now();
  for (;;) {
    let owner;
    try { owner = JSON.parse(await readFile(file, 'utf8')); } catch { return Date.now() - started; }
    if (!Number.isSafeInteger(owner?.pid) || !runtimeLockOwnerAlive(owner.pid)) return Date.now() - started;
    if (Date.now() - started > maxWaitMs) throw new Error(`HEAVY_GATE_SLOT_TIMEOUT: ${file} held longer than ${Math.round(maxWaitMs / 60000)} min`);
    await sleep(pollMs);
  }
}
