import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile, unlink, symlink, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import test from 'node:test';

// These tests drive in-place gates through files in the checkout's .tmp; snapshot gates have their own tests.
process.env.PIPELINE_GATE_SNAPSHOT ??= '0';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, 'gate-runner-cli.ts');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function run(cwd, args) {
  const env = { ...process.env };
  // NODE_PATH only lets this test worker resolve the external tsx install. Gate child fixtures use
  // built-ins/project dependencies; do not make that loader-only path part of their runtime identity.
  delete env.NODE_PATH;
  return spawnSync('npx', ['--yes', 'tsx', RUNNER, ...args], {
    cwd,
    encoding: 'utf8',
    env,
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
  assert.equal(evidence.heavy_slot, true);
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

test('declared candidate gate rejects missing, foreign and mismatched publish evidence', async () => {
  const fx = await makeRun('bash scripts/verify.sh {candidate_sha}', 'release-candidate');
  await mkdir(path.join(fx.root, 'scripts')); await writeFile(path.join(fx.root, 'scripts/verify.sh'), '#!/bin/sh\nexit 0\n');
  const manifestFile = path.join(fx.root, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  manifest.pipelines[0].stages = ['verify', 'publish', 'release-candidate'];
  manifest.pipelines[0].executors = { verify: 'git_verify', publish: 'git_publish', 'release-candidate': 'local_gate' };
  manifest.git_setup = { branch: 'feature/test' };
  manifest.gate_testing = { default: { 'release-candidate': { input_kind: 'candidate' } } };
  const content = JSON.stringify(manifest); await writeFile(manifestFile, content);
  const stateFile = path.join(fx.stateRoot, fx.runId, 'state.json');
  const state = JSON.parse(await readFile(stateFile, 'utf8')); state.manifest_sha256 = sha256(content); await writeFile(stateFile, JSON.stringify(state));
  const args = [fx.runId, 'app', 'release-candidate', '--state-root', fx.stateRoot];
  let result = run(fx.root, args);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /CANDIDATE_EVIDENCE_INVALID/);
  const candidate = 'a'.repeat(40);
  const evidence = { status: 'PASS', run_id: fx.runId, branch: 'feature/test', manifest_sha256: sha256(content), candidate_sha: candidate, remote_sha: candidate };
  for (const invalid of [{ ...evidence, run_id: 'other' }, { ...evidence, remote_sha: 'b'.repeat(40) }, { ...evidence, status: 'FAIL' }, { ...evidence, manifest_sha256: 'c'.repeat(64) }]) {
    await writeFile(path.join(fx.root, 'candidate.json'), JSON.stringify(invalid));
    result = run(fx.root, args); assert.notEqual(result.status, 0); assert.match(result.stderr, /CANDIDATE_EVIDENCE_INVALID/);
  }
  await writeFile(path.join(fx.root, 'candidate.json'), JSON.stringify(evidence));
  result = run(fx.root, args); assert.equal(result.status, 0, result.stderr);
  const written = JSON.parse(await readFile(JSON.parse(result.stdout).evidence, 'utf8'));
  assert.equal(written.candidate_sha, candidate);
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
  await mkdir(path.join(fx.root, 'node_modules/pnpm/bin'), { recursive: true });
  await mkdir(path.join(fx.root, 'node_modules/vitest/bin'), { recursive: true });
  await mkdir(path.join(fx.root, 'node_modules/.bin'), { recursive: true });
  await writeFile(path.join(fx.root, 'src/orders.ts'), 'initial\n');
  await writeFile(path.join(fx.root, 'src/web.ts'), 'initial\n');
  await writeFile(path.join(fx.root, '.gitignore'), 'node_modules/\n');
  await writeFile(path.join(fx.root, 'package.json'), JSON.stringify({ name: 'gate-fixture', packageManager: 'pnpm@1.0.0' }));
  await writeFile(path.join(fx.root, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n');
  await writeFile(path.join(fx.root, 'node_modules/pnpm/package.json'), JSON.stringify({ name: 'pnpm', version: '1.0.0' }));
  await writeFile(path.join(fx.root, 'node_modules/vitest/package.json'), JSON.stringify({ name: 'vitest', version: '1.0.0' }));
  await writeFile(path.join(fx.root, 'node_modules/vitest/bin/vitest.mjs'), '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });
  await symlink('../vitest/bin/vitest.mjs', path.join(fx.root, 'node_modules/.bin/vitest'));
  await writeFile(path.join(fx.root, 'node_modules/pnpm/bin/pnpm.cjs'), `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync('.tmp/calls.log', JSON.stringify(process.argv.slice(2)) + '\\n');
if (fs.existsSync('.tmp/fail')) { console.error('FAIL orders invariant'); process.exit(1); }
`, { mode: 0o755 });
  await symlink('../node_modules/pnpm/bin/pnpm.cjs', path.join(fx.root, 'bin/pnpm'));
  const statePath = path.join(fx.stateRoot, fx.runId, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const manifest = JSON.parse(await readFile(state.manifest_file, 'utf8'));
  await unlink(state.manifest_file);
  state.manifest_file = path.join(fx.stateRoot, fx.runId, 'manifest.json');
  const git = (...args) => spawnSync('git', args, { cwd: fx.root, encoding: 'utf8' });
  assert.equal(git('init').status, 0);
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  git('add', '.gitignore', 'src', 'bin', 'package.json', 'pnpm-lock.yaml'); assert.equal(git('commit', '-m', 'base').status, 0);
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

test('focused advisory narrows one frozen vitest command to existing test files only', async () => {
  const fx = await diagnosticFixture(); const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${fx.bin}:${oldPath}`;
    let result = run(fx.root, [...fx.args, '--advisory', '--command-index', '1', '--test-file', 'src/web.ts']);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.match(output.evidence, /checks\/app-build-focus-[0-9a-f]{12}\.json$/);
    const evidence = JSON.parse(await readFile(output.evidence, 'utf8'));
    assert.equal(evidence.results.length, 1); assert.equal(evidence.results[0].command_index, 1);
    assert.equal(evidence.results[0].argv.at(-1), 'src/web.ts'); assert.equal(evidence.selection_reason, 'focused test files');
    for (const [extra, error] of [
      [['--command-index', '1', '--test-file', 'src/missing.ts'], /TEST_FILE_MISSING/],
      [['--command-index', '1', '--test-file', '../src/web.ts'], /TEST_FILE_INVALID/],
      [['--command-index', '1', '--test-file', 'src/*.ts'], /TEST_FILE_INVALID/],
      [['--test-file', 'src/web.ts'], /requires --advisory --command-index/],
      [['--affected', '--test-file', 'src/web.ts'], /requires --advisory --command-index/],
    ]) {
      result = run(fx.root, [...fx.args, '--advisory', ...extra]);
      assert.notEqual(result.status, 0); assert.match(result.stderr, error);
    }
    assert.notEqual(run(fx.root, [...fx.args, '--command-index', '1', '--test-file', 'src/web.ts']).status, 0);
  } finally { process.env.PATH = oldPath; }
});

test('base probe runs the complete frozen set only on a clean checkout and records its base', async () => {
  const fx = await diagnosticFixture(); const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${fx.bin}:${oldPath}`;
    let result = run(fx.root, [...fx.args, '--advisory', '--base-probe']);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /BASE_PROBE_REQUIRES_CLEAN_CHECKOUT/);
    assert.equal(spawnSync('git', ['checkout', '--', 'src/orders.ts'], { cwd: fx.root }).status, 0);
    for (const extra of [['--affected'], ['--command-index', '0']]) {
      assert.notEqual(run(fx.root, [...fx.args, '--advisory', '--base-probe', ...extra]).status, 0);
    }
    assert.notEqual(run(fx.root, [...fx.args, '--base-probe']).status, 0);
    result = run(fx.root, [...fx.args, '--advisory', '--base-probe']);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.match(output.evidence, /checks\/app-build-base-probe\.json$/); assert.equal(output.commands_run, 2);
    const evidence = JSON.parse(await readFile(output.evidence, 'utf8'));
    assert.equal(evidence.purpose, 'advisory'); assert.equal(evidence.base_probe.head_sha, evidence.base_probe.base_sha);
    await writeFile(path.join(fx.root, '.tmp/fail'), '');
    result = run(fx.root, [...fx.args, '--advisory', '--base-probe']);
    assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(await readFile(output.evidence, 'utf8')).status, 'FAIL');
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

test('a live command sees exactly its own gate lock, and two runs of one lane gate queue instead of failing', async () => {
  const fx = await diagnosticFixture(); await attachPostgres(fx);
  await writeFile(path.join(fx.bin, 'pnpm'), `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const dir = '.tmp/pipelines/.runtime-locks';
const locks = fs.existsSync(dir) ? fs.readdirSync(dir).map(name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).lock) : [];
fs.appendFileSync('.tmp/locks-seen.log', JSON.stringify({ live: Boolean(process.env.LIVE_PG_TEST), locks, at: Date.now() }) + '\\n');
const until = Date.now() + 400; while (Date.now() < until) {}
`, { mode: 0o755 });
  const statePath = path.join(fx.stateRoot, fx.runId, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const manifest = JSON.parse(await readFile(state.manifest_file, 'utf8'));
  manifest.gate_testing.default.build.live_postgres.command_indexes = [1];
  const content = JSON.stringify(manifest); state.manifest_sha256 = sha256(content);
  await writeFile(state.manifest_file, content); await writeFile(statePath, JSON.stringify(state));
  const start = () => {
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), RUNNER, ...fx.args, '--no-reuse'], { cwd: fx.root, env: { ...process.env, PATH: `${fx.bin}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = ''; child.stderr.on('data', chunk => { errors += chunk; }); child.stdout.resume();
    return new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve({ code, errors })); });
  };
  const [first, second] = await Promise.all([start(), start()]);
  assert.equal(first.code, 0, first.errors); assert.equal(second.code, 0, second.errors);
  const seen = (await readFile(path.join(fx.root, '.tmp/locks-seen.log'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(seen.length, 4);
  for (const entry of seen) assert.deepEqual(entry.locks, entry.live ? [`gate:${fx.runId}:app:build`] : []);
  // The second run started its commands only after the first one finished all of its own.
  assert.ok(seen[2].at >= seen[1].at + 400);
  await assert.rejects(access(path.join(fx.stateRoot, '.runtime-locks', `${sha256(`gate:${fx.runId}:app:build`)}.lock`)));
  await assert.rejects(access(path.join(fx.stateRoot, '.gate-locks', `${sha256(`gate:${fx.runId}:app:build`)}.lock`)));
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

async function patchTesting(fx, patch) {
  const statePath = path.join(fx.stateRoot, fx.runId, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const manifest = JSON.parse(await readFile(state.manifest_file, 'utf8'));
  Object.assign(manifest.gate_testing.default.build, patch);
  const content = JSON.stringify(manifest); state.manifest_sha256 = sha256(content);
  await writeFile(state.manifest_file, content); await writeFile(statePath, JSON.stringify(state));
}

const callCount = async root => (await readFile(path.join(root, '.tmp/calls.log'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length;

test('a PASS on the identical tree is reused instead of rerun; any source change runs the commands again', async () => {
  const fx = await diagnosticFixture(); const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${fx.bin}:${oldPath}`;
    let result = run(fx.root, [...fx.args, '--advisory']); assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).commands_run, 2);
    const calls = await callCount(fx.root);
    result = run(fx.root, fx.args); assert.equal(result.status, 0, result.stderr);
    let output = JSON.parse(result.stdout);
    assert.equal(output.commands_run, 0); assert.match(output.reused_from, /checks\/app-build\.json$/);
    const evidence = JSON.parse(await readFile(output.evidence, 'utf8'));
    assert.equal(evidence.status, 'PASS'); assert.equal(evidence.purpose, 'authoritative'); assert.equal(evidence.results.length, 2);
    assert.equal(await callCount(fx.root), calls);
    result = run(fx.root, [...fx.args, '--no-reuse']); assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).commands_run, 2);
    await writeFile(path.join(fx.root, 'src/web.ts'), 'changed again\n');
    result = run(fx.root, fx.args); assert.equal(result.status, 0, result.stderr);
    output = JSON.parse(result.stdout); assert.equal(output.commands_run, 2); assert.equal(output.reused_from, null);
  } finally { process.env.PATH = oldPath; }
});

test('a same-PATH executable replacement invalidates reusable evidence', async () => {
  const fx = await diagnosticFixture(); const oldPath = process.env.PATH;
  const executable = path.join(fx.root, 'node_modules/pnpm/bin/pnpm.cjs');
  const writeExecutable = async marker => writeFile(executable, `#!/usr/bin/env node\nconst fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(path.join(fx.root, '.tmp/calls.log'))}, ${JSON.stringify(`${marker}\n`)});\n`, { mode: 0o755 });
  try {
    await writeExecutable('first-tool');
    process.env.PATH = `${fx.bin}:${oldPath}`;
    let result = run(fx.root, fx.args); assert.equal(result.status, 0, result.stderr);
    const first = JSON.parse(await readFile(JSON.parse(result.stdout).evidence, 'utf8'));
    assert.equal(first.results.length, 2);
    const calls = await callCount(fx.root);
    result = run(fx.root, fx.args); assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).commands_run, 0, 'unchanged executable should still reuse');
    assert.equal(await callCount(fx.root), calls);

    await writeExecutable('replacement-tool');
    result = run(fx.root, fx.args); assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.commands_run, 2, 'changed executable bytes at the same PATH must rerun commands');
    const replacement = JSON.parse(await readFile(output.evidence, 'utf8'));
    assert.notEqual(replacement.environment_digest, first.environment_digest);
    assert.equal(await callCount(fx.root), calls + 2);
  } finally { process.env.PATH = oldPath; }
});

test('a same-PATH local vitest replacement invalidates evidence through pnpm exec', async () => {
  const fx = await diagnosticFixture(); const oldPath = process.env.PATH;
  const executable = path.join(fx.root, 'node_modules/vitest/bin/vitest.mjs');
  try {
    process.env.PATH = `${fx.bin}:${oldPath}`;
    let result = run(fx.root, fx.args); assert.equal(result.status, 0, result.stderr);
    const first = JSON.parse(await readFile(JSON.parse(result.stdout).evidence, 'utf8'));
    result = run(fx.root, fx.args); assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).commands_run, 0);
    await writeFile(executable, '#!/usr/bin/env node\nprocess.exit(1);\n', { mode: 0o755 });
    result = run(fx.root, fx.args); assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.commands_run, 2);
    const changed = JSON.parse(await readFile(output.evidence, 'utf8'));
    assert.notEqual(changed.environment_digest, first.environment_digest);
  } finally { process.env.PATH = oldPath; }
});

