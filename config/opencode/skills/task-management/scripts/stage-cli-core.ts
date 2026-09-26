import { createHash } from 'node:crypto';
import { access, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  PipelineManifest,
  PipelineManifestPipeline,
  PipelineGithubOutboxEvent,
  PipelineRuntime,
  PipelineState,
  RulesSource,
  StageEvidence,
  StageRuntime,
  StageStatus,
} from '../types/pipeline-state';

const DEFAULT_STATE_ROOT = '.tmp/pipelines';
const STATE_FILE = 'state.json';
const LOCK_FILE = '.lock';
const HUMAN_ONLY = 'human_only';
const DISTRIBUTION_ONLY = 'distribution_only';
const DEFAULT_RULES_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'pipeline-rules.default.md',
);

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

interface ResolvedRules {
  source: RulesSource;
  path: string;
  metadata: RulesMetadata;
  content: string;
  sha256: string;
}

export interface StageCommandOptions {
  json: boolean;
  stateRoot: string;
  pipelineId?: string;
  message?: string;
  evidencePath?: string;
  environment?: boolean;
}

export interface RunnableStage {
  pipeline_id: string;
  stage: string;
}

function now(): string {
  return new Date().toISOString();
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function parseFrontmatter(content: string): RulesMetadata {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match?.[1]) throw new StageCliError('Rules file has no YAML frontmatter');

  const values = new Map<string, string>();
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(':');
    if (separator < 0) continue;
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

function assertRulesLocked(metadata: RulesMetadata, source: RulesSource): void {
  const expected = source === 'project' ? HUMAN_ONLY : DISTRIBUTION_ONLY;
  if (metadata.edit_policy !== expected) {
    throw new StageCliError(
      `Rules file has invalid edit_policy for ${source}: expected=${expected}, actual=${metadata.edit_policy}`,
    );
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function loadResolvedRules(path: string, source: RulesSource): Promise<ResolvedRules> {
  const rules = await readRules(path);
  assertRulesLocked(rules.metadata, source);
  return {
    source,
    path,
    metadata: rules.metadata,
    content: rules.content,
    sha256: sha256(rules.content),
  };
}

function resolveRulesPath(rulesFile: string): string {
  return rulesFile.startsWith('/') ? rulesFile : resolve(rulesFile);
}

export async function resolveEffectiveRules(
  rulesFile = 'docs/pipeline-rules.md',
  manifestPath?: string,
): Promise<ResolvedRules> {
  const projectCandidate = resolveRulesPath(rulesFile);
  if (await fileExists(projectCandidate)) {
    const source: RulesSource =
      resolve(projectCandidate) === resolve(DEFAULT_RULES_PATH) ? 'opencode_default' : 'project';
    return loadResolvedRules(projectCandidate, source);
  }

  if (manifestPath && !rulesFile.startsWith('/')) {
    const manifestCandidate = resolve(dirname(manifestPath), rulesFile);
    if (manifestCandidate !== projectCandidate && (await fileExists(manifestCandidate))) {
      return loadResolvedRules(manifestCandidate, 'project');
    }
  }

  if (await fileExists(DEFAULT_RULES_PATH)) {
    return loadResolvedRules(DEFAULT_RULES_PATH, 'opencode_default');
  }
  throw new StageCliError(
    `Rules not found: project=${projectCandidate}; default=${DEFAULT_RULES_PATH}`,
  );
}

function safeRepoPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\')) return false;
  const parts = value.split('/');
  return !parts.includes('..') && !parts.includes('.git') && !value.includes('\0');
}

function assertStringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new StageCliError(`${field} must be an array of non-empty strings`);
  }
}

function assertOptionalPathArray(value: unknown, field: string): void {
  if (value === undefined) return;
  assertStringArray(value, field);
  if (value.some((item) => !safeRepoPath(item))) {
    throw new StageCliError(`${field} must contain safe repository-relative paths`);
  }
}

