import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const SAFE_RUN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

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

export async function recoverStageLock(stateRoot: string, runId: string): Promise<{status:'RECOVERED'|'ABSENT';run_id:string;pid?:number}> {
  if (!SAFE_RUN.test(runId)) throw new StageLockRecoveryError('RUN_ID_INVALID');
  const directory = join(resolve(stateRoot), runId);
  const lock = join(directory, '.lock');
  const recovery = join(directory, '.lock.recover');
  await mkdir(directory, { recursive: true });

  let recoveryHandle;
  try {
    recoveryHandle = await open(recovery, 'wx');
  } catch (error: any) {
    if (error?.code === 'EEXIST') throw new StageLockRecoveryError('LOCK_RECOVERY_ALREADY_IN_PROGRESS');
    throw error;
  }

  try {
    let raw: string;
    try { raw = await readFile(lock, 'utf8'); }
    catch (error: any) {
      if (error?.code === 'ENOENT') return { status: 'ABSENT', run_id: runId };
      throw error;
    }
    if (!/^\d+\s*$/.test(raw)) throw new StageLockRecoveryError('LOCK_INVALID: expected one PID');
    const pid = Number(raw.trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new StageLockRecoveryError('LOCK_INVALID: PID');
    if (pidAlive(pid)) throw new StageLockRecoveryError(`LOCK_ACTIVE: pid=${pid}`);

    // Re-read while the recovery guard is held. No other recovery command may remove
    // the stale file, and normal stage-cli cannot acquire a new lock until this exact
    // path is removed.
    const current = await readFile(lock, 'utf8').catch(() => '');
    if (current !== raw) throw new StageLockRecoveryError('LOCK_CHANGED_DURING_RECOVERY');
    await rm(lock);
    return { status: 'RECOVERED', run_id: runId, pid };
  } finally {
    await recoveryHandle.close().catch(() => undefined);
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
