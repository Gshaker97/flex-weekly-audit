/**
 * THE FULL RECONCILE. Once a day, check everything that could be wrong against
 * Jobber's live figures, whether or not Jobber says it changed.
 *
 * WHY IT EXISTS
 *
 * The hourly sync is incremental: it asks Jobber for invoices by `updatedAt`,
 * so an invoice Jobber has not touched is never re-read and never re-labelled.
 * The hourly re-check (`open-invoice-status-refresh`) covers the gap for rows
 * that already say they are owing, but it is scoped - deliberately, for cost -
 * to a small set. Between those two scopes a row can be wrong indefinitely:
 * measured 2026-11-27, 12 invoices read `paid` with $25,983.82 outstanding,
 * none of them re-read since 2026-11-25.
 *
 * This module closes that gap by choosing the scope by RISK rather than by what
 * Jobber reported:
 *
 *   - every invoice this system calls open;
 *   - every invoice labelled paid that still shows a balance;
 *   - every invoice paid recently enough that a refund or reversal is plausible;
 *   - every invoice named by a card on the GHL invoice pipeline, at any age,
 *     so no card on the board is judged against an unverified figure.
 *
 * WHAT IT MAY AND MAY NOT DO
 *
 * It corrects STORED LABELS, through the same pre-image-guarded transaction the
 * hourly re-check uses, and nothing else. It writes no GHL card and sends no
 * text or email - it has no transport of any kind. Card stages are moved by the
 * card pass that runs after it, inside the same admitted sync run, under its own
 * gates, its own per-run budget and the journal's duplicate guards. That split
 * is deliberate: one writer owns card writes, so a reconcile can never become a
 * second path that creates a duplicate card.
 *
 * Anything it cannot act on is HELD with a reason and reported. A failure here
 * is reported and the run continues: a reconcile is a reading, so failing to
 * take one must never block the next hour's sync.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { log, logError } from "./log";
import {
  INVOICE_SNAPSHOT_SELECT, runInvoiceStatusRecheck, paidBalanceCorrectionEnabled,
  type OpenInvoiceSnapshot, type StatusRefreshPlan,
} from "./open-invoice-status-refresh";
import {
  syncRunDiagnostics, RECONCILE_LIST_LIMIT,
  type SyncRunReconcile, type SyncRunCorrection, type SyncRunSkip,
} from "./sync-writer-control";
import { invoiceNumbersInCardName } from "./ghl-invoice-card-plan";

/** How recently an invoice must have been issued to count as "recently paid". */
export const DEFAULT_RECENTLY_PAID_DAYS = 45;
/** How many hours must pass before another reconcile is due. */
export const RECONCILE_INTERVAL_HOURS = 20;
/** How many finished runs back to look for the last reconcile stamp. */
const RECONCILE_LOOKBACK_RUNS = 64;

export function recentlyPaidDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.RECONCILE_RECENTLY_PAID_DAYS);
  // A malformed or absurd setting falls back to the default rather than
  // widening the scope to every invoice ever issued.
  return Number.isFinite(raw) && raw >= 1 && raw <= 400 ? Math.floor(raw) : DEFAULT_RECENTLY_PAID_DAYS;
}

/**
 * Is a reconcile due? True when no finished run in the recent history carries a
 * reconcile stamp newer than the interval.
 *
 * Deliberately NOT a calendar-day test. "Once a day" has to survive a run that
 * is late, slow or skipped, and a run-based interval gives every later hourly
 * run a chance to catch up instead of waiting for midnight. Twenty hours means
 * it lands at a slightly different hour each day rather than never.
 */
export function reconcileDue(
  lastAt: Date | null, now: Date = new Date(), env: NodeJS.ProcessEnv = process.env
): boolean {
  // The one switch, for an operator who wants a reconcile on the next run.
  if (env.RECONCILE_FORCE === "true") return true;
  if (env.RECONCILE_ENABLED === "false") return false;
  if (!lastAt || !Number.isFinite(lastAt.getTime())) return true;
  // A stamp dated in the future is a clock problem, not a reconcile.
  if (lastAt.getTime() > now.getTime()) return true;
  return now.getTime() - lastAt.getTime() >= RECONCILE_INTERVAL_HOURS * 3600_000;
}

