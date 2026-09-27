import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const RUN_ID = /^[A-Za-z0-9._-]+$/;
const HOST = /^[A-Za-z0-9.-]+$/;
const USER = /^[A-Za-z0-9._-]+$/;

class DeploymentTargetError extends Error {}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function writeJsonAtomic(file: string, value: unknown): Promise<string> {
  await mkdir(dirname(file), { recursive: true });
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const temp = `${file}.tmp-${process.pid}`;
  await writeFile(temp, content, 'utf8');
  await rename(temp, file);
  return sha256(content);
}

function probeSsh(target: any): Record<string, unknown> {
  if (typeof target.host !== 'string' || !HOST.test(target.host) ||
      typeof target.user !== 'string' || !USER.test(target.user)) {
    throw new DeploymentTargetError('EXTERNAL_SSH_TARGET_INVALID');
  }
  const port = target.port ?? 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DeploymentTargetError('EXTERNAL_SSH_PORT_INVALID');
  }
  const timeout = target.connect_timeout_seconds ?? 8;
  if (!Number.isInteger(timeout) || timeout < 2 || timeout > 60) {
    throw new DeploymentTargetError('EXTERNAL_SSH_TIMEOUT_INVALID');
  }

  const destination = `${target.user}@${target.host}`;
  const result = spawnSync('ssh', [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `ConnectTimeout=${timeout}`,
    '-p', String(port),
    destination,
    'true',
  ], {
    shell: false,
    encoding: 'utf8',
    timeout: (timeout + 5) * 1000,
    maxBuffer: 256 * 1024,
  });

  if (result.error?.code === 'ENOENT') throw new DeploymentTargetError('SSH_EXECUTABLE_NOT_FOUND');
  if (result.error) throw new DeploymentTargetError(`SSH_PROBE_ERROR: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr ?? '').trim().replace(/\s+/g, ' ').slice(0, 500);
    throw new DeploymentTargetError(`EXTERNAL_SSH_AUTH_OR_REACHABILITY_FAILED: ${detail || 'ssh exited ' + result.status}`);
  }
  return {
    kind: 'external_ssh',
    host: target.host,
    user: target.user,
    port,
    authentication: 'batch-mode-ready',
    reachability: 'ready',
  };
}

async function inspect(runId: string, policyPath: string): Promise<Record<string, unknown>> {
  if (!RUN_ID.test(runId)) throw new DeploymentTargetError('INVALID_RUN_ID');
  let policy: any;
  try { policy = JSON.parse(await readFile(resolve(policyPath), 'utf8')); }
  catch (error) {
    throw new DeploymentTargetError(`DEPLOYMENT_POLICY_UNREADABLE: ${error instanceof Error ? error.message : String(error)}`);
  }
  const target = policy?.deployment_target;
  if (!target) return { status: 'NOT_CONFIGURED', run_id: runId };

  let details: Record<string, unknown>;
  if (target.kind === 'github_environment') {
    details = { kind: 'github_environment', environment: target.environment ?? null };
  } else if (target.kind === 'external_ssh') {
    details = probeSsh(target);
  } else {
    throw new DeploymentTargetError('DEPLOYMENT_TARGET_KIND_UNSUPPORTED');
  }

  const checkedAt = new Date().toISOString();
  const evidence = {
    status: 'READY',
    run_id: runId,
    policy: policyPath,
    checked_at: checkedAt,
    ...details,
  };
  const relative = 'planning/deployment-target.json';
  const file = resolve('.tmp', 'pipelines', runId, relative);
  const digest = await writeJsonAtomic(file, evidence);
  return {
    ...evidence,
    artifact: { path: relative, sha256: digest },
  };
}

async function main(args: string[]): Promise<void> {
  const [command, runId] = args;
  if (command !== 'inspect' || !runId) {
    throw new DeploymentTargetError('usage: deployment-target-cli.ts inspect <run-id> [--policy <path>]');
  }
  const policy = option(args, '--policy') ?? '.opencode/pipeline-policy.json';
  const result = await inspect(runId, policy);
  console.log(JSON.stringify(result, null, 2));
}

export { inspect, probeSsh };

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`BLOCKED: deployment_target: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
