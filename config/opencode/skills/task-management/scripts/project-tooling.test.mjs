import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkProjectTooling, executablePath, prepareProjectTooling, satisfies } from './project-tooling.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'project-tooling-'));
  const home = join(root, 'home'), project = join(root, 'project'), bin = join(home, '.local/bin');
  mkdirSync(bin, {recursive: true}); mkdirSync(project);
  symlinkSync(process.execPath, join(bin, 'node'));
  writeFileSync(join(project, 'package.json'), JSON.stringify({packageManager: 'pnpm@11.17.0', engines: {node: '>=22', pnpm: '>=11'}}));
  return {root, home, project, bin, env: {...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin`}};
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
    f.env.PATH += ':' + global;
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
