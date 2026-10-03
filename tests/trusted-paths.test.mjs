import assert from 'node:assert/strict';
import test from 'node:test';
import { materializeTrustedPaths } from '../scripts/materialize-opencode-trusted-paths.mjs';

test('only equivalent trusted CLI paths are added and repeated generation is stable', () => {
  const before = '---\npermission:\n  bash:\n    "*": deny\n    "npx tsx $HOME/.config/opencode/skills/task-management/scripts/stage-cli.ts*": allow\n  edit:\n    "*": deny\n---\nBody\n';
  for (const home of ['/root', '/home/runner']) {
    const after = materializeTrustedPaths(before, home);
    assert.ok(after.includes(`npx tsx ${home}/.config/opencode/skills/task-management/scripts/stage-cli.ts*`));
    assert.ok(after.includes('npx tsx ${HOME}/.config/opencode/skills/task-management/scripts/stage-cli.ts*'));
    assert.equal(after.match(/: allow/g).length, 3);
    assert.equal(materializeTrustedPaths(after, home), after);
    assert.ok(after.includes('  edit:\n    "*": deny'));
  }
  assert.equal(materializeTrustedPaths('---\npermission:\n  bash:\n    "*": deny\n---\n', '/root').includes(': allow'), false);
  assert.throws(() => materializeTrustedPaths(before, '/home/*'), /Unsafe/);
});