/**
 * When the last reconcile ran, from the journal envelopes of recent runs.
 *
 * Read out of the run rows on purpose: it needs no schema change, and the stamp
 * lives with the run that produced it, so it cannot drift from the evidence.
 * Unreadable is reported as null, which makes a reconcile due - the safe
 * direction, because a reconcile that runs twice costs reads, while one that
 * never runs is the bug this module exists to fix.
 */
export async function lastReconcileAt(db = prisma): Promise<Date | null> {
  try {
    const runs = await db.syncRun.findMany({
      where: { errorMessage: { not: null } },
      orderBy: { startedAt: "desc" }, take: RECONCILE_LOOKBACK_RUNS,
      select: { id: true, errorMessage: true },
    });
    let newest: Date | null = null;
    for (const run of runs) {
      const at = syncRunDiagnostics(run.errorMessage, run.id).reconcile?.at;
      if (!at) continue;
      const when = new Date(at);
      if (!Number.isFinite(when.getTime())) continue;
      if (!newest || when > newest) newest = when;
    }
    return newest;
  } catch (error) {
    logError(`[reconcile] could not read the last reconcile stamp (treating one as due): ${
      error instanceof Error ? error.message.slice(0, 160) : "unknown error"}`);
    return null;
  }
}

/** How many recent runs a page looks back through for the last reconcile. */
export const RECONCILE_PANEL_LOOKBACK_RUNS = 30;

/**
 * The most recent of these runs that actually took a reconcile.
 *
 * The dashboard needs this because the reconcile runs about once a day: the
 * newest run almost never carries the stamp, and showing nothing would make a
 * daily record look like it never happened.
 */
export function latestReconcileRun<T extends { id: string; errorMessage: string | null }>(
  runs: readonly T[]
): T | null {
  for (const run of runs) {
    if (syncRunDiagnostics(run.errorMessage, run.id).reconcile) return run;
  }
  return null;
}

/**
 * The rows this reconcile reads. Risk-based, and bounded in every direction:
 * the age window is capped, and the card clause names specific invoice numbers
 * rather than opening the scope to every invoice a card might mention.
 */
export function reconcileScopeWhere(
  now: Date, days: number, cardInvoiceNumbers: readonly string[]
): Prisma.InvoiceRecordWhereInput {
  const since = new Date(now.getTime() - days * 86400_000);
  const numbers = [...new Set(cardInvoiceNumbers.filter(n => typeof n === "string" && n.length > 0))];
  return {
    OR: [
      // Still open by our own reckoning.
      { invoiceStatus: { in: ["awaiting_payment", "past_due"] } },
      // Paid with money still on it - the 12, and anything that joins them.
      { invoiceStatus: "paid", amountDue: { gt: 0 } },
      // Recently paid, where a refund or reversal is still plausible. Keyed on
      // the issue date because `paidAt` is a copy of `issuedAt` on every row in
      // this database and cannot be read as a payment date.
      { invoiceStatus: "paid", issuedAt: { gte: since } },
      { invoiceStatus: "paid", issuedAt: null, createdAtJobber: { gte: since } },
      // Named by a card on the board, at any age: a card must never be judged
      // against a figure nothing has verified.
      ...(numbers.length ? [{ invoiceNumber: { in: numbers } }] : []),
    ],
  };
}

