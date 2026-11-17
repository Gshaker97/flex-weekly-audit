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
// `InvoiceRecord.lastSyncedAt` is advanced only when the FULL invoice sync
// actually included this invoice. The hourly open-invoice status refresh
// deliberately does not advance it ("the row was not fully refreshed"), because
// that read covers only status, amounts and owner.
//
// So this timestamp answers exactly one question: how long since the invoice was
// fully refreshed. It does NOT mean the balance is unverified -- the hourly status
// refresh may have confirmed it minutes ago. That hourly outcome is written only
// to a log line, so nothing here can distinguish:
//
//   confirmed against Jobber this hour, unchanged   -> no record written
//   not confirmable at all (Jobber returns null)    -> no record written
//
// Both look identical in the database. Telling them apart needs the refresh
// outcome persisted, which is a schema change. Until then these helpers claim
// only what the timestamp supports, and the page says plainly what it cannot
// establish -- a completed run is not evidence that any one figure is current.
// ---------------------------------------------------------------------------

/** Beyond this, a row is reported as not fully refreshed rather than simply shown. */
export const INVOICE_VERIFICATION_STALE_DAYS = 2;

const DAY_MS = 86_400_000;

/** Whole days since the full sync last included this invoice. Null if unreadable. */
export function invoiceVerificationAgeDays(
  invoice: { lastSyncedAt: Date | null },
  asOf: Date,
): number | null {
  const at = invoice.lastSyncedAt?.getTime();
  const ref = asOf?.getTime();
  if (!Number.isFinite(at) || !Number.isFinite(ref)) return null;
  return Math.max(0, Math.floor((ref! - at!) / DAY_MS));
}

/** True when this row has not been fully refreshed recently. */
export function invoiceVerificationIsStale(
  invoice: { lastSyncedAt: Date | null },
  asOf: Date,
  staleDays: number = INVOICE_VERIFICATION_STALE_DAYS,
): boolean {
  const age = invoiceVerificationAgeDays(invoice, asOf);
  return age === null || age >= staleDays;
}

/**
 * One short phrase for display, or null when recently refreshed. Deliberately
 * says "not fully refreshed", NOT "unverified": the hourly status refresh may
 * have confirmed this balance, and that is simply not recorded anywhere.
 */
export function invoiceVerificationBasis(
  invoice: { lastSyncedAt: Date | null },
  asOf: Date,
  staleDays: number = INVOICE_VERIFICATION_STALE_DAYS,
): string | null {
  const age = invoiceVerificationAgeDays(invoice, asOf);
  if (age === null) return "No refresh timestamp recorded";
  if (age < staleDays) return null;
  return `Not fully refreshed for ${age} day${age === 1 ? "" : "s"}`;
}

/**
 * Worst-case refresh age across the rows actually displayed, so a current sync
 * run cannot imply every figure on the page is current.
 */
export function oldestInvoiceVerification(
  invoices: ReadonlyArray<{ lastSyncedAt: Date | null }>,
  asOf: Date,
): Readonly<{ oldestDays: number | null; staleCount: number; total: number }> {
  let oldestDays: number | null = null;
  let staleCount = 0;
  for (const invoice of invoices) {
    const age = invoiceVerificationAgeDays(invoice, asOf);
    if (age === null || age >= INVOICE_VERIFICATION_STALE_DAYS) staleCount++;
    if (age !== null && (oldestDays === null || age > oldestDays)) oldestDays = age;
  }
  return Object.freeze({ oldestDays, staleCount, total: invoices.length });
}

/**
 * One sentence for a page header. Deliberately refuses to call the page current
 * on the strength of a completed run alone.
 */
export function describeDashboardFreshness(
  lastSuccessfulSyncAt: Date | null,
  rows: Readonly<{ oldestDays: number | null; staleCount: number; total: number }>,
): string {
  const run = lastSuccessfulSyncAt
    ? `Last successful sync ${lastSuccessfulSyncAt.toISOString().slice(0, 16).replace("T", " ")}Z`
    : "No successful sync recorded";
  if (!rows.total) return `${run}. No invoices shown.`;
  if (!rows.staleCount) return `${run}. All ${rows.total} shown fully refreshed within ${INVOICE_VERIFICATION_STALE_DAYS} days.`;
  const oldest = rows.oldestDays === null ? "unknown" : `${rows.oldestDays} days`;
  return `${run}. ${rows.staleCount} of ${rows.total} shown NOT fully refreshed recently (oldest ${oldest}). ` +
    `Per-invoice source confirmation is not recorded, so a completed sync is not evidence that any one figure here is current.`;
}
