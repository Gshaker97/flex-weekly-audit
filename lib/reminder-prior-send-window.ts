/**
 * When can a past GoHighLevel message NOT be about this invoice?
 *
 * The prior-send check treats any message that names no invoice number as
 * possibly-this-invoice's reminder, which holds the row. That rule has no time
 * limit, so a text sent months before the invoice existed holds it forever.
 *
 * A message sent strictly before the invoice was issued cannot be a reminder
 * for that invoice. That is the ONLY case this module lets through, and it
 * lets it through only when BOTH timestamps are reliably known.
 *
 * PRECISION. Jobber reports `issuedDate` as a calendar date, not an instant,
 * so the exact moment of issuance inside that Phoenix day is not knowable. The
 * boundary is therefore the START of the issue day in Phoenix: a message must
 * predate the whole issue day to be dismissed. A message sent at any hour of
 * the issue day, or later, is kept and still holds. That is deliberately
 * conservative — it errs towards holding, never towards sending.
 */
import { INVOICE_TIME_ZONE, invoiceCalendarDate } from "./invoice-reminder-clock";

export { INVOICE_TIME_ZONE as PRIOR_SEND_TIME_ZONE };

export type PriorSendRelevance =
  /** Reliably sent before the invoice existed. It cannot be this invoice's reminder. */
  | "predates_invoice"
  /** Sent on the issue day or later. It is kept, and it still holds. */
  | "at_or_after_issue"
  /** One of the two timestamps is missing or unusable. It is kept, and it still holds. */
  | "unknown";

/** Phoenix has no daylight saving, so the day starts at a fixed 07:00 UTC. */
const PHOENIX_DAY_START_UTC_HOURS = 7;

/**
 * The instant the invoice's issue day begins in Phoenix, in epoch ms.
 * null when the issue date is missing or unusable — which holds everything.
 */
export function invoiceIssueDayStartMs(issuedDate: string | Date | null | undefined): number | null {
  const calendarDay = invoiceCalendarDate(issuedDate ?? null);
  if (!calendarDay || !/^\d{4}-\d{2}-\d{2}$/.test(calendarDay)) return null;
  const ms = Date.parse(`${calendarDay}T0${PHOENIX_DAY_START_UTC_HOURS}:00:00.000Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Where one past message sits relative to the invoice's issue day.
 * Only "predates_invoice" may ever be dismissed by a caller.
 */
export function priorSendRelevance(
  sentAt: Date | null | undefined,
  issuedDate: string | Date | null | undefined,
): PriorSendRelevance {
  const boundary = invoiceIssueDayStartMs(issuedDate);
  if (boundary === null) return "unknown";
  if (!(sentAt instanceof Date)) return "unknown";
  const sent = sentAt.getTime();
  if (!Number.isFinite(sent)) return "unknown";
  // Strictly before. Equality is "at issue", which is kept.
  return sent < boundary ? "predates_invoice" : "at_or_after_issue";
}
