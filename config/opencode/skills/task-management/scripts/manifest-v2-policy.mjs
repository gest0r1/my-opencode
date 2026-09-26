import { createHash } from 'node:crypto';
import { accessSync, constants, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export class ManifestV2PolicyError extends Error {}

const SHA256 = /^[0-9a-f]{64}$/i;
const JS_MANAGERS = new Set(['npm', 'npx', 'pnpm', 'yarn', 'bun', 'corepack']);
const JS_DIRECT_TOOLS = new Set(['tsc', 'vitest', 'jest']);

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function exists(path) {
  try { accessSync(path, constants.R_OK); return true; }
  catch { return false; }
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false;
  const parts = value.split('/');
  return !parts.includes('..') && !parts.includes('.git');
}

function scopeContains(scope, path) {
  if (scope.endsWith('/**')) {
    const prefix = scope.slice(0, -3).replace(/\/$/, '');
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  return scope === path;
}

function scopesOverlap(left, right) {
  if (left === right) return true;
  if (left.endsWith('/**')) {
    const prefix = left.slice(0, -3).replace(/\/$/, '');
    if (right === prefix || right.startsWith(`${prefix}/`)) return true;
  }
  if (right.endsWith('/**')) {
    const prefix = right.slice(0, -3).replace(/\/$/, '');
    if (left === prefix || left.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

function assertSafePathArray(value, field) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => !safeRelativePath(item))) {
    throw new ManifestV2PolicyError(`${field} must contain safe repository-relative paths`);
  }
}

function runRoot(manifest, cwd, manifestPath) {
  return manifestPath
    ? dirname(resolve(manifestPath))
    : resolve(cwd, '.tmp', 'pipelines', String(manifest.run_id));
}

function readFrozenArtifact(root, value, field) {
  if (!value || typeof value !== 'object' || !safeRelativePath(value.path) || !SHA256.test(String(value.sha256 ?? ''))) {
    throw new ManifestV2PolicyError(`${field} must define safe path + SHA-256`);
  }
  const file = resolve(root, value.path);
  if (!file.startsWith(`${resolve(root)}/`)) {
    throw new ManifestV2PolicyError(`${field}.path escapes run root`);
  }
  let content;
  try { content = readFileSync(file, 'utf8'); }
  catch { throw new ManifestV2PolicyError(`${field} is missing: ${value.path}`); }
  const actual = sha256(content);
  if (actual !== value.sha256.toLowerCase()) {
    throw new ManifestV2PolicyError(`${field} SHA-256 mismatch: ${value.path}`);
  }
  return file;
}

function dependencyReachable(pipelines, from, target) {
  const byId = new Map(pipelines.map((pipeline) => [pipeline.id, pipeline]));
  const seen = new Set();
  const visit = (id) => {
    if (id === target) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return (byId.get(id)?.depends_on ?? []).some(visit);
  };
  return visit(from);
}

function pathsConflict(a, b, field) {
  const left = a[field] ?? [];
  const right = b[field] ?? [];
  return left.some((x) => right.some((y) => scopesOverlap(x, y)));
}

function assertConflictSerialization(manifest) {
  const pipelines = manifest.pipelines ?? [];
  for (let i = 0; i < pipelines.length; i += 1) {
    const a = pipelines[i];
    assertSafePathArray(a.exclusive_paths, `pipelines.${a.id}.exclusive_paths`);
    assertSafePathArray(a.migration_paths, `pipelines.${a.id}.migration_paths`);
    assertSafePathArray(a.fixture_paths, `pipelines.${a.id}.fixture_paths`);
    if (a.conflict_group !== undefined && (typeof a.conflict_group !== 'string' || !a.conflict_group.trim())) {
      throw new ManifestV2PolicyError(`pipelines.${a.id}.conflict_group must be a non-empty string`);
    }
    for (let j = i + 1; j < pipelines.length; j += 1) {
      const b = pipelines[j];
      const conflict =
        (a.conflict_group && a.conflict_group === b.conflict_group) ||
        pathsConflict(a, b, 'exclusive_paths') ||
        pathsConflict(a, b, 'migration_paths') ||
        pathsConflict(a, b, 'fixture_paths');
      if (!conflict) continue;
      const serialized = dependencyReachable(pipelines, a.id, b.id) || dependencyReachable(pipelines, b.id, a.id);
      if (!serialized) {
        throw new ManifestV2PolicyError(
          `CONFLICT_NOT_SERIALIZED: ${a.id} and ${b.id} share conflict metadata but neither depends on the other`,
        );
      }
    }
  }
}

function validatePlanningReadiness(manifest, root) {
  const readiness = manifest.planning_readiness;
  if (!readiness || typeof readiness !== 'object' || readiness.design_freeze !== true) {
    throw new ManifestV2PolicyError('schema v2 design-freeze manifest requires planning_readiness.design_freeze=true');
  }
  if (!Array.isArray(readiness.required_gates) || readiness.required_gates.length === 0 ||
      readiness.required_gates.some((value) => typeof value !== 'string' || !value)) {
    throw new ManifestV2PolicyError('planning_readiness.required_gates must be a non-empty string array');
  }
  if (new Set(readiness.required_gates).size !== readiness.required_gates.length) {
    throw new ManifestV2PolicyError('planning_readiness.required_gates contains duplicates');
  }
  if (!readiness.gates || typeof readiness.gates !== 'object' || Array.isArray(readiness.gates)) {
    throw new ManifestV2PolicyError('planning_readiness.gates must be an object');
  }
  for (const gate of readiness.required_gates) {
    const record = readiness.gates[gate];
    if (!record || record.required !== true) {
      throw new ManifestV2PolicyError(`planning gate is missing or not required: ${gate}`);
    }
    if (record.status !== 'ready') {
      throw new ManifestV2PolicyError(`PLANNING_GATE_NOT_READY: ${gate} status=${String(record.status)}`);
    }
    if (record.cycles !== undefined && (!Number.isInteger(record.cycles) || record.cycles < 1 || record.cycles > 3)) {
      throw new ManifestV2PolicyError(`planning gate cycles must be 1..3: ${gate}`);
    }
    if (record.blocking_decision_ids !== undefined &&
        (!Array.isArray(record.blocking_decision_ids) || record.blocking_decision_ids.length > 0)) {
      throw new ManifestV2PolicyError(`ready planning gate cannot retain blocking_decision_ids: ${gate}`);
    }
    readFrozenArtifact(root, record.artifact, `planning_readiness.gates.${gate}.artifact`);
    if (record.review !== undefined) {
      readFrozenArtifact(root, record.review, `planning_readiness.gates.${gate}.review`);
    }
  }

  const required = readiness.required_artifacts;
  const keys = ['decision_register', 'technology_evidence', 'contract_inventory', 'test_strategy', 'accepted_risks', 'work_items'];
  if (!required || typeof required !== 'object') {
    throw new ManifestV2PolicyError('planning_readiness.required_artifacts is required');
  }
  for (const key of keys) {
    readFrozenArtifact(root, required[key], `planning_readiness.required_artifacts.${key}`);
  }

  if (!Array.isArray(manifest.open_decisions) || manifest.open_decisions.length !== 0) {
    throw new ManifestV2PolicyError('schema v2 design-freeze manifest requires open_decisions=[] before init');
  }
}

function validateWorkItems(manifest, root) {
  if (!Array.isArray(manifest.work_items) || manifest.work_items.length === 0) {
    throw new ManifestV2PolicyError('schema v2 manifest requires frozen work_items');
  }
  const pipelines = new Map((manifest.pipelines ?? []).map((pipeline) => [pipeline.id, pipeline]));
  const ids = new Set();
  for (const item of manifest.work_items) {
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id)) {
      throw new ManifestV2PolicyError('work_items must have unique non-empty ids');
    }
    ids.add(item.id);
    if (!pipelines.has(item.pipeline_id)) {
      throw new ManifestV2PolicyError(`work item references unknown pipeline: ${item.id} -> ${String(item.pipeline_id)}`);
    }
    readFrozenArtifact(root, item, `work_items.${item.id}`);
  }
  for (const pipeline of manifest.pipelines ?? []) {
    if (!Array.isArray(pipeline.work_items) || pipeline.work_items.length === 0) {
      throw new ManifestV2PolicyError(`pipeline must reference at least one frozen work item: ${pipeline.id}`);
    }
    for (const id of pipeline.work_items) {
      const item = manifest.work_items.find((candidate) => candidate.id === id);
      if (!item || item.pipeline_id !== pipeline.id) {
        throw new ManifestV2PolicyError(`pipeline work item mapping is invalid: ${pipeline.id}/${String(id)}`);
      }
    }
    for (const field of ['decision_ids', 'research_ids', 'contract_ids']) {
      if (!Array.isArray(pipeline[field])) {
        throw new ManifestV2PolicyError(`schema v2 pipeline must define ${field}: ${pipeline.id}`);
      }
    }
  }
}

