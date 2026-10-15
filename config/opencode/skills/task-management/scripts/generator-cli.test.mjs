import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generatorCommandError, runGenerator, validateGenerators } from './generator-cli.mjs';
import { redundantGateCommands } from './manifest-preflight.mjs';

test('generator commands are limited to repository scripts and package scripts', () => {
  assert.equal(generatorCommandError('node --import tsx scripts/testing/test-blocks.ts --write'), undefined);
  assert.equal(generatorCommandError('corepack pnpm run test-blocks:write'), undefined);
  assert.match(generatorCommandError('node -e "process.exit(0)"'), /repository script/);
  assert.match(generatorCommandError('bash scripts/x.sh'), /generators may run/);
  assert.match(generatorCommandError('node ../outside.mjs'), /repository script/);
  assert.throws(() => validateGenerators({ generators: [{ id: 'g', write: 'node scripts/g.mjs', outputs: ['.github/x.yml'] }] }), /outputs/);
  assert.throws(() => validateGenerators({ generators: [{ id: 'g', write: 'node scripts/g.mjs', outputs: ['docs/x.json'], shell: true }] }), /unknown keys/);
});

test('stage-cli generate runs the frozen write and check commands and records evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'generator-'));
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'scripts/gen.mjs'), "import { writeFileSync, readFileSync } from 'node:fs';\nif (process.argv.includes('--check')) process.exit(readFileSync('out.json', 'utf8') === '{}' ? 0 : 1);\nwriteFileSync('out.json', '{}');\n");
  const run = join(root, '.tmp/pipelines/r1'); await mkdir(run, { recursive: true });
  const manifest = JSON.stringify({ generators: [{ id: 'blocks', write: 'node scripts/gen.mjs', check: 'node scripts/gen.mjs --check', outputs: ['out.json'] }] });
  await writeFile(join(run, 'manifest.json'), manifest);
  await writeFile(join(run, 'state.json'), JSON.stringify({ manifest_file: join(run, 'manifest.json'), manifest_sha256: createHash('sha256').update(manifest).digest('hex') }));
  const result = runGenerator({ stateRoot: join(root, '.tmp/pipelines'), runId: 'r1', id: 'blocks', cwd: root });
  assert.equal(result.status, 'PASS');
  assert.equal(await readFile(join(root, 'out.json'), 'utf8'), '{}');
  assert.equal(JSON.parse(await readFile(result.evidence, 'utf8')).results.length, 2);
  assert.throws(() => runGenerator({ stateRoot: join(root, '.tmp/pipelines'), runId: 'r1', id: 'other', cwd: root }), /GENERATOR_UNKNOWN/);
});

test('repeated or contained frozen commands are found', () => {
  const web = 'corepack pnpm exec vitest run --root apps/web --config vitest.config.ts --passWithNoTests=false';
  const narrowed = 'corepack pnpm exec vitest run --root apps/web --config vitest.config.ts src/test/a.test.tsx --passWithNoTests=false';
  assert.deepEqual(redundantGateCommands(['pnpm run lint', web, narrowed, narrowed]), ['2 is a subset of 1', '3 is a subset of 1', '3 repeats 2']);
  assert.deepEqual(redundantGateCommands(['pnpm run lint', web]), []);
});
