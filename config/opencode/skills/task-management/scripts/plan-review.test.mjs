import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  const file = async (name, body) => {
    const target = path.join(runDir, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, typeof body === 'string' ? body : JSON.stringify(body));
    return target;
  };
  const review = (body) => file(`reviews/review-${++seq}.md`, body);
  const ok = (result) => { assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
  return { root, runDir, cli, file, review, ok };
}

test('after three revisions the gate escalates to research and a rework, then carries technical findings without the owner', async () => {
  const fx = await fixture();
  let state = fx.ok(fx.cli('technical', '--evidence', await fx.review('status: needs_revision\nreview_scope: full\nblockers:\n- technical_fix [exit-code-drift]: codes differ\n')));
  assert.equal(state.next, 'revise');
  const first = path.join(fx.runDir, 'reviews', 'review-1.md');
  assert.equal(fx.ok(fx.cli('technical', '--evidence', first)).reviews, 1, 'recording the same verdict twice is idempotent');
  fx.ok(fx.cli('technical', '--evidence', await fx.review({ status: 'needs_revision', review_scope: 'delta', findings: [{ defect_class: 'lock-owner-unclear' }] })));
  state = fx.ok(fx.cli('technical', '--evidence', await fx.review('**status:** needs_revision\n**review_scope:** delta\n')));
  assert.equal(state.escalation_due, true); assert.equal(state.next, 'research_then_rework');
  let result = fx.cli('technical', '--evidence', await fx.review('status: ready\nreview_scope: full\n'));
  assert.match(result.stderr, /PLAN_RESEARCH_REQUIRED: technical 3 revisions did not converge/);
  result = fx.cli('technical', '--carry', await fx.file('carried.md', '- lock owner'));
  assert.match(result.stderr, /PLAN_CARRY_NOT_ALLOWED/);
  state = fx.ok(fx.cli('technical', '--research', await fx.file('planning/research/escalation-technical-v1.md', 'why it does not converge\n')));
  assert.equal(state.next, 'revise');
  // The rework is reviewed in full; open technical findings are carried into RUN instead of stopping.
  state = fx.ok(fx.cli('technical', '--evidence', await fx.review('status: needs_revision\nreview_scope: full\nblockers:\n- technical_fix [lock-scope]: scratch lock\n')));
  assert.equal(state.next, 'revise_or_carry'); assert.equal(state.owner_decision, false);
  state = fx.ok(fx.cli('technical', '--carry', await fx.file('planning/carried-findings-technical.md', '- lock-scope: verify in RUN review\n')));
  assert.equal(state.status, 'carried'); assert.equal(state.next, 'freeze_with_carried_findings');
  result = fx.cli('technical', '--evidence', await fx.review('looks fine'));
  assert.match(result.stderr, /PLAN_REVIEW_STATUS_REQUIRED/);
  result = fx.cli('technical', '--evidence', await fx.review('status: ready\n'));
  assert.match(result.stderr, /PLAN_REVIEW_SCOPE_REQUIRED/);
  result = fx.cli('technical', '--evidence', path.join(fx.root, 'outside.md'));
  assert.match(result.stderr, /inside the current run directory/);
});

test('only a finding that changes a decision or a business story stops the gate; it is never carried', async () => {
  const fx = await fixture();
  let state = fx.ok(fx.cli('architecture', '--evidence', await fx.review('status: needs_revision\nreview_scope: full\nblockers:\n- replan [delivery-mode]: the owner must choose CI or no CI\n')));
  assert.equal(state.owner_decision, true); assert.equal(state.next, 'owner_decision');
  const result = fx.cli('architecture', '--carry', await fx.file('carried.md', 'x'));
  assert.match(result.stderr, /PLAN_OWNER_DECISION_REQUIRED/);
  state = fx.ok(fx.cli('architecture', '--evidence', await fx.review({ status: 'needs_revision', review_scope: 'full',
    findings: [{ classification: 'technical_fix', defect_class: 'exit-codes' }] })));
  assert.equal(state.owner_decision, false);
});

test('a class repeated by consecutive plan reviews needs recorded research before the next review', async () => {
  const fx = await fixture();
  fx.ok(fx.cli('architecture', '--evidence', await fx.review({ status: 'needs_revision', review_scope: 'full', defect_classes: ['own-archive-parser'] })));
  let state = fx.ok(fx.cli('architecture', '--evidence', await fx.review({ status: 'needs_revision', review_scope: 'delta', defect_classes: ['own-archive-parser', 'typo'] })));
  assert.deepEqual(state.class_research_due, ['own-archive-parser']);
  let result = fx.cli('architecture', '--evidence', await fx.review('status: ready\nreview_scope: full\n'));
  assert.match(result.stderr, /PLAN_RESEARCH_REQUIRED: architecture classes=own-archive-parser/);
  result = fx.cli('architecture', '--research', path.join(fx.runDir, 'missing.md'));
  assert.match(result.stderr, /research is missing or empty/);
  const research = await fx.file('planning/research/class-own-archive-parser-v1.md', 'docker save emits the hybrid layout since 25.0; docker load reads it\n');
  fx.ok(fx.cli('architecture', '--research', research));
  result = fx.cli('architecture', '--research', research); assert.match(result.stderr, /PLAN_RESEARCH_NOT_DUE/);
  // A ready delta review is not enough to freeze; the closing review is full.
  state = fx.ok(fx.cli('architecture', '--evidence', await fx.review('status: ready\nreview_scope: delta\n')));
  assert.equal(state.next, 'full_review');
  state = fx.ok(fx.cli('architecture', '--evidence', await fx.review('status: ready\nreview_scope: full\n')));
  assert.equal(state.next, 'freeze');
  const ledger = JSON.parse(await readFile(path.join(fx.runDir, 'planning', 'review-ledger.json'), 'utf8'));
  assert.deepEqual(ledger.entries.map((entry) => entry.kind), ['review', 'review', 'research', 'review', 'review']);
});

