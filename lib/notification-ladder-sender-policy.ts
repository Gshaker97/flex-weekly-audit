/**
 * WHO THE LADDER SENDS AS, AND WHAT EACH RUNG DELIVERS.
 *
 * Both of these are the account owner's decisions, recorded here on 2026-11-19
 * rather than left implicit in a runner. Code elsewhere may read this policy; no
 * code anywhere may invent it.
 *
 * THE SENDING NUMBER. Approved by the owner on 2026-11-19 as the number every
 * ladder text sends from. It is the only SMS-capable number on the location
 * (observed through GoHighLevel's own phone-number list on 2026-11-18) and it
 * is the number the one approved staff test text actually went out from and
 * came back `delivered` on, so it is proven and not merely configured.
 *
 * It is pinned here rather than read from an environment variable on purpose: a
 * mistyped variable would send from a number customers do not recognise, or
 * fail at the provider, and neither failure would be visible until a customer
 * replied to nobody. The office number already lives in the pinned copy for the
 * same reason. Neither is a secret - both are numbers customers see.
 *
 * WHAT EACH RUNG DELIVERS. Days 10, 15, 20, 25 and 30 are messages to the
 * customer: ONE TEXT AND ONE EMAIL, carrying the same words. Days 21 and 35 are
 * internal: day 21 is Angie's call, day 35 is her collections decision.
 *
 * ONE TEXT AND ONE EMAIL, decided by the owner on 2026-11-24. Until then a
 * homeowner rung was a text only. The two are one message delivered twice, not
 * two messages: the email body is the text body, the identical string, so the
 * words cannot drift apart. See `notification-ladder-email.ts`.
 *
 * ONE PAIR PER CUSTOMER PER DAY, not one pair per invoice. A customer with
 * three overdue invoices gets one text and one email. That cap is enforced
 * where sends are reserved, not here.
 *
 * DAY 21 IS A TASK ONLY. Decided by the owner on 2026-11-19. The legacy Fixed
 * Automation workflow sends an email AND an internal text on day 21, and the
 * evaluator still describes it that way, marked "observed, not approved". It is
 * now approved in the other direction: day 21 delivers one task for Angie and
 * no message at all. One call should be raised once.
 */
import type { GhlSenderReview } from "./notification-ghl-contract";
import { LADDER_CUSTOMER_CHANNELS } from "./notification-ladder-email";

export const LADDER_SMS_SENDER = Object.freeze({
  /** E.164. The only SMS-capable number on this location, and the proven one. */
  number: "+16028548131",
  channel: "sms",
  scope: "conversations/message.write",
  /** The owner's approval, for the audit trail. */
  approvalRef: "owner-approved-2026-11-19-ladder-sms-sender",
  /** The one send that proved this number really delivers. */
  provenBy: "staff-test-sms-2026-11-18-delivered",
} as const);

/**
 * What a rung delivers. A rung the ladder does not have returns null.
 *
 * `customer_message` is one text AND one email with the same body. The old name
 * for it was "customer_sms", which stopped being true on 2026-11-24.
 */
export type LadderDelivery = "customer_message" | "internal_task";

const DELIVERY: Readonly<Record<number, LadderDelivery>> = Object.freeze({
  10: "customer_message", 15: "customer_message", 20: "customer_message",
  21: "internal_task",
  25: "customer_message", 30: "customer_message",
  35: "internal_task",
});

export function ladderDelivery(dayPastDue: number): LadderDelivery | null {
  return Number.isSafeInteger(dayPastDue) && Object.hasOwn(DELIVERY, dayPastDue)
    ? DELIVERY[dayPastDue] : null;
}

/** Days that message the customer - one text and one email - in ladder order. */
export const LADDER_CUSTOMER_MESSAGE_DAYS: readonly number[] = Object.freeze(
  Object.keys(DELIVERY).map(Number).filter(day => DELIVERY[day] === "customer_message").sort((a, b) => a - b));

/**
 * The old name, kept so no caller silently reads an undefined list. It is the
 * same days; each of them now delivers an email beside the text.
 */
export const LADDER_CUSTOMER_SMS_DAYS: readonly number[] = LADDER_CUSTOMER_MESSAGE_DAYS;

/** Days that raise internal work instead of messaging anyone. */
export const LADDER_INTERNAL_TASK_DAYS: readonly number[] = Object.freeze(
  Object.keys(DELIVERY).map(Number).filter(day => DELIVERY[day] === "internal_task").sort((a, b) => a - b));

/**
 * The sender review for a ladder text.
 *
 * The contract will only build a request when this matches the binding exactly,
 * so this is the single place the approval is expressed. It carries no
 * credential: approval to send as a number is not the ability to send.
 */
export function ladderSenderReview(accountId: string, locationId: string): GhlSenderReview {
  return Object.freeze({
    accountId, locationId, channel: "sms" as const, sender: LADDER_SMS_SENDER.number,
    scope: LADDER_SMS_SENDER.scope, approved: true as const, validated: true as const,
    evidenceRef: LADDER_SMS_SENDER.approvalRef,
  });
}

/**
 * Is this milestone a customer message at all?
 *
 * The evaluator holds a milestone whose channel policy is empty, which is the
 * right answer for a message and the WRONG answer for a task - a day 21 task is
 * not an undeclared message. Callers use this to tell the two apart instead of
 * reading an empty channel list as a fault.
 */
export function ladderMilestoneIsCustomerMessage(dayPastDue: number): boolean {
  return ladderDelivery(dayPastDue) === "customer_message";
}

/**
 * The channels a rung delivers on. A homeowner rung is both, always; an
 * internal rung messages nobody, so it is empty.
 *
 * This is the single place the "text AND email" decision is read from, so a
 * caller cannot deliver one half of a pair by accident.
 */
export function ladderCustomerChannels(dayPastDue: number): readonly ("sms" | "email")[] {
  return ladderMilestoneIsCustomerMessage(dayPastDue) ? LADDER_CUSTOMER_CHANNELS : EMPTY_CHANNELS;
}

const EMPTY_CHANNELS: readonly ("sms" | "email")[] = Object.freeze([]);
