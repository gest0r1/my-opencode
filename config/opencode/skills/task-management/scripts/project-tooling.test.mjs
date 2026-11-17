import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { checkProjectTooling, executablePath, prepareProjectTooling, restoreDependencies, satisfies } from './project-tooling.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'project-tooling-'));
  const home = join(root, 'home'), project = join(root, 'project'), bin = join(home, '.local/bin');
  mkdirSync(bin, {recursive: true}); mkdirSync(project);
  symlinkSync(process.execPath, join(bin, 'node'));
  writeFileSync(join(project, 'package.json'), JSON.stringify({packageManager: 'pnpm@11.17.0', engines: {node: '>=22', pnpm: '>=11'}}));
  return {root, home, project, bin, env: {...process.env, HOME: home, PATH: `${bin}`}};
}

test('diagnostics distinguish absent, broken, non-executable and failed commands', () => {
  const f = fixture();
  try {
    assert.throws(() => executablePath('pnpm', f.env), /EXECUTABLE_NOT_FOUND/);
    symlinkSync(join(f.root, 'missing'), join(f.bin, 'pnpm'));
    assert.throws(() => executablePath('pnpm', f.env), /EXECUTABLE_BROKEN_SYMLINK/);
    rmSync(join(f.bin, 'pnpm'));
    writeFileSync(join(f.bin, 'pnpm'), '#!/bin/sh\nexit 0\n', {mode: 0o600});
    assert.throws(() => executablePath('pnpm', f.env), /EXECUTABLE_NOT_ACCESSIBLE/);
    rmSync(join(f.bin, 'pnpm'));
    writeFileSync(join(f.bin, 'pnpm'), '#!/bin/sh\nexit 42\n', {mode: 0o755});
    assert.throws(() => checkProjectTooling(f.project, f.env), /EXECUTABLE_START_FAILED/);
  } finally {rmSync(f.root, {recursive: true, force: true});}
});

test('polluted PATH pointing into another user home is never accepted', (t) => {
  if (process.getuid?.() === 0) return t.skip('root can traverse /root; fixture asserts unprivileged access');
  const f = fixture();
  try {
    const rootNvm = join(f.root, 'root-nvm'); mkdirSync(rootNvm);
    symlinkSync('/root/.nvm/versions/node/v22.23.2/bin/pnpm', join(rootNvm, 'pnpm'));
    f.env.PATH = `${rootNvm}:${f.bin}`;
    assert.throws(() => executablePath('pnpm', f.env), /EXECUTABLE_(?:BROKEN_SYMLINK|NOT_ACCESSIBLE)/);
    assert.throws(() => checkProjectTooling(f.project, f.env), /EXECUTABLE_(?:BROKEN_SYMLINK|NOT_ACCESSIBLE)/);
  } finally {rmSync(f.root, {recursive: true, force: true});}
});

test('version and engines are checked by running the executable in the project', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.bin, 'pnpm'), '#!/bin/sh\necho 10.0.0\n', {mode: 0o755});
    assert.throws(() => checkProjectTooling(f.project, f.env), /PACKAGE_MANAGER_VERSION_MISMATCH/);
    writeFileSync(join(f.bin, 'pnpm'), '#!/bin/sh\necho 11.17.0\n');
    assert.equal(checkProjectTooling(f.project, f.env).version, '11.17.0');
    writeFileSync(join(f.project, 'package.json'), JSON.stringify({packageManager:'pnpm@11.17.0', engines:{node:'>=99'}}));
    assert.throws(() => checkProjectTooling(f.project, f.env), /NODE_VERSION_MISMATCH/);
  } finally {rmSync(f.root, {recursive: true, force: true});}
});

test('user preparation repairs a broken global pnpm and keeps project files unchanged', () => {
  const f = fixture(), getuid = process.getuid;
  const before = readFileSync(join(f.project, 'package.json'), 'utf8');
  process.getuid = () => 1001;
  try {
    const global = join(f.root, 'global'); mkdirSync(global);
    symlinkSync('/root/inaccessible/pnpm', join(global, 'pnpm'));
    f.env.PATH = `${f.bin}:/usr/bin:/bin:${global}`;
    writeFileSync(join(f.bin, 'npm'), `#!/bin/sh
if [ "$1" = view ]; then echo '{"node":">=22"}'; exit 0; fi
prefix=''; spec=''
while [ "$#" -gt 0 ]; do
 if [ "$1" = --prefix ]; then prefix="$2"; shift 2; else spec="$1"; shift; fi
done
mkdir -p "$prefix/bin"
printf '#!/bin/sh\\necho %s\\n' "\${spec#*@}" > "$prefix/bin/pnpm"
chmod 755 "$prefix/bin/pnpm"
`, {mode: 0o755});
    assert.equal(prepareProjectTooling(f.project, f).version, '11.17.0');
    assert.equal(readFileSync(join(f.project, 'package.json'), 'utf8'), before);
    const other = join(f.root, 'other'); mkdirSync(other);
    writeFileSync(join(other, 'package.json'), JSON.stringify({packageManager:'pnpm@11.18.0'}));
    assert.equal(prepareProjectTooling(other, f).version, '11.18.0');
    assert.equal(checkProjectTooling(f.project, f.env).version, '11.17.0');
    assert.equal(checkProjectTooling(other, f.env).version, '11.18.0');
  } finally {process.getuid = getuid; rmSync(f.root, {recursive: true, force: true});}
});

