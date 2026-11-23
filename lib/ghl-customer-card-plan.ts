/**
 * ONE CARD PER CUSTOMER.
 *
 * Why this replaces one-card-per-invoice
 * --------------------------------------
 * On 2026-11-20 the per-invoice writer ran against production and GoHighLevel
 * refused its second create for one contact:
 *
 *   400 {"code":"OPPORTUNITY_NO_DUPLICATE",
 *        "message":"Can not create duplicate opportunity for the contact."}
 *
 * GHL permits one open opportunity per contact. That is a hard constraint of
 * the product, not a rate limit and not something a retry clears, so a card per
 * invoice is unbuildable for any customer who owes more than one invoice.
 * Measured the same day against production: 50 unpaid invoices in the four
 * month window across 40 customers, of which 6 customers owe 16 invoices
 * between them. Those 6 would have failed forever.
 *
 * What this module does instead
 * -----------------------------
 * One card per customer. Its value is the TOTAL still unpaid. Its stage and its
 * reminder timing follow the OLDEST unpaid invoice, which is the one that has
 * been waiting longest and therefore sets how far down the chase ladder the
 * customer is. The name lists every unpaid invoice with its number, amount and
 * due date, because `name` and `monetaryValue` are the only fields the board
 * shows and the only ones `createOpportunity`/`moveOpportunityToStage` write.
 *
 * As invoices get paid the card is recalculated: the paid ones drop out of the
 * name, the value falls, and the stage follows whatever is now the oldest
 * unpaid invoice. When the last one is paid the card goes to "Invoice Paid"
 * carrying a zero balance.
 *
 * It reuses the customer's existing OPEN card rather than making a second one.
 * That is what makes it safe against the constraint above, and it is how the
 * one card the per-invoice writer managed to create before it halted is
 * adopted rather than orphaned.
 *
 * A finished card is not reopened
 * -------------------------------
 * A card marked `won` or `lost` is settled business: someone decided that
 * chase was over. When such a customer owes again, this module starts a NEW
 * card instead of reopening the old one, so the finished card stays an honest
 * record of what was collected and when. GoHighLevel allows this - its one-
 * card-per-contact rule counts only OPEN cards - and the resolver has already
 * excluded finished cards from `openCards`, so they arrive here as
 * `finishedCardIds` and change nothing except the reason recorded on the
 * create. The deployed per-invoice path did the opposite and held 135 changes
 * on "Closed or unknown status; automatic reopening disabled"; those customers
 * now get a fresh card.
 *
 * This module is pure. It performs no I/O and decides nothing about whether a
 * write is allowed; that stays with the writer and its gate.
 */

import {
  COLLECTIONS_CUTOFF, PROTECTED_STAGES, STAGE_OVERDUE, STAGE_PAID, STAGE_SENT,
  type ExistingCard, type InvoiceFact, type LegacySendingEvidence,
  legacySendingIsOff,
} from "./ghl-invoice-card-plan";

export { STAGE_OVERDUE, STAGE_PAID, STAGE_SENT };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const sorted = (r: readonly string[]) => Object.freeze([...new Set(r)].sort());

/** Dollars with at most a cent of precision: the `moneyCents` round trip. */
const cents = (v: unknown): number | null => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  const c = Math.round(v * 100);
  return Number.isSafeInteger(c) && c / 100 === v ? c : null;
};

