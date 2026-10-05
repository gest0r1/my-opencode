import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hasActiveStages } from './plan-lifecycle.ts';
import { reconcile } from './pipeline-reconcile-cli.ts';

function git(...args: string[]) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  if (r.status !== 0 || r.error) throw Error(r.stderr || String(r.error));
  return r.stdout.trim();
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!['preflight', 'check', 'apply'].includes(command)) throw Error('usage: pipeline-refresh-cli preflight|check|apply [RUN] [--evidence PATH]');
  const option = (key: string) => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };
  const stateRoot = resolve(option('--state-root') ?? '.tmp/pipelines');
  const branch = git('branch', '--show-current');
  const rest = args.filter((value, index) => !value.startsWith('--') && (index === 0 || !args[index - 1].startsWith('--')));
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
  if (hasActiveStages(s)) throw Error('RUN_ACTIVE: a stage is executing');
  if (s?.superseded_by) throw Error('RUN_SUPERSEDED');
  if (!branch || ['main','master'].includes(branch) || m.git_setup?.branch !== branch) throw Error('WORKTREE_BRANCH_MISMATCH');
  if (git('rev-parse','--path-format=absolute','--git-dir') === git('rev-parse','--path-format=absolute','--git-common-dir')) throw Error('LINKED_WORKTREE_REQUIRED');
  if (git('status','--porcelain','--untracked-files=all')) throw Error('CLEAN_WORKTREE_REQUIRED');
  const result = command === 'apply' ? await reconcile(stateRoot, run, option('--evidence')) :
    { status: 'PASS', action: 'refresh_preflight', run_id: run, branch, head_sha: git('rev-parse','HEAD'), current_main_sha: git('rev-parse','refs/heads/main') };
  console.log(JSON.stringify(result, null, 2));
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch(error => { console.error('BLOCKED: pipeline_refresh: ' + String(error)); process.exitCode = 1; });
