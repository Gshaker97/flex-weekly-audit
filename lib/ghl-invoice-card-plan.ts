/**
 * ONE CARD PER INVOICE.
 *
 * Chosen by the account owner on 2026-11-20, after measuring what the Invoice
 * Pipeline actually contains: 316 cards in three different shapes, written by
 * three different things that disagree about what a card even is.
 *
 *   169  "<name> - N overdue/unpaid invoice(s)"   this sync, one per CUSTOMER
 *   108  a bare customer name                     placed by hand
 *    39  "Invoice #7226 - <name>"                 this sync, one per INVOICE
 *
 * ALL THREE SHAPES ARE OURS OR MANUAL, and the per-invoice ones are OUR OWN
 * EARLIER WORK. Traced 2026-11-20: `opportunityName()` produced exactly
 * `Invoice #<number> - <client>` from commit 556e0c9 (2026-06-19) until
 * d235ff5 (2026-11-06) removed `createOpportunity` and replaced it with the
 * hold "No existing card; creation disabled". The last such card was created
 * 2026-11-05, the day before. Their timestamps are this service's hourly cron:
 * 38 of 39 fell at 8-12 minutes past the hour, all 39 on a weekday.
 *
 * The owner's four Zapier Zaps are NOT the source. They identify an opportunity
 * by CONTACT - first name, last name, phone, email - and put the invoice number
 * in the Notes, so they are per-customer writers too. All four have been off
 * since about 2026-09-21.
 *
 * So this is a RESTORATION, not a new idea, and it is right for the same reason
 * it was right the first time: the whole reminder ladder is per invoice - day
 * 10, 15, 20, 21, 25, 30, 35 past due on THAT invoice - and one card for a
 * customer can never say "invoice A is at day 15 and invoice B is at day 3".
 * That mismatch is why the text ladder's eligibility check ("is this customer's
 * card in the Overdue stage?") fitted so badly and held 28 of 42 invoices.
 *
 * WHAT THE OLD VERSION GOT WRONG, and this one does not: it created cards
 * DIRECTLY IN "Invoice Overdue" for a past-due invoice. That is the opportunity
 * event the legacy Fixed Automation triggers on, so the old sync was itself a
 * feed into the legacy text ladder. See the Overdue gate below.
 *
 * ADOPT, DO NOT OVERWRITE. A card already named "#7226" IS invoice 7226's card.
 * This plan keeps that name and corrects only the stage and the amount. It never
 * renames a card, never deletes one, and never touches the per-customer or
 * bare-name cards - retiring those is a separate decision for the owner.
 *
 * THE OVERDUE GATE, which is the reason this is a plan and not yet a writer.
 * The legacy "Fixed Automation" workflow is triggered by an opportunity event
 * (`exactOpportunityTrigger`), so moving a card INTO "Invoice Overdue" can enrol
 * that customer and start firing legacy reminders. 11 of the 27 live overdue
 * invoices are more than 35 days past due. Correcting the board before that
 * workflow's sending is switched off would therefore BE a send, to real
 * customers, about invoices that are months old.
 *   So every move into Overdue is withheld until the caller can prove the legacy
 *   workflow's sending is off, and a brand new card is created in "Invoice Sent",
 *   whose transition provably cannot send or enrol anyone
 *   (`sentTransitionCannotSendOrEnroll`). Until then the board will understate
 *   how overdue things are, which is the lesser of the two wrongs: a quiet board
 *   can be corrected later, a text cannot be unsent.
 *
 * PLANNING ONLY. No I/O, no credential, nothing here can change a card.
 */

export const STAGE_SENT = "Invoice Sent" as const;
export const STAGE_OVERDUE = "Invoice Overdue" as const;
export const STAGE_PAID = "Invoice Paid" as const;

/**
 * Stages this plan will never move a card out of. "Late Fee Invoice Sent" and
 * "Invoice Canceled" record a decision someone made by hand, and "Closed Out"
 * is terminal; overwriting any of them would destroy information the board is
 * the only record of.
 */
