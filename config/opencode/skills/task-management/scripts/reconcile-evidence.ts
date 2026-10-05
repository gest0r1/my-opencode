import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

export const digest = (raw: string) => createHash('sha256').update(raw).digest('hex');
export async function acceptedReconciliations(root: string, state: any, manifestHash: string): Promise<any[]> {
  const records = [];
  for (const record of state?.reconciliations ?? []) {
    const file = resolve(root, record.path);
    const rel = relative(resolve(root), file);
    if (!rel.startsWith('reconcile/') || rel.includes('..')) throw Error('RECONCILE_EVIDENCE_PATH_INVALID');
    const raw = await readFile(file, 'utf8');
    if (digest(raw) !== record.sha256) throw Error('RECONCILE_EVIDENCE_CHANGED');
    const evidence = JSON.parse(raw);
    if (evidence.manifest_sha256 !== manifestHash || evidence.result !== 'COMPATIBLE') throw Error('RECONCILE_IDENTITY_MISMATCH');
    records.push(evidence);
  }
  return records;
}
