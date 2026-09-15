import { mkdir, open, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { initFromManifest, StageCliError } from './stage-cli';
import type { PipelineState } from '../types/pipeline-state';

const DEFAULT_STATE_ROOT = '.tmp/pipelines';
const INIT_LOCK_FILE = '.init.lock';
const ACTIVE_STATUSES = new Set([
  'planned',
  'approved',
  'in_progress',
  'blocked',
  'ready',
  'release_ready',
  'failed',
]);

interface CliOptions {
  stateRoot: string;
  json: boolean;
}

function parseOptions(args: string[]): { manifest?: string; options: CliOptions } {
  const options: CliOptions = { stateRoot: DEFAULT_STATE_ROOT, json: false };
  let manifest: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--json') options.json = true;
    else if (argument === '--state-root') options.stateRoot = args[++index] ?? DEFAULT_STATE_ROOT;
    else if (argument?.startsWith('--')) throw new StageCliError(`Unknown option: ${argument}`);
    else if (!manifest && argument) manifest = argument;
    else if (argument) throw new StageCliError(`Unexpected argument: ${argument}`);
  }
  return { manifest, options };
}

async function readRunId(manifestPath: string): Promise<string> {
  const content = await readFile(resolve(manifestPath), 'utf8');
  const manifest = JSON.parse(content) as { run_id?: unknown };
  if (typeof manifest.run_id !== 'string' || manifest.run_id.length === 0) {
    throw new StageCliError('Manifest must define run_id');
  }
  return manifest.run_id;
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return code === 'EPERM';
  }
}

async function acquireInitLock(stateRoot: string): Promise<() => Promise<void>> {
  const root = resolve(stateRoot);
  const lock = join(root, INIT_LOCK_FILE);
  await mkdir(root, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lock, 'wx');
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, 'utf8');
      await handle.close();
      return async () => rm(lock, { force: true });
    } catch {
      const owner = await readFile(lock, 'utf8').catch(() => '');
      const pid = Number(owner.split('\n')[0]);
      if (attempt === 0 && !processAlive(pid)) {
        await rm(lock, { force: true });
        continue;
      }
      throw new StageCliError('Pipeline initialization is already in progress in this worktree');
    }
  }

  throw new StageCliError('Unable to acquire pipeline initialization lock');
}

async function findActiveSiblingRun(stateRoot: string, runId: string): Promise<PipelineState | undefined> {
  const root = resolve(stateRoot);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === runId) continue;
    const stateFile = join(root, entry.name, 'state.json');
    const content = await readFile(stateFile, 'utf8').catch(() => undefined);
    if (!content) continue;
    let state: PipelineState;
    try {
      state = JSON.parse(content) as PipelineState;
    } catch {
      continue;
    }
    if (state.run_id !== runId && ACTIVE_STATUSES.has(state.status)) return state;
  }
  return undefined;
}

export async function initPipelineForWorktree(
  manifestPath: string,
  stateRoot = DEFAULT_STATE_ROOT,
): Promise<PipelineState> {
  const runId = await readRunId(manifestPath);
  const unlock = await acquireInitLock(stateRoot);
  try {
    const active = await findActiveSiblingRun(stateRoot, runId);
    if (active) {
      throw new StageCliError(
        `Another pipeline run is active in this worktree: ${active.run_id} (${active.status}). ` +
          'Finish the existing run or use a separate git worktree.',
      );
    }
    return initFromManifest(manifestPath, stateRoot);
  } finally {
    await unlock();
  }
}

function printState(state: PipelineState, asJson: boolean): void {
  if (asJson) console.log(JSON.stringify(state, null, 2));
  else console.log(`Pipeline run initialized: ${state.run_id} status=${state.status}`);
}

export async function runCli(args: string[]): Promise<void> {
  const { manifest, options } = parseOptions(args);
  if (!manifest) {
    throw new StageCliError(
      'Usage: pipeline-init-cli <manifest> [--state-root <path>] [--json]',
    );
  }
  printState(await initPipelineForWorktree(manifest, options.stateRoot), options.json);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`pipeline-init-cli: ${message}`);
    process.exitCode = 1;
  });
}