/** Group plain sentences into "reason × count", largest first. */
export function groupReasons(
  reasons: readonly string[], limit = RECONCILE_LIST_LIMIT
): ReadonlyArray<Readonly<{ reason: string; count: number }>> {
  const counts = new Map<string, number>();
  for (const raw of reasons) {
    const reason = typeof raw === "string" ? raw.trim() : "";
    if (reason) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return Object.freeze([...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([reason, count]) => Object.freeze({ reason, count })));
}

/** A snapshot plus the two columns a person needs to read a correction. */
type ScopedInvoice = OpenInvoiceSnapshot & {
  invoiceNumber: string | null;
  clientName: string | null;
};

export interface InvoiceReconcileResult {
  stamp: SyncRunReconcile;
  plan: StatusRefreshPlan;
}

/**
 * Run the label half of the reconcile over an explicit card snapshot.
 *
 * The cards are passed in rather than fetched: the card pass has already taken
 * one complete, verified snapshot of the pipeline this run, and taking a second
 * one would mean reconciling against a board that may have moved in between.
 */
export async function reconcileInvoiceLabels(input: {
  /** The pipeline snapshot the card pass is using, names included. */
  cards: ReadonlyArray<{ name?: string | null }>;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  db?: typeof prisma;
}): Promise<InvoiceReconcileResult> {
  const now = input.now ?? new Date();
  const env = input.env ?? process.env;
  const db = input.db ?? prisma;
  const days = recentlyPaidDays(env);

  const cardNumbers = input.cards.flatMap(card => [...invoiceNumbersInCardName(card.name)]);
  const scope = reconcileScopeWhere(now, days, cardNumbers);
  const scoped = (await db.invoiceRecord.findMany({
    where: scope,
    select: { ...INVOICE_SNAPSHOT_SELECT, invoiceNumber: true, clientName: true },
  })) as ScopedInvoice[];

  // Who each invoice is, for the dashboard. Keyed by the Jobber id, which is
  // what the plan's holds and updates carry.
  const named = new Map(scoped.map(inv => [inv.jobberInvoiceId, inv]));
  const label = (jobberInvoiceId: string) => {
    const row = named.get(jobberInvoiceId);
    return { invoiceNumber: row?.invoiceNumber ?? null, customer: row?.clientName ?? null };
  };

  log(`[reconcile] scope: ${scoped.length} invoices (open, paid-with-a-balance,`
    + ` paid within ${days} days, or named by one of ${new Set(cardNumbers).size} card invoice numbers)`);

  const plan = await runInvoiceStatusRecheck(scoped, "full reconcile");

  const corrections: SyncRunCorrection[] = plan.updates
    .slice(0, RECONCILE_LIST_LIMIT)
    .map(update => Object.freeze({
      ...label(update.cached.jobberInvoiceId),
      from: update.cached.invoiceStatus, to: update.invoiceStatus,
    }));
  const holds: SyncRunSkip[] = plan.holds
    .slice(0, RECONCILE_LIST_LIMIT)
    .map(hold => Object.freeze({ ...label(hold.jobberInvoiceId), reason: plainReconcileHold(hold.reason) }));

  const stamp: SyncRunReconcile = Object.freeze({
    at: now.toISOString(),
    checkedInvoices: plan.checked,
    checkedCards: input.cards.length,
    corrected: plan.updates.length,
    corrections,
    held: plan.holds.length,
    holds,
    holdReasons: groupReasons(plan.holds.map(h => plainReconcileHold(h.reason))),
    cardReasons: Object.freeze([]),
    scope: `Checked ${plan.checked} invoices against Jobber's live balance and status`
      + ` — every open invoice, every invoice labelled paid that still owes money,`
      + ` everything paid in the last ${days} days, and every invoice named by a card on the board.`
      + (paidBalanceCorrectionEnabled(env) ? "" : " Label corrections are switched off, so nothing was changed."),
  });
  return { stamp, plan };
}

/**
 * The plain sentence behind one reconcile hold code.
 *
 * The re-check's own reasons are already readable, so this maps the ones worth
 * rewording and passes everything else through. A sentence a person has to
 * decode is not a reason.
 */
export function plainReconcileHold(reason: string): string {
  const sentences: Record<string, string> = {
    "Source object unavailable; retained last-known state":
      "Jobber did not return this invoice, so its stored figures were left exactly as they were.",
    "Unknown source status":
      "Jobber returned a status this system does not recognise, so nothing was changed.",
    "Unknown or changed invoice owner":
      "The customer on this invoice in Jobber is not the one on file, so nothing was changed.",
    "Unknown source amounts":
      "Jobber did not return readable amounts for this invoice, so nothing was changed.",
    "Conflicting or credit balance requires review":
      "The amounts on this invoice contradict each other, so a person needs to look before anything moves.",
    "Amounts changed; requires full invoice sync, not a status-only correction":
      "The amounts on this invoice have changed, which is more than a label correction can safely handle.",
    "Invoice total changed; requires full invoice sync, not a status correction":
      "The invoice total has changed, so it was re-issued or edited. That needs a full sync, not a label fix.",
    "Cached invoice is no longer open":
      "Jobber and this system agree the invoice is settled, so there was nothing to correct.",
    "Unknown cached amounts":
      "The stored amounts for this invoice are not readable, so nothing was changed.",
    "Balance changed without a status change; requires full invoice sync":
      "The balance moved but the status did not, which can be a part payment or a credit. A full sync handles it.",
    "Balance changed on a non-payment transition; requires full invoice sync":
      "The balance moved in a way this narrow read cannot explain, so a full sync handles it.",
  };
  return sentences[reason] ?? reason;
}
