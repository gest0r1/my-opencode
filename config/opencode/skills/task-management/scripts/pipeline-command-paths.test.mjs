import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../../..');

async function text(relative) {
  return readFile(path.join(ROOT, relative), 'utf8');
}

const hardCodedRootInvocation = /(?:^|\n)\s*(?:npx(?: --yes)? tsx|node|bash)\s+\/root\/\.config\/opencode\//m;

test('PLAN uses runtime-user HOME instead of root config paths', async () => {
  const plan = await text('config/opencode/command/pipeline-plan.md');
  assert.doesNotMatch(plan, hardCodedRootInvocation, 'pipeline-plan.md: executable command hard-codes root runtime path');
  assert.match(plan, /\$HOME\/\.config\/opencode\/skills\/task-management\/scripts\/github-issue-cli\.ts probe/);
  assert.match(plan, /\$HOME\/\.config\/opencode\/skills\/task-management\/scripts\/github-issue-cli\.ts milestone/);
  assert.match(await text('config/opencode/skills/task-management/scripts/stage-cli.ts'), /\['github-sync', \[script\('pipeline-github-sync\.mjs'\), 'sync', runId/);
});

test('replan stays parent-owned and uses exact allowlisted invocations', async () => {
  const replan = await text('config/opencode/command/pipeline-replan.md');
  const parent = await text('config/opencode/agent/core/openstage-orchestrator.md');

  assert.doesNotMatch(replan, hardCodedRootInvocation, 'pipeline-replan.md: executable command hard-codes root runtime path');
  assert.match(replan, /\$HOME\/\.config\/opencode\/node_modules\/\.bin\/tsx \$HOME\/\.config\/opencode\/skills\/task-management\/scripts\/pipeline-replan-cli\.ts preflight/);
  assert.match(replan, /bash \$HOME\/\.config\/opencode\/skills\/task-management\/scripts\/worktree-refresh\.sh --check/);
  assert.match(replan, /do not delegate them to `OpenDevopsSpecialist`/i);

  assert.match(parent, /MUST be invoked directly by OpenStage/);
  assert.match(parent, /arbitrary or non-allowlisted shell command does not prove that shell execution is unavailable/i);
  assert.match(parent, /selected PLAN\/RUN\/replan\/status contract/);
  assert.match(parent, /Never use a specialist as a generic shell proxy/i);
});
