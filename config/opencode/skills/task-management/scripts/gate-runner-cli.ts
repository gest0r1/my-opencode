import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { gatePolicyError, tokenizeGateCommand, preflightPolicyError } from './gate-command-policy.mjs';
import { validateGateTesting, selectAffectedCommands, parallelBatches, resolveGateTestingFile, isPrePublishGate } from './gate-testing-policy.mjs';
import { createLivePostgres } from './live-postgres.mjs';
import { sourceSnapshot, sourceInventory, changedFromInventory, readDiagnosticHypothesis, failureSummary, outputTail, readTestReports, retryTimeouts } from './gate-diagnostics.mjs';
import { createGateSnapshot, reuseLocalInputs } from './gate-snapshot.mjs';
import { laneDigest, laneScope } from './dispatch-leases.mjs';
import { gitReadEnv } from './git-readonly.mjs';
import { acquireHeavySlot, acquireLiveSlot, acquireLockFiles, waitForHeavySlot } from './runtime-locks.mjs';
import { resolveReuseIdentity } from './gate-reuse-identity.mjs';
import { planProbeInputDigest, requirePlanProbeManifestPath } from './plan-probe-identity.mjs';
import { verifyDeployedServiceGate } from './dev-deploy-cli.ts';
import { artifactDigest, outputProof, verifyOutputProof } from './build-output-proof.mjs';

type PipelineSpec = {
  id: string;
  profile?: string;
  runtime_locks?: string[];
  stages?: string[];
  executors?: Record<string, string>;
};

type Manifest = {
  run_id: string;
  pipelines: PipelineSpec[];
  gate_profiles?: Record<string, Record<string, string[]>>;
  gate_testing?: Record<string, Record<string, any>>;
  git_setup?: { base_sha: string; branch?: string };
  deploy_target?: string;
};

type State = {
  run_id: string;
  status: string;
  manifest_file?: string;
  manifest_sha256?: string;
  pipelines?: Record<string, { stages?: Record<string, { status?: string; started_at?: string }> }>;
};

