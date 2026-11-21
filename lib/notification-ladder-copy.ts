/**
 * The rest of the past-due ladder: the Day 20, 25 and 30 customer texts.
 *
 * Day 10 already lives in `notification-copy-policy.ts` and Day 15 in
 * `notification-day15-pilot.ts`. This module is the remaining three steps of
 * the company's written Late Fee and Cancellation policy, pinned the same way,
 * so drift from the policy is visible in a diff.
 *
 * THE ONE RULE THAT SHAPES ALL OF THIS
 *   The policy's words assert things about the customer's account: that fees
 *   have accrued, that services have been suspended, that collections will
 *   follow. Each of those is checkable, and each was written on the assumption
 *   that the earlier steps actually happened. Measured 2026-11-18, only 2 of 27
 *   invoices past day 15 carried any late fee at all — so "will continue to
 *   incur late fees" would have been untrue for almost everyone.
 *
 *   So every assertion here is either softened to the conditional, or it keeps
 *   its claim AND requires evidence. Nothing claims a fact about an account
 *   that nothing can prove.
 *
 * WHAT THAT MEANS PER STEP
 *   Day 20, 25  the fee and the suspension are stated as POSSIBILITIES, which
 *               the written policy backs on its own. Ready to send.
 *   Day 30      the policy ASSERTS services "have been temporarily suspended".
 *               That is a fact about the account, so it needs proof. Two bodies
 *               are pinned: the asserted one, usable only with suspension
 *               evidence, and a conditional one that needs none. The gate picks
 *               by evidence, never by preference.
 *
 * Nothing here sends, renders a balance, or reads a provider. It is words and
 * the rules about words.
 */
import { day15SmsCopyWarnsWithoutClaiming } from "./notification-day15-pilot";

export const LADDER_OFFICE_PHONE = "602-329-7865" as const;

/** The facts the ladder's words can claim. Each needs its own evidence. */
export type LadderClaim =
  /** Late fees recur every 15 days under the written policy. */
  | "recurring_late_fee_policy"
  /** THIS customer's services are actually suspended right now. */
  | "service_suspended"
  /** Unpaid invoices go to collections after day 35, under the written policy. */
  | "collections_after_day_35_policy";

/**
 * Day 20. The policy reads "This invoice will continue to incur late fees every
 * 15 days and may result in the temporary suspension of services".
 *
 * "will continue to incur" says fees have already started. For 25 of the 27
 * invoices measured, none had. So it becomes "may be added", which the written
 * policy supports without needing to know anything about this invoice's fees.
 * The suspension half was already conditional and is left as the policy has it.
 */
export const DAY20_SMS_BODY =
  "This is a reminder that your invoice is 20 days past due. Additional late fees may be " +
  "added every 15 days, and services may be temporarily suspended until payment is received. " +
  `If you have any questions or concerns please reach out to our office at ${LADDER_OFFICE_PHONE}.`;

/** Day 25. The policy's Day 25 text is its Day 20 text with the number changed. */
export const DAY25_SMS_BODY =
  "This is a reminder that your invoice is 25 days past due. Additional late fees may be " +
  "added every 15 days, and services may be temporarily suspended until payment is received. " +
  `If you have any questions or concerns please reach out to our office at ${LADDER_OFFICE_PHONE}.`;

/**
 * Day 30, ASSERTED. Only sendable with evidence that this customer's services
 * really are suspended. The policy's own wording, with "maintenance" dropped
 * because the same ladder serves irrigation.
 */
export const DAY30_SMS_BODY_SUSPENDED =
  "This is your final reminder that your invoice is 30 days past due. Your services have been " +
  "temporarily suspended until payment is received. If payment is not received within 35 days " +
  "of the invoice due date, the invoice will be sent to collections. If you have any questions " +
  `please contact our office at ${LADDER_OFFICE_PHONE}.`;

/**
 * Day 30, CONDITIONAL. For the ordinary case where nothing records a
 * suspension. It warns instead of asserting, so it needs no evidence about the
 * account — only the written policy.
 */
export const DAY30_SMS_BODY_UNVERIFIED =
  "This is your final reminder that your invoice is 30 days past due. Services may be " +
  "temporarily suspended until payment is received. If payment is not received within 35 days " +
  "of the invoice due date, the invoice may be sent to collections. If you have any questions " +
  `please contact our office at ${LADDER_OFFICE_PHONE}.`;

/**
 * Wording that ASSERTS this customer's services are already suspended. A
 * statement about their account, so it requires evidence.
 *
 * Deliberately matched on the assertion, not the word "suspend": "services may
 * be temporarily suspended" is a warning and must not trip this.
 */
const SUSPENSION_ASSERTED =
  /\bservices?\b[^.!?]{0,40}\b(?:has|have)\s+been\s+(?:temporarily\s+)?(?:suspended|stopped|paused)\b|\b(?:we\s+have|has\s+been)\s+suspended\b|\byour\s+services?\s+(?:are|is)\s+(?:now\s+)?suspended\b/i;

/** Wording that ASSERTS the invoice has been sent to collections already. */
const COLLECTIONS_ASSERTED =
  /\b(?:has|have)\s+been\s+(?:sent|referred|passed|turned)\s+(?:over\s+)?to\s+collections\b|\bis\s+(?:now\s+)?(?:in|with)\s+collections\b/i;

