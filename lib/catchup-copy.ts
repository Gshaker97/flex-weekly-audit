/**
 * THE WORDS OF THE ONE-TIME CATCH-UP, and nothing else.
 *
 * Pure. No transport, no persistence, no credentials.
 *
 * WHY THIS IS NOT THE LADDER'S COPY. Every ladder body is a frozen constant
 * (`DAY20_SMS_BODY` and friends) and `shapeIsUsable` rejects any body
 * containing a brace, because "nothing is rendered in, so nothing can be
 * rendered wrong". That is the right rule for a fixed template.
 *
 * The catch-up cannot work that way. The owner approved wording that names the
 * invoice number, the amount, the day count and a payment link - four values
 * per invoice, all read from Jobber. So this module takes the opposite
 * approach: it renders, and then REFUSES TO RETURN A STRING AT ALL unless every
 * value rendered cleanly. A missing amount does not become "$undefined" and a
 * missing link does not become "undefined"; it becomes `null`, and the caller
 * holds. That inversion is the whole point of the file.
 *
 * WHAT IT MAY CLAIM. The invoice number, the amount, the day count, and a link.
 * Nothing else. It never says a late fee was applied, never says services are
 * suspended, never says anything went to collections - and the exported
 * validator proves that about its own output rather than trusting the author.
 * The existing ladder guards are imported and reused rather than restated, so
 * the two can never drift apart.
 *
 * THE LINK IS TREATED AS HOSTILE INPUT. It arrives from an API response and
 * goes out to a customer, so it is checked against a pinned host allow-list
 * before it is allowed into a body. A link on any other host - or one carrying
 * a newline, a space or credentials - yields `null` and the message holds.
 */
import {
  bodyAssertsASuspension, bodyAssertsCollectionsAlreadyHappened, LADDER_OFFICE_PHONE,
} from "./notification-ladder-copy";

/** The one host a customer-facing payment link may point at. */
export const CATCHUP_PAY_LINK_HOST = "clienthub.getjobber.com" as const;

/**
 * Appended to the TEXT only, through the contract's native SMS suffix policy.
 * It is not part of the body either channel records, which is why it lives
 * apart from `catchupBody` rather than inside it.
 */
export const CATCHUP_SMS_SUFFIX = " Reply STOP to opt out." as const;

/** Longest body we will hand a provider. Well under the ledger's own ceiling. */
const MAX_BODY_BYTES = 4000;

/** One past-due invoice, as the catch-up needs to describe it. */
export type CatchupInvoice = Readonly<{
  invoiceNumber: string;
  /** Balance in MINOR units. Integer cents, so no float can round in the body. */
  balanceMinor: number;
  dayPastDue: number;
  /** The customer-facing Client Hub link for THIS invoice, or null if unknown. */
  payLink: string | null;
}>;

export type CatchupCopy = Readonly<{
  body: string;
  subject: string;
  /** The invoices this body actually names, in the order it names them. */
  covers: readonly string[];
}>;

const isPlainString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && !value.includes("\0");

/**
 * Is this a link we are willing to put in front of a customer?
 *
 * Deliberately strict. Only https, only the pinned host (exactly - not a
 * suffix match, so `clienthub.getjobber.com.evil.test` fails), no credentials,
 * no whitespace, no control characters. A link that fails any of these is not
 * sanitized into something acceptable; it is rejected.
 */
