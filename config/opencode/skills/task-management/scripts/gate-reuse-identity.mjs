import { createHash } from 'node:crypto';
import { accessSync, constants, createReadStream, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { packageContract } from './project-tooling.mjs';

const IDENTITY_VERSION = 'gate-reuse-identity-v2';
const VOLATILE_ENV = new Set(['PIPELINE_RUN_ID', 'PIPELINE_ID', 'PIPELINE_GATE', 'PIPELINE_GATE_ATTEMPT', 'PIPELINE_SCRATCH_DIR']);
const SKIP_DIRS = new Set(['.git', '.tmp', 'dist', 'build', 'coverage', '.next', '.turbo', '.cache', '.vite', 'out']);

function findExecutable(name, env) {
  if (!name || isAbsolute(name) || name.includes('/')) throw new Error(`executable path is not PATH-resolvable: ${name || '(empty)'}`);
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    const candidate = join(directory || '.', name);
    try {
      const info = lstatSync(candidate);
      if (!info.isFile() && !info.isSymbolicLink()) continue;
      accessSync(candidate, constants.X_OK);
      return resolve(candidate);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error(`executable is absent from PATH: ${name}`);
}

function hashFile(path) {
  const hash = createHash('sha256');
  let bytes = 0;
  return new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('data', chunk => { bytes += chunk.length; hash.update(chunk); });
    stream.on('error', reject);
    stream.on('end', () => resolvePromise({ digest: hash.digest('hex'), bytes }));
  });
}

async function hashPath(root, label, records, visited = new Set(), fileDigests = new Map(), stats = { files: 0, bytes: 0 }) {
  const lexical = resolve(root);
  const real = realpathSync(lexical);
  const info = lstatSync(lexical);
  const mode = info.mode & 0o111 ? '755' : '644';
  if (info.isSymbolicLink()) {
    const target = readlinkSync(lexical);
    records.push([label, 'symlink', target, real]);
    if (!visited.has(real)) await hashPath(real, `${label}=>${real}`, records, visited, fileDigests, stats);
    return;
  }
  if (info.isDirectory()) {
    if (visited.has(real)) { records.push([label, 'directory-alias', real]); return; }
    visited.add(real);
    records.push([label, 'directory', mode, real]);
    for (const name of readdirSync(lexical).sort()) await hashPath(join(lexical, name), `${label}/${name}`, records, visited, fileDigests, stats);
    return;
  }
  if (!info.isFile()) throw new Error(`unsupported filesystem entry: ${label}`);
  if (visited.has(real)) { records.push([label, 'file-alias', real]); return; }
  visited.add(real);
  const key = `${info.dev}:${info.ino}`;
  let digest = fileDigests.get(key);
  if (!digest) {
    const hashed = await hashFile(lexical);
    digest = hashed.digest;
    fileDigests.set(key, digest);
    stats.bytes += hashed.bytes;
  }
  stats.files += 1;
  records.push([label, 'file', mode, real, info.size, digest]);
}

function packageNameAt(file, wanted) {
  let directory = dirname(file);
  while (true) {
    const packageFile = join(directory, 'package.json');
    try {
      const manifest = JSON.parse(readFileSync(packageFile, 'utf8'));
      if (manifest.name === wanted) return directory;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function managerManifest(root, manager, version) {
  if (!root) return null;
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); }
  catch { return null; }
  return manifest.name === manager && manifest.version === version ? root : null;
}

function corepackManagerRoot(env, manager, version) {
  const home = env.COREPACK_HOME || join(env.HOME || homedir(), '.cache', 'node', 'corepack');
  const root = join(home, 'v1', manager, version);
  return managerManifest(root, manager, version);
}

function cachedManagerRoot(env, manager, version) {
  const root = join(env.HOME || homedir(), '.local', 'share', 'my-opencode', 'package-managers', `${manager}-${version}`);
  const executable = join(root, 'bin', manager);
  try { accessSync(executable, constants.X_OK); } catch { return null; }
  return managerManifest(root, manager, version);
}

function localExecTool(cwd, name) {
  if (!/^(?:vitest|tsc|eslint)$/.test(name ?? '')) throw new Error('pnpm exec tool is outside the bounded local tool list');
  // GateRunner runs from the verified project root; do not search external ancestors whose dependency
  // trees are outside this identity's read-set.
  const candidate = join(resolve(cwd), 'node_modules', '.bin', name);
  try {
    lstatSync(candidate);
    accessSync(candidate, constants.X_OK);
    const real = realpathSync(candidate);
    if (!lstatSync(real).isFile()) throw new Error('resolved local tool is not a regular file');
    return candidate;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`local pnpm exec tool ${name} is not executable`);
  }
  throw new Error(`pnpm exec tool ${name} has no project-root node_modules/.bin executable`);
}

