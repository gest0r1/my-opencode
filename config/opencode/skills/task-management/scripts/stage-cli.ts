import { createHash } from 'node:crypto';
import { access, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import type {
  PipelineManifest,
  PipelineRuntime,
  PipelineState,
  PipelineStatus,
  StageEvidence,
  StageRuntime,
  StageStatus,
} from '../types/pipeline-state';

const DEFAULT_STATE_ROOT = '.tmp/pipelines';
const STATE_FILE = 'state.json';
const LOCK_FILE = '.lock';
const HUMAN_ONLY = 'human_only';

export class StageCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StageCliError';
  }
}

interface RulesMetadata {
  rules_version: number;
  edit_policy: string;
}

export interface StageCommandOptions {
  json: boolean;
  stateRoot: string;
  pipelineId?: string;
  message?: string;
  evidencePath?: string;
}

function now(): string {
  return new Date().toISOString();
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function parseFrontmatter(content: string): RulesMetadata {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match?.[1]) {
    throw new StageCliError('Rules file has no YAML frontmatter');
  }

  const values = new Map<string, string>();
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(':');
    if (separator < 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
    values.set(key, value);
  }

  const rulesVersion = Number(values.get('rules_version'));
  const editPolicy = values.get('edit_policy');
  if (!Number.isInteger(rulesVersion) || !editPolicy) {
    throw new StageCliError('Rules file must define rules_version and edit_policy');
  }

  return { rules_version: rulesVersion, edit_policy: editPolicy };
}

async function readRules(rulesPath: string): Promise<{ metadata: RulesMetadata; content: string }> {
  const content = await readFile(rulesPath, 'utf8');
  return { metadata: parseFrontmatter(content), content };
}

function assertRulesLocked(metadata: RulesMetadata): void {
  if (metadata.edit_policy !== HUMAN_ONLY) {
    throw new StageCliError(
      `Rules file must be locked before pipeline execution: edit_policy=${metadata.edit_policy}`,
    );
  }
}

function assertGitSetup(value: PipelineManifest['git_setup']): void {
  if (!value) return;
  const sha = /^[0-9a-f]{40}$/i;
  const safeBranch = /^(?!main$|master$)[A-Za-z0-9][A-Za-z0-9._/-]*$/;
  const safePath = (path: unknown): path is string =>
    typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.includes('\\\\') && !path.split('/').includes('..');
  if (!sha.test(value.base_sha) || !safeBranch.test(value.branch) || value.branch.includes('..') || value.branch.endsWith('/')) {
    throw new StageCliError('git_setup must define a safe branch and 40-hex base_sha');
  }
  if (value.source_sha !== undefined && !sha.test(value.source_sha)) {
    throw new StageCliError('git_setup.source_sha must be a 40-hex SHA');
  }
  if ((value.checkout_paths ?? []).some((path) => !safePath(path)) || (value.must_absent ?? []).some((path) => !safePath(path))) {
    throw new StageCliError('git_setup paths must be repository-relative');
  }
  if (value.source_sha && (!value.checkout_paths || value.checkout_paths.length === 0)) {
    throw new StageCliError('git_setup.source_sha requires checkout_paths');
  }
}

function assertManifest(value: unknown): asserts value is PipelineManifest {
  if (!value || typeof value !== 'object') {
    throw new StageCliError('Manifest must be an object');
  }

  const manifest = value as Partial<PipelineManifest>;
  if (
    manifest.schema_version !== 1 ||
    typeof manifest.run_id !== 'string' ||
    typeof manifest.rules_file !== 'string' ||
    typeof manifest.rules_version !== 'number' ||
    !Array.isArray(manifest.pipelines) ||
    manifest.pipelines.length === 0
  ) {
    throw new StageCliError(
      'Manifest must define schema_version=1, run_id, rules_file, rules_version and pipelines',
    );
  }

  assertGitSetup(manifest.git_setup);

  const ids = new Set<string>();
  for (const pipeline of manifest.pipelines) {
    if (
      !pipeline ||
      typeof pipeline !== 'object' ||
      typeof pipeline.id !== 'string' ||
      !Array.isArray(pipeline.stages) ||
      pipeline.stages.length === 0 ||
      pipeline.stages.some((stage) => typeof stage !== 'string' || stage.length === 0)
    ) {
      throw new StageCliError('Every pipeline must define id and non-empty stages');
    }
    if (ids.has(pipeline.id)) {
      throw new StageCliError(`Duplicate pipeline id: ${pipeline.id}`);
    }
    ids.add(pipeline.id);
    if (new Set(pipeline.stages).size !== pipeline.stages.length) {
      throw new StageCliError(`Duplicate stage in pipeline: ${pipeline.id}`);
    }
  }
}

