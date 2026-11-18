// Day 15 customer EMAIL — no-send preflight.
//
// It answers one question: if the Day 15 email were live right now, exactly who
// would receive one, and why is everyone else not receiving one.
//
// It cannot send. It imports no sender, no GoHighLevel write path and no
// dispatcher, and it writes nothing to either provider or to our own database.
// Making it send would mean adding code.
//
// Rules applied, in this order:
//   1. issued 2026-03-01 or later          (lib/reminder-email-window)
//   2. open, with a positive TOTAL and a positive BALANCE, read live from Jobber
//   3. exactly 15 days past the Jobber due date today; no catch-up
//   4. the job's notes must not be confirmed warranty / callback / no-charge
//      rework; unmatched, missing or ambiguous notes HOLD  (lib/reminder-rework-notes)
//   5. the existing recipient, opt-out and per-invoice duplicate checks,
//      unchanged                            (lib/reminder-evaluation)
//
// Output carries invoice numbers and machine reasons only: no names, no email
// addresses, no phone numbers, no message text.
import { prisma } from "../lib/prisma";
import { evaluateReminders, type SendChannel } from "../lib/reminder-evaluation";
import { createReminderEvaluationReaders } from "../lib/reminder-evaluation-readers";
import { DAY15_EMAIL_ISSUED_SINCE, day15EmailIsWithheld, day15EmailIssueWindow } from "../lib/reminder-email-window";
import { classifyReworkNotes, type ReworkVerdict } from "../lib/reminder-rework-notes";

const DAY = 15;
/** Email only. Day 21 keeps whatever it already does; this run never touches it. */
const MILESTONE_CHANNELS = (step: { dayPastDue: number }): readonly SendChannel[] =>
  step.dayPastDue === DAY ? ["email"] : [];

/** Jobber reads must use the token that already exists. Refreshing it writes. */
const MIN_TOKEN_MINUTES = 20;

async function assertExistingJobberTokenIsEnough(): Promise<number> {
  const auth = await prisma.jobberAuth.findFirst({ orderBy: { createdAt: "desc" }, select: { expiresAt: true } });
  if (!auth) throw new Error("no_jobber_auth_row");
  const minutes = Math.floor((auth.expiresAt.getTime() - Date.now()) / 60000);
  if (minutes < MIN_TOKEN_MINUTES) {
    throw new Error(`jobber_token_coverage_too_short: ${minutes}m left; a read would refresh and write. Stopping.`);
  }
  return minutes;
}

/**
 * `--as-of=YYYY-MM-DD` runs the whole chain as if it were 09:05 Phoenix on that
 * date, so the recipient, opt-out and duplicate checks can be exercised against
 * the invoices that will actually be first in line instead of only against a day
 * on which nothing is at day 15. Balances are still read live, which is the
 * point: it shows what would happen today if that date arrived now. It cannot
 * send on any date.
 */
function resolveNow(): { now: Date; label: string } {
  const flag = process.argv.find(arg => arg.startsWith("--as-of="));
  if (!flag) return { now: new Date(), label: "live clock" };
  const date = flag.slice("--as-of=".length);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("as_of_must_be_yyyy_mm_dd");
  // 09:05 Phoenix = 16:05Z. Inside the 09:00-09:15 window, so the "window has
  // already passed today" hold does not mask the checks we want to see.
  const now = new Date(`${date}T16:05:00.000Z`);
  if (!Number.isFinite(now.getTime())) throw new Error("as_of_unparseable");
  return { now, label: `simulated 09:05 Phoenix on ${date}` };
}