function validateSourceSnapshot(manifest, root) {
  if (manifest.source_type !== 'github_issues') return;
  if (!SHA256.test(String(manifest.source_snapshot_sha256 ?? ''))) {
    throw new ManifestV2PolicyError('github_issues schema v2 manifest requires source_snapshot_sha256');
  }
  const file = join(root, 'sources', 'github-issues.json');
  let content;
  try { content = readFileSync(file, 'utf8'); }
  catch { throw new ManifestV2PolicyError('authoritative GitHub Issue snapshot is missing'); }
  if (sha256(content) !== manifest.source_snapshot_sha256.toLowerCase()) {
    throw new ManifestV2PolicyError('authoritative GitHub Issue snapshot SHA-256 mismatch');
  }
}

function validateProjectPolicy(manifest, cwd) {
  const defaultRelative = '.opencode/pipeline-policy.json';
  const defaultFile = resolve(cwd, defaultRelative);
  const hasDefault = exists(defaultFile);
  if (!hasDefault && manifest.project_policy === undefined) return undefined;
  const ref = manifest.project_policy;
  if (!ref || typeof ref !== 'object' || !safeRelativePath(ref.path) || !SHA256.test(String(ref.sha256 ?? ''))) {
    throw new ManifestV2PolicyError('project policy exists but manifest.project_policy path + SHA-256 is missing');
  }
  const file = resolve(cwd, ref.path);
  if (!exists(file)) throw new ManifestV2PolicyError(`project policy is missing: ${ref.path}`);
  const content = readFileSync(file, 'utf8');
  const actual = sha256(content);
  if (actual !== ref.sha256.toLowerCase()) throw new ManifestV2PolicyError('project policy SHA-256 mismatch');

  let policy;
  try { policy = JSON.parse(content); }
  catch { throw new ManifestV2PolicyError('project policy is not valid JSON'); }
  if (policy.schema_version !== 1) throw new ManifestV2PolicyError('project policy schema_version must be 1');
  assertSafePathArray(policy.protected_paths, 'project_policy.protected_paths');

  for (const protectedPath of policy.protected_paths ?? []) {
    for (const scope of manifest.allowed_change_paths ?? []) {
      if (scopesOverlap(protectedPath, scope)) {
        throw new ManifestV2PolicyError(`PROTECTED_PATH_IN_SCOPE: ${scope} overlaps ${protectedPath}`);
      }
    }
  }

  if (policy.required_gates !== undefined) {
    if (!Array.isArray(policy.required_gates)) throw new ManifestV2PolicyError('project_policy.required_gates must be an array');
    for (const rule of policy.required_gates) {
      if (!rule || typeof rule.stage !== 'string' || !Array.isArray(rule.when_paths) ||
          rule.when_paths.some((value) => !safeRelativePath(value))) {
        throw new ManifestV2PolicyError('project_policy.required_gates entries require stage + safe when_paths');
      }
      const triggered = (manifest.allowed_change_paths ?? []).some((scope) =>
        rule.when_paths.some((candidate) => scopesOverlap(scope, candidate)));
      if (triggered && !(manifest.pipelines ?? []).some((pipeline) => pipeline.stages?.includes(rule.stage))) {
        throw new ManifestV2PolicyError(`PROJECT_GATE_MISSING: ${rule.stage}`);
      }
    }
  }
  return { path: ref.path, sha256: actual };
}

