import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const sha256 = (content) => createHash('sha256').update(content).digest('hex');

// Frozen refs whose bytes PLAN may still regenerate before approval: work items, required planning
// artifacts, carried findings and the deployment target check. The manifest takes their SHA-256 from
// disk, never from a model. A gate artifact or its review is different: its hash is what the review
// approved, so a change there is reported and never refreshed.
function refreshableRefs(manifest) {
  const refs = [];
  const readiness = manifest.planning_readiness ?? {};
  for (const [key, ref] of Object.entries(readiness.required_artifacts ?? {})) refs.push([`planning_readiness.required_artifacts.${key}`, ref]);
  (readiness.carried_findings ?? []).forEach((ref, index) => refs.push([`planning_readiness.carried_findings[${index}]`, ref]));
  for (const item of manifest.work_items ?? []) refs.push([`work_items.${item.id}`, item]);
  if (manifest.deployment_target_check) refs.push(['deployment_target_check', manifest.deployment_target_check]);
  return refs;
}

function gateRefs(manifest) {
  const refs = [];
  for (const [gate, record] of Object.entries(manifest.planning_readiness?.gates ?? {})) {
    if (record?.artifact) refs.push([`planning_readiness.gates.${gate}.artifact`, record.artifact]);
    if (record?.review) refs.push([`planning_readiness.gates.${gate}.review`, record.review]);
  }
  return refs;
}

function digest(root, field, ref) {
  if (!ref || typeof ref.path !== 'string' || !ref.path || ref.path.startsWith('/') || ref.path.split('/').includes('..')) {
    throw new Error(`MANIFEST_REF_INVALID: ${field}`);
  }
  try { return sha256(readFileSync(resolve(root, ref.path), 'utf8')); }
  catch { throw new Error(`MANIFEST_REF_MISSING: ${field}: ${ref.path}`); }
}

export function refreshManifestHashes(manifestPath, { check = false } = {}) {
  const file = resolve(manifestPath);
  const root = dirname(file);
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  const changedGates = gateRefs(manifest).filter(([field, ref]) => digest(root, field, ref) !== String(ref.sha256 ?? '').toLowerCase()).map(([field, ref]) => `${field}: ${ref.path}`);
  if (changedGates.length) throw new Error(`GATE_ARTIFACT_CHANGED_AFTER_REVIEW: ${changedGates.join(', ')}; review the changed artifact again (stage-cli plan-review) instead of refreshing its hash`);
  const updated = [];
  for (const [field, ref] of refreshableRefs(manifest)) {
    const actual = digest(root, field, ref);
    if (actual === String(ref.sha256 ?? '').toLowerCase()) continue;
    updated.push({ field, path: ref.path, previous: ref.sha256 ?? null, sha256: actual });
    if (!check) ref.sha256 = actual;
  }
  if (!check && updated.length) {
    const temp = `${file}.refresh-${process.pid}`;
    writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`);
    renameSync(temp, file);
  }
  return { status: check && updated.length ? 'STALE' : 'PASS', manifest: manifestPath, updated };
}
