import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { gatePolicyError, tokenizeGateCommand } from './gate-command-policy.mjs';

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
const RUNTIME_GATE = /(runtime|deploy|release|smoke|install)/i;

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function safeRelativePath(value: string): boolean {
  return Boolean(value) && !value.startsWith('/') && !value.includes('\\') && !value.split('/').includes('..') && !value.split('/').includes('.git');
}

export function tokenizeCommand(command: string): string[] {
  try {
    return tokenizeGateCommand(command);
  } catch (error) {
    throw new GateRunnerError(error instanceof Error ? error.message : String(error));
  }
}

function assertSafeInvocation(tokens: string[], gate: string): void {
  const reason = gatePolicyError(tokens, gate);
  if (reason) throw new GateRunnerError(reason);
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
  const runId = args[0];
  const pipelineId = args[1];
  const gate = args[2];
  const advisory = args.includes('--advisory');
  let stateRoot = DEFAULT_STATE_ROOT;
  const stateRootIndex = args.indexOf('--state-root');
  if (stateRootIndex >= 0) stateRoot = args[stateRootIndex + 1] ?? DEFAULT_STATE_ROOT;
  if (!runId || !pipelineId || !gate) {
    throw new GateRunnerError('usage: gate-runner-cli.ts <run-id> <pipeline-id> <gate> [--state-root <path>] [--advisory]');
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
  let commands = manifest.gate_profiles?.[pipeline.profile]?.[gate];
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new GateRunnerError(`no executable gate commands: profile=${pipeline.profile} gate=${gate}`);
  }

  if (advisory && RUNTIME_GATE.test(gate)) throw new GateRunnerError('advisory checks cannot run runtime/deployment/install gates');
  const selection = args.indexOf('--command-index');
  if (selection >= 0) {
    const index = Number(args[selection + 1]);
    if (!advisory || !Number.isInteger(index) || index < 0 || index >= commands.length) throw new GateRunnerError('command-index requires an advisory check and a valid frozen command index');
    commands = [commands[index]];
  }
  const candidateSha = advisory ? undefined : await loadCandidate(state.manifest_file);
  const invocations = commands.map((command) => {
    const tokens = substituteCandidate(tokenizeCommand(command), candidateSha);
    assertSafeInvocation(tokens, gate);
    return { command, exe: tokens[0] as string, args: tokens.slice(1) };
  });

  const evidenceFile = join(resolve(stateRoot), runId, advisory ? 'checks' : 'gates', `${pipelineId}-${gate}.json`);
  await mkdir(dirname(evidenceFile), { recursive: true });
  const releaseLocks = RUNTIME_GATE.test(gate) ? pipeline.runtime_locks ?? [] : [];
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
        await writeFile(evidenceFile, `${JSON.stringify({ status: 'FAIL', purpose: advisory ? 'advisory' : 'authoritative', run_id: runId, pipeline_id: pipelineId, gate, runtime_locks: releaseLocks, results }, null, 2)}\n`, 'utf8');
        throw new GateRunnerError(`gate command failed (${result.exit_code}): ${invocation.command}; evidence=${evidenceFile}`);
      }
    }

    await writeFile(
      evidenceFile,
      `${JSON.stringify({ status: 'PASS', purpose: advisory ? 'advisory' : 'authoritative', run_id: runId, pipeline_id: pipelineId, gate, runtime_locks: releaseLocks, candidate_sha: candidateSha ?? null, results }, null, 2)}\n`,
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

