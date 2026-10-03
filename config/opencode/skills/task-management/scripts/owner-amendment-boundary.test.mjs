import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const read = (relative) => readFile(path.join(ROOT, relative), 'utf8');

test('owner amendment stays inside an existing frozen work item', async () => {
  const [run, rules, architecture, reviewer, dispatch, cli, policy] = await Promise.all([
    read('command/pipeline-run.md'),
    read('skills/task-management/pipeline-rules.default.md'),
    read('agent/subagents/planning/architecture-analyzer.md'),
    read('agent/subagents/code/senior-technical-plan-reviewer.md'),
    read('skills/task-management/scripts/pipeline-dispatch.ts'),
    read('skills/task-management/scripts/stage-cli.ts'),
    read('skills/task-management/scripts/owner-amendment-policy.ts'),
  ]);

  assert.match(run, /may not create a new work item/i);
  assert.match(run, /new independently scoped responsibility\/deliverable/i);
  assert.doesNotMatch(run, /amendment may add runtime work items/i);

  assert.match(rules, /Owner amendment never creates a new runtime work item/i);
  assert.match(rules, /If a new work item is required, full replan is required/i);

  assert.match(architecture, /new_work_item_required: true \| false/);
  assert.match(architecture, /Return bounded\/ready only when `new_work_item_required=false`/);

  assert.match(reviewer, /"work_items": \[\]/);
  assert.match(reviewer, /If `new_work_item_required=true`/);

  assert.match(policy, /FULL_REPLAN_REQUIRED_NEW_WORK_ITEM/);
  assert.match(policy, /manifest\?\.work_items\?\.find/);
  assert.match(policy, /pipeline\.work_items\?\.includes/);

  assert.match(cli, /validateOwnerAmendmentForApply/);
  assert.ok(
    cli.indexOf('validateOwnerAmendmentForApply({') < cli.indexOf('await applyOwnerAmendment('),
    'owner-amend-apply must validate the frozen-work-item boundary before state mutation',
  );

  assert.match(dispatch, /FULL_REPLAN_REQUIRED_NEW_WORK_ITEM/);
  assert.match(dispatch, /OWNER_AMENDMENT_EVIDENCE_CHANGED/);
  assert.match(dispatch, /validated\.work_item_id === workItemId/);
  assert.match(dispatch, /manifest\.work_items\.find/);
  assert.doesNotMatch(dispatch, /\?\? amendmentItems\.find/);
});
