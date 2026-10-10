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
  assert.match(plan, /\$HOME\/\.config\/opencode\/skills\/task-management\/scripts\/github-actions-gate-cli\.ts inspect/);
  assert.match(plan, /node \$HOME\/\.config\/opencode\/skills\/task-management\/scripts\/pipeline-github-sync\.mjs sync/);
});

test('refresh stays parent-owned and uses exact allowlisted invocations', async () => {
  const refresh = await text('config/opencode/command/pipeline-refresh.md');
  const parent = await text('config/opencode/agent/core/openstage-orchestrator.md');

  assert.doesNotMatch(refresh, hardCodedRootInvocation, 'pipeline-refresh.md: executable command hard-codes root runtime path');
  assert.match(refresh, /npx --yes tsx \$HOME\/\.config\/opencode\/skills\/task-management\/scripts\/pipeline-refresh-cli\.ts preflight/);
  assert.match(refresh, /bash \$HOME\/\.config\/opencode\/skills\/task-management\/scripts\/worktree-refresh\.sh --check/);
  assert.match(refresh, /do not delegate them to `OpenDevopsSpecialist`/i);

  assert.match(parent, /MUST be invoked directly by OpenStage/);
  assert.match(parent, /arbitrary or non-allowlisted shell command does not prove that shell execution is unavailable/i);
  assert.match(parent, /selected PLAN\/RUN\/refresh\/status contract/);
  assert.match(parent, /Never use a specialist as a generic shell proxy/i);
});
