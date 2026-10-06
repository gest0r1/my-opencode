import { createHash, randomBytes } from 'node:crypto';

// Only this trusted helper constructs Docker mutation argv. No caller flags/mounts.
export async function createLivePostgres(spec, identity, invoke) {
  const context = await invoke('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
  const endpoint = !process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST ? process.env.DOCKER_HOST : context.stdout.trim();
  if (context.exit_code !== 0 || !/^unix:\/\/\//.test(endpoint)) throw new Error('LIVE_POSTGRES_FAILED: a local Unix-socket Docker daemon is required');
  const localInvoke = (args, env) => invoke('docker', args, { DOCKER_CONTEXT: '', DOCKER_HOST: endpoint, ...env });
  const owner = createHash('sha256').update(identity).digest('hex');
  const name = `pipeline-live-${owner.slice(0, 12)}-${randomBytes(6).toString('hex')}`;
  const password = randomBytes(24).toString('hex');
  let id;
  let createAttempted = false;
  const call = async (args, env) => {
    const result = await localInvoke(args, env);
    if (result.exit_code !== 0) throw new Error(`LIVE_POSTGRES_FAILED: docker ${args[0]}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const cleanup = async () => {
    if (!createAttempted) return;
    const target = id ?? name;
    const result = await localInvoke(['inspect', '--format', '{{index .Config.Labels "opencode.pipeline.owner"}}', target]);
    if (result.exit_code !== 0 || result.stdout.trim() !== owner) throw new Error('LIVE_POSTGRES_CLEANUP_BLOCKED: ownership could not be verified');
    await call(['rm', '-f', target]);
    id = undefined;
    createAttempted = false;
  };
  try {
    createAttempted = true;
    id = await call(['create', '--name', name, '--label', `opencode.pipeline.owner=${owner}`,
      '--user', 'postgres', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only',
      '--memory', '512m', '--cpus', '1', '--pids-limit', '256',
      '--tmpfs', '/tmp:rw,nosuid,noexec,size=64m',
      '--tmpfs', '/var/run/postgresql:rw,nosuid,noexec,mode=1777,size=16m',
      '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,noexec,mode=1777,size=256m',
      '--publish', '127.0.0.1::5432', '--env', 'POSTGRES_PASSWORD',
      '--env', 'POSTGRES_DB=pipeline_live', '--env', 'PGDATA=/var/lib/postgresql/data/pgdata', spec.image],
    { POSTGRES_PASSWORD: password });
    if (!/^[0-9a-f]{64}$/.test(id)) { id = undefined; throw new Error('LIVE_POSTGRES_FAILED: invalid container ID'); }
    await call(['start', id]);
    const binding = await call(['port', id, '5432/tcp']);
    const port = /^127\.0\.0\.1:([0-9]+)$/.exec(binding)?.[1];
    if (!port) throw new Error('LIVE_POSTGRES_FAILED: port is not exclusively loopback');
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      // The entrypoint's bootstrap server is socket-only. Wait for the final TCP
      // server so tests cannot race database initialization.
      const result = await localInvoke(['exec', '--user', 'postgres', id, 'pg_isready', '-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '-d', 'pipeline_live']);
      if (result.exit_code === 0) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!ready) throw new Error('LIVE_POSTGRES_FAILED: readiness timeout');
    return {
      env: { LIVE_PG_TEST: '1', LIVE_PG_CONTOUR: `disposable-${owner.slice(0, 12)}`, DATABASE_URL: `postgresql://postgres:${password}@127.0.0.1:${port}/pipeline_live` },
      evidence: { image: spec.image, container_id: id, contour: `disposable-${owner.slice(0, 12)}` }, cleanup,
    };
  } catch (error) {
    try { await cleanup(); } catch (cleanupError) { throw new Error(`${error.message}; ${cleanupError.message}`); }
    throw error;
  }
}