export function catchupPayLinkIsUsable(link: unknown): link is string {
  if (!isPlainString(link) || link.length > 512) return false;
  if (/[\s<>"'\\]/.test(link)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(link)) return false;
  let url: URL;
  try { url = new URL(link); } catch { return false; }
  if (url.protocol !== "https:") return false;
  if (url.hostname !== CATCHUP_PAY_LINK_HOST) return false;
  if (url.username || url.password) return false;
  return true;
}

/** `160` -> `$160.00`. Integer cents only; anything else yields null. */
function money(balanceMinor: unknown): string | null {
  if (typeof balanceMinor !== "number" || !Number.isSafeInteger(balanceMinor)) return null;
  if (balanceMinor <= 0 || balanceMinor > 100_000_000) return null;
  const whole = Math.floor(balanceMinor / 100);
  const cents = balanceMinor % 100;
  return `$${whole.toLocaleString("en-US")}.${String(cents).padStart(2, "0")}`;
}

/** `#7226`, or null when the number is not one we can print. */
function invoiceLabel(invoiceNumber: unknown): string | null {
  if (!isPlainString(invoiceNumber)) return null;
  const trimmed = invoiceNumber.trim();
  if (!/^\d{3,12}$/.test(trimmed)) return null;
  return `#${trimmed}`;
}

/** `1 day`, `4 days`. Null for a day count the catch-up has no business stating. */
function days(dayPastDue: unknown): string | null {
  if (typeof dayPastDue !== "number" || !Number.isSafeInteger(dayPastDue)) return null;
  if (dayPastDue < 1 || dayPastDue > 3660) return null;
  return `${dayPastDue} ${dayPastDue === 1 ? "day" : "days"}`;
}

/** A first name we are willing to greet with, or null to greet without one. */
function firstName(name: unknown): string | null {
  if (!isPlainString(name)) return null;
  // Jobber stores some names with a double space ("Nate  Martin").
  const first = name.replace(/\s+/g, " ").trim().split(" ")[0] ?? "";
  if (!/^[\p{L}][\p{L}'’.-]{0,40}$/u.test(first)) return null;
  return first;
}

/**
 * Every rendered value for one invoice, or null if ANY of them failed.
 *
 * All-or-nothing on purpose: a half-rendered invoice must not reach a body.
 */
function renderInvoice(invoice: CatchupInvoice): Readonly<{
  label: string; amount: string; age: string; link: string; number: string;
}> | null {
  const label = invoiceLabel(invoice?.invoiceNumber);
  const amount = money(invoice?.balanceMinor);
  const age = days(invoice?.dayPastDue);
  const link = invoice?.payLink;
  if (!label || !amount || !age) return null;
  if (!catchupPayLinkIsUsable(link)) return null;
  return Object.freeze({ label, amount, age, link, number: label.slice(1) });
}

/**
 * Does this body claim only what the catch-up is allowed to claim?
 *
 * Proven about the OUTPUT, not asserted about the template. If someone edits
 * the sentences below into something that warns about a fee, this returns false
 * and the message holds.
 */
export function catchupCopyIsValid(body: unknown): boolean {
  if (!isPlainString(body) || !body.trim()) return false;
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) return false;
  // No unrendered placeholder may survive into a body.
  if (/[{}]|\bundefined\b|\bNaN\b|\bnull\b|\$\s|\$\./.test(body)) return false;
  // NO FEE LANGUAGE AT ALL, which is stricter than the ladder's own rule.
  //
  // Note this deliberately does NOT call `day15SmsCopyWarnsWithoutClaiming`.
  // That predicate REQUIRES the body to mention a fee - it exists to check that
  // a fee warning is phrased conditionally - so a body that never mentions one
  // fails it. As its own comment says, copy with no fee language "belongs under
  // the no-fee-claim policy", which is this: the words are rejected if a fee,
  // a percentage, or an "applied" claim appears anywhere.
  if (/\blate\s+(?:fee|charge)s?\b|\bfinance\s+charge\b|\b3\s*%/i.test(body)) return false;
  if (/\bhas\s+been\s+applied\b/i.test(body)) return false;
  if (bodyAssertsASuspension(body)) return false;
  if (bodyAssertsCollectionsAlreadyHappened(body)) return false;
  if (/\bcollections\b/i.test(body)) return false;
  return true;
}

/** The subject line. Names no claim, carries no newline. */
export function catchupSubject(invoices: readonly CatchupInvoice[]): string | null {
  if (!Array.isArray(invoices) || invoices.length === 0) return null;
  if (invoices.length === 1) {
    const only = renderInvoice(invoices[0]);
    if (!only) return null;
    return `Invoice ${only.label} is ${only.age} past due`;
  }
  return `${invoices.length} Flexx Landscaping invoices are past due`;
}

/**
 * The approved wording, rendered - or null, which means hold.
 *
 * ONE BODY SERVES BOTH CHANNELS. The email carries this exact string and the
 * text carries it plus the SMS-only suffix, so the words a customer reads
 * cannot differ between the two.
 */
export function catchupBody(input: Readonly<{
  clientName: string | null;
  invoices: readonly CatchupInvoice[];
}>): CatchupCopy | null {
  const invoices = input?.invoices;
  if (!Array.isArray(invoices) || invoices.length === 0 || invoices.length > 10) return null;

  const rendered = invoices.map(renderInvoice);
  // One unrenderable invoice holds the whole message rather than quietly
  // dropping that invoice from a list the customer would then think complete.
  if (rendered.some(value => value === null)) return null;
  const parts = rendered as readonly NonNullable<ReturnType<typeof renderInvoice>>[];

  const numbers = parts.map(part => part.number);
  if (new Set(numbers).size !== numbers.length) return null;

  const first = firstName(input?.clientName);
  const greeting = first ? `Hi ${first}, this is Flexx Landscaping.` : "Hello, this is Flexx Landscaping.";

  let middle: string;
  if (parts.length === 1) {
    const only = parts[0];
    middle = `Our records show invoice ${only.label} for ${only.amount} is ${only.age} past due. `
      + `You can view and pay it here: ${only.link}. `
      + `If you have already paid, please let us know. Otherwise please reach out to our office at `
      + `${LADDER_OFFICE_PHONE} to take care of it or if you have any questions.`;
  } else {
    const listed = parts
      .map(part => `${part.label} for ${part.amount} (${part.age})`)
      .join(parts.length === 2 ? " and " : ", ");
    const links = parts
      .map(part => `${part.label} here: ${part.link}`)
      .join(parts.length === 2 ? " and " : ", ");
    middle = `Our records show ${parts.length} invoices past due: ${listed}. `
      + `You can view and pay ${links}. `
      + `If you have already paid, please let us know. Otherwise please reach out to our office at `
      + `${LADDER_OFFICE_PHONE} to take care of them or if you have any questions.`;
  }

  const body = `${greeting} ${middle} Thank you.`;
  const subject = catchupSubject(invoices);
  if (!subject || /[\r\n]/.test(subject)) return null;
  // The output is checked, not the recipe.
  if (!catchupCopyIsValid(body)) return null;

  return Object.freeze({ body, subject, covers: Object.freeze([...numbers]) });
}

/** The exact string the TEXT carries: the shared body plus the opt-out line. */
export function catchupSmsReceiptBody(body: string): string | null {
  if (!isPlainString(body) || !body.trim()) return null;
  const receipt = body + CATCHUP_SMS_SUFFIX;
  if (Buffer.byteLength(receipt, "utf8") > MAX_BODY_BYTES) return null;
  return receipt;
}
