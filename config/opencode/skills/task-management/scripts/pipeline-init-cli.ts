import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateManifestExecutability } from './gate-runner-cli';
import { initFromManifest, StageCliError } from './stage-cli';
import type { PipelineState } from '../types/pipeline-state';

const execFileAsync = promisify(execFile);
const DEFAULT_STATE_ROOT = '.tmp/pipelines';
const INIT_LOCK_FILE = '.init.lock';
const GIT_WORKTREE_CLI = fileURLToPath(new URL('./git-worktree-cli.ts', import.meta.url));
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
  check: boolean;
}

interface ManifestPreview {
  run_id?: unknown;
  git_setup?: unknown;
}

interface ReadinessResult {
  status: 'PASS';
  gate: 'pipeline_init';
  mode: 'check';
  run_id: string;
  command_count: number;
  executables: string[];
  workspace?: Record<string, unknown>;
}

function parseOptions(args: string[]): { manifest?: string; options: CliOptions } {
  const options: CliOptions = { stateRoot: DEFAULT_STATE_ROOT, json: false, check: false };
  let manifest: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--json') options.json = true;
    else if (argument === '--check') options.check = true;
    else if (argument === '--state-root') options.stateRoot = args[++index] ?? DEFAULT_STATE_ROOT;
    else if (argument?.startsWith('--')) throw new StageCliError(`Unknown option: ${argument}`);
    else if (!manifest && argument) manifest = argument;
    else if (argument) throw new StageCliError(`Unexpected argument: ${argument}`);
  }
  return { manifest, options };
}

async function readManifestPreview(manifestPath: string): Promise<{ runId: string; manifest: ManifestPreview }> {
  const content = await readFile(resolve(manifestPath), 'utf8');
  const manifest = JSON.parse(content) as ManifestPreview;
  if (typeof manifest.run_id !== 'string' || manifest.run_id.length === 0) {
    throw new StageCliError('Manifest must define run_id');
  }
  return { runId: manifest.run_id, manifest };
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

async function validateManifestWithoutCanonicalState(manifestPath: string): Promise<void> {
  const temporaryRoot = await mkdtemp(join(os.tmpdir(), 'pipeline-init-check-'));
  try {
    await initFromManifest(manifestPath, temporaryRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function workspaceCapability(manifestPath: string): Promise<Record<string, unknown>> {
  try {
    const { stdout } = await execFileAsync(
      'npx',
      ['--yes', 'tsx', GIT_WORKTREE_CLI, 'capability', resolve(manifestPath)],
      { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    );
    return JSON.parse(stdout.trim()) as Record<string, unknown>;
  } catch (error: unknown) {
    const detail = String((error as any)?.stderr ?? (error as Error)?.message ?? error).trim();
    throw new StageCliError(`Workspace capability check failed${detail ? `: ${detail}` : ''}`);
  }
}

export async function checkPipelineReadiness(
  manifestPath: string,
  stateRoot = DEFAULT_STATE_ROOT,
): Promise<ReadinessResult> {
  const absoluteManifestPath = resolve(manifestPath);
  const { runId, manifest } = await readManifestPreview(absoluteManifestPath);

  await validateManifestWithoutCanonicalState(absoluteManifestPath);
  const active = await findActiveSiblingRun(stateRoot, runId);
  if (active) {
    throw new StageCliError(
      `Another pipeline run is active in this worktree: ${active.run_id} (${active.status}). ` +
        'Finish the existing run or use a separate git worktree.',
    );
  }

  const executability = await validateManifestExecutability(absoluteManifestPath, process.cwd());
  const workspace = manifest.git_setup ? await workspaceCapability(absoluteManifestPath) : undefined;
  return {
    status: 'PASS',
    gate: 'pipeline_init',
    mode: 'check',
    run_id: runId,
    ...executability,
    ...(workspace ? { workspace } : {}),
  };
}

export async function initPipelineForWorktree(
  manifestPath: string,
  stateRoot = DEFAULT_STATE_ROOT,
): Promise<PipelineState> {
  const unlock = await acquireInitLock(stateRoot);
  try {
    await checkPipelineReadiness(manifestPath, stateRoot);
    return initFromManifest(manifestPath, stateRoot);
  } finally {
    await unlock();
  }
}

function printState(state: PipelineState, asJson: boolean): void {
  if (asJson) console.log(JSON.stringify(state, null, 2));
  else console.log(`Pipeline run initialized: ${state.run_id} status=${state.status}`);
}

function printReadiness(result: ReadinessResult, asJson: boolean): void {
  if (asJson) console.log(JSON.stringify(result, null, 2));
  else console.log(`Pipeline readiness PASS: ${result.run_id}`);
}

export async function runCli(args: string[]): Promise<void> {
  const { manifest, options } = parseOptions(args);
  if (!manifest) {
    throw new StageCliError(
      'Usage: pipeline-init-cli <manifest> [--check] [--state-root <path>] [--json]',
    );
  }
  if (options.check) {
    printReadiness(await checkPipelineReadiness(manifest, options.stateRoot), options.json);
    return;
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
