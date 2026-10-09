import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const SAFE_RUN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ACTIVE_RETRIES = 4;
const ACTIVE_RETRY_MS = 250;

export class StageLockRecoveryError extends Error {}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw new StageLockRecoveryError(`LOCK_PID_CHECK_FAILED: ${String(error?.code ?? error)}`);
  }
}

function parsePid(raw: string, label: string): number {
  if (!/^\d+\s*$/.test(raw)) throw new StageLockRecoveryError(`${label}_INVALID: expected one PID`);
  const pid = Number(raw.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new StageLockRecoveryError(`${label}_INVALID: PID`);
  return pid;
}

const sleep = (ms: number) => new Promise(resolvePromise => setTimeout(resolvePromise, ms));

async function acquireRecoveryGuard(recovery: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(recovery, 'wx');
      try { await handle.writeFile(`${process.pid}\n`, 'utf8'); }
      finally { await handle.close(); }
      return;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      let raw: string;
      try { raw = await readFile(recovery, 'utf8'); }
      catch (readError: any) {
        if (readError?.code === 'ENOENT') continue;
        throw readError;
      }
      const ownerPid = parsePid(raw, 'LOCK_RECOVERY');
      if (pidAlive(ownerPid)) throw new StageLockRecoveryError(`LOCK_RECOVERY_ALREADY_IN_PROGRESS: pid=${ownerPid}`);
      const stale = `${recovery}.stale-${ownerPid}-${process.pid}`;
      try {
        await rename(recovery, stale);
        await rm(stale, { force: true });
      } catch (renameError: any) {
        if (renameError?.code !== 'ENOENT') throw renameError;
      }
    }
  }
  throw new StageLockRecoveryError('LOCK_RECOVERY_GUARD_UNAVAILABLE');
}

export async function recoverStageLock(stateRoot: string, runId: string): Promise<{status:'RECOVERED'|'ABSENT';run_id:string;pid?:number}> {
  if (!SAFE_RUN.test(runId)) throw new StageLockRecoveryError('RUN_ID_INVALID');
  const directory = join(resolve(stateRoot), runId);
  const lock = join(directory, '.lock');
  const recovery = join(directory, '.lock.recover');
  await mkdir(directory, { recursive: true });
  await acquireRecoveryGuard(recovery);

  try {
    let raw: string | undefined;
    let pid: number | undefined;
    for (let attempt = 0; attempt < ACTIVE_RETRIES; attempt += 1) {
      try { raw = await readFile(lock, 'utf8'); }
      catch (error: any) {
        if (error?.code === 'ENOENT') return { status: 'ABSENT', run_id: runId };
        throw error;
      }
      pid = parsePid(raw, 'LOCK');
      if (!pidAlive(pid)) break;
      if (attempt === ACTIVE_RETRIES - 1) throw new StageLockRecoveryError(`LOCK_ACTIVE: pid=${pid}`);
      await sleep(ACTIVE_RETRY_MS);
    }
    if (raw === undefined || pid === undefined) return { status: 'ABSENT', run_id: runId };

    // Normal stage-cli cannot acquire a new lock until this exact stale path is removed.
    // The recovery guard serializes recovery processes; re-read the lock immediately
    // before deletion so a changed owner is never removed by this recovery attempt.
    let current: string;
    try { current = await readFile(lock, 'utf8'); }
    catch (error: any) {
      if (error?.code === 'ENOENT') return { status: 'ABSENT', run_id: runId };
      throw error;
    }
    if (current !== raw) throw new StageLockRecoveryError('LOCK_CHANGED_DURING_RECOVERY');
    await rm(lock);
    return { status: 'RECOVERED', run_id: runId, pid };
  } finally {
    await rm(recovery, { force: true });
  }
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

async function main(args: string[]): Promise<void> {
  if (args[0] !== 'recover' || !args[1]) {
    throw new StageLockRecoveryError('usage: stage-lock-cli.ts recover <run-id> [--state-root <path>]');
  }
  const extras = args.slice(2);
  if (extras.length && !(extras.length === 2 && extras[0] === '--state-root' && extras[1])) {
    throw new StageLockRecoveryError('INVALID_ARGUMENTS');
  }
  const result = await recoverStageLock(option(args, '--state-root') ?? '.tmp/pipelines', args[1]);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`stage-lock-cli: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