async function main() {
  const { now, label } = resolveNow();
  const say = (line: string) => console.log("PF15: " + line);
  say(`clock: ${label}`);
  say(`token coverage ${await assertExistingJobberTokenIsEnough()}m (no refresh, no write)`);

  // Rule 1, from the cache, purely to decide who is worth a live read.
  const cached = await prisma.invoiceRecord.findMany({
    where: {
      invoiceStatus: { in: ["awaiting_payment", "past_due"] },
      amountDue: { gt: 0 },
      issuedAt: { gte: DAY15_EMAIL_ISSUED_SINCE },
    },
    select: {
      jobberInvoiceId: true, invoiceNumber: true, clientName: true, issuedAt: true,
      customer: { select: { jobberClientId: true, email: true, phone: true } },
    },
  });
  say(`in programme by cached issue date (>= 2026-03-01): ${cached.length}`);

  // Rule 4's raw material: the job tied to each invoice, by invoice number.
  const numbers = cached.map(r => r.invoiceNumber).filter((n): n is string => !!n);
  const jobs = await prisma.jobRecord.findMany({
    where: { invoiceNumber: { in: numbers } },
    select: { invoiceNumber: true, notes: true },
  });
  const notesByInvoice = new Map<string, string | null>();
  const seen = new Set<string>();
  for (const job of jobs) {
    if (!job.invoiceNumber) continue;
    // Two jobs on one invoice number is ambiguous; keep the one with notes and
    // record the clash so it cannot quietly resolve to "clear".
    if (seen.has(job.invoiceNumber) && notesByInvoice.get(job.invoiceNumber) !== job.notes) {
      notesByInvoice.set(job.invoiceNumber, "�");
      continue;
    }
    seen.add(job.invoiceNumber);
    notesByInvoice.set(job.invoiceNumber, job.notes ?? null);
  }

  const rework = new Map<string, { verdict: ReworkVerdict; reason: string; evidence: string | null }>();
  for (const row of cached) {
    const key = row.jobberInvoiceId;
    const matched = !!row.invoiceNumber && notesByInvoice.has(row.invoiceNumber);
    rework.set(key, classifyReworkNotes(matched, matched ? notesByInvoice.get(row.invoiceNumber!) ?? null : null));
  }

  const plan = await evaluateReminders({
    candidates: cached.map(row => ({
      jobberInvoiceId: row.jobberInvoiceId,
      invoiceNumber: row.invoiceNumber,
      clientName: row.clientName,
      jobberClientId: row.customer?.jobberClientId ?? null,
      email: row.customer?.email ?? null,
      phone: row.customer?.phone ?? null,
    })),
    readers: createReminderEvaluationReaders(),
    now,
    verifiedExclusions: null,   // asked for separately; nothing is sendable without them
    ignoreWindow: true,         // a manual review, not the 09:00 send window
    milestoneChannels: MILESTONE_CHANNELS,
  });

  const byInvoice = new Map(plan.rows.map(r => [r.jobberInvoiceId, r]));
  const tally = new Map<string, number>();
  const bump = (k: string) => tally.set(k, (tally.get(k) ?? 0) + 1);
  const holdReasons = new Map<string, number>();
  const ready: string[] = [];
  const readyExceptExclusions: string[] = [];
  const excludedRework: string[] = [];
  const zeroAmount: string[] = [];
  const unverifiableNotes: string[] = [];
  const pastDay15: string[] = [];
  const withheld: string[] = [];

  for (const row of cached) {
    const label = `#${row.invoiceNumber ?? "?"}`;
    const ev = byInvoice.get(row.jobberInvoiceId)!;
    const notes = rework.get(row.jobberInvoiceId)!;

    if (ev.holds.some(h => h.startsWith("source_invoice_unreadable"))) { bump("source_unreadable"); continue; }
    // Rule 1 again, this time against the live source issue date rather than the
    // cached one, so a cache that drifted cannot pull an older invoice into the
    // programme. Out of programme is permanent; unusable holds.
    const window = day15EmailIssueWindow(ev.sourceIssuedDate);
    if (window === "before_programme") { bump("source_issued_before_programme"); continue; }
    if (window === "unusable_issue_date") { bump("source_issue_date_unusable"); continue; }
    if (ev.decision === "no_longer_owes") { bump("no_longer_owes"); continue; }
    if (ev.holds.some(h => h.startsWith("source_total") || h.startsWith("source_balance"))) {
      zeroAmount.push(label); bump("zero_or_unreadable_amount"); continue;
    }
    if (notes.verdict === "excluded") { excludedRework.push(`${label}:${notes.evidence}`); bump("excluded_rework"); continue; }
    // Named human carve-outs. Checked before any timing so they can never be
    // "ready", not even for one day.
    if (day15EmailIsWithheld(row.invoiceNumber)) { withheld.push(label); bump("withheld_by_name"); continue; }

    const dpd = ev.daysPastDue;
    if (typeof dpd !== "number") { bump("days_past_due_unknown"); continue; }
    if (dpd > DAY) { pastDay15.push(label); bump("already_past_day_15_no_catch_up"); continue; }
    if (dpd < DAY) { bump("not_yet_day_15"); continue; }

    // From here on it IS day 15 today.
    if (notes.verdict === "hold") { unverifiableNotes.push(`${label}:${notes.reason}`); bump("held_notes_unverifiable"); continue; }

    const other = ev.holds.filter(h => !h.startsWith("exclusions_unverified"));
    for (const h of other) holdReasons.set(h.split(":")[0], (holdReasons.get(h.split(":")[0]) ?? 0) + 1);
    if (other.length === 0) {
      readyExceptExclusions.push(label);
      if (ev.decision === "eligible") ready.push(label);
      bump("ready_except_exclusion_gate");
    } else {
      bump("held_by_existing_checks");
    }
  }

  say("---- counts ----");
  for (const [key, count] of [...tally.entries()].sort((a, b) => b[1] - a[1])) say(`  ${key}: ${count}`);
  say(`  READY today (all checks incl. exclusion gate): ${ready.length}`);
  say(`  READY apart from the exclusion gate: ${readyExceptExclusions.length} ${readyExceptExclusions.join(" ")}`);
  say(`  excluded as rework: ${excludedRework.length} ${excludedRework.join(" ")}`);
  say(`  excluded, zero or unreadable amount: ${zeroAmount.length} ${zeroAmount.join(" ")}`);
  say(`  held, notes unverifiable: ${unverifiableNotes.length} ${unverifiableNotes.join(" ")}`);
  say(`  already past day 15, never replayed: ${pastDay15.length} ${pastDay15.join(" ")}`);
  say(`  withheld by name (never sendable): ${withheld.length} ${withheld.join(" ")}`);
  if (holdReasons.size) { say("---- other hold reasons on day-15 invoices ----");
    for (const [r, c] of [...holdReasons.entries()].sort((a, b) => b[1] - a[1])) say(`  ${r}: ${c}`); }

  // Programme-wide notes picture, so the warranty rule's blind spot is visible
  // even for invoices that are not at day 15 today.
  const notesTally = new Map<string, number>();
  for (const value of rework.values()) notesTally.set(value.reason, (notesTally.get(value.reason) ?? 0) + 1);
  say("---- notes verdicts across the whole programme ----");
  for (const [r, c] of [...notesTally.entries()].sort((a, b) => b[1] - a[1])) say(`  ${r}: ${c}`);

  say(`sends attempted: ${plan.sendsAttempted} (this script has no send path)`);
  for (const note of plan.notes) say(`note: ${note}`);
}

main()
  .then(async () => { await prisma.$disconnect(); process.exit(0); })
  .catch(async (err: any) => {
    console.error("PF15 FAILED:", err?.message ?? err);
    await prisma.$disconnect();
    process.exit(1);
  });
