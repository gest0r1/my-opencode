// Deterministic ledger of PLAN gate reviews. The orchestrator records every review verdict here instead of
// counting cycles itself. Nothing in it waits for the owner unless a verdict needs an owner decision:
// a repeated defect class or a third autonomous revision requires recorded research and a whole-section
// rework; a gate still open after that carries its technical findings into RUN as work-item checks.
// Intermediate re-reviews may read the delta; the review that freezes a gate is a full fresh review.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const PLAN_REVIEW_AUTONOMOUS_CYCLES = 3;
const CLASS_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const GATE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const OWNER_CLASSIFICATIONS = ['replan', 'security_stop', 'scope_stop', 'secret_stop', 'destructive_stop'];

type Review = {
  kind: 'review'; gate: string; status: 'ready' | 'needs_revision' | 'blocked'; scope: 'full' | 'delta';
  owner_decision: boolean; path: string; sha256: string; classes: string[]; at: string;
};
type Entry =
  | Review
  | { kind: 'research'; gate: string; path: string; sha256: string; at: string }
  | { kind: 'carry'; gate: string; path: string; sha256: string; review_sha256: string; at: string };

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

function parseVerdict(raw: string, extra: string[]) {
  let result: any;
  let json = true;
  try { result = JSON.parse(raw); } catch {
    json = false;
    const field = (name: string, values: string) =>
      new RegExp(`^\\s*(?:[-*]\\s*)?(?:\\*\\*)?${name}(?:\\*\\*)?\\s*:\\s*(?:\\*\\*)?\\s*\`?(${values})\\b`, 'im').exec(raw)?.[1];
    result = { status: field('status', 'ready|needs_revision|blocked'), review_scope: field('review_scope', 'full|delta') };
  }
  const status = String(result?.status ?? '').toLowerCase();
  if (status !== 'ready' && status !== 'needs_revision' && status !== 'blocked') {
    throw new PlanReviewError('PLAN_REVIEW_STATUS_REQUIRED: the review must state status: ready | needs_revision | blocked');
  }
  const scope = String(result?.review_scope ?? '').toLowerCase();
  if (scope !== 'full' && scope !== 'delta') throw new PlanReviewError('PLAN_REVIEW_SCOPE_REQUIRED: the review must state review_scope: full | delta');
  const named: unknown[] = [...extra];
  let owner = result?.owner_decision_required === true;
  if (Array.isArray(result?.defect_classes)) named.push(...result.defect_classes);
  for (const list of [result?.findings, result?.blockers]) {
    if (!Array.isArray(list)) continue;
    for (const finding of list) {
      if (!finding || typeof finding !== 'object') continue;
      if (finding.defect_class) named.push(finding.defect_class);
      if (OWNER_CLASSIFICATIONS.includes(String(finding.classification ?? finding.category ?? ''))) owner = true;
    }
  }
  // Text verdicts list blockers as "- <category> [<class>]: <text>".
  if (!json && new RegExp(`^\\s*-\\s*(?:${OWNER_CLASSIFICATIONS.join('|')})\\b`, 'im').test(raw)) owner = true;
  return { status: status as Review['status'], scope: scope as Review['scope'], owner_decision: owner, classes: [...new Set(named.map(normalizeClass))].sort() };
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

const gateEntries = (ledger: Ledger, gate: string) => ledger.entries.filter((entry) => entry.gate === gate);
const reviewsOf = (entries: Entry[]) => entries.filter((entry): entry is Review => entry.kind === 'review');

function recurringClasses(entries: Entry[]): string[] {
  const [previous, last] = reviewsOf(entries).slice(-2);
  if (!previous || !last || previous.status !== 'needs_revision' || last.status !== 'needs_revision') return [];
  return last.classes.filter((name) => previous.classes.includes(name));
}

// Why research is due before the next revision is reviewed: a class repeated by the last two verdicts,
// or the autonomous revision count reached (escalation: research + whole-section rework by a fresh author).
function researchDue(entries: Entry[]): { classes: string[]; escalation: boolean } {
  const reviews = reviewsOf(entries);
  const last = reviews.at(-1);
  if (!last || last.status !== 'needs_revision' || last.owner_decision) return { classes: [], escalation: false };
  const lastReview = entries.lastIndexOf(last);
  if (entries.slice(lastReview + 1).some((entry) => entry.kind === 'research')) return { classes: [], escalation: false };
  const revisions = reviews.filter((entry) => entry.status === 'needs_revision').length;
  return { classes: recurringClasses(entries), escalation: revisions === PLAN_REVIEW_AUTONOMOUS_CYCLES };
}

function summary(ledger: Ledger, gate: string) {
  const entries = gateEntries(ledger, gate);
  const reviews = reviewsOf(entries);
  const last = reviews.at(-1);
  const revisions = reviews.filter((entry) => entry.status === 'needs_revision').length;
  const carried = Boolean(last && entries.some((entry) => entry.kind === 'carry' && entry.review_sha256 === last.sha256));
  const due = researchDue(entries);
  let next = 'review';
  if (!last) next = 'review';
  else if (last.owner_decision) next = 'owner_decision';
  else if (carried) next = 'freeze_with_carried_findings';
  else if (last.status === 'ready') next = last.scope === 'full' ? 'freeze' : 'full_review';
  else if (due.classes.length || due.escalation) next = 'research_then_rework';
  else if (revisions > PLAN_REVIEW_AUTONOMOUS_CYCLES) next = 'revise_or_carry';
  else next = 'revise';
  return {
    run_id: ledger.run_id,
    gate,
    status: carried ? 'carried' : last?.status ?? 'none',
    scope: last?.scope ?? null,
    reviews: reviews.length,
    needs_revision: revisions,
    autonomous_cycles: PLAN_REVIEW_AUTONOMOUS_CYCLES,
    class_research_due: due.classes,
    escalation_due: due.escalation,
    owner_decision: Boolean(last?.owner_decision),
    next,
  };
}

export interface PlanReviewInput {
  runDir: string;
  runId: string;
  gate: string;
  evidencePath?: string;
  defectClasses?: string[];
  researchPath?: string;
  carryPath?: string;
}

export async function recordPlanReview(input: PlanReviewInput): Promise<ReturnType<typeof summary>> {
  const { runDir, runId, gate } = input;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || runId.includes('..')) throw new PlanReviewError(`PLAN_REVIEW_RUN_ID_INVALID: ${runId}`);
  if (!GATE_PATTERN.test(gate)) throw new PlanReviewError(`PLAN_REVIEW_GATE_INVALID: ${gate}`);
  const actions = [input.evidencePath, input.researchPath, input.carryPath].filter((value) => value !== undefined);
  if (actions.length !== 1) throw new PlanReviewError('plan-review needs exactly one of --evidence, --research or --carry');
  const ledger = await readLedger(runDir, runId);
  const at = new Date().toISOString();
  const entries = gateEntries(ledger, gate);
  const current = summary(ledger, gate);

  if (input.researchPath !== undefined) {
    const { path, raw } = runFile(runDir, input.researchPath, 'research');
    const due = researchDue(entries);
    if (!due.classes.length && !due.escalation) throw new PlanReviewError(`PLAN_RESEARCH_NOT_DUE: ${gate}`);
    ledger.entries.push({ kind: 'research', gate, path, sha256: sha256(raw), at });
    await writeLedger(runDir, ledger);
    return summary(ledger, gate);
  }
  if (input.carryPath !== undefined) {
    if (current.next !== 'revise_or_carry') {
      throw new PlanReviewError(current.owner_decision
        ? `PLAN_OWNER_DECISION_REQUIRED: ${gate} has a finding that changes a decision or a business story; it cannot be carried`
        : `PLAN_CARRY_NOT_ALLOWED: ${gate} next=${current.next}; findings are carried only after the escalation rework was reviewed`);
    }
    const { path, raw } = runFile(runDir, input.carryPath, 'carried findings');
    const last = reviewsOf(entries).at(-1)!;
    ledger.entries.push({ kind: 'carry', gate, path, sha256: sha256(raw), review_sha256: last.sha256, at });
    await writeLedger(runDir, ledger);
    return summary(ledger, gate);
  }

  const { path, raw } = runFile(runDir, input.evidencePath!, 'review evidence');
  const hash = sha256(raw);
  // Recording the same verdict again is idempotent.
  if (entries.some((entry) => entry.kind === 'review' && entry.sha256 === hash)) return current;
  const due = researchDue(entries);
  if (due.classes.length || due.escalation) {
    const why = due.classes.length ? `classes=${due.classes.join(',')}` : `${PLAN_REVIEW_AUTONOMOUS_CYCLES} revisions did not converge`;
    throw new PlanReviewError(`PLAN_RESEARCH_REQUIRED: ${gate} ${why}; record research with --research and have a fresh author rework the whole section before the next review`);
  }
  const verdict = parseVerdict(raw, input.defectClasses ?? []);
  ledger.entries.push({ kind: 'review', gate, ...verdict, path, sha256: hash, at });
  await writeLedger(runDir, ledger);
  return summary(ledger, gate);
}

