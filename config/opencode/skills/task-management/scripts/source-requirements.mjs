import { createHash } from 'node:crypto';
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

export function isPipelineOwnedComment(comment) {
  const body = typeof comment.body === 'string' ? comment.body : '';
  return /<!--\s*pipeline-(?:event|artifact):[^>]+-->/i.test(body);
}

function canonicalRequirements(snapshot) {
  const issues = Array.isArray(snapshot.issues) ? snapshot.issues : [];
  return {
    schema_version: 2,
    source_type: 'github_issues',
    repository: String(snapshot.repository ?? ''),
    issues: issues.map((issue) => ({
      repository: String(issue.repository ?? snapshot.repository ?? ''),
      number: Number(issue.number),
      title: typeof issue.title === 'string' ? issue.title : '',
      body: typeof issue.body === 'string' ? issue.body : '',
      state: String(issue.state ?? ''),
      comments: (Array.isArray(issue.comments) ? issue.comments : [])
        .filter((comment) => !isPipelineOwnedComment(comment))
        .map((comment) => ({
          id: comment.id ?? null,
          user: comment.user ?? null,
          body: typeof comment.body === 'string' ? comment.body : '',
          created_at: comment.created_at ?? null,
          updated_at: comment.updated_at ?? null,
        })),
    })),
  };
}

export function requirementsSha256ForSnapshot(snapshot) {
  return sha256(JSON.stringify(canonicalRequirements(snapshot)));
}

