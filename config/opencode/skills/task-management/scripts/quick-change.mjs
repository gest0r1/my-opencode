import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// /pipeline-quick takes a change without PLAN only when it is small and cannot change a decision:
// documentation, user-facing texts, tests that keep every check, and code up to CODE_LINE_LIMIT
// changed lines inside one module. Anything else (protected or sensitive paths, migrations,
// dependencies, CI, build config, a weakened test, wider code) goes to /pipeline-plan.
export const CODE_LINE_LIMIT = 50;

const DOC = /(^|\/)(docs?)\/|\.(md|mdx|rst|txt|adoc)$/i;
const TEXT = /(^|\/)(locales?|i18n|translations?|lang)\/|\.(po|pot|ftl|xliff)$/i;
const TEST = /(^|\/)(__tests__|tests?|spec|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/i;
const MIGRATION = /(^|\/)(migrations?|migrate)\/|\.sql$/i;
const CONFIG = /(^|\/)(\.github|\.gitlab|\.circleci|\.opencode)\/|(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|pyproject\.toml|uv\.lock|requirements[^/]*\.txt|go\.(mod|sum)|Cargo\.(toml|lock)|Dockerfile|docker-compose[^/]*\.ya?ml|Makefile|tsconfig[^/]*\.json|vite\.config\.[^/]+|vitest\.config\.[^/]+|jest\.config\.[^/]+)$/i;
const SENSITIVE = /(^|\/)\.env(\.(?!example$)[^/]*)?$|\.(key|pem|p12|pfx|secret)$/i;
const ASSERTION = /\b(expect|assert\w*|should|toBe|toEqual|toMatch|toThrow|t\.(?:is|true|false|deepEqual))\b/;
const DISABLED = /\b(?:it|test|describe)\.(?:skip|only|todo)\b|\b(?:xit|xdescribe|xtest)\s*\(|@pytest\.mark\.skip|\bt\.Skip\(/;

function matchesScope(path, scope) {
  if (scope.endsWith('/**')) { const prefix = scope.slice(0, -3).replace(/\/$/, ''); return path === prefix || path.startsWith(`${prefix}/`); }
  return path === scope;
}

function moduleOf(path) {
  const parts = path.split('/');
  if (parts.length <= 2) return parts.length === 1 ? '.' : parts[0];
  return ['packages', 'apps', 'libs', 'services', 'modules', 'crates', 'cmd', 'internal'].includes(parts[0]) ? parts.slice(0, 2).join('/') : parts[0];
}

export function classifyChange(files, { protectedPaths = [] } = {}) {
  const reasons = [];
  const kinds = new Set();
  let codeLines = 0;
  const codeModules = new Set();
  for (const file of files) {
    const { path } = file;
    if (SENSITIVE.test(path)) reasons.push(`SENSITIVE_PATH: ${path}`);
    if (protectedPaths.some((scope) => matchesScope(path, scope))) reasons.push(`PROTECTED_PATH: ${path}`);
    if (MIGRATION.test(path)) reasons.push(`MIGRATION: ${path}`);
    if (CONFIG.test(path)) reasons.push(`BUILD_OR_DEPENDENCY_CONFIG: ${path}`);
    if (file.binary) reasons.push(`BINARY: ${path}`);
    const kind = TEST.test(path) ? 'tests' : DOC.test(path) ? 'docs' : TEXT.test(path) ? 'texts' : 'code';
    kinds.add(kind);
    if (kind === 'tests') {
      const removed = file.removed.filter((line) => ASSERTION.test(line)).length;
      const added = file.added.filter((line) => ASSERTION.test(line)).length;
      if (removed > added) reasons.push(`TEST_WEAKENED: ${path} loses ${removed - added} assertion line(s)`);
      if (file.added.some((line) => DISABLED.test(line))) reasons.push(`TEST_DISABLED: ${path} adds a skip/only/todo`);
      if (file.deleted_file) reasons.push(`TEST_DELETED: ${path}`);
    }
    if (kind === 'code') { codeLines += file.added.length + file.removed.length; codeModules.add(moduleOf(path)); }
  }
  if (codeLines > CODE_LINE_LIMIT) reasons.push(`CODE_TOO_LARGE: ${codeLines} changed lines (limit ${CODE_LINE_LIMIT})`);
  if (codeModules.size > 1) reasons.push(`CODE_SPANS_MODULES: ${[...codeModules].sort().join(', ')}`);
  if (!files.length) reasons.push('NO_CHANGE');
  return { status: reasons.length ? 'NEEDS_PLAN' : 'QUICK', kinds: [...kinds].sort(), code_lines: codeLines,
    code_review_required: kinds.has('code'), files: files.map((file) => file.path).sort(), reasons };
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || '').trim()}`);
  return result.stdout;
}

// The working tree against HEAD, untracked files included, pipeline state excluded.
export function workingChange(cwd) {
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter((path) => path && !path.startsWith('.tmp/'));
  const status = git(cwd, ['diff', 'HEAD', '--name-status', '-z', '--no-renames']).split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < status.length; i += 2) {
    const path = status[i + 1];
    if (path.startsWith('.tmp/')) continue;
    const patch = git(cwd, ['diff', 'HEAD', '--no-renames', '--unified=0', '--', path]);
    files.push({ path, deleted_file: status[i] === 'D', binary: /^Binary files /m.test(patch),
      added: patch.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).map((line) => line.slice(1)),
      removed: patch.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---')).map((line) => line.slice(1)) });
  }
  for (const path of untracked) {
    let content = '';
    try { content = readFileSync(join(cwd, path), 'utf8'); } catch {}
    files.push({ path, deleted_file: false, binary: content.includes('\0'), added: content.split('\n').filter((line, index, all) => index < all.length - 1 || line), removed: [] });
  }
  const digest = createHash('sha256').update(JSON.stringify(files.map((file) => [file.path, file.added, file.removed]).sort())).digest('hex');
  return { files, digest };
}
