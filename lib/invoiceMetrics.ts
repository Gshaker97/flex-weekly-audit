import type { Prisma } from "@prisma/client";
import type { DateRange } from "./dateRange";

// Billing value is not cash received. Bad debt remains historical billing;
// draft, void and unrecognized states must not silently become revenue.
export const ISSUED_INVOICE_STATUSES = [
  "paid", "awaiting_payment", "past_due", "bad_debt",
];
export const OPEN_INVOICE_STATUSES = ["awaiting_payment", "past_due"];

export function issuedInvoiceWhere(range?: Pick<DateRange, "start" | "end">): Prisma.InvoiceRecordWhereInput {
  return {
    invoiceStatus: { in: ISSUED_INVOICE_STATUSES },
    ...(range ? { issuedAt: { gte: range.start, lte: range.end } } : {}),
  };
}

export function openReceivablesWhere(range?: Pick<DateRange, "start" | "end">): Prisma.InvoiceRecordWhereInput {
  return {
    invoiceStatus: { in: OPEN_INVOICE_STATUSES },
    amountDue: { gt: 0 },
    ...(range ? { issuedAt: { gte: range.start, lte: range.end } } : {}),
  };
}

// Preserve contradictory balances in an explicit review list, never classify
// them as collectible or settled just from one of the two fields.
export function balanceReviewWhere(range?: Pick<DateRange, "start" | "end">): Prisma.InvoiceRecordWhereInput {
  return {
    amountDue: { gt: 0 },
    OR: [
      { invoiceStatus: { notIn: OPEN_INVOICE_STATUSES } },
      { invoiceStatus: null },
    ],
    ...(range ? { issuedAt: { gte: range.start, lte: range.end } } : {}),
  };
}

// Presentation only. Aging an awaiting-payment row never changes its cached
// status, refreshes Jobber, or establishes the original sent-day reminder clock.
function overdueDisplayWhere(asOf: Date): Prisma.InvoiceRecordWhereInput {
  if (!Number.isFinite(asOf.getTime())) throw new RangeError("Invalid display reference time");
  return {
    amountDue: { gt: 0 },
    OR: [
      { invoiceStatus: "past_due" },
      { invoiceStatus: "awaiting_payment", dueAt: { lt: asOf } },
    ],
  };
}

export function overdueInvoicesWhere(range: Pick<DateRange, "start" | "end"> | undefined, cutoff: Date, asOf: Date): Prisma.InvoiceRecordWhereInput {
  return {
    ...overdueDisplayWhere(asOf),
    issuedAt: range
      ? { gte: range.start > cutoff ? range.start : cutoff, lte: range.end }
      : { gte: cutoff },
  };
}

export function legacyOverdueWhere(range: Pick<DateRange, "start" | "end">, cutoff: Date, asOf: Date): Prisma.InvoiceRecordWhereInput {
  return {
    ...overdueDisplayWhere(asOf),
    issuedAt: { gte: range.start, lte: range.end, lt: cutoff },
  };
}

export function overdueDisplayBasis(invoice: { invoiceStatus: string | null; amountDue: number; dueAt: Date | null }, asOf: Date): string | null {
  if (!Number.isFinite(asOf.getTime()) || !(invoice.amountDue > 0)) return null;
  if (invoice.invoiceStatus === "past_due") return "Cached past_due status";
  if (invoice.invoiceStatus === "awaiting_payment" && invoice.dueAt &&
      Number.isFinite(invoice.dueAt.getTime()) && invoice.dueAt < asOf) {
    return "Calculated from stored due date";
  }
  return null;
}

export function invoiceValueIncluded(status: string | null | undefined): boolean {
  return ISSUED_INVOICE_STATUSES.includes(status ?? "");
}

export function invoiceReviewReason(invoice: { invoiceStatus: string | null; amountDue: number }): string {
  if (invoice.amountDue > 0 && !OPEN_INVOICE_STATUSES.includes(invoice.invoiceStatus ?? "")) {
    return `${invoice.invoiceStatus || "Unknown status"} with a positive balance; verify in Jobber before collection or settlement`;
  }
  if (invoice.amountDue <= 0 && OPEN_INVOICE_STATUSES.includes(invoice.invoiceStatus ?? "")) {
    return `${invoice.invoiceStatus} with a zero or negative balance; verify source and payment evidence before treating as settled`;
  }
  if (!invoiceValueIncluded(invoice.invoiceStatus)) {
    return "Excluded from issued invoice value: draft, void or unrecognized status";
  }
  return "";
}

