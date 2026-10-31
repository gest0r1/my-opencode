// Pure policy: a human approval is a structured GitHub Issue comment, never an agent assertion.
// Keep this parser strict: a comment that mixes requirements with approval is a requirement.
const HEX = /^[0-9a-f]{64}$/i;
const RUN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/;
const PATH = /^(?:stories\/issue-[1-9][0-9]*\.md|planning\/story-deltas\/issue-[1-9][0-9]*-[A-Za-z0-9_.-]+\.md)$/;
const WRAPPER = /^<!-- pipeline-owner-approval:v1\n([\s\S]+?)\n-->$/;

export function parseOwnerApprovalComment(body) {
  if (typeof body !== 'string') return null;
  const match = WRAPPER.exec(body.trim());
  if (!match) return null;
  let doc;
  try { doc = JSON.parse(match[1]); } catch { return null; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) ||
      Object.keys(doc).sort().join(',') !== 'entries,run_id' ||
      !RUN.test(doc.run_id) || !Array.isArray(doc.entries) ||
      doc.entries.length < 1 || doc.entries.length > 50) return null;
  const seen = new Set();
  for (const item of doc.entries) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).sort().join(',') !== 'artifact_path,decision,issue_number,sha256' ||
        !Number.isSafeInteger(item.issue_number) || item.issue_number < 1 ||
        typeof item.artifact_path !== 'string' || !PATH.test(item.artifact_path) ||
        !item.artifact_path.includes('issue-' + item.issue_number) ||
        !HEX.test(item.sha256) || !['approve', 'reject'].includes(item.decision)) return null;
    const key = item.issue_number + ':' + item.artifact_path;
    if (seen.has(key)) return null;
    seen.add(key);
  }
  return doc;
}

export function isAuthenticatedApprovalComment(comment) {
  return Boolean(comment?.owner_approval_authorized === true &&
    comment?.created_at && comment.updated_at === comment.created_at &&
    parseOwnerApprovalComment(comment.body));
}

export function latestApprovalEntry(issues, runId, issueNumber, artifactPath) {
  const found = [];
  for (const issue of issues ?? []) {
    if (Number(issue.number) !== issueNumber) continue;
    for (const comment of issue.comments ?? []) {
      if (!isAuthenticatedApprovalComment(comment)) continue;
      const parsed = parseOwnerApprovalComment(comment.body);
      if (parsed.run_id !== runId) continue;
      const entry = parsed.entries.find(e => e.issue_number === issueNumber && e.artifact_path === artifactPath);
      if (entry) found.push({ ...entry, comment });
    }
  }
  found.sort((a, b) => String(a.comment.created_at).localeCompare(String(b.comment.created_at)) ||
    Number(a.comment.id) - Number(b.comment.id));
  return found.at(-1) ?? null;
}
