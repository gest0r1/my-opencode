import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { validateState } from './stage-cli-core.ts';
import { dispatchPacket } from './pipeline-dispatch.ts';

// Shared authorization for approved source mutations (delete/move): the reviewed run-local
// evidence must bind the exact dispatch, work item and approved requirement or owner decision.
export async function authorizeSourceChange(root: string, run: string, pipeline: string, stage: string, item: string, role: string,
  evidencePath: string, kind: 'source_deletion' | 'source_move', prefix: string, paths: (evidence: any) => unknown) {
  const state = await validateState(join(root, '.tmp/pipelines'), run);
  const packet = await dispatchPacket(root, run, pipeline, stage, item, role);
  if (packet.executor !== 'agent') throw Error(`${prefix}_REQUIRES_AGENT_STAGE`);
  const evidenceFile = resolve(root, evidencePath);
  if (!state.manifest_file || !evidenceFile.startsWith(dirname(resolve(state.manifest_file)) + sep)) throw Error(`${prefix}_EVIDENCE_OUTSIDE_RUN`);
  const raw = await readFile(evidenceFile, 'utf8');
  const evidence = JSON.parse(raw);
  const listed = paths(evidence);
  const decision = state.deferred_decisions?.find(d => d.id === evidence.decision_id && d.pipeline_id === pipeline && d.status === 'approved');
  const decisionRaw = decision ? await readFile(decision.evidence_path, 'utf8') : undefined;
  const ownerAuthorized = decision && decisionRaw && Array.isArray(listed) && createHash('sha256').update(decisionRaw).digest('hex') === decision.evidence_sha256 &&
    JSON.stringify([...JSON.parse(decisionRaw).paths].sort()) === JSON.stringify([...listed].sort());
  if (evidence.kind !== kind || evidence.status !== 'ready' || evidence.run_id !== run ||
      evidence.pipeline_id !== pipeline || evidence.work_item_id !== item || evidence.work_item_sha256 !== packet.work_item_sha256 ||
      (evidence.approved_requirement !== true && !ownerAuthorized) || evidence.owner_decision_required !== false ||
      typeof evidence.policy_basis !== 'string' || !evidence.policy_basis.trim() || !Array.isArray(listed) || !listed.length) {
    throw Error(`${prefix}_AUTHORIZATION_REQUIRED`);
  }
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const manifest = JSON.parse(await readFile(state.manifest_file, 'utf8'));
  if (!manifest.git_setup || git(['branch', '--show-current']) !== manifest.git_setup.branch || ['main', 'master'].includes(manifest.git_setup.branch)) throw Error(`${prefix}_WRONG_BRANCH`);
  const repo = await realpath(root);
  const assertPath = (path: unknown) => {
    if (typeof path !== 'string' || !path || path.startsWith('/') || /[\\\0*?\[\]{}]/.test(path) ||
        path.split('/').some(part => ['..', '.git', '.opencode', '.tmp'].includes(part)) ||
        path.startsWith('.github/') || /(^|\/)(\.env(?:\..*)?|pipeline-rules\.md)$|\.(key|pem|p12|pfx|secret)$/i.test(path)) throw Error(`${prefix}_PROTECTED_PATH`);
    if (!packet.effective_scope.some((scope: string) => scope.endsWith('/**') ? path.startsWith(scope.slice(0, -2)) : scope === path)) throw Error(`${prefix}_OUTSIDE_SCOPE`);
    return path;
  };
  const audit = join(dirname(state.manifest_file), `${kind === 'source_move' ? 'source-move' : 'source-delete'}-${createHash('sha256').update(raw).digest('hex').slice(0, 16)}.json`);
  return { evidence, evidenceFile, raw, git, repo, assertPath, audit };
}

export async function deleteApprovedSource(root: string, run: string, pipeline: string, stage: string, item: string, role: string, evidencePath: string) {
  const { evidenceFile, raw, git, repo, assertPath, audit, evidence } = await authorizeSourceChange(root, run, pipeline, stage, item, role,
    evidencePath, 'source_deletion', 'SOURCE_DELETE', value => value.paths);
  const paths = [...new Set(evidence.paths)] as string[];
  const files: Array<{ path: string; sha256: string; absent: boolean }> = [];
  for (const path of paths) {
    assertPath(path);
    if (git(['ls-files', '--', path]) !== path) throw Error('SOURCE_DELETE_UNTRACKED_PATH');
    const parent = await realpath(dirname(resolve(root, path)));
    if (parent !== repo && !parent.startsWith(repo + sep)) throw Error('SOURCE_DELETE_SYMLINK_PARENT');
    let stat;
    try { stat = await lstat(resolve(root, path)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (stat && !stat.isFile()) throw Error('SOURCE_DELETE_REQUIRES_REGULAR_FILE');
    files.push({ path, absent: !stat, sha256: stat ? createHash('sha256').update(await readFile(resolve(root, path))).digest('hex') : '' });
  }
  // Validate every path before the first mutation. Retries tolerate already absent tracked files.
  let previous: { files: Array<{ path: string; sha256: string }> } | undefined;
  try { previous = JSON.parse(await readFile(audit, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const file of files) {
    const old = previous?.files.find(item => item.path === file.path);
    if (old?.sha256) {
      if (!file.absent && file.sha256 !== old.sha256) throw Error('SOURCE_DELETE_SOURCE_CHANGED');
      if (file.absent) file.sha256 = old.sha256;
    }
  }
  const record = { status: 'in_progress', run_id: run, pipeline_id: pipeline, stage, work_item_id: item, evidence_path: evidenceFile, evidence_sha256: createHash('sha256').update(raw).digest('hex'), files, deleted: [] as string[] };
  await writeFile(audit, JSON.stringify(record, null, 2) + '\n');
  for (const file of files) {
    if (!file.absent) await unlink(resolve(root, file.path));
    record.deleted.push(file.path);
    await writeFile(audit, JSON.stringify(record, null, 2) + '\n');
  }
  record.status = 'PASS';
  await writeFile(audit, JSON.stringify(record, null, 2) + '\n');
  return { status: 'PASS', deleted: paths, evidence: audit };
}