function stateDir(stateRoot: string, runId: string): string {
  return join(resolve(stateRoot), runId);
}

function statePath(stateRoot: string, runId: string): string {
  return join(stateDir(stateRoot, runId), STATE_FILE);
}

function lockPath(stateRoot: string, runId: string): string {
  return join(stateDir(stateRoot, runId), LOCK_FILE);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, path);
}

async function acquireLock(stateRoot: string, runId: string): Promise<() => Promise<void>> {
  const directory = stateDir(stateRoot, runId);
  await mkdir(directory, { recursive: true });
  try {
    const handle = await open(lockPath(stateRoot, runId), 'wx');
    await handle.writeFile(`${process.pid}\n`, 'utf8');
    await handle.close();
  } catch {
    throw new StageCliError(`Pipeline is locked: ${runId}`);
  }

  return async () => {
    await rm(lockPath(stateRoot, runId), { force: true });
  };
}

async function readState(stateRoot: string, runId: string): Promise<PipelineState> {
  try {
    const raw = await readFile(statePath(stateRoot, runId), 'utf8');
    return JSON.parse(raw) as PipelineState;
  } catch {
    throw new StageCliError(`State not found or invalid: ${runId}`);
  }
}

function resolveRulesPath(rulesFile: string): string {
  if (rulesFile.startsWith('/')) {
    return rulesFile;
  }
  const projectCandidate = resolve(rulesFile);
  return projectCandidate;
}

async function resolveManifestRulesPath(manifestPath: string, rulesFile: string): Promise<string> {
  const projectCandidate = resolveRulesPath(rulesFile);
  try {
    await access(projectCandidate);
    return projectCandidate;
  } catch {
    return resolve(dirname(manifestPath), rulesFile);
  }
}

function createPipelineRuntime(id: string, stages: string[]): PipelineRuntime {
  const stageRuntime: Record<string, StageRuntime> = {};
  for (const stage of stages) {
    stageRuntime[stage] = { status: 'pending' };
  }
  return { id, status: 'planned', stages: stageRuntime, stage_order: stages };
}

