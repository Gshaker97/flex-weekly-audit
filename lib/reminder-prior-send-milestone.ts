/**
 * Which invoice was an old late-payment message about?
 *
 * THE PROBLEM. Flexx's legacy reminder texts name no invoice number and no
 * amount. They say only how far past due the invoice was:
 *
 *     "your invoice is 10 days past due"
 *     "a reminder that your invoice is 20 days past due"
 *     "your final reminder that your invoice is 30 days past due"
 *
 * The prior-send check matches on invoice NUMBER alone, so every one of these
 * reads as "could be about this invoice" and holds the row. A customer with a
 * years-old reminder for a long-settled invoice is held forever.
 *
 * THE SIGNAL. A message that states a day count states, implicitly, the DUE
 * DATE it is about: the invoice it names fell due N days before the message
 * went out. Comparing that implied due date with the invoice actually under
 * evaluation decides the question from the message's own words:
 *
 *   implied due date == this invoice's due date  ->  it IS this invoice's
 *                                                   reminder, at day N
 *   implied due date != this invoice's due date  ->  it is some OTHER
 *                                                   invoice's reminder
 *
 * WHICH DIRECTION IS DANGEROUS. Wrongly calling a message "this invoice's"
 * suppresses a reminder that is in fact still owed - a message the customer
 * never got. Wrongly calling it "another invoice's" releases a hold and can
 * send a duplicate. Only the second is a message the customer sees twice, so
 * dismissal must rest on the message's own words, never on an inference.
 *
 * That is why the fee template is treated separately. "A late fee of 3% has
 * been applied" states no day count at all; it sits at day 15 only because
 * Flexx's ladder puts the fee there. That is an assumption about the sender,
 * not something the text says. So a fee-template message may:
 *
 *   - CONFIRM: become this invoice's day 15 send when the day-15 arithmetic
 *     lands on this invoice's due date. Adding a known send only ever holds
 *     more, never less.
 *   - DISMISS: only when a message that DOES state its day count points at the
 *     very same other due date, so a second, explicit message corroborates it.
 *   - otherwise stay ambiguous, and keep holding.
 *
 * Everything here is pure. Nothing is read, sent or written.
 */
import { addInvoiceCalendarDays, invoiceCalendarDate } from "./invoice-reminder-clock";

/** How a message's day count was established. */
export type MilestoneBasis =
  /** The body states the number of days past due. The message's own words. */
  | "stated"
  /** The body is the 3% fee template, which states no day count. An inference. */
  | "fee_template";

export type MilestoneReading = Readonly<{
  dayPastDue: number;
  basis: MilestoneBasis;
}>;

/**
 * The ladder rung Flexx's 3% fee text occupies. Taken from the written policy
 * the ladder encodes (day 15 carries `three_percent_fee_applied`), NOT from
 * anything the fee message says about itself.
 */
export const FEE_TEMPLATE_DAY = 15;

/**
 * Only day counts a real reminder ladder could carry. A body quoting some
 * other figure ("45 days") is not one of Flexx's rungs, so it is not read as a
 * milestone at all and the message keeps holding.
 */
const LADDER_DAYS: readonly number[] = [10, 15, 20, 21, 25, 30, 35];

/**
 * "... is 10 days past due", "... 30 days past due". The number must be
 * followed by "day"/"days" and then "past due" within a short span, so a
 * stray figure elsewhere in the body is not mistaken for a day count.
 */
const STATED_DAYS = /(\d{1,3})\s*days?\s+past\s+due/i;

/** The 3% fee sentence, in the wording Flexx's template uses. */
const FEE_TEMPLATE = /late\s+fee\s+of\s+3\s*%\s+has\s+been\s+applied/i;

/**
 * The milestone a message body carries, or null when it carries none.
 *
 * A body that states a day count wins over the fee template: if a message
 * somehow says both, the stated number is what the customer read.
 */
