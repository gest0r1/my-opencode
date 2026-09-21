import { readFileSync, accessSync, constants } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';

export class ManifestPreflightError extends Error {}

// Only stages executed by gate-runner require profiles. Implementation, human review,
// Git scope verification and candidate publication use their own deterministic tools.
const MACHINE_STAGE = /(?:^|[-_])(test|tests|pytest|build|lint|typecheck|type-check|runtime|deploy|release|smoke|install|unit|e2e|scan|gates?)(?:$|[-_])/i;
const RUNTIME_GATE = /(runtime|deploy|release|smoke|install)/i;
const SAFE_SHA = /^[0-9a-f]{40}$/i;

export function tokenizeGateCommand(command) {
  if (typeof command !== 'string' || !command.trim() || /[\n\r\0]/.test(command)) {
    throw new ManifestPreflightError('empty or multiline gate command is forbidden');
  }
  if (/[;&|<>`]/.test(command) || /\$\(/.test(command)) {
    throw new ManifestPreflightError('shell composition, redirects and substitution are forbidden');
  }
  const tokens = [];
  let current = '';
  let quote;
  let escaped = false;
  const push = () => { if (current) tokens.push(current); current = ''; };
  for (const char of command) {
    if (escaped) { current += char; escaped = false; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = undefined; else current += char; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (/\s/.test(char)) push(); else current += char;
  }
  if (escaped || quote) throw new ManifestPreflightError('unterminated escape or quote');
  push();
  if (!tokens.length) throw new ManifestPreflightError('gate command has no executable');
  return tokens;
}

function safeRelativePath(value) {
  return Boolean(value) && !value.startsWith('/') && !value.includes('\\') &&
    !value.split('/').some((part) => part === '..' || part === '.git');
}

// Mirror gate-runner's allowlist, but never execute a gate during validation.
export function assertSafeGateInvocation(tokens, gate) {
  const [exe, ...args] = tokens;
  if (exe === 'bash') {
    if (args[0] === '-n' && args.length >= 2 && safeRelativePath(args[1])) return;
    if (RUNTIME_GATE.test(gate) && args.length >= 1 && safeRelativePath(args[0]) && !args[0].startsWith('-')) return;
    throw new ManifestPreflightError('bash is allowed only for -n or a repository script in runtime gate');
  }
  if (exe === 'pytest') return;
  if ((exe === 'python' || exe === 'python3') && args[0] === '-m' && args[1] === 'pytest') return;
  if (exe === 'tsc' || exe === 'mypy') return;
  if (exe === 'npx' && (args[0] === '--yes' ? ['tsc', 'vitest', 'jest'].includes(args[1]) : ['tsc', 'vitest', 'jest'].includes(args[0]))) return;
  if (exe === 'npm' && (args[0] === 'test' || (args[0] === 'run' && ['test', 'build', 'typecheck', 'lint'].includes(args[1])))) return;
  if (exe === 'pnpm' && (args[0] === 'test' || (args[0] === 'run' && ['test', 'build', 'typecheck', 'lint'].includes(args[1])) || (args[0] === 'exec' && ['tsc', 'vitest'].includes(args[1])))) return;
  if (exe === 'corepack' && args[0] === 'pnpm') return assertSafeGateInvocation(['pnpm', ...args.slice(1)], gate);
  if (exe === 'yarn' && ['test', 'build', 'lint'].includes(args[0])) return;
  if (exe === 'bun' && args[0] === 'test') return;
  if (exe === 'go' && ['test', 'build'].includes(args[0])) return;
  if (exe === 'cargo' && ['test', 'check', 'build'].includes(args[0])) return;
  if (exe === 'docker') {
    if (args[0] === 'pull' || args[0] === 'inspect' || (args[0] === 'image' && args[1] === 'inspect')) return;
    if (args[0] === 'compose') {
      const subcommands = new Set(['config', 'ps', 'build', 'pull', 'up', 'restart']);
      const command = args.find((arg) => subcommands.has(arg));
      if (['config', 'ps', 'pull'].includes(command)) return;
      if (RUNTIME_GATE.test(gate) && ['build', 'up', 'restart'].includes(command)) return;
    }
    throw new ManifestPreflightError('docker invocation is outside the safe gate policy');
  }
  if (exe === 'curl') {
    const forbidden = new Set(['-o', '--output', '-O', '--remote-name', '-d', '--data', '--data-raw', '-T', '--upload-file', '-X', '--request']);
    if (args.some((arg) => forbidden.has(arg))) throw new ManifestPreflightError('curl mutation/output options are forbidden');
    if (args.some((arg) => /^https?:\/\//.test(arg))) return;
  }
  throw new ManifestPreflightError(`executable is outside deterministic gate policy: ${exe}`);
}

function executableOnPath(exe) {
  if (isAbsolute(exe) || exe.includes('/')) return false;
  return (process.env.PATH ?? '').split(delimiter).some((directory) => {
    try { accessSync(join(directory || '.', exe), constants.X_OK); return true; }
    catch { return false; }
  });
}

function checkPython(tokens, cwd) {
  const exe = tokens[0];
  if (!['python', 'python3', 'pytest'].includes(exe)) return;
  const args = exe === 'pytest' ? ['--version'] : ['-m', 'pytest', '--version'];
  const result = spawnSync(exe, args, { cwd, shell: false, encoding: 'utf8', timeout: 15000, maxBuffer: 64 * 1024 });
  if (result.error || result.status !== 0) {
    const reason = result.error?.code || String(result.stderr || result.error?.message || result.status).trim().slice(0, 300);
    throw new ManifestPreflightError(`PYTHON_ENV_NOT_READY: ${exe} cannot run pytest (${reason}). Install interpreter, pytest and project dependencies in the runner environment before approval`);
  }
}

export function validateGateManifest(manifest, { environment = false, cwd = process.cwd() } = {}) {
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.pipelines)) {
    throw new ManifestPreflightError('manifest.pipelines must be an array');
  }
  const profiles = manifest.gate_profiles ?? {};
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) {
    throw new ManifestPreflightError('gate_profiles must be an object');
  }
  const invocations = [];
  for (const pipeline of manifest.pipelines) {
    const machineStages = (pipeline.stages ?? []).filter((stage) => typeof stage === 'string' && MACHINE_STAGE.test(stage));
    if (machineStages.length && (!pipeline.profile || typeof pipeline.profile !== 'string')) {
      throw new ManifestPreflightError(`pipeline has no gate profile: ${pipeline.id} (machine stages: ${machineStages.join(', ')})`);
    }
    if (pipeline.profile !== undefined) {
      const gates = profiles[pipeline.profile];
      if (!gates || typeof gates !== 'object' || Array.isArray(gates) || !Object.keys(gates).length) {
        throw new ManifestPreflightError(`gate profile is missing or empty: ${pipeline.id}/${String(pipeline.profile)}`);
      }
      for (const stage of machineStages) {
        if (!Array.isArray(gates[stage]) || gates[stage].length === 0) {
          throw new ManifestPreflightError(`MACHINE_GATE_MISSING: gate_profiles.${pipeline.profile}.${stage} must contain commands; gate key must match stage ID`);
        }
      }
    }
  }
  for (const [profile, gates] of Object.entries(profiles)) {
    if (!gates || typeof gates !== 'object' || Array.isArray(gates)) {
      throw new ManifestPreflightError(`gate_profiles.${profile} must be an object`);
    }
    for (const [gate, commands] of Object.entries(gates)) {
      if (!Array.isArray(commands) || commands.length === 0) {
        throw new ManifestPreflightError(`gate_profiles.${profile}.${gate} must be a nonempty command array`);
      }
      for (const command of commands) {
        const tokens = tokenizeGateCommand(command);
        assertSafeGateInvocation(tokens, gate);
        if (tokens.some((token) => token.includes('{candidate_sha}')) && !RUNTIME_GATE.test(gate)) {
          throw new ManifestPreflightError(`candidate_sha may only occur in runtime gate: ${profile}/${gate}`);
        }
        invocations.push({ profile, gate, tokens });
      }
    }
  }
  if (environment) {
    const used = new Set(manifest.pipelines.map((pipeline) => pipeline.profile).filter(Boolean));
    for (const { profile, gate, tokens } of invocations) {
      if (!used.has(profile)) continue;
      if (!executableOnPath(tokens[0])) {
        throw new ManifestPreflightError(`EXECUTABLE_NOT_FOUND: ${tokens[0]} for ${profile}/${gate} is absent from runner PATH`);
      }
      checkPython(tokens, cwd);
    }
  }
  return { status: 'PASS', checked_commands: invocations.length, environment_checked: environment };
}

export async function preflightFile(path, options = {}) {
  const raw = await readFile(path, 'utf8');
  return validateGateManifest(JSON.parse(raw), options);
}
