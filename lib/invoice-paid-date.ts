/**
 * WHEN AN INVOICE WAS ACTUALLY PAID.
 *
 * This file exists because `InvoiceRecord.paidAt` used to be a copy of the
 * issue date. `lib/sync.ts` wrote it as:
 *
 *     paidAt: isPaid && inv.issuedDate ? new Date(inv.issuedDate) : null
 *
 * so on a paid row it said when the invoice went OUT, not when the money came
 * in. Measured on the production database 2026-11-25: 5,880 of 5,880 paid rows
 * had `paidAt` exactly equal to `issuedAt`. The audit scripts already knew —
 * `scripts/source-audit/core.ts` counts `cachedPaidDateEqualsIssueDate` and
 * flags `cachedPaidDateIsUnverified` — but the value was still wrong, and it
 * misled a report to the owner about when a customer had paid.
 *
 * WHICH JOBBER FIELD. Jobber has no `paymentDate` on an invoice; the schema was
 * introspected rather than guessed. Two fields could serve:
 *
 *   - `Invoice.receivedDate` — one scalar.
 *   - `Invoice.paymentRecords.nodes[].entryDate` — a nested connection.
 *
 * Measured over 250 real invoices (200 of them paid) on 2026-11-25:
 *   - `receivedDate` equalled the LAST payment's `entryDate` on 200 of 200;
 *   - it was never only the FIRST payment's date, and never neither. The one
 *     invoice paid in two instalments (Oct 7 then Nov 3) carried the Nov 3
 *     date, so `receivedDate` tracks FULL settlement, not first money in;
 *   - no paid invoice was missing it;
 *   - it differed from the issue date on 120 of 200, which is how wrong the
 *     old value was — right about 40% of the time, by coincidence.
 *
 * So `receivedDate` is used, and `paymentRecords` is deliberately NOT added to
 * the sync query. A nested connection on every node, over a feed that paginates
 * to thousands of invoices, multiplies Jobber's query cost for a value that
 * matched the cheap scalar 200 times out of 200 — and this sync already has to
 * back off on THROTTLED.
 *
 * Also learned, and worth not re-learning the hard way: `PaymentRecord.amount`
 * is the whole payment, NOT the part allocated to the invoice you read it from.
 * One $487 payment settling a $137 invoice and a $350 invoice reports `487` on
 * both. Never sum it to work out what was paid on an invoice.
 */

/** Just the bits of a Jobber invoice node this decision needs. */
export type PaidDateSource = Readonly<{
  /** Jobber's `Invoice.receivedDate`. */
  receivedDate?: string | null;
  amounts?: Readonly<{ total?: number | null; invoiceBalance?: number | null }> | null;
}>;

/**
 * True when the invoice is settled: nothing left owing on a real total.
 *
 * Keyed on the total as well as the balance, so a $0 or unreadable-total
 * invoice is never called paid — the same rule the sync has always used, kept
 * here so the paid date and the paid test cannot drift apart.
 */
export function invoiceIsSettled(inv: PaidDateSource): boolean {
  const total = inv.amounts?.total ?? 0;
  const balance = inv.amounts?.invoiceBalance ?? 0;
  return balance === 0 && total > 0;
}

/**
 * The instant to store in `paidAt`, or null.
 *
 * Null in three cases, and null is the right answer in all three:
 *   - the invoice is not settled, so there is no payment date to hold;
 *   - the source carries no `receivedDate`, so the date is unknown. It is NOT
 *     filled in from the issue date, the due date or today. That guess is the
 *     bug this file exists to fix, and `lib/open-invoice-status-refresh.ts`
 *     already refuses to invent one for exactly the same reason;
 *   - the date is unparseable, which is unknown rather than zero.
 */
export function invoicePaidAt(inv: PaidDateSource): Date | null {
  if (!invoiceIsSettled(inv)) return null;
  const raw = inv.receivedDate;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const when = new Date(raw);
  return Number.isNaN(when.getTime()) ? null : when;
}