test('a missing local pnpm exec tool that could fall back to global PATH is not reused', async () => {
  const fx = await diagnosticFixture(); const oldPath = process.env.PATH;
  const globalBin = await mkdtemp(path.join(os.tmpdir(), 'gate-global-tool-'));
  try {
    await rm(path.join(fx.root, 'node_modules/.bin/vitest'));
    await writeFile(path.join(globalBin, 'vitest'), '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });
    process.env.PATH = `${fx.bin}:${globalBin}:${oldPath}`;
    let result = run(fx.root, fx.args); assert.equal(result.status, 0, result.stderr);
    const evidence = JSON.parse(await readFile(JSON.parse(result.stdout).evidence, 'utf8'));
    assert.equal(evidence.environment_digest, null);
    assert.match(evidence.reuse_disabled_reason, /no project-root node_modules/);
    result = run(fx.root, fx.args); assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).commands_run, 2);
  } finally { process.env.PATH = oldPath; await rm(globalBin, { recursive: true, force: true }); }
});

test('a dependency tree that changes during execution cannot produce reusable evidence', async () => {
  const fx = await diagnosticFixture(); const oldPath = process.env.PATH;
  const executable = path.join(fx.root, 'node_modules/pnpm/bin/pnpm.cjs');
  const changed = `#!/usr/bin/env node\nconst fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(path.join(fx.root, '.tmp/calls.log'))}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`;
  await writeFile(executable, `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst target = ${JSON.stringify(executable)};\nfs.appendFileSync(${JSON.stringify(path.join(fx.root, '.tmp/calls.log'))}, JSON.stringify(process.argv.slice(2)) + '\\n');\nif (!fs.existsSync('.tmp/tool-mutated')) { fs.writeFileSync('.tmp/tool-mutated', 'yes'); fs.writeFileSync(target, ${JSON.stringify(changed)}); }\n`);
  try {
    process.env.PATH = `${fx.bin}:${oldPath}`;
    let result = run(fx.root, fx.args); assert.equal(result.status, 0, result.stderr);
    const firstOutput = JSON.parse(result.stdout);
    const first = JSON.parse(await readFile(firstOutput.evidence, 'utf8'));
    assert.equal(first.status, 'PASS', 'the commands ran and passed');
    assert.equal(first.environment_digest, null, 'post-run identity drift must not be reusable');
    assert.match(first.reuse_disabled_reason, /changed during gate execution/);
    result = run(fx.root, fx.args); assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).commands_run, 2, 'the next run must execute after post-run identity drift');
  } finally { process.env.PATH = oldPath; }
});

