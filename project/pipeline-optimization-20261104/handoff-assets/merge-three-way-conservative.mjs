// Conservative line-based three-way merge for UNPUBLISHED staging trees.
// This never resolves overlapping edits and is NOT a replacement for native
// git merge-file, semantic conflict review, Bun check:changed, or tests.
const lines = s => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
function edits(base, updated) {
  const n = base.length, m = updated.length;
  if (n * m > 4000000) return null;
  const dp = new Uint32Array((n + 1) * (m + 1));
  const idx = (i, j) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[idx(i,j)] = base[i] === updated[j]
      ? 1 + dp[idx(i+1,j+1)]
      : Math.max(dp[idx(i+1,j)], dp[idx(i,j+1)]);
  const chunks = [];
  let h = null, i = 0, j = 0;
  const flush = () => { if (h) { chunks.push(h); h = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && base[i] === updated[j]) { flush(); i++; j++; }
    else if (j < m && (i === n || dp[idx(i,j+1)] >= dp[idx(i+1,j)])) {
      h ??= { s:i, e:i, r:[] }; h.r.push(updated[j++]);
    } else { h ??= { s:i, e:i, r:[] }; h.e++; i++; }
  }
  flush();
  return chunks;
}
const eq = (a,b) => a.s === b.s && a.e === b.e
  && JSON.stringify(a.r) === JSON.stringify(b.r);
const overlap = (a,b) =>
  a.s === a.e && b.s === b.e ? a.s === b.s
  : a.s === a.e ? a.s >= b.s && a.s <= b.e
  : b.s === b.e ? b.s >= a.s && b.s <= a.e
  : Math.max(a.s,b.s) < Math.min(a.e,b.e);
export function merge3(base, ours, upstream) {
  if (ours === upstream) return { content:ours, method:'identical' };
  if (base === ours) return { content:upstream, method:'upstream' };
  if (base === upstream) return { content:ours, method:'fork' };
  const b = lines(base), o = edits(b, lines(ours)), u = edits(b, lines(upstream));
  if (!o || !u) return { conflict:'complexity_limit' };
  const union = [...o];
  for (const c of u) {
    let duplicate = false;
    for (const a of o) {
      if (eq(a,c)) { duplicate = true; break; }
      if (overlap(a,c)) return { conflict:'overlapping_edit' };
    }
    if (!duplicate) union.push(c);
  }
  union.sort((a,b) => a.s - b.s || a.e - b.e);
  let prev = 0; const output = [];
  for (const c of union) {
    if (c.s < prev) return { conflict:'internal_overlap' };
    output.push(...b.slice(prev,c.s), ...c.r);
    prev = c.e;
  }
  output.push(...b.slice(prev));
  return { content:output.join(''), method:'nonoverlapping_lines',
    ours_edits:o.length, upstream_edits:u.length };
}
// Optional local verification, not executed by the GitHub connector.
if (import.meta.url === 'file://' + process.argv[1]) {
  const assert = (cond,msg) => { if (!cond) throw new Error(msg); };
  const b = 'alpha\nbeta\ngamma\n';
  assert(merge3(b,'ALPHA\nbeta\ngamma\n','alpha\nbeta\nGAMMA\n').content ===
    'ALPHA\nbeta\nGAMMA\n','disjoint');
  assert(merge3(b,'alpha\nBETA1\ngamma\n','alpha\nBETA2\ngamma\n').conflict,
    'overlap');
  assert(merge3(b,'alpha\nBETA\ngamma\n','alpha\nBETA\ngamma\n').content ===
    'alpha\nBETA\ngamma\n','identical');
  assert(merge3(b,'extra\nalpha\nbeta\ngamma\n','alpha\nbeta\ngamma\nextra\n').content ===
    'extra\nalpha\nbeta\ngamma\nextra\n','non-overlapping insertions');
  console.log('Conservative merge unit fixtures: PASS 4/4');
}