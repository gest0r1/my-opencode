import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { gatePolicyError, tokenizeGateCommand } from './gate-command-policy.mjs';
import { validateGateTesting, selectAffectedCommands } from './gate-testing-policy.mjs';
import { createLivePostgres } from './live-postgres.mjs';
import { sourceSnapshot, readDiagnosticHypothesis, failureSummary, readTestReports } from './gate-diagnostics.mjs';

type PipelineSpec = {
  id: string;
  profile?: string;
  runtime_locks?: string[];
};

type Manifest = {
  run_id: string;
  pipelines: PipelineSpec[];
  gate_profiles?: Record<string, Record<string, string[]>>;
  gate_testing?: Record<string, Record<string, any>>;
  git_setup?: { base_sha: string };
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

let interrupted = false;
const activeChildren = new Set<ReturnType<typeof spawn>>();
function terminate(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch {}
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  interrupted = true;
  for (const child of activeChildren) terminate(child, 'SIGTERM');
});

async function runInvocation(exe: string, args: string[], cwd: string, env: Record<string, string> = {}, timeout = 1800, cleanup = false): Promise<{ exit_code: number; stdout: string; stderr: string; truncated: boolean }> {
  if (interrupted && !cleanup) throw new GateRunnerError('execution interrupted');
  return new Promise((resolvePromise, reject) => {
    const child = spawn(exe, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32' });
    activeChildren.add(child);
    let stdout = ''; let stderr = ''; let timedOut = false; let truncated = false;
    const timer = setTimeout(() => { timedOut = true; terminate(child, 'SIGTERM'); }, timeout * 1000);
    // Also bounds children which ignore TERM, including an interrupted test tree.
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const killLater = () => { killTimer ??= setTimeout(() => terminate(child, 'SIGKILL'), 3000); };
    const timeoutKill = setTimeout(killLater, timeout * 1000);
    const onInterrupt = () => { if (!cleanup) killLater(); };
    process.once('SIGINT', onInterrupt); process.once('SIGTERM', onInterrupt);
    child.stdout.on('data', chunk => { const value = String(chunk); truncated ||= stdout.length + value.length > MAX_CAPTURE; stdout += value.slice(0, Math.max(0, MAX_CAPTURE - stdout.length)); });
    child.stderr.on('data', chunk => { const value = String(chunk); truncated ||= stderr.length + value.length > MAX_CAPTURE; stderr += value.slice(0, Math.max(0, MAX_CAPTURE - stderr.length)); });
    const done = () => { clearTimeout(timer); clearTimeout(timeoutKill); if (killTimer) clearTimeout(killTimer); activeChildren.delete(child); process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onInterrupt); };
    child.on('error', error => { done(); reject(error); });
    child.on('close', code => { done(); resolvePromise({ exit_code: timedOut ? 124 : interrupted && !cleanup ? 130 : code ?? 1, stdout, stderr: stderr + (timedOut ? '\nCOMMAND_TIMEOUT' : ''), truncated }); });
  });
}

