import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateGateManifest } from './manifest-preflight.mjs';
import { readRoleEditPolicy, roleCanEdit, validateWorkItemOutputContract,
  verifyCompletedWorkItemOutputs } from './work-item-output-policy.mjs';

const sha = raw => createHash('sha256').update(raw).digest('hex');
const policy = (name, edit) => `---\nname: ${name}\npermission:\n  edit:\n${edit}\n---\n`;

test('PLAN rejects DocWriter run-local output under deny and permits scoped documentation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'o10-policy-'));
  try {
    const dir = join(root, 'agents');
    await mkdir(dir);
    await writeFile(join(dir, 'DocWriter.md'), policy('DocWriter',
      '    "*": deny\n    "**/*.md": allow\n    ".tmp/pipelines/**": deny'));
    const opts = { policyDir: dir, cache: new Map() };
    const manifest = { work_item_output_contract_version: 1, allowed_change_paths: ['.tmp/pipelines/**', 'docs/**'] };
    const record = { id: 'doc', stage: 'impl', suggested_agent: 'DocWriter',
      allowed_change_paths: ['.tmp/pipelines/**', 'docs/**'] };
    assert.throws(() => validateWorkItemOutputContract(record, manifest, opts),
      /WORK_ITEM_OUTPUT_DECLARATION_REQUIRED/);
    record.required_outputs = ['.tmp/pipelines/run/validation/report.md'];
    assert.throws(() => validateWorkItemOutputContract(record, manifest, opts),
      /WORK_ITEM_OUTPUT_ROLE_DENIED/);
    record.required_outputs = ['docs/overview.md'];
    assert.doesNotThrow(() => validateWorkItemOutputContract(record, manifest, opts));
    record.required_outputs = ['docs/overview.md', '../private/secret.md'];
    assert.throws(() => validateWorkItemOutputContract(record, manifest, opts),
      /WORK_ITEM_OUTPUT_PATH_INVALID/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('PLAN honors specific TestEngineer allowance above broad machine-state deny', async () => {
  const root = await mkdtemp(join(tmpdir(), 'o10-test-policy-'));
  try {
    await writeFile(join(root, 'TestEngineer.md'), policy('TestEngineer',
      '    "*": allow\n    ".tmp/pipelines/**": deny\n    ".tmp/pipelines/*/planning/test-assessment-*.md": allow'));
    const rules = readRoleEditPolicy('TestEngineer', { policyDir: root });
    assert.ok(roleCanEdit(rules, '.tmp/pipelines/run/planning/test-assessment-api.md'));
    assert.ok(!roleCanEdit(rules, '.tmp/pipelines/run/validation/result.md'));
    assert.ok(roleCanEdit(rules, 'tests/api.test.ts'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('RUN refuses missing, empty, stale and foreign output; accepts valid frozen output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'o10-output-'));
  try {
    const dir = join(root, '.tmp', 'pipelines', 'run');
    await mkdir(join(dir, 'work-items'), { recursive: true });
    await mkdir(join(root, 'docs'), { recursive: true });
    const record = { id: 'wi-doc', pipeline_id: 'p', stage: 'implementation',
      suggested_agent: 'DocWriter', allowed_change_paths: ['docs/**'],
      required_outputs: ['docs/result.md'] };
    const raw = JSON.stringify(record);
    await writeFile(join(dir, 'work-items/wi-doc.json'), raw);
    const manifest = { allowed_change_paths: ['docs/**'],
      work_items: [{ id: 'wi-doc', pipeline_id: 'p', path: 'work-items/wi-doc.json', sha256: sha(raw) }] };
    const pipeline = { id: 'p', work_items: ['wi-doc'] };
    const args = { manifest, pipeline, stage: 'implementation', manifestFile: join(dir, 'manifest.json'),
      runId: 'run', projectRoot: root };
    const complete = () => verifyCompletedWorkItemOutputs(args);
    assert.throws(complete, /WORK_ITEM_OUTPUT_MISSING/);
    await writeFile(join(root, 'docs/result.md'), '');
    assert.throws(complete, /WORK_ITEM_OUTPUT_EMPTY/);
    await writeFile(join(root, 'docs/result.md'), '# ready\n');
    assert.doesNotThrow(complete);
    assert.throws(() => verifyCompletedWorkItemOutputs({ ...args, startedAt: '2099-01-01T00:00:00Z' }),
      /WORK_ITEM_OUTPUT_STALE/);
    assert.doesNotThrow(() => verifyCompletedWorkItemOutputs({ ...args, stage: 'review' }));
    await writeFile(join(dir, 'work-items/wi-doc.json'), raw + ' ');
    assert.throws(complete, /WORK_ITEM_CHANGED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('stage-cli preflight draft path catches impossible output before any closing review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'o10-draft-'));
  const old = process.env.OPENCODE_AGENT_POLICY_DIR;
  try {
    const dir = join(root, 'agents');
    const runRoot = join(root, '.tmp/pipelines/draft');
    await mkdir(join(runRoot, 'work-items'), { recursive: true });
    await mkdir(dir);
    await writeFile(join(dir, 'DocWriter.md'), policy('DocWriter',
      '    "*": deny\n    "**/*.md": allow\n    ".tmp/pipelines/**": deny'));
    process.env.OPENCODE_AGENT_POLICY_DIR = dir;
    const item = { id: 'doc', pipeline_id: 'p', stage: 'implementation', suggested_agent: 'DocWriter',
      allowed_change_paths: ['.tmp/pipelines/**'], required_outputs: ['.tmp/pipelines/draft/validation/report.md'] };
    const raw = JSON.stringify(item);
    await writeFile(join(runRoot, 'work-items/doc.json'), raw);
    const manifest = { schema_version: 2, run_id: 'draft', work_item_output_contract_version: 1, allowed_change_paths: ['.tmp/pipelines/**'],
      gate_profiles: {}, planning_readiness: { design_freeze: false },
      work_items: [{ id: 'doc', pipeline_id: 'p', path: 'work-items/doc.json', sha256: sha(raw) }],
      pipelines: [{ id: 'p', stages: ['implementation'], executors: { implementation: 'agent' },
        work_items: ['doc'], decision_ids: [], research_ids: [], contract_ids: [] }] };
    const check = () => validateGateManifest(manifest, { cwd: root, manifestPath: join(runRoot, 'manifest.json') });
    assert.throws(check, /WORK_ITEM_OUTPUT_ROLE_DENIED/);
    item.allowed_change_paths = ['docs/**']; item.required_outputs = ['docs/report.md'];
    manifest.allowed_change_paths = ['docs/**'];
    const updated = JSON.stringify(item);
    await writeFile(join(runRoot, 'work-items/doc.json'), updated);
    manifest.work_items[0].sha256 = sha(updated);
    assert.equal(check().status, 'DRAFT_READY');
  } finally {
    if (old === undefined) delete process.env.OPENCODE_AGENT_POLICY_DIR;
    else process.env.OPENCODE_AGENT_POLICY_DIR = old;
    await rm(root, { recursive: true, force: true });
  }
});

test('agent permission order matches OpenCode last-matching-rule semantics', () => {
  const specificAllowThenGlobalDeny = [
    { glob: 'docs/safe.md', access: 'allow' },
    { glob: '*', access: 'deny' },
  ];
  assert.equal(roleCanEdit(specificAllowThenGlobalDeny, 'docs/safe.md'), false);
  const denyThenSpecificAllow = [
    { glob: '*', access: 'deny' },
    { glob: 'docs/safe.md', access: 'allow' },
  ];
  assert.equal(roleCanEdit(denyThenSpecificAllow, 'docs/safe.md'), true);
  assert.equal(roleCanEdit([{ glob: '*', access: 'allow' }, { glob: '*.md', access: 'ask' }], 'docs/file.md'), true);
  assert.equal(roleCanEdit([{ glob: '*', access: 'allow' }, { glob: 'docs/**', access: 'ask' }], 'docs/file.md'), false);
});

test('unsupported agent edit policies block PLAN instead of ignoring a restrictive rule', async () => {
  const root = await mkdtemp(join(tmpdir(), 'o10-unknown-policy-'));
  try {
    await writeFile(join(root, 'DocWriter.md'), policy('DocWriter',
      '    "*": allow\n    "docs/[abc]*.md": deny'));
    assert.throws(() => readRoleEditPolicy('DocWriter', { policyDir: root }), /AGENT_EDIT_POLICY_UNSUPPORTED/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
