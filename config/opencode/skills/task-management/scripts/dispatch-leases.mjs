import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

// A writing worker holds a lease on the paths it may change from the moment the runtime starts it
// until it returns (a background child: until it goes idle). dispatch refuses a work item whose
// paths overlap a live lease, and `stage-cli waves` lists what can start now, so parallel workers
// never edit the same files. Leases are machine-owned files under the run's checks/.

const leaseDir = runRoot => join(runRoot, 'checks', 'active-dispatches');
const leaseName = ({ pipeline_id, stage, work_item_id }) =>
  `${createHash('sha256').update(JSON.stringify([pipeline_id, stage, work_item_id])).digest('hex').slice(0, 24)}.json`;

export function scopeMatches(file, scope) {
  if (typeof scope !== 'string' || !scope) return false;
  if (scope.endsWith('/**')) {
    const prefix = scope.slice(0, -3).replace(/\/$/, '');
    return file === prefix || file.startsWith(`${prefix}/`);
  }
  return file === scope;
}

export function scopesOverlap(left, right) {
  return left === right || scopeMatches(left.endsWith('/**') ? left.slice(0, -3).replace(/\/$/, '') : left, right) ||
    scopeMatches(right.endsWith('/**') ? right.slice(0, -3).replace(/\/$/, '') : right, left);
}

export function firstOverlap(left = [], right = []) {
  for (const a of left) for (const b of right) if (scopesOverlap(a, b)) return a;
  return null;
}

function ownerAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

export function sameDispatch(a, b) {
  return a.pipeline_id === b.pipeline_id && a.stage === b.stage && a.work_item_id === b.work_item_id;
}

export function writeLease(runRoot, lease) {
  const dir = leaseDir(runRoot);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, leaseName(lease));
  const temporary = `${target}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify({ owner_pid: process.pid, created_at: new Date().toISOString(), ...lease }, null, 2)}\n`, 'utf8');
  renameSync(temporary, target);
}

export function updateLease(runRoot, identity, patch) {
  const target = join(leaseDir(runRoot), leaseName(identity));
  let lease;
  try { lease = JSON.parse(readFileSync(target, 'utf8')); } catch { return; }
  writeLease(runRoot, { ...lease, ...patch });
}

export function removeLease(runRoot, identity) {
  rmSync(join(leaseDir(runRoot), leaseName(identity)), { force: true });
}

// Live leases only: a lease whose owning OpenCode process is gone (restart, crash) or whose stage
// is already completed is dropped, since its worker cannot still be writing.
export function readLeases(runRoot, { alive = ownerAlive, state } = {}) {
  let names = [];
  try { names = readdirSync(leaseDir(runRoot)).filter(name => name.endsWith('.json')); } catch { return []; }
  const leases = [];
  for (const name of names) {
    const file = join(leaseDir(runRoot), name);
    let lease;
    try { lease = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    const finished = state?.pipelines?.[lease.pipeline_id]?.stages?.[lease.stage]?.status === 'completed';
    if (!alive(lease.owner_pid) || finished) { rmSync(file, { force: true }); continue; }
    leases.push(lease);
  }
  return leases;
}

// Paths a scope check authorized at runtime become part of every live lease of that pipeline stage:
// the worker that asked will change them, and no other worker may start on them meanwhile.
export function extendLeases(runRoot, pipelineId, stage, paths) {
  for (const lease of readLeases(runRoot)) {
    if (lease.pipeline_id !== pipelineId || lease.stage !== stage) continue;
    const scope = [...new Set([...(lease.scope ?? []), ...paths])];
    if (scope.length !== (lease.scope ?? []).length) updateLease(runRoot, lease, { scope });
  }
}

export function leaseConflict(leases, self, paths) {
  for (const lease of leases) {
    if (sameDispatch(lease, self)) continue;
    const path = firstOverlap(paths, lease.scope ?? []);
    if (path) return { lease, path };
  }
  return null;
}

// Paths a scope check authorized for a pipeline stage. They are written by every worker of that stage
// from then on, so its later dispatches lease them too.
const stagePathsFile = (runRoot, pipelineId, stage) =>
  join(runRoot, 'checks', 'stage-paths', `${createHash('sha256').update(JSON.stringify([pipelineId, stage])).digest('hex').slice(0, 24)}.json`);

export function readStagePaths(runRoot, pipelineId, stage) {
  try { const value = JSON.parse(readFileSync(stagePathsFile(runRoot, pipelineId, stage), 'utf8')); return Array.isArray(value?.paths) ? value.paths : []; }
  catch { return []; }
}

export function recordStagePaths(runRoot, pipelineId, stage, paths) {
  const file = stagePathsFile(runRoot, pipelineId, stage);
  const merged = [...new Set([...readStagePaths(runRoot, pipelineId, stage), ...paths])].sort();
  mkdirSync(join(runRoot, 'checks', 'stage-paths'), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify({ pipeline_id: pipelineId, stage, paths: merged }, null, 2)}\n`, 'utf8');
  renameSync(temporary, file);
  extendLeases(runRoot, pipelineId, stage, paths);
}
