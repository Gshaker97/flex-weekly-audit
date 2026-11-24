/**
 * EVERY HOMEOWNER RUNG GOES OUT AS ONE TEXT AND ONE EMAIL, SAYING THE SAME THING.
 *
 * The account owner's decision, 2026-11-24. Before it, days 10/15/20/25/30
 * delivered a text only, and day 21 was the sole rung with an email.
 *
 * WHY THE EMAIL BODY IS NOT WRITTEN HERE. The ladder's words are pinned per
 * rung, and each rung's words are re-checked against a validator that decides
 * what they are allowed to claim about someone's account. A second, hand-copied
 * email version of each rung would be a second place for those words to drift -
 * and a drifted email would make a claim no validator had passed.
 *
 * So the email body IS the text body, the same string, with nothing added to it
 * and nothing taken away. `ladderEmail()` takes the already-validated body and
 * returns it with a subject. "The same message" is therefore structural: there
 * is only one message, and it cannot differ from itself.
 *
 * THE SUBJECT is the one thing an email needs that a text does not. It carries
 * the invoice number, because an email sits in an inbox next to other mail and
 * has to be identifiable. It deliberately states NOTHING about fees,
 * suspensions or collections - every claim lives in the validated body, so the
 * subject cannot introduce one that nothing checked.
 *
 * Nothing here sends, renders a balance, or reads a provider.
 */

/** The channels a homeowner rung delivers on, in a fixed order. */
export const LADDER_CUSTOMER_CHANNELS = Object.freeze(["sms", "email"] as const);

export type LadderEmail = Readonly<{ subject: string; body: string }>;

/**
 * Words the subject line must never contain, because each is a claim about the
 * customer's account that only a validated body may make.
 */
const SUBJECT_MUST_NOT_CLAIM = [
  /late\s*fee/i, /3\s*%/i, /suspend/i, /collections?/i, /has\s+been\s+applied/i,
];

/**
 * The subject for a rung. Plain, factual, and the same shape at every rung so a
 * customer with more than one reminder over time sees a consistent sender.
 */
export function ladderEmailSubject(invoiceNumber: string, dayPastDue: number): string | null {
  const number = typeof invoiceNumber === "string" ? invoiceNumber.trim() : "";
  if (!number || !Number.isSafeInteger(dayPastDue) || dayPastDue < 1) return null;
  const subject = `Invoice #${number} is ${dayPastDue} days past due`;
  // A subject that somehow acquired a claim is refused rather than softened:
  // the caller then holds, exactly as it does for a body that fails validation.
  return SUBJECT_MUST_NOT_CLAIM.some(pattern => pattern.test(subject)) ? null : subject;
}

/**
 * The email for a rung, built from the SAME validated body the text uses.
 *
 * Returns null when a subject cannot be formed, which the planner treats as a
 * hold. It never substitutes a different body and never edits the one given.
 */
export function ladderEmail(input: Readonly<{
  body: string; invoiceNumber: string; dayPastDue: number;
}>): LadderEmail | null {
  if (typeof input?.body !== "string" || input.body.trim().length === 0) return null;
  const subject = ladderEmailSubject(input.invoiceNumber, input.dayPastDue);
  if (!subject) return null;
  // The body is passed through untouched. This is the whole point of the module.
  return Object.freeze({ subject, body: input.body });
}

/**
 * Does this email carry exactly the text's message?
 *
 * Used by the planner and asserted in the tests, so "one text and one email
 * saying the same thing" is checked rather than assumed.
 */
export function ladderEmailMatchesText(email: LadderEmail | null, smsBody: string): boolean {
  return !!email && typeof smsBody === "string" && email.body === smsBody;
}