const money = (dollars: number) =>
  `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export type InvoiceClock = Readonly<{
  daysPastDue: number; isOverdue: boolean; sentOn: string;
}>;

/** One unpaid invoice, as the card's name will show it. */
export type CustomerCardLine = Readonly<{
  invoiceId: string;
  invoiceNumber: string;
  balanceDollars: number;
  dueDate: string | null;
  /** Issue date, the key this module calls "oldest". */
  sentOn: string;
  daysPastDue: number;
  isOverdue: boolean;
}>;

/** What one customer's single card should look like. */
export type CustomerCardTarget = Readonly<{
  stage: string;
  /** Total still unpaid, in dollars. Zero once everything is settled. */
  monetaryValue: number;
  name: string;
  /** Every unpaid invoice, oldest first. Empty when all are paid. */
  lines: readonly CustomerCardLine[];
  /**
   * The oldest unpaid invoice: the one whose clock drives the stage and the
   * reminder timing. Null when nothing is unpaid.
   */
  oldest: CustomerCardLine | null;
  /**
   * Invoices deliberately kept off the card, with the reason. Drafts and
   * pre-window invoices land here rather than holding the customer, but they
   * are never dropped silently: an operator can always see what was excluded.
   */
  excluded: readonly Readonly<{ invoiceNumber: string | null; reason: string }>[];
}>;

export type CustomerCardDecision =
  | Readonly<{ state: "create"; target: CustomerCardTarget; reasons: readonly string[] }>
  | Readonly<{
      state: "update"; cardId: string; target: CustomerCardTarget;
      changes: readonly ("stage" | "value" | "name")[]; reasons: readonly string[];
    }>
  | Readonly<{ state: "nothing"; cardId: string; target: CustomerCardTarget; reasons: readonly string[] }>
  | Readonly<{ state: "hold"; cardId: string | null; reasons: readonly string[] }>
  | Readonly<{ state: "skip"; reasons: readonly string[] }>;

export type CustomerCardInput = Readonly<{
  contactId: string;
  /** Display label for the card. Never an address or a phone number. */
  label: string;
  invoices: readonly InvoiceFact[];
  /** OPEN cards only. Finished ones go in `finishedCardIds`. */
  cards: readonly ExistingCard[];
  /**
   * Cards this contact already carries that are `won` or `lost`. History: they
   * never block, never get reopened, and only add a reason to a create so the
   * run log says plainly that a settled card was left alone.
   */
  finishedCardIds?: readonly string[];
  clocks: Readonly<Record<string, InvoiceClock | null>>;
  /** First issue date in scope, from `invoiceWindowStart`. */
  windowStart?: string;
  /** The workflow whose sending must be off before any Overdue move. */
  legacyWorkflowId: string;
  legacySending?: LegacySendingEvidence | null;
  now?: Date;
}>;

/**
 * GoHighLevel's hard limit on an opportunity name. Measured, not guessed: on
 * 2026-11-22 a PUT carrying a 166-character name was refused with HTTP 422 and
 * "Name must be shorter than or equal to 150 characters.", which left one real
 * customer's card unconverted. Any name this function returns fits.
 */
export const CARD_NAME_MAX_LENGTH = 150;

const ELLIPSIS = "\u2026";

/** Last-resort trim, so nothing can leave this module over the cap. */
const clampToCap = (s: string): string =>
  s.length <= CARD_NAME_MAX_LENGTH ? s : s.slice(0, CARD_NAME_MAX_LENGTH - 1).trimEnd() + ELLIPSIS;

/**
 * The card's name. Lists the unpaid invoices so the board itself answers
 * "what does this customer owe, and since when" without opening Jobber - but
 * never at the cost of exceeding GoHighLevel's 150-character limit, because a
 * name one character too long is not a truncated card, it is NO card: the
 * whole write is refused.
 *
 * WHAT IS PROTECTED, IN ORDER, when there is not room for everything:
 *   1. `N unpaid invoices, $total` - the count and the money, always present
 *      and always in the same words. The old aggregate writer's `PER_CUSTOMER`
 *      guard matches on this phrase, so keeping it is what stops a second
 *      writer from treating these as somebody else's cards.
 *   2. The first invoice's number. A per-customer card has always named at
 *      least one invoice, and `invoiceNumbersInCardName` is what the ownership
 *      boundary in the sync uses to tell whose card this is. A name that
 *      listed no invoice at all would quietly move a card across that line.
 *   3. The customer's name, shortened with an ellipsis before any invoice is
 *      dropped, because a half-written customer name still identifies them
 *      while a missing balance does not.
 *   4. The remaining invoices, as many as fit, with `+N more` standing in for
 *      the rest so the board never implies the list is complete.
 */
export function customerCardName(label: string, lines: readonly CustomerCardLine[]): string {
  const who = label.trim();
  if (!lines.length) return clampToCap(`${who} — all invoices paid`);

  const total = lines.reduce((s, l) => s + l.balanceDollars, 0);
  const counted = `${lines.length} unpaid invoice${lines.length === 1 ? "" : "s"}, ${money(total)}`;
  const parts = lines.map(
    l => `#${l.invoiceNumber} ${money(l.balanceDollars)}${l.dueDate ? ` due ${l.dueDate}` : ""}`);

  const build = (name: string, shown: number) => {
    const hidden = parts.length - shown;
    return `${name} — ${counted}`
      + parts.slice(0, shown).map(p => ` · ${p}`).join("")
      + (hidden > 0 ? ` · +${hidden} more` : "");
  };

  // Shorten the customer's name first, but only as far as keeping the count
  // and the first invoice needs - never for the sake of a longer invoice list.
  let shortened = who;
  const over = build(who, 1).length - CARD_NAME_MAX_LENGTH;
  if (over > 0) {
    shortened = who.length - over > 1 ? who.slice(0, who.length - over - 1).trimEnd() + ELLIPSIS : ELLIPSIS;
  }

  // Then as much of the invoice list as fits. Every candidate is measured, so
  // this does not rely on each entry being a predictable width.
  for (let shown = parts.length; shown >= 1; shown--) {
    const candidate = build(shortened, shown);
    if (candidate.length <= CARD_NAME_MAX_LENGTH) return candidate;
  }
  return clampToCap(build(shortened, 1));
}

