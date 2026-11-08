import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { copiedIgnoredInputs, reuseLocalInputs } from './gate-snapshot.mjs';

test('snapshot and reuse share the same ignored input files and include local untracked config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate-local-inputs-'));
  try {
    const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(git('init').status, 0);
    await mkdir(join(root, 'src'));
    await mkdir(join(root, 'node_modules'));
    await mkdir(join(root, '.tmp'));
    await writeFile(join(root, '.gitignore'), 'node_modules/\n.tmp/\n.env.local\n');
    await writeFile(join(root, 'src/index.ts'), 'export const x = 1;\n');
    assert.equal(git('add', '.gitignore', 'src/index.ts').status, 0);
    await writeFile(join(root, '.env.local'), 'MODE=1\n');
    await writeFile(join(root, '.env.untracked'), 'MODE=2\n');
    await writeFile(join(root, 'local.key'), 'fixture-only\n');
    await writeFile(join(root, 'src/new.ts'), 'export const y = 2;\n');
    await writeFile(join(root, 'node_modules/tool'), 'ignored dependency');
    await writeFile(join(root, '.tmp/local.key'), 'ignored temp');

    const copied = copiedIgnoredInputs(root);
    assert.deepEqual(copied, ['.env.local']);
    const inputs = reuseLocalInputs(root);
    assert.deepEqual(inputs, ['.env.local', '.env.untracked', 'local.key']);
    assert.ok(!inputs.some(file => file.startsWith('.tmp/') || file.startsWith('node_modules/')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('nested ignored inputs preserve bytes, additions, renames and removals in the shared read-set', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate-nested-inputs-'));
  try {
    const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(git('init').status, 0);
    await writeFile(join(root, '.gitignore'), '.local-config/\nnode_modules/\n.tmp/\ndist/\n');
    await mkdir(join(root, '.local-config/nested'), { recursive: true });
    await mkdir(join(root, 'node_modules'));
    await mkdir(join(root, 'dist'));
    await writeFile(join(root, '.local-config/nested/mode.txt'), 'good');
    await writeFile(join(root, 'node_modules/skip.key'), 'excluded');
    await writeFile(join(root, 'dist/skip.key'), 'excluded');

    const start = copiedIgnoredInputs(root);
    assert.deepEqual(start, ['.local-config/nested/mode.txt']);
    assert.deepEqual(reuseLocalInputs(root), start);
    await writeFile(join(root, '.local-config/nested/mode.txt'), 'bad');
    assert.deepEqual(copiedIgnoredInputs(root), start, 'path stable; hashing must see new bytes');
    await writeFile(join(root, '.local-config/nested/new.txt'), 'added');
    assert.deepEqual(copiedIgnoredInputs(root), ['.local-config/nested/mode.txt', '.local-config/nested/new.txt']);
    await rename(join(root, '.local-config/nested/mode.txt'), join(root, '.local-config/nested/renamed.txt'));
    assert.deepEqual(reuseLocalInputs(root), ['.local-config/nested/new.txt', '.local-config/nested/renamed.txt']);
    await unlink(join(root, '.local-config/nested/new.txt'));
    assert.deepEqual(copiedIgnoredInputs(root), ['.local-config/nested/renamed.txt']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('ignored symlink does not leak outside checkout or become reusable evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate-input-symlink-'));
  const outside = await mkdtemp(join(tmpdir(), 'gate-input-external-'));
  try {
    const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(git('init').status, 0);
    await writeFile(join(root, '.gitignore'), '.local-config/\n');
    await mkdir(join(root, '.local-config'));
    await writeFile(join(outside, 'secret.txt'), 'fixture');
    await symlink(join(outside, 'secret.txt'), join(root, '.local-config/secret.txt'));
    assert.throws(() => copiedIgnoredInputs(root), /SNAPSHOT_LOCAL_INPUT_OUTSIDE_CHECKOUT|SNAPSHOT_LOCAL_INPUT_NOT_REGULAR/);
    assert.throws(() => reuseLocalInputs(root), /SNAPSHOT_LOCAL_INPUT_OUTSIDE_CHECKOUT|SNAPSHOT_LOCAL_INPUT_NOT_REGULAR/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
