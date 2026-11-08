import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { reuseLocalInputs } from './gate-snapshot.mjs';
import test from 'node:test';
import { resolveReuseIdentity } from './gate-reuse-identity.mjs';

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'gate-reuse-identity-'));
  const bin = join(cwd, 'bin');
  const managerRoot = join(cwd, 'node_modules/pnpm');
  const vitestRoot = join(cwd, 'node_modules/vitest');
  await mkdir(join(bin), { recursive: true });
  await mkdir(join(managerRoot, 'bin'), { recursive: true });
  await mkdir(join(managerRoot, 'node_modules'), { recursive: true });
  await mkdir(join(vitestRoot, 'bin'), { recursive: true });
  await mkdir(join(cwd, 'node_modules/.bin'), { recursive: true });
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ packageManager: 'pnpm@1.0.0' }));
  await writeFile(join(managerRoot, 'package.json'), JSON.stringify({ name: 'pnpm', version: '1.0.0' }));
  await writeFile(join(vitestRoot, 'package.json'), JSON.stringify({ name: 'vitest', version: '1.0.0' }));
  await writeFile(join(vitestRoot, 'bin/vitest.mjs'), '#!/usr/bin/env node\nmodule.exports = 1;\n', { mode: 0o755 });
  await symlink('../vitest/bin/vitest.mjs', join(cwd, 'node_modules/.bin/vitest'));
  await writeFile(join(managerRoot, 'bin/pnpm.cjs'), '#!/usr/bin/env node\nmodule.exports = 1;\n', { mode: 0o755 });
  await symlink('../node_modules/pnpm/bin/pnpm.cjs', join(bin, 'pnpm'));
  const env = { ...process.env, PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}` };
  for (const key of ['NODE_PATH', 'NODE_OPTIONS', 'BASH_ENV', 'PYTHONPATH', 'PYTHONHOME', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'PNPM_HOME']) delete env[key];
  const invocation = { exe: 'pnpm', args: ['exec', 'vitest', 'run'], command: 'pnpm exec vitest run', index: 0, test_files: [] };
  return { cwd, env, invocation, managerFile: join(managerRoot, 'bin/pnpm.cjs') };
}

test('the same resolved package-manager toolchain has a stable identity and changed bytes invalidate it', async () => {
  const fx = await fixture();
  try {
    const first = await resolveReuseIdentity({ cwd: fx.cwd, invocations: [fx.invocation], env: fx.env });
    const same = await resolveReuseIdentity({ cwd: fx.cwd, invocations: [fx.invocation], env: fx.env });
    assert.ok(first.digest, first.reason);
    assert.equal(same.digest, first.digest);
    await writeFile(fx.managerFile, '#!/usr/bin/env node\nmodule.exports = 2;\n', { mode: 0o755 });
    const changed = await resolveReuseIdentity({ cwd: fx.cwd, invocations: [fx.invocation], env: fx.env });
    assert.ok(changed.digest, changed.reason);
    assert.notEqual(changed.digest, first.digest);
    assert.ok(changed.metrics.files > 0);
    assert.ok(changed.metrics.bytes > 0);
  } finally { await rm(fx.cwd, { recursive: true, force: true }); }
});

test('ignored snapshot configuration changes invalidate otherwise identical toolchain identity', async () => {
  const fx = await fixture();
  try {
    await writeFile(join(fx.cwd, '.env.local'), 'FEATURE_FLAG=off\n');
    const options = { cwd: fx.cwd, invocations: [fx.invocation], env: fx.env,
      ignoredSnapshotFiles: ['.env.local'] };
    const first = await resolveReuseIdentity(options);
    const second = await resolveReuseIdentity(options);
    assert.ok(first.digest, first.reason);
    assert.equal(second.digest, first.digest);
    await writeFile(join(fx.cwd, '.env.local'), 'FEATURE_FLAG=on\n');
    const changed = await resolveReuseIdentity(options);
    assert.ok(changed.digest, changed.reason);
    assert.notEqual(changed.digest, first.digest);
    await writeFile(join(fx.cwd, '.env.extra'), 'NEW=1\n');
    const added = await resolveReuseIdentity({ ...options, ignoredSnapshotFiles: ['.env.local', '.env.extra'] });
    assert.notEqual(added.digest, changed.digest);
  } finally { await rm(fx.cwd, { recursive: true, force: true }); }
});

test('actual nested ignored Git read-set invalidates reuse on byte and membership changes', async () => {
  const fx = await fixture();
  try {
    const git = (...args) => spawnSync('git', args, { cwd: fx.cwd, encoding: 'utf8' });
    assert.equal(git('init').status, 0);
    await writeFile(join(fx.cwd, '.gitignore'), '.local-config/\nnode_modules/\n');
    await mkdir(join(fx.cwd, '.local-config/nested'), { recursive: true });
    await writeFile(join(fx.cwd, '.local-config/nested/mode.txt'), 'good');
    const read = async () => resolveReuseIdentity({ cwd: fx.cwd, invocations: [fx.invocation], env: fx.env,
      ignoredSnapshotFiles: reuseLocalInputs(fx.cwd) });
    const first = await read();
    const stable = await read();
    assert.ok(first.digest, first.reason);
    assert.equal(stable.digest, first.digest, 'unchanged nested config may still reuse');
    await writeFile(join(fx.cwd, '.local-config/nested/mode.txt'), 'bad');
    const changed = await read();
    assert.ok(changed.digest, changed.reason);
    assert.notEqual(changed.digest, first.digest);
    await writeFile(join(fx.cwd, '.local-config/nested/extra.txt'), 'added');
    const added = await read();
    assert.notEqual(added.digest, changed.digest);
    await rename(join(fx.cwd, '.local-config/nested/extra.txt'),
      join(fx.cwd, '.local-config/nested/renamed.txt'));
    const renamed = await read();
    assert.notEqual(renamed.digest, added.digest);
  } finally { await rm(fx.cwd, { recursive: true, force: true }); }
});

test('dependency symlink cycles are recorded without recursive traversal or disabling identity', async () => {
  const fx = await fixture();
  try {
    await symlink('../..', join(fx.cwd, 'node_modules/pnpm/node_modules/back'));
    const first = await resolveReuseIdentity({ cwd: fx.cwd, invocations: [fx.invocation], env: fx.env });
    const same = await resolveReuseIdentity({ cwd: fx.cwd, invocations: [fx.invocation], env: fx.env });
    assert.ok(first.digest, first.reason);
    assert.equal(same.digest, first.digest);
  } finally { await rm(fx.cwd, { recursive: true, force: true }); }
});

test('unknown launcher routes return an explicit reuse-disabled reason without a digest', async () => {
  const fx = await fixture();
  try {
    const result = await resolveReuseIdentity({ cwd: fx.cwd, invocations: [{ ...fx.invocation, exe: 'npx', args: ['--yes', 'vitest'] }], env: fx.env });
    assert.equal(result.digest, null);
    assert.match(result.reason, /bounded dependency identity/);
  } finally { await rm(fx.cwd, { recursive: true, force: true }); }
});

test('Corepack routing overrides and a conflicting devEngines pin fail closed for reuse', async () => {
  const fx = await fixture();
  try {
    const invocation = { ...fx.invocation, exe: 'corepack', args: ['pnpm', 'exec', 'vitest', 'run'] };
    const env = { ...fx.env, COREPACK_ENABLE_PROJECT_SPEC: '0' };
    const bypass = await resolveReuseIdentity({ cwd: fx.cwd, invocations: [invocation], env });
    assert.equal(bypass.digest, null);
    assert.match(bypass.reason, /COREPACK_ENABLE_PROJECT_SPEC/);

    await writeFile(join(fx.cwd, 'package.json'), JSON.stringify({ packageManager: 'pnpm@1.0.0',
      devEngines: { packageManager: { name: 'pnpm', version: '2.0.0' } } }));
    const conflict = await resolveReuseIdentity({ cwd: fx.cwd, invocations: [fx.invocation], env: fx.env });
    assert.equal(conflict.digest, null);
    assert.match(conflict.reason, /devEngines\.packageManager/);
  } finally { await rm(fx.cwd, { recursive: true, force: true }); }
});
