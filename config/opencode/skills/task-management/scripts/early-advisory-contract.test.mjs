import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../../..');
const text = relative => readFile(path.join(ROOT, relative), 'utf8');

test('PLAN, dispatch and CoderAgent share one affected-advisory contract', async () => {
  const [plan, testing, taskManager, coder, orchestrator, dispatch] = await Promise.all([
    text('config/opencode/command/pipeline-plan.md'),
    text('config/opencode/skills/task-management/gate-testing.md'),
    text('config/opencode/agent/subagents/core/task-manager.md'),
    text('config/opencode/agent/subagents/code/coder-agent.md'),
    text('config/opencode/agent/core/openstage-orchestrator.md'),
    text('config/opencode/skills/task-management/scripts/pipeline-dispatch.ts'),
  ]);

  assert.match(plan, /gate_testing.*skills\/task-management\/gate-testing\.md/is);
  assert.match(testing, /source-only feature pipeline.*share.*profile.*advisory selection/is);
  assert.match(testing, /planning is incomplete.*revised before approval/is);
  assert.match(taskManager, /return `needs_revision`.*affected advisory check/is);
  assert.match(taskManager, /Do not duplicate\s+`advisory_checks` into work-item JSON/is);
  assert.match(dispatch, /advisory_checks:\s*advisoryChecks/);
  assert.match(dispatch, /impact_groups/);
  assert.match(coder, /Execute every `advisory_checks\[\]` entry/is);
  assert.match(coder, /--advisory --affected/);
  assert.match(orchestrator, /dispatch packet contains `advisory_checks`/i);
});
