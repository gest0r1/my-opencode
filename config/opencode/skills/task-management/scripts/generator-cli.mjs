// Frozen project generators (`manifest.generators`): repository scripts that rebuild derived files
// such as test impact maps. PLAN declares the exact write/check commands and outputs; RUN executes
// them through `stage-cli generate`, so neither the owner nor an agent shell is needed.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tokenizeGateCommand } from './gate-command-policy.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SCRIPT = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/@-]+\.(?:ts|mts|mjs|js|cjs)$/;
const FLAG = /^--?[A-Za-z0-9][A-Za-z0-9-]*(?:=[A-Za-z0-9._/@:-]*)?$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;
const MAX_OUTPUT = 64 * 1024;

export function generatorCommandError(command) {
  let tokens;
  try { tokens = tokenizeGateCommand(command); } catch (error) { return String(error.message ?? error); }
  const [exe, ...args] = tokens;
  const rest = list => list.every(arg => FLAG.test(arg) || SCRIPT.test(arg) || NAME.test(arg)) ? undefined : 'generator arguments must be plain flags, names or repository script paths';
  if (exe === 'node') {
    const offset = args[0] === '--import' && args[1] === 'tsx' ? 2 : 0;
    if (!SCRIPT.test(args[offset] ?? '')) return 'node generators run a repository script (optionally with --import tsx)';
    return rest(args.slice(offset + 1));
  }
  if (exe === 'npx' && args[0] === 'tsx' && SCRIPT.test(args[1] ?? '')) return rest(args.slice(2));
  const runner = exe === 'corepack' && args[0] === 'pnpm' ? args.slice(1) : ['pnpm', 'npm', 'bun'].includes(exe) ? args : null;
  if (runner && runner[0] === 'run' && NAME.test(runner[1] ?? '')) return rest(runner.slice(2));
  return 'generators may run node/npx tsx repository scripts or a package.json script (pnpm/npm/bun run)';
}

const safeOutput = path => typeof path === 'string' && !path.startsWith('/') && !path.includes('..') &&
  !/^(?:\.git|\.github|\.opencode)(?:\/|$)/.test(path) && !/(?:^|\/)\.env/.test(path) &&
  /^[A-Za-z0-9._/@-]+(?:\/\*\*)?$/.test(path);

export function validateGenerators(manifest) {
  const generators = manifest.generators;
  if (generators === undefined) return;
  if (!Array.isArray(generators) || !generators.length) throw new Error('GENERATORS_INVALID: expected a nonempty array');
  const ids = new Set();
  for (const generator of generators) {
    if (!generator || !SAFE_ID.test(generator.id ?? '') || ids.has(generator.id)) throw new Error('GENERATORS_INVALID: each generator needs a unique safe id');
    ids.add(generator.id);
    if (Object.keys(generator).some(key => !['id', 'write', 'check', 'outputs'].includes(key))) throw new Error(`GENERATORS_INVALID: ${generator.id} has unknown keys`);
    for (const key of ['write', 'check']) {
      if (generator[key] === undefined && key === 'check') continue;
      const error = generatorCommandError(generator[key]);
      if (error) throw new Error(`GENERATORS_INVALID: ${generator.id}.${key}: ${error}`);
    }
    if (!Array.isArray(generator.outputs) || !generator.outputs.length || !generator.outputs.every(safeOutput)) {
      throw new Error(`GENERATORS_INVALID: ${generator.id}.outputs must list repository paths or directory/** outside .git, .github, .opencode and env files`);
    }
  }
}

export function generatorOutputs(manifest) {
  return (Array.isArray(manifest?.generators) ? manifest.generators : []).flatMap(generator => Array.isArray(generator?.outputs) ? generator.outputs : []);
}

function runCommand(command, cwd, timeoutSeconds) {
  const [exe, ...args] = tokenizeGateCommand(command);
  const started = Date.now();
  const result = spawnSync(exe, args, { cwd, shell: false, encoding: 'utf8', timeout: timeoutSeconds * 1000, maxBuffer: 16 * 1024 * 1024 });
  const cut = value => String(value ?? '').slice(-MAX_OUTPUT);
  return { command, exit_code: result.status ?? (result.error ? 127 : 1), duration_ms: Date.now() - started,
    stdout: cut(result.stdout), stderr: cut(result.stderr ?? result.error?.message) };
}

export function runGenerator({ stateRoot, runId, id, checkOnly = false, cwd = process.cwd(), timeoutSeconds = 900 }) {
  if (!SAFE_ID.test(runId ?? '') || !SAFE_ID.test(id ?? '')) throw new Error('usage: stage-cli generate <run-id> <generator-id> [--check-only]');
  const runDirectory = resolve(stateRoot, runId);
  const state = JSON.parse(readFileSync(join(runDirectory, 'state.json'), 'utf8'));
  const raw = readFileSync(state.manifest_file, 'utf8');
  if (createHash('sha256').update(raw).digest('hex') !== state.manifest_sha256) throw new Error('FROZEN_MANIFEST_CHANGED');
  const manifest = JSON.parse(raw);
  validateGenerators(manifest);
  const generator = (manifest.generators ?? []).find(item => item.id === id);
  if (!generator) throw new Error(`GENERATOR_UNKNOWN: ${id} is not frozen in this manifest`);
  const results = [];
  if (!checkOnly) results.push(runCommand(generator.write, cwd, timeoutSeconds));
  if (generator.check && results.every(item => item.exit_code === 0)) results.push(runCommand(generator.check, cwd, timeoutSeconds));
  const status = results.length && results.every(item => item.exit_code === 0) ? 'PASS' : 'FAIL';
  const evidence = { status, kind: 'generator', run_id: runId, generator: id, outputs: generator.outputs, check_only: checkOnly, recorded_at: new Date().toISOString(), results };
  mkdirSync(join(runDirectory, 'checks'), { recursive: true });
  const path = join(runDirectory, 'checks', `generate-${id}.json`);
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return { status, generator: id, evidence: path, failed: results.filter(item => item.exit_code !== 0).map(item => ({ command: item.command, exit_code: item.exit_code, stderr: item.stderr.slice(-2000) })) };
}