export const PROTECTED_STAGES: readonly string[] = Object.freeze([
  "Late Fee Invoice Sent", "Invoice Canceled", "Quote Sent", "Closed Out",
]);

/** Invoices issued before this are out of scope, matching the Collections cutoff. */
export const COLLECTIONS_CUTOFF = "2026-01-01" as const;

/**
 * HELD BY NAME, AT THE OWNER'S STANDING INSTRUCTION: "Keep #7171 and Sherrie
 * Woods held."
 *
 * Written here rather than inferred, so the list is auditable and so lifting it
 * is a visible edit. It mirrors `EXCLUDED_NAMES` in `scripts/catchup-run.ts`,
 * which is the same decision on the send path.
 *
 * WHAT IT WITHHOLDS IS THE MOVE INTO OVERDUE, and only that. The reminder
 * ladder's eligibility test is "is this customer's card in the Overdue stage?",
 * so moving their card there would quietly re-admit them to the ladder, which
 * is the thing the hold exists to prevent. The amount on their card is still
 * corrected: showing what is actually owed is not a message to anybody.
 */
export const OVERDUE_HELD_CLIENT_NAMES: readonly string[] = Object.freeze(["Paula Rose", "Sherrie Woods"]);
/** The same hold, by invoice, for one the owner named directly. */
export const OVERDUE_HELD_INVOICE_NUMBERS: readonly string[] = Object.freeze(["7171"]);

/** Whether the owner's standing hold covers this customer or any of these invoices. */
export function overdueMoveIsHeldByOwner(
  label: string | null | undefined, invoiceNumbers: readonly string[]
): boolean {
  const name = typeof label === "string" ? label.trim().toLowerCase().replace(/\s+/g, " ") : "";
  if (name && OVERDUE_HELD_CLIENT_NAMES.some(n => n.toLowerCase() === name)) return true;
  return invoiceNumbers.some(n => typeof n === "string" && OVERDUE_HELD_INVOICE_NUMBERS.includes(n.trim()));
}

/**
 * How far back the board looks. The owner's scope, 2026-11-20: "all sent and
 * unpaid, overdue or whatever jobber status's it as invoices from the past 4
 * months to today should be added."
 *
 * A ROLLING window, not a fixed date, so it keeps meaning the same thing in
 * March as it does today without anyone editing it.
 */
export const DEFAULT_LOOKBACK_MONTHS = 4;

/**
 * The first issue date still in scope: `months` back from `now`, and never
 * earlier than the Collections cutoff, so the new window can only ever narrow
 * the old boundary and never quietly widen it.
 *
 * Month arithmetic by calendar month, clamped to the last day of the target
 * month: 4 months back from 31 October is 30 June, not 1 July. Done in UTC
 * because an invoice's issue date is a plain calendar day with no timezone.
 */
export function invoiceWindowStart(now: Date, months = DEFAULT_LOOKBACK_MONTHS): string {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return COLLECTIONS_CUTOFF;
  if (!Number.isSafeInteger(months) || months < 1 || months > 120) return COLLECTIONS_CUTOFF;
  const y = now.getUTCFullYear(), m = now.getUTCMonth(), d = now.getUTCDate();
  const target = new Date(Date.UTC(y, m - months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const start = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d, lastDay)));
  const day = start.toISOString().slice(0, 10);
  return day < COLLECTIONS_CUTOFF ? COLLECTIONS_CUTOFF : day;
}

/**
 * Proof that the legacy workflow can no longer send. Deliberately not a boolean
 * and not an environment variable: "the workflow is off" is a claim about the
 * outside world, so it has to carry who checked, when, and against which
 * workflow.
 */
export type LegacySendingEvidence = Readonly<{
  source: "operator-confirmed-workflow-sending-disabled";
  workflowId: string;
  disabledOn: string;
  observedAt: string;
  evidenceRef: string;
}>;

