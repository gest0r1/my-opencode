#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

function fail(message, code = 2) {
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exit(code);
}

function runGit(args, cwd, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    if (allowFailure) return '';
    const detail = error?.stderr?.toString?.().trim() || error?.message || String(error);
    fail(`git ${args.join(' ')} failed: ${detail}`);
  }
}

function parseArgs(argv) {
  const result = { mode: argv[0], runId: undefined, baseSha: undefined };
  if (!['plan', 'run'].includes(result.mode)) fail('usage: workspace-preflight.mjs <plan|run> [--run-id ID] [--base-sha SHA]');
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--run-id') result.runId = argv[++i];
    else if (arg === '--base-sha') result.baseSha = argv[++i];
    else fail(`unknown argument: ${arg}`);
  }
  if (result.baseSha && !/^[0-9a-f]{40}$/i.test(result.baseSha)) fail('base SHA must be a 40-hex commit SHA');
  return result;
}

function worktreeId(path) {
  return createHash('sha256').update(path).digest('hex').slice(0, 12);
}

function parseWorktrees(raw) {
  const items = [];
  let current = null;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current) items.push(current);
      current = { path: line.slice('worktree '.length), branch: null, head: null };
    } else if (current && line.startsWith('HEAD ')) current.head = line.slice(5);
    else if (current && line.startsWith('branch ')) current.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (current && line === 'detached') current.branch = '(detached)';
  }
  if (current) items.push(current);
  return items;
}

function readPipelineStates(worktreePath) {
  const root = join(worktreePath, '.tmp', 'pipelines');
  if (!existsSync(root)) return [];
  const states = [];
  for (const name of readdirSync(root, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const file = join(root, name.name, 'state.json');
    if (!existsSync(file)) continue;
    try {
      const state = JSON.parse(readFileSync(file, 'utf8'));
      states.push({ run_id: state.run_id ?? name.name, status: state.status ?? 'unknown' });
    } catch {
      states.push({ run_id: name.name, status: 'invalid_state' });
    }
  }
  return states;
}

const args = parseArgs(process.argv.slice(2));
const cwd = process.cwd();
const root = realpathSync(runGit(['rev-parse', '--show-toplevel'], cwd));
const head = runGit(['rev-parse', 'HEAD'], root);
const branch = runGit(['branch', '--show-current'], root, { allowFailure: true }) || '(detached)';
const dirtyLines = runGit(['status', '--porcelain'], root, { allowFailure: true });
const worktrees = parseWorktrees(runGit(['worktree', 'list', '--porcelain'], root));

const activeStatuses = new Set(['approved', 'in_progress', 'blocked', 'failed', 'ready', 'release_ready']);
const activeOtherRuns = [];
for (const wt of worktrees) {
  let resolved;
  try { resolved = realpathSync(wt.path); } catch { continue; }
  for (const state of readPipelineStates(resolved)) {
    if (state.run_id === args.runId) continue;
    if (!activeStatuses.has(state.status) && state.status !== 'invalid_state') continue;
    activeOtherRuns.push({
      run_id: state.run_id,
      status: state.status,
      worktree_id: worktreeId(resolved),
      same_worktree: resolved === root,
    });
  }
}

const sameWorktreeConflicts = activeOtherRuns.filter((item) => item.same_worktree);
let workspaceModeSuggestion;
if (sameWorktreeConflicts.length > 0) workspaceModeSuggestion = 'conflict_shared_worktree';
else if (activeOtherRuns.length > 0) workspaceModeSuggestion = 'dedicated_worktree';
else workspaceModeSuggestion = 'exclusive_shared_worktree';

let drift = null;
if (args.baseSha) {
  let isDescendant = true;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', args.baseSha, head], { cwd: root, stdio: 'ignore' });
  } catch {
    isDescendant = false;
  }
  const range = isDescendant ? `${args.baseSha}...${head}` : `${args.baseSha}..${head}`;
  const changed = runGit(['diff', '--name-only', range], root, { allowFailure: true });
  drift = {
    base_sha: args.baseSha,
    current_sha: head,
    is_descendant: isDescendant,
    changed_files: changed ? changed.split(/\r?\n/).filter(Boolean) : [],
  };
}

const result = {
  ok: sameWorktreeConflicts.length === 0,
  mode: args.mode,
  run_id: args.runId ?? null,
  branch,
  head_sha: head,
  worktree_id: worktreeId(root),
  clean: dirtyLines.length === 0,
  dirty_entries: dirtyLines ? dirtyLines.split(/\r?\n/).filter(Boolean).length : 0,
  worktree_count: worktrees.length,
  active_other_runs: activeOtherRuns,
  same_worktree_conflicts: sameWorktreeConflicts,
  workspace_mode_suggestion: workspaceModeSuggestion,
  requires_owner_confirmation: true,
  drift,
};

console.log(JSON.stringify(result, null, 2));
process.exitCode = sameWorktreeConflicts.length > 0 ? 3 : 0;