export function readMilestone(body: string | null | undefined): MilestoneReading | null {
  if (typeof body !== "string" || body.trim().length === 0) return null;
  const stated = STATED_DAYS.exec(body);
  if (stated) {
    const dayPastDue = Number(stated[1]);
    if (!Number.isSafeInteger(dayPastDue) || !LADDER_DAYS.includes(dayPastDue)) return null;
    return { dayPastDue, basis: "stated" };
  }
  if (FEE_TEMPLATE.test(body)) return { dayPastDue: FEE_TEMPLATE_DAY, basis: "fee_template" };
  return null;
}

/**
 * The due date a message implies: the Phoenix calendar date N days before the
 * message went out. null when the send time is unusable, which decides nothing
 * and therefore holds.
 */
export function impliedDueDate(
  sentAt: Date | null | undefined,
  dayPastDue: number,
): string | null {
  if (!(sentAt instanceof Date) || !Number.isFinite(sentAt.getTime())) return null;
  if (!Number.isSafeInteger(dayPastDue)) return null;
  const sentOn = invoiceCalendarDate(sentAt);
  if (!sentOn) return null;
  return addInvoiceCalendarDays(sentOn, -dayPastDue);
}

/** What the day-count evidence says about one message and one invoice. */
export type MilestoneVerdict =
  /** This invoice's reminder, at `dayPastDue`. */
  | { outcome: "this_invoice"; dayPastDue: number; impliedDueDate: string }
  /** Another invoice's reminder. Safe to drop for this invoice. */
  | { outcome: "other_invoice"; dayPastDue: number; impliedDueDate: string }
  /** Decides nothing: no day count, unusable dates, or an uncorroborated guess. */
  | { outcome: "undecided"; reason: string };

/**
 * Match ONE message against ONE invoice using the day count in its body.
 *
 * `corroboratingDueDates` are the due dates implied by the OTHER messages in
 * the same conversation that state their day count explicitly. They are what
 * lets a fee-template message be dismissed: on its own it is an inference, but
 * an explicit message pointing at the same other due date makes it evidence.
 */
export function matchMessageToInvoice(input: Readonly<{
  body: string | null | undefined;
  sentAt: Date | null | undefined;
  invoiceDueDate: string | Date | null | undefined;
  corroboratingDueDates?: readonly string[];
}>): MilestoneVerdict {
  const reading = readMilestone(input.body);
  if (!reading) return { outcome: "undecided", reason: "body states no ladder day count" };

  const dueOn = invoiceCalendarDate(input.invoiceDueDate ?? null);
  if (!dueOn) return { outcome: "undecided", reason: "this invoice has no usable due date" };

  const implied = impliedDueDate(input.sentAt, reading.dayPastDue);
  if (!implied) return { outcome: "undecided", reason: "message has no usable send time" };

  if (implied === dueOn) {
    // Confirming a send is the safe direction, so an inferred day count is
    // allowed to do it: the worst case is holding a reminder that was in fact
    // still owed, never sending one the customer already had.
    return { outcome: "this_invoice", dayPastDue: reading.dayPastDue, impliedDueDate: implied };
  }

  // Dismissal is the dangerous direction. The message must say so itself, or
  // an explicit message in the same conversation must point the same way.
  if (reading.basis === "stated") {
    return { outcome: "other_invoice", dayPastDue: reading.dayPastDue, impliedDueDate: implied };
  }
  const corroborated = (input.corroboratingDueDates ?? []).includes(implied);
  if (corroborated) {
    return { outcome: "other_invoice", dayPastDue: reading.dayPastDue, impliedDueDate: implied };
  }
  return { outcome: "undecided",
    reason: `fee template implies due ${implied}, which no message states outright` };
}

/**
 * The due dates implied by every message in a conversation that states its own
 * day count. Fee-template messages are deliberately excluded: a guess cannot
 * corroborate another guess.
 */
export function statedDueDates(
  messages: readonly Readonly<{ body: string | null | undefined; sentAt: Date | null | undefined }>[],
): string[] {
  const dates = new Set<string>();
  for (const message of messages) {
    const reading = readMilestone(message.body);
    if (!reading || reading.basis !== "stated") continue;
    const implied = impliedDueDate(message.sentAt, reading.dayPastDue);
    if (implied) dates.add(implied);
  }
  return [...dates];
}
