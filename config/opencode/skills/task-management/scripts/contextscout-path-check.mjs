// ContextScout's broad planning edit permission needs a run-bound pre-dispatch check.
// This checks the destination, not permission to edit any other source or runtime artifact.
// OpenCode's own edit permission remains the write-time enforcement boundary.
import { lstat } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUN_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const RESERVED = new Set([
  'revision.json', 'revisions.jsonl', 'review-ledger.json',
  'source-requirements.json', 'deployment-target.json', 'refresh-impact.json',
]);

export async function assertContextScoutPlanningPath({ root, runId, artifactPath }) {
  const allowed = `.tmp/pipelines/${runId}/planning/**`;
  const reject = reason => {
    throw new Error(`CONTEXTSCOUT_PATH_DENIED (${reason}): "${artifactPath}"; allowed: "${allowed}"`);
  };
  if (typeof runId !== 'string' || !RUN_ID.test(runId) || runId === '.' || runId === '..') {
    reject('invalid run ID');
  }
  if (typeof artifactPath !== 'string' || !artifactPath || isAbsolute(artifactPath) ||
      artifactPath.includes('\\') || artifactPath.includes('\0') ||
      artifactPath !== artifactPath.trim()) reject('unsafe artifact path');
  const parts = artifactPath.split('/');
  if (parts.length < 5 || parts[0] !== '.tmp' || parts[1] !== 'pipelines' ||
      parts[2] !== runId || parts[3] !== 'planning') reject('outside current run planning');
  if (parts.some(part => !part || part === '.' || part === '..' ||
      /[?*\[\]{}]/.test(part))) reject('unsafe path component');
  const tail = parts.slice(4);
  if (tail[0] === 'probes' || (tail.length === 1 && RESERVED.has(tail[0]))) {
    reject('machine-owned planning evidence');
  }
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, ...parts);
  if (!absolute.startsWith(absoluteRoot + sep) || relative(absoluteRoot, absolute).startsWith('..')) {
    reject('outside repository root');
  }
  // Reject pre-existing symlink parents AND symlink destinations, including broken links.
  // For not-yet-created directories ENOENT is expected; never resolve a link implicitly.
  for (let i = 0; i < parts.length; i++) {
    const current = join(absoluteRoot, ...parts.slice(0, i + 1));
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) reject('symbolic link');
      if (i < parts.length - 1 && !stat.isDirectory()) reject('non-directory parent');
      if (i === parts.length - 1 && stat.isDirectory()) reject('destination is directory');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return { status: 'PASS', artifact_path: artifactPath, allowed_scope: allowed };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [runId, artifactPath] = process.argv.slice(2);
  assertContextScoutPlanningPath({ root: process.cwd(), runId, artifactPath })
    .then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(error => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
