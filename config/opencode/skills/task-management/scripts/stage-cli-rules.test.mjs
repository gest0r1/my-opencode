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

async function writeProjectRules(root, body = '# project policy\n') {
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(
    path.join(root, 'docs', 'pipeline-rules.md'),
    `---\ndocument_type: pipeline_rules\nrules_version: 7\nedit_policy: human_only\n---\n\n${body}`,
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
  const item = await frozen(root, 'work-items/wi-app.json', '{"id":"wi-app","pipeline_id":"app"}\n');
  return {
    schema_version: 2,
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

test('default rules are recorded as the frozen rules source during init', async () => {
  const root = await tempProject();
  await mkdir(path.join(root, '.tmp', 'pipelines'), { recursive: true });
  const manifest = await v2Manifest(root, 'default-rules-run', 2);
  const manifestPath = path.join(root, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const result = run(root, [
    'init',
    manifestPath,
    '--state-root',
    path.join(root, '.tmp', 'pipelines'),
    '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(result.stdout);
  assert.equal(state.rules_source, 'opencode_default');
  assert.equal(state.rules_version, 2);
  assert.match(state.rules_sha256, /^[0-9a-f]{64}$/);
});

test('state validation blocks when frozen project rules change', async () => {
  const root = await tempProject();
  await writeProjectRules(root, '# original\n');
  const stateRoot = path.join(root, '.tmp', 'pipelines');
  const manifest = await v2Manifest(root, 'project-rules-run', 7);
  const manifestPath = path.join(root, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const init = run(root, ['init', manifestPath, '--state-root', stateRoot, '--json']);
  assert.equal(init.status, 0, init.stderr);
  const statePath = path.join(stateRoot, manifest.run_id, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.rules_source, 'project');

  await writeProjectRules(root, '# changed after init\n');
  const validate = run(root, ['validate', manifest.run_id, '--state-root', stateRoot]);
  assert.notEqual(validate.status, 0);
  assert.match(validate.stderr, /Rules file changed since pipeline initialization/);
});
