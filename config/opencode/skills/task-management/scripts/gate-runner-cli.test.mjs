import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, 'gate-runner-cli.ts');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function run(cwd, args) {
  return spawnSync('npx', ['--yes', 'tsx', RUNNER, ...args], {
    cwd,
    encoding: 'utf8',
    env: process.env,
  });
}

async function makeRun(command, gate = 'build') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gate-runner-'));
  const stateRoot = path.join(root, '.tmp', 'pipelines');
  const runId = 'gate-run';
  const manifest = {
    schema_version: 1,
    run_id: runId,
    pipelines: [{ id: 'app', stages: [gate], profile: 'default' }],
    gate_profiles: { default: { [gate]: [command] } },
  };
  const manifestFile = path.join(root, 'manifest.json');
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(manifestFile, manifestContent, 'utf8');
  await mkdir(path.join(stateRoot, runId), { recursive: true });
  await writeFile(
    path.join(stateRoot, runId, 'state.json'),
    `${JSON.stringify({
      run_id: runId,
      status: 'approved',
      manifest_file: manifestFile,
      manifest_sha256: sha256(manifestContent),
    }, null, 2)}\n`,
    'utf8',
  );
  return { root, stateRoot, runId };
}

test('runner executes an approved argv command without a shell and records evidence', async () => {
  const fixture = await makeRun('bash -n check.sh');
  await writeFile(path.join(fixture.root, 'check.sh'), '#!/usr/bin/env bash\necho ok\n', 'utf8');

  const result = run(fixture.root, [
    fixture.runId,
    'app',
    'build',
    '--state-root',
    fixture.stateRoot,
  ]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'PASS');

  const evidence = JSON.parse(await readFile(output.evidence, 'utf8'));
  assert.equal(evidence.status, 'PASS');
  assert.equal(evidence.results[0].executable, 'bash');
  assert.deepEqual(evidence.results[0].argv, ['-n', 'check.sh']);
  assert.equal(evidence.results[0].exit_code, 0);
});

