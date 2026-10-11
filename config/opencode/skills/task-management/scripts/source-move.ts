import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { authorizeSourceChange } from './source-delete.ts';

type Move = { from: string; to: string; sha256: string; state: 'pending' | 'copied' | 'moved' };

const digest = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex');
async function regularFile(file: string) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile()) throw Error('SOURCE_MOVE_REQUIRES_REGULAR_FILE');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

// Byte-identical relocation of approved tracked source. Models never transcribe file contents:
// the CLI copies, verifies SHA-256 and only then removes the original. Retries are resumable.
export async function moveApprovedSource(root: string, run: string, pipeline: string, stage: string, item: string, role: string, evidencePath: string) {
  const { evidence, evidenceFile, raw, git, repo, assertPath, audit } = await authorizeSourceChange(root, run, pipeline, stage, item, role,
    evidencePath, 'source_move', 'SOURCE_MOVE', value => Array.isArray(value.moves) ? value.moves.flatMap((move: any) => [move?.from, move?.to]) : undefined);
  const sources = new Set<string>(); const targets = new Set<string>();
  for (const move of evidence.moves) {
    const from = assertPath(move?.from); const to = assertPath(move?.to);
    if (from === to || sources.has(from) || targets.has(to)) throw Error('SOURCE_MOVE_DUPLICATE_PATH');
    sources.add(from); targets.add(to);
  }
  if ([...targets].some(path => sources.has(path))) throw Error('SOURCE_MOVE_CHAINED_PATH');
  const inside = (path: string) => path === repo || path.startsWith(repo + sep);
  let previous: { moves: Move[] } | undefined;
  try { previous = JSON.parse(await readFile(audit, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const moves: Move[] = [];
  // Validate every move before the first mutation.
  for (const { from, to } of evidence.moves as Array<{ from: string; to: string }>) {
    const source = resolve(root, from); const target = resolve(root, to);
    if (!inside(await realpath(dirname(source)).catch(() => repo))) throw Error('SOURCE_MOVE_SYMLINK_PARENT');
    let ancestor = dirname(target);
    for (;;) { try { ancestor = await realpath(ancestor); break; } catch { ancestor = dirname(ancestor); } }
    if (!inside(ancestor)) throw Error('SOURCE_MOVE_SYMLINK_PARENT');
    const old = previous?.moves.find(entry => entry.from === from && entry.to === to);
    const hasSource = await regularFile(source); const hasTarget = await regularFile(target);
    if (hasSource) {
      if (git(['ls-files', '--', from]) !== from) throw Error('SOURCE_MOVE_UNTRACKED_PATH');
      const sha256 = await digest(source);
      if (old?.sha256 && old.sha256 !== sha256) throw Error('SOURCE_MOVE_SOURCE_CHANGED');
      if (hasTarget && await digest(target) !== sha256) throw Error('SOURCE_MOVE_TARGET_EXISTS');
      moves.push({ from, to, sha256, state: hasTarget ? 'copied' : 'pending' });
    } else {
      if (!hasTarget || !old?.sha256 || await digest(target) !== old.sha256) throw Error('SOURCE_MOVE_SOURCE_MISSING');
      moves.push({ from, to, sha256: old.sha256, state: 'moved' });
    }
  }
  const record = { status: 'in_progress', run_id: run, pipeline_id: pipeline, stage, work_item_id: item, evidence_path: evidenceFile,
    evidence_sha256: createHash('sha256').update(raw).digest('hex'), moves };
  const save = () => writeFile(audit, JSON.stringify(record, null, 2) + '\n');
  await save();
  for (const move of moves) {
    const source = resolve(root, move.from); const target = resolve(root, move.to);
    if (move.state === 'pending') {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target, constants.COPYFILE_EXCL);
      move.state = 'copied'; await save();
    }
    if (move.state === 'copied') {
      if (await digest(target) !== move.sha256) throw Error('SOURCE_MOVE_COPY_MISMATCH');
      await unlink(source);
      move.state = 'moved'; await save();
    }
  }
  record.status = 'PASS';
  await save();
  return { status: 'PASS', moved: moves.map(({ from, to, sha256 }) => ({ from, to, sha256 })), evidence: audit };
}
