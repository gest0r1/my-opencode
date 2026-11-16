import { spawnSync } from 'node:child_process';
import { appendFile, cp, mkdir, readFile, readdir, rename, rm, lstat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readIssues, canonicalRequirements, requirementsSha256ForSnapshot } from './github-issue-cli.ts';
import { digest, acceptedReconciliations } from './reconcile-evidence.ts';
import { hasActiveStages, implementationStarted } from './plan-lifecycle.ts';

const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
async function optional(file: string): Promise<any> {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error: any) { if (error.code === 'ENOENT') return undefined; throw error; }
}
async function json(file: string, data: any, exclusive = false) {
  await mkdir(dirname(file), { recursive: true });
  const raw = JSON.stringify(data, null, 2) + '\n';
  if (exclusive) await writeFile(file, raw, { flag: 'wx' });
  else { const temp = file + '.tmp-' + process.pid; await writeFile(temp, raw); await rename(temp, file); }
  return digest(raw);
}
function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0 || result.error) throw Error(result.stderr || String(result.error));
  return result.stdout.trim();
}
async function locked(root: string, fn: () => Promise<any>) {
  const lock = join(root, '.lock');
  await writeFile(lock, String(process.pid), { flag: 'wx' });
  try { return await fn(); } finally { await rm(lock, { force: true }); }
}
async function context(stateRoot: string, run: string) {
  if (!safeId.test(run)) throw Error('INVALID_RUN_ID');
  const root = resolve(stateRoot, run);
  const raw = await readFile(join(root, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(raw);
  const state = await optional(join(root, 'state.json'));
  if (manifest.schema_version !== 2 || manifest.run_id !== run || state?.run_id && state.run_id !== run) throw Error('RUN_IDENTITY_MISMATCH');
  if (state?.superseded_by) throw Error('RUN_SUPERSEDED');
  if (hasActiveStages(state)) throw Error('RUN_ACTIVE: wait for or stop the active stage before reconciliation');
  if (state?.manifest_sha256 && state.manifest_sha256 !== digest(raw)) throw Error('MANIFEST_INTEGRITY_MISMATCH');
  return { root, raw, manifest, state, manifestHash: digest(raw) };
}
function matches(file: string, scope: string) {
  return scope.endsWith('/**') ? file === scope.slice(0, -3) || file.startsWith(scope.slice(0, -2)) : file === scope;
}
export async function reconcile(stateRoot: string, run: string, evidencePath?: string, apply = true, cwd = process.cwd()) {
  const c = await context(stateRoot, run);
  return locked(c.root, async () => {
    const { root, manifest, state, manifestHash } = await context(stateRoot, run);
    const accepted = await acceptedReconciliations(root, state, manifestHash);
    const latest = accepted.at(-1);
    const runtime = await optional(join(root, 'git-runtime.json'));
    if (runtime && runtime.planning_base_sha !== manifest.git_setup.base_sha) throw Error('RUNTIME_BASE_IDENTITY_MISMATCH');
    const previous = latest?.new_base_sha ?? runtime?.run_base_sha ?? manifest.git_setup.base_sha;
    const main = git(cwd, 'rev-parse', 'refs/heads/main');
    const head = git(cwd, 'rev-parse', 'HEAD');
    if (git(cwd, 'branch', '--show-current') !== manifest.git_setup.branch) throw Error('WORKTREE_BRANCH_MISMATCH');
    git(cwd, 'merge-base', '--is-ancestor', previous, main);
    git(cwd, 'merge-base', '--is-ancestor', main, head);
    const changed = git(cwd, 'diff', '--name-only', previous, main, '--').split('\n').filter(Boolean);
    const source = manifest.source_type === 'github_issues'
      ? await readIssues(manifest.source_issues.map((issue: any) => issue.number), { cwd }) : undefined;
    const sourceHash = source ? requirementsSha256ForSnapshot(source) : null;
    const previousSource = latest?.source_requirements_sha256 ?? manifest.source_requirements_sha256 ?? null;
    const scopes = manifest.planning_scope ?? Object.values(manifest.planning_inputs ?? {}).flat();
    const readSet = scopes.length ? scopes : [...(manifest.freshness_sensitive_paths ?? []), ...(manifest.allowed_change_paths ?? [])];
    const relevant = changed.filter(file => readSet.some((scope: string) => matches(file, scope)) ||
      file.startsWith('.github/workflows/') || /(^|\/)(package\.json|.*lock.*|tsconfig.*\.json)$/.test(file) ||
      file === 'docs/pipeline-rules.md' || file === manifest.project_policy?.path);
    const baselineSource = await optional(join(root, 'planning/source-requirements.json'));
    const observation = { run_id: run, manifest_sha256: manifestHash, previous_run_base_sha: previous,
      new_base_sha: main, head_sha: head, changed_paths: changed, relevant_paths: relevant,
      git_diff: changed.length ? git(cwd, 'diff', previous, main, '--') : '',
      previous_source_requirements_sha256: previousSource, source_requirements_sha256: sourceHash,
      effective_amendments: state?.owner_amendments ?? [],
      frozen_source: latest?.source ?? baselineSource ?? null, source: source ? canonicalRequirements(source) : null };
    const observationHash = digest(JSON.stringify(observation));
    const needsReview = relevant.length > 0 || previousSource !== sourceHash;
    let decision: any = { result: 'COMPATIBLE', reason: 'Source unchanged and main diff outside planning scope', affected_gates: [] };
    if (needsReview) {
      if (!evidencePath) {
        if (apply) await json(join(root, 'reconcile/input.json'), { ...observation, input_sha256: observationHash });
        return { status: 'REVIEW_REQUIRED', run_id: run, input_sha256: observationHash,
          evidence: join(root, 'reconcile/input.json'), implementation_started: implementationStarted(state, manifest) };
      }
      const rel = relative(root, resolve(evidencePath));
      if (rel.startsWith('..') || rel.startsWith('/') || !rel) throw Error('REVIEW_MUST_LIVE_IN_RUN');
      decision = JSON.parse(await readFile(evidencePath, 'utf8'));
      if (decision.input_sha256 !== observationHash || !['COMPATIBLE', 'PLAN_INVALID'].includes(decision.result) ||
          typeof decision.reason !== 'string' || !decision.reason.trim()) throw Error('RECONCILE_REVIEW_IDENTITY_INVALID');
      if (decision.result === 'COMPATIBLE') {
        for (const field of ['business_intent_changed', 'architecture_invalid', 'external_contract_changed', 'security_boundary_changed', 'destructive_change', 'owner_decision_required']) {
          if (decision[field] !== false) throw Error('PLAN_INVALID: unresolved structural/owner boundary: ' + field);
        }
        if (decision.implementation_change_required !== false) throw Error('CLARIFICATION_REQUIRED: revise PLAN before implementation, or apply owner amendment after start, then reconcile again');
      }
    }
    if (!apply) return { status: 'PASS', result: decision.result, run_id: run };
    const entries = await readdir(join(root, 'reconcile')).catch(() => []);
    const number = entries.filter(file => /^\d+\.json$/.test(file)).length + 1;
    const path = 'reconcile/' + String(number).padStart(3, '0') + '.json';
    const record = { ...observation, result: decision.result, reason: decision.reason, review_path: evidencePath ?? null, manifest_sha256: manifestHash, input_sha256: observationHash, recorded_at: new Date().toISOString() };
    const sha = await json(join(root, path), record, true);
    if (decision.result === 'PLAN_INVALID') return { status: 'PASS', result: 'PLAN_INVALID', run_id: run,
      action: implementationStarted(state, manifest) ? 'owner_authorized_in_place_unfreeze_or_explicit_new_run' : 'revise_plan_in_place', evidence: path };
    if (state) {
      state.reconciliations ??= [];
      state.reconciliations.push({ path, sha256: sha });
      state.run_base_sha = main;
      state.updated_at = new Date().toISOString();
      await json(join(root, 'state.json'), state);
    }
    await json(join(root, 'git-runtime.json'), { planning_base_sha: manifest.git_setup.base_sha,
      run_base_sha: main, merged_head_sha: head, upstream_changed_files: changed,
      refreshed_at: new Date().toISOString(), reconcile_evidence: path, reconcile_sha256: sha });
    return { status: 'PASS', result: 'COMPATIBLE', run_id: run, evidence: path };
  });
}

export async function revisePlan(stateRoot: string, run: string, evidencePath: string) {
  const c = await context(stateRoot, run);
  return locked(c.root, async () => {
    const { root, manifest, state, manifestHash } = await context(stateRoot, run);
    if (implementationStarted(state, manifest)) throw Error('IMPLEMENTATION_STARTED: incompatible replan requires a new run');
    const evidenceRaw = await readFile(evidencePath, 'utf8');
    const evidence = JSON.parse(evidenceRaw);
    if (evidence.manifest_sha256 !== manifestHash || typeof evidence.owner_contract_changed !== 'boolean' ||
        !Array.isArray(evidence.affected_gates) || !evidence.reason) throw Error('REVISION_EVIDENCE_REQUIRED');
    for (const gate of evidence.affected_gates) {
      const item = manifest.planning_readiness?.gates?.[gate];
      if (!item) throw Error('UNKNOWN_PLANNING_GATE: ' + gate);
      item.status = 'needs_revision';
    }
    // Retain the current folder and useful artifacts; invalidated gates cannot pass
    // preflight. No old story versions or effective runtime state survive as valid.
    const previousApproval = state?.status === 'approved' || state?.status === 'in_progress';
    const evidenceRelative = relative(root, resolve(evidencePath));
    const carriesApproval = previousApproval && evidence.owner_contract_changed === false && state?.approval_record &&
      !evidenceRelative.startsWith('..') && resolve(evidencePath).startsWith(resolve(root) + '/');
    const revision = { ...evidence, previous_approval: previousApproval,
      ...(carriesApproval ? {
        approval_carry: {
          ...state.approval_record,
          current_manifest_sha256: state.manifest_sha256,
          revision_evidence_path: evidenceRelative,
          revision_evidence_sha256: digest(evidenceRaw),
          revision_reviewed_manifest_sha256: evidence.manifest_sha256,
        },
        approval_outbox: state.github_outbox,
      } : {}),
      recorded_at: new Date().toISOString() };
    await json(join(root, 'planning/revision.json'), revision);
    await appendFile(join(root, 'planning/revisions.jsonl'), JSON.stringify(revision) + '\n');
    await json(join(root, 'manifest.json'), manifest);
    for (const file of ['state.json', 'git-runtime.json', 'candidate.json', 'git-verify.json']) await rm(join(root, file), { force: true });
    return { status: 'PASS', run_id: run, action: 'revise_plan_in_place',
      approval_required: evidence.owner_contract_changed, affected_gates: evidence.affected_gates };
  });
}

export async function inheritReplan(stateRoot: string, oldRun: string, newRun: string) {
  if (!safeId.test(newRun) || oldRun === newRun) throw Error('INVALID_NEW_RUN_ID');
  const c = await context(stateRoot, oldRun);
  if (!implementationStarted(c.state, c.manifest)) throw Error('REVISE_IN_PLACE_BEFORE_IMPLEMENTATION');
  return locked(c.root, async () => {
    const target = resolve(stateRoot, newRun);
    await mkdir(target); // Existing destination must never be overwritten.
    try {
      const inherited = join(target, 'planning/inherited');
      await mkdir(inherited, { recursive: true });
      async function copy(source: string, dest: string) {
        const info = await lstat(source).catch((error: any) => { if (error.code === 'ENOENT') return null; throw error; });
        if (!info) return;
        if (info.isSymbolicLink()) throw Error('INHERITED_CONTEXT_SYMLINK');
        if (info.isDirectory()) {
          await mkdir(dest, { recursive: true });
          for (const name of await readdir(source)) await copy(join(source, name), join(dest, name));
        } else await cp(source, dest, { errorOnExist: true, force: false });
      }
      for (const file of ['stories', 'decision-register.md', 'context-packet.md', 'planning/context-packet.md', 'planning/technology-evidence.json', 'technology-evidence.md', 'planning/research', 'research']) {
        await copy(join(c.root, file), join(inherited, file));
      }
      await json(join(inherited, 'lineage.json'), { previous_run_id: oldRun, previous_manifest_sha256: c.manifestHash });
      return { status: 'PASS', run_id: newRun, inherited_from: oldRun, old_run_unchanged: true };
    } catch (error) { await rm(target, { recursive: true, force: true }); throw error; }
  });
}

async function main() {
  const [command, run, ...args] = process.argv.slice(2);
  const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const stateRoot = option('--state-root') ?? '.tmp/pipelines';
  if (!run) throw Error('usage: pipeline-reconcile-cli check|apply|revise-plan|inherit-replan RUN [--evidence PATH] [--new-run ID]');
  let result;
  if (command === 'check' || command === 'apply') result = await reconcile(stateRoot, run, option('--evidence'), command === 'apply');
  else if (command === 'snapshot-source') {
    const c = await context(stateRoot, run);
    if (implementationStarted(c.state, c.manifest)) throw Error('IMPLEMENTATION_STARTED');
    const source = await readIssues(c.manifest.source_issues.map((issue: any) => issue.number));
    if (requirementsSha256ForSnapshot(source) !== c.manifest.source_requirements_sha256) throw Error('SOURCE_CHANGED_DURING_PLAN');
    await json(join(c.root, 'planning/source-requirements.json'), canonicalRequirements(source));
    result = { status: 'PASS', run_id: run };
  }
  else if (command === 'revise-plan' && option('--evidence')) result = await revisePlan(stateRoot, run, option('--evidence')!);
  else if (command === 'inherit-replan' && option('--new-run')) result = await inheritReplan(stateRoot, run, option('--new-run')!);
  else throw Error('INVALID_RECONCILE_COMMAND');
  console.log(JSON.stringify(result, null, 2));
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch(error => { console.error(String(error)); process.exitCode = 1; });