/**
 * Reduce one customer's invoices to the single card they should have.
 *
 * Holds rather than guesses. An invoice whose number or amounts cannot be read
 * is not quietly dropped from the total: it holds the whole customer, because a
 * card whose value silently omits an invoice is worse than no card at all.
 */
export function planCustomerCard(input: CustomerCardInput): CustomerCardDecision {
  const now = input.now ?? new Date();
  const windowStart =
    text(input.windowStart) && DAY.test(input.windowStart) && input.windowStart >= COLLECTIONS_CUTOFF
      ? input.windowStart
      : COLLECTIONS_CUTOFF;

  if (!text(input.contactId)) return Object.freeze({ state: "skip", reasons: sorted(["no_contact_id"]) });
  if (!text(input.label)) return Object.freeze({ state: "skip", reasons: sorted(["no_usable_label"]) });

  const lines: CustomerCardLine[] = [];
  const holds: string[] = [];
  /** Invoices deliberately left off the card, and why. Surfaced, never silent. */
  const excluded: { invoiceNumber: string | null; reason: string }[] = [];
  let sawInScope = false;

  for (const invoice of input.invoices) {
    const total = cents(invoice.totalDollars);
    const balance = cents(invoice.balanceDollars);
    const status = invoice.status?.toLowerCase() ?? null;

    if (total === null || balance === null) { holds.push("invoice_amounts_unusable"); continue; }
    if (balance > total) { holds.push("balance_exceeds_total"); continue; }

    // Settled invoices simply leave the card. They are not a hold and not a
    // line; recalculation is exactly their removal from the total.
    if (balance === 0) { sawInScope = true; continue; }

    // Status first, and never a hold. A draft is not a sent invoice, so it is
    // not something to chase, and it frequently carries no dates at all.
    // Holding a whole customer over an unsent draft would strand them forever
    // - which is exactly what the 2026-11-20 production dry run did to a
    // customer whose only problem invoice was a dateless draft.
    if (status !== "awaiting_payment" && status !== "past_due") {
      excluded.push({ invoiceNumber: invoice.invoiceNumber, reason: `not_a_sent_invoice_status_${status ?? "missing"}` });
      continue;
    }

    // Then the window, judged on the issue date alone, BEFORE the clock. An
    // ancient invoice with contradictory dates must not hold a customer whose
    // current invoices are perfectly readable. The real case was an invoice
    // from July 2024 whose due date fell a day before its issue date.
    if (text(invoice.issuedDate) && DAY.test(invoice.issuedDate) && invoice.issuedDate < windowStart) {
      excluded.push({ invoiceNumber: invoice.invoiceNumber, reason: "issued_before_the_lookback_window" });
      continue;
    }

    const clock = input.clocks[invoice.invoiceId] ?? null;
    if (!clock) { holds.push("invoice_dates_unusable"); continue; }
    if (clock.sentOn < windowStart) continue; // genuinely out of scope, not a hold
    sawInScope = true;

    if (total === 0) { holds.push("zero_total_invoice"); continue; }
    // Jobber occasionally labels an invoice past_due before its own due date.
    // That contradiction must not promote a whole customer's card early.
    if (status === "past_due" && !clock.isOverdue) {
      holds.push("past_due_label_contradicts_the_due_date"); continue;
    }
    if (!text(invoice.invoiceNumber)) { holds.push("invoice_number_unreadable"); continue; }

    lines.push(Object.freeze({
      invoiceId: invoice.invoiceId,
      invoiceNumber: invoice.invoiceNumber.trim(),
      balanceDollars: invoice.balanceDollars as number,
      dueDate: text(invoice.dueDate) ? invoice.dueDate : null,
      sentOn: clock.sentOn,
      daysPastDue: clock.daysPastDue,
      isOverdue: clock.isOverdue,
    }));
  }

  // One unreadable invoice poisons the total, so the whole customer holds.
  if (holds.length) return Object.freeze({ state: "hold", cardId: null, reasons: sorted(holds) });
  if (!sawInScope && !lines.length) {
    return Object.freeze({ state: "skip", reasons: sorted(["no_invoices_in_the_lookback_window"]) });
  }

  // Oldest = earliest issued. That invoice has been waiting longest, so it is
  // the one whose position on the reminder ladder the customer is really at.
  lines.sort((a, b) =>
    a.sentOn === b.sentOn ? a.invoiceNumber.localeCompare(b.invoiceNumber) : a.sentOn < b.sentOn ? -1 : 1);
  const oldest = lines[0] ?? null;
  const unpaidTotal = Math.round(lines.reduce((s, l) => s + l.balanceDollars, 0) * 100) / 100;

  const overdueAllowed = legacySendingIsOff(
    input.legacySending ?? null, input.legacyWorkflowId, now);

  const wantedStage = !oldest ? STAGE_PAID : oldest.isOverdue ? STAGE_OVERDUE : STAGE_SENT;
  const target: CustomerCardTarget = Object.freeze({
    stage: wantedStage,
    monetaryValue: oldest ? unpaidTotal : 0,
    name: customerCardName(input.label, lines),
    lines: Object.freeze(lines),
    oldest,
    excluded: Object.freeze(excluded.map(e => Object.freeze(e))),
  });

  // Which card is this customer's? Exactly one, or we refuse to choose.
  const usable = input.cards.filter(c => text(c.id));
  const protectedCard = usable.find(c => text(c.stageName) && PROTECTED_STAGES.includes(c.stageName));
  if (protectedCard) {
    return Object.freeze({
      state: "hold", cardId: protectedCard.id,
      reasons: sorted([`card_sits_in_a_protected_stage_${protectedCard.stageName}`]),
    });
  }
  if (usable.length > 1) {
    return Object.freeze({
      state: "hold", cardId: null,
      reasons: sorted(["contact_has_more_than_one_card_in_this_pipeline"]),
    });
  }

  const existing = usable[0];
  if (!existing) {
    if (!oldest) return Object.freeze({ state: "skip", reasons: sorted(["nothing_unpaid_and_no_card_to_close"]) });
    // A settled card is left settled; this customer simply starts a new one.
    const restarted = (input.finishedCardIds ?? []).filter(text).length > 0;
    const why = restarted
      ? "started_a_new_card_because_the_previous_one_is_finished"
      : "no_card_for_this_contact_yet";
    // A new card always starts in Sent. Creating straight into Overdue is the
    // transition the legacy workflow sends on, so it is never done blind.
    if (wantedStage === STAGE_OVERDUE && !overdueAllowed) {
      return Object.freeze({
        state: "create",
        target: Object.freeze({ ...target, stage: STAGE_SENT }),
        reasons: sorted([why, "created_in_sent_because_the_overdue_move_needs_recorded_proof"]),
      });
    }
    return Object.freeze({ state: "create", target, reasons: sorted([why]) });
  }

  // Reuse. This is the branch that keeps us inside GHL's one-card-per-contact
  // rule, and the branch that adopts the card already on the board.
  const reasons: string[] = ["reused_the_contacts_existing_card"];
  let stage: string = wantedStage;
  if (wantedStage === STAGE_OVERDUE && !overdueAllowed) {
    stage = text(existing.stageName) ? existing.stageName : STAGE_SENT;
    reasons.push("overdue_move_withheld_pending_recorded_proof");
  }

  const finalTarget: CustomerCardTarget = Object.freeze({ ...target, stage });
  const changes: ("stage" | "value" | "name")[] = [];
  if ((existing.stageName ?? null) !== stage) changes.push("stage");
  if (cents(existing.monetaryValue) !== cents(finalTarget.monetaryValue)) changes.push("value");
  if ((existing.name ?? null) !== finalTarget.name) changes.push("name");

  if (!changes.length) {
    return Object.freeze({ state: "nothing", cardId: existing.id, target: finalTarget, reasons: sorted(reasons) });
  }
  return Object.freeze({
    state: "update", cardId: existing.id, target: finalTarget,
    changes: Object.freeze(changes), reasons: sorted(reasons),
  });
}
