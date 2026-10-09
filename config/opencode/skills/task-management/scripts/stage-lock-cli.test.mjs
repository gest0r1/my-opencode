import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { recoverStageLock } from './stage-lock-cli.ts';

test('stale stage lock is recovered, absent lock is idempotent, live lock is preserved', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stage-lock-'));
  const runId = 'run-1';
  const dir = path.join(root, runId);
  await mkdir(dir, {recursive:true});
  try {
    await writeFile(path.join(dir,'.lock'), '2147483647\n');
    const recovered = await recoverStageLock(root, runId);
    assert.equal(recovered.status, 'RECOVERED');
    assert.equal(recovered.pid, 2147483647);
    await assert.rejects(readFile(path.join(dir,'.lock'),'utf8'), error => error?.code === 'ENOENT');
    assert.equal((await recoverStageLock(root, runId)).status, 'ABSENT');

    await writeFile(path.join(dir,'.lock'), `${process.pid}\n`);
    await assert.rejects(recoverStageLock(root, runId), /LOCK_ACTIVE/);
    assert.equal((await readFile(path.join(dir,'.lock'),'utf8')).trim(), String(process.pid));
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test('malformed lock fails closed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stage-lock-'));
  const dir = path.join(root, 'run-2');
  await mkdir(dir,{recursive:true});
  try {
    await writeFile(path.join(dir,'.lock'),'not-a-pid\n');
    await assert.rejects(recoverStageLock(root,'run-2'), /LOCK_INVALID/);
    assert.equal((await readFile(path.join(dir,'.lock'),'utf8')).trim(),'not-a-pid');
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});
