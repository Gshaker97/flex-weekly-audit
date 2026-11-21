/**
 * Scope of the Day 15 customer EMAIL programme.
 *
 * SEPARATE FROM THE DASHBOARD. `COLLECTIONS_SINCE` in lib/lateInvoices.ts is
 * 2026-01-01 and bounds what the Collections figures count. This constant
 * bounds who may be emailed, and it is deliberately a different, later date.
 * Neither may be derived from the other: changing one must never move the
 * other, which is why they are declared in different files with this note.
 *
 * Approved scope: invoices ISSUED on 2026-03-01 or later, going forward.
 * An invoice issued before that date is out of programme for good — it is not
 * "not yet due", it is never a candidate.
 */
import { invoiceCalendarDate } from "./invoice-reminder-clock";

/** Phoenix calendar date, inclusive. Compared as a date string, not a timestamp. */
export const DAY15_EMAIL_ISSUED_ON_OR_AFTER = "2026-03-01" as const;

/** UTC instant for the same boundary, for cached-row (`issuedAt`) queries only. */
export const DAY15_EMAIL_ISSUED_SINCE = new Date("2026-03-01T00:00:00.000Z");

export type EmailWindowVerdict = "in_programme" | "before_programme" | "unusable_issue_date";

/**
 * Decided from the SOURCE issue date, not the cache. An unreadable or malformed
 * date is never treated as in-programme: it returns `unusable_issue_date`, which
 * the caller must hold on.
 */
export function day15EmailIssueWindow(issuedDate: string | Date | null | undefined): EmailWindowVerdict {
  const issuedOn = invoiceCalendarDate(issuedDate ?? null);
  if (!issuedOn) return "unusable_issue_date";
  return issuedOn >= DAY15_EMAIL_ISSUED_ON_OR_AFTER ? "in_programme" : "before_programme";
}

/**
 * Both the invoice TOTAL and the remaining BALANCE must be positive.
 *
 * The balance alone is not enough: a $0 invoice that somehow carries a balance,
 * or an invoice whose total could not be read, must not be emailed. Cents are
 * required to be safe integers so a rounding artefact cannot pass as money.
 */
export function day15EmailAmountsArePositive(
  totalCents: number | null | undefined,
  balanceCents: number | null | undefined,
): { ok: boolean; reason: string | null } {
  if (typeof totalCents !== "number" || !Number.isSafeInteger(totalCents)) {
    return { ok: false, reason: "source_total_unreadable" };
  }
  if (totalCents <= 0) return { ok: false, reason: "source_total_not_positive" };
  if (typeof balanceCents !== "number" || !Number.isSafeInteger(balanceCents)) {
    return { ok: false, reason: "source_balance_unreadable" };
  }
  if (balanceCents <= 0) return { ok: false, reason: "source_balance_not_positive" };
  return { ok: true, reason: null };
}

/**
 * Invoices the user has told us to leave alone, by invoice number.
 *
 * These are NOT a rule and not derived from anything: they are named human
 * carve-outs, kept here so the programme cannot reach them by accident.
 *   7171 - "Leave #7171, Day 10 and Day 21 alone."
 *   7246 - "#7246 and Thanksgiving are not approved. Leave #7246 ... untouched."
 * Both happen to be the earliest in-programme invoices to reach day 15, which
 * is exactly why this list exists rather than a note in a report.
 */
export const DAY15_EMAIL_WITHHELD_INVOICE_NUMBERS: readonly string[] = ["7171", "7246"];

/** Compared as trimmed text, so "7171" and " 7171 " are the same invoice. */
export function day15EmailIsWithheld(invoiceNumber: string | null | undefined): boolean {
  if (typeof invoiceNumber !== "string") return false;
  return DAY15_EMAIL_WITHHELD_INVOICE_NUMBERS.includes(invoiceNumber.trim());
}
