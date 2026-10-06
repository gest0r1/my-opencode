import { acceptedReconciliations } from './reconcile-evidence.ts';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { access, cp, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
const DEFAULT_TECHNICAL_FIX_LIMIT = 5;
const MAX_TECHNICAL_FIX_LIMIT = 20;
const STATE_FILE = 'state.json';
const LOCK_FILE = '.lock';
const HUMAN_ONLY = 'human_only';
const DISTRIBUTION_ONLY = 'distribution_only';
const SUPERSEDE_REASONS = new Set([
  'MANIFEST_CONTRACT_CORRECTION',
  'BASELINE_SCOPE_MISMATCH',
  'PLANNING_EVIDENCE_CORRECTION',
  'OWNER_SCOPE_CHANGE',
  'ARCHITECTURE_REPLAN',
  'MAIN_DRIFT_REPLAN',
]);
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
  reason?: string;
  scopeClass?: 'test' | 'technical';
  repairClass?: 'technical_fix' | 'security_fix';
  cycles?: number;
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

function safeScopePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false;
  if (value.endsWith('/**')) {
    const base = value.slice(0, -3).replace(/\/$/, '');
    return safeRepoPath(base) && !/[?*\[\]{}]/.test(base);
  }
  return safeRepoPath(value) && !/[?*\[\]{}]/.test(value);
}

function assertOptionalPathArray(value: unknown, field: string): void {
  if (value === undefined) return;
  assertStringArray(value, field);
  if (value.some((item) => !safeScopePath(item))) {
    throw new StageCliError(
      `${field} supports only exact repository-relative paths or directory/** scopes`,
    );
  }
}

