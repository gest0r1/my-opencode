import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
