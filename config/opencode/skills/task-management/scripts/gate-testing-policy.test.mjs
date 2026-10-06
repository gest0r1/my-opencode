import assert from 'node:assert/strict';
import test from 'node:test';
import { selectAffectedCommands, validateGateTesting } from './gate-testing-policy.mjs';
import { createLivePostgres } from './live-postgres.mjs';
import { readTestReports } from './gate-diagnostics.mjs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const commands = ['pnpm exec vitest run --config vitest.api.ts', 'pnpm exec vitest run --config vitest.web.ts', 'pnpm exec tsc --noEmit'];
const config = { impact_groups: [
  { inputs: ['apps/api/**', 'packages/shared/**'], command_index: 0, test_files: ['apps/api/test/orders.test.ts'] },
  { inputs: ['apps/web/**', 'packages/shared/**'], command_index: 1 },
  { inputs: ['apps/api/**', 'apps/web/**', 'packages/shared/**'], command_index: 2 },
] };
const image = `postgres:16@sha256:${'a'.repeat(64)}`;

test('affected selection includes transitive consumers, prior failures and suite subsets', () => {
  let selection = selectAffectedCommands(commands, config, ['apps/api/src/orders.ts']);
  assert.deepEqual(selection.selected.map(item => item.index), [0, 2]);
  assert.deepEqual(selection.selected[0].test_files, ['apps/api/test/orders.test.ts']);
  selection = selectAffectedCommands(commands, config, ['packages/shared/src/types.ts']);
  assert.deepEqual(selection.selected.map(item => item.index), [0, 1, 2]);
  selection = selectAffectedCommands(commands, config, ['apps/api/src/orders.ts'], [1]);
  assert.deepEqual(selection.selected.map(item => item.index), [0, 1, 2]);
});

test('unmapped, security, schema, dependency and uncertain changes run the full set', () => {
  for (const changes of [null, [], ['other/file.ts'], ['package.json'], ['pnpm-lock.yaml'], ['packages/shared/src/schema.ts'], ['apps/api/src/auth.ts'], ['apps/api/src/auth/login.ts'], ['vitest.config.ts']]) {
    assert.equal(selectAffectedCommands(commands, config, changes).selected.length, commands.length, String(changes));
  }
});

test('frozen test/resource contracts reject privilege flags, mutable images and invalid filters', () => {
  const manifest = { gate_profiles: { local: { tests: commands } }, gate_testing: { local: { tests: { ...config, live_postgres: { image, command_indexes: [0] } } } } };
  validateGateTesting(manifest);
  for (const invalid of [
    { live_postgres: { image: 'postgres:16', command_indexes: [0] } },
    { live_postgres: { image, command_indexes: [0], privileged: true } },
    { impact_groups: [{ inputs: ['../prod/**'], command_index: 0 }] },
    { impact_groups: [{ inputs: ['apps/**'], command_index: 8 }] },
    { impact_groups: [{ inputs: ['apps/**'], command_index: 2, test_files: ['test.ts'] }] },
    { timeout_seconds: 0 }, { report_files: ['../secret.json'] },
  ]) {
    assert.throws(() => validateGateTesting({ ...manifest, gate_testing: { local: { tests: invalid } } }), /GATE_TESTING_INVALID/);
  }
});

function fakeDocker({ startFails = false, badOwner = false, readinessFails = false } = {}) {
  const calls = []; let owner;
  const invoke = async (exe, args, env) => {
    assert.equal(exe, 'docker'); calls.push({ args, env });
    if (args[0] === 'context') return { exit_code: 0, stdout: 'unix:///var/run/docker.sock', stderr: '' };
    if (args[0] === 'create') { owner = args[args.indexOf('--label') + 1].split('=')[1]; return { exit_code: 0, stdout: 'b'.repeat(64), stderr: '' }; }
    if (args[0] === 'start' && startFails) return { exit_code: 1, stdout: '', stderr: 'start failed' };
    if (args[0] === 'port') return { exit_code: 0, stdout: '127.0.0.1:55432', stderr: '' };
    if (args[0] === 'inspect') return { exit_code: 0, stdout: badOwner ? 'someone-else' : owner, stderr: '' };
    if (args[0] === 'exec' && readinessFails) throw new Error('interrupted');
    return { exit_code: 0, stdout: '', stderr: '' };
  };
  return { calls, invoke };
}