function pathMatchesScope(path: string, scope: string): boolean {
  if (scope.endsWith('/**')) {
    const prefix = scope.slice(0, -3).replace(/\/$/, '');
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  return path === scope;
}

function assertGitSetup(value: PipelineManifest['git_setup'], allowedChangePaths?: string[]): void {
  if (!value) return;
  const sha = /^[0-9a-f]{40}$/i;
  const safeBranch = /^(?!main$|master$)[A-Za-z0-9][A-Za-z0-9._/-]*$/;
  if (
    !sha.test(value.base_sha) ||
    !safeBranch.test(value.branch) ||
    value.branch.includes('..') ||
    value.branch.endsWith('/')
  ) {
    throw new StageCliError('git_setup must define a safe branch and 40-hex base_sha');
  }
  if (value.source_sha !== undefined && !sha.test(value.source_sha)) {
    throw new StageCliError('git_setup.source_sha must be a 40-hex SHA');
  }
  assertOptionalPathArray(value.checkout_paths, 'git_setup.checkout_paths');
  assertOptionalPathArray(value.must_absent, 'git_setup.must_absent');
  if (value.source_sha && (!value.checkout_paths || value.checkout_paths.length === 0)) {
    throw new StageCliError('git_setup.source_sha requires checkout_paths');
  }
  if (value.checkout_paths?.length && allowedChangePaths?.length) {
    for (const checkoutPath of value.checkout_paths) {
      if (!allowedChangePaths.some((scope) => pathMatchesScope(checkoutPath, scope))) {
        throw new StageCliError(`git_setup.checkout_paths[] is outside allowed_change_paths: ${checkoutPath}`);
      }
    }
  }
}

function assertIssueSource(manifest: PipelineManifest): void {
  if (manifest.freshness_sensitive_paths !== undefined) {
    assertOptionalPathArray(manifest.freshness_sensitive_paths, 'freshness_sensitive_paths');
  }
  if (manifest.planning_base_sha !== undefined && !/^[0-9a-f]{40}$/i.test(manifest.planning_base_sha)) {
    throw new StageCliError('planning_base_sha must be a 40-hex SHA');
  }
  if (manifest.planning_base_sha && manifest.git_setup?.base_sha &&
      manifest.planning_base_sha.toLowerCase() !== manifest.git_setup.base_sha.toLowerCase()) {
    throw new StageCliError('planning_base_sha must equal git_setup.base_sha');
  }
  if (manifest.source_type !== 'github_issues') return;
  if (!manifest.repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(manifest.repository)) {
    throw new StageCliError('github_issues source requires repository=owner/repo');
  }
  if (!Array.isArray(manifest.source_issues) || manifest.source_issues.length === 0) {
    throw new StageCliError('github_issues source requires non-empty source_issues');
  }
  const issueNumbers = new Set<number>();
  for (const issue of manifest.source_issues) {
    if (!issue || issue.repository !== manifest.repository || !Number.isInteger(issue.number) || issue.number <= 0 ||
        typeof issue.url !== 'string' || typeof issue.title !== 'string') {
      throw new StageCliError('source_issues must belong to repository and define number/url/title');
    }
    if (issueNumbers.has(issue.number)) throw new StageCliError(`Duplicate source issue: #${issue.number}`);
    issueNumbers.add(issue.number);
  }
  const mapped = new Set<number>();
  for (const pipeline of manifest.pipelines) {
    if (!Array.isArray(pipeline.issue_numbers) || pipeline.issue_numbers.length === 0) {
      throw new StageCliError(`Pipeline "${pipeline.id}" must map at least one issue in github_issues mode`);
    }
    for (const number of pipeline.issue_numbers) {
      if (!Number.isInteger(number) || !issueNumbers.has(number)) {
        throw new StageCliError(`Pipeline "${pipeline.id}" references unknown issue #${String(number)}`);
      }
      mapped.add(number);
    }
  }
  for (const number of issueNumbers) {
    if (!mapped.has(number)) throw new StageCliError(`Source issue #${number} is not mapped to a pipeline`);
  }
}

function assertDependencyGraph(pipelines: PipelineManifestPipeline[]): void {
  const ids = new Set(pipelines.map((pipeline) => pipeline.id));
  for (const pipeline of pipelines) {
    for (const dependency of pipeline.depends_on ?? []) {
      if (!ids.has(dependency)) throw new StageCliError(`Unknown dependency: ${pipeline.id} -> ${dependency}`);
      if (dependency === pipeline.id) throw new StageCliError(`Pipeline cannot depend on itself: ${pipeline.id}`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(pipelines.map((pipeline) => [pipeline.id, pipeline]));
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new StageCliError(`Pipeline dependency cycle detected at: ${id}`);
    visiting.add(id);
    for (const dependency of byId.get(id)?.depends_on ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
}

function assertGateProfiles(value: unknown): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new StageCliError('gate_profiles must be an object');
  }
  for (const [profile, stages] of Object.entries(value as Record<string, unknown>)) {
    if (!stages || typeof stages !== 'object' || Array.isArray(stages)) {
      throw new StageCliError(`gate_profiles.${profile} must be an object`);
    }
    for (const [stage, commands] of Object.entries(stages as Record<string, unknown>)) {
      assertStringArray(commands, `gate_profiles.${profile}.${stage}`);
    }
  }
}

function assertSha256Value(value: unknown, field: string): void {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new StageCliError(`${field} must be a SHA-256 hex string`);
  }
}

function assertFrozenArtifactShape(value: unknown, field: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new StageCliError(`${field} must define path + sha256`);
  }
  const artifact = value as { path?: unknown; sha256?: unknown };
  if (!safeRepoPath(artifact.path)) throw new StageCliError(`${field}.path must be repository-relative and safe`);
  assertSha256Value(artifact.sha256, `${field}.sha256`);
}

function assertV2PlanningShape(manifest: PipelineManifest): void {
  if (manifest.planning_mode !== 'design-freeze') {
    throw new StageCliError('schema_version=2 requires planning_mode=design-freeze');
  }
  const readiness = manifest.planning_readiness as any;
  if (!readiness || typeof readiness !== 'object' || readiness.design_freeze !== true) {
    throw new StageCliError('schema_version=2 requires planning_readiness.design_freeze=true');
  }
  assertStringArray(readiness.required_gates, 'planning_readiness.required_gates');
  if (readiness.required_gates.length === 0 || new Set(readiness.required_gates).size !== readiness.required_gates.length) {
    throw new StageCliError('planning_readiness.required_gates must be non-empty and unique');
  }
  if (!readiness.gates || typeof readiness.gates !== 'object' || Array.isArray(readiness.gates)) {
    throw new StageCliError('planning_readiness.gates must be an object');
  }
  for (const gate of readiness.required_gates) {
    const record = readiness.gates[gate];
    if (!record || record.required !== true || record.status !== 'ready') {
      throw new StageCliError(`PLANNING_GATE_NOT_READY: ${gate}`);
    }
    assertFrozenArtifactShape(record.artifact, `planning_readiness.gates.${gate}.artifact`);
    if (record.review !== undefined) {
      assertFrozenArtifactShape(record.review, `planning_readiness.gates.${gate}.review`);
    }
    if (record.cycles !== undefined && (!Number.isInteger(record.cycles) || record.cycles < 1 || record.cycles > 3)) {
      throw new StageCliError(`planning gate cycles must be 1..3: ${gate}`);
    }
    if (record.blocking_decision_ids !== undefined) {
      assertStringArray(record.blocking_decision_ids, `planning_readiness.gates.${gate}.blocking_decision_ids`);
      if (record.blocking_decision_ids.length) {
        throw new StageCliError(`ready planning gate has blocking decisions: ${gate}`);
      }
    }
  }
  const required = readiness.required_artifacts;
  if (!required || typeof required !== 'object' || Array.isArray(required)) {
    throw new StageCliError('planning_readiness.required_artifacts is required');
  }
  for (const key of [
    'decision_register',
    'technology_evidence',
    'contract_inventory',
    'test_strategy',
    'accepted_risks',
    'work_items',
  ]) {
    assertFrozenArtifactShape(required[key], `planning_readiness.required_artifacts.${key}`);
  }
  if (!Array.isArray(manifest.open_decisions) || manifest.open_decisions.length !== 0) {
    throw new StageCliError('schema_version=2 requires open_decisions=[] before init');
  }
}

function assertV2WorkItems(manifest: PipelineManifest): void {
  if (!Array.isArray(manifest.work_items) || manifest.work_items.length === 0) {
    throw new StageCliError('schema_version=2 requires frozen work_items');
  }
  const pipelineIds = new Set(manifest.pipelines.map((pipeline) => pipeline.id));
  const items = new Map<string, { pipeline_id: string }>();
  for (const item of manifest.work_items) {
    if (!item || typeof item.id !== 'string' || !item.id || items.has(item.id)) {
      throw new StageCliError('work_items must have unique non-empty ids');
    }
    if (!pipelineIds.has(item.pipeline_id)) {
      throw new StageCliError(`work item references unknown pipeline: ${item.id}`);
    }
    if (!safeRepoPath(item.path)) throw new StageCliError(`work item path is unsafe: ${item.id}`);
    assertSha256Value(item.sha256, `work_items.${item.id}.sha256`);
    items.set(item.id, { pipeline_id: item.pipeline_id });
  }
  for (const pipeline of manifest.pipelines) {
    assertStringArray(pipeline.work_items, `${pipeline.id}.work_items`);
    if (!pipeline.work_items.length) throw new StageCliError(`pipeline has no frozen work items: ${pipeline.id}`);
    for (const id of pipeline.work_items) {
      if (items.get(id)?.pipeline_id !== pipeline.id) {
        throw new StageCliError(`invalid work-item mapping: ${pipeline.id}/${id}`);
      }
    }
    for (const field of ['decision_ids', 'research_ids', 'contract_ids'] as const) {
      assertStringArray(pipeline[field], `${pipeline.id}.${field}`);
    }
    assertOptionalPathArray(pipeline.exclusive_paths, `${pipeline.id}.exclusive_paths`);
    assertOptionalPathArray(pipeline.migration_paths, `${pipeline.id}.migration_paths`);
    assertOptionalPathArray(pipeline.fixture_paths, `${pipeline.id}.fixture_paths`);
    if (pipeline.conflict_group !== undefined && (!pipeline.conflict_group || typeof pipeline.conflict_group !== 'string')) {
      throw new StageCliError(`${pipeline.id}.conflict_group must be a non-empty string`);
    }
    for (const [field, stage] of [
      ['ready_after_stage', pipeline.ready_after_stage],
      ['release_ready_after_stage', pipeline.release_ready_after_stage],
    ] as const) {
      if (stage !== undefined && !pipeline.stages.includes(stage)) {
        throw new StageCliError(`${pipeline.id}.${field} must reference an existing stage`);
      }
    }
    if (pipeline.ready_after_stage && pipeline.release_ready_after_stage) {
      if (pipeline.stages.indexOf(pipeline.ready_after_stage) > pipeline.stages.indexOf(pipeline.release_ready_after_stage)) {
        throw new StageCliError(`${pipeline.id} ready_after_stage must not follow release_ready_after_stage`);
      }
    }
  }
}

function assertV2Manifest(manifest: PipelineManifest): void {
  assertV2PlanningShape(manifest);
  assertV2WorkItems(manifest);
  if (manifest.source_type === 'github_issues') {
    assertSha256Value(manifest.source_snapshot_sha256, 'source_snapshot_sha256');
  }
  if (manifest.project_policy !== undefined) {
    if (!manifest.project_policy || !safeRepoPath(manifest.project_policy.path)) {
      throw new StageCliError('project_policy.path must be repository-relative and safe');
    }
    assertSha256Value(manifest.project_policy.sha256, 'project_policy.sha256');
  }
}

function assertManifest(value: unknown): asserts value is PipelineManifest {
  if (!value || typeof value !== 'object') throw new StageCliError('Manifest must be an object');
  const manifest = value as Partial<PipelineManifest>;
  if (
    ![1, 2].includes(Number(manifest.schema_version)) ||
    typeof manifest.run_id !== 'string' ||
    manifest.run_id.length === 0 ||
    typeof manifest.rules_file !== 'string' ||
    typeof manifest.rules_version !== 'number' ||
    !Array.isArray(manifest.pipelines) ||
    manifest.pipelines.length === 0
  ) {
    throw new StageCliError(
      'Manifest must define schema_version=1, run_id, rules_file, rules_version and pipelines',
    );
  }

  assertOptionalPathArray(manifest.allowed_change_paths, 'allowed_change_paths');
  assertGitSetup(manifest.git_setup, manifest.allowed_change_paths);
  assertIssueSource(manifest as PipelineManifest);
  assertGateProfiles(manifest.gate_profiles);
  if (manifest.open_decisions !== undefined) {
    assertStringArray(manifest.open_decisions, 'open_decisions');
    if (manifest.planning_mode === 'design-freeze' && manifest.open_decisions.length > 0) {
      throw new StageCliError('design-freeze manifest has unresolved open_decisions');
    }
  }

  const ids = new Set<string>();
  for (const pipeline of manifest.pipelines) {
    if (
      !pipeline ||
      typeof pipeline !== 'object' ||
      typeof pipeline.id !== 'string' ||
      pipeline.id.length === 0 ||
      !Array.isArray(pipeline.stages) ||
      pipeline.stages.length === 0 ||
      pipeline.stages.some((stage) => typeof stage !== 'string' || stage.length === 0)
    ) {
      throw new StageCliError('Every pipeline must define id and non-empty stages');
    }
    if (ids.has(pipeline.id)) throw new StageCliError(`Duplicate pipeline id: ${pipeline.id}`);
    ids.add(pipeline.id);
    if (new Set(pipeline.stages).size !== pipeline.stages.length) {
      throw new StageCliError(`Duplicate stage in pipeline: ${pipeline.id}`);
    }
    if (pipeline.depends_on !== undefined) assertStringArray(pipeline.depends_on, `${pipeline.id}.depends_on`);
    if (pipeline.runtime_locks !== undefined) assertStringArray(pipeline.runtime_locks, `${pipeline.id}.runtime_locks`);
    if (pipeline.issue_numbers !== undefined) {
      if (!Array.isArray(pipeline.issue_numbers) || pipeline.issue_numbers.some((value) => !Number.isInteger(value) || value <= 0)) {
        throw new StageCliError(`${pipeline.id}.issue_numbers must contain positive integers`);
      }
    }
  }
  assertDependencyGraph(manifest.pipelines);
  if (manifest.schema_version === 2) assertV2Manifest(manifest as PipelineManifest);
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
  return async () => rm(lockPath(stateRoot, runId), { force: true });
}

async function readState(stateRoot: string, runId: string): Promise<PipelineState> {
  try {
    return JSON.parse(await readFile(statePath(stateRoot, runId), 'utf8')) as PipelineState;
  } catch {
    throw new StageCliError(`State not found or invalid: ${runId}`);
  }
}

function createPipelineRuntime(pipeline: PipelineManifestPipeline): PipelineRuntime {
  const stageRuntime: Record<string, StageRuntime> = {};
  for (const stage of pipeline.stages) stageRuntime[stage] = { status: 'pending' };
  return {
    id: pipeline.id,
    status: 'planned',
    stages: stageRuntime,
    stage_order: [...pipeline.stages],
    depends_on: [...(pipeline.depends_on ?? [])],
    ...(pipeline.issue_numbers?.length ? { issue_numbers: [...pipeline.issue_numbers] } : {}),
    ...(pipeline.ready_after_stage ? { ready_after_stage: pipeline.ready_after_stage } : {}),
    ...(pipeline.release_ready_after_stage ? { release_ready_after_stage: pipeline.release_ready_after_stage } : {}),
  };
}

function sameStrings(a: string[] | undefined, b: string[] | undefined): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

function assertStateMatchesManifest(state: PipelineState, manifest: PipelineManifest): void {
  if (state.run_id !== manifest.run_id) throw new StageCliError('State run_id does not match frozen manifest');
  const manifestIds = manifest.pipelines.map((pipeline) => pipeline.id);
  const stateIds = Object.keys(state.pipelines);
  if (!sameStrings(stateIds, manifestIds)) throw new StageCliError('State pipelines do not match frozen manifest');
  for (const spec of manifest.pipelines) {
    const runtime = state.pipelines[spec.id];
    if (!runtime) throw new StageCliError(`Missing runtime pipeline: ${spec.id}`);
    if (!sameStrings(runtime.stage_order, spec.stages)) throw new StageCliError(`Stage order changed: ${spec.id}`);
    if (!sameStrings(runtime.depends_on, spec.depends_on)) throw new StageCliError(`Dependencies changed: ${spec.id}`);
    if (runtime.ready_after_stage !== spec.ready_after_stage) throw new StageCliError(`ready milestone changed: ${spec.id}`);
    if (runtime.release_ready_after_stage !== spec.release_ready_after_stage) throw new StageCliError(`release milestone changed: ${spec.id}`);
  }
}

export async function initFromManifest(
  manifestPath: string,
  stateRoot = DEFAULT_STATE_ROOT,
): Promise<PipelineState> {
  const absoluteManifestPath = resolve(manifestPath);
  const manifestContent = await readFile(absoluteManifestPath, 'utf8');
  const manifest = JSON.parse(manifestContent) as unknown;
  assertManifest(manifest);

  const rules = await resolveEffectiveRules(manifest.rules_file, absoluteManifestPath);
  if (rules.metadata.rules_version !== manifest.rules_version) {
    throw new StageCliError('Manifest rules_version does not match effective rules file');
  }

  const timestamp = now();
  const initialOutbox: PipelineGithubOutboxEvent[] = manifest.source_type === 'github_issues'
    ? manifest.pipelines.flatMap((pipeline, index) => pipeline.issue_numbers?.length ? [{
        id: `pipeline-status:${pipeline.id}:${index + 1}:created:planned`,
        kind: 'pipeline_status' as const,
        pipeline_id: pipeline.id,
        issue_numbers: [...pipeline.issue_numbers],
        to_status: 'planned' as const,
        created_at: timestamp,
        delivered_issue_numbers: [],
      }] : [])
    : [];

  const state: PipelineState = {
    schema_version: 1,
    run_id: manifest.run_id,
    manifest_file: absoluteManifestPath,
    manifest_sha256: sha256(manifestContent),
    rules_file: rules.path,
    rules_source: rules.source,
    rules_version: rules.metadata.rules_version,
    rules_sha256: rules.sha256,
    status: 'planned',
    created_at: timestamp,
    updated_at: timestamp,
    active_stages: [],
    ...(manifest.source_type ? { source_type: manifest.source_type } : {}),
    ...(manifest.repository ? { repository: manifest.repository } : {}),
    ...(manifest.source_issues ? { source_issues: manifest.source_issues.map((issue) => ({ ...issue })) } : {}),
    ...(manifest.source_snapshot_sha256 ? { source_snapshot_sha256: manifest.source_snapshot_sha256 } : {}),
    ...(manifest.project_policy ? {
      project_policy_file: resolve(manifest.project_policy.path),
      project_policy_sha256: manifest.project_policy.sha256,
    } : {}),
    ...(manifest.planning_base_sha || manifest.git_setup?.base_sha
      ? { planning_base_sha: manifest.planning_base_sha ?? manifest.git_setup?.base_sha,
          run_base_sha: manifest.planning_base_sha ?? manifest.git_setup?.base_sha }
      : {}),
    ...(manifest.source_type === 'github_issues' && manifest.repository && manifest.source_issues
      ? { issue_results: manifest.source_issues.map((issue) => ({
          repository: manifest.repository!,
          number: issue.number,
          status: 'pending' as const,
        })), github_outbox: initialOutbox }
      : {}),
    pipelines: Object.fromEntries(
      manifest.pipelines.map((pipeline) => [pipeline.id, createPipelineRuntime(pipeline)]),
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

export async function validateState(stateRoot: string, runId: string): Promise<PipelineState> {
  const state = await readState(stateRoot, runId);
  const source: RulesSource = state.rules_source ?? 'project';
  const rules = await loadResolvedRules(state.rules_file, source);
  if (rules.metadata.rules_version !== state.rules_version) {
    throw new StageCliError('Rules version changed since pipeline initialization');
  }
  if (rules.sha256 !== state.rules_sha256) {
    throw new StageCliError('Rules file changed since pipeline initialization');
  }

  if (state.manifest_file && state.manifest_sha256) {
    const manifestContent = await readFile(state.manifest_file, 'utf8').catch(() => {
      throw new StageCliError('Frozen manifest is missing');
    });
    if (sha256(manifestContent) !== state.manifest_sha256) {
      throw new StageCliError('Manifest changed since pipeline initialization');
    }
    const manifest = JSON.parse(manifestContent) as unknown;
    assertManifest(manifest);
    assertStateMatchesManifest(state, manifest);
  }

  if (state.source_snapshot_sha256 && state.manifest_file) {
    const snapshotPath = join(dirname(state.manifest_file), 'sources', 'github-issues.json');
    const snapshot = await readFile(snapshotPath, 'utf8').catch(() => {
      throw new StageCliError('Frozen GitHub Issue snapshot is missing');
    });
    if (sha256(snapshot) !== state.source_snapshot_sha256) {
      throw new StageCliError('Frozen GitHub Issue snapshot changed since pipeline initialization');
    }
  }
  if (state.project_policy_file && state.project_policy_sha256) {
    const policy = await readFile(state.project_policy_file, 'utf8').catch(() => {
      throw new StageCliError('Frozen project policy is missing');
    });
    if (sha256(policy) !== state.project_policy_sha256) {
      throw new StageCliError('Frozen project policy changed since pipeline initialization');
    }
  }

  for (const pipeline of Object.values(state.pipelines)) {
    if (pipeline.stage_order.length === 0) throw new StageCliError(`Pipeline has no stages: ${pipeline.id}`);
    for (const stage of pipeline.stage_order) {
      if (!pipeline.stages[stage]) throw new StageCliError(`Missing runtime state for stage: ${pipeline.id}/${stage}`);
    }
  }
  return state;
}

function getPipeline(state: PipelineState, pipelineId?: string): PipelineRuntime {
  const pipelines = Object.values(state.pipelines);
  if (pipelineId) {
    const pipeline = state.pipelines[pipelineId];
    if (!pipeline) throw new StageCliError(`Pipeline not found: ${pipelineId}`);
    return pipeline;
  }
  if (pipelines.length !== 1) throw new StageCliError('pipeline_id is required when run has multiple pipelines');
  return pipelines[0] as PipelineRuntime;
}

function dependenciesComplete(state: PipelineState, pipeline: PipelineRuntime): boolean {
  return (pipeline.depends_on ?? []).every((id) => state.pipelines[id]?.status === 'completed');
}

function firstPendingStage(pipeline: PipelineRuntime): string | undefined {
  if (Object.values(pipeline.stages).some((stage) => stage.status === 'in_progress')) return undefined;
  for (let index = 0; index < pipeline.stage_order.length; index += 1) {
    const stage = pipeline.stage_order[index] as string;
    const runtime = pipeline.stages[stage];
    if (!runtime) return undefined;
    if (runtime.status === 'pending') {
      const prior = pipeline.stage_order.slice(0, index).map((name) => pipeline.stages[name]?.status);
      return prior.every((status) => status === 'completed' || status === 'skipped') ? stage : undefined;
    }
    if (runtime.status === 'blocked' || runtime.status === 'failed') return undefined;
  }
  return undefined;
}

export function computeRunnable(state: PipelineState): RunnableStage[] {
  const runnable: RunnableStage[] = [];
  for (const pipeline of Object.values(state.pipelines)) {
    if (!['approved', 'in_progress', 'ready', 'release_ready'].includes(pipeline.status)) continue;
    if (!dependenciesComplete(state, pipeline)) continue;
    const stage = firstPendingStage(pipeline);
    if (stage) runnable.push({ pipeline_id: pipeline.id, stage });
  }
  return runnable;
}

function refreshActiveStages(state: PipelineState): void {
  const active: string[] = [];
  for (const pipeline of Object.values(state.pipelines)) {
    for (const stage of pipeline.stage_order) {
      if (pipeline.stages[stage]?.status === 'in_progress') active.push(`${pipeline.id}/${stage}`);
    }
  }
  state.active_stages = active;
  state.current_stage = active.length === 1 ? active[0] : undefined;
}

function recalculateRunStatus(state: PipelineState): void {
  refreshActiveStages(state);
  const pipelines = Object.values(state.pipelines);
  if (pipelines.length > 0 && pipelines.every((pipeline) => pipeline.status === 'completed')) {
    state.status = 'completed';
    return;
  }
  if (pipelines.some((pipeline) => pipeline.status === 'failed')) {
    state.status = 'failed';
    return;
  }
  if (pipelines.some((pipeline) => pipeline.status === 'blocked')) {
    state.status = 'blocked';
    return;
  }
  if (pipelines.some((pipeline) => pipeline.status === 'in_progress')) {
    state.status = 'in_progress';
    return;
  }
  if (computeRunnable(state).length > 0) {
    if (pipelines.every((pipeline) => ['release_ready', 'completed'].includes(pipeline.status))) {
      state.status = 'release_ready';
    } else if (pipelines.every((pipeline) => ['ready', 'release_ready', 'completed'].includes(pipeline.status))) {
      state.status = 'ready';
    } else if (pipelines.some((pipeline) => ['ready', 'release_ready'].includes(pipeline.status))) {
      state.status = 'in_progress';
    } else {
      state.status = 'approved';
    }
    return;
  }
  state.status = pipelines.some((pipeline) => pipeline.status === 'approved') ? 'approved' : 'planned';
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

function queuePipelineStatusTransitions(
  state: PipelineState,
  before: Map<string, PipelineRuntime['status']>,
): void {
  if (state.source_type !== 'github_issues') return;
  state.github_outbox ??= [];
  for (const pipeline of Object.values(state.pipelines)) {
    const previous = before.get(pipeline.id);
    if (!previous || previous === pipeline.status || !pipeline.issue_numbers?.length) continue;
    const sequence = state.github_outbox.length + 1;
    state.github_outbox.push({
      id: `pipeline-status:${pipeline.id}:${sequence}:${previous}:${pipeline.status}`,
      kind: 'pipeline_status',
      pipeline_id: pipeline.id,
      issue_numbers: [...pipeline.issue_numbers],
      from_status: previous,
      to_status: pipeline.status,
      created_at: now(),
      delivered_issue_numbers: [],
    });
  }
}

async function updateState(
  stateRoot: string,
  runId: string,
  updater: (state: PipelineState) => void,
): Promise<PipelineState> {
  const unlock = await acquireLock(stateRoot, runId);
  try {
    const state = await validateState(stateRoot, runId);
    const before = new Map(Object.values(state.pipelines).map((pipeline) => [pipeline.id, pipeline.status]));
    updater(state);
    recalculateRunStatus(state);
    queuePipelineStatusTransitions(state, before);
    state.updated_at = now();
    await writeJsonAtomic(statePath(stateRoot, runId), state);
    return state;
  } finally {
    await unlock();
  }
}

export async function approvePipeline(stateRoot: string, runId: string): Promise<PipelineState> {
  return updateState(stateRoot, runId, (state) => {
    if (state.status !== 'planned') throw new StageCliError(`Cannot approve run while it is ${state.status}`);
    for (const pipeline of Object.values(state.pipelines)) {
      if (pipeline.status !== 'planned') throw new StageCliError(`Pipeline is not planned: ${pipeline.id}`);
      pipeline.status = 'approved';
    }
  });
}

function assertPipelineDependencies(state: PipelineState, pipeline: PipelineRuntime): void {
  for (const dependency of pipeline.depends_on ?? []) {
    if (state.pipelines[dependency]?.status !== 'completed') {
      throw new StageCliError(`Pipeline dependency is not completed: ${pipeline.id} -> ${dependency}`);
    }
  }
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
    if (!runtime) throw new StageCliError(`Stage not found: ${pipeline.id}/${stage}`);
    if (runtime.status !== 'pending') throw new StageCliError(`Stage is not pending: ${pipeline.id}/${stage}`);
    if (!['approved', 'in_progress', 'ready', 'release_ready'].includes(pipeline.status)) {
      throw new StageCliError(`Cannot start stage while pipeline is ${pipeline.status}: ${pipeline.id}`);
    }
    assertPipelineDependencies(state, pipeline);

    const expected = firstPendingStage(pipeline);
    if (expected !== stage) throw new StageCliError(`Stage is not next for ${pipeline.id}: expected=${expected ?? 'none'}`);

    pipeline.status = 'in_progress';
    runtime.status = 'in_progress';
    runtime.started_at = now();
    pipeline.current_stage = stage;
    addHistory(state, pipeline.id, stage, 'in_progress');
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

    const stageDone = (name: string | undefined): boolean => {
      if (!name) return false;
      const index = pipeline.stage_order.indexOf(name);
      if (index < 0) return false;
      return pipeline.stage_order.slice(0, index + 1).every((item) => {
        const status = pipeline.stages[item]?.status;
        return status === 'completed' || status === 'skipped';
      });
    };
    const allCompleted = pipeline.stage_order.every((item) => {
      const status = pipeline.stages[item]?.status;
      return status === 'completed' || status === 'skipped';
    });
    if (allCompleted) pipeline.status = 'completed';
    else if (stageDone(pipeline.release_ready_after_stage)) pipeline.status = 'release_ready';
    else if (stageDone(pipeline.ready_after_stage)) pipeline.status = 'ready';
    else pipeline.status = 'in_progress';
    if (allCompleted) pipeline.current_stage = undefined;
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
    pipeline.status = status;
    pipeline.current_stage = undefined;
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
    assertPipelineDependencies(state, pipeline);
    runtime.status = 'in_progress';
    runtime.started_at = now();
    runtime.completed_at = undefined;
    runtime.evidence = undefined;
    pipeline.status = 'in_progress';
    pipeline.current_stage = stage;
    addHistory(state, pipeline.id, stage, 'in_progress', 'resumed');
  });
}

function parseOptions(args: string[]): { positional: string[]; options: StageCommandOptions } {
  const positional: string[] = [];
  const options: StageCommandOptions = { json: false, stateRoot: DEFAULT_STATE_ROOT };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--json') options.json = true;
    else if (argument === '--state-root') options.stateRoot = args[++index] ?? DEFAULT_STATE_ROOT;
    else if (argument === '--pipeline') options.pipelineId = args[++index];
    else if (argument === '--message') options.message = args[++index];
    else if (argument === '--evidence') options.evidencePath = args[++index];
    else if (argument === '--environment') options.environment = true;
    else if (argument?.startsWith('--')) throw new StageCliError(`Unknown option: ${argument}`);
    else if (argument) positional.push(argument);
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
  if (state.active_stages?.length) console.log(`Active: ${state.active_stages.join(', ')}`);
  for (const pipeline of Object.values(state.pipelines)) {
    console.log(`\n${pipeline.id}: ${pipeline.status}`);
    for (const stage of pipeline.stage_order) {
      const status = pipeline.stages[stage]?.status ?? 'unknown';
      const marker = status === 'completed' ? '✓' : status === 'in_progress' ? '→' : '○';
      console.log(`  ${marker} ${stage}: ${status}`);
    }
  }
}

function printRunnable(state: PipelineState, asJson: boolean): void {
  const runnable = computeRunnable(state);
  if (asJson) console.log(JSON.stringify({ run_id: state.run_id, status: state.status, runnable }, null, 2));
  else if (runnable.length === 0) console.log('No runnable stages');
  else for (const item of runnable) console.log(`${item.pipeline_id}/${item.stage}`);
}

function printRules(rules: ResolvedRules, asJson: boolean): void {
  const output = {
    status: 'PASS',
    rules_source: rules.source,
    rules_file: rules.path,
    rules_version: rules.metadata.rules_version,
    rules_sha256: rules.sha256,
  };
  if (asJson) console.log(JSON.stringify(output, null, 2));
  else {
    console.log(`PASS rules_source=${output.rules_source}`);
    console.log(`rules_file=${output.rules_file}`);
    console.log(`rules_version=${output.rules_version}`);
    console.log(`rules_sha256=${output.rules_sha256}`);
  }
}

function usage(): string {
  return [
    'Usage:',
    '  stage-cli rules [rules-file] [--json]',
    '  stage-cli preflight <manifest> [--environment] [--json]',
    '  stage-cli init <manifest> [--state-root <path>] [--environment]',
    '  stage-cli approve <run-id> [--state-root <path>]',
    '  stage-cli status <run-id> [--json] [--state-root <path>]',
    '  stage-cli validate <run-id> [--json] [--state-root <path>]',
    '  stage-cli next <run-id> [--json] [--state-root <path>]',
    '  stage-cli start <run-id> <stage> [--pipeline <id>]',
    '  stage-cli complete <run-id> <stage> [--pipeline <id>] [--message <text>] [--evidence <path>]',
    '  stage-cli fail|block <run-id> <stage> [--pipeline <id>] [--message <text>] [--evidence <path>]',
    '  stage-cli resume <run-id> <stage> [--pipeline <id>]',
  ].join('\n');
}

export async function runCli(args: string[]): Promise<void> {
  const { positional, options } = parseOptions(args);
  const command = positional[0];
  if (!command) throw new StageCliError(usage());

  if (command === 'rules') {
    printRules(await resolveEffectiveRules(positional[1] ?? 'docs/pipeline-rules.md'), options.json);
    return;
  }
  if (command === 'preflight') {
    const manifest = positional[1];
    if (!manifest) throw new StageCliError('Manifest path is required');
    const { preflightFile } = await import('./manifest-preflight.mjs');
    const result = await preflightFile(manifest, { environment: options.environment, cwd: process.cwd() });
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else console.log('PASS checked_commands=' + result.checked_commands + ' environment_checked=' + result.environment_checked);
    return;
  }
  if (command === 'init') {
    const manifest = positional[1];
    if (!manifest) throw new StageCliError('Manifest path is required');
    const { preflightFile } = await import('./manifest-preflight.mjs');
    await preflightFile(manifest, { environment: options.environment, cwd: process.cwd() });
    printState(await initFromManifest(manifest, options.stateRoot), options.json);
    return;
  }

  const runId = positional[1];
  if (!runId) throw new StageCliError('run-id is required');
  if (command === 'status') {
    printState(await readState(options.stateRoot, runId), options.json);
    return;
  }
  if (command === 'validate') {
    const state = await validateState(options.stateRoot, runId);
    if (options.json) console.log(JSON.stringify(state, null, 2));
    else console.log(`Valid: ${runId} status=${state.status}`);
    return;
  }
  if (command === 'next') {
    printRunnable(await validateState(options.stateRoot, runId), options.json);
    return;
  }
  if (command === 'approve') {
    const state = await readState(options.stateRoot, runId);
    if (!state.manifest_file) throw new StageCliError('Frozen manifest is missing');
    const { preflightFile } = await import('./manifest-preflight.mjs');
    await preflightFile(state.manifest_file, { environment: true, cwd: process.cwd() });
    printState(await approvePipeline(options.stateRoot, runId), options.json);
    return;
  }

  const stage = positional[2];
  if (!stage) throw new StageCliError('stage is required');
  let state: PipelineState;
  if (command === 'start') state = await startStage(options.stateRoot, runId, stage, options.pipelineId);
  else if (command === 'complete') {
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
  } else if (command === 'resume') state = await resumeStage(options.stateRoot, runId, stage, options.pipelineId);
  else throw new StageCliError(`Unknown command: ${command}\n\n${usage()}`);
  printState(state, options.json);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`stage-cli: ${message}`);
    process.exitCode = 1;
  });
}