test('runner rejects shell composition before any command is executed', async () => {
  const fixture = await makeRun('bash -n check.sh; touch pwned');
  await writeFile(path.join(fixture.root, 'check.sh'), '#!/usr/bin/env bash\necho ok\n', 'utf8');

  const result = run(fixture.root, [
    fixture.runId,
    'app',
    'build',
    '--state-root',
    fixture.stateRoot,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /shell composition/i);
  await assert.rejects(access(path.join(fixture.root, 'pwned')));
});

test('runtime candidate placeholder fails closed without published candidate evidence', async () => {
  const fixture = await makeRun('bash scripts/install.sh {candidate_sha}', 'runtime_validation');
  await mkdir(path.join(fixture.root, 'scripts'), { recursive: true });
  await writeFile(path.join(fixture.root, 'scripts', 'install.sh'), '#!/usr/bin/env bash\nexit 0\n', 'utf8');

  const result = run(fixture.root, [
    fixture.runId,
    'app',
    'runtime_validation',
    '--state-root',
    fixture.stateRoot,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /candidate evidence is missing/);
});


test('runner executes frozen uv pytest and rejects every non-pytest uv form', async () => {
  const fixture = await makeRun('uv run --frozen pytest backend/tests/test_x.py -q');
  const bin = path.join(fixture.root, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'uv'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${bin}:${oldPath}`;
    const pass = run(fixture.root, [fixture.runId, 'app', 'build', '--state-root', fixture.stateRoot]);
    assert.equal(pass.status, 0, pass.stderr);
    for (const command of ['uv run pytest -q', 'uv run bash -c id', 'uv run sh -c id', 'uv run python script.py', 'uv run --frozen python script.py', 'uv run --frozen arbitrary-command', 'uv run --frozen pytest -q | tee out']) {
      const rejected = await makeRun(command);
      const result = run(rejected.root, [rejected.runId, 'app', 'build', '--state-root', rejected.stateRoot]);
      assert.notEqual(result.status, 0, command);
    }
  } finally { process.env.PATH = oldPath; }
});


test('advisory checks use a selected frozen command and cannot overwrite final evidence', async () => {
  const fixture = await makeRun('bash -n check.sh');
  await writeFile(path.join(fixture.root, 'check.sh'), '#!/bin/bash\necho ok\n');
  const args = [fixture.runId, 'app', 'build', '--state-root', fixture.stateRoot];
  const final = run(fixture.root, args); assert.equal(final.status, 0, final.stderr);
  const finalPath = JSON.parse(final.stdout).evidence;
  const previous = await readFile(finalPath, 'utf8');
  const early = run(fixture.root, [...args, '--advisory', '--command-index', '0']);
  assert.equal(early.status, 0, early.stderr);
  const earlyPath = JSON.parse(early.stdout).evidence;
  assert.match(earlyPath, /checks/);
  assert.equal(JSON.parse(await readFile(earlyPath, 'utf8')).purpose, 'advisory');
  assert.equal(await readFile(finalPath, 'utf8'), previous);
  assert.notEqual(run(fixture.root, [...args, '--advisory', '--command-index', '2']).status, 0);
  assert.notEqual(run(fixture.root, [...args, '--command-index', '0']).status, 0);
  const runtime = await makeRun('bash scripts/install.sh', 'runtime_install');
  const blocked = run(runtime.root, [runtime.runId, 'app', 'runtime_install', '--advisory', '--state-root', runtime.stateRoot]);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /advisory checks cannot/);
});

async function diagnosticFixture() {
  const fx = await makeRun('pnpm exec vitest run --config vitest.unit.ts --passWithNoTests=false');
  await mkdir(path.join(fx.root, 'bin'));
  await mkdir(path.join(fx.root, 'src'));
  await writeFile(path.join(fx.root, 'src/orders.ts'), 'initial\n');
  await writeFile(path.join(fx.root, 'src/web.ts'), 'initial\n');
  await writeFile(path.join(fx.root, 'bin/pnpm'), `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync('.tmp/calls.log', JSON.stringify(process.argv.slice(2)) + '\\n');
if (fs.existsSync('.tmp/fail')) { console.error('FAIL orders invariant'); process.exit(1); }
`, { mode: 0o755 });
  const statePath = path.join(fx.stateRoot, fx.runId, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const manifest = JSON.parse(await readFile(state.manifest_file, 'utf8'));
  await unlink(state.manifest_file);
  state.manifest_file = path.join(fx.stateRoot, fx.runId, 'manifest.json');
  const git = (...args) => spawnSync('git', args, { cwd: fx.root, encoding: 'utf8' });
  assert.equal(git('init').status, 0);
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  git('add', 'src', 'bin'); assert.equal(git('commit', '-m', 'base').status, 0);
  manifest.git_setup = { base_sha: git('rev-parse', 'HEAD').stdout.trim() };
  manifest.gate_profiles.default.build.push('pnpm exec vitest run --config vitest.web.ts --passWithNoTests=false');
  manifest.gate_testing = { default: { build: { impact_groups: [
    { inputs: ['src/orders.ts'], command_index: 0, test_files: ['test/orders.test.ts'] },
    { inputs: ['src/web.ts'], command_index: 1 },
  ] } } };
  const content = JSON.stringify(manifest);
  state.manifest_sha256 = sha256(content);
  await writeFile(state.manifest_file, content); await writeFile(statePath, JSON.stringify(state));
  await writeFile(path.join(fx.root, 'src/orders.ts'), 'changed\n');
  return { ...fx, args: [fx.runId, 'app', 'build', '--state-root', fx.stateRoot], bin: path.join(fx.root, 'bin') };
}

test('affected advisory filters suites but authoritative invocation always runs the complete frozen set', async () => {
  const fx = await diagnosticFixture(); const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${fx.bin}:${oldPath}`;
    let result = run(fx.root, [...fx.args, '--advisory', '--affected']);
    assert.equal(result.status, 0, result.stderr);
    let evidence = JSON.parse(await readFile(JSON.parse(result.stdout).evidence, 'utf8'));
    assert.equal(evidence.results.length, 1); assert.ok(evidence.results[0].argv.includes('test/orders.test.ts'));
    assert.ok(evidence.results[0].duration_ms >= 0);
    result = run(fx.root, fx.args); assert.equal(result.status, 0, result.stderr);
    evidence = JSON.parse(await readFile(JSON.parse(result.stdout).evidence, 'utf8'));
    assert.equal(evidence.results.length, 2); assert.ok(!evidence.results[0].argv.includes('test/orders.test.ts'));
    assert.notEqual(run(fx.root, [...fx.args, '--affected']).status, 0);
    await writeFile(path.join(fx.root, 'src/unmapped.ts'), 'unknown');
    result = run(fx.root, [...fx.args, '--advisory', '--affected']); assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).commands_run, 2);
  } finally { process.env.PATH = oldPath; }
});