async function managerReadset({ invocation, cwd, env, records, visited, fileDigests, stats }) {
  const command = invocation.exe;
  let manager;
  if (command === 'pnpm') { manager = 'pnpm'; }
  else if (command === 'corepack' && invocation.args[0] === 'pnpm') { manager = 'pnpm'; }
  else return null;

  const managerArgs = command === 'corepack' ? invocation.args.slice(1) : invocation.args;
  if (managerArgs[0] !== 'exec' || !['vitest', 'tsc', 'eslint'].includes(managerArgs[1])) {
    throw new Error('pnpm reuse supports only the bounded exec vitest/tsc/eslint route');
  }
  const toolPath = localExecTool(cwd, managerArgs[1]);

  const contract = packageContract(cwd);
  if (!contract || contract.manager !== manager) throw new Error(`${manager} invocation has no matching exact packageManager declaration`);
  let projectPackage;
  try { projectPackage = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')); }
  catch { throw new Error('package manager manifest cannot be read'); }
  const declared = projectPackage.devEngines?.packageManager;
  if (declared && (declared.name !== manager || declared.version !== contract.version)) {
    throw new Error('devEngines.packageManager conflicts with the exact packageManager pin');
  }
  if (command === 'corepack') {
    for (const key of ['COREPACK_ENABLE_PROJECT_SPEC', 'COREPACK_ENABLE_STRICT']) {
      if (['0', 'false', 'no'].includes(String(env[key] ?? '').toLowerCase())) throw new Error(`${key} disables exact project manager routing`);
    }
    if (['1', 'true', 'yes'].includes(String(env.COREPACK_DEFAULT_TO_LATEST ?? '').toLowerCase())) {
      throw new Error('COREPACK_DEFAULT_TO_LATEST enables non-pinned manager routing');
    }
  }
  const launcher = findExecutable(command, env);
  const launcherReal = realpathSync(launcher);
  let managerRoot;
  if (command === 'corepack') managerRoot = corepackManagerRoot(env, manager, contract.version);
  else {
    managerRoot = packageNameAt(launcherReal, manager);
    if (!managerRoot) {
      const source = readFileSync(launcherReal, 'utf8');
      const relativeTarget = new RegExp(String.raw`\$\{SCRIPT_DIR\}/([^"'\s]*node_modules/${manager}/[^"'\s]+)`);
      const target = relativeTarget.exec(source)?.[1];
      if (target) managerRoot = packageNameAt(resolve(dirname(launcherReal), target), manager);
      if (!managerRoot) {
        const cached = cachedManagerRoot(env, manager, contract.version);
        if (cached && source.includes('package-managers') && source.includes(`${manager}-${contract.version}`)) managerRoot = cached;
      }
    }
  }
  if (!managerRoot || !managerManifest(managerRoot, manager, contract.version)) throw new Error(`cannot resolve actual ${manager}@${contract.version} package behind ${command} launcher`);
  records.push(['manager-contract', contract.spec]);
  await hashPath(launcher, `launcher:${command}`, records, visited, fileDigests, stats);
  await hashPath(managerRoot, `manager:${manager}@${contract.version}`, records, visited, fileDigests, stats);
  await hashPath(toolPath, `local-exec-tool:${managerArgs[1]}`, records, visited, fileDigests, stats);
  await managerConfigFiles(cwd, env, manager, records, visited, fileDigests, stats);
  return manager;
}

async function dependencyTrees(cwd, records, visited, fileDigests, stats) {
  const roots = [];
  const visit = (directory, depth = 0) => {
    if (depth > 32) throw new Error('project directory nesting exceeds supported limit');
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (entry.name === 'node_modules') {
        try { lstatSync(join(directory, entry.name)); roots.push(join(directory, entry.name)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        continue;
      }
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) visit(join(directory, entry.name), depth + 1);
    }
  };
  visit(cwd);
  if (!roots.length) throw new Error('project dependency tree is absent');
  for (const root of roots.sort()) await hashPath(root, `dependency-tree:${relative(cwd, root) || '.'}`, records, visited, fileDigests, stats);
}

async function managerConfigFiles(cwd, env, manager, records, visited, fileDigests, stats) {
  const names = manager === 'pnpm' ? ['.npmrc', '.pnpmfile.cjs', 'pnpm-workspace.yaml'] : ['.npmrc'];
  const roots = new Set([resolve(cwd), resolve(env.HOME || homedir())]);
  for (const start of roots) {
    let directory = start;
    while (true) {
      for (const name of names) {
        const file = join(directory, name);
        try { lstatSync(file); await hashPath(file, `manager-config:${file}`, records, visited, fileDigests, stats); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  if (manager === 'pnpm') {
    const file = join(env.HOME || homedir(), '.config/pnpm/rc');
    try { lstatSync(file); await hashPath(file, `manager-config:${file}`, records, visited, fileDigests, stats); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const routedConfig = new Map(Object.entries(env).filter(([, value]) => Boolean(value)).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of ['npm_config_userconfig', 'npm_config_globalconfig']) {
    const configured = routedConfig.get(key);
    if (!configured) continue;
    const expanded = configured.startsWith('~/') ? join(env.HOME || homedir(), configured.slice(2)) : configured;
    const file = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
    try { lstatSync(file); await hashPath(file, `manager-config:${key}`, records, visited, fileDigests, stats); }
    catch { throw new Error(`${key} points to an unreadable config file`); }
  }
}

async function externalModulePaths(env, records) {
  const unsupported = ['BASH_ENV', 'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONHOME', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES',
    'PNPM_HOME', 'npm_config_prefix', 'npm_config_node_options', 'npm_config_store_dir'];
  const envNames = new Map(Object.keys(env).map(key => [key.toLowerCase(), key]));
  const injected = unsupported.map(key => envNames.get(key.toLowerCase())).find(key => key && env[key]);
  if (injected) throw new Error(`${injected} points to execution inputs outside the bounded reuse read-set`);
}

function hashEnvironment(env) {
  const selected = Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined && !VOLATILE_ENV.has(key)).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(JSON.stringify(selected)).digest('hex');
}

export async function resolveReuseIdentity({ cwd, invocations, env, ignoredSnapshotFiles = [] }) {
  const records = [];
  const stats = { files: 0, bytes: 0 };
  const visited = new Set();
  const fileDigests = new Map();
  const started = performance.now();
  const metrics = () => ({ files: stats.files, bytes: stats.bytes, elapsed_ms: Math.round((performance.now() - started) * 1000) / 1000 });
  try {
    const environmentDigest = hashEnvironment(env);
    await externalModulePaths(env, records);
    // Snapshot preparation copies these ignored files (for example .env.local).
    // Their bytes are not in sourceInventory and must be part of reuse identity.
    // Paths are supplied by gate-snapshot's exact shared copiedIgnoredInputs().
    if (!Array.isArray(ignoredSnapshotFiles) || ignoredSnapshotFiles.some(file =>
        typeof file !== 'string' || !file || isAbsolute(file) || file.split('/').some(part => part === '..' || part === '.git'))) {
      throw new Error('ignored snapshot input paths are not safe');
    }
    for (const file of [...new Set(ignoredSnapshotFiles)].sort()) {
      await hashPath(join(resolve(cwd), file), `ignored-snapshot-input:${file}`, records, visited, fileDigests, stats);
    }
    const nodeFromPath = findExecutable('node', env);
    const nodeReal = realpathSync(nodeFromPath);
    if (nodeReal !== realpathSync(process.execPath)) throw new Error('PATH node differs from the gate runner Node runtime');
    await hashPath(nodeFromPath, 'node-runtime', records, visited, fileDigests, stats);
    let needsDependencies = false;
    for (const invocation of invocations) {
      const manager = await managerReadset({ invocation, cwd, env, records, visited, fileDigests, stats });
      const executable = findExecutable(invocation.exe, env);
      await hashPath(executable, `invocation:${invocation.exe}`, records, visited, fileDigests, stats);
      const bytes = readFileSync(executable);
      const shebang = bytes.subarray(0, 256).toString('utf8').split(/\r?\n/, 1)[0];
      const match = /^#!\s*\/usr\/bin\/env\s+([^\s]+)/.exec(shebang);
      if (match && match[1] !== 'env') await hashPath(findExecutable(match[1], env), `interpreter:${match[1]}`, records, visited, fileDigests, stats);
      if (manager) needsDependencies = true;
      else if (!['bash -n'].includes(`${invocation.exe} ${invocation.args[0] ?? ''}`)) throw new Error(`tool invocation has no bounded dependency identity: ${invocation.exe}`);
    }
    if (needsDependencies) await dependencyTrees(cwd, records, visited, fileDigests, stats);
    records.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    const readsetDigest = createHash('sha256').update(JSON.stringify(records)).digest('hex');
    return { digest: createHash('sha256').update(JSON.stringify([IDENTITY_VERSION, environmentDigest, readsetDigest])).digest('hex'), reason: null, metrics: metrics() };
  } catch (error) {
    return { digest: null, reason: String(error?.message ?? error).slice(0, 240), metrics: metrics() };
  }
}