test('plan-run-preflight binds each frozen gate review to the ledger: full ready or carried and frozen', async () => {
  const fx = await fixture();
  const manifestPath = path.join(fx.runDir, 'manifest.json');
  const check = async (reviewFile, carried = []) => {
    const sha = createHash('sha256').update(await readFile(reviewFile, 'utf8')).digest('hex');
    await writeFile(manifestPath, JSON.stringify({ planning_readiness: { required_gates: ['technical'], carried_findings: carried,
      gates: { technical: { review: { path: path.relative(fx.runDir, reviewFile), sha256: sha } } } } }));
    const code = `import(${JSON.stringify(path.join(HERE, 'plan-review.ts'))}).then(async (m) => { const fs = await import('node:fs'); m.assertPlanReviewLedger(JSON.parse(fs.readFileSync(${JSON.stringify(manifestPath)}, 'utf8')), ${JSON.stringify(manifestPath)}); })`;
    return spawnSync('npx', ['--yes', 'tsx', '-e', code], { cwd: fx.root, encoding: 'utf8', env: process.env });
  };
  const delta = await fx.review('status: ready\nreview_scope: delta\n');
  let result = await check(delta);
  assert.equal(result.status, 0, 'no ledger: nothing to bind (older plans)');
  fx.ok(fx.cli('architecture', '--evidence', await fx.review('status: ready\nreview_scope: full\n# architecture\n')));
  result = await check(delta);
  assert.match(result.stderr, /PLAN_REVIEW_LEDGER_MISSING: technical/);
  fx.ok(fx.cli('technical', '--evidence', delta));
  result = await check(delta);
  assert.match(result.stderr, /PLAN_REVIEW_NOT_FREEZABLE: technical next=full_review/);
  const full = await fx.review('status: ready\nreview_scope: full\n');
  fx.ok(fx.cli('technical', '--evidence', full));
  result = await check(delta);
  assert.match(result.stderr, /PLAN_REVIEW_LEDGER_MISMATCH: technical/);
  result = await check(full);
  assert.equal(result.status, 0, result.stderr);
});

test('a gate frozen with carried findings needs them in planning_readiness.carried_findings', async () => {
  const fx = await fixture();
  for (let index = 0; index < 3; index += 1) fx.ok(fx.cli('technical', '--evidence', await fx.review(`status: needs_revision\nreview_scope: full\n# ${index}\n`)));
  fx.ok(fx.cli('technical', '--research', await fx.file('planning/research/escalation.md', 'evidence\n')));
  const last = await fx.review('status: needs_revision\nreview_scope: full\nblockers:\n- technical_fix [lock-scope]: x\n');
  fx.ok(fx.cli('technical', '--evidence', last));
  const carried = await fx.file('planning/carried-findings-technical.md', '- lock-scope\n');
  fx.ok(fx.cli('technical', '--carry', carried));
  const sha = (text) => createHash('sha256').update(text).digest('hex');
  const manifestPath = path.join(fx.runDir, 'manifest.json');
  const check = async (carriedList) => {
    await writeFile(manifestPath, JSON.stringify({ planning_readiness: { required_gates: ['technical'], carried_findings: carriedList,
      gates: { technical: { review: { path: 'reviews/review-4.md', sha256: sha(await readFile(last, 'utf8')) } } } } }));
    const code = `import(${JSON.stringify(path.join(HERE, 'plan-review.ts'))}).then(async (m) => { const fs = await import('node:fs'); m.assertPlanReviewLedger(JSON.parse(fs.readFileSync(${JSON.stringify(manifestPath)}, 'utf8')), ${JSON.stringify(manifestPath)}); })`;
    return spawnSync('npx', ['--yes', 'tsx', '-e', code], { cwd: fx.root, encoding: 'utf8', env: process.env });
  };
  let result = await check([]);
  assert.match(result.stderr, /PLAN_CARRIED_FINDINGS_NOT_FROZEN: technical/);
  result = await check([{ path: 'planning/carried-findings-technical.md', sha256: sha(await readFile(carried, 'utf8')) }]);
  assert.equal(result.status, 0, result.stderr);
});
