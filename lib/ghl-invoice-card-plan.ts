/**
 * ONE CARD PER INVOICE.
 *
 * Chosen by the account owner on 2026-11-20, after measuring what the Invoice
 * Pipeline actually contains: 316 cards in three different shapes, written by
 * three different things that disagree about what a card even is.
 *
 *   169  "<name> - N overdue/unpaid invoice(s)"   our sync, one per CUSTOMER
 *   108  a bare customer name                     placed by hand
 *    39  "... #7226 ..."                          Zapier, one per INVOICE
 *
 * The per-invoice grain is the correct one, and Zapier had it right. The whole
 * reminder ladder is per invoice - day 10, 15, 20, 21, 25, 30, 35 past due on
 * THAT invoice - and one card for a customer can never say "invoice A is at day
 * 15 and invoice B is at day 3". That mismatch is why the text ladder's
 * eligibility check ("is this customer's card in the Overdue stage?") fitted so
 * badly and held 28 of 42 invoices.
 *
 * ONE WRITER, AND IT HAS TO BE THIS ONE. Zapier created those 39 cards between
 * July and November and then never moved them: 38 of 39 still sit in "Invoice
 * Sent", and 26 of them show money that has since been paid. An event-driven
 * Zap cannot recover from a missed event. This runs on a clock, re-reads Jobber
 * live every time, and therefore catches up on its own.
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
  | Readonly<{ state: "hold"; invoiceId: string; invoiceNumber: string | null; cardId: string | null; reasons: readonly string[] }>
  | Readonly<{ state: "skip"; invoiceId: string; invoiceNumber: string | null; reasons: readonly string[] }>;

export type InvoiceCardPlan = Readonly<{
  actions: readonly InvoiceCardAction[];
  /** Cards this plan deliberately leaves exactly as they are. */
  untouched: readonly Readonly<{ cardId: string; reason: string }>[];
  summary: Readonly<{ adopt: number; create: number; hold: number; skip: number; untouched: number }>;
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
  invoice: InvoiceFact, clock: { daysPastDue: number; isOverdue: boolean; sentOn: string } | null
): { stage: string; balance: number } | { stage: null; reason: string } {
  const total = cents(invoice.totalDollars);
  const balance = cents(invoice.balanceDollars);
  if (total === null || balance === null) return { stage: null, reason: "invoice_amounts_unusable" };
  if (balance > total) return { stage: null, reason: "balance_exceeds_total" };
  const status = invoice.status?.toLowerCase() ?? null;
  if (status === "paid" && balance === 0) return { stage: STAGE_PAID, balance: 0 };
  if (!clock) return { stage: null, reason: "invoice_dates_unusable" };
  if (clock.sentOn < COLLECTIONS_CUTOFF) return { stage: null, reason: "before_collections_cutoff" };
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
    summary: Object.freeze({ adopt: 0, create: 0, hold: 0, skip: 0, untouched: 0 }),
  });
  if (!input || typeof input !== "object" || !Array.isArray(input.invoices) || !Array.isArray(input.cards)) return empty;

  const now = input.now ?? new Date();
  const gateOpen = legacySendingIsOff(input.legacySending, input.legacyWorkflowId, now);
  const actions: InvoiceCardAction[] = [];
  const claimed = new Set<string>();

  // A number that appears on two different invoices cannot identify a card.
  const numberCounts = new Map<string, number>();
  for (const inv of input.invoices) {
    if (text(inv.invoiceNumber)) numberCounts.set(inv.invoiceNumber.trim(), (numberCounts.get(inv.invoiceNumber.trim()) ?? 0) + 1);
  }

  for (const invoice of input.invoices) {
    const number = text(invoice.invoiceNumber) ? invoice.invoiceNumber.trim() : null;
    const hold = (...reasons: string[]): void => {
      actions.push(Object.freeze({ state: "hold", invoiceId: invoice.invoiceId, invoiceNumber: number, cardId: null, reasons: sorted(reasons) }));
    };
    if (!text(invoice.invoiceId)) { hold("invoice_id_missing"); continue; }
    if (!number) { hold("invoice_number_missing"); continue; }
    if ((numberCounts.get(number) ?? 0) > 1) { hold("invoice_number_is_not_unique"); continue; }

    const want = desiredStageForInvoice(invoice, input.clocks?.[invoice.invoiceId] ?? null);
    const matches = input.cards.filter(card => invoiceNumbersInCardName(card.name).includes(number));
    for (const card of matches) claimed.add(card.id);

    if (want.stage === null) {
      // Out of scope is not a fault; everything else is.
      if (want.reason === "before_collections_cutoff" || want.reason === "zero_total_invoice") {
        actions.push(Object.freeze({ state: "skip", invoiceId: invoice.invoiceId, invoiceNumber: number, reasons: sorted([want.reason]) }));
      } else hold(want.reason);
      continue;
    }

    if (matches.length > 1) {
      actions.push(Object.freeze({ state: "hold", invoiceId: invoice.invoiceId, invoiceNumber: number,
        cardId: null, reasons: sorted(["multiple_cards_name_this_invoice"]) }));
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
      const overdue = want.stage === STAGE_OVERDUE;
      actions.push(Object.freeze({
        state: "create", invoiceId: invoice.invoiceId, invoiceNumber: number,
        desiredStage: want.stage, stage: STAGE_SENT, monetaryValue: want.balance,
        name: `${input.label.trim()} - invoice #${number}`,
        reasons: sorted(overdue ? ["created_in_sent_not_overdue_to_avoid_legacy_enrollment"] : []),
      }));
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
    const withheld = want.stage === STAGE_OVERDUE && !gateOpen;
    const stage = withheld ? (stageNow ?? STAGE_SENT) : want.stage;
    const changes: ("stage" | "value")[] = [];
    if (stage !== stageNow) changes.push("stage");
    if (card.monetaryValue !== want.balance) changes.push("value");
    actions.push(Object.freeze({
      state: "adopt", invoiceId: invoice.invoiceId, invoiceNumber: number, cardId: card.id,
      desiredStage: want.stage, stage, monetaryValue: want.balance,
      changes: Object.freeze(changes),
      reasons: sorted(withheld ? ["overdue_move_withheld_until_legacy_workflow_sending_is_off"] : []),
    }));
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
      adopt: count("adopt"), create: count("create"), hold: count("hold"),
      skip: count("skip"), untouched: untouched.length,
    }),
  });
}
