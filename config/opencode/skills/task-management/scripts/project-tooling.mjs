import { accessSync, constants, lstatSync, readFileSync, realpathSync, mkdirSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

export function executablePath(exe, env = process.env) {
  if (isAbsolute(exe) || exe.includes('/')) throw new Error(`EXECUTABLE_INVALID: ${exe}`);
  let failure;
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    const file = join(directory || '.', exe);
    try {
      const stat = lstatSync(file);
      try { realpathSync(file); }
      catch (error) { failure ??= `EXECUTABLE_BROKEN_SYMLINK: ${file} (${error.code})`; continue; }
      try { accessSync(file, constants.X_OK); }
      catch (error) { failure ??= `EXECUTABLE_NOT_ACCESSIBLE: ${file} (${error.code})`; continue; }
      if (!stat.isFile() && !stat.isSymbolicLink()) { failure ??= `EXECUTABLE_INVALID: ${file}`; continue; }
      return file;
    } catch (error) {
      if (error.code !== 'ENOENT') failure ??= `EXECUTABLE_NOT_ACCESSIBLE: ${file} (${error.code})`;
    }
  }
  throw new Error(failure ?? `EXECUTABLE_NOT_FOUND: ${exe} is absent from runtime PATH`);
}

function run(exe, args, cwd, env, timeout = 30000) {
  const result = spawnSync(exe, args, {cwd, env, encoding: 'utf8', shell: false, timeout, maxBuffer: 1024 * 1024});
  if (result.error || result.status !== 0) {
    // Do not print package-manager stderr: it can contain registry credentials.
    throw new Error(`EXECUTABLE_START_FAILED: ${exe} (${result.error?.code ?? result.status})`);
  }
  return result.stdout.trim();
}

function tuple(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.replace(/^v/, ''));
  if (!match) throw new Error(`VERSION_FORMAT_UNSUPPORTED: ${value}`);
  return match.slice(1).map(Number);
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

export function satisfies(version, range) {
  const actual = tuple(version);
  // Engine grammar is intentionally bounded. Unsupported clauses BLOCK instead
  // of silently allowing an incompatible Node/package manager.
  return range.split('||').some(branch => {
    const clauses = branch.trim().replace(/,/g, ' ').match(/(?:>=|<=|>|<|=|\^|~)?\s*\d+(?:\.(?:\d+|x|\*)){0,2}/g);
    if (!clauses || branch.replace(/,/g, ' ').replace(/(?:>=|<=|>|<|=|\^|~)?\s*\d+(?:\.(?:\d+|x|\*)){0,2}/g, '').trim()) {
      throw new Error(`ENGINE_RANGE_UNSUPPORTED: ${range}`);
    }
    return clauses.every(clause => {
      const match = /^(>=|<=|>|<|=|\^|~)?\s*(.*)$/.exec(clause);
      const parts = match[2].split('.');
      const bound = parts.map(p => /^\d+$/.test(p) ? Number(p) : 0);
      while (bound.length < 3) bound.push(0);
      const c = compare(actual, bound);
      switch (match[1]) {
        case '>=': return c >= 0; case '<=': return c <= 0;
        case '>': return c > 0; case '<': return c < 0;
        case '^': {
          const pivot = bound.findIndex(v => v !== 0);
          const upper = [...bound]; const i = pivot < 0 ? 2 : pivot;
          upper[i]++; for (let j = i + 1; j < 3; j++) upper[j] = 0;
          return c >= 0 && compare(actual, upper) < 0;
        }
        case '~': return c >= 0 && actual[0] === bound[0] && (parts.length < 2 || actual[1] === bound[1]);
        default: return parts.every((p, i) => p === '*' || p === 'x' || actual[i] === Number(p));
      }
    });
  });
}

export function packageContract(cwd) {
  let pkg;
  try { pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!pkg.packageManager) return null;
  const match = /^(pnpm|npm|yarn|bun)@(\d+\.\d+\.\d+)(\+sha(?:224|256|384|512)\.[a-f0-9]+)?$/.exec(pkg.packageManager);
  if (!match) throw new Error('PACKAGE_MANAGER_PIN_REQUIRED: packageManager must specify an exact supported version');
  return {manager: match[1], version: match[2], spec: pkg.packageManager, engines: pkg.engines ?? {}};
}

export function checkProjectTooling(cwd, env = process.env) {
  const contract = packageContract(cwd);
  if (!contract) return {status: 'PASS', package_manager: null};
  const node = run(executablePath('node', env), ['--version'], cwd, env);
  if (contract.engines.node && !satisfies(node, contract.engines.node)) throw new Error(`NODE_VERSION_MISMATCH: ${node} does not satisfy ${contract.engines.node}`);
  const exe = executablePath(contract.manager, env);
  const actual = run(exe, ['--version'], cwd, env);
  if (actual !== contract.version) throw new Error(`PACKAGE_MANAGER_VERSION_MISMATCH: ${contract.manager} expected=${contract.version} actual=${actual}`);
  if (contract.engines[contract.manager] && !satisfies(actual, contract.engines[contract.manager])) throw new Error('PACKAGE_MANAGER_ENGINE_MISMATCH');
  return {status: 'PASS', package_manager: contract.manager, version: actual, executable: exe, node_version: node};
}

