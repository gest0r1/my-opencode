import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

type PipelineSpec = {
  id: string;
  profile?: string;
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

class GateRunnerError extends Error {}

const DEFAULT_STATE_ROOT = '.tmp/pipelines';
const MAX_CAPTURE = 256 * 1024;

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function isSafeApprovedCommand(command: string): boolean {
  if (!command.trim() || /[\n\r\0]/.test(command)) return false;
  // No composition, redirects or command substitution. One approved command per manifest entry.
  if (/[;&|<>`]/.test(command) || /\$\(/.test(command)) return false;
  const forbidden = [
    /(^|\s)sudo(\s|$)/i,
    /(^|\s)rm\s+-[^\n]*r/i,
    /(^|\s)git\s+(reset|clean|push|rebase|merge|checkout|switch)(\s|$)/i,
    /(^|\s)(shutdown|reboot|poweroff|mkfs)(\s|$)/i,
    /(^|\s)dd\s+/i,
    /docker\s+system\s+prune/i,
    /docker\s+compose\s+down/i,
    /kubectl\s+(delete|apply|replace|patch)(\s|$)/i,
    /terraform\s+(apply|destroy)(\s|$)/i,
  ];
  if (forbidden.some((pattern) => pattern.test(command))) return false;

  const allowed = [
    /^bash\s+-n\s+/,
    /^pytest\s+/,
    /^python(?:3)?\s+-m\s+pytest\s+/,
    /^npx\s+(?:--yes\s+)?(?:tsc|vitest|jest)\b/,
    /^tsc\b/,
    /^mypy\b/,
    /^npm\s+(?:test|run\s+(?:test|build|typecheck|lint))\b/,
    /^(?:corepack\s+)?pnpm\s+(?:test|run\s+(?:test|build|typecheck|lint)|exec\s+(?:tsc|vitest))\b/,
    /^yarn\s+(?:test|build|lint)\b/,
    /^bun\s+test\b/,
    /^go\s+(?:test|build)\b/,
    /^cargo\s+(?:test|check|build)\b/,
    /^docker\s+compose\b.*\sconfig(?:\s|$)/,
    /^docker\s+(?:pull|inspect|image\s+inspect)\b/,
    /^curl\s+-(?:f|s|S)/,
    /^gh\s+(?:workflow\s+run|run\s+(?:watch|view))\b/,
  ];
  return allowed.some((pattern) => pattern.test(command.trim()));
}

async function runCommand(command: string, cwd: string): Promise<{ exit_code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const runId = args[0];
  const pipelineId = args[1];
  const gate = args[2];
  let stateRoot = DEFAULT_STATE_ROOT;
  const stateRootIndex = args.indexOf('--state-root');
  if (stateRootIndex >= 0) stateRoot = args[stateRootIndex + 1] ?? DEFAULT_STATE_ROOT;
  if (!runId || !pipelineId || !gate) {
    throw new GateRunnerError('usage: gate-runner-cli.ts <run-id> <pipeline-id> <gate> [--state-root <path>]');
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
  if (sha256(manifestContent) !== state.manifest_sha256) {
    throw new GateRunnerError('frozen manifest hash mismatch');
  }
  const manifest = JSON.parse(manifestContent) as Manifest;
  if (manifest.run_id !== runId) throw new GateRunnerError('manifest run_id mismatch');
  const pipeline = manifest.pipelines.find((item) => item.id === pipelineId);
  if (!pipeline) throw new GateRunnerError(`pipeline not found: ${pipelineId}`);
  if (!pipeline.profile) throw new GateRunnerError(`pipeline has no gate profile: ${pipelineId}`);
  const commands = manifest.gate_profiles?.[pipeline.profile]?.[gate];
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new GateRunnerError(`no executable gate commands: profile=${pipeline.profile} gate=${gate}`);
  }
  for (const command of commands) {
    if (!isSafeApprovedCommand(command)) {
      throw new GateRunnerError(`command is not in deterministic safe runner policy: ${command}`);
    }
  }

  const evidenceFile = join(resolve(stateRoot), runId, 'gates', `${pipelineId}-${gate}.json`);
  await mkdir(dirname(evidenceFile), { recursive: true });
  const results: Array<Record<string, unknown>> = [];
  for (const command of commands) {
    const startedAt = new Date().toISOString();
    const result = await runCommand(command, process.cwd());
    results.push({
      command,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      exit_code: result.exit_code,
      stdout: redact(result.stdout),
      stderr: redact(result.stderr),
      stdout_sha256: sha256(result.stdout),
      stderr_sha256: sha256(result.stderr),
    });
    if (result.exit_code !== 0) {
      await writeFile(evidenceFile, `${JSON.stringify({ status: 'FAIL', run_id: runId, pipeline_id: pipelineId, gate, results }, null, 2)}\n`, 'utf8');
      throw new GateRunnerError(`gate command failed (${result.exit_code}): ${command}; evidence=${evidenceFile}`);
    }
  }

  await writeFile(
    evidenceFile,
    `${JSON.stringify({ status: 'PASS', run_id: runId, pipeline_id: pipelineId, gate, results }, null, 2)}\n`,
    'utf8',
  );
  console.log(JSON.stringify({ status: 'PASS', gate, pipeline_id: pipelineId, evidence: evidenceFile }));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`BLOCKED: gate_runner: ${message}`);
  process.exitCode = 1;
});