export type InvoiceFact = Readonly<{
  invoiceId: string;
  invoiceNumber: string | null;
  status: string | null;
  /** Dollars, as Jobber reports them. */
  totalDollars: number | null;
  balanceDollars: number | null;
  issuedDate: string | null;
  dueDate: string | null;
}>;

export type ExistingCard = Readonly<{
  id: string;
  name: string | null;
  stageName: string | null;
  status: string | null;
  monetaryValue: number | null;
}>;

export type InvoiceCardAction =
  | Readonly<{
      state: "adopt"; invoiceId: string; invoiceNumber: string; cardId: string;
      /** Where the evidence says it belongs. */
      desiredStage: string;
      /** Where this plan will actually put it, once the gate allows. */
      stage: string;
      monetaryValue: number;
      changes: readonly ("stage" | "value")[];
      reasons: readonly string[];
    }>
  | Readonly<{
      state: "create"; invoiceId: string; invoiceNumber: string;
      desiredStage: string; stage: typeof STAGE_SENT;
      monetaryValue: number; name: string; reasons: readonly string[];
    }>
  | Readonly<{
      /**
       * TAKE OVER ONE CARD FOR SEVERAL INVOICES.
       *
       * A card that names several invoices, or none at all, is not one
       * invoice's card - it stands for a SET of this customer's invoices. This
       * action moves that one card to the stage and amount the whole set adds
       * up to. It never renames it, so the set it may cover is bounded by what
       * the name already says; see `planInvoiceCards`.
       */
      state: "combine"; cardId: string;
      /** Every invoice this one card is being made to stand for. At least one. */
      invoiceIds: readonly string[];
      invoiceNumbers: readonly string[];
      desiredStage: string;
      stage: string;
      /** The sum of the covered invoices' balances, in dollars. */
      monetaryValue: number;
      changes: readonly ("stage" | "value")[];
      reasons: readonly string[];
    }>
  | Readonly<{ state: "hold"; invoiceId: string; invoiceNumber: string | null; cardId: string | null; reasons: readonly string[] }>
  | Readonly<{ state: "skip"; invoiceId: string; invoiceNumber: string | null; reasons: readonly string[] }>;

export type InvoiceCardPlan = Readonly<{
  actions: readonly InvoiceCardAction[];
  /** Cards this plan deliberately leaves exactly as they are. */
  untouched: readonly Readonly<{ cardId: string; reason: string }>[];
  summary: Readonly<{ adopt: number; combine: number; create: number; hold: number; skip: number; untouched: number }>;
}>;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const sorted = (r: readonly string[]) => Object.freeze([...new Set(r)].sort());

/** Dollars with at most a cent of precision: the `moneyCents` round trip. */
const cents = (v: unknown): number | null => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  const c = Math.round(v * 100);
  return Number.isSafeInteger(c) && c / 100 === v ? c : null;
};

/** Our own per-customer card format, which this plan must never overwrite. */
const PER_CUSTOMER = /\d+\s+(overdue|unpaid)\s+invoice/i;

/**
 * The name a per-invoice card carries: `Invoice #7226 — Someone`.
 *
 * This is not a new convention. It is exactly what `opportunityName()` produced
 * in this file's own history, from 2026-06-19 until card creation was removed
 * on 2026-11-06, and the 39 cards it left on the board still read this way.
 */
export function invoiceCardName(invoiceNumber: string, label: string): string {
  return `Invoice #${invoiceNumber.trim()} — ${label.trim()}`;
}

