import { link, open, readFile, rename, rm } from 'node:fs/promises';
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