test('unchanged diagnostic failures cannot spin; a unique hypothesis permits one retry and source corrections resume', async () => {
  const fx = await diagnosticFixture(); const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${fx.bin}:${oldPath}`;
    await writeFile(path.join(fx.root, '.tmp/fail'), 'yes');
    const args = [...fx.args, '--advisory', '--command-index', '0'];
    let result = run(fx.root, args); assert.notEqual(result.status, 0);
    const evidenceFile = path.join(fx.stateRoot, fx.runId, 'checks/app-build.json');
    const previous = await readFile(evidenceFile, 'utf8');
    result = run(fx.root, args); assert.match(result.stderr, /DIAGNOSTIC_NO_PROGRESS/);
    assert.equal(await readFile(evidenceFile, 'utf8'), previous);
    result = run(fx.root, [...fx.args, '--advisory', '--command-index', '1']); assert.notEqual(result.status, 0);
    result = run(fx.root, args); assert.match(result.stderr, /DIAGNOSTIC_NO_PROGRESS/); // changing command selection cannot erase a consumed failure
    const hypothesis = path.join(fx.stateRoot, fx.runId, 'checks/hypothesis.md');
    await writeFile(hypothesis, 'Check whether a transient startup race reproduces.');
    result = run(fx.root, [...args, '--hypothesis', hypothesis]); assert.notEqual(result.status, 0); assert.doesNotMatch(result.stderr, /DIAGNOSTIC_NO_PROGRESS/);
    result = run(fx.root, [...args, '--hypothesis', hypothesis]); assert.match(result.stderr, /DIAGNOSTIC_NO_PROGRESS/);
    await writeFile(path.join(fx.root, 'src/orders.ts'), 'fixed\n'); await unlink(path.join(fx.root, '.tmp/fail'));
    result = run(fx.root, args); assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(await readFile(evidenceFile, 'utf8')).status, 'PASS');
  } finally { process.env.PATH = oldPath; }
});

async function attachPostgres(fx) {
  await writeFile(path.join(fx.bin, 'docker'), `#!/usr/bin/env node
const fs = require('node:fs'); const args = process.argv.slice(2);
fs.appendFileSync('.tmp/docker.log', JSON.stringify(args) + '\\n');
const state = '.tmp/docker-state.json';
if (args[0] === 'context') console.log('unix:///var/run/docker.sock');
if (args[0] === 'create') { fs.writeFileSync(state, JSON.stringify({owner: args[args.indexOf('--label') + 1].split('=')[1]})); console.log('b'.repeat(64)); }
if (args[0] === 'port') console.log('127.0.0.1:55432');
if (args[0] === 'inspect') console.log(JSON.parse(fs.readFileSync(state)).owner);
if (args[0] === 'rm') fs.unlinkSync(state);
`, { mode: 0o755 });
  await writeFile(path.join(fx.bin, 'pnpm'), `#!/usr/bin/env node
const fs = require('node:fs');
if (!process.env.LIVE_PG_TEST || !process.env.DATABASE_URL?.includes('@127.0.0.1:55432/pipeline_live')) process.exit(2);
fs.writeFileSync('.tmp/test-started', 'yes');
console.log('database=' + process.env.DATABASE_URL);
if (fs.existsSync('.tmp/sleep')) setInterval(() => {}, 1000);
else if (fs.existsSync('.tmp/fail')) { console.error('FAIL live invariant'); process.exit(1); }
`, { mode: 0o755 });
  const statePath = path.join(fx.stateRoot, fx.runId, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const manifest = JSON.parse(await readFile(state.manifest_file, 'utf8'));
  manifest.gate_testing.default.build.live_postgres = { image: `postgres:16@sha256:${'a'.repeat(64)}`, command_indexes: [0, 1] };
  const content = JSON.stringify(manifest); state.manifest_sha256 = sha256(content);
  await writeFile(state.manifest_file, content); await writeFile(statePath, JSON.stringify(state));
}

test('runner provisions env and owned cleanup for both passing and failed live gates', async () => {
  for (const fail of [false, true]) {
    const fx = await diagnosticFixture(); await attachPostgres(fx);
    const oldPath = process.env.PATH;
    try {
      process.env.PATH = `${fx.bin}:${oldPath}`;
      if (fail) await writeFile(path.join(fx.root, '.tmp/fail'), 'yes');
      const result = run(fx.root, fx.args);
      assert.equal(result.status, fail ? 1 : 0, result.stderr);
      const raw = await readFile(path.join(fx.stateRoot, fx.runId, 'gates/app-build.json'), 'utf8');
      const evidence = JSON.parse(raw);
      assert.equal(evidence.status, fail ? 'FAIL' : 'PASS'); assert.equal(evidence.cleanup_complete, true);
      assert.match(evidence.results[0].stdout, /postgresql:\/\/\[REDACTED\]@/);
      await assert.rejects(access(path.join(fx.root, '.tmp/docker-state.json')));
      const calls = (await readFile(path.join(fx.root, '.tmp/docker.log'), 'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(calls.at(-1)[0], 'rm'); assert.equal(calls.filter(call => call[0] === 'create').length, 1);
    } finally { process.env.PATH = oldPath; }
  }
});

test('SIGTERM stops the test tree, cleans its container and preserves failed evidence', async () => {
  const fx = await diagnosticFixture(); await attachPostgres(fx);
  await writeFile(path.join(fx.root, '.tmp/sleep'), 'yes');
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), RUNNER, ...fx.args], { cwd: fx.root, env: { ...process.env, PATH: `${fx.bin}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; child.stderr.on('data', chunk => { errors += chunk; }); child.stdout.resume();
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve(code)); });
  let started = false;
  for (let count = 0; count < 100; count++) {
    try { await access(path.join(fx.root, '.tmp/test-started')); started = true; break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!started) child.kill('SIGKILL');
  assert.equal(started, true, errors);
  child.kill('SIGTERM'); assert.equal(await done, 1, errors);
  const evidence = JSON.parse(await readFile(path.join(fx.stateRoot, fx.runId, 'gates/app-build.json'), 'utf8'));
  assert.equal(evidence.status, 'FAIL'); assert.equal(evidence.cleanup_complete, true);
  assert.equal(evidence.results[0].exit_code, 130);
  await assert.rejects(access(path.join(fx.root, '.tmp/docker-state.json')));
});
