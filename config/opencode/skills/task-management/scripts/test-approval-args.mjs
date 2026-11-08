import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

/** Supply explicit fixture audit data to legacy integration callers that exercise approval success. */
export function withApprovalArgs(cwd, args) {
  if (args[0] !== 'approve' || args.includes('--approval-subject')) return args;
  const runId = args[1];
  const rootIndex = args.indexOf('--state-root');
  const stateRoot = rootIndex >= 0 ? args[rootIndex + 1] : '.tmp/pipelines';
  try {
    const state = JSON.parse(readFileSync(path.resolve(cwd, stateRoot, runId, 'state.json'), 'utf8'));
    if (state.status !== 'planned' || !state.manifest_file) return args;
    const raw = readFileSync(state.manifest_file, 'utf8');
    return [...args,
      '--approval-subject', 'final-manifest',
      '--approval-run-id', runId,
      '--approval-manifest-sha256', createHash('sha256').update(raw).digest('hex'),
      '--approval-decision', 'approved',
      '--owner-response', 'Approved final manifest in fixture',
    ];
  } catch {
    return args;
  }
}
