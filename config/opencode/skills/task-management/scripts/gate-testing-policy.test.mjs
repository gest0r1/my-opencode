import assert from 'node:assert/strict';
import test from 'node:test';
import { selectAffectedCommands, validateGateTesting, parallelBatches, isPrePublishGate } from './gate-testing-policy.mjs';
import { createLivePostgres } from './live-postgres.mjs';
import { readTestReports, sourceSnapshot, sourceInventory } from './gate-diagnostics.mjs';
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

test('unmapped, security, dependency and uncertain changes run the full set', () => {
  for (const changes of [null, [], ['other/file.ts'], ['package.json'], ['apps/api/package.json'], ['pnpm-lock.yaml'], ['apps/api/src/auth.ts'], ['apps/api/src/auth/login.ts'], ['vitest.config.ts'], ['db/migrations/061_baseline.sql'], ['apps/api/src/orders.ts', 'vitest.live.config.ts']]) {
    assert.equal(selectAffectedCommands(commands, config, changes).selected.length, commands.length, String(changes));
  }
});

test('mapped schema, migration and configuration changes follow the frozen impact groups', () => {
  const mapped = { impact_groups: [
    ...config.impact_groups,
    { inputs: ['packages/db/migrations/**', 'vitest.live.config.ts'], command_index: 0 },
  ] };
  for (const changes of [['packages/db/migrations/061_baseline.sql'], ['vitest.live.config.ts'], ['apps/api/src/schema.ts']]) {
    assert.deepEqual(selectAffectedCommands(commands, mapped, changes).selected.map(item => item.index), changes[0].startsWith('apps/') ? [0, 2] : [0], String(changes));
  }
  assert.deepEqual(selectAffectedCommands(commands, mapped, ['packages/shared/src/schema.ts']).selected.map(item => item.index), [0, 1, 2]);
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

test('frozen input kind enforces tree-before-publish and exact candidate/service ordering', () => {
  const manifest = (kind, stages, executors, gate = 'check') => ({
    gate_profiles: { local: { [gate]: ['pnpm exec tsc --noEmit'] } },
    gate_testing: { local: { [gate]: { input_kind: kind } } },
    pipelines: [{ id: 'delivery', profile: 'local', stages, executors }],
  });
  const tree = manifest('tree', ['check', 'publish'], { check: 'local_gate', publish: 'git_publish' });
  assert.doesNotThrow(() => validateGateTesting(tree));
  assert.throws(
    () => validateGateTesting(manifest('tree', ['publish', 'check'], { publish: 'git_publish', check: 'local_gate' })),
    /GATE_TREE_AFTER_PUBLISH/,
  );
  assert.throws(
    () => validateGateTesting(manifest('candidate', ['check', 'verify'], { check: 'local_gate', verify: 'git_verify' })),
    /GATE_CANDIDATE_BEFORE_VERIFY/,
  );
  assert.throws(() => validateGateTesting(manifest('candidate', ['verify', 'check'], { verify: 'git_verify', check: 'local_gate' })), /GATE_CANDIDATE_BEFORE_PUBLISH/);
  const candidate = manifest('candidate', ['verify', 'publish', 'release-candidate'], { verify: 'git_verify', publish: 'git_publish', 'release-candidate': 'local_gate' }, 'release-candidate');
  assert.throws(() => validateGateTesting(candidate), /GATE_CANDIDATE_UNBOUND/);
  candidate.gate_profiles.local['release-candidate'] = ['bash verify.sh {candidate_sha}'];
  assert.doesNotThrow(() => validateGateTesting(candidate));
  assert.equal(isPrePublishGate(manifest('candidate', ['verify', 'check', 'publish'], { verify: 'git_verify', check: 'local_gate', publish: 'git_publish' }), 'local', 'check'), false,
    'candidate gate must not be a clean-tree PLAN probe');
  assert.throws(
    () => validateGateTesting(manifest('deployed-service', ['check', 'deploy'], { check: 'local_gate', deploy: 'dev_deploy' })),
    /GATE_SERVICE_BEFORE_DEPLOY/,
  );
  assert.doesNotThrow(() => validateGateTesting(manifest('deployed-service', ['deploy', 'check'], { deploy: 'dev_deploy', check: 'local_gate' })));
  assert.throws(
    () => validateGateTesting(manifest('build-output', ['check'], { check: 'local_gate' })),
    /GATE_BUILD_OUTPUT_INVALID/,
  );
});

test('build-output requires an earlier materializing tree gate and immutable artifact input', () => {
  const manifest = {
    pipelines: [{ id: 'app', profile: 'local',
      stages: ['assemble', 'verify', 'publish', 'inspect'],
      executors: { assemble: 'local_gate', verify: 'git_verify', publish: 'git_publish', inspect: 'local_gate' } }],
    gate_profiles: { local: {
      assemble: ['npm run build'], inspect: ['npm test -- {artifact_path}'],
    } },
    gate_testing: { local: {
      assemble: { input_kind: 'tree', artifact_output: { path: 'dist/bundle.tgz' } },
      inspect: { input_kind: 'build-output', build_output: { producer_gate: 'assemble' } },
    } },
  };
  assert.doesNotThrow(() => validateGateTesting(manifest));
  assert.equal(isPrePublishGate(manifest, 'local', 'assemble'), false,
    'materialized build output must run in RUN, not as PLAN clean-tree probe');
  assert.equal(isPrePublishGate(manifest, 'local', 'inspect'), false);
  const renamed = JSON.parse(JSON.stringify(manifest));
  renamed.pipelines[0].stages[0] = 'release-assemble';
  renamed.pipelines[0].executors['release-assemble'] = 'local_gate';
  delete renamed.pipelines[0].executors.assemble;
  renamed.gate_profiles.local['release-assemble'] = renamed.gate_profiles.local.assemble;
  renamed.gate_testing.local['release-assemble'] = renamed.gate_testing.local.assemble;
  delete renamed.gate_profiles.local.assemble;
  delete renamed.gate_testing.local.assemble;
  renamed.gate_testing.local.inspect.build_output.producer_gate = 'release-assemble';
  assert.doesNotThrow(() => validateGateTesting(renamed), 'producer semantics must not depend on its name');
  const orphaned = JSON.parse(JSON.stringify(renamed));
  orphaned.gate_testing.local.assemble = { input_kind: 'tree' };
  orphaned.gate_profiles.local.assemble = ['npm run build'];
  assert.throws(() => validateGateTesting(orphaned), /GATE_INPUT_OWNER_INVALID/, 'an orphan gate must still be rejected');
  const broken = mutator => {
    const copy = JSON.parse(JSON.stringify(manifest));
    mutator(copy);
    return copy;
  };
  assert.throws(() => validateGateTesting(broken(m => {
    m.gate_testing.local.assemble.artifact_output.path = 'src/unstable.tgz';
  })), /GATE_BUILD_OUTPUT_PRODUCER_INVALID/);
  assert.throws(() => validateGateTesting(broken(m => {
    m.gate_testing.local.assemble.artifact_output.path = '../../outside';
  })), /GATE_BUILD_OUTPUT_PRODUCER_INVALID/);
  assert.throws(() => validateGateTesting(broken(m => {
    m.pipelines[0].stages = ['inspect', 'assemble', 'verify', 'publish'];
  })), /GATE_BUILD_OUTPUT_PRODUCER_MISSING/);
  assert.throws(() => validateGateTesting(broken(m => {
    m.gate_profiles.local.inspect = ['npm test'];
  })), /GATE_BUILD_OUTPUT_INVALID/);
  assert.throws(() => validateGateTesting(broken(m => {
    m.gate_testing.local.inspect.build_output.producer_gate = 'other';
  })), /GATE_BUILD_OUTPUT_PRODUCER_MISSING/);
});

test('live PostgreSQL preflight freezes only safe, explicit validateOnly repository scripts', () => {
  const image = 'postgres:16@sha256:' + 'a'.repeat(64);
  const build = command => ({ gate_profiles: { local: { check: ['pnpm exec vitest run --config vitest.live.ts'] } },
    gate_testing: { local: { check: { live_postgres: {
      image, command_indexes: [0], preflight_command: command,
    } } } } });
  for (const command of [
    'node scripts/testing/preflight.mjs --pipeline-preflight',
    'pnpm exec tsx scripts/testing/preflight.ts --pipeline-preflight',
    'corepack pnpm exec tsx scripts/testing/preflight.ts --pipeline-preflight',
  ]) assert.doesNotThrow(() => validateGateTesting(build(command)));
  for (const command of [
    'node -e process.exit(0) --pipeline-preflight',
    'node ../outside.js --pipeline-preflight',
    'node scripts/testing/preflight.mjs',
    'pnpm exec tsx /tmp/evil.ts --pipeline-preflight',
    'pnpm exec tsx scripts/testing/preflight.ts --pipeline-preflight && touch x',
    'bash scripts/testing/preflight.sh --pipeline-preflight',
  ]) assert.throws(() => validateGateTesting(build(command)), /GATE_TESTING_PREFLIGHT_INVALID/, command);
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

test('parallel groups are consecutive frozen steps; shared report files and live commands never share a batch', () => {
  const manifest = groups => ({ gate_profiles: { p: { g: commands } }, gate_testing: { p: { g: { ...config, parallel_groups: groups } } } });
  validateGateTesting(manifest([[0, 1]]));
  assert.throws(() => validateGateTesting(manifest([[0, 2]])), /consecutive/);
  assert.throws(() => validateGateTesting({ gate_profiles: { p: { g: commands } }, gate_testing: { p: { g: { ...config, coordinator_only: [0, 1, 2] } } } }), /no command for the worker/);
  const inv = (index, args = []) => ({ index, args });
  assert.deepEqual(parallelBatches([inv(0), inv(1), inv(2)], { parallel_groups: [[0, 1]] }).map(batch => batch.map(item => item.index)), [[0, 1], [2]]);
  assert.deepEqual(parallelBatches([inv(0), inv(2), inv(1)], { parallel_groups: [[1, 2]] }).map(batch => batch.map(item => item.index)), [[0], [2, 1]]);
  assert.deepEqual(parallelBatches([inv(0), inv(1)], { parallel_groups: [[0, 1]] }, [1]).map(batch => batch.map(item => item.index)), [[0], [1]]);
  const reports = { parallel_groups: [[0, 1]], report_files: ['reports/unit.json'] };
  assert.deepEqual(parallelBatches([inv(0, ['--outputFile=reports/unit.json']), inv(1, ['--outputFile=reports/unit.json'])], reports).map(batch => batch.length), [1, 1]);
});

test('a change that impacts only coordinator commands is deferred, never silently empty', () => {
  const selection = selectAffectedCommands(commands, { ...config, coordinator_only: [2] }, ['apps/api/src/orders.ts']);
  assert.deepEqual(selection.selected.map(item => item.index), [0]);
  assert.deepEqual(selection.deferred, [2]);
  const only = selectAffectedCommands(commands, { impact_groups: [{ inputs: ['types/**'], command_index: 2 }], coordinator_only: [2] }, ['types/a.d.ts']);
  assert.deepEqual(only.selected, []); assert.deepEqual(only.deferred, [2]);
});

test('the reuse digest covers the whole tree while the scoped digest stays bound to the work item', async () => {
  const root = await mkdtemp(join(tmpdir(), 'snapshot-'));
  const git = (...args) => promisify(execFile)('git', args, { cwd: root });
  await git('init'); await mkdir(join(root, 'src')); await mkdir(join(root, 'lib'));
  await writeFile(join(root, 'src/a.ts'), 'a\n'); await writeFile(join(root, 'lib/b.ts'), 'b\n'); await writeFile(join(root, '.env.test'), 'X=1\n');
  await git('add', '.');
  const invoke = async (exe, argv) => { try { const { stdout } = await promisify(execFile)(exe, argv, { cwd: root }); return { exit_code: 0, stdout, truncated: false }; } catch (error) { return { exit_code: 1, stdout: '', truncated: false }; } };
  const inventory = await sourceInventory(root, invoke);
  assert.ok('.env.test' in inventory.files, 'tracked .env files are part of the identity');
  const baseline = { files: inventory.files, allowed_change_paths: ['src/**'] };
  const before = await sourceSnapshot(root, {}, invoke, baseline);
  await writeFile(join(root, 'lib/b.ts'), 'changed outside the scope\n');
  const outside = await sourceSnapshot(root, {}, invoke, baseline);
  assert.equal(outside.scoped_digest, before.scoped_digest);
  assert.notEqual(outside.digest, before.digest, 'an out-of-scope change invalidates PASS reuse');
  assert.deepEqual(outside.changed, []);
  // A repair path joins the bound scope: editing it makes the scoped digest (stage-complete) stale.
  const repair = { ...baseline, allowed_change_paths: ['src/**', 'lib/b.ts'] };
  const withRepair = await sourceSnapshot(root, {}, invoke, repair);
  await writeFile(join(root, 'lib/b.ts'), 'repaired\n');
  assert.notEqual((await sourceSnapshot(root, {}, invoke, repair)).scoped_digest, withRepair.scoped_digest);
  await writeFile(join(root, '.env.test'), 'X=2\n');
  assert.notEqual((await sourceSnapshot(root, {}, invoke, baseline)).digest, outside.digest);
  await writeFile(join(root, '.env.local'), 'SECRET=1\n');
  assert.ok(!('.env.local' in (await sourceInventory(root, invoke)).files), 'untracked sensitive files stay out');
});

test('pre-publish release and install gates may hold test resources; post-publish and deployment gates may not', () => {
  const manifest = (stages, executors) => ({
    pipelines: [{ id: 'sink', profile: 'release', stages, executors }],
    gate_profiles: { release: { 'release-parity': ['pnpm exec vitest run'], 'dev-install': ['bash install.sh'] } },
  });
  const pre = manifest(['implementation', 'release-parity', 'git_publish'], { implementation: 'agent', 'release-parity': 'local_gate', git_publish: 'git_publish' });
  assert.equal(isPrePublishGate(pre, 'release', 'release-parity'), true);
  validateGateTesting({ ...pre, gate_testing: { release: { 'release-parity': { live_postgres: { image: 'postgres:16@sha256:' + 'a'.repeat(64), command_indexes: [0] } } } } });
  const post = manifest(['implementation', 'git_publish', 'release-parity'], { implementation: 'agent', git_publish: 'git_publish', 'release-parity': 'local_gate' });
  assert.equal(isPrePublishGate(post, 'release', 'release-parity'), false);
  assert.throws(() => validateGateTesting({ ...post, gate_testing: { release: { 'release-parity': { timeout_seconds: 60 } } } }), /test resources cannot wrap deployment gates/);
  const deploy = manifest(['dev-install'], { 'dev-install': 'local_gate' });
  assert.equal(isPrePublishGate({ ...deploy, gate_profiles: { release: { 'dev-deploy': ['x'] } } }, 'release', 'dev-deploy'), false);
});

test('post-deploy input classification is accepted without enabling deployment test resources', () => {
  const manifest = {
    pipelines: [{ id: 'app', profile: 'local', stages: ['deploy', 'smoke'], executors: { deploy: 'dev_deploy', smoke: 'local_gate' } }],
    gate_profiles: { local: { smoke: ['curl http://localhost/health'] } },
    gate_testing: { local: { smoke: { input_kind: 'deployed-service' } } },
  };
  assert.doesNotThrow(() => validateGateTesting(manifest));
  manifest.gate_testing.local.smoke.live_postgres = { image, command_indexes: [0] };
  assert.throws(() => validateGateTesting(manifest), /test resources cannot wrap deployment gates/);
});
