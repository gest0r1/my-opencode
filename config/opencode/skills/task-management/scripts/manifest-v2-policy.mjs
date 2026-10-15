import { createHash } from 'node:crypto';
import { accessSync, constants, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { validateGateTesting, resolveGateTesting } from './gate-testing-policy.mjs';
import { validateGenerators } from './generator-cli.mjs';

export class ManifestV2PolicyError extends Error {}

const SHA = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const SUPERSEDE_REASONS = new Set([
  'MANIFEST_CONTRACT_CORRECTION',
  'BASELINE_SCOPE_MISMATCH',
  'PLANNING_EVIDENCE_CORRECTION',
  'OWNER_SCOPE_CHANGE',
  'ARCHITECTURE_REPLAN',
  'MAIN_DRIFT_REPLAN',
]);
const JS_MANAGERS = new Set(['npm', 'npx', 'pnpm', 'yarn', 'bun', 'corepack']);
const JS_DIRECT_TOOLS = new Set(['tsc', 'vitest', 'jest']);
const STAGE_EXECUTORS = new Set(['agent', 'review', 'local_gate', 'git_verify', 'git_publish', 'github_ci', 'github_dev', 'owner_acceptance']);
const GITHUB_JOB_ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;

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

function safeScopePath(value) {
  if (typeof value !== 'string' || !value) return false;
  if (value.endsWith('/**')) {
    const base = value.slice(0, -3).replace(/\/$/, '');
    return safeRelativePath(base) && !/[?*\[\]{}]/.test(base);
  }
  return safeRelativePath(value) && !/[?*\[\]{}]/.test(value);
}

function assertSafePathArray(value, field) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => !safeScopePath(item))) {
    throw new ManifestV2PolicyError(
      `${field} supports only exact repository-relative paths or directory/** scopes`,
    );
  }
}

function validatePreservedBaseline(manifest) {
  const baseline = manifest.preserved_baseline;
  if (baseline === undefined) return;
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline) ||
      !SHA.test(String(baseline.head_sha ?? '')) ||
      !SHA256.test(String(baseline.diff_sha256 ?? '')) ||
      !Array.isArray(baseline.changed_paths) ||
      baseline.changed_paths.length === 0 ||
      baseline.changed_paths.some((path) => !safeRelativePath(path)) ||
      new Set(baseline.changed_paths).size !== baseline.changed_paths.length) {
    throw new ManifestV2PolicyError('PRESERVED_BASELINE_INVALID');
  }
  const sorted = [...baseline.changed_paths].sort();
  if (JSON.stringify(sorted) !== JSON.stringify(baseline.changed_paths)) {
    throw new ManifestV2PolicyError('PRESERVED_BASELINE_PATHS_NOT_SORTED');
  }
  if (!manifest.git_setup || !SHA.test(String(manifest.git_setup.base_sha ?? ''))) {
    throw new ManifestV2PolicyError('PRESERVED_BASELINE_REQUIRES_GIT_SETUP');
  }
}

