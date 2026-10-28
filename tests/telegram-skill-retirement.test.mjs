import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

test('retired telegram-send is absent from the installed source', async () => {
  await assert.rejects(
    access(join(repoRoot, 'config/opencode/skills/telegram-send/SKILL.md')),
    { code: 'ENOENT' },
  );
});

test('generation migration removes legacy Telegram copies but preserves user skills', async () => {
  const installer = await readFile(join(repoRoot, 'scripts/install-opencode-generation.sh'), 'utf8');
  const cleanup = installer.match(/^rm -rf -- "\$STAGE_CONFIG\/skills\/telegram-send" "\$STAGE_SKILLS\/telegram-send"$/m);
  assert.ok(cleanup, 'staged generation must retire both copies of telegram-send');
  const root = await mkdtemp(join(tmpdir(), 'telegram-skill-retirement-'));
  const config = join(root, 'config with spaces');
  const skills = join(root, 'skills with spaces');
  try {
    for (const dir of [
      join(config, 'skills/telegram-send'),
      join(config, 'skills/my-custom'),
      join(skills, 'telegram-send'),
      join(skills, 'my-custom'),
    ]) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'SKILL.md'), 'fixture');
    }
    const run = spawnSync('bash', ['-e', '-c', cleanup[0]], {
      env: { ...process.env, STAGE_CONFIG: config, STAGE_SKILLS: skills },
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    await assert.rejects(access(join(config, 'skills/telegram-send')), { code: 'ENOENT' });
    await assert.rejects(access(join(skills, 'telegram-send')), { code: 'ENOENT' });
    await access(join(config, 'skills/my-custom/SKILL.md'));
    await access(join(skills, 'my-custom/SKILL.md'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
