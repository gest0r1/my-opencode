import { readFileSync } from 'node:fs';
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
    if (!Number.isSafeInteger(pid) || pid <= 0 || processAlive(pid, owner.pid_start)) throw error;
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

// Field 22 of /proc/<pid>/stat. Parsed after the last ")" because the comm field may hold spaces and parens.
export function processStartTime(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    return /^\d+$/.test(start ?? '') ? start : null;
  } catch { return null; }
}

// A dead process whose pid the OS reused has a different start time; a record without one keeps the pid-only check.
export function processAlive(pid, start) {
  try { process.kill(pid, 0); } catch (error) { if (error?.code !== 'EPERM') return false; }
  if (start === null || start === undefined) return true;
  const current = processStartTime(pid);
  return current === null || current === String(start);
}

// Heavy test sets (final gates, coordinator checks, base and plan probes) share one machine-wide
// slot. On a loaded machine they were timing out against each other and against workers' checks,
// and each timeout cost a repair cycle. A full set waits for the slot; a narrow worker check never
// takes it but waits while a full set holds it. The slot lives outside any worktree, so parallel
// runs on the same machine see each other.
const HEAVY_POLL_MS = 1000;
const HEAVY_MAX_WAIT_MS = 2 * 60 * 60 * 1000;

function slotFile(name) {
  const dir = process.env.PIPELINE_HEAVY_LOCK_DIR || join(os.homedir(), '.cache', 'opencode-pipeline');
  return join(dir, name);
}
const heavySlotFile = () => slotFile('heavy-gate.lock');

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export function acquireHeavySlot(owner, options) {
  return acquireSlot(heavySlotFile(), owner, options);
}

// Live-database commands share one machine-wide slot: a project's live harness may accept exactly one
// active gate (sevami's live config derives its gate from the single runtime lock), so two live runs at
// once fail each other. A live command waits for the slot instead.
export function acquireLiveSlot(owner, options) {
  return acquireSlot(slotFile('live-gate.lock'), owner, options);
}

// Lock files that wait for a live holder instead of failing; a dead holder is reclaimed.
export async function acquireLockFiles(directory, entries, { pollMs = HEAVY_POLL_MS, maxWaitMs = HEAVY_MAX_WAIT_MS } = {}) {
  await mkdir(directory, { recursive: true });
  const acquired = [];
  const started = Date.now();
  try {
    for (const { file, record } of [...entries].sort((a, b) => a.file.localeCompare(b.file))) {
      const target = join(directory, file);
      for (;;) {
        try {
          const handle = await openRuntimeLock(target);
          await handle.writeFile(JSON.stringify({ ...record, pid: process.pid, pid_start: processStartTime(process.pid), acquired_at: new Date().toISOString() }));
          await handle.close();
          acquired.push(target);
          break;
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error;
          if (Date.now() - started > maxWaitMs) throw new Error(`LOCK_WAIT_TIMEOUT: ${target} held longer than ${Math.round(maxWaitMs / 60000)} min`);
          await sleep(pollMs);
        }
      }
    }
  } catch (error) {
    await Promise.all(acquired.map(file => rm(file, { force: true })));
    throw error;
  }
  return { waited_ms: Date.now() - started, release: () => Promise.all(acquired.map(file => rm(file, { force: true }))) };
}

async function acquireSlot(file, owner, { pollMs = HEAVY_POLL_MS, maxWaitMs = HEAVY_MAX_WAIT_MS } = {}) {
  await mkdir(dirname(file), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      const handle = await openRuntimeLock(file);
      await handle.writeFile(JSON.stringify({ ...owner, pid: process.pid, pid_start: processStartTime(process.pid), acquired_at: new Date().toISOString() }));
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
  // A slot free at the first look costs no wait, however long reading it took.
  for (let waited = false; ; waited = true) {
    let owner;
    try { owner = JSON.parse(await readFile(file, 'utf8')); } catch { return waited ? Date.now() - started : 0; }
    if (!Number.isSafeInteger(owner?.pid) || !processAlive(owner.pid, owner.pid_start)) return waited ? Date.now() - started : 0;
    if (Date.now() - started > maxWaitMs) throw new Error(`HEAVY_GATE_SLOT_TIMEOUT: ${file} held longer than ${Math.round(maxWaitMs / 60000)} min`);
    await sleep(pollMs);
  }
}