test('live PostgreSQL has bounded privileges, loopback, private random credentials and owned cleanup', async () => {
  const docker = fakeDocker();
  const resource = await createLivePostgres({ image }, 'run:app:tests', docker.invoke);
  const creation = docker.calls.find(call => call.args[0] === 'create');
  const create = creation.args;
  assert.ok(create.includes('--read-only')); assert.ok(create.includes('no-new-privileges'));
  assert.equal(create[create.indexOf('--publish') + 1], '127.0.0.1::5432');
  assert.equal(create[create.indexOf('--user') + 1], 'postgres');
  assert.ok(!create.includes('--privileged') && !create.includes('--volume'));
  assert.ok(!JSON.stringify(create).includes(creation.env.POSTGRES_PASSWORD));
  assert.match(resource.env.DATABASE_URL, /@127\.0\.0\.1:55432\/pipeline_live$/);
  const ready = docker.calls.find(call => call.args[0] === 'exec').args;
  assert.equal(ready[ready.indexOf('-h') + 1], '127.0.0.1');
  await resource.cleanup();
  assert.equal(docker.calls.at(-2).args[0], 'inspect'); assert.equal(docker.calls.at(-1).args[0], 'rm');
  await resource.cleanup(); // idempotent; no broad cleanup operation
});

test('failed startup and interrupted readiness both remove only the verified owned container', async () => {
  for (const options of [{ startFails: true }, { readinessFails: true }]) {
    const docker = fakeDocker(options);
    await assert.rejects(createLivePostgres({ image }, 'run:app:tests', docker.invoke));
    assert.equal(docker.calls.at(-1).args[0], 'rm');
    assert.equal(docker.calls.at(-1).args[2], 'b'.repeat(64));
  }
});

test('cleanup refuses a resource with another owner label', async () => {
  const docker = fakeDocker({ badOwner: true });
  const resource = await createLivePostgres({ image }, 'run:app:tests', docker.invoke);
  await assert.rejects(resource.cleanup(), /ownership/);
  assert.equal(docker.calls.some(call => call.args[0] === 'rm'), false);
});

test('one-line fresh Vitest reports yield failures automatically; stale reports never count', async () => {
  const root = await mkdtemp(join(tmpdir(), 'test-report-'));
  await mkdir(join(root, 'validation'));
  const started = new Date(Date.now() - 1000).toISOString();
  await writeFile(join(root, 'validation/live.json'), JSON.stringify({ numFailedTestSuites: 1, numFailedTests: 1, numPassedTests: 172,
    testResults: [{ name: 'orders', assertionResults: [{ status: 'failed', fullName: 'lock order', failureMessages: ['expected invariant'] }] }] }));
  const reports = await readTestReports(['validation/live.json'], root, started);
  assert.equal(reports[0].failed_tests, 1); assert.equal(reports[0].failures[0].test, 'lock order');
  assert.deepEqual(await readTestReports(['validation/live.json'], root, new Date(Date.now() + 1000).toISOString()), []);
});

test('real Docker smoke starts non-root PostgreSQL, applies test DDL and removes its container', { skip: process.env.PIPELINE_REAL_DOCKER !== '1' }, async () => {
  const execute = promisify(execFile);
  const invoke = async (exe, args, env = {}) => {
    try {
      const result = await execute(exe, args, { env: { ...process.env, ...env }, timeout: 120000, maxBuffer: 1024 * 1024 });
      return { exit_code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) { return { exit_code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? error.message }; }
  };
  const pulled = await invoke('docker', ['pull', 'postgres:16-bookworm']);
  assert.equal(pulled.exit_code, 0, pulled.stderr);
  const inspected = await invoke('docker', ['image', 'inspect', '--format', '{{index .RepoDigests 0}}', 'postgres:16-bookworm']);
  assert.equal(inspected.exit_code, 0, inspected.stderr);
  const digest = /sha256:[0-9a-f]{64}/.exec(inspected.stdout)?.[0]; assert.ok(digest);
  const resource = await createLivePostgres({ image: `postgres:16-bookworm@${digest}` }, `ci:${process.pid}`, invoke);
  try {
    const password = new URL(resource.env.DATABASE_URL).password;
    const sql = await invoke('docker', ['exec', '--user', 'postgres', '--env', 'PGPASSWORD', resource.evidence.container_id, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'pipeline_live', '-v', 'ON_ERROR_STOP=1', '-c',
      'CREATE TABLE live_probe (id int); CREATE ROLE live_probe_role BYPASSRLS; INSERT INTO live_probe VALUES (1); SELECT id FROM live_probe;'], { PGPASSWORD: password });
    assert.equal(sql.exit_code, 0, sql.stderr);
    assert.match(sql.stdout, /INSERT 0 1/);
  } finally { await resource.cleanup(); }
  const removed = await invoke('docker', ['inspect', resource.evidence.container_id]);
  assert.notEqual(removed.exit_code, 0);
});