export function bodyAssertsASuspension(body: unknown): boolean {
  return typeof body === "string" && SUSPENSION_ASSERTED.test(body);
}

export function bodyAssertsCollectionsAlreadyHappened(body: unknown): boolean {
  return typeof body === "string" && COLLECTIONS_ASSERTED.test(body);
}

const MAX_BYTES = 4000;

function shapeIsUsable(body: unknown): body is string {
  if (typeof body !== "string" || !body.trim() || body.includes("\0")) return false;
  if (Buffer.byteLength(body, "utf8") > MAX_BYTES) return false;
  // These texts name no amount and carry no link, exactly like the policy's
  // own. Nothing is rendered in, so nothing can be rendered wrong.
  return !/[{}]/.test(body);
}

/**
 * Which claims a body actually makes. The gate proves these; it does not take
 * a caller's word for what the words say.
 *
 * Note it never returns `collections_after_day_35_policy` for a body that says
 * collections ALREADY happened — that is a different and unprovable claim, and
 * such a body is rejected outright by the validators below.
 */
export function ladderCopyClaims(body: string): readonly LadderClaim[] {
  const claims: LadderClaim[] = [];
  if (/\blate fees?\b/i.test(body)) claims.push("recurring_late_fee_policy");
  if (bodyAssertsASuspension(body)) claims.push("service_suspended");
  if (/\bcollections\b/i.test(body)) claims.push("collections_after_day_35_policy");
  return Object.freeze(claims);
}

/**
 * Is this body valid for a step that may claim NOTHING about the account?
 * Used by Day 20 and Day 25. It must warn about fees without claiming any were
 * applied (the Day 15 predicate, reused rather than re-expressed), and must not
 * assert a suspension or a completed collections referral.
 */
export function ladderWarningCopyIsValid(body: unknown): boolean {
  if (!shapeIsUsable(body)) return false;
  if (!day15SmsCopyWarnsWithoutClaiming(body)) return false;
  if (bodyAssertsASuspension(body)) return false;
  if (bodyAssertsCollectionsAlreadyHappened(body)) return false;
  return true;
}

/**
 * Day 30 has two valid shapes, and which one is allowed depends ONLY on whether
 * the suspension is proven.
 *
 *   proven     -> the asserted body is required to actually assert it, so the
 *                 customer is told the true thing rather than a hedge
 *   not proven -> the body must not assert a suspension at all
 *
 * A completed collections referral is never assertable: day 30 is five days
 * before the referral is even due.
 */
export function day30CopyIsValid(
  body: unknown,
  suspensionProven: boolean,
): boolean {
  if (!shapeIsUsable(body)) return false;
  if (bodyAssertsCollectionsAlreadyHappened(body)) return false;
  // Fee wording, when present, is held to the same standard as every other step.
  if (/\blate fees?\b/i.test(body) && !day15SmsCopyWarnsWithoutClaiming(body)) return false;
  return suspensionProven ? bodyAssertsASuspension(body) : !bodyAssertsASuspension(body);
}

/**
 * Proof that THIS customer's services are actually suspended.
 *
 * There is deliberately no path to this from an invoice being old, from a day
 * number, or from an operator's say-so in a config file. Nothing in the system
 * records suspensions today, which is why `day30Copy` returns the conditional
 * body: it is the honest default, not a placeholder to be flipped.
 */
export type SuspensionEvidence = Readonly<{
  source: "jobber-client-suspension" | "operator-recorded-suspension";
  jobberClientId: string;
  /** The Phoenix date services stopped. */
  suspendedOn: string;
  observedAt: string;
  evidenceRef: string;
}>;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

export function suspensionIsProven(
  evidence: SuspensionEvidence | null | undefined,
  jobberClientId: string,
): boolean {
  if (!evidence || typeof evidence !== "object") return false;
  if (evidence.source !== "jobber-client-suspension" && evidence.source !== "operator-recorded-suspension") return false;
  if (!text(evidence.jobberClientId) || evidence.jobberClientId !== jobberClientId) return false;
  if (!text(jobberClientId)) return false;
  if (typeof evidence.suspendedOn !== "string" || !DAY.test(evidence.suspendedOn)) return false;
  const at = Date.parse(evidence.observedAt);
  if (!Number.isFinite(at) || at > Date.now()) return false;
  return text(evidence.evidenceRef);
}

/** The Day 30 body this customer may actually be sent, decided by evidence. */
export function day30Copy(
  evidence: SuspensionEvidence | null | undefined,
  jobberClientId: string,
): { body: string; claims: readonly LadderClaim[]; suspensionProven: boolean } {
  const proven = suspensionIsProven(evidence, jobberClientId);
  const body = proven ? DAY30_SMS_BODY_SUSPENDED : DAY30_SMS_BODY_UNVERIFIED;
  return { body, claims: ladderCopyClaims(body), suspensionProven: proven };
}

/** The pinned customer text for a ladder day, where that day has one. */
export const LADDER_SMS_BODIES: Readonly<Record<20 | 25, string>> = Object.freeze({
  20: DAY20_SMS_BODY,
  25: DAY25_SMS_BODY,
});