export async function initFromManifest(
  manifestPath: string,
  stateRoot = DEFAULT_STATE_ROOT,
): Promise<PipelineState> {
  const absoluteManifestPath = resolve(manifestPath);
  const manifest = JSON.parse(await readFile(absoluteManifestPath, 'utf8')) as unknown;
  assertManifest(manifest);

  const rulesPath = await resolveManifestRulesPath(absoluteManifestPath, manifest.rules_file);
  const rules = await readRules(rulesPath);
  assertRulesLocked(rules.metadata);
  if (rules.metadata.rules_version !== manifest.rules_version) {
    throw new StageCliError('Manifest rules_version does not match rules file');
  }

  const timestamp = now();
  const state: PipelineState = {
    schema_version: 1,
    run_id: manifest.run_id,
    rules_file: rulesPath,
    rules_version: rules.metadata.rules_version,
    rules_sha256: sha256(rules.content),
    status: 'planned',
    created_at: timestamp,
    updated_at: timestamp,
    pipelines: Object.fromEntries(
      manifest.pipelines.map((pipeline) => [
        pipeline.id,
        createPipelineRuntime(pipeline.id, pipeline.stages),
      ]),
    ),
    history: [],
  };

  const unlock = await acquireLock(stateRoot, manifest.run_id);
  try {
    if (await fileExists(statePath(stateRoot, manifest.run_id))) {
      throw new StageCliError(`State already exists: ${manifest.run_id}`);
    }
    await writeJsonAtomic(statePath(stateRoot, manifest.run_id), state);
  } finally {
    await unlock();
  }
  return state;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function validateState(stateRoot: string, runId: string): Promise<PipelineState> {
  const state = await readState(stateRoot, runId);
  const rules = await readRules(state.rules_file);
  assertRulesLocked(rules.metadata);
  if (rules.metadata.rules_version !== state.rules_version) {
    throw new StageCliError('Rules version changed since pipeline initialization');
  }
  if (sha256(rules.content) !== state.rules_sha256) {
    throw new StageCliError('Rules file changed since pipeline initialization');
  }
  for (const pipeline of Object.values(state.pipelines)) {
    if (pipeline.stage_order.length === 0) {
      throw new StageCliError(`Pipeline has no stages: ${pipeline.id}`);
    }
    for (const stage of pipeline.stage_order) {
      if (!pipeline.stages[stage]) {
        throw new StageCliError(`Missing runtime state for stage: ${pipeline.id}/${stage}`);
      }
    }
  }
  return state;
}

function getPipeline(state: PipelineState, pipelineId?: string): PipelineRuntime {
  const pipelines = Object.values(state.pipelines);
  if (pipelineId) {
    const pipeline = state.pipelines[pipelineId];
    if (!pipeline) {
      throw new StageCliError(`Pipeline not found: ${pipelineId}`);
    }
    return pipeline;
  }
  if (pipelines.length !== 1) {
    throw new StageCliError('pipeline_id is required when run has multiple pipelines');
  }
  return pipelines[0] as PipelineRuntime;
}

function assertStatusTransition(current: PipelineStatus, target: PipelineStatus): void {
  const allowed: Record<PipelineStatus, PipelineStatus[]> = {
    planned: ['approved'],
    approved: ['in_progress'],
    in_progress: ['ready', 'blocked', 'failed'],
    blocked: ['in_progress'],
    failed: ['in_progress'],
    ready: ['release_ready'],
    release_ready: ['completed'],
    completed: [],
  };
  if (!allowed[current].includes(target)) {
    throw new StageCliError(`Invalid pipeline transition: ${current} -> ${target}`);
  }
}

function recalculateRunStatus(state: PipelineState): void {
  const statuses = Object.values(state.pipelines).map((pipeline) => pipeline.status);
  if (statuses.some((status) => status === 'failed')) {
    state.status = 'failed';
  } else if (statuses.some((status) => status === 'blocked')) {
    state.status = 'blocked';
  } else if (statuses.every((status) => status === 'completed')) {
    state.status = 'completed';
  } else if (
    statuses.length > 0 &&
    statuses.every((status) => status === 'release_ready' || status === 'completed')
  ) {
    state.status = 'release_ready';
  } else if (
    statuses.length > 0 &&
    statuses.every(
      (status) => status === 'ready' || status === 'release_ready' || status === 'completed',
    )
  ) {
    state.status = 'ready';
  } else if (statuses.some((status) => status === 'in_progress')) {
    state.status = 'in_progress';
  } else if (statuses.some((status) => status === 'approved')) {
    state.status = 'approved';
  } else {
    state.status = 'planned';
  }
}

function addHistory(
  state: PipelineState,
  pipelineId: string,
  stage: string,
  status: StageStatus,
  message?: string,
): void {
  state.history.push({
    pipeline_id: pipelineId,
    stage,
    status,
    timestamp: now(),
    ...(message ? { message } : {}),
  });
}

async function updateState(
  stateRoot: string,
  runId: string,
  updater: (state: PipelineState) => void,
): Promise<PipelineState> {
  const unlock = await acquireLock(stateRoot, runId);
  try {
    const state = await validateState(stateRoot, runId);
    updater(state);
    state.updated_at = now();
    await writeJsonAtomic(statePath(stateRoot, runId), state);
    return state;
  } finally {
    await unlock();
  }
}

export async function approvePipeline(stateRoot: string, runId: string): Promise<PipelineState> {
  return updateState(stateRoot, runId, (state) => {
    if (state.status !== 'planned') {
      throw new StageCliError(`Cannot approve run while it is ${state.status}`);
    }
    state.status = 'approved';
    for (const pipeline of Object.values(state.pipelines)) {
      pipeline.status = 'approved';
    }
  });
}

export async function startStage(
  stateRoot: string,
  runId: string,
  stage: string,
  pipelineId?: string,
): Promise<PipelineState> {
  return updateState(stateRoot, runId, (state) => {
    const pipeline = getPipeline(state, pipelineId);
    const runtime = pipeline.stages[stage];
    if (!runtime) {
      throw new StageCliError(`Stage not found: ${pipeline.id}/${stage}`);
    }
    if (runtime.status !== 'pending') {
      throw new StageCliError(`Stage is not pending: ${pipeline.id}/${stage}`);
    }
    const index = pipeline.stage_order.indexOf(stage);
    const previousStage =
      index > 0 ? pipeline.stages[pipeline.stage_order[index - 1] as string] : undefined;
    if (
      previousStage &&
      previousStage.status !== 'completed' &&
      previousStage.status !== 'skipped'
    ) {
      throw new StageCliError(`Previous stage is not complete: ${pipeline.stage_order[index - 1]}`);
    }
    if (state.status !== 'approved' && state.status !== 'in_progress') {
      throw new StageCliError(`Cannot start stage while run is ${state.status}`);
    }
    if (pipeline.status === 'approved' || pipeline.status === 'planned') {
      pipeline.status = 'in_progress';
    }
    runtime.status = 'in_progress';
    runtime.started_at = now();
    pipeline.current_stage = stage;
    state.current_stage = `${pipeline.id}/${stage}`;
    addHistory(state, pipeline.id, stage, 'in_progress');
    recalculateRunStatus(state);
  });
}

function buildEvidence(
  stage: string,
  status: StageEvidence['status'],
  options: StageCommandOptions,
): StageEvidence {
  return {
    stage,
    status,
    ...(options.message ? { message: options.message } : {}),
    ...(options.evidencePath ? { artifacts: [options.evidencePath] } : {}),
    recorded_at: now(),
  };
}

export async function completeStage(
  stateRoot: string,
  runId: string,
  stage: string,
  pipelineId?: string,
  options: StageCommandOptions = { json: false, stateRoot },
): Promise<PipelineState> {
  return updateState(stateRoot, runId, (state) => {
    const pipeline = getPipeline(state, pipelineId);
    const runtime = pipeline.stages[stage];
    if (!runtime || runtime.status !== 'in_progress') {
      throw new StageCliError(`Stage is not in progress: ${pipeline.id}/${stage}`);
    }
    runtime.status = 'completed';
    runtime.completed_at = now();
    runtime.evidence = buildEvidence(stage, 'completed', options);
    addHistory(state, pipeline.id, stage, 'completed', options.message);

    const allCompleted = pipeline.stage_order.every((item) => {
      const itemStatus = pipeline.stages[item]?.status;
      return itemStatus === 'completed' || itemStatus === 'skipped';
    });
    const releaseStage = pipeline.stage_order.find((item) => /release|deploy|smoke/i.test(item));
    if (releaseStage && stage === releaseStage) {
      assertStatusTransition(pipeline.status, 'release_ready');
      pipeline.status = 'release_ready';
    } else if (allCompleted) {
      if (pipeline.status === 'release_ready') {
        assertStatusTransition(pipeline.status, 'completed');
        pipeline.status = 'completed';
      } else {
        assertStatusTransition(pipeline.status, 'ready');
        pipeline.status = 'ready';
      }
    }
    recalculateRunStatus(state);
  });
}

export async function setStageFailure(
  stateRoot: string,
  runId: string,
  stage: string,
  status: 'failed' | 'blocked',
  pipelineId?: string,
  options: StageCommandOptions = { json: false, stateRoot },
): Promise<PipelineState> {
  return updateState(stateRoot, runId, (state) => {
    const pipeline = getPipeline(state, pipelineId);
    const runtime = pipeline.stages[stage];
    if (!runtime || runtime.status !== 'in_progress') {
      throw new StageCliError(`Stage is not in progress: ${pipeline.id}/${stage}`);
    }
    runtime.status = status;
    runtime.evidence = buildEvidence(stage, status, options);
    addHistory(state, pipeline.id, stage, status, options.message);
    assertStatusTransition(pipeline.status, status);
    pipeline.status = status;
    recalculateRunStatus(state);
  });
}

export async function resumeStage(
  stateRoot: string,
  runId: string,
  stage: string,
  pipelineId?: string,
): Promise<PipelineState> {
  return updateState(stateRoot, runId, (state) => {
    const pipeline = getPipeline(state, pipelineId);
    const runtime = pipeline.stages[stage];
    if (!runtime || (runtime.status !== 'failed' && runtime.status !== 'blocked')) {
      throw new StageCliError(`Stage is not resumable: ${pipeline.id}/${stage}`);
    }
    if (pipeline.status !== 'failed' && pipeline.status !== 'blocked') {
      throw new StageCliError(`Pipeline is not resumable: ${pipeline.id}`);
    }
    runtime.status = 'in_progress';
    runtime.started_at = now();
    runtime.completed_at = undefined;
    runtime.evidence = undefined;
    pipeline.status = 'in_progress';
    pipeline.current_stage = stage;
    state.current_stage = `${pipeline.id}/${stage}`;
    addHistory(state, pipeline.id, stage, 'in_progress', 'resumed');
    recalculateRunStatus(state);
  });
}

function parseOptions(args: string[]): { positional: string[]; options: StageCommandOptions } {
  const positional: string[] = [];
  const options: StageCommandOptions = { json: false, stateRoot: DEFAULT_STATE_ROOT };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--json') {
      options.json = true;
    } else if (argument === '--state-root') {
      options.stateRoot = args[++index] ?? DEFAULT_STATE_ROOT;
    } else if (argument === '--pipeline') {
      options.pipelineId = args[++index];
    } else if (argument === '--message') {
      options.message = args[++index];
    } else if (argument === '--evidence') {
      options.evidencePath = args[++index];
    } else if (argument?.startsWith('--')) {
      throw new StageCliError(`Unknown option: ${argument}`);
    } else if (argument) {
      positional.push(argument);
    }
  }
  return { positional, options };
}

