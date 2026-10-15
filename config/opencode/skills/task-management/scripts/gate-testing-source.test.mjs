import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveGateTesting, selectAffectedCommands, validateGateTesting } from './gate-testing-policy.mjs';
import { freezeGateTesting } from './gate-testing-freeze.mjs';

const commands = ['pnpm run typecheck', 'pnpm exec vitest run apps/api', 'pnpm exec vitest run apps/web'];
const map = {
  coordinator_only: [0],
  impact_groups: [
    { inputs: ['apps/api/src/orders.ts', 'apps/api/test/orders.test.ts'], command_index: 1, test_files: ['apps/api/test/orders.test.ts'] },
    { inputs: ['apps/web/src/page.tsx'], command_index: 2, test_files: ['apps/web/src/test/page.test.tsx'] },
    { inputs: ['apps/api/src/orders.ts', 'apps/web/src/page.tsx'], command_index: 0 },
  ],
};
const ignored = { ignored_input_rules: [{ pattern: 'docs/**', except: ['docs/testing/**'] }, '**/*.md'] };

test('ignored inputs select nothing; docs/testing stays mapped', () => {
  const config = { ...map, ignored_inputs: ignored.ignored_input_rules };
  assert.equal(selectAffectedCommands(commands, config, ['docs/features/a.md', 'README.md']).selected.length, 0);
  assert.equal(selectAffectedCommands(commands, config, ['docs/testing/blocks.json']).reason, 'unmapped change');
});

test('a new test file runs alone with the command owning its directory', () => {
  const selection = selectAffectedCommands(commands, map, ['apps/api/test/refunds.test.ts'], [], { isNew: () => true });
  assert.deepEqual(selection.selected.map(item => [item.index, item.test_files]), [[1, ['apps/api/test/refunds.test.ts']]]);
  const globbed = { impact_groups: [...map.impact_groups, { inputs: ['apps/api/**'], command_index: 0 }], coordinator_only: [0] };
  const viaGlob = selectAffectedCommands(commands, globbed, ['apps/api/test/refunds.test.ts'], [], { isNew: () => true });
  assert.deepEqual(viaGlob.selected.map(item => [item.index, item.test_files]), [[1, ['apps/api/test/refunds.test.ts']]]);
});

test('a new source file is reached through changed mapped importers; alone it runs the full set', () => {
  const isNew = file => file === 'apps/api/src/refunds.ts';
  let selection = selectAffectedCommands(commands, map, ['apps/api/src/refunds.ts', 'apps/api/src/orders.ts'], [], { isNew });
  assert.deepEqual(selection.selected.map(item => item.index), [1]);
  assert.deepEqual(selection.deferred, [0]);
  selection = selectAffectedCommands(commands, map, ['apps/api/src/refunds.ts'], [], { isNew });
  assert.equal(selection.reason, 'unmapped change');
  selection = selectAffectedCommands(commands, map, ['apps/api/src/legacy.ts', 'apps/api/src/orders.ts']);
  assert.equal(selection.reason, 'unmapped change');
});

async function fixture() {
  const repo = await mkdtemp(join(tmpdir(), 'gate-source-'));
  const run = join(repo, '.tmp/pipelines/r1');
  await mkdir(join(repo, 'docs/testing'), { recursive: true });
  await mkdir(run, { recursive: true });
  await writeFile(join(repo, 'docs/testing/gate.json'), JSON.stringify(map));
  await writeFile(join(repo, 'docs/testing/commands.json'), JSON.stringify({ gate_profiles: { release: { 'fail-fast': commands } } }));
  await writeFile(join(repo, 'docs/testing/blocks.json'), JSON.stringify(ignored));
  const manifest = { run_id: 'r1', gate_profiles: { app: { 'fail-fast': commands } }, gate_testing: { app: { 'fail-fast': { timeout_seconds: 900 } } } };
  const manifestPath = join(run, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { repo, run, manifestPath };
}

test('freeze copies the project map into the run and every reader resolves the same groups', async () => {
  const fx = await fixture();
  const result = freezeGateTesting({ manifestPath: fx.manifestPath, profile: 'app', gate: 'fail-fast', source: 'docs/testing/gate.json',
    commands: 'docs/testing/commands.json', ignored: 'docs/testing/blocks.json', cwd: fx.repo });
  assert.equal(result.impact_groups, 3);
  const manifest = JSON.parse(await readFile(fx.manifestPath, 'utf8'));
  const entry = manifest.gate_testing.app['fail-fast'];
  assert.equal(entry.timeout_seconds, 900);
  assert.equal(entry.impact_groups, undefined);
  const resolved = resolveGateTesting(manifest, fx.run).gate_testing.app['fail-fast'];
  assert.equal(resolved.impact_groups.length, 3);
  assert.deepEqual(resolved.coordinator_only, [0]);
  assert.equal(resolved.ignored_inputs.length, 2);
  validateGateTesting(resolveGateTesting(manifest, fx.run));

  await writeFile(join(fx.run, entry.source.snapshot), JSON.stringify({ impact_groups: [] }));
  assert.throws(() => resolveGateTesting(manifest, fx.run), /GATE_TESTING_SOURCE_CHANGED/);
});

test('freeze refuses a map built for another command array, and the snapshot pins the commands', async () => {
  const fx = await fixture();
  await writeFile(join(fx.repo, 'docs/testing/commands.json'), JSON.stringify({ gate_profiles: { release: { 'fail-fast': ['other'] } } }));
  assert.throws(() => freezeGateTesting({ manifestPath: fx.manifestPath, profile: 'app', gate: 'fail-fast', source: 'docs/testing/gate.json',
    commands: 'docs/testing/commands.json', cwd: fx.repo }), /GATE_TESTING_FREEZE_COMMANDS_MISMATCH/);
  await writeFile(join(fx.repo, 'docs/testing/commands.json'), JSON.stringify(commands));
  freezeGateTesting({ manifestPath: fx.manifestPath, profile: 'app', gate: 'fail-fast', source: 'docs/testing/gate.json', commands: 'docs/testing/commands.json', cwd: fx.repo });
  const manifest = JSON.parse(await readFile(fx.manifestPath, 'utf8'));
  manifest.gate_profiles.app['fail-fast'] = [...commands, 'pnpm run lint'];
  assert.throws(() => resolveGateTesting(manifest, fx.run), /GATE_TESTING_SOURCE_COMMANDS_CHANGED/);
});
