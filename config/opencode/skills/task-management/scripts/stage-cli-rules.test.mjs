import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STAGE_CLI = path.join(HERE, 'stage-cli.ts');

function run(cwd, args) {
  return spawnSync('npx', ['--yes', 'tsx', STAGE_CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: process.env,
  });
}

async function tempProject() {
  return mkdtemp(path.join(os.tmpdir(), 'stage-cli-rules-'));
}

async function writeProjectRules(root, body = '# project policy\n', rulesVersion = 7) {
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(
    path.join(root, 'docs', 'pipeline-rules.md'),
    `---\ndocument_type: pipeline_rules\nrules_version: ${rulesVersion}\nedit_policy: human_only\n---\n\n${body}`,
    'utf8',
  );
}

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function frozen(root, relative, content) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
  return { path: relative, sha256: sha(content) };
}

async function v2Manifest(root, runId, rulesVersion) {
  const architecture = await frozen(root, 'planning/architecture.md', '# architecture\n');
  const review = await frozen(root, 'reviews/architecture.md', '# review\n');
  const requiredArtifacts = {
    decision_register: await frozen(root, 'decision-register.md', '# decisions\n'),
    technology_evidence: await frozen(root, 'technology-evidence.md', '# evidence\n'),
    contract_inventory: await frozen(root, 'contract-inventory.md', '# contracts\n'),
    test_strategy: await frozen(root, 'test-strategy.md', '# tests\n'),
    accepted_risks: await frozen(root, 'accepted-risks.md', '# risks\n'),
    work_items: await frozen(root, 'work-items/index.json', '{"schema":2}\n'),
  };
  const item = await frozen(root, 'work-items/wi-app.json', JSON.stringify({ id: 'wi-app', pipeline_id: 'app', stage: 'implementation', suggested_agent: 'CoderAgent' }) + '\n');
  return {
    schema_version: 2,
    work_item_output_contract_version: 1,
    run_id: runId,
    rules_file: 'docs/pipeline-rules.md',
    rules_version: rulesVersion,
    planning_mode: 'design-freeze',
    planning_readiness: {
      design_freeze: true,
      required_gates: ['architecture'],
      gates: {
        architecture: {
          required: true,
          status: 'ready',
          cycles: 1,
          artifact: architecture,
          review,
          blocking_decision_ids: [],
        },
      },
      required_artifacts: requiredArtifacts,
    },
    open_decisions: [],
    allowed_change_paths: [],
    gate_profiles: {},
    pipelines: [{
      id: 'app',
      deployable: false,
      stages: ['implementation'],
      executors: { implementation: 'agent' },
      work_items: ['wi-app'],
      decision_ids: [],
      research_ids: [],
      contract_ids: [],
    }],
    work_items: [{ id: 'wi-app', pipeline_id: 'app', ...item }],
  };
}