function validateLineage(manifest) {
  const lineage = manifest.lineage;
  if (lineage === undefined) return;
  if (!lineage || typeof lineage !== 'object' || Array.isArray(lineage) ||
      !['supersede', 'replan'].includes(lineage.change_class) ||
      typeof lineage.supersedes !== 'string' || !lineage.supersedes.trim() ||
      lineage.supersedes === manifest.run_id ||
      !SUPERSEDE_REASONS.has(lineage.reason_code)) {
    throw new ManifestV2PolicyError('PIPELINE_LINEAGE_INVALID');
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

// Independent pipelines run at the same time in one checkout. Work items of two pipelines that
// neither depends on must not be allowed to change the same paths, or parallel workers would edit
// the same files; shared files belong to the delivery sink or a serialized conflict group.
function assertParallelScopes(manifest, root) {
  const pipelines = manifest.pipelines ?? [];
  const scopes = new Map(pipelines.map(pipeline => [pipeline.id, []]));
  for (const item of manifest.work_items ?? []) {
    let record;
    try { record = JSON.parse(readFileSync(resolve(root, item.path), 'utf8')); } catch { continue; }
    if (Array.isArray(record?.allowed_change_paths)) scopes.get(item.pipeline_id)?.push(...record.allowed_change_paths.filter(path => typeof path === 'string'));
  }
  for (let i = 0; i < pipelines.length; i += 1) {
    for (let j = i + 1; j < pipelines.length; j += 1) {
      const a = pipelines[i]; const b = pipelines[j];
      if (dependencyReachable(pipelines, a.id, b.id) || dependencyReachable(pipelines, b.id, a.id)) continue;
      const overlap = scopes.get(a.id).find(x => scopes.get(b.id).some(y => scopesOverlap(x, y)));
      if (overlap) {
        throw new ManifestV2PolicyError(`PARALLEL_SCOPE_OVERLAP: ${a.id} and ${b.id} run in parallel and both may change ${overlap}; move the shared path to one pipeline or serialize them with depends_on`);
      }
    }
  }
}

function validatePlanningInputs(manifest) {
  if (manifest.planning_scope !== undefined) {
    if (!Array.isArray(manifest.planning_scope) || !manifest.planning_scope.length) throw new ManifestV2PolicyError('planning_scope must be a non-empty path-scope array');
    assertSafePathArray(manifest.planning_scope, 'planning_scope');
  }
  if (manifest.planning_inputs === undefined) return;
  const inputs = manifest.planning_inputs;
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs) || Object.keys(inputs).length === 0) {
    throw new ManifestV2PolicyError('planning_inputs must be a non-empty object when present');
  }
  const gateIds = new Set(Object.keys(manifest.planning_readiness?.gates ?? {}));
  for (const [gate, scopes] of Object.entries(inputs)) {
    if (!gate || (gate !== 'work_items' && !gateIds.has(gate))) {
      throw new ManifestV2PolicyError(`planning_inputs key must reference an existing planning gate or work_items: ${gate || '<empty>'}`);
    }
    if (!Array.isArray(scopes) || scopes.length === 0) {
      throw new ManifestV2PolicyError(`planning_inputs.${gate} must be a non-empty path-scope array`);
    }
    assertSafePathArray(scopes, `planning_inputs.${gate}`);
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
  const mandatory = ['decision_register', 'work_items'];
  const optional = ['technology_evidence', 'contract_inventory'];
  if (!required || typeof required !== 'object') {
    throw new ManifestV2PolicyError('planning_readiness.required_artifacts is required');
  }
  for (const key of mandatory) {
    readFrozenArtifact(root, required[key], `planning_readiness.required_artifacts.${key}`);
  }
  for (const key of optional) {
    if (required[key] !== undefined) {
      readFrozenArtifact(root, required[key], `planning_readiness.required_artifacts.${key}`);
    }
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
    const pipeline = pipelines.get(item.pipeline_id);
    if (!pipeline.work_items?.includes(item.id)) throw new ManifestV2PolicyError(`UNBOUND_WORK_ITEM: ${item.id}`);
    if (!Object.values(pipeline.executors ?? {}).includes('agent')) throw new ManifestV2PolicyError(`WORK_ITEM_NOT_EXECUTABLE: ${item.id}`);
  }
  const records = new Map(manifest.work_items.map(item => [item.id, JSON.parse(readFileSync(resolve(root, item.path), 'utf8'))]));
  const visited = new Set(), visiting = new Set();
  const visit = id => {
    if (visiting.has(id)) throw new ManifestV2PolicyError(`WORK_ITEM_DEPENDENCY_CYCLE: ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    const dependencies = records.get(id).depends_on ?? [];
    if (!Array.isArray(dependencies)) throw new ManifestV2PolicyError(`INVALID_WORK_ITEM_DEPENDENCIES: ${id}`);
    for (const dependency of dependencies) {
      if (!records.has(dependency)) throw new ManifestV2PolicyError(`UNKNOWN_WORK_ITEM_DEPENDENCY: ${id}/${dependency}`);
      visit(dependency);
    }
    visiting.delete(id); visited.add(id);
  };
  for (const id of records.keys()) visit(id);
  for (const pipeline of manifest.pipelines ?? []) {
    if (new Set(pipeline.work_items ?? []).size !== (pipeline.work_items ?? []).length) throw new ManifestV2PolicyError(`DUPLICATE_WORK_ITEM_MAPPING: ${pipeline.id}`);
    for (const [index, id] of (pipeline.work_items ?? []).entries()) {
      for (const dependency of records.get(id)?.depends_on ?? []) {
        const dependencyIndex = pipeline.work_items.indexOf(dependency);
        if (dependencyIndex >= index) throw new ManifestV2PolicyError(`WORK_ITEM_DEPENDENCY_ORDER: ${id}/${dependency}`);
      }
    }
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

function validateSourceRequirements(manifest) {
  if (manifest.source_type !== 'github_issues') return;
  if (!SHA256.test(String(manifest.source_requirements_sha256 ?? ''))) {
    throw new ManifestV2PolicyError(
      'github_issues schema v2 manifest requires source_requirements_sha256',
    );
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
  if (policy.github_actions !== undefined) {
    if (!policy.github_actions || typeof policy.github_actions !== 'object' || Array.isArray(policy.github_actions)) {
      throw new ManifestV2PolicyError('project_policy.github_actions must be an object');
    }
    for (const [kind, gate] of Object.entries(policy.github_actions)) {
      if (!['ci', 'dev'].includes(kind) || !gate || typeof gate !== 'object' || Array.isArray(gate)) {
        throw new ManifestV2PolicyError('project_policy.github_actions may define only ci/dev objects');
      }
      if (!safeRelativePath(gate.workflow) || !gate.workflow.startsWith('.github/workflows/') ||
          !/\.ya?ml$/i.test(gate.workflow) || !GITHUB_JOB_ID.test(String(gate.terminal_job ?? ''))) {
        throw new ManifestV2PolicyError(`project_policy.github_actions.${kind} has invalid workflow/terminal_job`);
      }
      if (gate.trigger !== undefined && !['push', 'pull_request', 'workflow_dispatch'].includes(gate.trigger)) {
        throw new ManifestV2PolicyError(`project_policy.github_actions.${kind}.trigger is invalid`);
      }
      if (gate.required_jobs !== undefined &&
          (!Array.isArray(gate.required_jobs) || gate.required_jobs.length === 0 ||
           gate.required_jobs.some((job) => typeof job !== 'string' || !GITHUB_JOB_ID.test(job)) ||
           new Set(gate.required_jobs).size !== gate.required_jobs.length)) {
        throw new ManifestV2PolicyError(`project_policy.github_actions.${kind}.required_jobs is invalid`);
      }
      if (kind === 'dev' && gate.mode === 'stateful') {
        if (gate.trigger !== 'workflow_dispatch' ||
            typeof gate.environment !== 'string' || !gate.environment.trim() ||
            typeof gate.trusted_ref !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(gate.trusted_ref) ||
            gate.trusted_ref.includes('..') || gate.trusted_ref.endsWith('/') ||
            typeof gate.concurrency_group !== 'string' || !gate.concurrency_group.trim()) {
          throw new ManifestV2PolicyError('project_policy.github_actions.dev stateful contract is incomplete');
        }
      }
    }
  }

  if (policy.deployment_target !== undefined) {
    const target = policy.deployment_target;
    if (!target || typeof target !== 'object' || Array.isArray(target) || target.kind !== 'opencode_host') {
      throw new ManifestV2PolicyError('project_policy.deployment_target.kind must be opencode_host');
    }
    if (!['github_ssh', 'self_hosted_runner'].includes(target.transport) ||
        typeof target.target_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(target.target_id) ||
        typeof target.environment !== 'string' || !target.environment.trim() ||
        !safeRelativePath(target.probe_workflow) || !target.probe_workflow.startsWith('.github/workflows/') ||
        !/\.ya?ml$/i.test(target.probe_workflow) ||
        !GITHUB_JOB_ID.test(String(target.probe_job ?? '')) ||
        typeof target.trusted_ref !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(target.trusted_ref) ||
        target.trusted_ref.includes('..') || target.trusted_ref.endsWith('/')) {
      throw new ManifestV2PolicyError('project_policy.deployment_target opencode_host contract is incomplete');
    }
    const secrets = target.required_environment_secrets ?? [];
    if (!Array.isArray(secrets) ||
        secrets.some((name) => typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) ||
        new Set(secrets).size !== secrets.length) {
      throw new ManifestV2PolicyError('project_policy.deployment_target required_environment_secrets is invalid');
    }
    if (target.transport === 'github_ssh' && secrets.length === 0) {
      throw new ManifestV2PolicyError('project_policy.deployment_target github_ssh requires environment secret names');
    }
    const labels = target.runner_labels ?? [];
    if (!Array.isArray(labels) || labels.some((label) => typeof label !== 'string' || !label.trim())) {
      throw new ManifestV2PolicyError('project_policy.deployment_target runner_labels is invalid');
    }
    if (target.transport === 'self_hosted_runner' && labels.length === 0) {
      throw new ManifestV2PolicyError('project_policy.deployment_target self_hosted_runner requires labels');
    }
  }

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


function validateGithubExecutionContract(manifest) {
  const workItems = new Map((manifest.work_items ?? []).map((item) => [item.id, item]));
  const dependedOn = new Set(
    (manifest.pipelines ?? []).flatMap((pipeline) => pipeline.depends_on ?? []),
  );
  for (const pipeline of manifest.pipelines ?? []) {
    if (!pipeline.executors || typeof pipeline.executors !== 'object' || Array.isArray(pipeline.executors)) {
      throw new ManifestV2PolicyError(`schema v2 pipeline requires executors: ${pipeline.id}`);
    }
    if (typeof pipeline.deployable !== 'boolean') {
      throw new ManifestV2PolicyError(`schema v2 pipeline must declare deployable=true|false: ${pipeline.id}`);
    }
    const stageSet = new Set(pipeline.stages ?? []);
    const executorKeys = Object.keys(pipeline.executors);
    if (executorKeys.length !== stageSet.size || executorKeys.some((stage) => !stageSet.has(stage))) {
      throw new ManifestV2PolicyError(`EXECUTOR_STAGE_MISMATCH: executors must map every stage exactly once: ${pipeline.id}`);
    }

    const stages = pipeline.stages ?? [];
    if (dependedOn.has(pipeline.id)) {
      if (typeof pipeline.ready_after_stage !== 'string' || !stages.includes(pipeline.ready_after_stage)) {
        throw new ManifestV2PolicyError(`DEPENDENCY_SOURCE_READY_STAGE_REQUIRED: ${pipeline.id}`);
      }
      const readyIndex = stages.indexOf(pipeline.ready_after_stage);
      for (const later of stages.slice(readyIndex + 1)) {
        if (pipeline.executors[later] === 'agent') {
          throw new ManifestV2PolicyError(
            `SOURCE_STAGE_AFTER_READY_BOUNDARY: ${pipeline.id}/${later}`,
          );
        }
      }
    }
    if (stages.some((stage) => pipeline.executors[stage] === 'github_dev') && pipeline.deployable !== true) {
      throw new ManifestV2PolicyError(`GITHUB_DEV_REQUIRES_DEPLOYABLE_PIPELINE: ${pipeline.id}`);
    }
    const firstPublishIndex = stages.findIndex((stage) => pipeline.executors[stage] === 'git_publish');
    if (firstPublishIndex >= 0) {
      const verifyBeforePublish = stages.slice(0, firstPublishIndex)
        .some((stage) => pipeline.executors[stage] === 'git_verify');
      if (!verifyBeforePublish) {
        throw new ManifestV2PolicyError(`GIT_PUBLISH_REQUIRES_VERIFY: ${pipeline.id}`);
      }
      for (const later of stages.slice(firstPublishIndex + 1)) {
        if (pipeline.executors[later] === 'agent') {
          throw new ManifestV2PolicyError(`SOURCE_STAGE_AFTER_PUBLISH: ${pipeline.id}/${later}`);
        }
      }
    }

    for (const stage of stages) {
      const executor = pipeline.executors[stage];
      if (!STAGE_EXECUTORS.has(executor)) {
        throw new ManifestV2PolicyError(`INVALID_STAGE_EXECUTOR: ${pipeline.id}/${stage}=${String(executor)}`);
      }
      if (executor === 'owner_acceptance' && pipeline.deployable !== true) {
        throw new ManifestV2PolicyError(`OWNER_ACCEPTANCE_REQUIRES_DEPLOYABLE_PIPELINE: ${pipeline.id}/${stage}`);
      }

      const gate = pipeline.github_gates?.[stage];
      if (executor === 'github_ci' || executor === 'github_dev') {
        if (executor === 'github_ci') {
          const index = stages.indexOf(stage);
          if (!stages.slice(0, index).some((name) => pipeline.executors[name] === 'git_publish')) {
            throw new ManifestV2PolicyError(`GITHUB_CI_REQUIRES_PUBLISHED_CANDIDATE: ${pipeline.id}/${stage}`);
          }
        }
        if (!gate || typeof gate !== 'object' || Array.isArray(gate)) {
          throw new ManifestV2PolicyError(`GITHUB_GATE_MISSING: ${pipeline.id}/${stage}`);
        }
        if (!safeRelativePath(gate.workflow) || !gate.workflow.startsWith('.github/workflows/') ||
            !/\.ya?ml$/i.test(gate.workflow)) {
          throw new ManifestV2PolicyError(`GITHUB_WORKFLOW_INVALID: ${pipeline.id}/${stage}`);
        }
        if (!GITHUB_JOB_ID.test(String(gate.terminal_job ?? ''))) {
          throw new ManifestV2PolicyError(`GITHUB_TERMINAL_JOB_INVALID: ${pipeline.id}/${stage}`);
        }
        if (gate.required_jobs !== undefined &&
            (!Array.isArray(gate.required_jobs) || gate.required_jobs.length === 0 ||
             gate.required_jobs.some((job) => typeof job !== 'string' || !GITHUB_JOB_ID.test(job)) ||
             new Set(gate.required_jobs).size !== gate.required_jobs.length)) {
          throw new ManifestV2PolicyError(`GITHUB_REQUIRED_JOBS_INVALID: ${pipeline.id}/${stage}`);
        }
        if (!['push', 'pull_request', 'workflow_dispatch'].includes(gate.trigger)) {
          throw new ManifestV2PolicyError(`GITHUB_TRIGGER_INVALID: ${pipeline.id}/${stage}`);
        }
        if (gate.trigger === 'pull_request' && (!Number.isSafeInteger(gate.pr_number) || gate.pr_number < 1)) {
          throw new ManifestV2PolicyError(`GITHUB_PR_NUMBER_REQUIRED: ${pipeline.id}/${stage}`);
        }
        if (gate.timeout_seconds !== undefined &&
            (!Number.isInteger(gate.timeout_seconds) || gate.timeout_seconds < 30 || gate.timeout_seconds > 7200)) {
          throw new ManifestV2PolicyError(`GITHUB_TIMEOUT_INVALID: ${pipeline.id}/${stage}`);
        }

        if (gate.bootstrap_required === true) {
          if (typeof gate.bootstrap_work_item_id !== 'string' || !gate.bootstrap_work_item_id) {
            throw new ManifestV2PolicyError(`GITHUB_BOOTSTRAP_WORK_ITEM_MISSING: ${pipeline.id}/${stage}`);
          }
          const item = workItems.get(gate.bootstrap_work_item_id);
          if (!item || item.pipeline_id !== pipeline.id || !(pipeline.work_items ?? []).includes(item.id)) {
            throw new ManifestV2PolicyError(`GITHUB_BOOTSTRAP_WORK_ITEM_INVALID: ${pipeline.id}/${stage}`);
          }
          if (!(manifest.allowed_change_paths ?? []).some((scope) => scopeContains(scope, gate.workflow))) {
            throw new ManifestV2PolicyError(`GITHUB_BOOTSTRAP_SCOPE_MISSING: ${gate.workflow} is outside allowed_change_paths`);
          }
          if (gate.trigger !== 'push') {
            throw new ManifestV2PolicyError(`GITHUB_BOOTSTRAP_REQUIRES_PUSH: ${pipeline.id}/${stage}`);
          }
        }

        if (executor === 'github_dev') {
          if (!['disposable', 'stateful'].includes(gate.mode)) {
            throw new ManifestV2PolicyError('GITHUB_DEV_MODE_INVALID: ' + pipeline.id + '/' + stage);
          }
          if (typeof gate.source_ci_stage !== 'string' || pipeline.executors[gate.source_ci_stage] !== 'github_ci') {
            throw new ManifestV2PolicyError('GITHUB_DEV_SOURCE_CI_INVALID: ' + pipeline.id + '/' + stage);
          }
          if (pipeline.stages.indexOf(gate.source_ci_stage) >= pipeline.stages.indexOf(stage)) {
            throw new ManifestV2PolicyError('GITHUB_DEV_SOURCE_CI_ORDER_INVALID: ' + pipeline.id + '/' + stage);
          }
          const sourceGate = pipeline.github_gates?.[gate.source_ci_stage];
          if (!sourceGate) {
            throw new ManifestV2PolicyError('GITHUB_DEV_SOURCE_CI_GATE_MISSING: ' + pipeline.id + '/' + stage);
          }
          if (gate.trigger !== 'workflow_dispatch') {
            throw new ManifestV2PolicyError('GITHUB_DEV_REQUIRES_DISPATCH: ' + pipeline.id + '/' + stage);
          }
          if (gate.bootstrap_required === true) {
            throw new ManifestV2PolicyError('GITHUB_DEV_CANNOT_BOOTSTRAP_SEPARATELY: ' + pipeline.id + '/' + stage);
          }
          if ((gate.artifact === undefined) !== (gate.evidence_file === undefined)) {
            throw new ManifestV2PolicyError('GITHUB_DEV_LEGACY_ARTIFACT_PAIR_INVALID: ' + pipeline.id + '/' + stage);
          }
          if (gate.evidence_file !== undefined &&
              (typeof gate.evidence_file !== 'string' || !/^[A-Za-z0-9._-]+\.json$/.test(gate.evidence_file))) {
            throw new ManifestV2PolicyError('GITHUB_DEV_EVIDENCE_FILE_INVALID: ' + pipeline.id + '/' + stage);
          }

          if (gate.mode === 'stateful') {
            if (typeof gate.environment !== 'string' || !gate.environment.trim()) {
              throw new ManifestV2PolicyError('GITHUB_DEV_ENVIRONMENT_REQUIRED: ' + pipeline.id + '/' + stage);
            }
            if (typeof gate.concurrency_group !== 'string' || !gate.concurrency_group.trim()) {
              throw new ManifestV2PolicyError('GITHUB_DEV_CONCURRENCY_GROUP_REQUIRED: ' + pipeline.id + '/' + stage);
            }
            if (typeof gate.trusted_ref !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(gate.trusted_ref) ||
                gate.trusted_ref.includes('..') || gate.trusted_ref.endsWith('/')) {
              throw new ManifestV2PolicyError('GITHUB_DEV_TRUSTED_REF_INVALID: ' + pipeline.id + '/' + stage);
            }
            if ((manifest.allowed_change_paths ?? []).some((scope) => scopesOverlap(scope, gate.workflow))) {
              throw new ManifestV2PolicyError('GITHUB_STATEFUL_DEV_WORKFLOW_MUTABLE: ' + gate.workflow + ' must remain trusted outside candidate change scope');
            }
          } else if (gate.trusted_ref !== undefined || gate.environment !== undefined || gate.concurrency_group !== undefined) {
            throw new ManifestV2PolicyError('GITHUB_DISPOSABLE_DEV_MUST_NOT_USE_TRUSTED_ENVIRONMENT: ' + pipeline.id + '/' + stage);
          }
        }
      } else if (gate !== undefined) {
        throw new ManifestV2PolicyError(`GITHUB_GATE_WITH_NON_GITHUB_EXECUTOR: ${pipeline.id}/${stage}`);
      }
    }

    if (pipeline.deployable) {
      const validation = pipeline.deployment_validation;
      if (!validation || typeof validation !== 'object' ||
          typeof validation.stage !== 'string' || !stageSet.has(validation.stage)) {
        throw new ManifestV2PolicyError(`DEPLOYMENT_VALIDATION_REQUIRED: ${pipeline.id}`);
      }
      const ciMode = pipeline.github_ci_mode ?? 'required';
      if (!['required', 'optional', 'off'].includes(ciMode)) throw new ManifestV2PolicyError(`GITHUB_CI_MODE_INVALID: ${pipeline.id}`);
      const validationExecutor = pipeline.executors[validation.stage];
      if (ciMode === 'off') {
        // Owner chose no GitHub CI: the frozen local gate is the delivery validation.
        if (Object.values(pipeline.executors).includes('github_ci') || validationExecutor !== 'local_gate') {
          throw new ManifestV2PolicyError(`GITHUB_CI_MODE_OFF_REQUIRES_LOCAL_VALIDATION: ${pipeline.id}/${validation.stage}`);
        }
      } else if (validationExecutor !== 'github_ci') {
        throw new ManifestV2PolicyError(`DEPLOYMENT_VALIDATION_REQUIRES_FINAL_GITHUB_CI: ${pipeline.id}/${validation.stage}`);
      }

      const hasFreshJob = validation.fresh_job !== undefined;
      const hasUpgradeJob = validation.upgrade_job !== undefined;
      if (hasFreshJob !== hasUpgradeJob ||
          (hasFreshJob && (
            !GITHUB_JOB_ID.test(String(validation.fresh_job)) ||
            !GITHUB_JOB_ID.test(String(validation.upgrade_job)) ||
            validation.fresh_job === validation.upgrade_job
          ))) {
        throw new ManifestV2PolicyError(`DEPLOYMENT_VALIDATION_LEGACY_JOBS_INVALID: ${pipeline.id}`);
      }

      const strategy = pipeline.testing_strategy;
      if (!strategy || typeof strategy !== 'object' ||
          !['github', 'opencode_host', 'hybrid'].includes(strategy.mode) ||
          typeof strategy.owner_decision_id !== 'string' || !strategy.owner_decision_id.trim() ||
          !(pipeline.decision_ids ?? []).includes(strategy.owner_decision_id)) {
        throw new ManifestV2PolicyError(`DEPLOYMENT_TESTING_STRATEGY_REQUIRED: ${pipeline.id}`);
      }

      const stageIndex = (name) => typeof name === 'string' ? stages.indexOf(name) : -1;
      if (strategy.github_validation_stage !== validation.stage) {
        throw new ManifestV2PolicyError(`FINAL_GITHUB_CI_STAGE_MISMATCH: ${pipeline.id}`);
      }

      if (strategy.mode === 'github') {
        if (strategy.opencode_host_stage !== undefined ||
            strategy.post_deploy_test !== undefined ||
            strategy.owner_acceptance_stage !== undefined) {
          throw new ManifestV2PolicyError(`GITHUB_ONLY_TEST_STRATEGY_INVALID: ${pipeline.id}`);
        }
      }

      if (strategy.mode === 'opencode_host') {
        const remoteStage = strategy.opencode_host_stage;
        const remoteGate = typeof remoteStage === 'string' ? pipeline.github_gates?.[remoteStage] : undefined;
        if (typeof remoteStage !== 'string' ||
            pipeline.executors[remoteStage] !== 'github_dev' ||
            remoteGate?.mode !== 'stateful' ||
            !['automated', 'user', 'automated_then_user'].includes(strategy.post_deploy_test) ||
            stageIndex(validation.stage) >= stageIndex(remoteStage)) {
          throw new ManifestV2PolicyError(`OPENCODE_HOST_TEST_STRATEGY_INVALID: ${pipeline.id}`);
        }
        if (!manifest.deployment_target_check) {
          throw new ManifestV2PolicyError(`OPENCODE_HOST_TARGET_CHECK_REQUIRED: ${pipeline.id}`);
        }
        if (typeof remoteGate.environment !== 'string' || typeof remoteGate.trusted_ref !== 'string') {
          throw new ManifestV2PolicyError(`OPENCODE_HOST_GITHUB_DEV_REQUIRED: ${pipeline.id}`);
        }
      }

      if (strategy.mode === 'hybrid') {
        const localStage = strategy.opencode_host_stage;
        if (typeof localStage !== 'string' ||
            pipeline.executors[localStage] !== 'local_gate' ||
            !['automated', 'user', 'automated_then_user'].includes(strategy.post_deploy_test) ||
            stageIndex(validation.stage) >= stageIndex(localStage)) {
          throw new ManifestV2PolicyError(`HYBRID_TEST_STRATEGY_INVALID: ${pipeline.id}`);
        }
      }

      const ownerAcceptanceStages = stages.filter((name) => pipeline.executors[name] === 'owner_acceptance');
      const referencedAcceptance = strategy.owner_acceptance_stage ? [strategy.owner_acceptance_stage] : [];
      if (ownerAcceptanceStages.length !== referencedAcceptance.length ||
          ownerAcceptanceStages.some((name) => !referencedAcceptance.includes(name))) {
        throw new ManifestV2PolicyError(`OWNER_ACCEPTANCE_STAGE_MAPPING_INVALID: ${pipeline.id}`);
      }

      const runtimeStage = strategy.mode === 'github' ? undefined : strategy.opencode_host_stage;
      const wantsOwner = strategy.post_deploy_test === 'user' || strategy.post_deploy_test === 'automated_then_user';
      if (wantsOwner) {
        const acceptance = strategy.owner_acceptance_stage;
        if (typeof acceptance !== 'string' || !stageSet.has(acceptance) ||
            pipeline.executors[acceptance] !== 'owner_acceptance' ||
            stageIndex(acceptance) <= stageIndex(runtimeStage)) {
          throw new ManifestV2PolicyError(`OWNER_ACCEPTANCE_STAGE_REQUIRED: ${pipeline.id}`);
        }
      } else if (strategy.owner_acceptance_stage !== undefined) {
        throw new ManifestV2PolicyError(`OWNER_ACCEPTANCE_STAGE_UNEXPECTED: ${pipeline.id}`);
      }
    } else if (pipeline.deployment_validation !== undefined || pipeline.testing_strategy !== undefined) {
      throw new ManifestV2PolicyError(`DEPLOYMENT_CONTRACT_WITH_NON_DEPLOYABLE_PIPELINE: ${pipeline.id}`);
    }

    for (const [name, gate] of Object.entries(pipeline.future_github_gates ?? {})) {
      if (!gate || typeof gate !== 'object' || Array.isArray(gate) ||
          !safeRelativePath(gate.workflow) || !gate.workflow.startsWith('.github/workflows/') ||
          !/\.ya?ml$/i.test(gate.workflow) ||
          !GITHUB_JOB_ID.test(String(gate.terminal_job ?? '')) ||
          gate.trigger !== 'workflow_dispatch' ||
          gate.mode !== 'stateful' ||
          typeof gate.environment !== 'string' || !gate.environment.trim() ||
          typeof gate.trusted_ref !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(gate.trusted_ref) ||
          gate.trusted_ref.includes('..') || gate.trusted_ref.endsWith('/') ||
          typeof gate.concurrency_group !== 'string' || !gate.concurrency_group.trim() ||
          typeof gate.source_ci_stage !== 'string' || pipeline.executors[gate.source_ci_stage] !== 'github_ci' ||
          ((gate.artifact === undefined) !== (gate.evidence_file === undefined)) ||
          (gate.evidence_file !== undefined &&
            (typeof gate.evidence_file !== 'string' || !/^[A-Za-z0-9._-]+\.json$/.test(gate.evidence_file))) ||
          gate.bootstrap_required !== true || typeof gate.bootstrap_work_item_id !== 'string') {
        throw new ManifestV2PolicyError(`FUTURE_GITHUB_DEV_INVALID: ${pipeline.id}/${name}`);
      }
      const item = workItems.get(gate.bootstrap_work_item_id);
      if (!item || item.pipeline_id !== pipeline.id || !(pipeline.work_items ?? []).includes(item.id)) {
        throw new ManifestV2PolicyError(`FUTURE_GITHUB_DEV_WORK_ITEM_INVALID: ${pipeline.id}/${name}`);
      }
      if (!(manifest.allowed_change_paths ?? []).some((scope) => scopeContains(scope, gate.workflow))) {
        throw new ManifestV2PolicyError(`FUTURE_GITHUB_DEV_SCOPE_MISSING: ${gate.workflow}`);
      }
      if (stageSet.has(name)) {
        throw new ManifestV2PolicyError(`FUTURE_GITHUB_DEV_MUST_NOT_EXECUTE_CURRENT_RUN: ${pipeline.id}/${name}`);
      }
    }

    for (const stage of Object.keys(pipeline.github_gates ?? {})) {
      if (!stageSet.has(stage)) throw new ManifestV2PolicyError(`GITHUB_GATE_UNKNOWN_STAGE: ${pipeline.id}/${stage}`);
    }
  }
}

export function validateManifestV2Policy(manifest, options = {}) {
  if (manifest?.schema_version !== 2) {
    throw new ManifestV2PolicyError('pipeline manifest schema_version must be exactly 2');
  }
  if (manifest.planning_mode !== 'design-freeze') {
    throw new ManifestV2PolicyError('schema v2 requires planning_mode=design-freeze');
  }
  const cwd = options.cwd ?? process.cwd();
  const root = runRoot(manifest, cwd, options.manifestPath);
  try { validateGateTesting(resolveGateTesting(manifest, root)); }
  catch (error) { throw new ManifestV2PolicyError(error.message); }
  if (manifest.generated_paths !== undefined && (!Array.isArray(manifest.generated_paths) || manifest.generated_paths.some(path =>
    typeof path !== 'string' || !safeRelativePath(path.endsWith('/**') ? path.slice(0, -3) : path) || /[*?\[\]{}]/.test(path.endsWith('/**') ? path.slice(0, -3) : path) ||
    /^(?:\.git|\.github|\.opencode)(?:\/|$)/.test(path) || /(?:^|\/)\.env/.test(path)))) {
    throw new ManifestV2PolicyError('GENERATED_PATHS_INVALID: exact repository paths or directory/** only, outside .git, .github, .opencode and env files');
  }
  try { validateGenerators(manifest); }
  catch (error) { throw new ManifestV2PolicyError(error.message); }
  validatePlanningReadiness(manifest, root);
  validatePlanningInputs(manifest);
  validateWorkItems(manifest, root);
  assertParallelScopes(manifest, root);
  validatePreservedBaseline(manifest);
  validateLineage(manifest);
  validateGithubExecutionContract(manifest);
  validateSourceRequirements(manifest);
  assertConflictSerialization(manifest);
  const projectPolicy = validateProjectPolicy(manifest, cwd);
  const usesOpenCodeHost = (manifest.pipelines ?? []).some((pipeline) =>
    pipeline.testing_strategy?.mode === 'opencode_host');
  if (usesOpenCodeHost) {
    if (!projectPolicy) throw new ManifestV2PolicyError('OPENCODE_HOST_PROJECT_POLICY_REQUIRED');
    const policy = JSON.parse(readFileSync(resolve(cwd, projectPolicy.path), 'utf8'));
    const target = policy.deployment_target;
    if (target?.kind !== 'opencode_host') {
      throw new ManifestV2PolicyError('OPENCODE_HOST_DEPLOYMENT_TARGET_REQUIRED');
    }
    const targetFile = readFrozenArtifact(root, manifest.deployment_target_check, 'deployment_target_check');
    let targetEvidence;
    try { targetEvidence = JSON.parse(readFileSync(targetFile, 'utf8')); }
    catch { throw new ManifestV2PolicyError('OPENCODE_HOST_TARGET_EVIDENCE_INVALID_JSON'); }
    if (targetEvidence.status !== 'READY' ||
        targetEvidence.run_id !== manifest.run_id ||
        targetEvidence.kind !== 'opencode_host' ||
        targetEvidence.transport !== target.transport ||
        targetEvidence.target_id !== target.target_id ||
        targetEvidence.environment !== target.environment ||
        targetEvidence.trusted_ref !== target.trusted_ref ||
        !Number.isInteger(Number(targetEvidence.workflow_run_id)) ||
        targetEvidence.probe_job !== target.probe_job) {
      throw new ManifestV2PolicyError('OPENCODE_HOST_TARGET_EVIDENCE_MISMATCH');
    }
    for (const pipeline of manifest.pipelines ?? []) {
      if (pipeline.testing_strategy?.mode !== 'opencode_host') continue;
      const stage = pipeline.testing_strategy.opencode_host_stage;
      const gate = stage ? pipeline.github_gates?.[stage] : undefined;
      if (!gate || gate.mode !== 'stateful' ||
          gate.target_id !== target.target_id ||
          gate.environment !== target.environment ||
          gate.trusted_ref !== target.trusted_ref) {
        throw new ManifestV2PolicyError(`OPENCODE_HOST_GATE_TARGET_MISMATCH: ${pipeline.id}`);
      }
    }
  }
  return { checked_artifacts: true, project_policy: projectPolicy };
}