function detectJsPackageManager(cwd) {
  let declared;
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    if (typeof pkg.packageManager === 'string') declared = pkg.packageManager.split('@')[0];
  } catch {}
  if (declared && ['pnpm', 'npm', 'yarn', 'bun'].includes(declared)) return declared;
  if (exists(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (exists(join(cwd, 'package-lock.json')) || exists(join(cwd, 'npm-shrinkwrap.json'))) return 'npm';
  if (exists(join(cwd, 'yarn.lock'))) return 'yarn';
  if (exists(join(cwd, 'bun.lock')) || exists(join(cwd, 'bun.lockb'))) return 'bun';
  return undefined;
}

function invocationManager(tokens) {
  const exe = tokens[0];
  if (exe === 'corepack') return tokens[1] === 'pnpm' ? 'pnpm' : tokens[1];
  if (JS_MANAGERS.has(exe)) return exe === 'npx' ? 'npm' : exe;
  if (JS_DIRECT_TOOLS.has(exe)) return 'direct';
  return undefined;
}

export function validatePackageManagerContract(invocations, { cwd = process.cwd(), environment = false, executableOnPath } = {}) {
  const manager = detectJsPackageManager(cwd);
  if (!manager) return { package_manager: null };
  for (const { profile, gate, tokens } of invocations) {
    if (tokens[0] === 'npx' && tokens.includes('--yes')) {
      throw new ManifestV2PolicyError(`DEPENDENCY_BOOTSTRAP_FORBIDDEN: npx --yes in ${profile}/${gate}`);
    }
    const used = invocationManager(tokens);
    if (!used) continue;
    if (used === 'direct' || used !== manager) {
      throw new ManifestV2PolicyError(
        `JS_PACKAGE_MANAGER_MISMATCH: project uses ${manager}, gate ${profile}/${gate} uses ${tokens[0]}`,
      );
    }
  }
  if (environment && executableOnPath) {
    const managerUsedDirectly = invocations.some(({ tokens }) =>
      tokens[0] === manager || (tokens[0] === 'corepack' && tokens[1] === manager));
    if (managerUsedDirectly) {
      const executable = invocations.some(({ tokens }) => tokens[0] === manager) ? manager : 'corepack';
      if (!executableOnPath(executable)) {
        throw new ManifestV2PolicyError(`EXECUTABLE_NOT_FOUND: ${executable} is required by project packageManager=${manager}`);
      }
    }
  }
  return { package_manager: manager };
}

export function validateManifestV2Policy(manifest, options = {}) {
  if (manifest?.schema_version !== 2) return { checked_artifacts: 0, project_policy: undefined };
  if (manifest.planning_mode !== 'design-freeze') {
    throw new ManifestV2PolicyError('schema v2 requires planning_mode=design-freeze');
  }
  const cwd = options.cwd ?? process.cwd();
  const root = runRoot(manifest, cwd, options.manifestPath);
  validatePlanningReadiness(manifest, root);
  validateWorkItems(manifest, root);
  validateSourceSnapshot(manifest, root);
  assertConflictSerialization(manifest);
  const projectPolicy = validateProjectPolicy(manifest, cwd);
  return { checked_artifacts: true, project_policy: projectPolicy };
}
