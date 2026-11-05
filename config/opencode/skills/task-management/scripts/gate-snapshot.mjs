import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { sourceInventory } from './gate-diagnostics.mjs';
import { checkProjectTooling, restoreDependencies } from './project-tooling.mjs';

// A full gate runs on a snapshot of the working tree in its own git worktree, so workers keep writing
// while it runs and the gate measures one fixed tree. The snapshot is a commit object built with a
// private index (no ref, branch or main index changes) holding every tracked file plus the untracked
// files the source inventory covers; ignored local files (env, local config) are copied, dependencies
// are restored from the lockfile, and `.tmp/pipelines` points back to the run's state root.

const IGNORED_SKIP = /(^|\/)(node_modules|dist|build|coverage|\.tmp|\.git|\.pnpm-store|\.next|\.turbo|\.cache|\.vite|out)(\/|$)/;
const SENSITIVE_UNTRACKED = /(^|\/)(\.env(?:\..*)?|[^/]+\.(?:key|pem|secret))$/i;
const generated = file => /(^|\/)(\.tmp|\.git|node_modules|dist|build|coverage)(\/|$)/i.test(file);
const sensitive = file => /(^|\/)(\.env(?:\..*)?|[^/]+\.(?:key|pem|secret))$/i.test(file);

function git(cwd, args, { env = {}, input } = {}) {
  const result = spawnSync('git', args, { cwd, env: { ...process.env, GIT_LITERAL_PATHSPECS: '1', ...env }, input, encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
  if (result.status !== 0) throw new Error(`SNAPSHOT_GIT_FAILED: git ${args[0]}: ${(result.stderr || result.error?.message || '').trim().slice(0, 300)}`);
  return result.stdout;
}

const lines = text => text.split('\0').filter(Boolean);

function snapshotCommit(cwd, scratch) {
  const index = join(scratch, `index-${process.pid}-${randomBytes(4).toString('hex')}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    const head = git(cwd, ['rev-parse', '--verify', 'HEAD']).trim();
    git(cwd, ['read-tree', head], { env });
    // Changes to tracked files (deletions included) and untracked files the inventory hashes; untracked
    // sensitive files never enter the object store.
    const changed = lines(git(cwd, ['diff', '--name-only', '-z', '--no-renames', head, '--']));
    const untracked = lines(git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).filter(file => !generated(file) && !sensitive(file));
    const paths = [...new Set([...changed, ...untracked])];
    if (paths.length) git(cwd, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { env, input: `${paths.join('\0')}\0` });
    const tree = git(cwd, ['write-tree'], { env }).trim();
    const identity = { GIT_AUTHOR_NAME: 'pipeline', GIT_AUTHOR_EMAIL: 'pipeline@localhost', GIT_COMMITTER_NAME: 'pipeline', GIT_COMMITTER_EMAIL: 'pipeline@localhost' };
    return git(cwd, ['commit-tree', tree, '-p', head, '-m', 'pipeline gate snapshot'], { env: identity }).trim();
  } finally { rmSync(index, { force: true }); }
}

// The checkout's dependency trees (root and per-package node_modules), hard-linked into the snapshot.
// A fresh install there is not the same environment: pnpm may report "Already up to date" and leave
// workspace links out, and then a test that resolves a workspace package from another cwd fails only on
// the snapshot. Links keep pnpm's relative symlinks, so workspace packages resolve inside the snapshot.
function linkDependencyTrees(cwd, dir) {
  const started = Date.now();
  const trees = lines(git(cwd, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']))
    .map(entry => entry.replace(/\/$/, ''))
    .filter(entry => entry.split('/').at(-1) === 'node_modules' && !entry.split('/').slice(0, -1).includes('node_modules'));
  for (const tree of trees) {
    const target = join(dir, tree);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(dirname(target), { recursive: true });
    let copied = spawnSync('cp', ['-al', join(cwd, tree), target], { encoding: 'utf8' });
    // Another filesystem cannot hard-link: copy instead.
    if (copied.status !== 0) { rmSync(target, { recursive: true, force: true }); copied = spawnSync('cp', ['-a', join(cwd, tree), target], { encoding: 'utf8' }); }
    if (copied.status !== 0) throw new Error(`SNAPSHOT_DEPENDENCIES_FAILED: ${tree}: ${(copied.stderr || '').trim().slice(0, 300)}`);
  }
  return { dependency_trees: trees, link_ms: Date.now() - started };
}

// This is the exact read-set of ignored local inputs copied into the snapshot.
// The gate reuse identity hashes these same paths, otherwise a changed .env.local
// could reuse a PASS from a different service/test configuration.
export function copiedIgnoredInputs(cwd) {
  return lines(git(cwd, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']))
    .filter(entry => !entry.endsWith('/') && !IGNORED_SKIP.test(entry));
}

// An untracked, nonignored secret is intentionally not committed to a snapshot,
// but may affect a fallback in-place gate. Hash its bytes in the reuse identity;
// never expose the content or persist an individual secret hash.
export function reuseLocalInputs(cwd) {
  const excludedSensitive = lines(git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']))
    .filter(file => !IGNORED_SKIP.test(file) && SENSITIVE_UNTRACKED.test(file));
  return [...new Set([...copiedIgnoredInputs(cwd), ...excludedSensitive])].sort();
}

function copyIgnoredFiles(cwd, dir) {
  for (const entry of copiedIgnoredInputs(cwd)) {
    mkdirSync(dirname(join(dir, entry)), { recursive: true });
    try { copyFileSync(join(cwd, entry), join(dir, entry)); }
    catch (error) { throw new Error(`SNAPSHOT_LOCAL_INPUT_COPY_FAILED: ${entry}: ${String(error instanceof Error ? error.message : error)}`); }
  }
}

const STALE_SNAPSHOT_MS = 24 * 60 * 60 * 1000;

function snapshotRoot(cwd) {
  const base = process.env.PIPELINE_SNAPSHOT_DIR || join(os.homedir(), '.cache', 'opencode-pipeline', 'snapshots');
  mkdirSync(base, { recursive: true });
  // A gate killed outright (SIGKILL, host crash) leaves its worktree behind; a day later it is removed.
  for (const name of readdirSync(base)) {
    const dir = join(base, name);
    try { if (Date.now() - statSync(dir).mtimeMs > STALE_SNAPSHOT_MS) rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  try { git(cwd, ['worktree', 'prune']); } catch {}
  // Physical path: project harnesses compare their root lexically with its real path.
  return realpathSync(base);
}

// Returns `unavailable` with a reason when the tree cannot be snapshotted; the gate then runs in place.
// `prepare()` (ignored files, state link, dependencies) runs only once the gate has commands to run.
export async function createGateSnapshot({ cwd, stateRoot, label, installEvidence }) {
  const rel = relative(cwd, stateRoot);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return { unavailable: 'state root is outside the checkout' };
  let dir;
  const started = Date.now();
  try {
    const commit = snapshotCommit(cwd, stateRoot);
    dir = join(snapshotRoot(cwd), `${label}-${createHash('sha256').update(`${cwd}:${commit}:${process.pid}:${Date.now()}`).digest('hex').slice(0, 12)}`);
    git(cwd, ['worktree', 'add', '--detach', '--force', dir, commit]);
    const snapshot = {
      dir, commit, cwd,
      async prepare() {
        copyIgnoredFiles(cwd, dir);
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        rmSync(join(dir, rel), { recursive: true, force: true });
        symlinkSync(stateRoot, join(dir, rel));
        const linked = linkDependencyTrees(cwd, dir);
        if (linked.dependency_trees.length) return linked;
        // The checkout has no installed dependencies to share: restore them from the lockfile.
        const tooling = checkProjectTooling(dir);
        const install = tooling.package_manager
          ? restoreDependencies(dir, tooling, { evidenceFile: installEvidence, extraArgs: ['--prefer-offline'] }) : null;
        return { install_ms: install?.duration_ms ?? 0 };
      },
      // Moves the same worktree to a fresh snapshot of the current tree and links the checkout's current
      // dependency trees again.
      async refresh() {
        const next = snapshotCommit(cwd, stateRoot);
        git(dir, ['checkout', '--detach', '--force', next]);
        git(dir, ['clean', '-fdx', '-e', 'node_modules', '-e', rel.split('/')[0]]);
        snapshot.commit = next;
        return snapshot.prepare();
      },
      async inventory(invoke) { return sourceInventory(dir, invoke); },
      async remove() {
        if (process.env.PIPELINE_KEEP_SNAPSHOT === '1') return;
        try { git(cwd, ['worktree', 'remove', '--force', dir]); } catch { rmSync(dir, { recursive: true, force: true }); git(cwd, ['worktree', 'prune']); }
      },
    };
    return { snapshot, setup_ms: Date.now() - started };
  } catch (error) {
    if (dir) { try { git(cwd, ['worktree', 'remove', '--force', dir]); } catch { rmSync(dir, { recursive: true, force: true }); try { git(cwd, ['worktree', 'prune']); } catch {} } }
    return { unavailable: error instanceof Error ? error.message : String(error) };
  }
}