test('legacy partial environment digests are not eligible for reuse', async () => {
  const fx = await diagnosticFixture(); const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${fx.bin}:${oldPath}`;
    let result = run(fx.root, fx.args); assert.equal(result.status, 0, result.stderr);
    const evidencePath = JSON.parse(result.stdout).evidence;
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
    evidence.environment_digest = sha256(JSON.stringify([process.version, process.env.PATH, process.env.NODE_ENV,
      process.env.LIVE_PG_TEST, process.env.LIVE_PG_CONTOUR, process.env.DATABASE_URL]));
    await writeFile(evidencePath, JSON.stringify(evidence));
    result = run(fx.root, fx.args); assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).commands_run, 2);
  } finally { process.env.PATH = oldPath; }
});

test('reuse is per command: a complete run executes only the commands not yet passed on this tree', async () => {
  const fx = await diagnosticFixture(); const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${fx.bin}:${oldPath}`;
    let result = run(fx.root, [...fx.args, '--advisory', '--command-index', '0']); assert.equal(result.status, 0, result.stderr);
    result = run(fx.root, fx.args); assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.commands_run, 1); assert.equal(output.commands_reused, 1); assert.equal(output.reused_from, null);
    const evidence = JSON.parse(await readFile(output.evidence, 'utf8'));
    assert.deepEqual(evidence.results.map(item => [item.command_index, Boolean(item.reused_from)]), [[0, true], [1, false]]);
    result = run(fx.root, fx.args); assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).commands_run, 0);
  } finally { process.env.PATH = oldPath; }
});

