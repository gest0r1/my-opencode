import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { classifyChange, CODE_LINE_LIMIT } from './quick-change.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const file = (p, added = [], removed = [], extra = {}) => ({ path: p, added, removed, deleted_file: false, binary: false, ...extra });

test('docs, texts, tests that keep their checks and small code in one module are quick', () => {
  const result = classifyChange([
    file('docs/guide.md', ['new line']), file('src/locales/ru.json', ['"a": "б"']),
    file('src/api/user.test.ts', ['expect(x).toBe(1);'], []), file('src/api/user.ts', Array(10).fill('x'), Array(5).fill('y')),
  ]);
  assert.equal(result.status, 'QUICK');
  assert.deepEqual(result.kinds, ['code', 'docs', 'tests', 'texts']);
  assert.equal(result.code_review_required, true);
  assert.equal(classifyChange([file('README.md', ['x'])]).code_review_required, false);
});

test('anything that can change a decision goes to PLAN', () => {
  const reasons = (files, options) => classifyChange(files, options).reasons;
  assert.match(reasons([file('src/a.ts', Array(CODE_LINE_LIMIT + 1).fill('x'))])[0], /^CODE_TOO_LARGE/);
  assert.match(reasons([file('packages/a/x.ts', ['x']), file('packages/b/y.ts', ['y'])])[0], /^CODE_SPANS_MODULES: packages\/a, packages\/b/);
  assert.match(reasons([file('db/migrations/001.sql', ['x'])]).join(), /MIGRATION/);
  assert.match(reasons([file('package.json', ['x'])]).join(), /BUILD_OR_DEPENDENCY_CONFIG/);
  assert.match(reasons([file('.github/workflows/ci.yml', ['x'])]).join(), /BUILD_OR_DEPENDENCY_CONFIG/);
  assert.match(reasons([file('.env.local', ['x'])]).join(), /SENSITIVE_PATH/);
  assert.match(reasons([file('src/auth/token.ts', ['x'])], { protectedPaths: ['src/auth/**'] }).join(), /PROTECTED_PATH/);
  assert.match(reasons([file('src/a.test.ts', ['// gone'], ['expect(a).toBe(1);'])]).join(), /TEST_WEAKENED/);
  assert.match(reasons([file('src/a.test.ts', ['it.skip("x", () => {})'], [])]).join(), /TEST_DISABLED/);
  assert.match(reasons([file('tests/old.test.ts', [], ['x'], { deleted_file: true })]).join(), /TEST_DELETED/);
  assert.deepEqual(reasons([]), ['NO_CHANGE']);
});

test('quick-commit commits only the checked and reviewed diff to a feature branch', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'quick-change-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const cli = (...args) => spawnSync('npx', ['--yes', 'tsx', path.join(HERE, 'git-worktree-cli.ts'), ...args], { cwd: root, encoding: 'utf8' });
  git('init', '-b', 'main'); git('config', 'user.email', 't@example.invalid'); git('config', 'user.name', 'T');
  await mkdir(path.join(root, 'src')); await writeFile(path.join(root, '.gitignore'), '.tmp/\n');
  await writeFile(path.join(root, 'src/a.ts'), 'export const a = 1;\n'); git('add', '.'); git('commit', '-m', 'base');
  await writeFile(path.join(root, 'src/a.ts'), 'export const a = 2;\n');
  let result = cli('quick-check', 'quick-1');
  assert.notEqual(result.status, 0); assert.match(result.stderr, /QUICK_ON_DEFAULT_BRANCH/);
  git('checkout', '-b', 'feature/quick');
  result = cli('quick-check', 'quick-1');
  assert.equal(result.status, 0, result.stderr);
  const checked = JSON.parse(result.stdout);
  assert.equal(checked.code_review_required, true);
  result = cli('quick-commit', 'quick-1', '--message', 'fix: a is 2');
  assert.notEqual(result.status, 0); assert.match(result.stderr, /QUICK_REVIEW_REQUIRED/);
  const reviewFile = path.join(root, '.tmp/pipelines/quick-1/review.json');
  await writeFile(reviewFile, JSON.stringify({ status: 'ready', diff_sha256: checked.diff_sha256 }));
  await writeFile(path.join(root, 'src/a.ts'), 'export const a = 3;\n');
  result = cli('quick-commit', 'quick-1', '--message', 'fix: a is 2');
  assert.notEqual(result.status, 0); assert.match(result.stderr, /QUICK_CHANGED_AFTER_CHECK/);
  await writeFile(path.join(root, 'src/a.ts'), 'export const a = 2;\n');
  result = cli('quick-commit', 'quick-1', '--message', 'fix: a is 2');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git('log', '-1', '--format=%s'), 'fix: a is 2');
  assert.equal(git('status', '--porcelain'), '');
  assert.equal(JSON.parse(await readFile(reviewFile, 'utf8')).status, 'ready');
});
