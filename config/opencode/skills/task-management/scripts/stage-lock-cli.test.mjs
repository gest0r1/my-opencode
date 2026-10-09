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

test('stale recovery guard from a crashed recovery process is reclaimed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stage-lock-'));
  const runId = 'run-recovery';
  const dir = path.join(root, runId);
  await mkdir(dir,{recursive:true});
  try {
    await writeFile(path.join(dir,'.lock.recover'),'2147483646\n');
    await writeFile(path.join(dir,'.lock'),'2147483647\n');
    const recovered = await recoverStageLock(root, runId);
    assert.equal(recovered.status, 'RECOVERED');
    await assert.rejects(readFile(path.join(dir,'.lock.recover'),'utf8'), error => error?.code === 'ENOENT');
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test('malformed lock and recovery guard fail closed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stage-lock-'));
  const lockDir = path.join(root, 'run-2');
  const guardDir = path.join(root, 'run-3');
  await mkdir(lockDir,{recursive:true});
  await mkdir(guardDir,{recursive:true});
  try {
    await writeFile(path.join(lockDir,'.lock'),'not-a-pid\n');
    await assert.rejects(recoverStageLock(root,'run-2'), /LOCK_INVALID/);
    assert.equal((await readFile(path.join(lockDir,'.lock'),'utf8')).trim(),'not-a-pid');

    await writeFile(path.join(guardDir,'.lock.recover'),'not-a-pid\n');
    await assert.rejects(recoverStageLock(root,'run-3'), /LOCK_RECOVERY_INVALID/);
    assert.equal((await readFile(path.join(guardDir,'.lock.recover'),'utf8')).trim(),'not-a-pid');
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});
