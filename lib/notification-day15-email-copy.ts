/**
 * Day 15 customer email copy, fee-free.
 *
 * WHY FEE-FREE: the Day 15 milestone in `invoice-reminder-clock` requires the fact
 * `three_percent_fee_applied`. Claiming that fee needs Jobber to prove the fee was
 * actually applied AND approved terms behind it. This copy states no fee at all, so it
 * makes no such claim, and the gate's deliberately narrow day-15 exemption
 * (`notification-gate.ts`, `feeClaimFreeDay15`) accepts it without fee proof. That
 * exemption is channel-agnostic, so it covers email exactly as it covers SMS.
 *
 * NOT YET APPROVED. These are the exact proposed words. The installer below pins the
 * policy body to this constant so no unreviewed wording can be substituted at install
 * time, but pinning is integrity, not approval. Approval is a separate human decision.
 */
import { bodyMakesNoFeeClaim } from "./notification-day15-pilot";

export const DAY15_EMAIL_TEMPLATE_POLICY = "day15-no-fee-claim-email" as const;

/** Subject line. No placeholders: nothing in it varies per invoice. */
export const PROPOSED_DAY15_EMAIL_SUBJECT = "Your Flexx Landscaping invoice is past due";

/**
 * Body. Exactly two placeholders, both filled from live reads at send time:
 *   {{balance}}      the live Jobber invoice balance, rendered with its currency
 *   {{invoiceLink}}  the live Jobber client-hub URL for this exact invoice
 * No late fee is mentioned, promised, threatened or implied.
 */
export const PROPOSED_DAY15_EMAIL_BODY = [
  "Hello,",
  "",
  "This is a friendly reminder from Flexx Landscaping that your invoice is now 15 days past due.",
  "The balance currently showing on your account is {{balance}}.",
  "",
  "You can view the invoice and pay it here: {{invoiceLink}}",
  "",
  "If you have already paid, or if anything on the invoice looks wrong, please contact our office",
  "at 602-329-7865 and we will get it sorted out.",
  "",
  "Thank you,",
  "Flexx Landscaping",
].join("\n");

const PLACEHOLDER = /\{\{(balance|invoiceLink)\}\}/g;

/**
 * Structural guarantees of the proposed copy, asserted rather than assumed. Both the
 * raw template and every rendered body must pass, so rendering cannot introduce fee
 * wording that the template did not have.
 */
export function day15EmailCopyIsFeeClaimFree(subject: string, body: string): boolean {
  if (typeof subject !== "string" || !subject.trim() || /[\r\n]/.test(subject) || subject.length > 256) return false;
  if (!bodyMakesNoFeeClaim(subject)) return false;
  if (typeof body !== "string" || !body.trim()) return false;
  // Fee-claim-free with placeholders present AND with them stripped.
  return bodyMakesNoFeeClaim(body) && bodyMakesNoFeeClaim(body.replace(PLACEHOLDER, ""));
}

/** The template must carry both placeholders exactly, and no other brace token. */
export function day15EmailTemplateShapeIsExact(body: unknown): body is string {
  if (typeof body !== "string" || !body.trim() || body.includes("\0")) return false;
  if (Buffer.byteLength(body, "utf8") > 4000) return false;
  if (!body.includes("{{balance}}") || !body.includes("{{invoiceLink}}")) return false;
  return !body.replace(PLACEHOLDER, "").match(/[{}]/);
}

/** Only this link shape is accepted. Same regex the Day 15 sender uses. */
const CLIENT_HUB = /^https:\/\/clienthub\.getjobber\.com\/client_hubs\/[0-9a-f-]{36}\/invoices\/[A-Za-z0-9._~-]{1,256}$/;

/**
 * Renders the live balance and the live invoice link. Throws rather than send a message
 * with a stale amount, a zero or negative amount, or a link that is not this invoice's.
 */
export function renderDay15EmailBody(
  template: string,
  snapshot: Readonly<{ balanceMinor: number; currency: string }>,
  invoiceLinkUrl: string,
): string {
  if (!day15EmailTemplateShapeIsExact(template)) throw new Error("day15_email_template_shape_unexact");
  if (!Number.isSafeInteger(snapshot.balanceMinor) || snapshot.balanceMinor <= 0)
    throw new Error("day15_email_requires_positive_balance");
  if (!/^[A-Z]{3}$/.test(snapshot.currency)) throw new Error("day15_email_requires_exact_currency");
  if (typeof invoiceLinkUrl !== "string" || !CLIENT_HUB.test(invoiceLinkUrl))
    throw new Error("day15_email_invalid_invoice_link");
  const major = Math.floor(snapshot.balanceMinor / 100);
  const minor = String(snapshot.balanceMinor % 100).padStart(2, "0");
  const balance = `${snapshot.currency} ${major}.${minor}`;
  const body = template.replace(PLACEHOLDER, (_, token: string) =>
    token === "balance" ? balance : invoiceLinkUrl);
  if (!bodyMakesNoFeeClaim(body)) throw new Error("day15_email_rendered_body_claims_a_fee");
  return body;
}

/**
 * The same approved words, as the HTML GoHighLevel actually accepts.
 *
 * WHY THIS EXISTS. GoHighLevel's `POST /conversations/messages` rejects an
 * Email whose only content is the `message` field: it answers 422
 * CONVERSATIONS_MSG_NO_CONTENT, "There is no message or attachments for this
 * message. Skip sending." Observed live on 2026-11-17 with the exact Day 15
 * payload. An Email must carry `html`. So the plain body stays the reviewed
 * artefact — it is what the fee-claim and shape checks read — and this is the
 * only permitted transformation of it on the way to the wire.
 *
 * It adds no words. It escapes the five HTML metacharacters and turns each
 * newline into a line break, and nothing else. Deterministic, so the pre-send
 * re-render produces a byte-identical result and drift is still detectable.
 */
export function day15EmailHtmlFromPlain(plainBody: string): string {
  if (typeof plainBody !== "string" || !plainBody.length) throw new Error("day15_email_html_requires_a_body");
  if (!bodyMakesNoFeeClaim(plainBody)) throw new Error("day15_email_html_body_claims_a_fee");
  const escaped = plainBody
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  return escaped.split("\n").join("<br>\n");
}