type CandidateEvidence = {
  candidate_sha?: string;
  remote_sha?: string;
  run_id?: string;
  branch?: string;
  status?: string;
  manifest_sha256?: string;
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

async function runInvocation(exe: string, args: string[], cwd: string, env: Record<string, string | undefined> = {}, timeout = 1800, cleanup = false): Promise<{ exit_code: number; stdout: string; stderr: string; truncated: boolean }> {
  if (interrupted && !cleanup) throw new GateRunnerError('execution interrupted');
  return new Promise((resolvePromise, reject) => {
    const childEnv: Record<string, string | undefined> = { ...process.env, ...env };
    for (const key of Object.keys(childEnv)) if (childEnv[key] === undefined) delete childEnv[key];
    const child = spawn(exe, args, { cwd, env: childEnv as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32' });
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

async function loadDeclaredCandidate(manifestFile: string, manifest: Manifest, manifestSha: string): Promise<string> {
  let candidate: CandidateEvidence;
  try { candidate = JSON.parse(await readFile(join(dirname(manifestFile), 'candidate.json'), 'utf8')); }
  catch { throw new GateRunnerError('CANDIDATE_EVIDENCE_INVALID: published candidate evidence missing or unreadable'); }
  if (candidate.status !== 'PASS' || candidate.run_id !== manifest.run_id || !manifest.git_setup?.branch ||
      candidate.branch !== manifest.git_setup.branch || candidate.manifest_sha256 !== manifestSha || !candidate.candidate_sha || !SHA.test(candidate.candidate_sha) ||
      candidate.remote_sha?.toLowerCase() !== candidate.candidate_sha.toLowerCase()) {
    throw new GateRunnerError('CANDIDATE_EVIDENCE_INVALID: published run, branch or remote SHA mismatch');
  }
  return candidate.candidate_sha;
}

// Lock files are named by the hash of the lock name; the record carries the name for its readers.
function lockEntry(name: string, runId: string) {
  return { file: `${sha256(name)}.lock`, record: { lock: name, run_id: runId } };
}

// Two runs of one lane gate (two work items checking in parallel) queue on the lane lock instead of
// failing. The lane lock lives in .gate-locks: `.runtime-locks` is what a project's live harness reads,
// and it must see exactly one gate while a live command runs (see the live slot below).
async function acquireGateLocks(stateRoot: string, runId: string, gateLock: string, runtimeLocks: string[]): Promise<() => Promise<void>> {
  const lane = await acquireLockFiles(join(resolve(stateRoot), '.gate-locks'), [lockEntry(gateLock, runId)]);
  // A runtime/release gate keeps its project-visible locks for its whole run, as release tooling checks them.
  let visible: { release: () => Promise<unknown> } | undefined;
  try {
    if (runtimeLocks.length) visible = await acquireLockFiles(join(resolve(stateRoot), '.runtime-locks'), runtimeLocks.map(name => lockEntry(name, runId)));
  } catch (error) { await lane.release(); throw new GateRunnerError(`runtime target is locked: ${String((error as Error)?.message ?? error)}`); }
  return async () => { await visible?.release(); await lane.release(); };
}

type ReuseQuery = {
  stateRoot: string; runId: string; gate: string; sourceDigest: string; environmentDigest: string;
  selected: Array<{ index: number; command: string; test_files: string[] }>; };

// A command that already passed on the identical source tree, with the same command text, gate and
// environment proves the same result; running it again on the same bytes adds wall-clock time, not
// evidence. The match is by command text, not by manifest or pipeline, so a later RUN over the same
// commit (a delivery-only RUN, a replan) and another lane on the same tree reuse it too. Reuse is per
// command: a worker's bound check covering commands 3..11 spares those commands in a later complete run.
// A result reused once can be reused again, because it still describes the same bytes. Evidence written
// before these identity fields existed, base probes and interrupted/blocked runs are never reused.
const REUSE_OTHER_RUNS = 20;
async function findReusableResults(query: ReuseQuery): Promise<Map<number, { path: string; result: any }>> {
  const found = new Map<number, { path: string; result: any }>();
  let others: string[] = [];
  try {
    const names = (await readdir(query.stateRoot, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== query.runId);
    const dated = await Promise.all(names.map(async entry => ({ name: entry.name, mtime: (await stat(join(query.stateRoot, entry.name))).mtimeMs })));
    others = dated.sort((a, b) => b.mtime - a.mtime).slice(0, REUSE_OTHER_RUNS).map(entry => entry.name);
  } catch {}
  for (const run of [query.runId, ...others]) {
    for (const directory of ['gates', 'checks']) {
      let names: string[] = [];
      try { names = await readdir(join(query.stateRoot, run, directory)); } catch { continue; }
      for (const name of names.sort()) {
        if (found.size === query.selected.length) return found;
        if (!name.endsWith('.json') || name.endsWith('-attempts.json')) continue;
        const path = join(query.stateRoot, run, directory, name);
        let evidence: any;
        try { evidence = JSON.parse(await readFile(path, 'utf8')); } catch { continue; }
        if (!['PASS', 'FAIL'].includes(evidence?.status) || evidence.gate !== query.gate || evidence.source_digest !== query.sourceDigest ||
            evidence.environment_digest !== query.environmentDigest || evidence.base_probe || !Array.isArray(evidence.results)) continue;
        for (const { index, command, test_files: files } of query.selected) {
          if (found.has(index)) continue;
          const result = evidence.results.find((item: any) => item.command === command && item.exit_code === 0 && Array.isArray(item.test_files) &&
            (item.test_files.length === 0 || (files.length > 0 && files.every(file => item.test_files.includes(file)))));
          if (result) found.set(index, { path: result.reused_from ?? path, result: { ...result, command_index: index } });
        }
      }
    }
  }
  return found;
}

// sha256 of JSON.stringify(frozen command array); same digest as gate-testing-policy commandsDigest.
export function planProbeCommandsSha256(commands: string[]): string {
  return sha256(JSON.stringify(commands));
}

// Gate environment (A1): identity + per-attempt scratch dir for every gate command. The reuse identity
// excludes only these run-specific IDs/attempt/scratch path; worker limits and all other inherited values
// remain part of the digest. CANDIDATE_SHA is explicitly unset without a candidate.
function gateEnv(identity: { runId: string; pipelineId: string; gate: string; attempt: number; candidateSha?: string; deployTarget?: string; scratchDir: string }): Record<string, string | undefined> {
  return { PIPELINE_RUN_ID: identity.runId, PIPELINE_ID: identity.pipelineId, PIPELINE_GATE: identity.gate, PIPELINE_GATE_ATTEMPT: String(identity.attempt),
    CANDIDATE_SHA: identity.candidateSha, PIPELINE_SCRATCH_DIR: identity.scratchDir,
    PIPELINE_DEPLOY_TARGET: identity.deployTarget,
    // Half the machine for a gate's own workers; a project wires it into its runner (vitest --maxWorkers,
    // jest --maxWorkers, pytest -n) in the frozen command. Set PIPELINE_MAX_WORKERS outside to override.
    PIPELINE_MAX_WORKERS: process.env.PIPELINE_MAX_WORKERS || String(Math.max(1, Math.floor(os.availableParallelism() / 2))) };
}

type Invocation = { command: string; index: number; test_files: string[]; exe: string; args: string[] };


async function executeInvocation(invocation: Invocation, env: Record<string, string | undefined>, timeout: number): Promise<{ result: Record<string, any>; exit_code: number }> {
  const commandStarted = new Date().toISOString();
  const result = await runInvocation(invocation.exe, invocation.args, process.cwd(), env, timeout)
    .catch(error => {
      if (interrupted) throw error;
      return { exit_code: 127, stdout: '', stderr: `COMMAND_START_FAILED: ${String((error as Error)?.message ?? error)}`, truncated: false };
    });
  const stdout = redact(result.stdout); const stderr = redact(result.stderr);
  return { exit_code: result.exit_code, result: {
    command: invocation.command, command_index: invocation.index, executable: invocation.exe, argv: invocation.args, test_files: invocation.test_files,
    started_at: commandStarted, completed_at: new Date().toISOString(), duration_ms: Date.now() - Date.parse(commandStarted),
    exit_code: result.exit_code, stdout, stderr, output_truncated: result.truncated,
    failure_summary: result.exit_code === 0 ? [] : failureSummary(stdout, stderr),
    output_tail: result.exit_code === 0 ? [] : outputTail(stdout, stderr),
    stdout_sha256: sha256(result.stdout), stderr_sha256: sha256(result.stderr),
  } };
}

async function requireCleanCheckout(): Promise<string> {
  const status = await runInvocation('git', ['status', '--porcelain', '--untracked-files=all'], process.cwd(), gitReadEnv({}), 30);
  const dirty = status.stdout.split('\n').filter(line => line.trim() && !/^.. \.tmp\//.test(line));
  if (status.exit_code !== 0 || dirty.length) throw new GateRunnerError('BASE_PROBE_REQUIRES_CLEAN_CHECKOUT');
  const head = await runInvocation('git', ['rev-parse', 'HEAD'], process.cwd(), gitReadEnv({}), 30);
  return head.stdout.trim();
}

// PLAN and RUN use the same stateless validateOnly command. The caller owns
// phase-aware locks, provenance checks and lifecycle; this helper only validates
// one frozen repository-local command without a DB or expensive test collection.
async function livePreflight(command: string, identity: {
  cwd: string; runId: string; pipelineId: string; gate: string;
  phase: 'plan_probe' | 'run_preflight'; candidateSha?: string;
}): Promise<void> {
  const tokens = tokenizeCommand(command);
  const reason = preflightPolicyError(tokens);
  if (reason) throw new GateRunnerError(reason);
  const script = tokens[0] === 'node' ? tokens[1] : tokens[0] === 'pnpm' ? tokens[3] : tokens[4];
  const scriptReal = await realpath(resolve(identity.cwd, script));
  const workspaceReal = await realpath(identity.cwd);
  if (!scriptReal.startsWith(workspaceReal + sep) ||
      relative(workspaceReal, scriptReal).startsWith('..')) {
    throw new GateRunnerError('LIVE_PREFLIGHT_SCRIPT_ESCAPE: script is outside checkout');
  }
  const result = await runInvocation(tokens[0], tokens.slice(1), identity.cwd, {
    PIPELINE_RUN_ID: identity.runId, PIPELINE_ID: identity.pipelineId, PIPELINE_GATE: identity.gate,
    PIPELINE_GATE_PHASE: identity.phase,
    PIPELINE_GATE_ATTEMPT: undefined, PIPELINE_SCRATCH_DIR: undefined,
    CANDIDATE_SHA: identity.candidateSha, PIPELINE_DEPLOY_TARGET: undefined,
    DATABASE_URL: undefined, LIVE_PG_TEST: undefined, LIVE_PG_CONTOUR: undefined,
    PGHOST: undefined, PGPORT: undefined, PGUSER: undefined,
    PGPASSWORD: undefined, PGDATABASE: undefined,
  }, 60);
  if (result.exit_code !== 0) {
    throw new GateRunnerError((identity.phase === 'plan_probe' ? 'PLAN_LIVE_PREFLIGHT_FAILED' : 'RUN_LIVE_PREFLIGHT_FAILED') + ': phase=' + identity.phase + ' exit=' +
      result.exit_code + ' ' + redact(result.stderr).slice(0, 500));
  }
}

// PLAN probe: stateless and provenance-bound, without creating a RUN state.json.
// Live profiles hold one phase-aware runtime lock and validate cheaply before
// allocating an attempt, container, scratch directory or running expensive suites.
async function planProbe(args: string[]): Promise<void> {
  const [manifestArg, pipelineId, gate] = args;
  if (!manifestArg || !pipelineId || !gate || args.length !== 3) throw new GateRunnerError('usage: gate-runner-cli.ts --plan-probe <manifest-path> <pipeline-id> <gate>');
  if (![pipelineId, gate].every(id => SAFE_ID.test(id) && !id.includes('..'))) throw new GateRunnerError('PLAN_PROBE_STAGE_ID_INVALID');
  const manifestFile = resolve(manifestArg);
  const manifestRaw = await readFile(manifestFile, 'utf8');
  const manifest = resolveGateTestingFile(JSON.parse(manifestRaw), manifestFile) as Manifest;
  const pipeline = manifest.pipelines?.find(item => item.id === pipelineId);
  if (!pipeline) throw new GateRunnerError('pipeline not found: ' + pipelineId);
  if (!pipeline.profile) throw new GateRunnerError('pipeline has no gate profile: ' + pipelineId);
  const commands = manifest.gate_profiles?.[pipeline.profile]?.[gate];
  if (!Array.isArray(commands) || commands.length === 0) throw new GateRunnerError('no executable gate commands: profile=' + pipeline.profile + ' gate=' + gate);
  validateGateTesting(manifest);
  if (!isPrePublishGate(manifest, pipeline.profile, gate)) throw new GateRunnerError('PLAN_PROBE_UNSUPPORTED: ' + gate + ' is not a pre-publish local gate');
  if (commands.some(command => command.includes('{candidate_sha}'))) throw new GateRunnerError('PLAN_PROBE_UNSUPPORTED: ' + pipeline.profile + '/' + gate + ' uses {candidate_sha}');
  const config = manifest.gate_testing?.[pipeline.profile]?.[gate];
  const invocations: Invocation[] = commands.map((command, index) => {
    const tokens = tokenizeCommand(command);
    assertSafeInvocation(tokens, gate);
    return { command, index, test_files: [], exe: tokens[0], args: tokens.slice(1) };
  });
  const headSha = await requireCleanCheckout();
  const hasLive = Boolean(config?.live_postgres && invocations.some(item => config.live_postgres.command_indexes.includes(item.index)));
  if (hasLive) requirePlanProbeManifestPath(manifestFile, manifest.run_id);
  const manifestSha = sha256(manifestRaw);
  const inputDigest = planProbeInputDigest(commands, config?.live_postgres, headSha);
  const root = dirname(manifestFile);
  const evidenceFile = join(root, 'planning', 'probes', pipelineId + '-' + gate + '.json');
  const startedAt = new Date().toISOString();
  const results: Array<Record<string, any>> = [];
  let attempt: number | null = null;
  let scratchDir: string | null = null;
  let resource: Awaited<ReturnType<typeof createLivePostgres>> | undefined;
  let cleanupComplete: boolean | null = null;
  let heavySlot: { release: () => Promise<void> } | undefined;
  let liveSlot: { release: () => Promise<void> } | undefined;
  let phaseLock: { release: () => Promise<unknown> } | undefined;
  let failure: unknown;
  let preflightStatus: 'not_required' | 'PASS' | 'FAIL' = hasLive ? 'FAIL' : 'not_required';
  let status = 'PASS';
  try {
    if (hasLive && !config.live_postgres.preflight_command) {
      throw new GateRunnerError('PLAN_LIVE_PREFLIGHT_REQUIRED: freeze live_postgres.preflight_command before PLAN probe');
    }
    heavySlot = await acquireHeavySlot({ run_id: manifest.run_id, pipeline_id: pipelineId, gate, plan_probe: true });
    if (hasLive) {
      // Slot first: the adapter must never see two simultaneous phase-lock owners.
      // Heavy slot first preserves the existing RUN heavy -> live acquisition order.
      liveSlot = await acquireLiveSlot({ run_id: manifest.run_id, pipeline_id: pipelineId, gate, plan_probe: true });
      const lockName = 'gate:' + manifest.run_id + ':' + pipelineId + ':' + gate;
      phaseLock = await acquireLockFiles(join(dirname(root), '.runtime-locks'), [{
        file: sha256(lockName) + '.lock',
        record: {
          lock: lockName, run_id: manifest.run_id, pipeline_id: pipelineId, gate,
          profile: pipeline.profile, phase: 'plan_probe', manifest_file: manifestFile,
          manifest_sha256: manifestSha, head_sha: headSha, input_digest: inputDigest,
          candidate_sha: null,
        },
      }]);
      await livePreflight(config.live_postgres.preflight_command, {
        cwd: process.cwd(), runId: manifest.run_id, pipelineId, gate, phase: 'plan_probe',
      });
      preflightStatus = 'PASS';
    }

    // Only now may a real gate attempt be allocated. A rejected cheap preflight
    // has attempt=null, no scratch and no Docker and cannot leave a false PASS.
    await mkdir(dirname(evidenceFile), { recursive: true });
    let previous: any;
    try { previous = JSON.parse(await readFile(evidenceFile, 'utf8')); } catch {}
    attempt = (Number.isInteger(previous?.attempt) ? previous.attempt : 0) + 1;
    scratchDir = join(root, 'scratch', pipelineId + '-' + gate + '-plan-probe-' + attempt);
    await mkdir(scratchDir, { recursive: true });
    const env = gateEnv({ runId: manifest.run_id, pipelineId, gate, attempt, scratchDir });
    if (hasLive) {
      resource = await createLivePostgres(config.live_postgres,
        process.cwd() + ':' + manifest.run_id + ':' + pipelineId + ':' + gate,
        (exe: string, argv: string[], liveEnv?: Record<string, string>) =>
          runInvocation(exe, argv, process.cwd(), { ...liveEnv, CANDIDATE_SHA: undefined, PIPELINE_DEPLOY_TARGET: undefined }, 60, ['inspect', 'rm'].includes(argv[0])));
    }
    for (const batch of parallelBatches(invocations, config, liveIndexes(config))) {
      const settled = await Promise.all(batch.map((invocation: Invocation) => {
        const usesLive = resource && config.live_postgres.command_indexes.includes(invocation.index);
        return executeInvocation(invocation, { ...(usesLive ? resource.env : {}), ...env }, config?.timeout_seconds ?? 1800)
          .then(done => ({ invocation, ...done }));
      }));
      await retryTimeouts(settled, () => interrupted, (invocation: Invocation) => {
        const usesLive = resource && config.live_postgres.command_indexes.includes(invocation.index);
        return executeInvocation(invocation, { ...(usesLive ? resource.env : {}), ...env }, config?.timeout_seconds ?? 1800);
      });
      for (const item of settled) results.push(item.result);
      const failed = settled.find(item => item.result.exit_code !== 0);
      if (failed) {
        status = 'FAIL';
        throw new GateRunnerError('gate command failed (' + failed.result.exit_code + '): ' + failed.result.command + '; evidence=' + evidenceFile);
      }
    }
    const completedHead = await requireCleanCheckout();
    if (completedHead !== headSha || sha256(await readFile(manifestFile, 'utf8')) !== manifestSha) {
      throw new GateRunnerError('PLAN_PROBE_INPUT_CHANGED: HEAD/checkout or draft manifest changed during probe; rerun on a stable base');
    }
  } catch (error) {
    failure = error; if (status !== 'FAIL') status = 'BLOCKED';
  } finally {
    try {
      if (resource) { await resource.cleanup(); cleanupComplete = true; }
    } catch (error) {
      status = 'BLOCKED';
      cleanupComplete = false;
      failure = new GateRunnerError((failure ? String(failure) + '; ' : '') + String(error));
    }
    try {
      await mkdir(dirname(evidenceFile), { recursive: true });
      await writeFile(evidenceFile, JSON.stringify({
        kind: 'plan_probe', phase: 'plan_probe', status,
        run_id: manifest.run_id, pipeline_id: pipelineId, gate, profile: pipeline.profile,
        head_sha: headSha, base_sha: manifest.git_setup?.base_sha ?? null,
        manifest_sha256: manifestSha, input_digest: inputDigest,
        candidate_sha: null, preflight_status: preflightStatus,
        live_postgres: resource?.evidence ?? null, cleanup_complete: cleanupComplete,
        commands_sha256: planProbeCommandsSha256(commands), attempt, scratch_dir: scratchDir,
        results: [...results].sort((a, b) => a.command_index - b.command_index),
        started_at: startedAt, completed_at: new Date().toISOString(), duration_ms: Date.now() - Date.parse(startedAt),
        error: failure ? redact(String(failure)) : null,
      }, null, 2) + '\n', 'utf8');
    } finally {
      try { await phaseLock?.release(); }
      finally { try { await liveSlot?.release(); } finally { await heavySlot?.release(); } }
    }
  }
  if (failure) throw failure;
  console.log(JSON.stringify({ status, gate, pipeline_id: pipelineId, work_item_id: null, candidate_sha: null,
    evidence: evidenceFile, selection_reason: 'plan probe: full frozen set', commands_run: results.length,
    commands_reused: 0, reused_from: null }));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--plan-probe') return planProbe(args.slice(1));
  const runId = args[0];
  const pipelineId = args[1];
  const gate = args[2];
  const advisory = args.includes('--advisory');
  let stateRoot = DEFAULT_STATE_ROOT;
  const stateRootIndex = args.indexOf('--state-root');
  if (stateRootIndex >= 0) stateRoot = args[stateRootIndex + 1] ?? DEFAULT_STATE_ROOT;
  // Absolute from here on: a gate on a tree snapshot runs in another directory.
  stateRoot = resolve(stateRoot);
  if (!runId || !pipelineId || !gate) {
    throw new GateRunnerError('usage: gate-runner-cli.ts <run-id> <pipeline-id> <gate> [--state-root <path>] [--no-reuse] [--in-place] [--advisory [--affected ...|--command-index N [--test-file PATH]...|--coordinator|--base-probe]]');
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
  const manifest = resolveGateTestingFile(JSON.parse(manifestContent), state.manifest_file) as Manifest;
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
  if (advisory && (['candidate', 'build-output', 'deployed-service'].includes(config?.input_kind) || config?.artifact_output)) {
    throw new GateRunnerError('candidate/build-output/deployed-service or artifact-producing gates cannot be advisory');
  }
  // Service checks consume the existing dev_deploy proof, not a new deployment
  // state store; do this before source inventory and test/container allocations.
  const candidateSha = advisory ? undefined
    : ['candidate', 'deployed-service'].includes(config?.input_kind)
      ? await loadDeclaredCandidate(state.manifest_file, manifest, state.manifest_sha256)
      : await loadCandidate(state.manifest_file);
  let deployedServiceEvidence: Record<string, unknown> | null = null;
  let deployedServiceInput: Parameters<typeof verifyDeployedServiceGate>[0] | null = null;
  if (config?.input_kind === 'deployed-service') {
    const stages = pipeline.stages ?? [];
    const gateIndex = stages.indexOf(gate);
    const deployStage = stages.slice(0, gateIndex).reverse()
      .find(stage => pipeline.executors?.[stage] === 'dev_deploy');
    if (!deployStage) throw new GateRunnerError('GATE_SERVICE_DEPLOY_STAGE_MISSING');
    const deployment = state.pipelines?.[pipelineId]?.stages?.[deployStage];
    if (deployment?.status !== 'completed' || !deployment.started_at || !manifest.deploy_target || !candidateSha) {
      throw new GateRunnerError('GATE_SERVICE_DEPLOY_INCOMPLETE: missing completed install, target or published candidate');
    }
    deployedServiceInput = {
      artifactRoot: dirname(state.manifest_file), runId, pipelineId,
      stage: deployStage, target: manifest.deploy_target,
      candidateSha, startedAt: deployment.started_at,
    };
    deployedServiceEvidence = await verifyDeployedServiceGate(deployedServiceInput);
  }
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

  // Coordinator check: only the frozen coordinator_only commands (build, type-check, lint) on the
  // combined tree. Worker bound checks already covered the impacted tests; the complete set runs
  // in the authoritative gate, reusing every command that already passed on the same bytes.
  const coordinator = args.includes('--coordinator');
  if (coordinator) {
    if (!advisory || affected || selection >= 0 || hasBoundBaseline) throw new GateRunnerError('coordinator requires --advisory without --affected or --command-index');
    const indexes = Array.isArray(config?.coordinator_only) ? config.coordinator_only : [];
    if (!indexes.length) throw new GateRunnerError('COORDINATOR_COMMANDS_MISSING: gate_testing has no coordinator_only commands');
    selected = indexes.slice().sort((a: number, b: number) => a - b).map((index: number) => selected[index]);
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
    if (!advisory || affected || selection >= 0 || hasBoundBaseline || coordinator) throw new GateRunnerError('base-probe requires --advisory and the complete frozen set');
    probe = { head_sha: await requireCleanCheckout(), base_sha: manifest.git_setup?.base_sha ?? null };
  }

  // One held RUN lane lock covers the cheap preflight and all ensuing gate
  // work. A failing preflight does not allocate a numbered attempt or scratch.
  const gateLock = `gate:${runId}:${pipelineId}:${gate}`;
  const runtimeGate = RUNTIME_GATE.test(gate);
  const releaseLocks = [...(runtimeGate ? pipeline.runtime_locks ?? [] : []), gateLock];
  // Pure gates keep their original late lock acquisition, so hashing does
  // not serialize other invocations of the same lane. Live RUN alone holds
  // its gate lock across the early preflight and subsequent gate execution.
  let unlock: (() => Promise<void>) | undefined;
  let unlocked = false;
  const release = async () => {
    if (unlocked) return;
    unlocked = true;
    await unlock?.();
  };
  try {
    const liveConfig = config?.live_postgres;
    if (liveConfig && liveIndexes(config).length) {
      unlock = await acquireGateLocks(stateRoot, runId, gateLock, runtimeGate ? releaseLocks : []);
      if (!liveConfig.preflight_command) throw new GateRunnerError(
        'RUN_LIVE_PREFLIGHT_REQUIRED: freeze live_postgres.preflight_command before RUN');
      // Use existing heavy->live order for both phases. The lock is visible
      // to the project before its validateOnly adapter runs, but no real PG exists.
      const heavyPreflight = await acquireHeavySlot({ run_id: runId, pipeline_id: pipelineId, gate });
      let livePreflightSlot: { release: () => Promise<void> } | undefined;
      let phaseLock: { release: () => Promise<unknown> } | undefined;
      try {
        livePreflightSlot = await acquireLiveSlot({ run_id: runId, pipeline_id: pipelineId, gate });
        const before = await runInvocation('git', ['rev-parse', 'HEAD'], process.cwd(), gitReadEnv({}), 30);
        if (before.exit_code !== 0 || !SHA.test(before.stdout.trim())) {
          throw new GateRunnerError('RUN_LIVE_PREFLIGHT_HEAD_UNAVAILABLE');
        }
        if (!runtimeGate) {
          phaseLock = await acquireLockFiles(join(resolve(stateRoot), '.runtime-locks'), [{
            file: sha256(gateLock) + '.lock',
            record: {
              lock: gateLock, run_id: runId, pipeline_id: pipelineId, gate,
              profile: pipeline.profile, phase: 'run_preflight',
              manifest_file: state.manifest_file, manifest_sha256: state.manifest_sha256,
              head_sha: before.stdout.trim(), candidate_sha: candidateSha ?? null,
            },
          }]);
        }
        await livePreflight(liveConfig.preflight_command, {
          cwd: process.cwd(), runId, pipelineId, gate, phase: 'run_preflight',
          candidateSha,
        });
        const currentState = JSON.parse(await readFile(stateFile, 'utf8')) as State;
        if (currentState.run_id !== runId || !['approved', 'in_progress'].includes(currentState.status) ||
            currentState.manifest_sha256 !== state.manifest_sha256 ||
            currentState.manifest_file !== state.manifest_file ||
            sha256(await readFile(state.manifest_file, 'utf8')) !== state.manifest_sha256) {
          throw new GateRunnerError('RUN_LIVE_PREFLIGHT_STATE_CHANGED');
        }
        const after = await runInvocation('git', ['rev-parse', 'HEAD'], process.cwd(), gitReadEnv({}), 30);
        if (after.exit_code !== 0 || after.stdout.trim() !== before.stdout.trim()) {
          throw new GateRunnerError('RUN_LIVE_PREFLIGHT_HEAD_CHANGED');
        }
        if (['candidate', 'deployed-service'].includes(config?.input_kind) &&
            await loadDeclaredCandidate(state.manifest_file, manifest, state.manifest_sha256) !== candidateSha) {
          throw new GateRunnerError('RUN_LIVE_PREFLIGHT_CANDIDATE_CHANGED');
        }
      } finally {
        try { await phaseLock?.release(); }
        finally { try { await livePreflightSlot?.release(); } finally { await heavyPreflight.release(); } }
      }
    }

  const evidenceSuffix = workItemId ? `-${sha256(`${baseline?.stage ?? ''}:${workItemId}`).slice(0, 16)}`
    : baseProbe ? '-base-probe'
      : coordinator ? '-coordinator'
      : testFiles.length ? `-focus-${sha256(JSON.stringify([selected[0].index, selected[0].test_files])).slice(0, 12)}` : '';
  const evidenceFile = join(resolve(stateRoot), runId, advisory ? 'checks' : 'gates', `${pipelineId}-${gate}${evidenceSuffix}.json`);
  await mkdir(dirname(evidenceFile), { recursive: true });
  let previous: any;
  try { previous = JSON.parse(await readFile(evidenceFile, 'utf8')); } catch {}
  const attempt = (Number.isInteger(previous?.attempt) ? previous.attempt : 0) + 1;
  const gitIn = (dir: string) => (exe: string, argv: string[]) => runInvocation(exe, argv, dir, gitReadEnv({}), 30);
  // Read-only inventory: never take .git/index.lock while a worker or publish may be writing.
  let snapshot = await sourceSnapshot(process.cwd(), manifest, gitIn(process.cwd()), advisory ? baseline : null);
  // A build-output gate reads an existing producer gate PASS, not a mutable
  // regenerated artifact or a second copy of build state. Check before test work.
  let buildOutputInput: Parameters<typeof verifyOutputProof>[0] | null = null;
  let buildOutputEvidence: Record<string, unknown> | null = null;
  if (config?.input_kind === 'build-output') {
    const producerGate = config.build_output.producer_gate as string;
    const producerStage = state.pipelines?.[pipelineId]?.stages?.[producerGate];
    if (producerStage?.status !== 'completed' || !snapshot?.digest) {
      throw new GateRunnerError('BUILD_OUTPUT_PRODUCER_NOT_COMPLETED: producer stage and clean source evidence required');
    }
    const artifactPath = manifest.gate_testing?.[pipeline.profile]?.[producerGate]?.artifact_output?.path;
    buildOutputInput = { cwd: process.cwd(),
      evidencePath: join(resolve(stateRoot), runId, 'gates', `${pipelineId}-${producerGate}.json`),
      runId, pipelineId, producerGate, manifestSha: state.manifest_sha256,
      sourceDigest: snapshot.digest, artifactPath };
    buildOutputEvidence = await verifyOutputProof(buildOutputInput);
  }
  let deferred: number[] = [];
  let selectionReason = baseProbe ? 'base probe: full frozen set' : coordinator ? 'coordinator-only commands' : testFiles.length ? 'focused test files' : 'full frozen set';
  if (affected) {
    const failures = (previous?.results ?? []).filter((result: any) => result.exit_code !== 0).map((result: any) => result.command_index);
    const known = baseline?.files && typeof baseline.files === 'object' ? baseline.files : null;
    const impact = selectAffectedCommands(commands, config, snapshot?.changed, failures, { isNew: (file: string) => Boolean(known) && !(file in known) });
    selected = impact.selected; selectionReason = impact.reason; deferred = impact.deferred;
    // Only coordinator commands are impacted: the worker has nothing to run, and the evidence says
    // so explicitly; the wave gate and the final complete gate run those commands.
    if (!selected.length) selectionReason = `deferred to coordinator: commands ${deferred.join(', ')}`;
  }
  const invocations = selected.map(item => {
    const tokens = substituteCandidate(tokenizeCommand(item.command), candidateSha)
      .map(token => token.replaceAll('{artifact_path}', buildOutputInput?.artifactPath ?? '{artifact_path}'));
    tokens.push(...item.test_files);
    assertSafeInvocation(tokens, gate);
    return { ...item, exe: tokens[0], args: tokens.slice(1) };
  });
  const hypothesisIndex = args.indexOf('--hypothesis');
  if (hypothesisIndex >= 0 && (!advisory || !args[hypothesisIndex + 1])) throw new GateRunnerError('hypothesis requires an advisory check and an evidence path');
  const hypothesis = hypothesisIndex < 0 ? null : await readDiagnosticHypothesis(args[hypothesisIndex + 1], join(resolve(stateRoot), runId));
  // Completion requires the lane's own files (generated ones aside) unchanged since the gate's snapshot.
  const laneScopeList = laneScope(manifest, dirname(state.manifest_file), join(stateRoot, runId), pipelineId);
  const generatedPaths: string[] = (manifest as any).generated_paths ?? [];
  const laneProof = (files: Record<string, string>) => laneScopeList.length
    ? { lane_scope: laneScopeList, lane_exclude: generatedPaths, lane_scope_digest: laneDigest(files, laneScopeList, generatedPaths) } : {};
  const originalCwd = process.cwd();
  const identityInvocations = commands.map((command, index) => {
    const tokens = substituteCandidate(tokenizeCommand(command), candidateSha)
      .map(token => token.replaceAll('{artifact_path}', buildOutputInput?.artifactPath ?? '{artifact_path}'));
    assertSafeInvocation(tokens, gate);
    return { command, index, test_files: [], exe: tokens[0], args: tokens.slice(1) };
  });
  const identityEnvironment: Record<string, string | undefined> = { ...process.env, ...gateEnv({ runId, pipelineId, gate, attempt, candidateSha, deployTarget: config?.input_kind === 'deployed-service' ? manifest.deploy_target : undefined, scratchDir: '' }) };
  for (const key of Object.keys(identityEnvironment)) if (identityEnvironment[key] === undefined) delete identityEnvironment[key];
  // Ignored local input files are copied into gate snapshots; source inventory
  // deliberately excludes them, so the toolchain identity must hash their bytes.
  // Failure to enumerate them means reuse is unsafe, but fresh execution remains allowed.
  let ignoredSnapshotFiles: string[] | null = null;
  let ignoredSnapshotError: string | null = null;
  try { ignoredSnapshotFiles = reuseLocalInputs(originalCwd); }
  catch (error) { ignoredSnapshotError = 'ignored snapshot inputs cannot be enumerated: ' + String(error instanceof Error ? error.message : error); }
  let reuseIdentity = ignoredSnapshotFiles === null
    ? { digest: null, reason: ignoredSnapshotError, metrics: { files: 0, bytes: 0, elapsed_ms: 0 } }
    : await resolveReuseIdentity({ cwd: originalCwd, invocations: identityInvocations, env: identityEnvironment, ignoredSnapshotFiles });
  const reuseIdentityMeasurements: Array<{ files: number; bytes: number; elapsed_ms: number }> = reuseIdentity.metrics ? [reuseIdentity.metrics] : [];
  let environmentDigest = reuseIdentity.digest;
  let reuseDisabledReason = reuseIdentity.reason;
  // The whole tree: a rerun after a shared config or test changed outside the work item (another lane, a
  // coordinator fix) is progress, not a repeat; only a rerun on byte-identical sources is refused.
  const inputIdentity = snapshot?.digest ? sha256(JSON.stringify([snapshot.digest, state.manifest_sha256, baselineSha ?? null, environmentDigest])) : null;
  const fingerprint = inputIdentity ? sha256(JSON.stringify([inputIdentity, invocations])) : null;
  const ledgerFile = join(resolve(stateRoot), runId, 'checks', `${pipelineId}-${gate}${evidenceSuffix}-attempts.json`);
  // Pure gates acquire here as before; live gates retain the earlier lock.
  if (!unlock) unlock = await acquireGateLocks(stateRoot, runId, gateLock, runtimeGate ? releaseLocks : []);
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

  // Full gates and coordinator checks run on a snapshot of the tree in a separate worktree: workers keep
  // writing meanwhile and the gate measures one fixed tree. `--in-place` (or PIPELINE_GATE_SNAPSHOT=0)
  // runs in the checkout; the orchestrator's allowlist admits the flag, not an env prefix.
  let treeCopy: any;
  let copyFiles: Record<string, string> | null = null;
  let snapshotRecord: Record<string, any> | null = null;
  if ((!advisory || coordinator) && !config?.artifact_output && config?.input_kind !== 'build-output' && !RUNTIME_GATE.test(gate) && !commands.some(command => command.includes('{candidate_sha}')) && process.env.PIPELINE_GATE_SNAPSHOT !== '0' && !args.includes('--in-place')) {
    const created = await createGateSnapshot({ cwd: originalCwd, stateRoot, label: `${pipelineId}-${gate}`,
      installEvidence: join(stateRoot, runId, 'checks', `${pipelineId}-${gate}${evidenceSuffix}-snapshot-install.json`) });
    if (created.snapshot) {
      treeCopy = created.snapshot;
      process.chdir(treeCopy.dir);
      snapshotRecord = { status: 'used', commit: treeCopy.commit, setup_ms: created.setup_ms };
      const inventory = await sourceInventory(process.cwd(), gitIn(process.cwd()));
      copyFiles = inventory.files;
      snapshot = { ...snapshot, digest: inventory.digest };
    } else snapshotRecord = { status: 'unavailable', reason: created.unavailable };
  }
  const dropCopy = async () => {
    if (!treeCopy) return;
    process.chdir(originalCwd);
    await treeCopy.remove();
    treeCopy = undefined;
  };
  const results: Array<Record<string, any>> = [];
  let resource: Awaited<ReturnType<typeof createLivePostgres>> | undefined;
  let failure: unknown;
  let cleanupComplete: boolean | null = null;
  let status = 'PASS';
  const startedAt = new Date().toISOString();
  const usesCandidate = commands.some(command => command.includes('{candidate_sha}'));
  // Resource-bound results do not prove the state of a later disposable DB or deployed service.
  // Keep reuse for pure commands from the same gate, but always establish fresh live evidence.
  const liveCommandIndexes = new Set(liveIndexes(config));
  const canReuseCommand = (index: number) => !config?.artifact_output && !['build-output', 'deployed-service'].includes(config?.input_kind) && !liveCommandIndexes.has(index);
  const reusable = args.includes('--no-reuse') || baseProbe || hypothesis || usesCandidate || RUNTIME_GATE.test(gate) || !snapshot?.digest || !environmentDigest ? new Map()
    : await findReusableResults({ stateRoot: resolve(stateRoot), runId, gate, sourceDigest: snapshot.digest, environmentDigest,
      selected: invocations.filter(item => canReuseCommand(item.index))
        .map(item => ({ index: item.index, command: item.command, test_files: item.test_files })) });
  if (environmentDigest) {
    let freshInputs: string[] | null = null;
    try { freshInputs = reuseLocalInputs(originalCwd); }
    catch { /* a failed input inventory invalidates reusable evidence */ }
    if (!freshInputs || JSON.stringify(freshInputs) !== JSON.stringify(ignoredSnapshotFiles)) {
      reusable.clear();
      environmentDigest = null;
      reuseDisabledReason = 'ignored snapshot input set changed during gate preparation';
    } else {
      reuseIdentity = await resolveReuseIdentity({ cwd: originalCwd, invocations: identityInvocations, env: identityEnvironment, ignoredSnapshotFiles: freshInputs });
      if (reuseIdentity.metrics) reuseIdentityMeasurements.push(reuseIdentity.metrics);
      if (reuseIdentity.digest !== environmentDigest) {
        reusable.clear();
        environmentDigest = null;
        reuseDisabledReason = reuseIdentity.reason ?? 'toolchain or relevant environment changed during reuse lookup';
      }
    }
  }
  // A gate that passed on an earlier snapshot and runs again (its lane files moved after it, or a plain
  // rerun) repeats only the commands that the changes between the two snapshots reach through the frozen
  // impact map; the others keep their PASS. Unmapped and dependency changes reach every command.
  if (environmentDigest && treeCopy && !args.includes('--no-reuse') && !hypothesis && previous?.status === 'PASS' && previous.snapshot?.status === 'used' &&
      SHA.test(previous.snapshot.commit ?? '') && previous.manifest_sha256 === state.manifest_sha256 && previous.environment_digest === environmentDigest) {
    const diff = await runInvocation('git', ['diff', '--name-only', '-z', '--no-renames', previous.snapshot.commit, treeCopy.commit, '--'], originalCwd, gitReadEnv({}), 30);
    if (diff.exit_code === 0 && !diff.truncated) {
      const changed = diff.stdout.split('\0').filter(Boolean);
      const touched = changed.length ? selectAffectedCommands(commands, config, changed, []) : { selected: [], deferred: [] };
      const reached = new Set<number>([...touched.selected.map((item: any) => item.index), ...touched.deferred]);
      for (const item of invocations) {
        if (!canReuseCommand(item.index)) continue;
        const prior = (previous.results ?? []).find((result: any) => result.command_index === item.index);
        if (reusable.has(item.index) || reached.has(item.index) || prior?.exit_code !== 0 ||
            JSON.stringify(prior.test_files ?? []) !== JSON.stringify(item.test_files)) continue;
        reusable.set(item.index, { path: evidenceFile, result: prior });
      }
      snapshotRecord!.reused_by_impact = { from_commit: previous.snapshot.commit, changed_paths: changed.slice(0, 200),
        commands: [...reusable.keys()].sort((a, b) => a - b) };
    }
  }
  const pending = invocations.filter(item => !reusable.has(item.index));
  // Whole-run reuse keeps the old evidence shape (`reused_from` set, zero commands run).
  const reuse = invocations.length > 0 && pending.length === 0 ? { path: [...reusable.values()][0].path } : null;
  // Fresh empty scratch dir per run of this evidence file; only created when a command will run.
  const scratchDir = pending.length ? join(resolve(stateRoot), runId, 'scratch', `${pipelineId}-${gate}${evidenceSuffix}-${attempt}`) : null;
  const env = gateEnv({ runId, pipelineId, gate, attempt, candidateSha, deployTarget: config?.input_kind === 'deployed-service' ? manifest.deploy_target : undefined, scratchDir: scratchDir ?? '' });
  // A full set takes the machine-wide heavy slot; a narrow check waits while a full set holds it.
  const heavy = pending.length > 0 && !affected && selection < 0;
  let heavySlot: { waited_ms: number; release: () => Promise<void> } | undefined;
  let slotWaitMs = 0;
  let liveHold: { waited_ms: number; release: () => Promise<void> } | undefined;
  let liveVisible: { release: () => Promise<unknown> } | undefined;
  let liveWaitMs = 0;
  let liveEvidence: unknown = null;
  const releaseLive = async () => { await liveVisible?.release(); liveVisible = undefined; await liveHold?.release(); liveHold = undefined; };
  const finishLive = async () => {
    liveEvidence = resource!.evidence;
    await resource!.cleanup();
    cleanupComplete = true;
    resource = undefined;
    await releaseLive();
  };
  const runPending = async (list: Invocation[]) => {
    // Frozen parallel groups run together (bounded); every other command keeps frozen order.
    // A failing batch stops the gate after all of its members settle, so evidence stays complete.
    const isLive = (batch: Invocation[]) => Boolean(config?.live_postgres) && batch.some(item => config.live_postgres.command_indexes.includes(item.index));
    const batches = parallelBatches(list, config, liveIndexes(config));
    for (const [batchIndex, batch] of batches.entries()) {
      // Live batches run alone on the machine: they take the live slot, show the project exactly this
      // gate in .runtime-locks and share one disposable database, all released before the next non-live batch.
      if (!resource && isLive(batch)) {
        liveHold = await acquireLiveSlot({ run_id: runId, pipeline_id: pipelineId, gate });
        liveWaitMs += liveHold.waited_ms;
        if (!runtimeGate) liveVisible = await acquireLockFiles(join(resolve(stateRoot), '.runtime-locks'), [lockEntry(gateLock, runId)]);
        resource = await createLivePostgres(config.live_postgres, `${process.cwd()}:${runId}:${pipelineId}:${gate}`, (exe: string, argv: string[], env?: Record<string, string>) => runInvocation(exe, argv, process.cwd(), env, 60, ['inspect', 'rm'].includes(argv[0])));
      }
      // Every member settles to a recorded result (a start failure is exit 127), so one failing to
      // start never leaves its siblings running unrecorded.
      const settled = await Promise.all(batch.map(async invocation => {
        const usesLive = resource && config.live_postgres.command_indexes.includes(invocation.index);
        const done = await executeInvocation(invocation, { ...(usesLive ? resource.env : {}), ...env }, config?.timeout_seconds ?? 1800);
        return { invocation, result: done.result };
      }));
      await retryTimeouts(settled, () => interrupted, (invocation: Invocation) => {
        const usesLive = resource && config.live_postgres.command_indexes.includes(invocation.index);
        return executeInvocation(invocation, { ...(usesLive ? resource.env : {}), ...env }, config?.timeout_seconds ?? 1800);
      });
      for (const item of settled) results.push(item.result);
      const failed = settled.find(item => item.result.exit_code !== 0);
      if (failed) {
        status = 'FAIL';
        throw new GateRunnerError(`gate command failed (${failed.result.exit_code}): ${failed.invocation.command}; evidence=${evidenceFile}`);
      }
      if (resource && !(batches[batchIndex + 1] && isLive(batches[batchIndex + 1]))) await finishLive();
    }
  };
  // A FAIL on a snapshot while other work kept changing the tree: when files changed since the snapshot
  // reach the failed commands (frozen impact map, unmapped changes count), the failure may already be
  // fixed or caused by a half-merged change. The failed and not yet run commands, plus passed ones those
  // changes reach, run again once on a fresh snapshot; only that result counts, so no repair cycle is
  // charged for a tree that no longer exists. Otherwise the failure stands.
  const rerunAfterChanges = async (): Promise<boolean> => {
    const live = await sourceInventory(originalCwd, gitIn(originalCwd));
    const changed = changedFromInventory(live.files, copyFiles) ?? [];
    const failedIndexes = results.filter(result => result.exit_code !== 0).map(result => result.command_index as number);
    if (!changed.length) { snapshotRecord!.failure_check = 'tree unchanged since the snapshot'; return false; }
    const touched = selectAffectedCommands(commands, config, changed, []);
    const reached = new Set<number>([...touched.selected.map((item: any) => item.index), ...touched.deferred]);
    if (!failedIndexes.some(index => reached.has(index))) {
      snapshotRecord!.failure_check = 'changes since the snapshot do not reach the failed commands';
      snapshotRecord!.changed_since = changed.slice(0, 200);
      return false;
    }
    if (resource) await finishLive();
    const first = { commit: treeCopy.commit, failed_commands: failedIndexes, changed_paths: changed.slice(0, 200) };
    Object.assign(snapshotRecord!, await treeCopy.refresh());
    snapshotRecord!.commit = treeCopy.commit;
    const inventory = await sourceInventory(process.cwd(), gitIn(process.cwd()));
    copyFiles = inventory.files;
    snapshot = { ...snapshot, digest: inventory.digest };
    const keep = results.filter(result => result.exit_code === 0 && !reached.has(result.command_index));
    const again = invocations.filter(item => !keep.some(result => result.command_index === item.index));
    results.length = 0;
    results.push(...keep.map(result => ({ ...result, snapshot_commit: first.commit })));
    status = 'PASS';
    snapshotRecord!.rerun = { first_attempt: first, commands: again.map(item => item.index) };
    await runPending(again);
    return true;
  };
  try {
    if (scratchDir) await mkdir(scratchDir, { recursive: true });
    for (const [, item] of reusable) results.push({ ...item.result, reused_from: item.path });
    // Dependencies are restored before the heavy slot is taken, so the slot is held only for the tests.
    if (treeCopy && pending.length) {
      try { Object.assign(snapshotRecord!, await treeCopy.prepare()); }
      catch (error) {
        // A snapshot that cannot be prepared (dependency restore) must not stop the gate: run in place.
        await dropCopy();
        snapshotRecord = { status: 'unavailable', reason: redact(String((error as Error)?.message ?? error)) };
      }
    }
    if (heavy) { heavySlot = await acquireHeavySlot({ run_id: runId, pipeline_id: pipelineId, gate }); slotWaitMs = heavySlot.waited_ms; }
    else if (pending.length) slotWaitMs = await waitForHeavySlot();
    try { await runPending(pending); }
    catch (error) {
      if (!(status === 'FAIL' && treeCopy && !interrupted && await rerunAfterChanges())) throw error;
    }
  } catch (error) {
    failure = error; if (status !== 'FAIL') status = 'BLOCKED';
    // An advisory run stopped by its caller (shell timeout, cancelled tool call) proves nothing about
    // the source: it is recorded as INTERRUPTED and does not consume the no-progress fingerprint.
    if (advisory && interrupted) status = 'INTERRUPTED';
  }
  finally {
    if (resource) {
      try { await finishLive(); }
      catch (error) { cleanupComplete = false; status = 'BLOCKED'; failure = new GateRunnerError(`${failure ? String(failure) + '; ' : ''}${String(error)}`); }
    }
    await releaseLive();
    if (deployedServiceInput && status === 'PASS') {
      try {
        const currentCandidate = await loadDeclaredCandidate(state.manifest_file, manifest, state.manifest_sha256);
        if (currentCandidate !== deployedServiceInput.candidateSha) throw new Error('published candidate changed');
        deployedServiceEvidence = await verifyDeployedServiceGate(deployedServiceInput);
      } catch (error) {
        status = 'BLOCKED';
        failure = new GateRunnerError('GATE_SERVICE_CHANGED_DURING_GATE: ' + String(error instanceof Error ? error.message : error));
      }
    }
    if ((config?.artifact_output || buildOutputInput) && status === 'PASS') {
      try {
        const freshSource = await sourceInventory(originalCwd, gitIn(originalCwd));
        if (!snapshot?.digest || freshSource.digest !== snapshot.digest) {
          throw new Error('source tree changed since build producer / consumer started');
        }
        if (config?.artifact_output) {
          const artifact = await artifactDigest(originalCwd, config.artifact_output.path);
          buildOutputEvidence = outputProof({ runId, pipelineId, gate, manifestSha: state.manifest_sha256,
            sourceDigest: snapshot.digest, artifact });
        } else if (buildOutputInput) {
          buildOutputEvidence = await verifyOutputProof(buildOutputInput);
        }
      } catch (error) {
        status = 'BLOCKED';
        failure = new GateRunnerError('BUILD_OUTPUT_CHANGED_DURING_GATE: ' + String(error instanceof Error ? error.message : error));
      }
    }
    if (environmentDigest && (pending.length > 0 || reusable.size > 0)) {
      let finalInputs: string[] | null = null;
      try { finalInputs = reuseLocalInputs(originalCwd); } catch {}
      const afterRun = finalInputs && JSON.stringify(finalInputs) === JSON.stringify(ignoredSnapshotFiles)
        ? await resolveReuseIdentity({ cwd: originalCwd, invocations: identityInvocations, env: identityEnvironment, ignoredSnapshotFiles: finalInputs })
        : { digest: null, reason: 'ignored snapshot input set changed during gate execution', metrics: { files: 0, bytes: 0, elapsed_ms: 0 } };
      if (afterRun.metrics) reuseIdentityMeasurements.push(afterRun.metrics);
      if (afterRun.digest !== environmentDigest) {
        if (reusable.size > 0 && status === 'PASS') {
          status = 'BLOCKED';
          failure = new GateRunnerError('REUSE_IDENTITY_CHANGED_DURING_GATE: reused results cannot prove an altered toolchain or ignored input set');
        }
        environmentDigest = null;
        reuseDisabledReason = afterRun.reason ?? 'toolchain or relevant environment changed during gate execution';
      }
    }
    try {
      const reuseIdentityMetrics = {
        passes: reuseIdentityMeasurements.length,
        file_entries: reuseIdentityMeasurements.reduce((sum, measurement) => sum + measurement.files, 0),
        bytes_read: reuseIdentityMeasurements.reduce((sum, measurement) => sum + measurement.bytes, 0),
        hashing_ms: reuseIdentityMeasurements.reduce((sum, measurement) => sum + measurement.elapsed_ms, 0),
      };
      await writeFile(evidenceFile, `${JSON.stringify({ status, purpose: advisory ? 'advisory' : 'authoritative', run_id: runId, pipeline_id: pipelineId, gate,
        work_item_id: workItemId ?? null, dispatch_stage: baseline?.stage ?? null, baseline_path: baselinePath ?? null, baseline_sha256: baselineSha ?? null,
        runtime_locks: releaseLocks, candidate_sha: candidateSha ?? null, deployed_service: deployedServiceEvidence, fingerprint, attempt, scratch_dir: scratchDir,
        manifest_sha256: state.manifest_sha256, environment_digest: environmentDigest, reuse_disabled_reason: reuseDisabledReason,
        build_output: config?.artifact_output ? buildOutputEvidence : null,
        build_output_input: buildOutputInput ? buildOutputEvidence : null,
        reuse_identity_metrics: reuseIdentityMetrics, reused_from: reuse?.path ?? null,
        hypothesis_hashes: [...new Set([...previousHypotheses, ...(hypothesis ? [hypothesis] : [])])],
        selection_reason: selectionReason, deferred_to_coordinator: deferred, base_probe: probe, source_digest: snapshot?.digest ?? null, scoped_source_digest: snapshot?.scoped_digest ?? null,
        changed_paths: snapshot?.changed ?? null,
        started_at: startedAt, completed_at: new Date().toISOString(), duration_ms: Date.now() - Date.parse(startedAt),
        live_postgres: liveEvidence ?? resource?.evidence ?? null, cleanup_complete: cleanupComplete, heavy_slot: heavy, heavy_slot_wait_ms: slotWaitMs, live_slot_wait_ms: liveWaitMs,
        snapshot: snapshotRecord && treeCopy && copyFiles ? { ...snapshotRecord, ...laneProof(copyFiles) } : snapshotRecord,
        test_reports: reuse ? [] : JSON.parse(redact(JSON.stringify(await readTestReports(config?.report_files, join(resolve(stateRoot), runId), startedAt)))),
        error: failure ? redact(String(failure)) : null, results: [...results].sort((a: any, b: any) => a.command_index - b.command_index) }, null, 2)}\n`, 'utf8');
      // Append-only gate timeline for the RUN report: the main wall-clock cost is gate time.
      await mkdir(join(resolve(stateRoot), runId, 'reuse-metrics'), { recursive: true });
      await writeFile(join(resolve(stateRoot), runId, 'reuse-metrics', 'gates.jsonl'), `${JSON.stringify({ timestamp: new Date().toISOString(),
        event: 'gate_run', run_id: runId, pipeline_id: pipelineId, gate, work_item_id: workItemId ?? null, purpose: advisory ? 'advisory' : 'authoritative',
        mode: baseProbe ? 'base_probe' : coordinator ? 'coordinator' : testFiles.length ? 'focus' : affected ? 'affected' : selection >= 0 ? 'command' : 'complete',
        status, duration_ms: Date.now() - Date.parse(startedAt), commands_run: results.filter(item => !item.reused_from).length, commands_reused: reusable.size, reused: Boolean(reuse) })}\n`, { encoding: 'utf8', flag: 'a' });
      if (advisory && fingerprint && status !== 'INTERRUPTED') {
        ledger.attempts[fingerprint] = { status, hypothesis_hashes: [...new Set([...previousHypotheses, ...(hypothesis ? [hypothesis] : [])])] };
        await writeFile(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
      }
    } finally { await heavySlot?.release(); await release(); await dropCopy(); }
  }
  if (failure) throw failure;
  console.log(JSON.stringify({ status, gate, pipeline_id: pipelineId, work_item_id: workItemId ?? null, candidate_sha: candidateSha ?? null, evidence: evidenceFile,
    heavy_slot_wait_ms: slotWaitMs, selection_reason: selectionReason, commands_run: results.filter(item => !item.reused_from).length, commands_reused: reusable.size, reused_from: reuse?.path ?? null }));
  } finally { await release(); }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`BLOCKED: gate_runner: ${message}`);
  process.exitCode = 1;
});