test('coordinator mode runs only coordinator_only commands and the complete run reuses them', async () => {
  const fx = await diagnosticFixture(); const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${fx.bin}:${oldPath}`;
    const statePath = path.join(fx.stateRoot, fx.runId, 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    const manifest = JSON.parse(await readFile(state.manifest_file, 'utf8'));
    manifest.gate_testing.default.build.coordinator_only = [1];
    const content = JSON.stringify(manifest); state.manifest_sha256 = sha256(content);
    await writeFile(state.manifest_file, content); await writeFile(statePath, JSON.stringify(state));
    let result = run(fx.root, [...fx.args, '--advisory', '--coordinator']); assert.equal(result.status, 0, result.stderr);
    let output = JSON.parse(result.stdout);
    assert.equal(output.commands_run, 1); assert.match(output.evidence, /-coordinator\.json$/);
    result = run(fx.root, fx.args); assert.equal(result.status, 0, result.stderr);
    output = JSON.parse(result.stdout); assert.equal(output.commands_run, 1); assert.equal(output.commands_reused, 1);
    result = run(fx.root, [...fx.args, '--advisory', '--coordinator', '--affected']); assert.notEqual(result.status, 0);
  } finally { process.env.PATH = oldPath; }
});

test('a focused PASS never stands in for the complete authoritative set', async () => {
  const fx = await diagnosticFixture(); const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${fx.bin}:${oldPath}`;
    let result = run(fx.root, [...fx.args, '--advisory', '--affected']); assert.equal(result.status, 0, result.stderr);
    result = run(fx.root, fx.args); assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).commands_run, 2);
  } finally { process.env.PATH = oldPath; }
});

test('an advisory run stopped by its caller is INTERRUPTED and does not consume the no-progress fingerprint', async () => {
  const fx = await diagnosticFixture(); await attachPostgres(fx);
  await writeFile(path.join(fx.root, '.tmp/sleep'), 'yes');
  const args = [...fx.args, '--advisory', '--command-index', '0'];
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), RUNNER, ...args], { cwd: fx.root, env: { ...process.env, PATH: `${fx.bin}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; child.stderr.on('data', chunk => { errors += chunk; }); child.stdout.resume();
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve(code)); });
  let started = false;
  for (let count = 0; count < 100; count++) {
    try { await access(path.join(fx.root, '.tmp/test-started')); started = true; break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!started) child.kill('SIGKILL');
  assert.equal(started, true, errors);
  child.kill('SIGINT'); assert.equal(await done, 1, errors);
  const evidence = JSON.parse(await readFile(path.join(fx.stateRoot, fx.runId, 'checks/app-build.json'), 'utf8'));
  assert.equal(evidence.status, 'INTERRUPTED'); assert.equal(evidence.cleanup_complete, true);
  await unlink(path.join(fx.root, '.tmp/sleep'));
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${fx.bin}:${oldPath}`;
    const rerun = run(fx.root, args);
    assert.doesNotMatch(rerun.stderr, /DIAGNOSTIC_NO_PROGRESS/); assert.equal(rerun.status, 0, rerun.stderr);
  } finally { process.env.PATH = oldPath; }
});

test('frozen parallel groups run together and coordinator-only commands stay out of affected checks', async () => {
  const fx = await diagnosticFixture(); const oldPath = process.env.PATH;
  await writeFile(path.join(fx.bin, 'pnpm'), `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync('.tmp/calls.log', JSON.stringify(process.argv.slice(2)) + '\\n');
const until = Date.now() + 600; while (Date.now() < until) {}
`, { mode: 0o755 });
  try {
    process.env.PATH = `${fx.bin}:${oldPath}`;
    await patchTesting(fx, { parallel_groups: [[0, 1]] });
    let result = run(fx.root, fx.args); assert.equal(result.status, 0, result.stderr);
    const evidence = JSON.parse(await readFile(JSON.parse(result.stdout).evidence, 'utf8'));
    const [first, second] = evidence.results;
    assert.ok(Date.parse(second.started_at) < Date.parse(first.completed_at), 'grouped commands overlap');
    await patchTesting(fx, { coordinator_only: [1] });
    await writeFile(path.join(fx.root, 'src/web.ts'), 'changed\n');
    result = run(fx.root, [...fx.args, '--advisory', '--affected']); assert.equal(result.status, 0, result.stderr);
    const affected = JSON.parse(await readFile(JSON.parse(result.stdout).evidence, 'utf8'));
    assert.deepEqual(affected.results.map(item => item.command_index), [0]);
    await patchTesting(fx, { parallel_groups: [[0, 1, 0]] });
    result = run(fx.root, fx.args); assert.notEqual(result.status, 0); assert.match(result.stderr, /parallel_groups/);
  } finally { process.env.PATH = oldPath; }
});