function pathMatchesScope(path: string, scope: string): boolean {
  if (scope.endsWith('/**')) {
    const prefix = scope.slice(0, -3).replace(/\/$/, '');
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  return path === scope;
}

function effectiveAllowedChangePaths(manifest: PipelineManifest, state: PipelineState): string[] {
  return [
    ...(manifest.allowed_change_paths ?? []),
    ...(state.runtime_scope_extensions ?? []).flatMap((entry) => entry.paths),
  ];
}

function componentRoot(path: string): string | undefined {
  const parts = path.split('/');
  if ((parts[0] === 'apps' || parts[0] === 'packages') && parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return undefined;
}

function isTestSupportPath(path: string): boolean {
  const parts = path.split('/');
  const testSegment = parts.some((part) =>
    ['test', 'tests', '__tests__', 'fixtures', 'fixture', 'mocks', '__mocks__', 'snapshots', '__snapshots__'].includes(part));
  const testFile = /(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/i.test(path);
  return testSegment || testFile;
}

function canAutoExtendTestScope(path: string, manifest: PipelineManifest, state: PipelineState): boolean {
  if (!isTestSupportPath(path)) return false;
  const root = componentRoot(path);
  if (!root) return false;
  return effectiveAllowedChangePaths(manifest, state).some((scope) => {
    const normalized = scope.endsWith('/**') ? scope.slice(0, -3).replace(/\/$/, '') : scope;
    return normalized === root || normalized.startsWith(`${root}/`);
  });
}

function readFrozenManifestFromState(state: PipelineState): PipelineManifest {
  if (!state.manifest_file) throw new StageCliError('Frozen manifest is missing');
  try {
    return JSON.parse(readFileSync(state.manifest_file, 'utf8')) as PipelineManifest;
  } catch {
    throw new StageCliError('Frozen manifest is missing or invalid');
  }
}

function scopeOutput(state: PipelineState, manifest: PipelineManifest, paths: string[]) {
  return {
    status: 'PASS' as const,
    run_id: state.run_id,
    requested_paths: paths,
    effective_allowed_change_paths: effectiveAllowedChangePaths(manifest, state),
    runtime_scope_extensions: state.runtime_scope_extensions ?? [],
  };
}

function runtimeScopeSensitive(path: string): boolean {
  const name = path.split('/').pop() ?? path;
  return path === 'docs/pipeline-rules.md' ||
    path.startsWith('.github/workflows/') ||
    path.startsWith('.opencode/') ||
    name === '.env' ||
    (/^\.env\./.test(name) && name !== '.env.example') ||
    /\.(key|pem|p12|pfx|secret)$/i.test(name);
}

function runtimeScopeProtectedByPolicy(manifest: PipelineManifest, path: string): boolean {
  if (!manifest.project_policy?.path) return false;
  let policy: any;
  try {
    policy = JSON.parse(readFileSync(resolve(manifest.project_policy.path), 'utf8'));
  } catch {
    throw new StageCliError('Project policy is missing or invalid while checking runtime scope');
  }
  return (policy.protected_paths ?? []).some((scope: string) =>
    typeof scope === 'string' && pathMatchesScope(path, scope));
}

function assertRuntimeScopeExtensible(manifest: PipelineManifest, path: string): void {
  if (runtimeScopeSensitive(path) || runtimeScopeProtectedByPolicy(manifest, path)) {
    throw new StageCliError(
      `OWNER_OR_REPLAN_REQUIRED: runtime scope cannot auto-authorize protected/sensitive path: ${path}`,
    );
  }
}

export async function hashRunArtifacts(
  stateRoot: string,
  runId: string,
  artifactPaths: string[],
): Promise<{ status: 'PASS'; run_id: string; artifacts: Array<{ path: string; sha256: string }> }> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new StageCliError('run-id must be path-safe');
  }
  if (!artifactPaths.length) throw new StageCliError('at least one artifact path is required');
  const root = resolve(stateRoot, runId);
  const artifacts: Array<{ path: string; sha256: string }> = [];
  for (const artifactPath of artifactPaths) {
    if (!safeRepoPath(artifactPath)) throw new StageCliError(`unsafe artifact path: ${artifactPath}`);
    const absolute = resolve(root, artifactPath);
    if (!absolute.startsWith(`${root}/`)) throw new StageCliError(`artifact escapes run root: ${artifactPath}`);
    const content = await readFile(absolute, 'utf8').catch(() => {
      throw new StageCliError(`artifact not found: ${artifactPath}`);
    });
    artifacts.push({ path: artifactPath, sha256: sha256(content) });
  }
  return { status: 'PASS', run_id: runId, artifacts };
}

export async function inspectProjectPolicy(
  policyPath = '.opencode/pipeline-policy.json',
): Promise<Record<string, unknown>> {
  if (!safeRepoPath(policyPath)) throw new StageCliError('project policy path must be repository-relative and safe');
  const absolute = resolve(policyPath);
  if (!(await fileExists(absolute))) return { status: 'ABSENT', path: policyPath };
  const content = await readFile(absolute, 'utf8');
  let policy: any;
  try {
    policy = JSON.parse(content);
  } catch {
    throw new StageCliError('project policy is not valid JSON');
  }
  if (policy?.schema_version !== 1) throw new StageCliError('project policy schema_version must be 1');
  return {
    status: 'PASS',
    path: policyPath,
    sha256: sha256(content),
    schema_version: 1,
    protected_paths: Array.isArray(policy.protected_paths) ? policy.protected_paths : [],
    required_gates: Array.isArray(policy.required_gates) ? policy.required_gates : [],
    github_actions: policy.github_actions && typeof policy.github_actions === 'object' ? policy.github_actions : undefined,
    deployment_target: policy.deployment_target && typeof policy.deployment_target === 'object' ? policy.deployment_target : undefined,
  };
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
  for (const key of ['decision_register', 'work_items']) {
    assertFrozenArtifactShape(required[key], `planning_readiness.required_artifacts.${key}`);
  }
  for (const key of ['technology_evidence', 'contract_inventory']) {
    if (required[key] !== undefined) {
      assertFrozenArtifactShape(required[key], `planning_readiness.required_artifacts.${key}`);
    }
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
    assertSha256Value(manifest.source_requirements_sha256, 'source_requirements_sha256');
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
    Number(manifest.schema_version) !== 2 ||
    typeof manifest.run_id !== 'string' ||
    manifest.run_id.length === 0 ||
    typeof manifest.rules_file !== 'string' ||
    typeof manifest.rules_version !== 'number' ||
    !Array.isArray(manifest.pipelines) ||
    manifest.pipelines.length === 0
  ) {
    throw new StageCliError(
      'Manifest must define schema_version=2, run_id, rules_file, rules_version and pipelines',
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
  assertV2Manifest(manifest as PipelineManifest);
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
  for (const stage of pipeline.stages) stageRuntime[stage] = { status: 'pending', technical_fix_limit: DEFAULT_TECHNICAL_FIX_LIMIT };
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
    ...(manifest.source_requirements_sha256 ? { source_requirements_sha256: manifest.source_requirements_sha256 } : {}),
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
  const revision = await readFile(join(dirname(absoluteManifestPath), 'planning/revision.json'), 'utf8').then(JSON.parse).catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (revision?.previous_approval === true && revision.owner_contract_changed === false) {
    state.status = 'approved';
    for (const pipeline of Object.values(state.pipelines)) pipeline.status = 'approved';
  }

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
  const effectiveRulesFile = source === 'opencode_default' ? DEFAULT_RULES_PATH : state.rules_file;
  const rules = await loadResolvedRules(effectiveRulesFile, source);

  if (rules.path !== state.rules_file ||
      rules.metadata.rules_version !== state.rules_version ||
      rules.sha256 !== state.rules_sha256) {
    const previousFile = state.rules_file;
    const previousSha = state.rules_sha256;
    state.rules_file = rules.path;
    delete state.rules_origin_file;
    state.rules_version = rules.metadata.rules_version;
    state.rules_sha256 = rules.sha256;
    state.rules_refresh_history ??= [];
    state.rules_refresh_history.push({
      timestamp: now(),
      previous_file: previousFile,
      previous_sha256: previousSha,
      new_file: rules.path,
      new_sha256: rules.sha256,
    });
    state.updated_at = now();
    await writeJsonAtomic(statePath(stateRoot, runId), state);
  }

  if (state.manifest_file && state.manifest_sha256) {
    const manifestContent = await readFile(state.manifest_file, 'utf8').catch(() => {
      throw new StageCliError('Frozen manifest is missing');
    });
    if (sha256(manifestContent) !== state.manifest_sha256) {
      throw new StageCliError('Manifest changed since pipeline initialization');
    }
    const manifest = JSON.parse(manifestContent) as unknown;
    await acceptedReconciliations(dirname(state.manifest_file), state, state.manifest_sha256);
    assertManifest(manifest);
    assertStateMatchesManifest(state, manifest);
    const { validateManifestV2Policy } = await import('./manifest-v2-policy.mjs');
    try {
      validateManifestV2Policy(manifest as PipelineManifest, {
        cwd: process.cwd(),
        manifestPath: state.manifest_file,
      });
    } catch (error) {
      throw new StageCliError(
        `Frozen planning evidence validation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
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

function milestoneDone(pipeline: PipelineRuntime, stage: string | undefined): boolean {
  if (!stage) return pipeline.status === 'completed';
  const index = pipeline.stage_order.indexOf(stage);
  if (index < 0) return false;
  return pipeline.stage_order.slice(0, index + 1).every((name) => {
    const status = pipeline.stages[name]?.status;
    return status === 'completed' || status === 'skipped';
  });
}

function dependencyReady(state: PipelineState, dependencyId: string): boolean {
  const dependency = state.pipelines[dependencyId];
  if (!dependency) return false;
  return dependency.ready_after_stage
    ? milestoneDone(dependency, dependency.ready_after_stage)
    : dependency.status === 'completed';
}

function dependenciesComplete(state: PipelineState, pipeline: PipelineRuntime): boolean {
  return (pipeline.depends_on ?? []).every((id) => dependencyReady(state, id));
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

  const runnable = computeRunnable(state);
  const active = pipelines.some((pipeline) => pipeline.status === 'in_progress');
  if (active || runnable.length > 0) {
    if (!active &&
        pipelines.every((pipeline) => ['release_ready', 'completed'].includes(pipeline.status))) {
      state.status = 'release_ready';
    } else if (!active &&
               pipelines.every((pipeline) => ['ready', 'release_ready', 'completed'].includes(pipeline.status))) {
      state.status = 'ready';
    } else {
      // A blocked/failed pipeline may coexist with useful downstream/independent
      // work when its source-ready milestone was already reached.
      state.status = state.execution_started_at || state.history.some(event => event.status === 'in_progress') ? 'in_progress' : 'approved';
    }
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
    if (state.superseded_by) {
      throw new StageCliError(`RUN_SUPERSEDED: ${runId} -> ${state.superseded_by} reason=${String(state.supersede_reason ?? 'unknown')}`);
    }
    const before = new Map(Object.values(state.pipelines).map((pipeline) => [pipeline.id, pipeline.status]));
    updater(state);
    for (const decision of state.deferred_decisions ?? []) {
      if (decision.status !== 'pending') continue;
      const pipeline = state.pipelines[decision.pipeline_id];
      if (pipeline && firstPendingStage(pipeline) === decision.before_stage) {
        pipeline.stages[decision.before_stage].status = 'blocked';
        pipeline.stages[decision.before_stage].message = 'DEFERRED_OWNER_DECISION_REQUIRED';
        pipeline.status = 'blocked';
        addHistory(state, pipeline.id, decision.before_stage, 'blocked', `deferred owner decision ${decision.id}`);
      }
    }
    recalculateRunStatus(state);
    queuePipelineStatusTransitions(state, before);
    state.updated_at = now();
    await writeJsonAtomic(statePath(stateRoot, runId), state);
    return state;
  } finally {
    await unlock();
  }
}

export async function checkRuntimeScope(
  stateRoot: string,
  runId: string,
  stage: string,
  paths: string[],
  pipelineId?: string,
): Promise<{ status: 'PASS'; run_id: string; requested_paths: string[]; effective_allowed_change_paths: string[]; runtime_scope_extensions: NonNullable<PipelineState['runtime_scope_extensions']> }> {
  if (!paths.length) throw new StageCliError('scope-check requires at least one repository path');
  for (const path of paths) {
    if (!safeRepoPath(path) || /[?*\[\]{}]/.test(path)) {
      throw new StageCliError(`scope-check requires concrete safe repository paths: ${path}`);
    }
  }

  let output: ReturnType<typeof scopeOutput> | undefined;
  await updateState(stateRoot, runId, (state) => {
    const pipeline = getPipeline(state, pipelineId);
    if (!pipeline.stages[stage]) throw new StageCliError(`Stage not found: ${pipeline.id}/${stage}`);
    const manifest = readFrozenManifestFromState(state);
    const effective = effectiveAllowedChangePaths(manifest, state);
    const outside = paths.filter((path) => !effective.some((scope) => pathMatchesScope(path, scope)));
    for (const path of outside) assertRuntimeScopeExtensible(manifest, path);
    const autoTests = outside.filter((path) => canAutoExtendTestScope(path, manifest, state));
    const unresolved = outside.filter((path) => !autoTests.includes(path));

    if (unresolved.length) {
      throw new StageCliError(
        `TECHNICAL_SCOPE_REVIEW_REQUIRED: ${unresolved.join(', ')}; do not edit manifest/state and do not consume a technical_fix cycle`,
      );
    }

    if (autoTests.length) {
      state.runtime_scope_extensions ??= [];
      const newPaths = autoTests.filter((path) =>
        !state.runtime_scope_extensions!.some((entry) => entry.paths.includes(path)));
      if (newPaths.length) {
        state.runtime_scope_extensions.push({
          timestamp: now(),
          scope_class: 'test',
          paths: newPaths,
          reason: 'automatic test/support scope extension for an already-approved component',
        });
      }
    }

    state.scope_preflight = {
      timestamp: now(),
      pipeline_id: pipeline.id,
      stage,
      paths: [...paths],
    };
    output = scopeOutput(state, manifest, paths);
  });
  return output!;
}

type TechnicalScopeReview = {
  status?: unknown;
  scope_class?: unknown;
  paths?: unknown;
  architecture_status?: unknown;
  review_status?: unknown;
  owner_decision_required?: unknown;
  requirements_changed?: unknown;
  acceptance_criteria_changed?: unknown;
  external_contract_changed?: unknown;
  security_boundary_changed?: unknown;
  destructive_change?: unknown;
};

export async function authorizeTechnicalScope(
  stateRoot: string,
  runId: string,
  stage: string,
  paths: string[],
  evidencePath: string,
  pipelineId?: string,
): Promise<{ status: 'PASS'; run_id: string; requested_paths: string[]; effective_allowed_change_paths: string[]; runtime_scope_extensions: NonNullable<PipelineState['runtime_scope_extensions']> }> {
  if (!paths.length) throw new StageCliError('scope-extend requires at least one repository path');
  for (const path of paths) {
    if (!safeRepoPath(path) || /[?*\[\]{}]/.test(path) || isTestSupportPath(path)) {
      throw new StageCliError(`technical scope extension requires concrete non-test repository paths: ${path}`);
    }
  }

  const root = resolve(stateRoot, runId);
  const absoluteEvidence = resolve(evidencePath.startsWith('/') ? evidencePath : join(process.cwd(), evidencePath));
  if (!absoluteEvidence.startsWith(`${root}/`)) {
    throw new StageCliError('technical scope review evidence must live inside the current run directory');
  }
  const evidenceContent = await readFile(absoluteEvidence, 'utf8').catch(() => {
    throw new StageCliError(`technical scope review evidence not found: ${evidencePath}`);
  });
  let review: TechnicalScopeReview;
  try {
    review = JSON.parse(evidenceContent) as TechnicalScopeReview;
  } catch {
    throw new StageCliError('technical scope review evidence is not valid JSON');
  }
  const sortedRequested = [...paths].sort();
  const sortedReviewed = Array.isArray(review.paths) ? [...review.paths].map(String).sort() : [];
  const ready =
    review.status === 'ready' &&
    review.scope_class === 'technical' &&
    review.architecture_status === 'ready' &&
    review.review_status === 'ready' &&
    review.owner_decision_required === false &&
    review.requirements_changed === false &&
    review.acceptance_criteria_changed === false &&
    review.external_contract_changed === false &&
    review.security_boundary_changed === false &&
    review.destructive_change === false &&
    JSON.stringify(sortedRequested) === JSON.stringify(sortedReviewed);
  if (!ready) {
    throw new StageCliError('OWNER_OR_REPLAN_REQUIRED: technical scope review did not prove a decision-free bounded clarification');
  }

  let output: ReturnType<typeof scopeOutput> | undefined;
  await updateState(stateRoot, runId, (state) => {
    const pipeline = getPipeline(state, pipelineId);
    if (!pipeline.stages[stage]) throw new StageCliError(`Stage not found: ${pipeline.id}/${stage}`);
    const manifest = readFrozenManifestFromState(state);
    const effective = effectiveAllowedChangePaths(manifest, state);
    const newPaths = paths.filter((path) => !effective.some((scope) => pathMatchesScope(path, scope)));
    for (const path of newPaths) assertRuntimeScopeExtensible(manifest, path);
    if (newPaths.length) {
      state.runtime_scope_extensions ??= [];
      state.runtime_scope_extensions.push({
        timestamp: now(),
        scope_class: 'technical',
        paths: newPaths,
        reason: 'autonomous architecture clarification inside approved requirements/acceptance boundaries',
        evidence_path: absoluteEvidence,
        evidence_sha256: sha256(evidenceContent),
      });
    }
    state.scope_preflight = {
      timestamp: now(),
      pipeline_id: pipeline.id,
      stage,
      paths: [...paths],
    };
    output = scopeOutput(state, manifest, paths);
  });
  return output!;
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
    if (!dependencyReady(state, dependency)) {
      const upstream = state.pipelines[dependency];
      const required = upstream?.ready_after_stage
        ? `ready_after_stage=${upstream.ready_after_stage}`
        : 'completed';
      throw new StageCliError(
        `Pipeline dependency is not source-ready: ${pipeline.id} -> ${dependency} requires ${required}`,
      );
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

    state.execution_started_at ??= now();
    const spec = readFrozenManifestFromState(state).pipelines.find(p => p.id === pipeline.id);
    if (spec?.executors?.[stage] === 'agent') state.implementation_started_at ??= now();
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

function technicalFixLimit(runtime: StageRuntime): number {
  return runtime.technical_fix_limit ?? DEFAULT_TECHNICAL_FIX_LIMIT;
}

function activeRuntimeReplan(runtime: StageRuntime) {
  return [...(runtime.runtime_replans ?? [])]
    .reverse()
    .find((record) =>
      record.status === 'awaiting_owner_clarification' ||
      record.status === 'awaiting_owner_approval');
}

export async function setRunTechnicalFixBudget(
  stateRoot: string,
  runId: string,
  limit: number,
): Promise<PipelineState> {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TECHNICAL_FIX_LIMIT) {
    throw new StageCliError(`fix-budget-set cycles must be an integer from 1 to ${MAX_TECHNICAL_FIX_LIMIT}`);
  }
  return updateState(stateRoot, runId, (state) => {
    if (state.status === 'completed') {
      throw new StageCliError(`Fix budget cannot change for completed run: ${runId}`);
    }
    for (const pipeline of Object.values(state.pipelines)) {
      for (const stage of pipeline.stage_order) {
        const runtime = pipeline.stages[stage];
        if (!runtime) continue;
        const previousLimit = technicalFixLimit(runtime);
        if (limit <= previousLimit) continue;
        const pending = activeRuntimeReplan(runtime);
        if (pending) {
          throw new StageCliError(
            `RUNTIME_REPLAN_PENDING: ${pipeline.id}/${stage} revision=${pending.revision} status=${pending.status}; approve or clarify that replan before raising the run budget`,
          );
        }
        runtime.technical_fix_limit = limit;
        runtime.technical_fix_budget_grants ??= [];
        runtime.technical_fix_budget_grants.push({
          timestamp: now(),
          source: 'run_override',
          added_cycles: limit - previousLimit,
          previous_limit: previousLimit,
          new_limit: limit,
        });
      }
    }
  });
}

type SecurityFixReview = {
  kind?: unknown;
  pipeline_id?: unknown;
  stage?: unknown;
  paths?: unknown;
  policy_basis?: unknown;
  bounded_remediation?: unknown;
  owner_decision_required?: unknown;
  requirements_changed?: unknown;
  acceptance_criteria_changed?: unknown;
  external_contract_changed?: unknown;
  security_boundary_changed?: unknown;
  privilege_expansion?: unknown;
  secret_exposure?: unknown;
  destructive_change?: unknown;
};

function validateSecurityFixReview(
  review: SecurityFixReview,
  pipelineId: string,
  stage: string,
): string[] {
  if (review.kind !== 'security_fix') {
    throw new StageCliError('security fix evidence must have kind=security_fix');
  }
  if (review.pipeline_id !== pipelineId || review.stage !== stage) {
    throw new StageCliError('security fix evidence pipeline/stage does not match the target');
  }
  const paths = Array.isArray(review.paths) ? review.paths.map(String) : [];
  if (!paths.length || paths.some((path) => !safeRepoPath(path) || /[?*\[\]{}]/.test(path))) {
    throw new StageCliError('security fix evidence must define non-empty concrete repository paths');
  }
  if (new Set(paths).size !== paths.length) {
    throw new StageCliError('security fix evidence paths must be unique');
  }
  const policyBasis = Array.isArray(review.policy_basis)
    ? review.policy_basis.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  if (!policyBasis.length) {
    throw new StageCliError('security fix evidence must cite at least one frozen AC/contract/security rule in policy_basis');
  }
  if (
    review.bounded_remediation !== true ||
    review.owner_decision_required !== false ||
    review.requirements_changed !== false ||
    review.acceptance_criteria_changed !== false ||
    review.external_contract_changed !== false ||
    review.security_boundary_changed !== false ||
    review.privilege_expansion !== false ||
    review.secret_exposure !== false ||
    review.destructive_change !== false
  ) {
    throw new StageCliError(
      'SECURITY_FIX_OWNER_STOP_REQUIRED: autonomous security repair must be bounded, decision-free, non-expanding, secret-free and non-destructive',
    );
  }
  return paths;
}

export async function authorizeSecurityFix(
  stateRoot: string,
  runId: string,
  stage: string,
  evidencePath: string,
  pipelineId?: string,
): Promise<PipelineState> {
  const root = resolve(stateRoot, runId);
  const absoluteEvidence = resolve(evidencePath.startsWith('/') ? evidencePath : join(process.cwd(), evidencePath));
  if (!absoluteEvidence.startsWith(`${root}/`)) {
    throw new StageCliError('security fix evidence must live inside the current run directory');
  }
  const evidenceContent = await readFile(absoluteEvidence, 'utf8').catch(() => {
    throw new StageCliError(`security fix evidence not found: ${evidencePath}`);
  });
  let review: SecurityFixReview;
  try {
    review = JSON.parse(evidenceContent) as SecurityFixReview;
  } catch {
    throw new StageCliError('security fix evidence is not valid JSON');
  }

  return updateState(stateRoot, runId, (state) => {
    const pipeline = getPipeline(state, pipelineId);
    const runtime = pipeline.stages[stage];
    if (!runtime) throw new StageCliError(`Stage not found: ${pipeline.id}/${stage}`);
    if (!['in_progress', 'failed', 'blocked'].includes(runtime.status)) {
      throw new StageCliError(`Security fix is not allowed while stage is ${runtime.status}: ${pipeline.id}/${stage}`);
    }
    const paths = validateSecurityFixReview(review, pipeline.id, stage);
    state.security_fix_preflight = {
      timestamp: now(),
      pipeline_id: pipeline.id,
      stage,
      paths,
      evidence_path: absoluteEvidence,
      evidence_sha256: sha256(evidenceContent),
    };
  });
}

export async function grantTechnicalFixBudget(
  stateRoot: string,
  runId: string,
  stage: string,
  cycles: number,
  pipelineId?: string,
): Promise<PipelineState> {
  if (!Number.isInteger(cycles) || cycles < 1 || cycles > MAX_TECHNICAL_FIX_LIMIT) {
    throw new StageCliError(`fix-budget-add cycles must be an integer from 1 to ${MAX_TECHNICAL_FIX_LIMIT}`);
  }
  return updateState(stateRoot, runId, (state) => {
    const pipeline = getPipeline(state, pipelineId);
    const runtime = pipeline.stages[stage];
    if (!runtime) throw new StageCliError(`Stage not found: ${pipeline.id}/${stage}`);
    if (!['in_progress', 'failed', 'blocked'].includes(runtime.status)) {
      throw new StageCliError(`Fix budget cannot change while stage is ${runtime.status}: ${pipeline.id}/${stage}`);
    }
    const pending = activeRuntimeReplan(runtime);
    if (pending) {
      throw new StageCliError(
        `RUNTIME_REPLAN_PENDING: ${pipeline.id}/${stage} revision=${pending.revision} status=${pending.status}; approve or clarify that replan before granting direct cycles`,
      );
    }
    const previousLimit = technicalFixLimit(runtime);
    const newLimit = previousLimit + cycles;
    if (newLimit > MAX_TECHNICAL_FIX_LIMIT) {
      throw new StageCliError(
        `TECHNICAL_FIX_LIMIT_MAX: ${pipeline.id}/${stage} requested=${newLimit} max=${MAX_TECHNICAL_FIX_LIMIT}`,
      );
    }
    runtime.technical_fix_limit = newLimit;
    runtime.technical_fix_budget_grants ??= [];
    runtime.technical_fix_budget_grants.push({
      timestamp: now(),
      source: 'owner_direct',
      added_cycles: cycles,
      previous_limit: previousLimit,
      new_limit: newLimit,
    });
    runtime.message = `owner granted +${cycles} technical_fix cycles; budget ${runtime.technical_fix_cycles ?? 0}/${newLimit}`;
    addHistory(state, pipeline.id, stage, runtime.status, runtime.message);
  });
}

type RuntimeReplanReview = {
  kind?: unknown;
  status?: unknown;
  pipeline_id?: unknown;
  stage?: unknown;
  summary?: unknown;
  owner_questions?: unknown;
  requirements_changed?: unknown;
  acceptance_criteria_changed?: unknown;
  external_contract_changed?: unknown;
  security_boundary_changed?: unknown;
  destructive_change?: unknown;
};

function validateRuntimeReplanReview(
  review: RuntimeReplanReview,
  pipelineId: string,
  stage: string,
): {
  status: 'awaiting_owner_clarification' | 'awaiting_owner_approval';
  ownerQuestions: string[];
  summary?: string;
} {
  if (review.kind !== 'runtime_replan') {
    throw new StageCliError('runtime replan evidence must have kind=runtime_replan');
  }
  if (review.pipeline_id !== pipelineId || review.stage !== stage) {
    throw new StageCliError('runtime replan evidence pipeline/stage does not match the target');
  }
  if (
    review.requirements_changed !== false ||
    review.acceptance_criteria_changed !== false ||
    review.external_contract_changed !== false ||
    review.security_boundary_changed !== false ||
    review.destructive_change !== false
  ) {
    throw new StageCliError(
      'FULL_REPLAN_REQUIRED: runtime replan crossed requirements/acceptance/external-contract/security/destructive boundary',
    );
  }
  const questions = Array.isArray(review.owner_questions)
    ? review.owner_questions.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  if (review.status === 'needs_owner_clarification') {
    if (!questions.length) {
      throw new StageCliError('runtime replan clarification evidence must contain owner_questions');
    }
    return {
      status: 'awaiting_owner_clarification',
      ownerQuestions: questions,
      ...(typeof review.summary === 'string' && review.summary.trim() ? { summary: review.summary.trim() } : {}),
    };
  }
  if (review.status === 'ready_for_owner_approval') {
    return {
      status: 'awaiting_owner_approval',
      ownerQuestions: questions,
      ...(typeof review.summary === 'string' && review.summary.trim() ? { summary: review.summary.trim() } : {}),
    };
  }
  throw new StageCliError('runtime replan evidence status must be needs_owner_clarification or ready_for_owner_approval');
}

export async function proposeRuntimeReplan(
  stateRoot: string,
  runId: string,
  stage: string,
  evidencePath: string,
  pipelineId?: string,
): Promise<PipelineState> {
  const root = resolve(stateRoot, runId);
  const absoluteEvidence = resolve(evidencePath.startsWith('/') ? evidencePath : join(process.cwd(), evidencePath));
  if (!absoluteEvidence.startsWith(`${root}/`)) {
    throw new StageCliError('runtime replan evidence must live inside the current run directory');
  }
  const evidenceContent = await readFile(absoluteEvidence, 'utf8').catch(() => {
    throw new StageCliError(`runtime replan evidence not found: ${evidencePath}`);
  });
  let review: RuntimeReplanReview;
  try {
    review = JSON.parse(evidenceContent) as RuntimeReplanReview;
  } catch {
    throw new StageCliError('runtime replan evidence is not valid JSON');
  }

  return updateState(stateRoot, runId, (state) => {
    const pipeline = getPipeline(state, pipelineId);
    const runtime = pipeline.stages[stage];
    if (!runtime) throw new StageCliError(`Stage not found: ${pipeline.id}/${stage}`);
    if (!['in_progress', 'failed', 'blocked'].includes(runtime.status)) {
      throw new StageCliError(`Runtime replan is not allowed while stage is ${runtime.status}: ${pipeline.id}/${stage}`);
    }
    const validated = validateRuntimeReplanReview(review, pipeline.id, stage);
    runtime.runtime_replans ??= [];
    const previous = activeRuntimeReplan(runtime);
    if (previous) {
      previous.status = 'superseded';
      previous.superseded_at = now();
    }
    const revision = runtime.runtime_replans.reduce((max, item) => Math.max(max, item.revision), 0) + 1;
    state.scope_preflight = undefined;
    state.security_fix_preflight = undefined;
    runtime.runtime_replans.push({
      revision,
      status: validated.status,
      proposed_at: now(),
      evidence_path: absoluteEvidence,
      evidence_sha256: sha256(evidenceContent),
      ...(validated.ownerQuestions.length ? { owner_questions: validated.ownerQuestions } : {}),
      ...(validated.summary ? { summary: validated.summary } : {}),
    });
    runtime.message = validated.status === 'awaiting_owner_clarification'
      ? `runtime_replan revision ${revision} awaiting owner clarification`
      : `runtime_replan revision ${revision} awaiting owner approval`;
    addHistory(state, pipeline.id, stage, runtime.status, runtime.message);
  });
}

export async function approveRuntimeReplan(
  stateRoot: string,
  runId: string,
  stage: string,
  cycles: number,
  pipelineId?: string,
): Promise<PipelineState> {
  if (!Number.isInteger(cycles) || cycles < 1 || cycles > MAX_TECHNICAL_FIX_LIMIT) {
    throw new StageCliError(`runtime-replan-approve cycles must be an integer from 1 to ${MAX_TECHNICAL_FIX_LIMIT}`);
  }
  return updateState(stateRoot, runId, (state) => {
    const pipeline = getPipeline(state, pipelineId);
    const runtime = pipeline.stages[stage];
    if (!runtime) throw new StageCliError(`Stage not found: ${pipeline.id}/${stage}`);
    const pending = activeRuntimeReplan(runtime);
    if (!pending) {
      throw new StageCliError(`RUNTIME_REPLAN_NOT_PENDING: ${pipeline.id}/${stage}`);
    }
    if (pending.status === 'awaiting_owner_clarification') {
      throw new StageCliError(
        `OWNER_CLARIFICATION_REQUIRED: ${pipeline.id}/${stage} runtime_replan revision=${pending.revision}`,
      );
    }
    if (pending.status !== 'awaiting_owner_approval') {
      throw new StageCliError(`RUNTIME_REPLAN_NOT_APPROVABLE: revision=${pending.revision} status=${pending.status}`);
    }
    const previousLimit = technicalFixLimit(runtime);
    const newLimit = previousLimit + cycles;
    if (newLimit > MAX_TECHNICAL_FIX_LIMIT) {
      throw new StageCliError(
        `TECHNICAL_FIX_LIMIT_MAX: ${pipeline.id}/${stage} requested=${newLimit} max=${MAX_TECHNICAL_FIX_LIMIT}`,
      );
    }
    pending.status = 'approved';
    pending.approved_at = now();
    pending.granted_cycles = cycles;
    runtime.technical_fix_limit = newLimit;
    runtime.technical_fix_budget_grants ??= [];
    runtime.technical_fix_budget_grants.push({
      timestamp: now(),
      source: 'runtime_replan',
      added_cycles: cycles,
      previous_limit: previousLimit,
      new_limit: newLimit,
      runtime_replan_revision: pending.revision,
    });
    runtime.message = `owner approved runtime_replan revision ${pending.revision} and granted +${cycles} cycles; budget ${runtime.technical_fix_cycles ?? 0}/${newLimit}`;
    addHistory(state, pipeline.id, stage, runtime.status, runtime.message);
  });
}

export async function deferOwnerDecision(stateRoot: string, runId: string, id: string, evidencePath: string, pipelineId: string): Promise<PipelineState> {
  return updateState(stateRoot, runId, state => {
    const file = resolve(evidencePath);
    if (!state.manifest_file || !file.startsWith(dirname(resolve(state.manifest_file)) + '/')) throw new StageCliError('DEFERRED_DECISION_EVIDENCE_OUTSIDE_RUN');
    const raw = readFileSync(file, 'utf8');
    const evidence = JSON.parse(raw);
    const pipeline = getPipeline(state, pipelineId);
    const spec = readFrozenManifestFromState(state).pipelines.find(p => p.id === pipelineId);
    if (!/^[A-Za-z0-9._-]+$/.test(id) || evidence.kind !== 'deferred_owner_decision' || evidence.owner_decision_required !== true ||
        evidence.independent_repairs_safe !== true || evidence.action_executed !== false ||
        typeof evidence.summary !== 'string' || !evidence.summary.trim() ||
        !Array.isArray(evidence.paths) || !evidence.paths.length || evidence.paths.some((path: unknown) => typeof path !== 'string' || !path || path.startsWith('/') || path.split('/').includes('..')) ||
        !pipeline.stages[evidence.source_stage] || !['review', 'agent'].includes(spec?.executors?.[evidence.source_stage] ?? '') ||
        !['git_verify', 'local_gate', 'github_ci'].includes(spec?.executors?.[evidence.before_stage] ?? '') ||
        pipeline.stage_order.indexOf(evidence.before_stage) <= pipeline.stage_order.indexOf(evidence.source_stage) ||
        pipeline.stages[evidence.before_stage].status !== 'pending') throw new StageCliError('DEFERRED_DECISION_INVALID');
    state.deferred_decisions ??= [];
    const existing = state.deferred_decisions.find(d => d.id === id);
    if (existing) {
      if (existing.evidence_sha256 !== sha256(raw)) throw new StageCliError('DEFERRED_DECISION_CHANGED');
      return;
    }
    state.deferred_decisions.push({ id, pipeline_id: pipelineId, source_stage: evidence.source_stage, before_stage: evidence.before_stage,
      status: 'pending', evidence_path: file, evidence_sha256: sha256(raw), summary: evidence.summary });
  });
}

export async function resolveOwnerDecision(stateRoot: string, runId: string, id: string, result: string): Promise<PipelineState> {
  if (!['approve', 'reject'].includes(result)) throw new StageCliError('owner-decision-resolve requires --message approve|reject after an explicit owner response');
  return updateState(stateRoot, runId, state => {
    const decision = state.deferred_decisions?.find(d => d.id === id);
    if (!decision || decision.status !== 'pending') throw new StageCliError('DEFERRED_DECISION_NOT_PENDING');
    if (sha256(readFileSync(decision.evidence_path, 'utf8')) !== decision.evidence_sha256) throw new StageCliError('DEFERRED_DECISION_EVIDENCE_CHANGED');
    decision.status = result === 'approve' ? 'approved' : 'rejected';
    const pipeline = state.pipelines[decision.pipeline_id];
    if (pipeline.stages[decision.before_stage].status !== 'blocked') throw new StageCliError('DEFERRED_CHECKPOINT_NOT_REACHED');
    if (result === 'reject') {
      pipeline.stages[decision.before_stage].message = 'OWNER_AMENDMENT_REQUIRED: rejected deferred action';
      return;
    }
    if (state.deferred_decisions?.some(d => d.pipeline_id === decision.pipeline_id && d.before_stage === decision.before_stage && d.status !== 'approved')) return;
    pipeline.stages[decision.before_stage].status = 'pending';
    pipeline.stages[decision.source_stage].status = 'blocked';
    pipeline.stages[decision.source_stage].message = 'Owner approved deferred action; resume the existing fix loop after scope/security authorization';
    pipeline.status = 'blocked';
    addHistory(state, pipeline.id, decision.source_stage, 'blocked', `owner approved deferred decision ${id}`);
  });
}

export async function recordTechnicalFixCycle(
  stateRoot: string,
  runId: string,
  stage: string,
  pipelineId?: string,
  repairClass: 'technical_fix' | 'security_fix' = 'technical_fix',
  evidencePath?: string,
): Promise<PipelineState> {
  return updateState(stateRoot, runId, (state) => {
    const pipeline = getPipeline(state, pipelineId);
    const runtime = pipeline.stages[stage];
    if (!runtime) throw new StageCliError(`Stage not found: ${pipeline.id}/${stage}`);
    if (runtime.repair_origin_stage && runtime.repair_origin_stage !== stage) {
      throw new StageCliError(`REPAIR_BUDGET_OWNER: record the next fix-cycle on ${pipeline.id}/${runtime.repair_origin_stage}`);
    }
    if (activeRuntimeReplan(runtime)) throw new StageCliError('RUNTIME_REPLAN_APPROVAL_REQUIRED');
    const manifest = readFrozenManifestFromState(state);
    const spec = manifest.pipelines.find((item) => item.id === pipeline.id);
    const stageIndex = pipeline.stage_order.indexOf(stage);
    let repairIndex = stageIndex;
    if (spec?.executors?.[stage] !== 'agent') {
      repairIndex = -1;
      for (let index = stageIndex - 1; index >= 0; index -= 1) {
        if (spec?.executors?.[pipeline.stage_order[index]] === 'agent') {
          repairIndex = index;
          break;
        }
      }
      if (repairIndex < 0) throw new StageCliError(`REPAIR_TARGET_MISSING: ${pipeline.id}/${stage} has no preceding agent stage`);
    }
    const scopePreflight = state.scope_preflight;
    if (!scopePreflight || scopePreflight.pipeline_id !== pipeline.id || scopePreflight.stage !== stage) {
      throw new StageCliError(
        `SCOPE_PREFLIGHT_REQUIRED: run stage-cli scope-check ${runId} ${stage} <planned-path>... --pipeline ${pipeline.id} before fix-cycle`,
      );
    }
    const securityFixPreflight = state.security_fix_preflight;
    if (repairClass === 'security_fix') {
      if (!securityFixPreflight ||
          securityFixPreflight.pipeline_id !== pipeline.id ||
          securityFixPreflight.stage !== stage ||
          JSON.stringify([...securityFixPreflight.paths].sort()) !== JSON.stringify([...scopePreflight.paths].sort())) {
        throw new StageCliError(
          `SECURITY_FIX_PREFLIGHT_REQUIRED: run stage-cli security-fix-check with matching evidence before security repair: ${pipeline.id}/${stage}`,
        );
      }
    } else if (securityFixPreflight?.pipeline_id === pipeline.id && securityFixPreflight.stage === stage) {
      throw new StageCliError(
        `SECURITY_FIX_REPAIR_CLASS_REQUIRED: ${pipeline.id}/${stage} has approved security-fix evidence; use --repair-class security_fix`,
      );
    }
    if (!['in_progress', 'failed', 'blocked'].includes(runtime.status)) {
      throw new StageCliError(`Fix cycle is not allowed while stage is ${runtime.status}: ${pipeline.id}/${stage}`);
    }
    const limit = technicalFixLimit(runtime);
    // Older review repair checkpoints charged a cycle without reopening source.
    // Resume that exact authorized attempt; a fresh review or changed scope/evidence
    // still starts a new cycle. The source marker distinguishes repaired new runs.
    const priorEvidence = runtime.repair_evidence;
    const resumeChargedRepair = repairIndex < stageIndex &&
      pipeline.stages[pipeline.stage_order[repairIndex]].status === 'completed' &&
      !pipeline.stages[pipeline.stage_order[repairIndex]].repair_origin_stage &&
      (runtime.technical_fix_cycles ?? 0) > 0 &&
      priorEvidence && evidencePath && resolve(evidencePath) === resolve(priorEvidence.path) &&
      sha256(readFileSync(resolve(evidencePath), 'utf8')) === priorEvidence.sha256 &&
      JSON.stringify([...(runtime.repair_paths ?? [])].sort()) === JSON.stringify([...scopePreflight.paths].sort());
    const next = (runtime.technical_fix_cycles ?? 0) + (resumeChargedRepair ? 0 : 1);
    if (next > limit) {
      throw new StageCliError(
        `TECHNICAL_FIX_LIMIT_EXCEEDED: ${pipeline.id}/${stage} used=${runtime.technical_fix_cycles ?? 0} limit=${limit}; owner may grant +N cycles or request runtime replan`,
      );
    }
    if (evidencePath) {
      const absolute = resolve(evidencePath);
      if (!absolute.startsWith(resolve(process.cwd()) + '/')) throw new StageCliError('REPAIR_EVIDENCE_OUTSIDE_PROJECT');
      runtime.repair_evidence = { path: absolute, sha256: sha256(readFileSync(absolute, 'utf8')) };
    } else runtime.repair_evidence = undefined;
    runtime.repair_paths = [...scopePreflight.paths];
    runtime.technical_fix_cycles = next;
    runtime.message = `${repairClass} cycle ${next}/${limit}`;
    state.scope_preflight = undefined;
    if (repairClass === 'security_fix') state.security_fix_preflight = undefined;

    // Reopen the existing source -> review/gates chain, before or after publication.
    // The initiating gate keeps its budget and repair evidence. The source executor
    // only borrows that identity for dispatch; no new stage, work item or counter.
    if (repairIndex < stageIndex) {
      for (const name of pipeline.stage_order.slice(repairIndex)) {
        const item = pipeline.stages[name];
        item.status = 'pending';
        item.started_at = undefined;
        item.completed_at = undefined;
        item.evidence = undefined;
        item.repair_origin_stage = undefined;
        if (name !== stage) item.message = undefined;
        addHistory(state, pipeline.id, name, 'pending', `invalidated by ${repairClass} cycle ${next}/${limit} for ${stage}`);
      }
      pipeline.stages[pipeline.stage_order[repairIndex]].repair_origin_stage = stage;
      pipeline.status = 'approved';
      pipeline.current_stage = undefined;
    }
  });
}

export async function applyOwnerAmendment(
  stateRoot: string,
  runId: string,
  stage: string,
  evidencePath: string,
  pipelineId: string,
): Promise<PipelineState> {
  const raw = await readFile(resolve(evidencePath), 'utf8');
  const evidence = JSON.parse(raw) as any;
  if (evidence.kind !== 'owner_amendment' || evidence.status !== 'ready' || evidence.bounded !== true) {
    throw new StageCliError('OWNER_AMENDMENT_INVALID: ready bounded owner amendment evidence required');
  }
  if (evidence.business_intent_changed === true || evidence.external_contract_changed === true ||
      evidence.security_boundary_changed === true || evidence.destructive_change === true) {
    throw new StageCliError('FULL_REPLAN_REQUIRED: owner amendment crosses a structural PLAN boundary');
  }
  if (!Array.isArray(evidence.paths) || evidence.paths.some((path: unknown) => !safeScopePath(path))) {
    throw new StageCliError('OWNER_AMENDMENT_INVALID: paths must be safe repository scopes');
  }
  if (!Array.isArray(evidence.work_items)) throw new StageCliError('OWNER_AMENDMENT_INVALID: work_items must be an array');
  const workItems: any[] = [];
  for (const item of evidence.work_items) {
    if (!item || typeof item.id !== 'string' || item.pipeline_id !== pipelineId || !safeRepoPath(item.path) ||
        !/^[0-9a-f]{64}$/i.test(String(item.sha256 ?? ''))) {
      throw new StageCliError('OWNER_AMENDMENT_INVALID: invalid runtime work item');
    }
    const content = await readFile(resolve(stateDir(stateRoot, runId), item.path), 'utf8');
    if (sha256(content) !== item.sha256) throw new StageCliError('OWNER_AMENDMENT_WORK_ITEM_CHANGED: ' + item.id);
    workItems.push({ id: item.id, pipeline_id: item.pipeline_id, path: item.path, sha256: item.sha256 });
  }
  return updateState(stateRoot, runId, (state) => {
    const pipeline = getPipeline(state, pipelineId);
    const manifest = readFrozenManifestFromState(state);
    const source = pipeline.stages[stage];
    if (!source || Object.values(state.pipelines).some(p => Object.values(p.stages).some(s => s.status === 'in_progress' && s !== source))) {
      throw new StageCliError('OWNER_AMENDMENT_REQUIRES_OWNER_CHECKPOINT: ' + pipelineId + '/' + stage);
    }
    for (const item of workItems) {
      if (manifest.work_items?.some(w => w.id === item.id) || state.owner_amendments?.some(a => a.work_items.some(w => w.id === item.id))) throw new StageCliError('DUPLICATE_RUNTIME_WORK_ITEM: ' + item.id);
    }
    const targetStage = String(evidence.target_stage ?? '');
    const spec = manifest.pipelines.find((item) => item.id === pipelineId);
    if (source.status === 'in_progress' && spec?.executors?.[stage] !== 'owner_acceptance') throw new StageCliError('STOP_ACTIVE_SOURCE_STAGE_BEFORE_OWNER_AMENDMENT');
    const targetIndex = pipeline.stage_order.indexOf(targetStage);
    if (!spec || targetIndex < 0 || spec.executors?.[targetStage] !== 'agent') {
      throw new StageCliError('OWNER_AMENDMENT_INVALID: target_stage must be an existing agent stage');
    }
    for (const path of evidence.paths as string[]) assertRuntimeScopeExtensible(manifest, path.replace(/\/\*\*$/, ''));
    const revision = (state.owner_amendments?.length ?? 0) + 1;
    state.owner_amendments ??= [];
    state.owner_amendments.push({
      revision, pipeline_id: pipelineId, source_stage: stage, status: 'approved',
      summary: String(evidence.summary ?? 'owner clarification'), approved_at: now(),
      evidence_path: evidencePath, evidence_sha256: sha256(raw),
      acceptance_criteria_changed: evidence.acceptance_criteria_changed === true,
      requirements_changed: evidence.requirements_changed === true,
      paths: [...evidence.paths], work_items: workItems,
    });
    if (evidence.paths.length) {
      state.runtime_scope_extensions ??= [];
      state.runtime_scope_extensions.push({ timestamp: now(), scope_class: 'owner_amendment', paths: [...evidence.paths],
        reason: 'approved owner amendment revision ' + revision, evidence_path: evidencePath, evidence_sha256: sha256(raw) });
    }
    for (const name of pipeline.stage_order.slice(targetIndex)) {
      const runtime = pipeline.stages[name];
      if (!runtime) continue;
      runtime.status = 'pending'; runtime.started_at = undefined; runtime.completed_at = undefined; runtime.evidence = undefined;
      runtime.message = undefined;
      addHistory(state, pipeline.id, name, 'pending', 'reopened by owner amendment revision ' + revision);
    }
    pipeline.status = 'approved';
    pipeline.current_stage = undefined;
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


async function copyIfPresent(source:string,destination:string,recursive=false):Promise<void>{
  if(!(await fileExists(source)))return;
  await cp(source,destination,{recursive,force:false,errorOnExist:true});
}

export async function supersedeRun(
  stateRoot:string,
  oldRunId:string,
  newRunId:string,
  reason:string,
):Promise<Record<string,unknown>>{
  if(!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(newRunId) || newRunId===oldRunId) {
    throw new StageCliError('supersede requires a new safe run-id');
  }
  if(!SUPERSEDE_REASONS.has(reason)) {
    throw new StageCliError(`invalid supersede reason: ${reason}`);
  }
  const oldState=await validateState(stateRoot,oldRunId);
  if(!oldState.manifest_file)throw new StageCliError('old run has no frozen manifest');
  const oldManifest=JSON.parse(await readFile(oldState.manifest_file,'utf8')) as PipelineManifest;
  const oldRoot=dirname(resolve(oldState.manifest_file));
  const newRoot=join(dirname(oldRoot),newRunId);
  if(await fileExists(newRoot) || await fileExists(statePath(stateRoot,newRunId))) {
    throw new StageCliError(`supersede destination already exists: ${newRunId}`);
  }
  await mkdir(newRoot,{recursive:true});
  try {
    for(const directory of ['planning','stories','reviews','work-items']){
      await copyIfPresent(join(oldRoot,directory),join(newRoot,directory),true);
    }
    await rm(join(newRoot,'planning','deployment-target.json'),{force:true});
    for(const file of ['decision-register.md','work-items.json']){
      await copyIfPresent(join(oldRoot,file),join(newRoot,file));
    }
    const cloned:PipelineManifest={...oldManifest,run_id:newRunId};
    cloned.lineage={
      change_class: reason==='ARCHITECTURE_REPLAN'||reason==='MAIN_DRIFT_REPLAN' ? 'replan' : 'supersede',
      supersedes:oldRunId,
      reason_code:reason as any,
    };
    if(cloned.deployment_target_check)delete cloned.deployment_target_check;
    await writeFile(join(newRoot,'manifest.json'),`${JSON.stringify(cloned,null,2)}\n`,'utf8');

    const unlock=await acquireLock(stateRoot,oldRunId);
    try{
      const state=await validateState(stateRoot,oldRunId);
      state.superseded_by=newRunId;
      state.supersede_reason=reason as any;
      state.updated_at=now();
      await writeJsonAtomic(statePath(stateRoot,oldRunId),state);
    }finally{await unlock();}

    return {
      status:'PASS',
      change_class:cloned.lineage.change_class,
      old_run_id:oldRunId,
      new_run_id:newRunId,
      reason_code:reason,
      manifest:join(newRoot,'manifest.json'),
      state_copied:false,
      machine_evidence_copied:false,
      deployment_target_check_reset:Boolean(oldManifest.deployment_target_check),
    };
  }catch(error){
    await rm(newRoot,{recursive:true,force:true});
    throw error;
  }
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
    else if (argument === '--reason') options.reason = args[++index];
    else if (argument === '--cycles') {
      const value = Number(args[++index]);
      if (!Number.isInteger(value) || value < 1 || value > MAX_TECHNICAL_FIX_LIMIT) {
        throw new StageCliError(`--cycles must be an integer from 1 to ${MAX_TECHNICAL_FIX_LIMIT}`);
      }
      options.cycles = value;
    }
    else if (argument === '--class') {
      const value = args[++index];
      if (value !== 'test' && value !== 'technical') throw new StageCliError('--class must be test or technical');
      options.scopeClass = value;
    }
    else if (argument === '--repair-class') {
      const value = args[++index];
      if (value !== 'technical_fix' && value !== 'security_fix') {
        throw new StageCliError('--repair-class must be technical_fix or security_fix');
      }
      options.repairClass = value;
    }
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
      const runtime = pipeline.stages[stage];
      const status = runtime?.status ?? 'unknown';
      const marker = status === 'completed' ? '✓' : status === 'in_progress' ? '→' : '○';
      const used = runtime?.technical_fix_cycles ?? 0;
      const limit = runtime ? technicalFixLimit(runtime) : DEFAULT_TECHNICAL_FIX_LIMIT;
      console.log(`  ${marker} ${stage}: ${status} fix_budget=${used}/${limit}`);
      const pendingReplan = runtime ? activeRuntimeReplan(runtime) : undefined;
      if (pendingReplan) console.log(`      runtime_replan=${pendingReplan.revision}:${pendingReplan.status}`);
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
    '  stage-cli plan-run-preflight <manifest> [--environment] [--json]',
    '  stage-cli artifacts <run-id> <run-relative-path>... [--state-root <path>] [--json]',
    '  stage-cli policy [repo-relative-path] [--json]',
    '  stage-cli init <manifest> [--state-root <path>] [--environment]',
    '  stage-cli approve <run-id> [--state-root <path>]',
    '  stage-cli status <run-id> [--json] [--state-root <path>]',
    '  stage-cli validate <run-id> [--json] [--state-root <path>]',
    '  stage-cli run-preflight <run-id> [--json] [--state-root <path>]',
    '  stage-cli next <run-id> [--json] [--state-root <path>]',
    '  stage-cli start <run-id> <stage> [--pipeline <id>]',
    '  stage-cli complete <run-id> <stage> [--pipeline <id>] [--message <text>] [--evidence <path>]',
    '  stage-cli owner-accept <run-id> <stage> --pipeline <id> --result pass|fail [--message <text>]',
    '  stage-cli fail|block <run-id> <stage> [--pipeline <id>] [--message <text>] [--evidence <path>]',
    '  stage-cli resume <run-id> <stage> [--pipeline <id>]',
    '  stage-cli scope-check <run-id> <stage> <path>... [--pipeline <id>] [--json]',
    '  stage-cli scope-extend <run-id> <stage> <path>... --class technical --evidence <run-artifact.json> [--pipeline <id>] [--json]',
    '  stage-cli security-fix-check <run-id> <stage> --pipeline <id> --evidence <review.json> [--json]',
    '  stage-cli fix-cycle <run-id> <stage> [--pipeline <id>] [--repair-class technical_fix|security_fix] [--json]',
    '  stage-cli fix-budget-set <run-id> --cycles <1..20> [--json]',
    '  stage-cli fix-budget-add <run-id> <stage> --pipeline <id> --cycles <1..20> [--json]',
    '  stage-cli runtime-replan-propose <run-id> <stage> --pipeline <id> --evidence <review.json> [--json]',
    '  stage-cli runtime-replan-approve <run-id> <stage> --pipeline <id> --cycles <1..20> [--json]',
    '  stage-cli supersede <old-run-id> <new-run-id> --reason <reason-code> [--state-root <path>] [--json]',
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
  if (command === 'plan-run-preflight') {
    const manifestPath = positional[1];
    if (!manifestPath) throw new StageCliError('Manifest path is required');
    const manifest = JSON.parse(await readFile(resolve(manifestPath), 'utf8')) as PipelineManifest;
    if (manifest.schema_version !== 2) {
      throw new StageCliError('NEW_PLAN_SCHEMA_V2_REQUIRED: owner approval may only be requested for schema v2');
    }
    const { preflightFile } = await import('./manifest-preflight.mjs');
    const result = await preflightFile(manifestPath, { environment: options.environment, cwd: process.cwd() });
    const output = { status: 'PASS', run_id: manifest.run_id, schema_version: 2, checked_commands: result.checked_commands,
      environment_checked: result.environment_checked };
    if (options.json) console.log(JSON.stringify(output, null, 2));
    else console.log(`PASS run_id=${manifest.run_id} schema_version=2`);
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

  if (command === 'artifacts') {
    const runId = positional[1];
    if (!runId) throw new StageCliError('run-id is required');
    const result = await hashRunArtifacts(options.stateRoot, runId, positional.slice(2));
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else for (const artifact of result.artifacts) console.log(`${artifact.sha256}  ${artifact.path}`);
    return;
  }
  if (command === 'policy') {
    const result = await inspectProjectPolicy(positional[1] ?? '.opencode/pipeline-policy.json');
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else console.log(result.status === 'ABSENT' ? `ABSENT ${String(result.path)}` : `PASS ${String(result.sha256)}  ${String(result.path)}`);
    return;
  }

  if (command === 'supersede') {
    const oldRunId = positional[1];
    const newRunId = positional[2];
    if (!oldRunId || !newRunId || !options.reason) {
      throw new StageCliError('usage: stage-cli supersede <old-run-id> <new-run-id> --reason <reason-code>');
    }
    const result = await supersedeRun(options.stateRoot, oldRunId, newRunId, options.reason);
    console.log(JSON.stringify(result, null, 2));
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
  if (command === 'run-preflight') {
    const rawState = await readState(options.stateRoot, runId);
    if (!rawState.manifest_file) throw new StageCliError('Frozen manifest is missing');
    const rawManifest = JSON.parse(await readFile(rawState.manifest_file, 'utf8')) as PipelineManifest;
    const state = await validateState(options.stateRoot, runId);
    if (state.superseded_by) {
      throw new StageCliError(`RUN_SUPERSEDED: ${runId} -> ${state.superseded_by} reason=${String(state.supersede_reason ?? 'unknown')}`);
    }
    if (options.json) console.log(JSON.stringify({ status: 'PASS', run_id: runId, schema_version: 2 }, null, 2));
    else console.log(`PASS run_id=${runId} schema_version=2`);
    return;
  }
  if (command === 'next') {
    const state = await validateState(options.stateRoot, runId);
    if (state.superseded_by) {
      throw new StageCliError(`RUN_SUPERSEDED: ${runId} -> ${state.superseded_by} reason=${String(state.supersede_reason ?? 'unknown')}`);
    }
    printRunnable(state, options.json);
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
  if (command === 'scope-check') {
    const stage = positional[2];
    if (!stage) throw new StageCliError('stage is required');
    const result = await checkRuntimeScope(options.stateRoot, runId, stage, positional.slice(3), options.pipelineId);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else console.log(`PASS effective_scope=${result.effective_allowed_change_paths.length} requested=${result.requested_paths.length}`);
    return;
  }
  if (command === 'scope-extend') {
    const stage = positional[2];
    if (!stage) throw new StageCliError('stage is required');
    if (options.scopeClass !== 'technical' || !options.evidencePath) {
      throw new StageCliError('scope-extend requires --class technical --evidence <run-artifact.json>');
    }
    const result = await authorizeTechnicalScope(
      options.stateRoot, runId, stage, positional.slice(3), options.evidencePath, options.pipelineId,
    );
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else console.log(`PASS effective_scope=${result.effective_allowed_change_paths.length} requested=${result.requested_paths.length}`);
    return;
  }
  if (command === 'security-fix-check') {
    const stage = positional[2];
    if (!stage || !options.pipelineId || !options.evidencePath) {
      throw new StageCliError('security-fix-check requires <stage> --pipeline <id> --evidence <review.json>');
    }
    printState(
      await authorizeSecurityFix(options.stateRoot, runId, stage, options.evidencePath, options.pipelineId),
      options.json,
    );
    return;
  }
  if (command === 'owner-decision-defer') {
    if (!positional[2] || !options.pipelineId || !options.evidencePath) throw new StageCliError('owner-decision-defer requires <id> --pipeline <id> --evidence <file>');
    printState(await deferOwnerDecision(options.stateRoot, runId, positional[2], options.evidencePath, options.pipelineId), options.json);
    return;
  }
  if (command === 'owner-decision-resolve') {
    if (!positional[2] || !options.message) throw new StageCliError('owner-decision-resolve requires <id> --message approve|reject');
    printState(await resolveOwnerDecision(options.stateRoot, runId, positional[2], options.message), options.json);
    return;
  }
  if (command === 'fix-cycle') {
    const stage = positional[2];
    if (!stage) throw new StageCliError('stage is required');
    printState(
      await recordTechnicalFixCycle(
        options.stateRoot,
        runId,
        stage,
        options.pipelineId,
        options.repairClass ?? 'technical_fix',
        options.evidencePath,
      ),
      options.json,
    );
    return;
  }
  if (command === 'fix-budget-set') {
    if (!options.cycles) {
      throw new StageCliError('fix-budget-set requires --cycles <1..20>');
    }
    printState(await setRunTechnicalFixBudget(options.stateRoot, runId, options.cycles), options.json);
    return;
  }
  if (command === 'fix-budget-add') {
    const stage = positional[2];
    if (!stage || !options.pipelineId || !options.cycles) {
      throw new StageCliError('fix-budget-add requires <stage> --pipeline <id> --cycles <1..20>');
    }
    printState(
      await grantTechnicalFixBudget(options.stateRoot, runId, stage, options.cycles, options.pipelineId),
      options.json,
    );
    return;
  }
  if (command === 'runtime-replan-propose') {
    const stage = positional[2];
    if (!stage || !options.pipelineId || !options.evidencePath) {
      throw new StageCliError('runtime-replan-propose requires <stage> --pipeline <id> --evidence <review.json>');
    }
    printState(
      await proposeRuntimeReplan(options.stateRoot, runId, stage, options.evidencePath, options.pipelineId),
      options.json,
    );
    return;
  }
  if (command === 'runtime-replan-approve') {
    const stage = positional[2];
    if (!stage || !options.pipelineId || !options.cycles) {
      throw new StageCliError('runtime-replan-approve requires <stage> --pipeline <id> --cycles <1..20>');
    }
    printState(
      await approveRuntimeReplan(options.stateRoot, runId, stage, options.cycles, options.pipelineId),
      options.json,
    );
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
