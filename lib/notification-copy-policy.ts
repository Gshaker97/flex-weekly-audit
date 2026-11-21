/** Exact known non-monetary copy shape, not template approval or send authorization. */
import { createHash } from "node:crypto";
import type { Event } from "./notification-gate";

export const ORIGINAL_DAY10_SMS_BODY = "This is a friendly reminder your invoice is 10 days past due. We kindly ask this invoice be paid as soon as possible to avoid any late fees. Please reach out to our office at 602-329-7865 if you have any questions or concerns.";
const originalDay10Digest = createHash("sha256").update(ORIGINAL_DAY10_SMS_BODY, "utf8").digest("hex");

/** This narrow exception says only that this exact body does not render money. The existing
 * gate still requires an approved exact template, positive unchanged source balance and all
 * other proofs. No caller boolean can conceal an amount, and no currency value is invented. */
export function permitsUnknownCurrency(event: Pick<Event, "dayPastDue" | "audience" | "channel" | "bodyDigest" | "claimedFacts">): boolean {
  return event.dayPastDue === 10 && event.audience === "homeowner" && event.channel === "sms" &&
    event.bodyDigest === originalDay10Digest && Array.isArray(event.claimedFacts) && event.claimedFacts.length === 0;
}