function redact(value: string): string {
  return value
    .replace(/(postgres(?:ql)?:\/\/)[^\s@]+@/gi, '$1[REDACTED]@')
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
  validateGateTesting(manifest);
  const config = manifest.gate_testing?.[pipeline.profile]?.[gate];
  const affected = args.includes('--affected');
  if (affected && !advisory) throw new GateRunnerError('affected tests are advisory only; final gates always run the full frozen set');
  const selection = args.indexOf('--command-index');
  let selected = commands.map((command, index) => ({ command, index, test_files: [] as string[] }));
  if (selection >= 0) {
    const index = Number(args[selection + 1]);
    if (!advisory || affected || !Number.isInteger(index) || index < 0 || index >= commands.length) throw new GateRunnerError('command-index requires an advisory check and a valid frozen command index');
    selected = [selected[index]];
  }
  const evidenceFile = join(resolve(stateRoot), runId, advisory ? 'checks' : 'gates', `${pipelineId}-${gate}.json`);
  await mkdir(dirname(evidenceFile), { recursive: true });
  let previous: any;
  try { previous = JSON.parse(await readFile(evidenceFile, 'utf8')); } catch {}
  const snapshot = advisory ? await sourceSnapshot(process.cwd(), manifest, (exe: string, argv: string[]) => runInvocation(exe, argv, process.cwd(), {}, 30)) : null;
  let selectionReason = 'full frozen set';
  if (affected) {
    const failures = (previous?.results ?? []).filter((result: any) => result.exit_code !== 0).map((result: any) => result.command_index);
    const impact = selectAffectedCommands(commands, config, snapshot?.changed, failures);
    selected = impact.selected; selectionReason = impact.reason;
  }
  const candidateSha = advisory ? undefined : await loadCandidate(state.manifest_file);
  const invocations = selected.map(item => {
    const tokens = substituteCandidate(tokenizeCommand(item.command), candidateSha);
    tokens.push(...item.test_files);
    assertSafeInvocation(tokens, gate);
    return { ...item, exe: tokens[0], args: tokens.slice(1) };
  });
  const hypothesisIndex = args.indexOf('--hypothesis');
  if (hypothesisIndex >= 0 && (!advisory || !args[hypothesisIndex + 1])) throw new GateRunnerError('hypothesis requires an advisory check and an evidence path');
  const hypothesis = hypothesisIndex < 0 ? null : await readDiagnosticHypothesis(args[hypothesisIndex + 1], join(resolve(stateRoot), runId));
  const environmentDigest = sha256(JSON.stringify([process.version, process.env.PATH, process.env.NODE_ENV, process.env.LIVE_PG_TEST, process.env.LIVE_PG_CONTOUR, process.env.DATABASE_URL]));
  const inputIdentity = snapshot?.digest ? sha256(JSON.stringify([snapshot.digest, state.manifest_sha256, environmentDigest])) : null;
  const fingerprint = inputIdentity ? sha256(JSON.stringify([inputIdentity, invocations])) : null;
  const ledgerFile = join(resolve(stateRoot), runId, 'checks', `${pipelineId}-${gate}-attempts.json`);
  const releaseLocks = [...(RUNTIME_GATE.test(gate) ? pipeline.runtime_locks ?? [] : []), `gate:${runId}:${pipelineId}:${gate}`];
  const release = await acquireRuntimeLocks(stateRoot, runId, releaseLocks);
  let ledger: any = { input_identity: inputIdentity, attempts: {} };
  let previousHypotheses: string[] = [];
  try {
    if (advisory && fingerprint) {
      try { const saved = JSON.parse(await readFile(ledgerFile, 'utf8')); if (saved.input_identity === inputIdentity) ledger = saved; } catch {}
      const prior = ledger.attempts[fingerprint];
      previousHypotheses = prior?.hypothesis_hashes ?? [];
      if (['FAIL', 'BLOCKED'].includes(prior?.status) && (!hypothesis || previousHypotheses.includes(hypothesis))) {
        throw new GateRunnerError(`DIAGNOSTIC_NO_PROGRESS: unchanged failed inputs; inspect ${evidenceFile}, change inputs or provide a new checks/ hypothesis; do not weaken tests`);
      }
    }
  } catch (error) { await release(); throw error; }
  const results: Array<Record<string, unknown>> = [];
  let resource: Awaited<ReturnType<typeof createLivePostgres>> | undefined;
  let failure: unknown;
  let cleanupComplete: boolean | null = null;
  let status = 'PASS';
  const startedAt = new Date().toISOString();
  try {
    if (config?.live_postgres && invocations.some(item => config.live_postgres.command_indexes.includes(item.index))) {
      resource = await createLivePostgres(config.live_postgres, `${process.cwd()}:${runId}:${pipelineId}:${gate}`, (exe: string, argv: string[], env?: Record<string, string>) => runInvocation(exe, argv, process.cwd(), env, 60, ['inspect', 'rm'].includes(argv[0])));
    }
    for (const invocation of invocations) {
      const commandStarted = new Date().toISOString();
      const usesLive = resource && config.live_postgres.command_indexes.includes(invocation.index);
      const result = await runInvocation(invocation.exe, invocation.args, process.cwd(), usesLive ? resource.env : {}, config?.timeout_seconds ?? 1800);
      const stdout = redact(result.stdout); const stderr = redact(result.stderr);
      results.push({
        command: invocation.command, command_index: invocation.index, executable: invocation.exe, argv: invocation.args,
        started_at: commandStarted, completed_at: new Date().toISOString(), duration_ms: Date.now() - Date.parse(commandStarted),
        exit_code: result.exit_code, stdout, stderr, output_truncated: result.truncated,
        failure_summary: result.exit_code === 0 ? [] : failureSummary(stdout, stderr),
        stdout_sha256: sha256(result.stdout), stderr_sha256: sha256(result.stderr),
      });
      if (result.exit_code !== 0) {
        status = 'FAIL';
        throw new GateRunnerError(`gate command failed (${result.exit_code}): ${invocation.command}; evidence=${evidenceFile}`);
      }
    }
  } catch (error) { failure = error; if (status !== 'FAIL') status = 'BLOCKED'; }
  finally {
    if (resource) {
      try {
        await resource.cleanup();
        cleanupComplete = true;
      } catch (error) { cleanupComplete = false; status = 'BLOCKED'; failure = new GateRunnerError(`${failure ? String(failure) + '; ' : ''}${String(error)}`); }
    }
    try {
      await writeFile(evidenceFile, `${JSON.stringify({ status, purpose: advisory ? 'advisory' : 'authoritative', run_id: runId, pipeline_id: pipelineId, gate,
        runtime_locks: releaseLocks, candidate_sha: candidateSha ?? null, fingerprint,
        hypothesis_hashes: [...new Set([...previousHypotheses, ...(hypothesis ? [hypothesis] : [])])],
        selection_reason: selectionReason, source_digest: snapshot?.digest ?? null,
        started_at: startedAt, completed_at: new Date().toISOString(), duration_ms: Date.now() - Date.parse(startedAt),
        live_postgres: resource?.evidence ?? null, cleanup_complete: cleanupComplete,
        test_reports: JSON.parse(redact(JSON.stringify(await readTestReports(config?.report_files, join(resolve(stateRoot), runId), startedAt)))),
        error: failure ? redact(String(failure)) : null, results }, null, 2)}\n`, 'utf8');
      if (advisory && fingerprint) {
        ledger.attempts[fingerprint] = { status, hypothesis_hashes: [...new Set([...previousHypotheses, ...(hypothesis ? [hypothesis] : [])])] };
        await writeFile(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
      }
    } finally { await release(); }
  }
  if (failure) throw failure;
  console.log(JSON.stringify({ status, gate, pipeline_id: pipelineId, candidate_sha: candidateSha ?? null, evidence: evidenceFile,
    selection_reason: selectionReason, commands_run: results.length }));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`BLOCKED: gate_runner: ${message}`);
  process.exitCode = 1;
});