test('supported engine ranges fail closed on unsupported grammar', () => {
  for (const range of ['>=22', '^24.0.0', '~24.19.0', '>=22 <25', '>=20.19 || >=22.12']) assert.equal(satisfies('24.19.0', range), true, range);
  for (const range of ['>=25', '^0.2.0', '~24.18.0', '<22']) assert.equal(satisfies('24.19.0', range), false, range);
  assert.throws(() => satisfies('24.19.0', '22 - 24'), /ENGINE_RANGE_UNSUPPORTED/);
});

function depFixture(manager, version, lock, body = '') {
  const f = fixture();
  writeFileSync(join(f.project, 'package.json'), JSON.stringify({packageManager: `${manager}@${version}`}));
  if (lock) writeFileSync(join(f.project, lock), 'lock-v1\n');
  const argv = join(f.root, 'argv.txt');
  writeFileSync(join(f.bin, manager), `#!/bin/sh\nif [ "$1" = --version ]; then echo ${version}; exit 0; fi\nprintf '%s|' "$@" >> ${argv}\npwd >> ${argv}\n${body}\n`, {mode: 0o755});
  f.argv = argv; f.evidence = join(f.root, 'run', 'checks', 'dependencies.json');
  f.restore = () => restoreDependencies(f.project, checkProjectTooling(f.project, f.env), {env: f.env, evidenceFile: f.evidence});
  return f;
}

test('dependency restore runs exactly one frozen install per manager and writes evidence', () => {
  for (const [manager, lock, args] of [['pnpm', 'pnpm-lock.yaml', 'install|--frozen-lockfile|'], ['npm', 'package-lock.json', 'ci|'], ['yarn', 'yarn.lock', 'install|--immutable|'], ['bun', 'bun.lockb', 'install|--frozen-lockfile|']]) {
    const f = depFixture(manager, '1.2.3', lock, 'echo installed');
    try {
      const evidence = f.restore();
      assert.equal(readFileSync(f.argv, 'utf8').trim(), `${args}${realpathSync(f.project)}`);
      assert.deepEqual(JSON.parse(readFileSync(f.evidence, 'utf8')), evidence);
      assert.equal(evidence.kind, 'dependency_restore'); assert.equal(evidence.status, 'PASS');
      assert.equal(evidence.manager, manager); assert.equal(evidence.version, '1.2.3'); assert.equal(evidence.lockfile, lock);
      assert.match(evidence.lockfile_sha256, /^[0-9a-f]{64}$/); assert.equal(evidence.exit_code, 0);
      assert.match(evidence.output_tail, /installed/); assert.ok(evidence.command.startsWith(manager)); assert.ok(evidence.at && evidence.duration_ms >= 0);
    } finally {rmSync(f.root, {recursive: true, force: true});}
  }
});

test('dependency restore requires a lockfile before running anything', () => {
  const f = depFixture('pnpm', '11.17.0', null);
  try {
    assert.throws(f.restore, /DEPENDENCY_LOCK_MISSING/);
    assert.equal(existsSync(f.argv), false);
  } finally {rmSync(f.root, {recursive: true, force: true});}
});

test('dependency restore fails when the installer changes the lockfile or package.json', () => {
  for (const [file, name] of [['pnpm-lock.yaml', 'lockfile'], ['package.json', 'manifest']]) {
    const f = depFixture('pnpm', '11.17.0', 'pnpm-lock.yaml', `echo changed >> "${file}"`);
    try {
      assert.throws(f.restore, new RegExp(`DEPENDENCY_LOCK_CHANGED: .*${file.replace('.', '\\.')}`), name);
      const evidence = JSON.parse(readFileSync(f.evidence, 'utf8'));
      assert.equal(evidence.status, 'FAIL'); assert.deepEqual(evidence.changed_files, [file]);
    } finally {rmSync(f.root, {recursive: true, force: true});}
  }
});

test('dependency restore reports a failing install with a redacted output tail', () => {
  const f = depFixture('npm', '10.9.0', 'package-lock.json', 'echo "fetch https://user:hunter2@registry.example/x _authToken=abc123" >&2; exit 3');
  try {
    assert.throws(f.restore, error => /DEPENDENCY_INSTALL_FAILED/.test(error.message) && !/hunter2|abc123/.test(error.message));
    const evidence = JSON.parse(readFileSync(f.evidence, 'utf8'));
    assert.equal(evidence.status, 'FAIL'); assert.equal(evidence.exit_code, 3);
    assert.doesNotMatch(evidence.output_tail, /hunter2|abc123/); assert.match(evidence.output_tail, /\*\*\*/);
  } finally {rmSync(f.root, {recursive: true, force: true});}
});

test('stage-cli prepare-environment accepts only the --dependencies flag', () => {
  const cli = join(import.meta.dirname, 'stage-cli.ts');
  const result = spawnSync(process.execPath, [cli, 'prepare-environment', 'm.json', '--bogus'], {encoding: 'utf8'});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /prepare-environment <manifest\.json> \[--dependencies\]/);
});