test('uses OpenCode default rules when project rules are absent', async () => {
  const root = await tempProject();
  const result = run(root, ['rules', 'docs/pipeline-rules.md', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'PASS');
  assert.equal(output.rules_source, 'opencode_default');
  assert.equal(output.rules_version, 2);
  assert.match(output.rules_file, /pipeline-rules\.default\.md$/);
  assert.match(output.rules_sha256, /^[0-9a-f]{64}$/);
});

test('project rules take precedence over default rules', async () => {
  const root = await tempProject();
  await writeProjectRules(root);
  const result = run(root, ['rules', 'docs/pipeline-rules.md', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.rules_source, 'project');
  assert.equal(output.rules_version, 7);
  assert.equal(output.rules_file, path.join(root, 'docs', 'pipeline-rules.md'));
});

test('invalid existing project rules block instead of falling back', async () => {
  const root = await tempProject();
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(path.join(root, 'docs', 'pipeline-rules.md'), '# invalid\n', 'utf8');
  const result = run(root, ['rules', 'docs/pipeline-rules.md', '--json']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Rules file has no YAML frontmatter/);
  assert.doesNotMatch(result.stdout, /opencode_default/);
});

test('default rules stay live instead of being copied into run state', async () => {
  const root = await tempProject();
  const stateRoot = path.join(root, '.tmp', 'pipelines');
  const manifest = await v2Manifest(root, 'default-rules-run', 2);
  const manifestPath = path.join(root, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const result = run(root, ['init', manifestPath, '--state-root', stateRoot, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(result.stdout);
  assert.equal(state.rules_source, 'opencode_default');
  assert.match(state.rules_file, /pipeline-rules\.default\.md$/);
  assert.equal(state.rules_origin_file, undefined);
  assert.notEqual(state.rules_file, path.join(stateRoot, manifest.run_id, 'rules', 'pipeline-rules.default.md'));

  const validate = run(root, ['validate', manifest.run_id, '--state-root', stateRoot]);
  assert.equal(validate.status, 0, validate.stderr);
});

test('project rules changed between pipeline commands are adopted on validate', async () => {
  const root = await tempProject();
  await writeProjectRules(root, '# original\n');
  const stateRoot = path.join(root, '.tmp', 'pipelines');
  const manifest = await v2Manifest(root, 'project-rules-run', 7);
  const manifestPath = path.join(root, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const init = run(root, ['init', manifestPath, '--state-root', stateRoot, '--json']);
  assert.equal(init.status, 0, init.stderr);
  const statePath = path.join(stateRoot, manifest.run_id, 'state.json');
  const before = JSON.parse(await readFile(statePath, 'utf8'));

  await writeProjectRules(root, '# owner changed policy while run was stopped\n', 8);
  const currentContent = await readFile(path.join(root, 'docs', 'pipeline-rules.md'), 'utf8');
  const validate = run(root, ['validate', manifest.run_id, '--state-root', stateRoot, '--json']);
  assert.equal(validate.status, 0, validate.stderr);

  const after = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(after.rules_source, 'project');
  assert.equal(after.rules_version, 8);
  assert.equal(after.rules_sha256, sha(currentContent));
  assert.notEqual(after.rules_sha256, before.rules_sha256);
  assert.equal(after.rules_refresh_history.length, 1);
  assert.equal(after.rules_refresh_history[0].previous_sha256, before.rules_sha256);
  assert.equal(after.rules_refresh_history[0].new_sha256, after.rules_sha256);
});

test('legacy default-rules snapshot is replaced by current installed rules on validate', async () => {
  const root = await tempProject();
  const stateRoot = path.join(root, '.tmp', 'pipelines');
  const manifest = await v2Manifest(root, 'default-live-update-run', 2);
  const manifestPath = path.join(root, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const init = run(root, ['init', manifestPath, '--state-root', stateRoot, '--json']);
  assert.equal(init.status, 0, init.stderr);
  const statePath = path.join(stateRoot, manifest.run_id, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const installedFile = state.rules_file;
  const installedContent = await readFile(installedFile, 'utf8');

  const legacySnapshot = path.join(stateRoot, manifest.run_id, 'rules', 'pipeline-rules.default.md');
  const legacyContent = '---\ndocument_type: pipeline_rules\nrules_version: 999\nedit_policy: distribution_only\n---\n\n# stale snapshot\n';
  await mkdir(path.dirname(legacySnapshot), { recursive: true });
  await writeFile(legacySnapshot, legacyContent, 'utf8');
  state.rules_file = legacySnapshot;
  state.rules_origin_file = installedFile;
  state.rules_version = 999;
  state.rules_sha256 = sha(legacyContent);
  delete state.rules_refresh_history;
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

  const validate = run(root, ['validate', manifest.run_id, '--state-root', stateRoot, '--json']);
  assert.equal(validate.status, 0, validate.stderr);

  const after = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(after.rules_source, 'opencode_default');
  assert.equal(after.rules_file, installedFile);
  assert.equal(after.rules_origin_file, undefined);
  assert.equal(after.rules_version, 2);
  assert.equal(after.rules_sha256, sha(installedContent));
  assert.equal(after.rules_refresh_history.length, 1);
  assert.equal(after.rules_refresh_history[0].previous_file, legacySnapshot);
  assert.equal(after.rules_refresh_history[0].new_file, installedFile);
});

test('invalid live rules still block validation', async () => {
  const root = await tempProject();
  await writeProjectRules(root, '# original\n');
  const stateRoot = path.join(root, '.tmp', 'pipelines');
  const manifest = await v2Manifest(root, 'invalid-live-rules-run', 7);
  const manifestPath = path.join(root, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const init = run(root, ['init', manifestPath, '--state-root', stateRoot, '--json']);
  assert.equal(init.status, 0, init.stderr);

  await writeFile(path.join(root, 'docs', 'pipeline-rules.md'), '# invalid now\n', 'utf8');
  const validate = run(root, ['validate', manifest.run_id, '--state-root', stateRoot]);
  assert.notEqual(validate.status, 0);
  assert.match(validate.stderr, /Rules file has no YAML frontmatter/);
});