// A manifest whose run keeps a ledger must freeze, for each reviewed gate, the ledger's last verdict:
// a full ready review, or a later verdict whose technical findings were carried into RUN.
export function assertPlanReviewLedger(manifest: any, manifestPath: string): void {
  const file = ledgerPath(dirname(resolve(manifestPath)));
  if (!existsSync(file)) return;
  const ledger = JSON.parse(readFileSync(file, 'utf8')) as Ledger;
  const gates = manifest?.planning_readiness?.gates ?? {};
  for (const gate of manifest?.planning_readiness?.required_gates ?? []) {
    const review = gates[gate]?.review;
    if (!review) continue;
    const state = summary(ledger, gate);
    const last = reviewsOf(gateEntries(ledger, gate)).at(-1);
    if (!last) throw new Error(`PLAN_REVIEW_LEDGER_MISSING: ${gate} has a frozen review that was never recorded with stage-cli plan-review`);
    if (last.sha256 !== review.sha256) throw new Error(`PLAN_REVIEW_LEDGER_MISMATCH: ${gate} frozen review is not the ledger's last verdict`);
    if (state.next !== 'freeze' && state.next !== 'freeze_with_carried_findings') {
      throw new Error(`PLAN_REVIEW_NOT_FREEZABLE: ${gate} next=${state.next} (the freezing review must be a full ready review or have carried findings)`);
    }
    if (state.next === 'freeze_with_carried_findings') {
      const carry = gateEntries(ledger, gate).find((entry) => entry.kind === 'carry' && entry.review_sha256 === last.sha256);
      const listed = JSON.stringify(manifest?.planning_readiness?.carried_findings ?? []);
      if (carry && !listed.includes((carry as any).sha256)) {
        throw new Error(`PLAN_CARRIED_FINDINGS_NOT_FROZEN: ${gate} carried findings must be frozen in planning_readiness.carried_findings with their SHA-256`);
      }
    }
  }
}