/** Every invoice number a card's name claims. More than one is an ambiguity. */
export function invoiceNumbersInCardName(name: string | null | undefined): readonly string[] {
  if (!text(name)) return Object.freeze([]);
  return Object.freeze([...new Set([...name.matchAll(/#\s*(\d{3,})/g)].map(m => m[1]))]);
}

/** Does this evidence prove THIS workflow can no longer send? */
export function legacySendingIsOff(
  evidence: LegacySendingEvidence | null | undefined, workflowId: string, now = new Date()
): boolean {
  if (!evidence || typeof evidence !== "object") return false;
  if (evidence.source !== "operator-confirmed-workflow-sending-disabled") return false;
  if (!text(workflowId) || evidence.workflowId !== workflowId) return false;
  if (!text(evidence.evidenceRef)) return false;
  if (!text(evidence.disabledOn) || !DAY.test(evidence.disabledOn)) return false;
  const observed = Date.parse(evidence.observedAt);
  // A check from the future is a clock problem, not evidence.
  return Number.isFinite(observed) && observed <= now.getTime();
}

/**
 * Where one invoice's own facts say its card belongs, or null when the facts do
 * not support any stage. Mirrors `phoneSourcePlan`'s rules, one invoice at a
 * time instead of summed over a customer.
 */
export function desiredStageForInvoice(
  invoice: InvoiceFact, clock: { daysPastDue: number; isOverdue: boolean; sentOn: string } | null,
  /** First issue date in scope. Required, so no caller can forget the window. */
  windowStart: string = COLLECTIONS_CUTOFF
): { stage: string; balance: number } | { stage: null; reason: string } {
  const total = cents(invoice.totalDollars);
  const balance = cents(invoice.balanceDollars);
  if (total === null || balance === null) return { stage: null, reason: "invoice_amounts_unusable" };
  if (balance > total) return { stage: null, reason: "balance_exceeds_total" };
  const status = invoice.status?.toLowerCase() ?? null;
  if (status === "paid" && balance === 0) return { stage: STAGE_PAID, balance: 0 };
  if (!clock) return { stage: null, reason: "invoice_dates_unusable" };
  // A malformed window is treated as the widest safe boundary, never as "no
  // boundary": an unreadable setting must not silently pull in years of history.
  const start = DAY.test(windowStart) && windowStart >= COLLECTIONS_CUTOFF ? windowStart : COLLECTIONS_CUTOFF;
  if (clock.sentOn < start) return { stage: null, reason: "outside_the_lookback_window" };
  if (total === 0) return { stage: null, reason: "zero_total_invoice" };
  if (balance > 0 && (status === "awaiting_payment" || status === "past_due")) {
    // Jobber occasionally labels an invoice past_due before its own due date.
    // That contradiction is held rather than used to promote a card early.
    if (status === "past_due" && !clock.isOverdue) return { stage: null, reason: "past_due_label_contradicts_the_due_date" };
    return { stage: clock.isOverdue ? STAGE_OVERDUE : STAGE_SENT, balance: invoice.balanceDollars as number };
  }
  return { stage: null, reason: `unusable_invoice_status_${status ?? "missing"}` };
}

export type InvoiceCardInput = Readonly<{
  /** The single GoHighLevel contact these cards hang off. */
  contactId: string;
  /** Label for a NEW card's name. Never an address or a phone number. */
  label: string;
  invoices: readonly InvoiceFact[];
  cards: readonly ExistingCard[];
  /** One per invoice id, from the live invoice clock. */
  clocks: Readonly<Record<string, { daysPastDue: number; isOverdue: boolean; sentOn: string } | null>>;
  /**
   * First issue date in scope, from `invoiceWindowStart`. Omitted means the
   * Collections cutoff, which is wider - callers that care must pass it.
   */
  windowStart?: string;
  /** The workflow whose sending must be off before any Overdue move. */
  legacyWorkflowId: string;
  legacySending?: LegacySendingEvidence | null;
  now?: Date;
}>;

/**
 * Work out, for one customer, what each of their invoices' cards should be.
 *
 * Holds rather than guesses. In particular it will not act on an invoice whose
 * number it cannot read, because the number is the only link between an invoice
 * and its card: acting without it would mean picking a card by position.
 */
export function planInvoiceCards(input: InvoiceCardInput): InvoiceCardPlan {
  const empty: InvoiceCardPlan = Object.freeze({
    actions: Object.freeze([]), untouched: Object.freeze([]),
    summary: Object.freeze({ adopt: 0, combine: 0, create: 0, hold: 0, skip: 0, untouched: 0 }),
  });
  if (!input || typeof input !== "object" || !Array.isArray(input.invoices) || !Array.isArray(input.cards)) return empty;

  const now = input.now ?? new Date();
  const gateOpen = legacySendingIsOff(input.legacySending, input.legacyWorkflowId, now);
  const actions: InvoiceCardAction[] = [];
  const claimed = new Set<string>();

  /**
   * TAKING OVER THE CARDS THAT WERE ALREADY THERE.
   *
   * GoHighLevel refuses a second opportunity for a contact that already has one
   * in a pipeline (`OPPORTUNITY_NO_DUPLICATE`), measured against the live
   * location on 2026-11-25: of 32 creations attempted that day 3 succeeded, and
   * all 3 were for contacts with no card. So for every customer who already has
   * a card, one-card-per-invoice is not reachable at all, and refusing to touch
   * their card means their invoices never appear on the board. 55 of the 61 live
   * unpaid invoices were in exactly that position.
   *
   * So a card that is not one invoice's card is treated as a COMBINED card: it
   * stands for a set of this customer's invoices, and its stage and amount are
   * driven by the whole set. The account owner asked for this on 2026-11-25.
   *
   * WHAT A COMBINED CARD MAY COVER IS BOUNDED BY ITS OWN NAME, because this
   * plan still never renames a card:
   *   - a card naming #7286 and #7304 covers exactly those two invoices, so the
   *     name keeps telling the truth about what the amount is for;
   *   - a card naming no invoice at all (`Sherrie Woods - 4 overdue invoices`,
   *     or a bare hand-placed name) covers whatever this customer owes.
   * An invoice is never folded into a card that names a DIFFERENT invoice: that
   * would leave a card reading `Invoice #7319` while carrying two invoices'
   * money, which is worse than leaving the second one off the board.
   */
  type Pending = Readonly<{ invoiceId: string; invoiceNumber: string; balance: number; overdue: boolean }>;
  /** Invoices whose only match is a card naming several invoices, by card id. */
  const shared = new Map<string, Pending[]>();
  /** Invoices with no card naming them at all. */
  const orphans: Pending[] = [];
  /** Cards this plan has given to a single invoice; never also combined. */
  const directlyOwned = new Set<string>();
  /** True once any of this customer's invoices could not be read at all. */
  let unreadableInvoice = false;

  // A number that appears on two different invoices cannot identify a card.
  const numberCounts = new Map<string, number>();
  for (const inv of input.invoices) {
    if (text(inv.invoiceNumber)) numberCounts.set(inv.invoiceNumber.trim(), (numberCounts.get(inv.invoiceNumber.trim()) ?? 0) + 1);
  }

  for (const invoice of input.invoices) {
    const number = text(invoice.invoiceNumber) ? invoice.invoiceNumber.trim() : null;
    const hold = (...reasons: string[]): void => {
      // A held invoice is one whose own facts this plan could not use. No
      // combined total may be computed while one of them is outstanding: the
      // sum would silently leave that invoice's money out.
      unreadableInvoice = true;
      actions.push(Object.freeze({ state: "hold", invoiceId: invoice.invoiceId, invoiceNumber: number, cardId: null, reasons: sorted(reasons) }));
    };
    if (!text(invoice.invoiceId)) { hold("invoice_id_missing"); continue; }
    if (!number) { hold("invoice_number_missing"); continue; }
    if ((numberCounts.get(number) ?? 0) > 1) { hold("invoice_number_is_not_unique"); continue; }

    const want = desiredStageForInvoice(invoice, input.clocks?.[invoice.invoiceId] ?? null,
      input.windowStart ?? invoiceWindowStart(now));
    const matches = input.cards.filter(card => invoiceNumbersInCardName(card.name).includes(number));
    for (const card of matches) claimed.add(card.id);

    if (want.stage === null) {
      // Out of scope is not a fault; everything else is.
      if (want.reason === "outside_the_lookback_window" || want.reason === "zero_total_invoice") {
        actions.push(Object.freeze({ state: "skip", invoiceId: invoice.invoiceId, invoiceNumber: number, reasons: sorted([want.reason]) }));
      } else hold(want.reason);
      continue;
    }

    if (matches.length > 1) {
      actions.push(Object.freeze({ state: "hold", invoiceId: invoice.invoiceId, invoiceNumber: number,
        cardId: null, reasons: sorted(["multiple_cards_name_this_invoice"]) }));
      continue;
    }

    const pending: Pending = Object.freeze({ invoiceId: invoice.invoiceId, invoiceNumber: number,
      balance: want.balance, overdue: want.stage === STAGE_OVERDUE });

    if (matches.length === 1 && invoiceNumbersInCardName(matches[0].name).length > 1) {
      // Its only match names other invoices too, so the card is not this
      // invoice's - it is theirs together. Decided below, once every invoice
      // sharing that card has been seen.
      if (want.stage === STAGE_PAID) {
        actions.push(Object.freeze({ state: "skip", invoiceId: invoice.invoiceId, invoiceNumber: number,
          reasons: sorted(["paid_invoice_is_covered_by_a_shared_card_and_needs_no_move"]) }));
        continue;
      }
      const card = matches[0];
      shared.set(card.id, [...(shared.get(card.id) ?? []), pending]);
      continue;
    }

    if (!matches.length) {
      // A settled invoice with no card needs none: the board is for money owed.
      if (want.stage === STAGE_PAID) {
        actions.push(Object.freeze({ state: "skip", invoiceId: invoice.invoiceId, invoiceNumber: number,
          reasons: sorted(["paid_invoice_needs_no_card"]) }));
        continue;
      }
      if (!text(input.contactId)) { hold("no_single_contact_resolved"); continue; }
      if (!text(input.label)) { hold("card_label_missing"); continue; }
      // Whether this becomes a new card or a share of one the customer already
      // has depends on their other cards, which is decided after the loop.
      orphans.push(pending);
      continue;
    }

    const card = matches[0];
    const stageNow = card.stageName ?? null;
    if (stageNow && PROTECTED_STAGES.some(s => s.toLowerCase() === stageNow.toLowerCase())) {
      actions.push(Object.freeze({ state: "hold", invoiceId: invoice.invoiceId, invoiceNumber: number,
        cardId: card.id, reasons: sorted(["card_is_in_a_protected_stage"]) }));
      continue;
    }
    if ((card.status ?? "").toLowerCase() !== "open") {
      actions.push(Object.freeze({ state: "hold", invoiceId: invoice.invoiceId, invoiceNumber: number,
        cardId: card.id, reasons: sorted(["card_is_not_open_and_is_never_reopened"]) }));
      continue;
    }

    // The gate: an Overdue move can enrol this customer in the legacy workflow.
    const ownerHeld = want.stage === STAGE_OVERDUE && overdueMoveIsHeldByOwner(input.label, [number]);
    const withheld = want.stage === STAGE_OVERDUE && (!gateOpen || ownerHeld);
    const stage = withheld ? (stageNow ?? STAGE_SENT) : want.stage;
    const changes: ("stage" | "value")[] = [];
    if (stage !== stageNow) changes.push("stage");
    if (card.monetaryValue !== want.balance) changes.push("value");
    // This card is now this one invoice's. It can never also be the card a
    // different invoice of the same customer shares.
    directlyOwned.add(card.id);
    actions.push(Object.freeze({
      state: "adopt", invoiceId: invoice.invoiceId, invoiceNumber: number, cardId: card.id,
      desiredStage: want.stage, stage, monetaryValue: want.balance,
      changes: Object.freeze(changes),
      reasons: sorted([
        ...(withheld && !gateOpen ? ["overdue_move_withheld_until_legacy_workflow_sending_is_off"] : []),
        ...(ownerHeld ? ["overdue_move_held_by_owner_instruction"] : []),
      ]),
    }));
  }

  // ---- The combined cards, now that every invoice has been seen. ----------
  //
  // `balance` is summed in cents and converted back once, so a total is never
  // the sum of floats. An unusable sum is a hold, never a rounded guess.
  const total = (group: readonly Pending[]): number | null => {
    let sum = 0;
    for (const p of group) {
      const c = cents(p.balance);
      if (c === null) return null;
      sum += c;
    }
    return Number.isSafeInteger(sum) ? sum / 100 : null;
  };
  const holdGroup = (group: readonly Pending[], cardId: string | null, reason: string): void => {
    for (const p of group) {
      actions.push(Object.freeze({ state: "hold", invoiceId: p.invoiceId, invoiceNumber: p.invoiceNumber,
        cardId, reasons: sorted([reason]) }));
    }
  };
  /**
   * Emit one `combine` for one card and the invoices it is to stand for.
   *
   * The Overdue gate applies exactly as it does to a single invoice's card:
   * moving INTO Overdue is the stage change the legacy workflow sends on, so it
   * is withheld until the caller can prove that workflow cannot send.
   */
  const combine = (cardId: string, group: readonly Pending[], extraReasons: readonly string[] = []): void => {
    const card = input.cards.find(c => c.id === cardId);
    if (!card) { holdGroup(group, cardId, "shared_card_vanished_from_this_contacts_cards"); return; }
    const stageNow = card.stageName ?? null;
    if (stageNow && PROTECTED_STAGES.some(s => s.toLowerCase() === stageNow.toLowerCase())) {
      holdGroup(group, cardId, "shared_card_is_in_a_protected_stage"); return;
    }
    if ((card.status ?? "").toLowerCase() !== "open") {
      holdGroup(group, cardId, "shared_card_is_not_open_and_is_never_reopened"); return;
    }
    const sum = total(group);
    // Every invoice here is unpaid with a positive balance, so a zero or
    // unusable total means the arithmetic itself failed.
    if (sum === null || sum <= 0) { holdGroup(group, cardId, "shared_card_total_unusable"); return; }
    const desired = group.some(p => p.overdue) ? STAGE_OVERDUE : STAGE_SENT;
    const ownerHeld = desired === STAGE_OVERDUE
      && overdueMoveIsHeldByOwner(input.label, group.map(p => p.invoiceNumber));
    const withheld = desired === STAGE_OVERDUE && (!gateOpen || ownerHeld);
    const stage = withheld ? (stageNow ?? STAGE_SENT) : desired;
    const changes: ("stage" | "value")[] = [];
    if (stage !== stageNow) changes.push("stage");
    if (card.monetaryValue !== sum) changes.push("value");
    claimed.add(cardId);
    actions.push(Object.freeze({
      state: "combine", cardId,
      invoiceIds: Object.freeze([...group].map(p => p.invoiceId).sort()),
      invoiceNumbers: Object.freeze([...group].map(p => p.invoiceNumber).sort()),
      desiredStage: desired, stage, monetaryValue: sum,
      changes: Object.freeze(changes),
      reasons: sorted([...extraReasons,
        ...(withheld && !gateOpen ? ["overdue_move_withheld_until_legacy_workflow_sending_is_off"] : []),
        ...(ownerHeld ? ["overdue_move_held_by_owner_instruction"] : [])]),
    }));
  };

  // A card that enumerates its invoices covers exactly those, so every number
  // it names must be one this plan could read and act on. If it names an
  // invoice we cannot see - out of the window, missing from the snapshot - the
  // total would silently leave that money out, so the card is left alone.
  for (const [cardId, group] of shared) {
    const card = input.cards.find(c => c.id === cardId);
    const named = invoiceNumbersInCardName(card?.name);
    const covered = new Set(group.map(p => p.invoiceNumber));
    // Numbers on the card that are settled: already paid, so they are rightly
    // absent from the total but are still accounted for.
    const settled = new Set<string>();
    for (const a of actions) {
      if (a.state === "skip" && a.invoiceNumber
          && a.reasons.includes("paid_invoice_is_covered_by_a_shared_card_and_needs_no_move")) settled.add(a.invoiceNumber);
    }
    const unaccounted = named.filter(n => !covered.has(n) && !settled.has(n));
    if (unaccounted.length) {
      holdGroup(group, cardId, "shared_card_names_an_invoice_this_plan_cannot_account_for"); continue;
    }
    if (unreadableInvoice) { holdGroup(group, cardId, "another_invoice_for_this_customer_could_not_be_read"); continue; }
    combine(cardId, group, ["card_names_these_invoices_together_so_it_is_adopted_for_all_of_them"]);
  }

  // An invoice with no card of its own gets a new card only if the customer has
  // none at all; GoHighLevel refuses a second one. Otherwise it shares the
  // customer's one card that names no invoice, and if there is no such card it
  // is held - attempting a creation that cannot succeed is worse than saying so.
  if (orphans.length) {
    const sharable = input.cards.filter(c => !directlyOwned.has(c.id) && !invoiceNumbersInCardName(c.name).length
      && (c.status ?? "").toLowerCase() === "open"
      && !(c.stageName && PROTECTED_STAGES.some(s => s.toLowerCase() === c.stageName!.toLowerCase())));
    if (!input.cards.length) {
      for (const p of orphans) {
        actions.push(Object.freeze({
          state: "create", invoiceId: p.invoiceId, invoiceNumber: p.invoiceNumber,
          desiredStage: p.overdue ? STAGE_OVERDUE : STAGE_SENT, stage: STAGE_SENT, monetaryValue: p.balance,
          // The historical format, restored exactly. This sync created one card
          // per invoice named `Invoice #<number> — <client>` from 2026-06-19
          // until commit d235ff5 removed creation on 2026-11-06, and 39 of those
          // cards are still on the board. Matching that spelling means a new card
          // is indistinguishable from them, the next run's matcher finds it, and
          // nobody has to learn a second convention.
          name: invoiceCardName(p.invoiceNumber, input.label),
          reasons: sorted(p.overdue ? ["created_in_sent_not_overdue_to_avoid_legacy_enrollment"] : []),
        }));
      }
    } else if (unreadableInvoice) {
      holdGroup(orphans, null, "another_invoice_for_this_customer_could_not_be_read");
    } else if (sharable.length === 1) {
      combine(sharable[0].id, orphans, ["card_names_no_invoice_so_it_is_adopted_for_everything_this_customer_owes"]);
    } else if (sharable.length > 1) {
      holdGroup(orphans, null, "several_cards_could_stand_for_this_customers_invoices");
    } else {
      holdGroup(orphans, null, "contact_already_has_a_card_so_no_second_card_can_be_created");
    }
  }

  const untouched = input.cards.filter(card => !claimed.has(card.id)).map(card => {
    const numbers = invoiceNumbersInCardName(card.name);
    const reason = numbers.length ? "card_names_an_invoice_we_cannot_see"
      : PER_CUSTOMER.test(card.name ?? "") ? "legacy_per_customer_card_needs_retiring"
      : "card_is_not_tied_to_an_invoice";
    return Object.freeze({ cardId: card.id, reason });
  });

  const count = (state: string) => actions.filter(a => a.state === state).length;
  return Object.freeze({
    actions: Object.freeze(actions),
    untouched: Object.freeze(untouched),
    summary: Object.freeze({
      adopt: count("adopt"), combine: count("combine"), create: count("create"), hold: count("hold"),
      skip: count("skip"), untouched: untouched.length,
    }),
  });
}