export function prepareProjectTooling(cwd, {home = homedir(), env = process.env} = {}) {
  const contract = packageContract(cwd);
  if (!contract) return {status: 'PASS', package_manager: null};
  if (process.getuid?.() === 0) throw new Error('RUNTIME_USER_REQUIRED: prepare tooling as opencode');
  // The service PATH is explicit; do not report success using a private PATH
  // that future gates cannot inherit.
  const userBin = join(home, '.local/bin');
  if (!(env.PATH ?? '').split(delimiter).includes(userBin)) throw new Error('RUNTIME_PATH_MISSING_USER_BIN: restart runtime with managed PATH');
  try { return checkProjectTooling(cwd, env); } catch (error) {
    if (!/^(EXECUTABLE_|PACKAGE_MANAGER_VERSION_MISMATCH)/.test(error.message)) throw error;
  }
  const node = run(executablePath('node', env), ['--version'], cwd, env);
  if (contract.engines.node && !satisfies(node, contract.engines.node)) throw new Error('NODE_VERSION_MISMATCH');
  if (contract.manager === 'bun') throw new Error('BUN_BOOTSTRAP_REQUIRED: use the pinned Bun installer');
  mkdirSync(userBin, {recursive: true});
  const cache = join(home, '.local/share/my-opencode/package-managers', `${contract.manager}-${contract.version}`);
  if (!existsSync(join(cache, 'bin', contract.manager))) {
    mkdirSync(cache, {recursive: true});
    // pnpm/npm have exact npm packages. Yarn modern releases use Corepack.
    if (contract.manager === 'yarn' || contract.spec.includes('+sha')) {
      const corepack = executablePath('corepack', env);
      run(corepack, ['enable', '--install-directory', userBin, contract.manager], cwd, env);
      run(corepack, ['prepare', contract.spec, '--activate'], cwd, {...env, COREPACK_HOME: join(home, '.cache/node/corepack')}, 120000);
      // Ensure the activation cache is the same in later runtime invocations.
      return checkProjectTooling(cwd, {...env, COREPACK_HOME: join(home, '.cache/node/corepack')});
    }
    const tmp = `${cache}.staging-${process.pid}`;
    try {
      const npm = executablePath('npm', env);
      const engines = JSON.parse(run(npm, ['view', `${contract.manager}@${contract.version}`, 'engines', '--json'], cwd, env, 120000) || '{}');
      if (engines.node && !satisfies(node, engines.node)) throw new Error(`NODE_VERSION_MISMATCH: ${contract.manager} requires ${engines.node}`);
      run(npm, ['install', '--global', '--prefix', tmp, '--ignore-scripts', '--no-audit', '--no-fund', `${contract.manager}@${contract.version}`], cwd, env, 120000);
      run(join(tmp, 'bin', contract.manager), ['--version'], cwd, env);
      rmSync(cache, {recursive: true, force: true});
      renameSync(tmp, cache);
    } finally { rmSync(tmp, {recursive: true, force: true}); }
  }
  // A single launcher resolves each project's exact cached version. Preparing
  // another PLAN cannot silently change an already running project's pnpm.
  const launcher = join(userBin, contract.manager);
  const temporary = `${launcher}.tmp-${process.pid}`;
  const source = `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const manager=${JSON.stringify(contract.manager)},root=${JSON.stringify(join(home, '.local/share/my-opencode/package-managers'))};
let dir=process.cwd(),version=${JSON.stringify(contract.version)};
while(true){
 const file=path.join(dir,'package.json');
 if(fs.existsSync(file)){
  const pkg=JSON.parse(fs.readFileSync(file,'utf8'));
  if(pkg.packageManager){
   const match=/^(pnpm|npm|yarn|bun)@(\\d+\\.\\d+\\.\\d+)(?:\\+sha(?:224|256|384|512)\\.[a-f0-9]+)?$/.exec(pkg.packageManager);
   if(!match||match[1]!==manager){console.error('PACKAGE_MANAGER_CONTRACT_MISMATCH');process.exit(1)}
   version=match[2];
  }
  break;
 }
 const parent=path.dirname(dir);if(parent===dir)break;dir=parent;
}
const exe=path.join(root,manager+'-'+version,'bin',manager);
if(!fs.existsSync(exe)){console.error('PACKAGE_MANAGER_CACHE_MISSING: prepare-environment first');process.exit(1)}
const result=cp.spawnSync(exe,process.argv.slice(2),{stdio:'inherit',env:process.env});
if(result.error){console.error('PACKAGE_MANAGER_START_FAILED');process.exit(1)}
process.exit(result.status??1);
`;
  writeFileSync(temporary, source, {mode: 0o755});
  renameSync(temporary, launcher);
  return checkProjectTooling(cwd, env);
}
