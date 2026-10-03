import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  lstat,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { probeRequirements } from './github-issue-cli.ts';

const DEFAULT_STATE_ROOT = '.tmp/pipelines';
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA = /^[0-9a-f]{40}$/i;
const MACHINE_FILES = new Set([
  'state.json',
  '.lock',
  'candidate.json',
  'git-verify.json',
  'git-runtime.json',
  'refresh-impact.json',
]);
const COPY_DIRS = ['planning', 'stories', 'reviews', 'work-items'];
const COPY_FILES = ['decision-register.md', 'work-items.json'];
const STRUCTURAL_PATHS = new Set([
  'docs/pipeline-rules.md',
  '.opencode/pipeline-policy.json',
]);
const GLOBAL_TECHNICAL = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'pyproject.toml',
  'uv.lock',
  'go.mod',
  'go.sum',
  'Cargo.toml',
  'Cargo.lock',
]);

class RefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefreshError';
  }
}

type Manifest = Record<string, any>;
type State = Record<string, any>;

function command(executable: string, args: string[], cwd = process.cwd()): string {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || result.status).trim();
    throw new RefreshError(`${executable} ${args.join(' ')} failed: ${detail}`);
  }
  return String(result.stdout ?? '').trim();
}

function git(args: string[], cwd = process.cwd()): string {
  return command('git', args, cwd);
}

function gitSucceeds(args: string[], cwd = process.cwd()): boolean {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: process.env });
  return !result.error && result.status === 0;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
    return false;
  }
  const parts = value.split('/');
  return !parts.includes('..') && !parts.includes('.git');
}

function validScope(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false;
  const base = value.endsWith('/**') ? value.slice(0, -3).replace(/\/$/, '') : value;
  return safePath(base) && !/[?*\[\]{}]/.test(base);
}

