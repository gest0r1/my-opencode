import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { gatePolicyError, tokenizeGateCommand } from './gate-command-policy.mjs';
import { validateGateTesting, selectAffectedCommands, parallelBatches } from './gate-testing-policy.mjs';
import { createLivePostgres } from './live-postgres.mjs';
import { sourceSnapshot, readDiagnosticHypothesis, failureSummary, readTestReports } from './gate-diagnostics.mjs';
import { gitReadEnv } from './git-readonly.mjs';

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
const SHA256 = /^[0-9a-f]{64}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
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

function liveIndexes(config: any): number[] {
  return Array.isArray(config?.live_postgres?.command_indexes) ? config.live_postgres.command_indexes : [];
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

type ReuseQuery = {
  runDirectory: string; pipelineId: string; gate: string; manifestSha: string; sourceDigest: string;
  environmentDigest: string; selected: Array<{ index: number; test_files: string[] }>; requireComplete: number | null;
};

// A PASS already recorded by this runner for the identical source tree, frozen manifest, gate,
// environment and a superset of the selected commands proves the same result; running the same
// commands again on the same bytes adds wall-clock time, not evidence. Evidence written before
// these identity fields existed is never reused.
async function findReusablePass(query: ReuseQuery): Promise<{ path: string; evidence: any } | null> {
  for (const directory of ['gates', 'checks']) {
    let names: string[] = [];
    try { names = await readdir(join(query.runDirectory, directory)); } catch { continue; }
    for (const name of names.sort()) {
      if (!name.endsWith('.json') || name.endsWith('-attempts.json')) continue;
      const path = join(query.runDirectory, directory, name);
      let evidence: any;
      try { evidence = JSON.parse(await readFile(path, 'utf8')); } catch { continue; }
      if (evidence?.status !== 'PASS' || evidence.pipeline_id !== query.pipelineId || evidence.gate !== query.gate ||
          evidence.manifest_sha256 !== query.manifestSha || evidence.source_digest !== query.sourceDigest ||
          evidence.environment_digest !== query.environmentDigest || evidence.base_probe || evidence.reused_from ||
          !Array.isArray(evidence.results)) continue;
      const covered = (index: number, files: string[]) => evidence.results.some((result: any) => result.command_index === index &&
        result.exit_code === 0 && Array.isArray(result.test_files) &&
        (result.test_files.length === 0 || (files.length > 0 && files.every(file => result.test_files.includes(file)))));
      if (query.requireComplete !== null) {
        if (!Array.from({ length: query.requireComplete }, (_, index) => index).every(index => covered(index, []))) continue;
      } else if (!query.selected.every(item => covered(item.index, item.test_files))) continue;
      return { path, evidence };
    }
  }
  return null;
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
    throw new GateRunnerError('usage: gate-runner-cli.ts <run-id> <pipeline-id> <gate> [--state-root <path>] [--no-reuse] [--advisory [--affected ...|--command-index N [--test-file PATH]...|--base-probe]]');
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

  if (advisory && RUNTIME_GATE.test(gate)) throw new GateRunnerError('advisory checks cannot run runtime/deployment/install gates');
  validateGateTesting(manifest);
  const config = manifest.gate_testing?.[pipeline.profile]?.[gate];
  const affected = args.includes('--affected');
  if (affected && !advisory) throw new GateRunnerError('affected tests are advisory only; final gates always run the full frozen set');

  const workItemIndex = args.indexOf('--work-item');
  const baselineIndex = args.indexOf('--baseline');
  const baselineShaIndex = args.indexOf('--baseline-sha256');
  const workItemId = workItemIndex >= 0 ? args[workItemIndex + 1] : undefined;
  const baselinePath = baselineIndex >= 0 ? args[baselineIndex + 1] : undefined;
  const baselineSha = baselineShaIndex >= 0 ? args[baselineShaIndex + 1] : undefined;
  const hasBoundBaseline = workItemId !== undefined || baselinePath !== undefined || baselineSha !== undefined;
  if (hasBoundBaseline && (!advisory || !affected || !workItemId || !baselinePath || !baselineSha)) {
    throw new GateRunnerError('work-item baseline requires --advisory --affected --work-item --baseline --baseline-sha256');
  }
  if (workItemId && !SAFE_ID.test(workItemId)) throw new GateRunnerError('WORK_ITEM_ID_INVALID');

  let baseline: any = null;
  let baselineRaw: string | undefined;
  if (baselinePath) {
    if (!safeRelativePath(baselinePath) || !baselinePath.startsWith('checks/baselines/')) throw new GateRunnerError('ADVISORY_BASELINE_PATH_INVALID');
    if (!SHA256.test(baselineSha ?? '')) throw new GateRunnerError('ADVISORY_BASELINE_SHA_INVALID');
    const absolute = resolve(stateRoot, runId, baselinePath);
    baselineRaw = await readFile(absolute, 'utf8').catch(() => { throw new GateRunnerError('ADVISORY_BASELINE_MISSING'); });
    if (sha256(baselineRaw) !== baselineSha) throw new GateRunnerError('ADVISORY_BASELINE_CHANGED');
    try { baseline = JSON.parse(baselineRaw); }
    catch { throw new GateRunnerError('ADVISORY_BASELINE_INVALID_JSON'); }
    if (baseline.schema_version !== 1 || baseline.run_id !== runId || baseline.pipeline_id !== pipelineId ||
        baseline.work_item_id !== workItemId || baseline.manifest_sha256 !== state.manifest_sha256 ||
        !Array.isArray(baseline.allowed_change_paths) || baseline.allowed_change_paths.length === 0 || !baseline.files) {
      throw new GateRunnerError('ADVISORY_BASELINE_IDENTITY_MISMATCH');
    }
  }

  const selection = args.indexOf('--command-index');
  let selected = commands.map((command, index) => ({ command, index, test_files: [] as string[] }));
  if (selection >= 0) {
    const index = Number(args[selection + 1]);
    if (!advisory || affected || !Number.isInteger(index) || index < 0 || index >= commands.length) throw new GateRunnerError('command-index requires an advisory check and a valid frozen command index');
    selected = [selected[index]];
  }

  // Focused diagnostic: one frozen vitest command narrowed to concrete test files. It never
  // satisfies a bound completion check; the bound affected check and final gates stay complete.
  const testFiles: string[] = [];
  args.forEach((value, index) => { if (value === '--test-file') testFiles.push(args[index + 1] ?? ''); });
  if (testFiles.length) {
    if (!advisory || affected || selection < 0) throw new GateRunnerError('test-file requires --advisory --command-index N');
    for (const file of testFiles) {
      if (!safeRelativePath(file) || file.startsWith('-') || /[*?\[\]{}\0\r\n]/.test(file)) throw new GateRunnerError(`TEST_FILE_INVALID: ${file}`);
      await access(resolve(process.cwd(), file)).catch(() => { throw new GateRunnerError(`TEST_FILE_MISSING: ${file}`); });
    }
    const tokens = tokenizeCommand(selected[0].command);
    if (!tokens.includes('vitest') || !tokens.includes('run')) throw new GateRunnerError('test-file requires an explicit vitest run command');
    selected[0] = { ...selected[0], test_files: [...new Set(testFiles)] };
  }

  // Base probe: the complete frozen set on the untouched checkout before implementation starts,
  // so pre-existing red suites are classified up front instead of inside an unrelated work item.
  const baseProbe = args.includes('--base-probe');
  let probe: { head_sha: string; base_sha: string | null } | null = null;
  if (baseProbe) {
    if (!advisory || affected || selection >= 0 || hasBoundBaseline) throw new GateRunnerError('base-probe requires --advisory and the complete frozen set');
    const status = await runInvocation('git', ['status', '--porcelain', '--untracked-files=all'], process.cwd(), gitReadEnv({}), 30);
    const dirty = status.stdout.split('\n').filter(line => line.trim() && !/^.. \.tmp\//.test(line));
    if (status.exit_code !== 0 || dirty.length) throw new GateRunnerError('BASE_PROBE_REQUIRES_CLEAN_CHECKOUT');
    const head = await runInvocation('git', ['rev-parse', 'HEAD'], process.cwd(), gitReadEnv({}), 30);
    probe = { head_sha: head.stdout.trim(), base_sha: manifest.git_setup?.base_sha ?? null };
  }

  const evidenceSuffix = workItemId ? `-${sha256(`${baseline?.stage ?? ''}:${workItemId}`).slice(0, 16)}`
    : baseProbe ? '-base-probe'
      : testFiles.length ? `-focus-${sha256(JSON.stringify([selected[0].index, selected[0].test_files])).slice(0, 12)}` : '';
  const evidenceFile = join(resolve(stateRoot), runId, advisory ? 'checks' : 'gates', `${pipelineId}-${gate}${evidenceSuffix}.json`);
  await mkdir(dirname(evidenceFile), { recursive: true });
  let previous: any;
  try { previous = JSON.parse(await readFile(evidenceFile, 'utf8')); } catch {}
  // Read-only inventory: never take .git/index.lock while a worker or publish may be writing.
  const snapshot = await sourceSnapshot(process.cwd(), manifest, (exe: string, argv: string[]) => runInvocation(exe, argv, process.cwd(), gitReadEnv({}), 30), advisory ? baseline : null);
  let deferred: number[] = [];
  let selectionReason = baseProbe ? 'base probe: full frozen set' : testFiles.length ? 'focused test files' : 'full frozen set';
  if (affected) {
    const failures = (previous?.results ?? []).filter((result: any) => result.exit_code !== 0).map((result: any) => result.command_index);
    const impact = selectAffectedCommands(commands, config, snapshot?.changed, failures);
    selected = impact.selected; selectionReason = impact.reason; deferred = impact.deferred;
    // Only coordinator commands are impacted: the worker has nothing to run, and the evidence says
    // so explicitly; the wave gate and the final complete gate run those commands.
    if (!selected.length) selectionReason = `deferred to coordinator: commands ${deferred.join(', ')}`;
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
  const inputIdentity = snapshot?.digest ? sha256(JSON.stringify([snapshot.scoped_digest ?? snapshot.digest, state.manifest_sha256, baselineSha ?? null, environmentDigest])) : null;
  const fingerprint = inputIdentity ? sha256(JSON.stringify([inputIdentity, invocations])) : null;
  const ledgerFile = join(resolve(stateRoot), runId, 'checks', `${pipelineId}-${gate}${evidenceSuffix}-attempts.json`);
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
  const usesCandidate = commands.some(command => command.includes('{candidate_sha}'));
  const reuse = args.includes('--no-reuse') || baseProbe || hypothesis || usesCandidate || RUNTIME_GATE.test(gate) || !snapshot?.digest ? null
    : await findReusablePass({ runDirectory: join(resolve(stateRoot), runId), pipelineId, gate, manifestSha: state.manifest_sha256,
      sourceDigest: snapshot.digest, environmentDigest, selected: invocations.map(item => ({ index: item.index, test_files: item.test_files })),
      requireComplete: advisory ? null : commands.length });
  try {
    if (reuse) {
      results.push(...reuse.evidence.results);
    } else {
    if (config?.live_postgres && invocations.some(item => config.live_postgres.command_indexes.includes(item.index))) {
      resource = await createLivePostgres(config.live_postgres, `${process.cwd()}:${runId}:${pipelineId}:${gate}`, (exe: string, argv: string[], env?: Record<string, string>) => runInvocation(exe, argv, process.cwd(), env, 60, ['inspect', 'rm'].includes(argv[0])));
    }
    // Frozen parallel groups run together (bounded); every other command keeps frozen order.
    // A failing batch stops the gate after all of its members settle, so evidence stays complete.
    for (const batch of parallelBatches(invocations, config, liveIndexes(config))) {
      // Every member settles to a recorded result (a start failure is exit 127), so one failing to
      // start never leaves its siblings running unrecorded.
      const settled = await Promise.all(batch.map(async invocation => {
        const commandStarted = new Date().toISOString();
        const usesLive = resource && config.live_postgres.command_indexes.includes(invocation.index);
        const result = await runInvocation(invocation.exe, invocation.args, process.cwd(), usesLive ? resource.env : {}, config?.timeout_seconds ?? 1800)
          .catch(error => {
            if (interrupted) throw error;
            return { exit_code: 127, stdout: '', stderr: `COMMAND_START_FAILED: ${String((error as Error)?.message ?? error)}`, truncated: false };
          });
        const stdout = redact(result.stdout); const stderr = redact(result.stderr);
        return { invocation, result: {
          command: invocation.command, command_index: invocation.index, executable: invocation.exe, argv: invocation.args, test_files: invocation.test_files,
          started_at: commandStarted, completed_at: new Date().toISOString(), duration_ms: Date.now() - Date.parse(commandStarted),
          exit_code: result.exit_code, stdout, stderr, output_truncated: result.truncated,
          failure_summary: result.exit_code === 0 ? [] : failureSummary(stdout, stderr),
          stdout_sha256: sha256(result.stdout), stderr_sha256: sha256(result.stderr),
        } };
      }));
      for (const item of settled) results.push(item.result);
      const failed = settled.find(item => item.result.exit_code !== 0);
      if (failed) {
        status = 'FAIL';
        throw new GateRunnerError(`gate command failed (${failed.result.exit_code}): ${failed.invocation.command}; evidence=${evidenceFile}`);
      }
    }
    }
  } catch (error) {
    failure = error; if (status !== 'FAIL') status = 'BLOCKED';
    // An advisory run stopped by its caller (shell timeout, cancelled tool call) proves nothing about
    // the source: it is recorded as INTERRUPTED and does not consume the no-progress fingerprint.
    if (advisory && interrupted) status = 'INTERRUPTED';
  }
  finally {
    if (resource) {
      try {
        await resource.cleanup();
        cleanupComplete = true;
      } catch (error) { cleanupComplete = false; status = 'BLOCKED'; failure = new GateRunnerError(`${failure ? String(failure) + '; ' : ''}${String(error)}`); }
    }
    try {
      await writeFile(evidenceFile, `${JSON.stringify({ status, purpose: advisory ? 'advisory' : 'authoritative', run_id: runId, pipeline_id: pipelineId, gate,
        work_item_id: workItemId ?? null, dispatch_stage: baseline?.stage ?? null, baseline_path: baselinePath ?? null, baseline_sha256: baselineSha ?? null,
        runtime_locks: releaseLocks, candidate_sha: candidateSha ?? null, fingerprint,
        manifest_sha256: state.manifest_sha256, environment_digest: environmentDigest, reused_from: reuse?.path ?? null,
        hypothesis_hashes: [...new Set([...previousHypotheses, ...(hypothesis ? [hypothesis] : [])])],
        selection_reason: selectionReason, deferred_to_coordinator: deferred, base_probe: probe, source_digest: snapshot?.digest ?? null, scoped_source_digest: snapshot?.scoped_digest ?? null,
        changed_paths: snapshot?.changed ?? null,
        started_at: startedAt, completed_at: new Date().toISOString(), duration_ms: Date.now() - Date.parse(startedAt),
        live_postgres: resource?.evidence ?? null, cleanup_complete: cleanupComplete,
        test_reports: reuse ? reuse.evidence.test_reports ?? [] : JSON.parse(redact(JSON.stringify(await readTestReports(config?.report_files, join(resolve(stateRoot), runId), startedAt)))),
        error: failure ? redact(String(failure)) : null, results }, null, 2)}\n`, 'utf8');
      // Append-only gate timeline for the RUN report: the main wall-clock cost is gate time.
      await mkdir(join(resolve(stateRoot), runId, 'reuse-metrics'), { recursive: true });
      await writeFile(join(resolve(stateRoot), runId, 'reuse-metrics', 'gates.jsonl'), `${JSON.stringify({ timestamp: new Date().toISOString(),
        event: 'gate_run', run_id: runId, pipeline_id: pipelineId, gate, work_item_id: workItemId ?? null, purpose: advisory ? 'advisory' : 'authoritative',
        mode: baseProbe ? 'base_probe' : testFiles.length ? 'focus' : affected ? 'affected' : selection >= 0 ? 'command' : 'complete',
        status, duration_ms: Date.now() - Date.parse(startedAt), commands_run: reuse ? 0 : results.length, reused: Boolean(reuse) })}\n`, { encoding: 'utf8', flag: 'a' });
      if (advisory && fingerprint && status !== 'INTERRUPTED') {
        ledger.attempts[fingerprint] = { status, hypothesis_hashes: [...new Set([...previousHypotheses, ...(hypothesis ? [hypothesis] : [])])] };
        await writeFile(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
      }
    } finally { await release(); }
  }
  if (failure) throw failure;
  console.log(JSON.stringify({ status, gate, pipeline_id: pipelineId, work_item_id: workItemId ?? null, candidate_sha: candidateSha ?? null, evidence: evidenceFile,
    selection_reason: selectionReason, commands_run: reuse ? 0 : results.length, reused_from: reuse?.path ?? null }));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`BLOCKED: gate_runner: ${message}`);
  process.exitCode = 1;
});