export function totalLessBalance(total: number, balance: number): number {
  return Math.round((total - balance) * 100) / 100;
}

export function invoiceMonthKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Phoenix", year: "numeric", month: "2-digit",
  }).formatToParts(date);
  return `${parts.find(p => p.type === "year")!.value}-${parts.find(p => p.type === "month")!.value}`;
}

export function sumInvoiceMonths(invoices: Array<{ issuedAt: Date | null; total: number }>): Map<string, number> {
  const months = new Map<string, number>();
  for (const invoice of invoices) {
    if (!invoice.issuedAt) continue;
    const key = invoiceMonthKey(invoice.issuedAt);
    months.set(key, (months.get(key) ?? 0) + invoice.total);
  }
  return months;
}

// ---------------------------------------------------------------------------
// Source-verification freshness.
//
// Two independent Jobber reads can confirm an invoice:
//
//   the FULL incremental invoice sync      -> advances `lastSyncedAt`
//   the hourly open-invoice status refresh -> advances `lastVerifiedAt`
//
// The hourly refresh deliberately does NOT advance `lastSyncedAt`, because it
// covers only status, amounts and owner. Before `lastVerifiedAt` existed, its
// outcome went to a log line and nothing else, so these two cases were
// indistinguishable in the database:
//
//   confirmed against Jobber this hour, unchanged   -> nothing written
//   not confirmable at all (Jobber returned null)   -> nothing written
//
// That is why 59 of 73 open invoices read as "not fully refreshed" when only one
// is genuinely unconfirmable. `lastVerifyOutcome` closes that gap: it records the
// result of the most recent hourly check, and because that check covers every
// open invoice on every run, it is always as of the latest run.
//
// A row is CONFIRMED when either read succeeded recently. It is UNCONFIRMED only
// when the latest check actually failed. An unconfirmed row keeps its stored
// status and balance and stays in every total -- not knowing is never recorded
// as paid, and never silently dropped.
// ---------------------------------------------------------------------------

/** Beyond this, a row is reported as not confirmed recently rather than simply shown. */
export const INVOICE_VERIFICATION_STALE_DAYS = 2;

/** The one `lastVerifyOutcome` value that means Jobber confirmed the row. */
export const INVOICE_VERIFY_CONFIRMED = "confirmed";

const DAY_MS = 86_400_000;

/** Older rows predate `lastVerifiedAt`, so both fields stay optional. */
export type InvoiceVerificationFields = {
  lastSyncedAt: Date | null;
  lastVerifiedAt?: Date | null;
  lastVerifyOutcome?: string | null;
};

const stamp = (value: Date | null | undefined): number | null => {
  const at = value?.getTime();
  return Number.isFinite(at) ? at! : null;
};

/** True when the most recent hourly check failed to confirm this invoice. */
export function invoiceVerificationFailed(invoice: InvoiceVerificationFields): boolean {
  const outcome = invoice.lastVerifyOutcome;
  return typeof outcome === "string" && outcome.length > 0 && outcome !== INVOICE_VERIFY_CONFIRMED;
}

/**
 * Whole days since Jobber last confirmed this invoice by EITHER read, whichever
 * is more recent. Null when neither read has ever recorded a confirmation.
 */
export function invoiceVerificationAgeDays(
  invoice: InvoiceVerificationFields,
  asOf: Date,
): number | null {
  const ref = stamp(asOf);
  const at = Math.max(stamp(invoice.lastVerifiedAt) ?? -Infinity, stamp(invoice.lastSyncedAt) ?? -Infinity);
  if (ref === null || !Number.isFinite(at)) return null;
  return Math.max(0, Math.floor((ref - at) / DAY_MS));
}

export type InvoiceVerificationState = "confirmed" | "unconfirmed" | "stale";

