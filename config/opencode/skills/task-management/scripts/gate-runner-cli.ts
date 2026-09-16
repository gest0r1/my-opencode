import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import process from 'node:process';

type PipelineSpec = {
  id: string;
  profile?: string;
  runtime_locks?: string[];
};

type Manifest = {
  run_id: string;
  pipelines: PipelineSpec[];
  gate_profiles?: Record<string, Record<string, string[]>>;
};

type State = {
  run_id: string;
  status: string;
  manifest_file?: string;
  manifest_sha256?: string;
};

type CandidateEvidence = {
  candidate_sha?: string;
};

class GateRunnerError extends Error {}

const DEFAULT_STATE_ROOT = '.tmp/pipelines';
const MAX_CAPTURE = 256 * 1024;
const SHA = /^[0-9a-f]{40}$/i;

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function safeRelativePath(value: string): boolean {
  return Boolean(value) && !value.startsWith('/') && !value.includes('\\') && !value.split('/').includes('..') && !value.split('/').includes('.git');
}

export function tokenizeCommand(command: string): string[] {
  if (!command.trim() || /[\n\r\0]/.test(command)) throw new GateRunnerError('empty or multiline command is not allowed');
  if (/[;&|<>`]/.test(command) || /\$\(/.test(command)) {
    throw new GateRunnerError('shell composition, redirects and substitution are forbidden');
  }

  const tokens: string[] = [];
  let current = '';
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const push = () => {
    if (current.length) tokens.push(current);
    current = '';
  };

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) push();
    else current += char;
  }
  if (escaped || quote) throw new GateRunnerError('unterminated escape or quote');
  push();
  if (tokens.length === 0) throw new GateRunnerError('command has no executable');
  return tokens;
}

function isRuntimeGate(gate: string): boolean {
  return /(runtime|deploy|release|smoke|install)/i.test(gate);
}

function assertSafeInvocation(tokens: string[], gate: string): void {
  const [exe, ...args] = tokens;
  if (!exe) throw new GateRunnerError('missing executable');

  if (exe === 'bash') {
    if (args[0] === '-n' && args.length >= 2 && safeRelativePath(args[1] as string)) return;
    if (isRuntimeGate(gate) && args.length >= 1 && safeRelativePath(args[0] as string) && !args[0]?.startsWith('-')) return;
    throw new GateRunnerError('bash is allowed only for -n checks or an approved repository script in a runtime gate');
  }

  if (exe === 'pytest') return;
  if ((exe === 'python' || exe === 'python3') && args[0] === '-m' && args[1] === 'pytest') return;
  if (exe === 'tsc' || exe === 'mypy') return;
  if (exe === 'npx' && (args[0] === '--yes' ? ['tsc', 'vitest', 'jest'].includes(args[1] ?? '') : ['tsc', 'vitest', 'jest'].includes(args[0] ?? ''))) return;
  if (exe === 'npm' && (args[0] === 'test' || (args[0] === 'run' && ['test', 'build', 'typecheck', 'lint'].includes(args[1] ?? '')))) return;
  if (exe === 'pnpm' && (args[0] === 'test' || (args[0] === 'run' && ['test', 'build', 'typecheck', 'lint'].includes(args[1] ?? '')) || (args[0] === 'exec' && ['tsc', 'vitest'].includes(args[1] ?? '')))) return;
  if (exe === 'corepack' && args[0] === 'pnpm') return assertSafeInvocation(['pnpm', ...args.slice(1)], gate);
  if (exe === 'yarn' && ['test', 'build', 'lint'].includes(args[0] ?? '')) return;
  if (exe === 'bun' && args[0] === 'test') return;
  if (exe === 'go' && ['test', 'build'].includes(args[0] ?? '')) return;
  if (exe === 'cargo' && ['test', 'check', 'build'].includes(args[0] ?? '')) return;

  if (exe === 'docker') {
    if (args[0] === 'pull' || args[0] === 'inspect' || (args[0] === 'image' && args[1] === 'inspect')) return;
    if (args[0] === 'compose') {
      const subcommands = new Set(['config', 'ps', 'build', 'pull', 'up', 'restart']);
      const subcommand = args.find((arg) => subcommands.has(arg));
      if (subcommand === 'config' || subcommand === 'ps' || subcommand === 'pull') return;
      if (isRuntimeGate(gate) && (subcommand === 'build' || subcommand === 'up' || subcommand === 'restart')) return;
    }
    throw new GateRunnerError('docker invocation is outside the safe gate policy');
  }

  if (exe === 'curl') {
    const forbidden = new Set(['-o', '--output', '-O', '--remote-name', '-d', '--data', '--data-raw', '-T', '--upload-file', '-X', '--request']);
    if (args.some((arg) => forbidden.has(arg))) throw new GateRunnerError('curl mutation/output options are forbidden');
    if (args.some((arg) => /^https?:\/\//.test(arg))) return;
  }

  throw new GateRunnerError(`executable is outside the deterministic gate policy: ${exe}`);
}

async function executableAvailable(executable: string): Promise<boolean> {
  if (executable.includes('/') || executable.includes('\\')) {
    try {
      await access(resolve(executable), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = resolve(directory || '.', executable);
    try {
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      // Continue through PATH.
    }
  }
  return false;
}

async function validateManifestExecutability(manifest: Manifest): Promise<{ command_count: number; executables: string[] }> {
  if (!manifest || typeof manifest !== 'object') throw new GateRunnerError('manifest must be an object');
  if (!Array.isArray(manifest.pipelines)) throw new GateRunnerError('manifest pipelines must be an array');

  const profiles = new Set(
    manifest.pipelines
      .map((pipeline) => pipeline.profile)
      .filter((profile): profile is string => typeof profile === 'string' && profile.length > 0),
  );
  const checkedExecutables = new Map<string, boolean>();
  let commandCount = 0;

  for (const profile of profiles) {
    const gates = manifest.gate_profiles?.[profile];
    if (!gates || typeof gates !== 'object') {
      throw new GateRunnerError(`referenced gate profile is missing: ${profile}`);
    }

    for (const [gate, commands] of Object.entries(gates)) {
      if (!Array.isArray(commands) || commands.length === 0) {
        throw new GateRunnerError(`gate profile has no executable commands: profile=${profile} gate=${gate}`);
      }
      for (const command of commands) {
        if (typeof command !== 'string') {
          throw new GateRunnerError(`gate command must be a string: profile=${profile} gate=${gate}`);
        }
        const tokens = tokenizeCommand(command);
        assertSafeInvocation(tokens, gate);
        const executable = tokens[0] as string;
        if (!checkedExecutables.has(executable)) {
          checkedExecutables.set(executable, await executableAvailable(executable));
        }
        if (!checkedExecutables.get(executable)) {
          throw new GateRunnerError(`required executable is unavailable: ${executable}; profile=${profile} gate=${gate}`);
        }
        commandCount += 1;
      }
    }
  }

  return {
    command_count: commandCount,
    executables: [...checkedExecutables.keys()].sort(),
  };
}

function substituteCandidate(tokens: string[], candidateSha?: string): string[] {
  if (!tokens.some((token) => token.includes('{candidate_sha}'))) return tokens;
  if (!candidateSha || !SHA.test(candidateSha)) throw new GateRunnerError('candidate_sha placeholder used but candidate evidence is missing');
  return tokens.map((token) => token.replaceAll('{candidate_sha}', candidateSha));
}

async function runInvocation(exe: string, args: string[], cwd: string): Promise<{ exit_code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(exe, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_CAPTURE) stdout += String(chunk).slice(0, MAX_CAPTURE - stdout.length);
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_CAPTURE) stderr += String(chunk).slice(0, MAX_CAPTURE - stderr.length);
    });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ exit_code: code ?? 1, stdout, stderr }));
  });
}

function redact(value: string): string {
  return value
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/((?:token|password|secret|api[_-]?key)\s*[=:]\s*)[^\s]+/gi, '$1[REDACTED]');
}

async function loadCandidate(manifestFile: string): Promise<string | undefined> {
  try {
    const candidate = JSON.parse(await readFile(join(dirname(manifestFile), 'candidate.json'), 'utf8')) as CandidateEvidence;
    return candidate.candidate_sha;
  } catch {
    return undefined;
  }
}

async function acquireRuntimeLocks(stateRoot: string, runId: string, locks: string[]): Promise<() => Promise<void>> {
  if (locks.length === 0) return async () => undefined;
  const directory = join(resolve(stateRoot), '.runtime-locks');
  await mkdir(directory, { recursive: true });
  const acquired: string[] = [];
  try {
    for (const name of [...new Set(locks)].sort()) {
      const file = join(directory, `${sha256(name)}.lock`);
      const handle = await open(file, 'wx');
      await handle.writeFile(JSON.stringify({ lock: name, run_id: runId, pid: process.pid, acquired_at: new Date().toISOString() }));
      await handle.close();
      acquired.push(file);
    }
  } catch (error) {
    await Promise.all(acquired.map((file) => rm(file, { force: true })));
    throw new GateRunnerError(`runtime target is locked: ${String((error as Error)?.message ?? error)}`);
  }
  return async () => {
    await Promise.all(acquired.map((file) => rm(file, { force: true })));
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === 'validate-manifest') {
    const manifestPath = args[1];
    if (!manifestPath || args.length !== 2) {
      throw new GateRunnerError('usage: gate-runner-cli.ts validate-manifest <manifest.json>');
    }
    const manifest = JSON.parse(await readFile(resolve(manifestPath), 'utf8')) as Manifest;
    const details = await validateManifestExecutability(manifest);
    console.log(JSON.stringify({ status: 'PASS', gate: 'manifest_executability', manifest: resolve(manifestPath), ...details }));
    return;
  }

  const runId = args[0];
  const pipelineId = args[1];
  const gate = args[2];
  let stateRoot = DEFAULT_STATE_ROOT;
  const stateRootIndex = args.indexOf('--state-root');
  if (stateRootIndex >= 0) stateRoot = args[stateRootIndex + 1] ?? DEFAULT_STATE_ROOT;
  if (!runId || !pipelineId || !gate) {
    throw new GateRunnerError('usage: gate-runner-cli.ts validate-manifest <manifest.json> | <run-id> <pipeline-id> <gate> [--state-root <path>]');
  }

  const stateFile = join(resolve(stateRoot), runId, 'state.json');
  const state = JSON.parse(await readFile(stateFile, 'utf8')) as State;
  if (state.run_id !== runId) throw new GateRunnerError('state run_id mismatch');
  if (!['approved', 'in_progress'].includes(state.status)) {
    throw new GateRunnerError(`run is not executable: status=${state.status}`);
  }
  if (!state.manifest_file || !state.manifest_sha256) {
    throw new GateRunnerError('run has no frozen manifest metadata; re-plan with current stage-cli');
  }

  const manifestContent = await readFile(state.manifest_file, 'utf8');
  if (sha256(manifestContent) !== state.manifest_sha256) throw new GateRunnerError('frozen manifest hash mismatch');
  const manifest = JSON.parse(manifestContent) as Manifest;
  if (manifest.run_id !== runId) throw new GateRunnerError('manifest run_id mismatch');
  const pipeline = manifest.pipelines.find((item) => item.id === pipelineId);
  if (!pipeline) throw new GateRunnerError(`pipeline not found: ${pipelineId}`);
  if (!pipeline.profile) throw new GateRunnerError(`pipeline has no gate profile: ${pipelineId}`);
  const commands = manifest.gate_profiles?.[pipeline.profile]?.[gate];
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new GateRunnerError(`no executable gate commands: profile=${pipeline.profile} gate=${gate}`);
  }

  const candidateSha = await loadCandidate(state.manifest_file);
  const invocations = commands.map((command) => {
    const tokens = substituteCandidate(tokenizeCommand(command), candidateSha);
    assertSafeInvocation(tokens, gate);
    return { command, exe: tokens[0] as string, args: tokens.slice(1) };
  });

  const evidenceFile = join(resolve(stateRoot), runId, 'gates', `${pipelineId}-${gate}.json`);
  await mkdir(dirname(evidenceFile), { recursive: true });
  const releaseLocks = isRuntimeGate(gate) ? pipeline.runtime_locks ?? [] : [];
  const release = await acquireRuntimeLocks(stateRoot, runId, releaseLocks);
  const results: Array<Record<string, unknown>> = [];
  try {
    for (const invocation of invocations) {
      const startedAt = new Date().toISOString();
      const result = await runInvocation(invocation.exe, invocation.args, process.cwd());
      results.push({
        command: invocation.command,
        executable: invocation.exe,
        argv: invocation.args,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        exit_code: result.exit_code,
        stdout: redact(result.stdout),
        stderr: redact(result.stderr),
        stdout_sha256: sha256(result.stdout),
        stderr_sha256: sha256(result.stderr),
      });
      if (result.exit_code !== 0) {
        await writeFile(evidenceFile, `${JSON.stringify({ status: 'FAIL', run_id: runId, pipeline_id: pipelineId, gate, runtime_locks: releaseLocks, results }, null, 2)}\n`, 'utf8');
        throw new GateRunnerError(`gate command failed (${result.exit_code}): ${invocation.command}; evidence=${evidenceFile}`);
      }
    }

    await writeFile(
      evidenceFile,
      `${JSON.stringify({ status: 'PASS', run_id: runId, pipeline_id: pipelineId, gate, runtime_locks: releaseLocks, candidate_sha: candidateSha ?? null, results }, null, 2)}\n`,
      'utf8',
    );
  } finally {
    await release();
  }
  console.log(JSON.stringify({ status: 'PASS', gate, pipeline_id: pipelineId, candidate_sha: candidateSha ?? null, evidence: evidenceFile }));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`BLOCKED: gate_runner: ${message}`);
  process.exitCode = 1;
});