// Fixture whose fake pnpm records the gate environment of every command it runs.
async function envFixture() {
  const fx = await diagnosticFixture();
  await writeFile(path.join(fx.root, 'bin/pnpm'), `#!/usr/bin/env node
const fs = require('node:fs');
const keys = ['PIPELINE_RUN_ID', 'PIPELINE_ID', 'PIPELINE_GATE', 'PIPELINE_GATE_ATTEMPT', 'CANDIDATE_SHA', 'PIPELINE_SCRATCH_DIR'];
const entry = Object.fromEntries(keys.map(key => [key, process.env[key] ?? null]));
entry.scratch_entries = process.env.PIPELINE_SCRATCH_DIR ? fs.readdirSync(process.env.PIPELINE_SCRATCH_DIR) : null;
if (process.env.PIPELINE_SCRATCH_DIR) fs.writeFileSync(process.env.PIPELINE_SCRATCH_DIR + '/marker', 'x');
fs.appendFileSync('.tmp/env.log', JSON.stringify(entry) + '\\n');
if (fs.existsSync('.tmp/fail')) { console.error('FAIL orders invariant'); process.exit(1); }
`, { mode: 0o755 });
  const git = (...args) => spawnSync('git', args, { cwd: fx.root, encoding: 'utf8' });
  git('checkout', '--', 'src/orders.ts');
  git('add', 'bin');
  const committed = git('commit', '-m', 'env pnpm');
  if (committed.status !== 0) assert.match(`${committed.stdout}\n${committed.stderr}`, /nothing (?:added to commit|to commit)/);
  const manifestFile = path.join(fx.stateRoot, fx.runId, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  manifest.git_setup = { base_sha: git('rev-parse', 'HEAD').stdout.trim() };
  const content = JSON.stringify(manifest);
  await writeFile(manifestFile, content);
  const statePath = path.join(fx.stateRoot, fx.runId, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8')); state.manifest_sha256 = sha256(content);
  await writeFile(statePath, JSON.stringify(state));
  return { ...fx, manifestFile, manifest, envLog: async () => (await readFile(path.join(fx.root, '.tmp/env.log'), 'utf8')).trim().split('\n').map(JSON.parse) };
}

test('gate commands get identity env, a fresh scratch dir per attempt and CANDIDATE_SHA only with a candidate', async () => {
  const fx = await envFixture(); const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${fx.bin}:${oldPath}`;
    const outer = process.env.CANDIDATE_SHA; process.env.CANDIDATE_SHA = 'f'.repeat(40);
    let result; try { result = run(fx.root, [...fx.args, '--advisory']); } finally { if (outer === undefined) delete process.env.CANDIDATE_SHA; else process.env.CANDIDATE_SHA = outer; }
    assert.equal(result.status, 0, result.stderr);
    let output = JSON.parse(result.stdout); let evidence = JSON.parse(await readFile(output.evidence, 'utf8'));
    assert.equal(evidence.attempt, 1);
    assert.equal(evidence.scratch_dir, path.join(fx.stateRoot, fx.runId, 'scratch', 'app-build-1'));
    assert.deepEqual((await fx.envLog())[0], { PIPELINE_RUN_ID: fx.runId, PIPELINE_ID: 'app', PIPELINE_GATE: 'build', PIPELINE_GATE_ATTEMPT: '1',
      CANDIDATE_SHA: null, PIPELINE_SCRATCH_DIR: evidence.scratch_dir, scratch_entries: [] });
    result = run(fx.root, [...fx.args, '--advisory', '--no-reuse']); assert.equal(result.status, 0, result.stderr);
    evidence = JSON.parse(await readFile(JSON.parse(result.stdout).evidence, 'utf8'));
    assert.equal(evidence.attempt, 2); assert.match(evidence.scratch_dir, /app-build-2$/);
    const log = await fx.envLog(); assert.equal(log.at(-1).PIPELINE_GATE_ATTEMPT, '2'); assert.deepEqual(log.at(-2).scratch_entries, []); assert.deepEqual(log.at(-1).scratch_entries, ['marker']);
    const candidate = 'a'.repeat(40);
    await writeFile(path.join(path.dirname(fx.manifestFile), 'candidate.json'), JSON.stringify({ candidate_sha: candidate }));
    result = run(fx.root, [...fx.args, '--no-reuse']); assert.equal(result.status, 0, result.stderr);
    output = JSON.parse(result.stdout); evidence = JSON.parse(await readFile(output.evidence, 'utf8'));
    assert.equal(evidence.attempt, 1); assert.equal((await fx.envLog()).at(-1).CANDIDATE_SHA, candidate);
  } finally { process.env.PATH = oldPath; }
});

test('gate env vars leave environment_digest unchanged so evidence reuse still works', async () => {
  const fx = await envFixture(); const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${fx.bin}:${oldPath}`;
    let result = run(fx.root, [...fx.args, '--advisory']); assert.equal(result.status, 0, result.stderr);
    const first = JSON.parse(await readFile(JSON.parse(result.stdout).evidence, 'utf8'));
    result = run(fx.root, [...fx.args, '--advisory', '--no-reuse']); assert.equal(result.status, 0, result.stderr);
    const second = JSON.parse(await readFile(JSON.parse(result.stdout).evidence, 'utf8'));
    assert.equal(second.attempt, 2); assert.equal(second.environment_digest, first.environment_digest);
    result = run(fx.root, fx.args); assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout); assert.equal(output.commands_run, 0); assert.match(output.reused_from, /checks\/app-build\.json$/);
    assert.equal(JSON.parse(await readFile(output.evidence, 'utf8')).scratch_dir, null);
  } finally { process.env.PATH = oldPath; }
});

