// Deterministic ledger of PLAN gate reviews. The orchestrator records every review verdict here instead of
// counting cycles itself: three autonomous `needs_revision` rounds per gate, then an owner checkpoint; a defect
// class repeated by consecutive verdicts needs recorded prior-art research before the author revises again.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const PLAN_REVIEW_AUTONOMOUS_CYCLES = 3;
const CLASS_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const GATE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

type Entry =
  | { kind: 'review'; gate: string; status: 'ready' | 'needs_revision' | 'blocked'; path: string; sha256: string; classes: string[]; at: string }
  | { kind: 'research'; gate: string; path: string; sha256: string; at: string }
  | { kind: 'owner_continue'; gate: string; reason: string; at: string };

interface Ledger { schema: 1; run_id: string; entries: Entry[] }

export class PlanReviewError extends Error {}

const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');

export function ledgerPath(runDir: string): string {
  return join(runDir, 'planning', 'review-ledger.json');
}

function normalizeClass(value: unknown): string {
  const name = String(value ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  if (!CLASS_PATTERN.test(name)) throw new PlanReviewError(`DEFECT_CLASS_INVALID: ${String(value)} (use a short kebab-case class key)`);
  return name;
}

function parseVerdict(raw: string, extra: string[]): { status: 'ready' | 'needs_revision' | 'blocked'; classes: string[] } {
  let result: any;
  try { result = JSON.parse(raw); } catch {
    const match = /^\s*(?:[-*]\s*)?(?:\*\*)?status(?:\*\*)?\s*:\s*(?:\*\*)?\s*`?(ready|needs_revision|blocked)\b/im.exec(raw);
    result = { status: match?.[1] };
  }
  const status = String(result?.status ?? '').toLowerCase();
  if (status !== 'ready' && status !== 'needs_revision' && status !== 'blocked') {
    throw new PlanReviewError('PLAN_REVIEW_STATUS_REQUIRED: the review must state status: ready | needs_revision | blocked');
  }
  const named: unknown[] = [...extra];
  if (Array.isArray(result?.defect_classes)) named.push(...result.defect_classes);
  for (const list of [result?.findings, result?.blockers]) {
    if (!Array.isArray(list)) continue;
    for (const finding of list) if (finding && typeof finding === 'object' && finding.defect_class) named.push(finding.defect_class);
  }
  return { status, classes: [...new Set(named.map(normalizeClass))].sort() };
}

async function readLedger(runDir: string, runId: string): Promise<Ledger> {
  const file = ledgerPath(runDir);
  if (!existsSync(file)) return { schema: 1, run_id: runId, entries: [] };
  const ledger = JSON.parse(await readFile(file, 'utf8')) as Ledger;
  if (ledger.schema !== 1 || ledger.run_id !== runId || !Array.isArray(ledger.entries)) throw new PlanReviewError('PLAN_REVIEW_LEDGER_INVALID');
  return ledger;
}

async function writeLedger(runDir: string, ledger: Ledger): Promise<void> {
  const file = ledgerPath(runDir);
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`);
  await rename(temporary, file);
}

function runFile(runDir: string, value: string, field: string): { path: string; raw: string } {
  const absolute = resolve(value);
  if (!absolute.startsWith(`${resolve(runDir)}/`)) throw new PlanReviewError(`${field} must live inside the current run directory`);
  let raw = '';
  try { raw = readFileSync(absolute, 'utf8'); } catch { /* reported below */ }
  if (!raw.trim()) throw new PlanReviewError(`${field} is missing or empty: ${value}`);
  return { path: absolute, raw };
}

// Entries of one gate since the owner last let it continue.
function window(ledger: Ledger, gate: string): Entry[] {
  const entries = ledger.entries.filter((entry) => entry.gate === gate);
  const reset = entries.map((entry) => entry.kind).lastIndexOf('owner_continue');
  return entries.slice(reset + 1);
}

function recurringClasses(entries: Entry[]): string[] {
  const reviews = entries.filter((entry): entry is Extract<Entry, { kind: 'review' }> => entry.kind === 'review');
  const [previous, last] = reviews.slice(-2);
  if (!previous || !last || previous.status !== 'needs_revision' || last.status !== 'needs_revision') return [];
  return last.classes.filter((name) => previous.classes.includes(name));
}

// Research is due when the last two verdicts share a class and no research was recorded after the last one.
function researchDue(entries: Entry[]): string[] {
  const recurring = recurringClasses(entries);
  if (!recurring.length) return [];
  const lastReview = entries.map((entry) => entry.kind).lastIndexOf('review');
  return entries.slice(lastReview + 1).some((entry) => entry.kind === 'research') ? [] : recurring;
}

function summary(ledger: Ledger, gate: string) {
  const entries = window(ledger, gate);
  const reviews = entries.filter((entry) => entry.kind === 'review') as Extract<Entry, { kind: 'review' }>[];
  return {
    run_id: ledger.run_id,
    gate,
    status: reviews.at(-1)?.status ?? 'none',
    reviews: reviews.length,
    needs_revision: reviews.filter((entry) => entry.status === 'needs_revision').length,
    autonomous_limit: PLAN_REVIEW_AUTONOMOUS_CYCLES,
    class_research_due: researchDue(entries),
    total_reviews: ledger.entries.filter((entry) => entry.gate === gate && entry.kind === 'review').length,
  };
}

export interface PlanReviewInput {
  runDir: string;
  runId: string;
  gate: string;
  evidencePath?: string;
  defectClasses?: string[];
  researchPath?: string;
  ownerContinue?: string;
}

export async function recordPlanReview(input: PlanReviewInput): Promise<ReturnType<typeof summary>> {
  const { runDir, runId, gate } = input;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || runId.includes('..')) throw new PlanReviewError(`PLAN_REVIEW_RUN_ID_INVALID: ${runId}`);
  if (!GATE_PATTERN.test(gate)) throw new PlanReviewError(`PLAN_REVIEW_GATE_INVALID: ${gate}`);
  const actions = [input.evidencePath, input.researchPath, input.ownerContinue].filter((value) => value !== undefined);
  if (actions.length !== 1) throw new PlanReviewError('plan-review needs exactly one of --evidence, --research or --owner-continue');
  const ledger = await readLedger(runDir, runId);
  const at = new Date().toISOString();

  if (input.ownerContinue !== undefined) {
    if (!input.ownerContinue.trim()) throw new PlanReviewError('--owner-continue needs the owner\'s words');
    ledger.entries.push({ kind: 'owner_continue', gate, reason: input.ownerContinue.trim(), at });
    await writeLedger(runDir, ledger);
    return summary(ledger, gate);
  }
  if (input.researchPath !== undefined) {
    const { path, raw } = runFile(runDir, input.researchPath, 'research');
    if (!researchDue(window(ledger, gate)).length) throw new PlanReviewError(`PLAN_CLASS_RESEARCH_NOT_DUE: ${gate}`);
    ledger.entries.push({ kind: 'research', gate, path, sha256: sha256(raw), at });
    await writeLedger(runDir, ledger);
    return summary(ledger, gate);
  }

  const { path, raw } = runFile(runDir, input.evidencePath!, 'review evidence');
  const hash = sha256(raw);
  // Recording the same verdict again is idempotent.
  if (ledger.entries.some((entry) => entry.kind === 'review' && entry.gate === gate && entry.sha256 === hash)) return summary(ledger, gate);
  const due = researchDue(window(ledger, gate));
  if (due.length) {
    throw new PlanReviewError(`PLAN_CLASS_RESEARCH_REQUIRED: ${gate} classes=${due.join(',')}; record ExternalScout research with --research before the next revision is reviewed`);
  }
  const before = summary(ledger, gate);
  if (before.status === 'needs_revision' && before.needs_revision >= PLAN_REVIEW_AUTONOMOUS_CYCLES) {
    throw new PlanReviewError(`PLAN_REVIEW_LIMIT: ${gate} had ${before.needs_revision} autonomous revisions; owner checkpoint, then --owner-continue`);
  }
  const verdict = parseVerdict(raw, input.defectClasses ?? []);
  ledger.entries.push({ kind: 'review', gate, status: verdict.status, path, sha256: hash, classes: verdict.classes, at });
  await writeLedger(runDir, ledger);
  const after = summary(ledger, gate);
  if (after.status === 'needs_revision' && after.class_research_due.length) {
    throw new PlanReviewError(`PLAN_CLASS_RECURRENCE: ${gate} classes=${after.class_research_due.join(',')}; run ExternalScout on the class, record it with --research, then have the author rework the whole section`);
  }
  if (after.status === 'needs_revision' && after.needs_revision >= PLAN_REVIEW_AUTONOMOUS_CYCLES) {
    throw new PlanReviewError(`PLAN_REVIEW_LIMIT: ${gate} had ${after.needs_revision} autonomous revisions; summarize why it does not converge for the owner`);
  }
  return after;
}

// A manifest whose run keeps a ledger must freeze, for each reviewed gate, the ledger's last verdict: ready.
export function assertPlanReviewLedger(manifest: any, manifestPath: string): void {
  const file = ledgerPath(dirname(resolve(manifestPath)));
  if (!existsSync(file)) return;
  const ledger = JSON.parse(readFileSync(file, 'utf8')) as Ledger;
  const gates = manifest?.planning_readiness?.gates ?? {};
  for (const gate of manifest?.planning_readiness?.required_gates ?? []) {
    const review = gates[gate]?.review;
    if (!review) continue;
    const reviews = ledger.entries.filter((entry) => entry.gate === gate && entry.kind === 'review') as Extract<Entry, { kind: 'review' }>[];
    const last = reviews.at(-1);
    if (!last) throw new Error(`PLAN_REVIEW_LEDGER_MISSING: ${gate} has a frozen review that was never recorded with stage-cli plan-review`);
    if (last.status !== 'ready' || last.sha256 !== review.sha256) {
      throw new Error(`PLAN_REVIEW_LEDGER_MISMATCH: ${gate} frozen review is not the ledger's last ready verdict`);
    }
  }
}