function printState(state: PipelineState, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  console.log(`Pipeline run: ${state.run_id}`);
  console.log(`Status: ${state.status}`);
  for (const pipeline of Object.values(state.pipelines)) {
    console.log(`\n${pipeline.id}: ${pipeline.status}`);
    for (const stage of pipeline.stage_order) {
      const status = pipeline.stages[stage]?.status ?? 'unknown';
      const marker = status === 'completed' ? '✓' : status === 'in_progress' ? '→' : '○';
      console.log(`  ${marker} ${stage}: ${status}`);
    }
  }
}

function usage(): string {
  return [
    'Usage:',
    '  stage-cli init <manifest> [--state-root <path>]',
    '  stage-cli approve <run-id> [--state-root <path>]',
    '  stage-cli status <run-id> [--json] [--state-root <path>]',
    '  stage-cli validate <run-id> [--state-root <path>]',
    '  stage-cli start <run-id> <stage> [--pipeline <id>]',
    '  stage-cli complete <run-id> <stage> [--pipeline <id>] [--message <text>]',
    '  stage-cli fail|block <run-id> <stage> [--pipeline <id>] [--message <text>]',
    '  stage-cli resume <run-id> <stage> [--pipeline <id>]',
  ].join('\n');
}

export async function runCli(args: string[]): Promise<void> {
  const { positional, options } = parseOptions(args);
  const command = positional[0];
  if (!command) {
    throw new StageCliError(usage());
  }

  if (command === 'init') {
    const manifest = positional[1];
    if (!manifest) {
      throw new StageCliError('Manifest path is required');
    }
    printState(await initFromManifest(manifest, options.stateRoot), options.json);
    return;
  }

  const runId = positional[1];
  if (!runId) {
    throw new StageCliError('run-id is required');
  }
  if (command === 'status') {
    printState(await readState(options.stateRoot, runId), options.json);
    return;
  }
  if (command === 'validate') {
    const state = await validateState(options.stateRoot, runId);
    console.log(options.json ? JSON.stringify(state, null, 2) : `Valid: ${runId}`);
    return;
  }
  if (command === 'approve') {
    printState(await approvePipeline(options.stateRoot, runId), options.json);
    return;
  }

  const stage = positional[2];
  if (!stage) {
    throw new StageCliError('stage is required');
  }
  let state: PipelineState;
  if (command === 'start') {
    state = await startStage(options.stateRoot, runId, stage, options.pipelineId);
  } else if (command === 'complete') {
    state = await completeStage(options.stateRoot, runId, stage, options.pipelineId, options);
  } else if (command === 'fail' || command === 'block') {
    state = await setStageFailure(
      options.stateRoot,
      runId,
      stage,
      command === 'fail' ? 'failed' : 'blocked',
      options.pipelineId,
      options,
    );
  } else if (command === 'resume') {
    state = await resumeStage(options.stateRoot, runId, stage, options.pipelineId);
  } else {
    throw new StageCliError(`Unknown command: ${command}\n\n${usage()}`);
  }
  printState(state, options.json);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`stage-cli: ${message}`);
    process.exitCode = 1;
  });
}
