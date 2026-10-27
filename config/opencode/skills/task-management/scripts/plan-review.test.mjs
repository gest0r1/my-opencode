import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STAGE_CLI = path.join(HERE, 'stage-cli.ts');

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plan-review-'));
  const stateRoot = path.join(root, '.tmp', 'pipelines');
  const runDir = path.join(stateRoot, 'plan-run');
  await mkdir(path.join(runDir, 'reviews'), { recursive: true });
  let seq = 0;
  const cli = (...args) => spawnSync('npx', ['--yes', 'tsx', STAGE_CLI, 'plan-review', 'plan-run', ...args, '--state-root', stateRoot, '--json'],
    { cwd: root, encoding: 'utf8', env: process.env });
  const review = async (body) => {
    const file = path.join(runDir, 'reviews', `technical-${++seq}.md`);
    await writeFile(file, typeof body === 'string' ? body : JSON.stringify(body));
    return file;
  };
  return { root, stateRoot, runDir, cli, review };
}

test('plan reviews are counted by the ledger: three autonomous revisions, then the owner', async () => {
  const fx = await fixture();
  let result = fx.cli('technical', '--evidence', await fx.review('status: needs_revision\nblockers:\n- exit codes differ\n'), '--defect-class', 'exit-code-drift');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).needs_revision, 1);
  const same = path.join(fx.runDir, 'reviews', 'technical-1.md');
  result = fx.cli('technical', '--evidence', same); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).reviews, 1, 'recording the same verdict twice is idempotent');
  result = fx.cli('technical', '--evidence', await fx.review({ status: 'needs_revision', findings: [{ defect_class: 'lock-owner-unclear' }] }));
  assert.equal(result.status, 0, result.stderr);
  result = fx.cli('technical', '--evidence', await fx.review('**status:** needs_revision\n'));
  assert.notEqual(result.status, 0); assert.match(result.stderr, /PLAN_REVIEW_LIMIT: technical had 3 autonomous revisions/);
  result = fx.cli('technical', '--evidence', await fx.review('status: ready\n'));
  assert.match(result.stderr, /PLAN_REVIEW_LIMIT/);
  result = fx.cli('technical', '--owner-continue', ' ');
  assert.match(result.stderr, /owner's words/);
  result = fx.cli('technical', '--owner-continue', 'продолжай');
  assert.equal(result.status, 0, result.stderr);
  result = fx.cli('technical', '--evidence', path.join(fx.runDir, 'reviews', 'technical-4.md'));
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, 'ready'); assert.equal(summary.reviews, 1); assert.equal(summary.total_reviews, 4);
  result = fx.cli('technical', '--evidence', await fx.review('looks fine'));
  assert.match(result.stderr, /PLAN_REVIEW_STATUS_REQUIRED/);
  result = fx.cli('technical', '--evidence', path.join(fx.root, 'outside.md'));
  assert.match(result.stderr, /inside the current run directory/);
});

test('a class repeated by consecutive plan reviews needs recorded research before the next review', async () => {
  const fx = await fixture();
  let result = fx.cli('architecture', '--evidence', await fx.review({ status: 'needs_revision', defect_classes: ['own-archive-parser'] }));
  assert.equal(result.status, 0, result.stderr);
  result = fx.cli('architecture', '--evidence', await fx.review({ status: 'needs_revision', defect_classes: ['own-archive-parser', 'typo'] }));
  assert.notEqual(result.status, 0); assert.match(result.stderr, /PLAN_CLASS_RECURRENCE: architecture classes=own-archive-parser/);
  result = fx.cli('architecture', '--evidence', await fx.review('status: ready\n'));
  assert.match(result.stderr, /PLAN_CLASS_RESEARCH_REQUIRED: architecture classes=own-archive-parser/);
  result = fx.cli('architecture', '--research', path.join(fx.runDir, 'missing.md'));
  assert.match(result.stderr, /research is missing or empty/);
  const research = path.join(fx.runDir, 'planning', 'research', 'class-own-archive-parser-v1.md');
  await mkdir(path.dirname(research), { recursive: true });
  await writeFile(research, 'docker save emits the hybrid layout since 25.0; docker load reads it\n');
  result = fx.cli('architecture', '--research', research); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).class_research_due, []);
  result = fx.cli('architecture', '--research', research); assert.match(result.stderr, /PLAN_CLASS_RESEARCH_NOT_DUE/);
  result = fx.cli('architecture', '--evidence', path.join(fx.runDir, 'reviews', 'technical-3.md'));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'ready');
  const ledger = JSON.parse(await readFile(path.join(fx.runDir, 'planning', 'review-ledger.json'), 'utf8'));
  assert.deepEqual(ledger.entries.map((entry) => entry.kind), ['review', 'review', 'research', 'review']);
});

test('plan-run-preflight binds each frozen gate review to the ledger\'s last ready verdict', async () => {
  const fx = await fixture();
  const ready = await fx.review('status: ready\n');
  const manifestPath = path.join(fx.runDir, 'manifest.json');
  const check = async (reviewSha) => {
    await writeFile(manifestPath, JSON.stringify({ planning_readiness: { required_gates: ['technical'],
      gates: { technical: { review: { path: 'reviews/technical-1.md', sha256: reviewSha } } } } }));
    const code = `import(${JSON.stringify(path.join(HERE, 'plan-review.ts'))}).then(async (m) => { const fs = await import('node:fs'); m.assertPlanReviewLedger(JSON.parse(fs.readFileSync(${JSON.stringify(manifestPath)}, 'utf8')), ${JSON.stringify(manifestPath)}); })`;
    return spawnSync('npx', ['--yes', 'tsx', '-e', code], { cwd: fx.root, encoding: 'utf8', env: process.env });
  };
  const { createHash } = await import('node:crypto');
  const sha = createHash('sha256').update(await readFile(ready, 'utf8')).digest('hex');
  let result = await check(sha);
  assert.equal(result.status, 0, 'no ledger: nothing to bind (older plans)');
  result = fx.cli('architecture', '--evidence', await fx.review('status: ready\n# architecture\n')); assert.equal(result.status, 0, result.stderr);
  result = await check(sha);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /PLAN_REVIEW_LEDGER_MISSING: technical/);
  result = fx.cli('technical', '--evidence', await fx.review('status: needs_revision\n')); assert.equal(result.status, 0, result.stderr);
  result = await check(sha);
  assert.match(result.stderr, /PLAN_REVIEW_LEDGER_MISMATCH: technical/);
  result = fx.cli('technical', '--evidence', ready); assert.equal(result.status, 0, result.stderr);
  result = await check(sha);
  assert.equal(result.status, 0, result.stderr);
});
