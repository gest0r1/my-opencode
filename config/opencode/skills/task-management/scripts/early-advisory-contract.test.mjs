import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../../..');
const text = relative => readFile(path.join(ROOT, relative), 'utf8');

test('PLAN, RUN, dispatch, CoderAgent and completion share one affected-advisory contract', async () => {
  const [plan, run, testing, taskManager, coder, orchestrator, dispatch, runner, completion] = await Promise.all([
    text('config/opencode/command/pipeline-plan.md'),
    text('config/opencode/command/pipeline-run.md'),
    text('config/opencode/skills/task-management/gate-testing.md'),
    text('config/opencode/agent/subagents/core/task-manager.md'),
    text('config/opencode/agent/subagents/code/coder-agent.md'),
    text('config/opencode/agent/core/openstage-orchestrator.md'),
    text('config/opencode/skills/task-management/scripts/pipeline-dispatch.ts'),
    text('config/opencode/skills/task-management/scripts/gate-runner-cli.ts'),
    text('config/opencode/skills/task-management/scripts/stage-complete-cli.ts'),
  ]);

  assert.match(plan, /gate_testing.*skills\/task-management\/gate-testing\.md/is);
  assert.match(run, /stage-complete-cli.*mandatory boundary/is);
  assert.match(run, /Never call `stage-cli complete` directly from OpenStage/is);
  assert.match(run, /Every supplied `mode=affected` entry is a mandatory completion check/is);
  assert.match(run, /--work-item WORK_ITEM_ID[\s\S]*--baseline BASELINE_PATH[\s\S]*--baseline-sha256 BASELINE_SHA256/is);
  assert.match(testing, /machine-owned content baseline/is);
  assert.match(testing, /work item's\s+frozen `allowed_change_paths`/is);
  assert.match(taskManager, /`stage`: exact target agent stage ID/is);
  assert.match(taskManager, /`allowed_change_paths`.*mandatory and non-empty for source-changing CoderAgent/is);
  assert.match(taskManager, /Do not duplicate\s+`advisory_checks` into work-item JSON/is);
  assert.match(dispatch, /WORK_ITEM_STAGE_MISMATCH/);
  assert.match(dispatch, /WORK_ITEM_ADVISORY_SCOPE_MISSING/);
  assert.match(dispatch, /baseline_path: baseline\.path/);
  assert.match(dispatch, /baseline_sha256: baseline\.sha256/);
  assert.match(runner, /--baseline-sha256/);
  assert.match(runner, /scoped_source_digest/);
  assert.match(coder, /--work-item WORK_ITEM_ID/);
  assert.match(coder, /--baseline BASELINE_PATH/);
  assert.match(coder, /--baseline-sha256 BASELINE_SHA256/);
  assert.match(orchestrator, /stage-complete-cli/);
  assert.match(completion, /ADVISORY_DISPATCH_BASELINE_REQUIRED/);
  assert.match(completion, /ADVISORY_EVIDENCE_STALE_SOURCE/);
});