test('a relevant inherited gate environment change invalidates reusable evidence', async () => {
  const fx = await diagnosticFixture(); const oldPath = process.env.PATH; const oldWorkers = process.env.PIPELINE_MAX_WORKERS;
  try {
    process.env.PATH = `${fx.bin}:${oldPath}`;
    process.env.PIPELINE_MAX_WORKERS = '2';
    let result = run(fx.root, fx.args); assert.equal(result.status, 0, result.stderr);
    const first = JSON.parse(await readFile(JSON.parse(result.stdout).evidence, 'utf8'));
    process.env.PIPELINE_MAX_WORKERS = '3';
    result = run(fx.root, fx.args); assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.commands_run, 2);
    const changed = JSON.parse(await readFile(output.evidence, 'utf8'));
    assert.notEqual(changed.environment_digest, first.environment_digest);
  } finally {
    process.env.PATH = oldPath;
    if (oldWorkers === undefined) delete process.env.PIPELINE_MAX_WORKERS; else process.env.PIPELINE_MAX_WORKERS = oldWorkers;
  }
});

test('lockfile changes invalidate evidence and keep affected selection broad', async () => {
  const fx = await diagnosticFixture(); const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${fx.bin}:${oldPath}`;
    let result = run(fx.root, fx.args); assert.equal(result.status, 0, result.stderr);
    await writeFile(path.join(fx.root, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n# changed\n');
    result = run(fx.root, [...fx.args, '--advisory', '--affected']); assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).commands_run, 2);
  } finally { process.env.PATH = oldPath; }
});

test('plan probe runs the complete frozen set statelessly and writes planning/probes evidence', async () => {
  const fx = await envFixture(); const oldPath = process.env.PATH;
  const probeArgs = ['--plan-probe', fx.manifestFile, 'app', 'build'];
  try {
    process.env.PATH = `${fx.bin}:${oldPath}`;
    await unlink(path.join(fx.stateRoot, fx.runId, 'state.json'));
    await writeFile(path.join(fx.root, 'src/orders.ts'), 'dirty\n');
    let result = run(fx.root, probeArgs);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /BASE_PROBE_REQUIRES_CLEAN_CHECKOUT/);
    assert.equal(spawnSync('git', ['checkout', '--', 'src/orders.ts'], { cwd: fx.root }).status, 0);
    result = run(fx.root, probeArgs); assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'PASS'); assert.equal(output.commands_run, 2); assert.equal(output.candidate_sha, null);
    assert.equal(output.evidence, path.join(path.dirname(fx.manifestFile), 'planning/probes/app-build.json'));
    const evidence = JSON.parse(await readFile(output.evidence, 'utf8'));
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: fx.root, encoding: 'utf8' }).stdout.trim();
    assert.deepEqual([evidence.kind, evidence.status, evidence.run_id, evidence.pipeline_id, evidence.gate, evidence.profile, evidence.head_sha, evidence.base_sha, evidence.error],
      ['plan_probe', 'PASS', fx.runId, 'app', 'build', 'default', head, head, null]);
    assert.equal(evidence.commands_sha256, sha256(JSON.stringify(fx.manifest.gate_profiles.default.build)));
    assert.equal(evidence.results.length, 2); assert.equal(evidence.results[1].command_index, 1);
    const env = (await fx.envLog())[0];
    assert.equal(env.PIPELINE_RUN_ID, fx.runId); assert.equal(env.CANDIDATE_SHA, null); assert.equal(env.PIPELINE_GATE_ATTEMPT, '1');
    assert.equal(env.PIPELINE_SCRATCH_DIR, evidence.scratch_dir); assert.equal(evidence.scratch_dir.startsWith(path.dirname(fx.manifestFile)), true);
    result = run(fx.root, probeArgs); assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(await readFile(output.evidence, 'utf8')).attempt, 2);
    assert.equal(JSON.parse(await readFile(output.evidence, 'utf8')).results.length, 2);
    await writeFile(path.join(fx.root, '.tmp/fail'), '');
    result = run(fx.root, probeArgs); assert.notEqual(result.status, 0);
    const failed = JSON.parse(await readFile(output.evidence, 'utf8'));
    assert.equal(failed.status, 'FAIL'); assert.match(failed.error, /gate command failed/);
    assert.ok(failed.results[0].failure_summary.length + failed.results[0].output_tail.length > 0);
  } finally { process.env.PATH = oldPath; }
});

test('PLAN live probe validates with a real phase lock before attempt/Docker, then executes statelessly', async () => {
  const fx = await envFixture();
  await attachPostgres(fx);
  const scriptDir = path.join(fx.root, 'scripts');
  await mkdir(scriptDir, { recursive: true });
  await writeFile(path.join(scriptDir, 'live-preflight.mjs'), String.raw`
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const location = '.tmp/pipelines/.runtime-locks';
const files = fs.readdirSync(location).filter(name => name.endsWith('.lock'));
if (files.length !== 1 || process.argv[2] !== '--pipeline-preflight') process.exit(11);
const lock = JSON.parse(fs.readFileSync(location + '/' + files[0], 'utf8'));
const raw = fs.readFileSync(lock.manifest_file);
const manifestHash = createHash('sha256').update(raw).digest('hex');
if (lock.phase !== 'plan_probe' || lock.pid !== process.ppid || lock.manifest_sha256 !== manifestHash ||
    !/^[a-f0-9]{64}$/.test(lock.input_digest) || !/^[a-f0-9]{40}$/.test(lock.head_sha) ||
    process.env.CANDIDATE_SHA || process.env.PIPELINE_GATE_ATTEMPT) process.exit(12);
fs.writeFileSync('.tmp/preflight-evidence.json', JSON.stringify(lock));
if (fs.existsSync('.tmp/reject-cheap')) process.exit(19);
`, 'utf8');

  const git = (...args) => spawnSync('git', args, { cwd: fx.root, encoding: 'utf8' });
  assert.equal(git('add', 'bin', 'scripts').status, 0);
  assert.equal(git('commit', '-m', 'live phase probe fixture').status, 0);
  const head = git('rev-parse', 'HEAD').stdout.trim();
  const manifest = JSON.parse(await readFile(fx.manifestFile, 'utf8'));
  manifest.git_setup.base_sha = head;
  manifest.gate_testing.default.build.live_postgres.preflight_command =
    'node scripts/live-preflight.mjs --pipeline-preflight';
  await writeFile(fx.manifestFile, JSON.stringify(manifest));
  await unlink(path.join(fx.stateRoot, fx.runId, 'state.json'));
  const oldPath = process.env.PATH, inherited = process.env.CANDIDATE_SHA;
  const args = ['--plan-probe', fx.manifestFile, 'app', 'build'];
  try {
    process.env.PATH = fx.bin + ':' + oldPath;
    process.env.CANDIDATE_SHA = 'f'.repeat(40);
    await writeFile(path.join(fx.root, '.tmp/reject-cheap'), 'yes');
    let result = run(fx.root, args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /PLAN_LIVE_PREFLIGHT_FAILED/);
    let evidence = JSON.parse(await readFile(path.join(fx.stateRoot, fx.runId, 'planning/probes/app-build.json'), 'utf8'));
    assert.deepEqual([evidence.phase, evidence.status, evidence.attempt, evidence.scratch_dir, evidence.candidate_sha, evidence.preflight_status],
      ['plan_probe', 'BLOCKED', null, null, null, 'FAIL']);
    await assert.rejects(access(path.join(fx.root, '.tmp/docker.log')), 'preflight failure must not call Docker');
    await assert.rejects(access(path.join(fx.stateRoot, '.runtime-locks', sha256('gate:' + fx.runId + ':app:build') + '.lock')));
    const preflight = JSON.parse(await readFile(path.join(fx.root, '.tmp/preflight-evidence.json'), 'utf8'));
    assert.equal(preflight.manifest_sha256, sha256(JSON.stringify(manifest)));
    assert.equal(preflight.head_sha, head);
    await unlink(path.join(fx.root, '.tmp/reject-cheap'));
    result = run(fx.root, args);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    evidence = JSON.parse(await readFile(output.evidence, 'utf8'));
    assert.equal(evidence.status, 'PASS');
    assert.equal(evidence.preflight_status, 'PASS');
    assert.equal(evidence.attempt, 1);
    assert.equal(evidence.candidate_sha, null);
    assert.equal(evidence.input_digest, preflight.input_digest);
    const calls = (await readFile(path.join(fx.root, '.tmp/docker.log'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(calls.some(x => x[0] === 'create'));
    assert.equal(calls.at(-1)[0], 'rm');
    await assert.rejects(access(path.join(fx.stateRoot, '.runtime-locks', sha256('gate:' + fx.runId + ':app:build') + '.lock')));
  } finally {
    process.env.PATH = oldPath;
    if (inherited === undefined) delete process.env.CANDIDATE_SHA; else process.env.CANDIDATE_SHA = inherited;
  }
});

test('deployed-service smoke reads exact completed deploy proof and refuses stale contour before commands', async () => {
  const fx = await diagnosticFixture(); const oldPath = process.env.PATH;
  try {
    process.env.PATH = fx.bin + ':' + oldPath;
    const stateFile = path.join(fx.stateRoot, fx.runId, 'state.json');
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    const manifest = JSON.parse(await readFile(state.manifest_file, 'utf8'));
    const sha = 'a'.repeat(40);
    manifest.git_setup.branch = 'feature/test';
    manifest.deploy_target = 'dev-test';
    manifest.pipelines[0].stages = ['deploy', 'smoke'];
    manifest.pipelines[0].executors = { deploy: 'dev_deploy', smoke: 'local_gate' };
    manifest.gate_profiles.default.smoke = [...manifest.gate_profiles.default.build];
    manifest.gate_testing.default.smoke = { input_kind: 'deployed-service' };
    const raw = JSON.stringify(manifest);
    state.manifest_sha256 = sha256(raw);
    state.pipelines = { app: { stages: { deploy: {
      status: 'completed', started_at: new Date(Date.now() - 30_000).toISOString(),
    } } } };
    await writeFile(state.manifest_file, raw);
    await writeFile(stateFile, JSON.stringify(state));
    const runDir = path.dirname(state.manifest_file);
    const deployState = path.join(fx.root, '.tmp', 'deploy-state');
    await mkdir(deployState, { recursive: true });
    const originalDeployDir = process.env.OPENCODE_DEPLOY_STATE_DIR;
    process.env.OPENCODE_DEPLOY_STATE_DIR = deployState;
    try {
      await writeFile(path.join(runDir, 'candidate.json'), JSON.stringify({
        status: 'PASS', run_id: fx.runId, branch: 'feature/test',
        manifest_sha256: state.manifest_sha256, candidate_sha: sha, remote_sha: sha,
      }));
      await mkdir(path.join(runDir, 'deploy'), { recursive: true });
      await writeFile(path.join(runDir, 'deploy/app-deploy.json'), JSON.stringify({
        status: 'PASS', run_id: fx.runId, pipeline_id: 'app', stage: 'deploy',
        target: 'dev-test', candidate_sha: sha,
      }));
      const statusFile = path.join(deployState, 'dev-test.status.json');
      await writeFile(statusFile, JSON.stringify({ sha, health: 'ok' }));
      const install = { key: 'dev-test', sha, exit_code: 0,
        finished_at: new Date().toISOString(), status_file: statusFile };
      await writeFile(path.join(deployState, 'dev-test.json'), JSON.stringify(install));
      const args = [fx.runId, 'app', 'smoke', '--state-root', fx.stateRoot, '--no-reuse'];
      // The command must receive the verified contour key, not an inherited
      // or hand-selected target; commands that target a different contour fail.
      const binFile = path.join(fx.bin, 'pnpm');
      const binContent = await readFile(binFile, 'utf8');
      assert.match(binContent, /const fs = require\('node:fs'\)/);
      await writeFile(binFile, binContent.replace("const fs = require('node:fs');",
        "if (process.env.PIPELINE_DEPLOY_TARGET !== 'dev-test') process.exit(42);\nconst fs = require('node:fs');"), { mode: 0o755 });
      let result = run(fx.root, args);
      assert.equal(result.status, 0, result.stderr);
      const data = JSON.parse(await readFile(JSON.parse(result.stdout).evidence, 'utf8'));
      assert.equal(data.deployed_service.installed_sha, sha);
      assert.equal(data.deployed_service.target, 'dev-test');
      await writeFile(path.join(deployState, 'dev-test.json'), JSON.stringify({ ...install, sha: 'b'.repeat(40) }));
      result = run(fx.root, args);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /GATE_SERVICE_INSTALL_CHANGED/);
      await writeFile(path.join(deployState, 'dev-test.json'), JSON.stringify(install));
      state.pipelines.app.stages.deploy.status = 'pending';
      await writeFile(stateFile, JSON.stringify(state));
      result = run(fx.root, args);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /GATE_SERVICE_DEPLOY_INCOMPLETE/);
      // A target that changes DURING an otherwise passing smoke must not emit PASS.
      state.pipelines.app.stages.deploy.status = 'completed';
      await writeFile(stateFile, JSON.stringify(state));
      await writeFile(path.join(fx.bin, 'pnpm'), `#!/usr/bin/env node
const fs = require('node:fs');
const p = '.tmp/deploy-state/dev-test.json';
const data = JSON.parse(fs.readFileSync(p, 'utf8'));
data.sha = 'c'.repeat(40);
fs.writeFileSync(p, JSON.stringify(data));
`, { mode: 0o755 });
      result = run(fx.root, args);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /GATE_SERVICE_CHANGED_DURING_GATE/);
      const smokeEvidence = JSON.parse(await readFile(path.join(fx.stateRoot, fx.runId, 'gates/app-smoke.json'), 'utf8'));
      assert.equal(smokeEvidence.status, 'BLOCKED');
    } finally {
      if (originalDeployDir === undefined) delete process.env.OPENCODE_DEPLOY_STATE_DIR;
      else process.env.OPENCODE_DEPLOY_STATE_DIR = originalDeployDir;
    }
  } finally { process.env.PATH = oldPath; }
});

test('plan probe refuses candidate-sha and deployment gates and unknown pipelines', async () => {
  const candidate = await makeRun('bash scripts/install.sh {candidate_sha}', 'verify');
  const manifestFile = path.join(candidate.root, 'manifest.json');
  let result = run(candidate.root, ['--plan-probe', manifestFile, 'app', 'verify']);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /PLAN_PROBE_UNSUPPORTED: .*candidate_sha/);
  // Position decides, not the name: a gate without a later git_publish is pre-publish, deployment gates never are.
  const runtime = await makeRun('bash -n check.sh', 'deploy_validation');
  result = run(runtime.root, ['--plan-probe', path.join(runtime.root, 'manifest.json'), 'app', 'deploy_validation']);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /PLAN_PROBE_UNSUPPORTED: deploy_validation is not a pre-publish local gate/);
  result = run(runtime.root, ['--plan-probe', path.join(runtime.root, 'manifest.json'), 'nope', 'build']);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /pipeline not found/);
  result = run(runtime.root, ['--plan-probe', path.join(runtime.root, 'manifest.json'), 'app']);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /usage/);
});

test('a later RUN over the same tree reuses the gate commands an earlier RUN passed', async () => {
  const fx = await diagnosticFixture(); const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${fx.bin}:${oldPath}`;
    let result = run(fx.root, fx.args); assert.equal(result.status, 0, result.stderr);
    const first = JSON.parse(result.stdout);
    assert.equal(first.commands_run, 2);
    // A delivery-only RUN: another run id, another pipeline id, the same frozen commands and tree.
    const state = JSON.parse(await readFile(path.join(fx.stateRoot, fx.runId, 'state.json'), 'utf8'));
    const manifest = JSON.parse(await readFile(state.manifest_file, 'utf8'));
    const runDir = path.join(fx.stateRoot, 'delivery-run'); await mkdir(runDir, { recursive: true });
    const content = JSON.stringify({ ...manifest, run_id: 'delivery-run', pipelines: manifest.pipelines.map(item => ({ ...item, id: 'sink' })) });
    await writeFile(path.join(runDir, 'manifest.json'), content);
    await writeFile(path.join(runDir, 'state.json'), JSON.stringify({ ...state, run_id: 'delivery-run', manifest_file: path.join(runDir, 'manifest.json'), manifest_sha256: sha256(content) }));
    result = run(fx.root, ['delivery-run', 'sink', 'build', '--state-root', fx.stateRoot]); assert.equal(result.status, 0, result.stderr);
    const second = JSON.parse(result.stdout);
    assert.equal(second.commands_run, 0); assert.equal(second.commands_reused, 2);
    assert.equal(second.reused_from, first.evidence);
  } finally { process.env.PATH = oldPath; }
});
