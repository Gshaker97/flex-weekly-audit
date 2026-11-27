/**
 * ONE definition of whether an invoice is settled or still owing.
 *
 * Jobber's `invoiceStatus` does not answer "does anyone still owe money on
 * this?". It leaves the label on `paid` when
 *
 *   - the card payment was later refunded in full. The PaymentRecord keeps
 *     `adjustmentType: PAYMENT` and its original amount; only
 *     `jobberPaymentTransactionStatus: REFUNDED` and a `refunds` entry say
 *     otherwise. `amounts.paymentsTotal` correctly drops back to 0 and
 *     `invoiceBalance` back to the full total, but the status and
 *     `receivedDate` are never walked back.
 *   - only a deposit or a half was ever paid.
 *
 * Measured read-only on the live account 2026-11-27: 12 invoices read `paid`
 * while $25,983.82 was still outstanding across them - 5 refunded in full, 7
 * part-paid, 2 of those with no payment record at all.
 *
 * So the BALANCE decides whether money is owed, and the STATUS only excludes:
 * a void, draft or bad-debt invoice is nobody's receivable however its balance
 * reads. That split is the whole point of this module - every gate that used to
 * ask "is the label paid?" asks this instead, so there is exactly one answer in
 * the codebase and it cannot drift between the dashboard, the cards and the
 * reminder ladder.
 *
 * This module is pure. It reads no clock, no database and no environment.
 */

/** Every invoice status Jobber is known to return. */
export const KNOWN_INVOICE_STATUSES = Object.freeze(
  ["awaiting_payment", "past_due", "paid", "void", "draft", "bad_debt"] as const);

/**
 * Statuses that are never a receivable, whatever the balance says. A void or
 * bad-debt invoice has been taken off the books and a draft was never issued,
 * so none of them may enter collections, a card stage or a reminder - and a
 * balance-only test would have let all three through.
 */
export const NEVER_COLLECT_STATUSES = Object.freeze(["void", "draft", "bad_debt"] as const);

/** The two labels this codebase uses for an invoice that still owes money. */
export const OWING_STATUSES = Object.freeze(["awaiting_payment", "past_due"] as const);

export type Settlement = "settled" | "owing" | "excluded" | "unreadable";

function normalise(status: string | null | undefined): string | null {
  if (typeof status !== "string") return null;
  const s = status.trim().toLowerCase();
  return s.length > 0 ? s : null;
}

function usableCents(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && Number.isSafeInteger(value) ? value : null;
}

/**
 * What one invoice really is, from its status and its amounts in minor units.
 *
 * `unreadable` is deliberately distinct from `excluded`: the first means this
 * code cannot tell, so the caller must hold and nobody should be messaged; the
 * second is a confident "not a receivable". Collapsing them would turn a
 * missing amount into a silent decision.
 */
export function invoiceSettlement(
  status: string | null | undefined,
  totalCents: number | null | undefined,
  balanceCents: number | null | undefined
): Settlement {
  const s = normalise(status);
  if (s === null || !KNOWN_INVOICE_STATUSES.some(k => k === s)) return "unreadable";
  // Checked BEFORE the amounts: a void invoice with unreadable amounts is still
  // confidently not a receivable, and calling that "unreadable" would invite a
  // caller to go looking for amounts that do not matter.
  if (NEVER_COLLECT_STATUSES.some(k => k === s)) return "excluded";
  const total = usableCents(totalCents), balance = usableCents(balanceCents);
  if (total === null || balance === null) return "unreadable";
  // A balance above the total, or a negative total, is not a bigger debt - it
  // is a figure this code does not understand, and guessing at it is how a
  // wrong number ends up in a customer's hand.
  if (total < 0 || balance > total) return "unreadable";
  // A credit balance is not a debt. Nothing is owed at or below zero.
  return balance > 0 ? "owing" : "settled";
}

/** True only when money is genuinely outstanding on a collectable invoice. */
export function isOwing(
  status: string | null | undefined, totalCents: number | null | undefined, balanceCents: number | null | undefined
): boolean {
  return invoiceSettlement(status, totalCents, balanceCents) === "owing";
}

/**
 * True only when nothing is outstanding on a collectable invoice. A void or
 * draft invoice is NOT settled - it is excluded - so this never retires a card
 * on the strength of a status that was never a receivable in the first place.
 */
export function isSettled(
  status: string | null | undefined, totalCents: number | null | undefined, balanceCents: number | null | undefined
): boolean {
  return invoiceSettlement(status, totalCents, balanceCents) === "settled";
}

/**
 * The label this system should store for an invoice, given what is actually
 * owed on it.
 *
 * DELIBERATELY NARROW. It corrects the settled-versus-owing axis and nothing
 * else:
 *
 *   - paid while money is still outstanding  -> an owing label
 *   - an owing label with nothing outstanding -> paid
 *   - already agreeing, void, draft, bad debt or unreadable -> left alone
 *
 * It does NOT re-referee `past_due` against `awaiting_payment` when Jobber
 * already says one of them. That distinction is the due date's business, every
 * consumer that cares already computes it from the stored due date, and
 * rewriting thousands of correct rows to make the same point is a far larger
 * change than the bug being fixed here. `overdue` is therefore consulted only
 * when a label has to be invented from scratch, which happens on exactly the
 * paid-while-owing case.
 */
export function settledOrOwingStatus(
  status: string | null | undefined,
  totalCents: number | null | undefined,
  balanceCents: number | null | undefined,
  overdue: boolean
): string | null {
  const s = normalise(status);
  switch (invoiceSettlement(status, totalCents, balanceCents)) {
    case "owing":
      // Jobber already calls it owing, and which of the two it is belongs to
      // the due date, not to this correction. Leave it exactly as found.
      if (s !== null && OWING_STATUSES.some(k => k === s)) return s;
      return overdue ? "past_due" : "awaiting_payment";
    case "settled":
      return "paid";
    // Nothing to correct, and nothing worth inventing: keep what the source
    // said so the stored row still reports the source faithfully.
    default:
      return s;
  }
}