function matches(path: string, scope: string): boolean {
  if (scope.endsWith('/**')) {
    const prefix = scope.slice(0, -3).replace(/\/$/, '');
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  return path === scope;
}

function isGlobalTechnical(path: string): boolean {
  const name = path.split('/').pop() ?? path;
  return GLOBAL_TECHNICAL.has(path) ||
    /^tsconfig(?:\..+)?\.json$/.test(name) ||
    /^requirements(?:\..+)?\.txt$/.test(name);
}

function isGithubWorkflow(path: string): boolean {
  return path.startsWith('.github/workflows/');
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

function currentBranch(cwd: string): string {
  return git(['branch', '--show-current'], cwd);
}

function localMain(cwd: string): string {
  return git(['rev-parse', '--verify', 'refs/heads/main'], cwd);
}

function headSha(cwd: string): string {
  return git(['rev-parse', 'HEAD'], cwd);
}

function runRoot(stateRoot: string, runId: string): string {
  return join(resolve(stateRoot), runId);
}

async function readManifest(stateRoot: string, runId: string): Promise<{ manifest: Manifest; path: string; raw: string }> {
  const path = join(runRoot(stateRoot, runId), 'manifest.json');
  const raw = await readFile(path, 'utf8').catch(() => {
    throw new RefreshError(`manifest not found: ${path}`);
  });
  const manifest = JSON.parse(raw) as Manifest;
  if (manifest.schema_version !== 2) {
    throw new RefreshError('pipeline manifest schema_version must be exactly 2');
  }
  if (manifest.run_id !== runId) throw new RefreshError('manifest run_id does not match selected run');
  return { manifest, path, raw };
}

async function readStateIfPresent(stateRoot: string, runId: string): Promise<State | undefined> {
  const path = join(runRoot(stateRoot, runId), 'state.json');
  if (!(await exists(path))) return undefined;
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    throw new RefreshError(`state.json is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const state = JSON.parse(raw) as State;
    if (state.run_id && state.run_id !== runId) throw new RefreshError('state.json run_id does not match selected run');
    return state;
  } catch (error) {
    if (error instanceof RefreshError) throw error;
    throw new RefreshError('state.json is invalid JSON');
  }
}

function assertInactiveState(state: State | undefined): void {
  if (!state) return;
  const active = state.status === 'in_progress' ||
    (Array.isArray(state.active_stages) && state.active_stages.length > 0);
  if (active) throw new RefreshError('RUN_ACTIVE: /pipeline-refresh requires no active RUN');
  if (state.superseded_by) {
    throw new RefreshError(`RUN_SUPERSEDED: selected run already superseded by ${String(state.superseded_by)}`);
  }
}

async function resolveRunId(stateRoot: string, explicit: string | undefined, cwd: string): Promise<string> {
  if (explicit) {
    if (!SAFE_RUN_ID.test(explicit)) throw new RefreshError('run-id must be path-safe');
    return explicit;
  }
  const root = resolve(stateRoot);
  const branch = currentBranch(cwd);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const candidates: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_RUN_ID.test(entry.name)) continue;
    try {
      const { manifest } = await readManifest(stateRoot, entry.name);
      if (manifest.git_setup?.branch !== branch) continue;
      const state = await readStateIfPresent(stateRoot, entry.name);
      if (state?.superseded_by || ['completed', 'failed'].includes(String(state?.status ?? ''))) continue;
      candidates.push(entry.name);
    } catch {
      // Ignore malformed or unrelated historical directories during auto-resolution.
    }
  }
  if (candidates.length !== 1) {
    throw new RefreshError(
      `RUN_SELECTION_REQUIRED: expected exactly one refreshable run for branch ${branch}; found ${candidates.length}: ${candidates.join(', ') || 'none'}`,
    );
  }
  return candidates[0];
}

function previousRunBase(manifest: Manifest, root: string): Promise<string> {
  const runtimePath = join(root, 'git-runtime.json');
  return readFile(runtimePath, 'utf8')
    .then((raw) => {
      const runtime = JSON.parse(raw) as Record<string, unknown>;
      const runBase = String(runtime.run_base_sha ?? '');
      const planningBase = String(runtime.planning_base_sha ?? '');
      if (!SHA.test(runBase) || planningBase.toLowerCase() !== String(manifest.git_setup?.base_sha ?? '').toLowerCase()) {
        throw new RefreshError('git-runtime.json does not match the selected manifest');
      }
      return runBase;
    })
    .catch((error) => {
      if (error instanceof RefreshError) throw error;
      const base = String(manifest.git_setup?.base_sha ?? '');
      if (!SHA.test(base)) throw new RefreshError('manifest git_setup.base_sha is missing or invalid');
      return base;
    });
}

function planningInputs(manifest: Manifest): Record<string, string[]> {
  const value = manifest.planning_inputs;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output: Record<string, string[]> = {};
  for (const [gate, raw] of Object.entries(value)) {
    if (!Array.isArray(raw) || raw.length === 0 || raw.some((scope) => !validScope(scope))) {
      throw new RefreshError(`planning_inputs.${gate} must contain exact paths or directory/** scopes`);
    }
    output[gate] = [...new Set(raw as string[])].sort();
  }
  return output;
}

function readinessGateNames(manifest: Manifest): string[] {
  const gates = manifest.planning_readiness?.gates;
  return gates && typeof gates === 'object' && !Array.isArray(gates) ? Object.keys(gates) : [];
}

function findGate(manifest: Manifest, patterns: RegExp[]): string | undefined {
  return readinessGateNames(manifest).find((gate) => patterns.some((pattern) => pattern.test(gate)));
}

function addGate(set: Set<string>, manifest: Manifest, semantic: 'architecture' | 'technical' | 'contracts' | 'stories'): void {
  const patterns = semantic === 'architecture' ? [/arch/i] :
    semantic === 'technical' ? [/technical/i, /plan/i, /senior/i] :
    semantic === 'contracts' ? [/contract/i] :
    [/stor/i];
  const gate = findGate(manifest, patterns);
  if (gate) set.add(gate);
}

function computeAffected(manifest: Manifest, changed: string[]): {
  affectedGates: string[];
  reasons: string[];
  rebuildWorkItems: boolean;
} {
  const inputs = planningInputs(manifest);
  const affected = new Set<string>();
  const reasons = new Set<string>();
  let rebuildWorkItems = false;

  for (const [gate, scopes] of Object.entries(inputs)) {
    if (changed.some((path) => scopes.some((scope) => matches(path, scope)))) {
      if (gate === 'work_items') rebuildWorkItems = true;
      else affected.add(gate);
      reasons.add(`planning_inputs:${gate}`);
    }
  }

  const fallbackScopes = [
    ...(Array.isArray(manifest.freshness_sensitive_paths) ? manifest.freshness_sensitive_paths : []),
    ...(Array.isArray(manifest.allowed_change_paths) ? manifest.allowed_change_paths : []),
  ].filter(validScope);

  for (const path of changed) {
    if (isGithubWorkflow(path)) {
      addGate(affected, manifest, 'technical');
      rebuildWorkItems = true;
      reasons.add('github_workflow');
    }
    if (isGlobalTechnical(path)) {
      addGate(affected, manifest, 'technical');
      rebuildWorkItems = true;
      reasons.add('global_technical_contract');
    }
    if (fallbackScopes.some((scope) => matches(path, scope)) && !Object.keys(inputs).length) {
      addGate(affected, manifest, 'architecture');
      addGate(affected, manifest, 'technical');
      rebuildWorkItems = true;
      reasons.add('fallback_freshness_scope');
    }
  }

  if (affected.size > 0) rebuildWorkItems = true;
  return {
    affectedGates: [...affected].sort(),
    reasons: [...reasons].sort(),
    rebuildWorkItems,
  };
}

async function sourceRequirementsStatus(manifest: Manifest, _root: string, cwd: string): Promise<{
  changed: boolean;
  frozen: string | null;
  live: string | null;
}> {
  if (manifest.source_type !== 'github_issues') return { changed: false, frozen: null, live: null };
  const frozen = String(manifest.source_requirements_sha256 ?? '');
  if (!/^[0-9a-f]{64}$/i.test(frozen)) {
    throw new RefreshError('github_issues manifest has no valid source_requirements_sha256');
  }
  const numbers = Array.isArray(manifest.source_issues)
    ? manifest.source_issues.map((issue: any) => Number(issue.number)).filter((value: number) => Number.isInteger(value) && value > 0)
    : [];
  if (!numbers.length) throw new RefreshError('github_issues manifest has no source issue numbers');
  const liveResult = await probeRequirements(numbers, { cwd });
  const live = String(liveResult.requirements_sha256 ?? '');
  if (!/^[0-9a-f]{64}$/i.test(live)) throw new RefreshError('invalid live semantic requirements digest');
  return { changed: frozen.toLowerCase() !== live.toLowerCase(), frozen, live };
}
function structuralPaths(manifest: Manifest, changed: string[]): string[] {
  const policyPath = typeof manifest.project_policy?.path === 'string' ? manifest.project_policy.path : undefined;
  return changed.filter((path) => STRUCTURAL_PATHS.has(path) || (policyPath && path === policyPath));
}

async function writeNoImpactRuntime(
  manifest: Manifest,
  manifestPath: string,
  previousBase: string,
  newBase: string,
  head: string,
  changed: string[],
  impactSha256: string,
): Promise<void> {
  const root = dirname(resolve(manifestPath));
  await writeJsonAtomic(join(root, 'git-runtime.json'), {
    planning_base_sha: manifest.git_setup.base_sha,
    run_base_sha: newBase,
    merged_head_sha: head,
    previous_run_base_sha: previousBase,
    upstream_changed_files: changed,
    refresh_impact_sha256: impactSha256,
    refreshed_at: new Date().toISOString(),
  });

  const statePath = join(root, 'state.json');
  if (await exists(statePath)) {
    const state = JSON.parse(await readFile(statePath, 'utf8')) as State;
    if (state.run_id && state.run_id !== manifest.run_id) throw new RefreshError('state run_id does not match manifest');
    state.run_base_sha = newBase;
    state.refresh_impact_sha256 = impactSha256;
    state.updated_at = new Date().toISOString();
    await writeJsonAtomic(statePath, state);
  }
}

async function assertNoSymlinks(target: string): Promise<void> {
  if (!(await exists(target))) return;
  const info = await lstat(target);
  if (info.isSymbolicLink()) throw new RefreshError(`artifact tree contains symlink: ${target}`);
  if (!info.isDirectory()) return;
  for (const entry of await readdir(target)) await assertNoSymlinks(join(target, entry));
}

function transferablePath(source: string): boolean {
  const name = source.split('/').pop() ?? source;
  return name !== 'deployment-target.json' && name !== 'refresh-impact.json';
}

async function copyIfPresent(source: string, destination: string, recursive = false): Promise<void> {
  if (!(await exists(source))) return;
  await assertNoSymlinks(source);
  await cp(source, destination, {
    recursive,
    force: false,
    errorOnExist: true,
    filter: async (current) => transferablePath(current),
  });
}

async function preservedBaseline(newBase: string, cwd: string): Promise<Record<string, unknown> | undefined> {
  const head = headSha(cwd);
  const changed = git(['diff', '--name-only', newBase, head, '--'], cwd)
    .split('\n').filter(Boolean).sort();
  if (!changed.length) return undefined;
  for (const path of changed) {
    if (!safePath(path)) throw new RefreshError(`unsafe preserved baseline path: ${path}`);
  }
  const raw = git(['diff', '--raw', '--full-index', '--no-renames', newBase, head, '--'], cwd);
  return {
    head_sha: head,
    changed_paths: changed,
    diff_sha256: sha256(raw),
  };
}

function invalidateGate(manifest: Manifest, gate: string): void {
  const record = manifest.planning_readiness?.gates?.[gate];
  if (!record || typeof record !== 'object') return;
  record.status = 'needs_revision';
  record.blocking_decision_ids = [];
  delete record.cycles;
}

async function createBoundedRun(
  stateRoot: string,
  oldRunId: string,
  manifest: Manifest,
  newBase: string,
  changed: string[],
  affectedGates: string[],
  reasons: string[],
  rebuildWorkItems: boolean,
  impact: Record<string, unknown>,
  cwd: string,
): Promise<Record<string, unknown>> {
  const oldRoot = runRoot(stateRoot, oldRunId);
  const newRunId = `${oldRunId}-refresh-${newBase.slice(0, 8)}`;
  if (!SAFE_RUN_ID.test(newRunId)) throw new RefreshError('derived refresh run-id is unsafe');
  const newRoot = runRoot(stateRoot, newRunId);

  if (await exists(newRoot)) {
    const existing = JSON.parse(await readFile(join(newRoot, 'manifest.json'), 'utf8')) as Manifest;
    if (existing.lineage?.supersedes === oldRunId &&
        existing.lineage?.reason_code === 'MAIN_DRIFT_REPLAN' &&
        existing.git_setup?.base_sha === newBase) {
      return {
        status: 'PASS',
        classification: 'BOUNDED_IMPACT',
        action: 'reuse_bounded_draft',
        old_run_id: oldRunId,
        new_run_id: newRunId,
        affected_gates: affectedGates,
        rebuild_work_items: rebuildWorkItems,
        manifest: join(newRoot, 'manifest.json'),
      };
    }
    throw new RefreshError(`refresh destination already exists: ${newRunId}`);
  }

  await mkdir(newRoot, { recursive: true });
  try {
    for (const directory of COPY_DIRS) {
      await copyIfPresent(join(oldRoot, directory), join(newRoot, directory), true);
    }
    for (const file of COPY_FILES) {
      if (!MACHINE_FILES.has(file)) await copyIfPresent(join(oldRoot, file), join(newRoot, file));
    }

    await rm(join(newRoot, 'planning', 'deployment-target.json'), { force: true });

    const impactPath = join(newRoot, 'planning', 'refresh-impact.json');
    const impactContent = {
      ...impact,
      copied_by: 'pipeline-refresh-cli',
      inherited_from_run_id: oldRunId,
    };
    await writeJsonAtomic(impactPath, impactContent);
    const impactSha = sha256(await readFile(impactPath, 'utf8'));

    const cloned = JSON.parse(JSON.stringify(manifest)) as Manifest;
    cloned.run_id = newRunId;
    cloned.git_setup = { ...cloned.git_setup, base_sha: newBase };
    cloned.planning_base_sha = newBase;
    const semanticDigest = String((impact as any).source_requirements?.frozen ?? '');
    if (cloned.source_type === 'github_issues' && /^[0-9a-f]{64}$/i.test(semanticDigest)) {
      cloned.source_requirements_sha256 = semanticDigest;
    } else if (/^[0-9a-f]{64}$/i.test(semanticDigest)) {
      cloned.source_requirements_sha256 = semanticDigest;
    }
    if (!cloned.planning_inputs || typeof cloned.planning_inputs !== 'object' || Array.isArray(cloned.planning_inputs)) {
      const fallback = [
        ...(Array.isArray(cloned.freshness_sensitive_paths) ? cloned.freshness_sensitive_paths : []),
        ...(Array.isArray(cloned.allowed_change_paths) ? cloned.allowed_change_paths : []),
      ].filter(validScope);
      const scopes = [...new Set(fallback)].sort();
      if (scopes.length) {
        cloned.planning_inputs = {};
        for (const gate of readinessGateNames(cloned)) cloned.planning_inputs[gate] = scopes;
        cloned.planning_inputs.work_items = scopes;
      }
    }
    cloned.lineage = {
      change_class: 'replan',
      supersedes: oldRunId,
      reason_code: 'MAIN_DRIFT_REPLAN',
    };
    cloned.refresh_revalidation = {
      classification: 'BOUNDED_IMPACT',
      inherited_from_run_id: oldRunId,
      new_base_sha: newBase,
      changed_paths: changed,
      affected_gates: affectedGates,
      reasons,
      rebuild_work_items: rebuildWorkItems,
      impact_evidence: {
        path: 'planning/refresh-impact.json',
        sha256: impactSha,
      },
    };
    if (cloned.deployment_target_check) delete cloned.deployment_target_check;
    const baseline = await preservedBaseline(newBase, cwd);
    if (baseline) cloned.preserved_baseline = baseline;
    else delete cloned.preserved_baseline;

    for (const gate of affectedGates) invalidateGate(cloned, gate);
    if (rebuildWorkItems) {
      cloned.refresh_revalidation.work_items_status = 'needs_revision';
    }

    await writeJsonAtomic(join(newRoot, 'manifest.json'), cloned);

    const oldStatePath = join(oldRoot, 'state.json');
    if (await exists(oldStatePath)) {
      const oldState = JSON.parse(await readFile(oldStatePath, 'utf8')) as State;
      assertInactiveState(oldState);
      oldState.superseded_by = newRunId;
      oldState.supersede_reason = 'MAIN_DRIFT_REPLAN';
      oldState.updated_at = new Date().toISOString();
      await writeJsonAtomic(oldStatePath, oldState);
    }

    return {
      status: 'PASS',
      classification: 'BOUNDED_IMPACT',
      action: 'revalidate_affected_gates',
      old_run_id: oldRunId,
      new_run_id: newRunId,
      new_base_sha: newBase,
      changed_paths: changed,
      affected_gates: affectedGates,
      rebuild_work_items: rebuildWorkItems,
      copied_by_cli: true,
      state_copied: false,
      machine_evidence_copied: false,
      manifest: join(newRoot, 'manifest.json'),
      impact_evidence: impactPath,
    };
  } catch (error) {
    await rm(newRoot, { recursive: true, force: true });
    throw error;
  }
}

async function inspectContext(manifest: Manifest, cwd: string): Promise<{ main: string; head: string; branch: string }> {
  const branch = currentBranch(cwd);
  if (!branch || branch === 'main' || branch === 'master') {
    throw new RefreshError('refresh must run in a non-default linked worktree branch');
  }
  if (branch !== manifest.git_setup?.branch) {
    throw new RefreshError(`selected branch mismatch: expected ${String(manifest.git_setup?.branch)}, got ${branch}`);
  }
  const gitDir = resolve(git(['rev-parse', '--path-format=absolute', '--git-dir'], cwd));
  const common = resolve(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd));
  if (gitDir === common) throw new RefreshError('refresh requires an owner-created linked worktree');
  const dirty = git(['status', '--porcelain', '--untracked-files=all'], cwd);
  if (dirty) throw new RefreshError('refresh analysis requires a clean worktree after deterministic merge');
  const main = localMain(cwd);
  const head = headSha(cwd);
  if (!gitSucceeds(['merge-base', '--is-ancestor', main, head], cwd)) {
    throw new RefreshError('refreshed branch does not contain current local main');
  }
  return { main, head, branch };
}

async function analyzeAndApply(
  stateRoot: string,
  runId: string,
  apply: boolean,
  cwd: string,
): Promise<Record<string, unknown>> {
  const { manifest, path: manifestPath, raw: manifestRaw } = await readManifest(stateRoot, runId);
  const state = await readStateIfPresent(stateRoot, runId);
  assertInactiveState(state);
  if (state?.manifest_sha256 &&
      String(state.manifest_sha256).toLowerCase() !== sha256(manifestRaw).toLowerCase()) {
    throw new RefreshError('frozen manifest integrity mismatch');
  }

  const context = await inspectContext(manifest, cwd);
  const root = dirname(resolve(manifestPath));
  const previousBase = await previousRunBase(manifest, root);
  if (!gitSucceeds(['merge-base', '--is-ancestor', previousBase, context.main], cwd)) {
    throw new RefreshError('main history diverged from previous approved/effective run base');
  }
  const changed = git(['diff', '--name-only', previousBase, context.main, '--'], cwd)
    .split('\n').filter(Boolean).sort();

  const source = await sourceRequirementsStatus(manifest, root, cwd);
  const structural = structuralPaths(manifest, changed);
  const { affectedGates, reasons, rebuildWorkItems } = computeAffected(manifest, changed);
  const structuralReasons = [
    ...(source.changed ? ['source_requirements_changed'] : []),
    ...structural.map((path) => `structural_path:${path}`),
  ];

  const classification = structuralReasons.length
    ? 'STRUCTURAL_IMPACT'
    : affectedGates.length || rebuildWorkItems
      ? 'BOUNDED_IMPACT'
      : 'NO_IMPACT';

  const impact = {
    schema_version: 1,
    run_id: runId,
    classification,
    previous_run_base_sha: previousBase,
    new_base_sha: context.main,
    merged_head_sha: context.head,
    changed_paths: changed,
    affected_gates: affectedGates,
    rebuild_work_items: rebuildWorkItems,
    reasons: [...new Set([...reasons, ...structuralReasons])].sort(),
    source_requirements: source,
    analyzed_at: new Date().toISOString(),
  };

  if (!apply) return { status: 'PASS', ...impact, action: 'check_only' };

  const impactPath = join(root, 'refresh-impact.json');
  await writeJsonAtomic(impactPath, impact);
  const impactSha = sha256(await readFile(impactPath, 'utf8'));

  if (classification === 'NO_IMPACT') {
    await writeNoImpactRuntime(
      manifest,
      manifestPath,
      previousBase,
      context.main,
      context.head,
      changed,
      impactSha,
    );
    return {
      status: 'PASS',
      ...impact,
      action: 'reuse_approved_run',
      approval_reused: true,
      run_id: runId,
      copied_by_cli: false,
      impact_evidence: impactPath,
    };
  }

  if (classification === 'STRUCTURAL_IMPACT') {
    return {
      status: 'PASS',
      ...impact,
      action: 'full_replan',
      approval_reused: false,
      copied_by_cli: false,
      impact_evidence: impactPath,
    };
  }

  return createBoundedRun(
    stateRoot,
    runId,
    manifest,
    context.main,
    changed,
    affectedGates,
    reasons,
    rebuildWorkItems,
    impact,
    cwd,
  );
}

function parseArgs(args: string[]): {
  commandName: 'preflight' | 'check' | 'apply';
  runId?: string;
  stateRoot: string;
} {
  const [commandName, ...rest] = args;
  if (commandName !== 'preflight' && commandName !== 'check' && commandName !== 'apply') {
    throw new RefreshError('usage: pipeline-refresh-cli.ts preflight|check|apply [run-id] [--state-root <path>]');
  }
  let runId: string | undefined;
  let stateRoot = DEFAULT_STATE_ROOT;
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === '--state-root') {
      const next = rest[++index];
      if (!next) throw new RefreshError('--state-root requires a path');
      stateRoot = next;
    } else if (value?.startsWith('--')) {
      throw new RefreshError(`unknown option: ${value}`);
    } else if (value) {
      if (runId) throw new RefreshError('only one run-id may be selected');
      if (!SAFE_RUN_ID.test(value)) throw new RefreshError('run-id must be path-safe');
      runId = value;
    }
  }
  return { commandName, runId, stateRoot };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const cwd = git(['rev-parse', '--show-toplevel']);
  const runId = await resolveRunId(parsed.stateRoot, parsed.runId, cwd);

  if (parsed.commandName === 'preflight' || parsed.commandName === 'check') {
    const { manifest } = await readManifest(parsed.stateRoot, runId);
    const state = await readStateIfPresent(parsed.stateRoot, runId);
    assertInactiveState(state);
    const context = await inspectContext(manifest, cwd);
    console.log(JSON.stringify({
      status: 'PASS',
      action: 'refresh_preflight',
      run_id: runId,
      branch: context.branch,
      current_main_sha: context.main,
      head_sha: context.head,
      run_status: state?.status ?? 'draft',
    }, null, 2));
    return;
  }

  const result = await analyzeAndApply(parsed.stateRoot, runId, true, cwd);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(`BLOCKED: pipeline_refresh: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