/**
 * `unconfirmed` is reserved for a check that ran and failed. `stale` means no
 * recent confirmation and no recorded failure either -- nothing is claimed
 * about why.
 */
export function invoiceVerificationState(
  invoice: InvoiceVerificationFields,
  asOf: Date,
  staleDays: number = INVOICE_VERIFICATION_STALE_DAYS,
): InvoiceVerificationState {
  const age = invoiceVerificationAgeDays(invoice, asOf);
  if (age !== null && age < staleDays) return "confirmed";
  return invoiceVerificationFailed(invoice) ? "unconfirmed" : "stale";
}

/** True when this row was not confirmed by either Jobber read recently. */
export function invoiceVerificationIsStale(
  invoice: InvoiceVerificationFields,
  asOf: Date,
  staleDays: number = INVOICE_VERIFICATION_STALE_DAYS,
): boolean {
  return invoiceVerificationState(invoice, asOf, staleDays) !== "confirmed";
}

/**
 * One short phrase for display, or null when confirmed recently. Never says
 * paid, unpaid or settled: a failed check carries no information about the
 * balance, only about our ability to read it.
 */
export function invoiceVerificationBasis(
  invoice: InvoiceVerificationFields,
  asOf: Date,
  staleDays: number = INVOICE_VERIFICATION_STALE_DAYS,
): string | null {
  const state = invoiceVerificationState(invoice, asOf, staleDays);
  if (state === "confirmed") return null;
  const age = invoiceVerificationAgeDays(invoice, asOf);
  const since = age === null
    ? "never confirmed from Jobber"
    : `last confirmed ${age} day${age === 1 ? "" : "s"} ago`;
  if (state === "unconfirmed") return `Jobber could not confirm this invoice; ${since}`;
  return age === null ? "No refresh timestamp recorded" : `Not fully refreshed for ${age} day${age === 1 ? "" : "s"}`;
}

/**
 * Worst case across the rows actually displayed, so a current sync run cannot
 * imply every figure on the page is current. `unconfirmedCount` counts only
 * rows whose latest check failed.
 */
export function oldestInvoiceVerification(
  invoices: ReadonlyArray<InvoiceVerificationFields>,
  asOf: Date,
): Readonly<{ oldestDays: number | null; staleCount: number; unconfirmedCount: number; total: number }> {
  let oldestDays: number | null = null;
  let staleCount = 0;
  let unconfirmedCount = 0;
  for (const invoice of invoices) {
    const state = invoiceVerificationState(invoice, asOf);
    if (state !== "confirmed") staleCount++;
    if (state === "unconfirmed") unconfirmedCount++;
    const age = invoiceVerificationAgeDays(invoice, asOf);
    if (age !== null && (oldestDays === null || age > oldestDays)) oldestDays = age;
  }
  return Object.freeze({ oldestDays, staleCount, unconfirmedCount, total: invoices.length });
}

/**
 * One sentence for a page header. Refuses to call the page current on the
 * strength of a completed run alone, and names the unconfirmable rows
 * separately from rows that are merely waiting on the next full sync.
 */
export function describeDashboardFreshness(
  lastSuccessfulSyncAt: Date | null,
  rows: Readonly<{ oldestDays: number | null; staleCount: number; unconfirmedCount?: number; total: number }>,
): string {
  const run = lastSuccessfulSyncAt
    ? `Last successful sync ${lastSuccessfulSyncAt.toISOString().slice(0, 16).replace("T", " ")}Z`
    : "No successful sync recorded";
  if (!rows.total) return `${run}. No invoices shown.`;
  if (!rows.staleCount) {
    return `${run}. All ${rows.total} shown confirmed from Jobber within ${INVOICE_VERIFICATION_STALE_DAYS} days.`;
  }
  const oldest = rows.oldestDays === null ? "unknown" : `${rows.oldestDays} days`;
  const unconfirmed = rows.unconfirmedCount ?? 0;
  const failed = unconfirmed
    ? ` ${unconfirmed} of those failed its latest check and is still counted at its stored balance.`
    : "";
  return `${run}. ${rows.staleCount} of ${rows.total} shown NOT confirmed from Jobber recently (oldest ${oldest}).` +
    `${failed} A completed sync is not evidence that any one figure here is current.`;
}
