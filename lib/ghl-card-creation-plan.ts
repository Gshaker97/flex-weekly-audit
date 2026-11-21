/**
 * CREATE A CARD FOR AN INVOICED JOB THAT HAS NONE.
 *
 * The Invoice Pipeline sync has always been "existing cards only": a customer
 * with unpaid invoices and no card is reported as
 * "No existing card; creation disabled" and nothing happens. That is why the
 * board does not reflect reality, and why 28 of 42 reminder holds on 2026-11-19
 * were `card_not_in_overdue_stage` or `card_status_not_open`. The account owner
 * asked on 2026-11-19 for invoiced jobs to get a card and be moved accordingly.
 *
 * A NEW CARD IS ALWAYS CREATED IN "INVOICE SENT", NEVER IN "INVOICE OVERDUE",
 * AND THAT IS THE WHOLE SAFETY ARGUMENT OF THIS MODULE.
 *
 * The legacy "Fixed Automation" workflow is triggered by an opportunity event.
 * The reviewed evidence for that workflow records two facts side by side:
 * `sentTransitionCannotSendOrEnroll: true`, and a set of guards that exist only
 * because an OVERDUE transition can enrol a contact and start its reminder
 * clock (`pastAndDueNowMilestonesSkipped`, and the sync's own refusal to touch
 * an existing Overdue cycle: "no re-enrollment or clock restart").
 *
 * So creating a card directly in Overdue would not be a tidy-up of a board. For
 * an invoice already 200 days past due it could enrol that customer and fire
 * legacy reminders at them immediately - the exact outcome every guard in this
 * codebase exists to prevent. Creating in Sent cannot send or enrol anyone, and
 * the move from Sent onwards stays with the existing, reviewed stage logic and
 * its guards.
 *
 * PLANNING ONLY. This module computes a target; it performs no I/O, holds no
 * credential and cannot create anything. The caller writes, under its own
 * admitted writer, mode and approved cohort.
 */

/** The stage a new card is created in. Deliberately not a parameter. */
export const CARD_CREATION_STAGE = "Invoice Sent" as const;

export type CardCreationInput = Readonly<{
  /** The single GoHighLevel contact this customer resolved to. */
  contactId: string;
  /** How many cards this contact already has, in ANY status. Must be 0. */
  existingCardCount: number;
  /** The verified Jobber plan for this customer's own invoices. */
  verified: Readonly<{
    /** Stage name the evidence supports: "Invoice Sent" | "Invoice Overdue" | "Invoice Paid". */
    stage: string;
    /**
     * The outstanding balance IN DOLLARS, exactly as `phoneSourcePlan` reports
     * it - that function sums cents and returns `cents / 100`, and a GoHighLevel
     * opportunity's monetaryValue is a currency amount, not minor units. So
     * $137.50 arrives here as 137.5, which is why this is not an integer check:
     * requiring one would quietly refuse a card to every customer whose balance
     * is not a whole number of dollars.
     */
    total: number;
    /** How many unpaid invoices it represents. */
    count: number;
  }> | null;
  /** Human label for the card name. Never an address or a phone number. */
  label: string;
}>;

export type CardCreationPlan =
  | Readonly<{
      state: "create";
      contactId: string;
      stageName: typeof CARD_CREATION_STAGE;
      /** Dollars, passed through from the verified plan unchanged. */
      monetaryValue: number;
      name: string;
      /** True when the evidence says Overdue but we still create in Sent. */
      deferredFromOverdue: boolean;
      reasons: readonly string[];
    }>
  | Readonly<{ state: "hold"; reasons: readonly string[] }>;

const PAID = "Invoice Paid";
const OVERDUE = "Invoice Overdue";
const SENT = "Invoice Sent";
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/**
 * A usable money amount in dollars: the same round-trip rule as `moneyCents` in
 * ghl-phone-state.ts, restated here so this module imports no Jobber client.
 * Accepts ordinary cents (137.5, 0.29) and rejects sub-cent values, which would
 * mean the source amount was never a real invoice balance.
 */
const dollars = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const cents = Math.round(value * 100);
  return Number.isSafeInteger(cents) && cents / 100 === value ? cents : null;
};

const hold = (reasons: readonly string[]): CardCreationPlan =>
  Object.freeze({ state: "hold", reasons: Object.freeze([...new Set(reasons)].sort()) });

/**
 * Decide whether to create a card, and what it should say.
 *
 * Holds on anything uncertain. In particular it will not create a SECOND card:
 * a contact that already has one - open, won, lost or unknown - is left to the
 * existing logic, because two cards for one customer is the ambiguity the
 * reminder evaluator then refuses to act on.
 */
export function planCardCreation(input: CardCreationInput): CardCreationPlan {
  if (!input || typeof input !== "object") return hold(["malformed_card_creation_input"]);
  const reasons: string[] = [];

  if (!text(input.contactId)) reasons.push("no_single_contact_resolved");
  if (!Number.isSafeInteger(input.existingCardCount) || input.existingCardCount < 0)
    reasons.push("existing_card_count_unreadable");
  else if (input.existingCardCount > 0) reasons.push("contact_already_has_a_card");
  if (!text(input.label)) reasons.push("card_label_missing");

  const verified = input.verified;
  if (!verified || typeof verified !== "object") reasons.push("no_verified_jobber_plan");
  else {
    if (!text(verified.stage) || ![SENT, OVERDUE, PAID].includes(verified.stage))
      reasons.push("verified_stage_unrecognised");
    // A paid customer has nothing to chase, so a card would be noise on a board
    // that exists to show who owes money.
    else if (verified.stage === PAID) reasons.push("nothing_outstanding_so_no_card_needed");
    const cents = dollars(verified.total);
    if (cents === null || cents <= 0) reasons.push("verified_total_not_positive");
    if (!Number.isSafeInteger(verified.count) || verified.count <= 0) reasons.push("verified_invoice_count_not_positive");
  }

  if (reasons.length || !verified) return hold(reasons);

  // The one decision this module makes, and it is fixed: Sent, never Overdue.
  const deferredFromOverdue = verified.stage === OVERDUE;
  const noun = `invoice${verified.count === 1 ? "" : "s"}`;
  return Object.freeze({
    state: "create",
    contactId: input.contactId,
    stageName: CARD_CREATION_STAGE,
    monetaryValue: verified.total,
    // Matches the existing naming so a created card is indistinguishable from
    // one the sync has been maintaining all along.
    name: `${input.label.trim()} - ${verified.count} unpaid ${noun}`,
    deferredFromOverdue,
    reasons: Object.freeze(deferredFromOverdue
      ? ["created_in_sent_not_overdue_to_avoid_legacy_enrollment"]
      : []),
  });
}

/** A one-line summary for the plan log, with no customer detail in it. */
export function describeCardCreation(plan: CardCreationPlan): string {
  return plan.state === "create"
    ? `create in ${plan.stageName} value=${plan.monetaryValue}` +
      (plan.deferredFromOverdue ? " (evidence says Overdue; deferred to Sent)" : "")
    : `hold: ${plan.reasons.join("; ")}`;
}
