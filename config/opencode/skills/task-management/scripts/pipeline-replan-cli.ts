import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hasActiveStages, implementationStarted } from './plan-lifecycle.ts';
import { acceptedReconciliations } from './reconcile-evidence.ts';
import { reconcile } from './pipeline-reconcile-cli.ts';

const matches = (file: string, scope: string) =>
  scope.endsWith('/**') ? file === scope.slice(0, -3) || file.startsWith(scope.slice(0, -2)) : file === scope;
const strings = (value: any, out: string[] = [], depth = 0): string[] => {
  if (typeof value === 'string') out.push(value);
  else if (depth < 12 && value && typeof value === 'object') for (const item of Object.values(value)) strings(item, out, depth + 1);
  return out;
};
const optionalJson = async (file: string) => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return undefined; } };

// Read-only: files changed on local main since the run's effective base, grouped by the plan inputs they touch.
async function delta(stateRoot: string, run: string, m: any, s: any) {
  const root = join(stateRoot, run);
  const accepted = await acceptedReconciliations(root, s, createHash('sha256').update(await readFile(join(root, 'manifest.json'), 'utf8')).digest('hex'));
  const adopted = accepted.at(-1)?.new_base_sha;
  const base = adopted ?? m.git_setup?.base_sha;
  const main = git('rev-parse', 'refs/heads/main');
  const changed = git('diff', '--name-only', base, main, '--').split('\n').filter(Boolean);
  const hit = (scopes: string[]) => changed.filter(file => scopes.some(scope => matches(file, scope)));
  const planning = (m.planning_scope ?? Object.values(m.planning_inputs ?? {}).flat()) as string[];
  const allowed = (m.allowed_change_paths ?? []) as string[];
  const rework = (m.test_rework ?? []).map((entry: any) => entry?.path).filter((p: any) => typeof p === 'string') as string[];
  const gateStrings: string[] = [];
  for (const profile of Object.values(m.gate_testing ?? {}) as any[]) for (const config of Object.values(profile ?? {}) as any[]) {
    strings({ ...config, source: undefined }, gateStrings);
    const snapshot = config?.source?.snapshot;
    if (typeof snapshot === 'string' && !snapshot.includes('..')) strings(await optionalJson(join(root, snapshot)), gateStrings);
  }
  const itemScopes: string[] = [];
  for (const item of m.work_items ?? []) {
    if (typeof item?.path !== 'string' || item.path.includes('..')) continue;
    const record = await optionalJson(join(root, item.path));
    if (Array.isArray(record?.allowed_change_paths)) itemScopes.push(...record.allowed_change_paths.filter((p: any) => typeof p === 'string'));
  }
  const intersections = { planning_scope: hit(planning), allowed_change_paths: hit(allowed), test_rework: hit(rework),
    gate_testing_source: hit(gateStrings), work_item_scopes: hit(itemScopes) };
  const affected: string[] = [];
  if (intersections.planning_scope.length) affected.push('stories', 'architecture', 'contracts');
  if (intersections.allowed_change_paths.length || intersections.test_rework.length || intersections.work_item_scopes.length) affected.push('work_items');
  if (changed.length) affected.push('gate_probes');
  return { status: 'PASS', action: 'replan_delta', run_id: run, base_sha: base, base_source: adopted ? 'reconcile' : 'manifest',
    main_sha: main, implementation_started: implementationStarted(s, m), changed_files: changed, intersections, affected_gates: affected };
}

function git(...args: string[]) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  if (r.status !== 0 || r.error) throw Error(r.stderr || String(r.error));
  return r.stdout.trim();
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!['preflight', 'check', 'apply', 'delta'].includes(command)) throw Error('usage: pipeline-replan-cli preflight|check|apply|delta [RUN] [--evidence PATH] [--json]');
  const option = (key: string) => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };
  const stateRoot = resolve(option('--state-root') ?? '.tmp/pipelines');
  const branch = git('branch', '--show-current');
  const plain = args.filter(value => value !== '--json');
  const rest = plain.filter((value, index) => !value.startsWith('--') && (index === 0 || !plain[index - 1].startsWith('--')));
  let run = rest[0];
  if (!run) {
    const candidates = [];
    for (const entry of await readdir(stateRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const m = JSON.parse(await readFile(join(stateRoot, entry.name, 'manifest.json'), 'utf8'));
        const s = JSON.parse(await readFile(join(stateRoot, entry.name, 'state.json'), 'utf8'));
        if (m.git_setup?.branch === branch && !s.superseded_by && !['completed','failed'].includes(s.status)) candidates.push(entry.name);
      } catch { /* unrelated historical directories */ }
    }
    if (candidates.length !== 1) throw Error('RUN_SELECTION_REQUIRED: ' + candidates.join(', '));
    run = candidates[0];
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(run)) throw Error('INVALID_RUN_ID');
  const m = JSON.parse(await readFile(join(stateRoot, run, 'manifest.json'), 'utf8'));
  let s;
  try { s = JSON.parse(await readFile(join(stateRoot, run, 'state.json'), 'utf8')); }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  if (command === 'delta') { console.log(JSON.stringify(await delta(stateRoot, run, m, s), null, 2)); return; }
  if (hasActiveStages(s)) throw Error('RUN_ACTIVE: a stage is executing');
  if (s?.superseded_by) throw Error('RUN_SUPERSEDED');
  if (!branch || ['main','master'].includes(branch) || m.git_setup?.branch !== branch) throw Error('WORKTREE_BRANCH_MISMATCH');
  if (git('rev-parse','--path-format=absolute','--git-dir') === git('rev-parse','--path-format=absolute','--git-common-dir')) throw Error('LINKED_WORKTREE_REQUIRED');
  if (git('status','--porcelain','--untracked-files=all')) throw Error('CLEAN_WORKTREE_REQUIRED');
  const result = command === 'apply' ? await reconcile(stateRoot, run, option('--evidence')) :
    { status: 'PASS', action: 'replan_preflight', run_id: run, branch, head_sha: git('rev-parse','HEAD'), current_main_sha: git('rev-parse','refs/heads/main') };
  console.log(JSON.stringify(result, null, 2));
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch(error => { console.error('BLOCKED: pipeline_replan: ' + String(error)); process.exitCode = 1; });
