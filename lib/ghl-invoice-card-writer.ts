/**
 * THE PER-INVOICE WRITER, WITH "INVOICE OVERDUE" LOCKED OFF.
 *
 * `lib/ghl-invoice-card-plan.ts` decides what every invoice's card should be.
 * This module is the only thing that carries those decisions into GoHighLevel,
 * and it is deliberately able to do less than the plan can describe.
 *
 * WHAT IT CAN DO
 *   - create a missing card, always in "Invoice Sent", named exactly
 *     `Invoice #<number> — <client>` as this sync has named them since June
 *   - move a card to "Invoice Paid" once Jobber says the invoice is settled
 *   - correct a card's amount to the invoice's real outstanding balance
 *
 * WHAT IT CANNOT DO, AND WHY
 *   - It cannot move a card into "Invoice Overdue". Not "will not unless" -
 *     cannot. `OVERDUE_WRITES_LOCKED` is a constant, there is no environment
 *     variable for it, and `decideInvoiceCardWrite` refuses an Overdue target
 *     even when the plan's own legacy-sending gate has been opened with valid
 *     evidence. Two independent locks, because the consequence of getting this
 *     wrong is a real text message to a real customer about a months-old
 *     invoice, and a text cannot be unsent. The legacy "Fixed Automation"
 *     workflow triggers on a pipeline-stage change (`exactOpportunityTrigger`),
 *     so the Overdue move IS the send. Removing this lock is a code change, made
 *     deliberately, after that workflow's sending is off.
 *   - It cannot rename a card. An `adopt` action carries no name, the PUT omits
 *     the name field, and the durable record has `updateName: false`. A card
 *     named `Invoice #7226` IS invoice 7226's card; its name is the only link
 *     between the two and overwriting it would destroy the link.
 *   - It cannot touch the 169 per-customer or 108 bare-name cards. They are not
 *     in any action, and retiring them is the owner's decision, not a side
 *     effect of this.
 *   - It cannot reopen a closed card, write into a protected stage, or act on a
 *     card whose name does not name exactly one invoice it can see.
 *
 * ON "INVOICE PAID", WHICH IS THE ONE PLACE THIS REASONS RATHER THAN CITES.
 * `sentTransitionCannotSendOrEnroll: true` is a recorded, operator-verified fact
 * about the live workflow (see ghl-existing-overdue-bootstrap.ts). There is NO
 * equivalent recorded fact for Paid, so the Paid exit rests on two structural
 * guards instead: the workflow's first branch is `Lead value > 1` with
 * "Remove from Workflow" on the other side, and a Paid card is written with a
 * balance of exactly 0 - enforced here, not assumed - so it fails that branch
 * immediately; and every later branch re-checks the pipeline stage, which a
 * paid invoice never leaves. `GHL_PER_INVOICE_PAID_EXITS_ENABLED=false` turns
 * Paid writes off without a deploy if the workflow's two trigger stages turn
 * out to include it.
 *
 * EVERY WRITE IS CLAIMED BEFORE IT IS ATTEMPTED and confirmed only after the
 * provider is read back. An unconfirmed write blocks this writer, and the
 * pending claim blocks every future run until someone looks - including a
 * creation, which is claimed against the INVOICE, because a card that may or
 * may not have been POSTed has no id to claim against.
 */
import { createOpportunity, listContactOpportunities, moveOpportunityToStage, readOpportunity,
  type GhlOpportunity } from "./ghl";
import { buildGhlWriteIntent, buildInvoiceSourceEvidence } from "./ghl-write-intent";
import { moneyCents, type PhoneInvoiceEvidence } from "./ghl-phone-state";
import { cardNameHash, creationPlaceholderId, invoiceSourceFingerprint,
  type CycleJournalEntry, type GhlWriteIntent, type SyncRunWriter } from "./sync-writer-control";
import { invoiceNumbersInCardName, STAGE_PAID, STAGE_SENT, type ExistingCard,
  type InvoiceCardAction, type InvoiceCardPlan } from "./ghl-invoice-card-plan";

/**
 * Not configurable, on purpose. See the module header: the only way to allow an
 * Overdue write is to edit this file, which is a decision with a commit behind
 * it rather than a variable someone sets at 6pm.
 */
export const OVERDUE_WRITES_LOCKED = true as const;

/** A sane ceiling on how much one run may change, whatever the environment says. */
export const MAX_WRITE_BUDGET = 120;
export const DEFAULT_WRITE_BUDGET = 60;

export type StageIds = Readonly<{ sent: string; overdue: string; paid: string }>;

/** Every invoice any past run has already claimed a card for, in this pipeline. */
export function claimedInvoiceIdsFromHistory(history: readonly CycleJournalEntry[],
  scope: { locationId: string; pipelineId: string }): Set<string> {
  const out = new Set<string>();
  for (const entry of history) {
    const c = entry.intent.creation;
    if (c && c.locationId === scope.locationId && c.pipelineId === scope.pipelineId) out.add(c.invoiceId);
  }
  return out;
}

export type WriteDecision =
  | Readonly<{ state: "write"; kind: "adopt"; role: "sent" | "paid"; cardId: string;
      stageId: string; monetaryValue: number; invoiceId: string; invoiceNumber: string }>
  | Readonly<{ state: "write"; kind: "create"; role: "sent"; stageId: string; name: string;
      monetaryValue: number; invoiceId: string; invoiceNumber: string }>
  | Readonly<{ state: "nothing"; reason: string }>
  | Readonly<{ state: "refuse"; reason: string }>;

/**
 * Whether one planned action is something this writer may carry out, and if so
 * exactly what it will send. Pure: no environment, no clock, no I/O.
 */
export function decideInvoiceCardWrite(action: InvoiceCardAction, stageIds: StageIds): WriteDecision {
  if (!action || (action.state !== "adopt" && action.state !== "create")) {
    return Object.freeze({ state: "nothing", reason: "action_is_not_a_write" });
  }
  const amount = moneyCents(action.monetaryValue);
  if (amount === null) return Object.freeze({ state: "refuse", reason: "monetary_value_unusable" });

  // The lock. Checked against the stage this plan would ACTUALLY write, and
  // again below against the resolved stage id, so neither a renamed stage nor a
  // reordered pipeline can smuggle an Overdue write through.
  if (action.stage !== STAGE_SENT && action.stage !== STAGE_PAID) {
    return Object.freeze({ state: "refuse",
      reason: OVERDUE_WRITES_LOCKED && action.stage === "Invoice Overdue"
        ? "overdue_writes_are_locked_off_in_this_build" : "target_stage_is_not_writable" });
  }
  const role = action.stage === STAGE_PAID ? "paid" as const : "sent" as const;
  const stageId = role === "paid" ? stageIds.paid : stageIds.sent;
  if (!stageId || stageId === stageIds.overdue) {
    return Object.freeze({ state: "refuse", reason: "stage_id_unresolved_or_is_the_overdue_stage" });
  }
  // A Paid card carries nothing. This is a guard, not a formality: it is half
  // the reason a Paid write cannot reach the legacy ladder's first branch.
  if (role === "paid" && amount !== 0) {
    return Object.freeze({ state: "refuse", reason: "paid_card_must_carry_a_zero_balance" });
  }

  if (action.state === "create") {
    if (action.stage !== STAGE_SENT) return Object.freeze({ state: "refuse", reason: "new_cards_are_only_ever_created_in_sent" });
    if (amount <= 0) return Object.freeze({ state: "refuse", reason: "no_card_is_created_for_a_zero_balance" });
    if (!action.name?.trim()) return Object.freeze({ state: "refuse", reason: "card_name_missing" });
    return Object.freeze({ state: "write", kind: "create", role: "sent", stageId, name: action.name,
      monetaryValue: action.monetaryValue, invoiceId: action.invoiceId, invoiceNumber: action.invoiceNumber });
  }
  if (!action.changes.length) return Object.freeze({ state: "nothing", reason: "card_already_matches_the_invoice" });
  if (!action.cardId?.trim()) return Object.freeze({ state: "refuse", reason: "card_id_missing" });
  return Object.freeze({ state: "write", kind: "adopt", role, cardId: action.cardId, stageId,
    monetaryValue: action.monetaryValue, invoiceId: action.invoiceId, invoiceNumber: action.invoiceNumber });
}

export type InvoiceCardWriteGate =
  | Readonly<{ open: true; approvalId: string; budget: number; paidExits: boolean }>
  | Readonly<{ open: false; reason: string }>;

/**
 * May this process write cards at all? A separate switch from
 * `GHL_INVOICE_WRITE_MODE` on purpose: turning the per-customer sync to `sync`
 * must not turn this on, and turning this on must not turn that on.
 */
export function invoiceCardWriteGate(env: Record<string, string | undefined> = process.env): InvoiceCardWriteGate {
  if (env.GHL_PER_INVOICE_CARD_WRITES_ENABLED !== "true") return Object.freeze({ open: false, reason: "per_invoice_card_writes_not_enabled" });
  const approvalId = env.GHL_WRITE_APPROVAL_ID;
  if (!approvalId || !/^[A-Za-z0-9._:-]{1,128}$/.test(approvalId)) return Object.freeze({ open: false, reason: "write_approval_id_missing_or_malformed" });
  if (!env.GHL_LOCATION_ID?.trim()) return Object.freeze({ open: false, reason: "location_id_missing" });
  const raw = env.GHL_PER_INVOICE_CARD_WRITE_BUDGET;
  let budget = DEFAULT_WRITE_BUDGET;
  if (raw !== undefined && raw !== "") {
    // A malformed budget is a refusal, never a fallback to the default: someone
    // meant to bound this run and the number they wrote did not parse.
    if (!/^\d{1,3}$/.test(raw)) return Object.freeze({ open: false, reason: "write_budget_malformed" });
    budget = Number(raw);
    if (budget < 1 || budget > MAX_WRITE_BUDGET) return Object.freeze({ open: false, reason: "write_budget_out_of_range" });
  }
  return Object.freeze({ open: true, approvalId, budget,
    paidExits: env.GHL_PER_INVOICE_PAID_EXITS_ENABLED !== "false" });
}

export interface InvoiceCardWriteReport {
  invoiceId: string;
  invoiceNumber: string | null;
  cardId: string | null;
  kind: "adopt" | "create";
  action: "applied" | "unchanged" | "hold" | "failed";
  reason: string;
  to?: { stageId: string; monetaryValue: number; name?: string };
}

type Writer = Pick<SyncRunWriter, "prepare" | "assertPending" | "confirm" | "block"> &
  { readCycleHistory: SyncRunWriter["readCycleHistory"] };

export interface InvoiceCardWriteIo {
  readOpportunity: typeof readOpportunity;
  listContactOpportunities: typeof listContactOpportunities;
  moveOpportunityToStage: typeof moveOpportunityToStage;
  createOpportunity: typeof createOpportunity;
}

const defaultIo: InvoiceCardWriteIo = { readOpportunity, listContactOpportunities, moveOpportunityToStage, createOpportunity };

export interface ApplyInvoiceCardPlanInput {
  plan: InvoiceCardPlan;
  contactId: string;
  jobberClientId: string;
  pipelineId: string;
  locationId: string;
  stageIds: StageIds;
  gate: Extract<InvoiceCardWriteGate, { open: true }>;
  /** The same verified Jobber snapshot the plan was computed from. */
  source: PhoneInvoiceEvidence[];
  observedAt: string;
  /** What each card looked like when the plan was made, by card id. */
  preflight: ReadonlyMap<string, ExistingCard>;
  /** Shared across every customer in the run, so the budget bounds the RUN. */
  spend: { remaining: number };
  /**
   * Invoice ids whose card is already claimed - seeded from the durable journal
   * of every past run via `claimedInvoiceIdsFromHistory`, and added to as this
   * run claims more. A fast pre-check only: the binding guarantee is
   * `assertCreationHistory` inside `prepare`, which reads the journal again in
   * the same transaction that records the claim.
   */
  claimedInvoiceIds: Set<string>;
  writer: Writer;
  report: (entry: InvoiceCardWriteReport) => void;
  io?: InvoiceCardWriteIo;
}

/**
 * Carry out one customer's plan. Returns how many writes were applied and
 * whether the writer is now halted; a halted writer must not be used again this
 * run, by this customer or any other.
 */
export async function applyInvoiceCardPlan(input: ApplyInvoiceCardPlanInput): Promise<{ applied: number; halted: boolean }> {
  const io = input.io ?? defaultIo;
  const { stageIds } = input;
  let applied = 0;
  const hold = (d: { invoiceId: string; invoiceNumber: string | null; cardId: string | null;
    kind: "adopt" | "create" }, reason: string) => input.report({ ...d, action: "hold", reason });

  for (const action of input.plan.actions) {
    if (action.state !== "adopt" && action.state !== "create") continue;
    const kind = action.state;
    const decision = decideInvoiceCardWrite(action, stageIds);
    const base = { invoiceId: action.invoiceId, invoiceNumber: action.invoiceNumber,
      cardId: action.state === "adopt" ? action.cardId : null, kind } as const;

    if (decision.state === "nothing") { input.report({ ...base, action: "unchanged", reason: decision.reason }); continue; }
    if (decision.state === "refuse") { hold(base, decision.reason); continue; }
    if (decision.role === "paid" && !input.gate.paidExits) { hold(base, "paid_exits_disabled_by_configuration"); continue; }
    if (input.spend.remaining <= 0) { hold(base, "run_write_budget_exhausted"); continue; }

    try {
      const outcome = decision.kind === "create"
        ? await createCard(input, io, decision)
        : await adoptCard(input, io, decision);
      if (outcome.state === "applied") { applied += 1; input.spend.remaining -= 1; }
      input.report({ ...base, cardId: outcome.cardId ?? base.cardId, action: outcome.state,
        reason: outcome.reason, ...(outcome.to ? { to: outcome.to } : {}) });
      if (outcome.state === "failed") return { applied, halted: true };
    } catch (err: any) {
      // Everything a card write can be expected to get wrong is handled inside
      // the helpers and comes back as a hold. An exception reaching here is
      // therefore unexplained, and an unexplained failure in a writer whose
      // claim may already be durable is a halt, not a skipped card.
      await input.writer.block();
      input.report({ ...base, action: "failed",
        reason: `Unexpected card write failure; remaining card writes halted. ${err?.message ?? err}` });
      return { applied, halted: true };
    }
  }
  return { applied, halted: false };
}

type Outcome = { state: "applied" | "unchanged" | "hold" | "failed"; reason: string;
  cardId?: string | null; to?: { stageId: string; monetaryValue: number; name?: string }; claimed: boolean };

/** Move an existing card. Never renames it, never reopens it. */
async function adoptCard(
  input: ApplyInvoiceCardPlanInput, io: InvoiceCardWriteIo,
  decision: Extract<WriteDecision, { kind: "adopt" }>
): Promise<Outcome> {
  const to = { stageId: decision.stageId, monetaryValue: decision.monetaryValue };
  const held = (reason: string): Outcome => ({ state: "hold", reason, cardId: decision.cardId, to, claimed: false });

  let current: GhlOpportunity;
  try {
    current = await io.readOpportunity(decision.cardId);
  } catch (err: any) {
    // Nothing has been claimed or sent, so this is one card held, not a halt.
    return held(`fresh_card_read_failed_${err?.message ?? err}`);
  }
  if (current.id !== decision.cardId || current.pipelineId !== input.pipelineId
      || current.contactId !== input.contactId || current.status !== "open") return held("card_ownership_or_status_changed_before_write");
  // Only the three stages this writer understands. Anything else is a protected
  // stage or a stage we have never seen, and either way it is not ours to move.
  if (![stageOf(input, "sent"), stageOf(input, "overdue"), stageOf(input, "paid")].includes(current.pipelineStageId ?? "")) {
    return held("card_is_in_a_protected_or_unknown_stage");
  }
  // The name is the link to the invoice. It must still name this invoice, and
  // only this invoice, or we would be moving a card about something else.
  const named = invoiceNumbersInCardName(current.name);
  if (named.length !== 1 || named[0] !== decision.invoiceNumber) return held("card_no_longer_names_exactly_this_invoice");

  const seen = input.preflight.get(decision.cardId);
  if (!seen) return held("card_was_not_in_the_preflight_snapshot");
  if ((current.monetaryValue ?? null) !== seen.monetaryValue || (current.name ?? null) !== seen.name
      || (current.status ?? null) !== seen.status) return held("card_changed_since_the_plan_was_made");

  if (current.pipelineStageId === decision.stageId && current.monetaryValue === decision.monetaryValue) {
    return { state: "unchanged", reason: "fresh_read_already_matches_the_target", cardId: decision.cardId, to, claimed: false };
  }

  const intent = buildGhlWriteIntent({ current, to, jobberClientId: input.jobberClientId,
    source: input.source, storedInvoiceIds: [decision.invoiceId], observedAt: input.observedAt });
  // `to` carries no `name`, so the durable record says updateName: false.
  if (!intent || intent.target.updateName || intent.target.nameHash !== cardNameHash(current.name)) {
    return held("card_or_source_evidence_unavailable_or_would_rename");
  }
  if (intent.approvalId !== input.gate.approvalId) return held("write_approval_changed_before_write");

  // `prepare` halts the writer itself on any failure, so a throw here is
  // already a halt and must be reported as one.
  let intentId: string;
  try {
    intentId = await input.writer.prepare(intent);
  } catch (err: any) {
    return { state: "failed", cardId: decision.cardId, to, claimed: true,
      reason: `Durable write claim refused; remaining card writes halted. ${err?.message ?? err}` };
  }
  try {
    await input.writer.assertPending(intentId);
    await io.moveOpportunityToStage(decision.cardId, decision.stageId, decision.monetaryValue);
    const accepted = await io.readOpportunity(decision.cardId);
    if (accepted.id !== decision.cardId || accepted.pipelineId !== current.pipelineId
        || accepted.contactId !== current.contactId || accepted.status !== "open"
        || accepted.pipelineStageId !== decision.stageId || accepted.monetaryValue !== decision.monetaryValue
        || (accepted.name ?? null) !== (current.name ?? null)) throw new Error("Post-write card state not confirmed");
    await input.writer.confirm(intentId);
  } catch (err: any) {
    await input.writer.block();
    return { state: "failed", cardId: decision.cardId, to, claimed: true,
      reason: `Write outcome unconfirmed; remaining card writes halted. ${err?.message ?? err}` };
  }
  return { state: "applied", cardId: decision.cardId, to, claimed: true,
    reason: decision.role === "paid" ? "Moved to Paid against verified Jobber settlement; card carries a zero balance"
      : "Stage and amount corrected from verified Jobber source; Overdue remains locked off" };
}

/** Create the card an invoice has never had. Always "Invoice Sent". */
async function createCard(
  input: ApplyInvoiceCardPlanInput, io: InvoiceCardWriteIo,
  decision: Extract<WriteDecision, { kind: "create" }>
): Promise<Outcome> {
  const to = { stageId: decision.stageId, monetaryValue: decision.monetaryValue, name: decision.name };
  const held = (reason: string): Outcome => ({ state: "hold", reason, cardId: null, to, claimed: false });
  if (decision.stageId !== stageOf(input, "sent")) return held("creation_target_is_not_the_sent_stage");

  // Has any run already claimed this invoice's card? A pending claim counts:
  // it means a POST was started and never answered.
  if (input.claimedInvoiceIds.has(decision.invoiceId)) return held("creation_already_claimed_for_this_invoice");

  // Fresh, complete, every-status read of this contact's cards. The preflight
  // snapshot is minutes old by now and a duplicate card is the one mistake here
  // that a customer can actually see.
  let live: GhlOpportunity[];
  try {
    live = await io.listContactOpportunities(input.contactId, input.pipelineId);
  } catch (err: any) {
    // Without a complete answer we cannot rule out a duplicate, and a duplicate
    // card is the one mistake a customer sees. Hold, do not create.
    return held(`contact_card_read_failed_${err?.message ?? err}`);
  }
  if (live.some(card => invoiceNumbersInCardName(card.name).includes(decision.invoiceNumber))) {
    return held("a_card_for_this_invoice_already_exists");
  }

  const invoices = buildInvoiceSourceEvidence(input.source, input.jobberClientId);
  const row = invoices?.find(i => i.id === decision.invoiceId);
  const amountCents = moneyCents(decision.monetaryValue);
  if (!invoices || !row || amountCents === null) return held("source_evidence_unavailable");
  if (row.invoiceStatus === "paid" || row.balanceCents <= 0) return held("invoice_is_no_longer_unpaid");
  if (row.balanceCents !== amountCents) return held("invoice_balance_changed_since_the_plan_was_made");

  const intent: GhlWriteIntent = {
    creation: { version: 1, stageRole: "sent", locationId: input.locationId, pipelineId: input.pipelineId,
      stageId: decision.stageId, contactId: input.contactId, jobberClientId: input.jobberClientId,
      invoiceId: decision.invoiceId, invoiceNumber: decision.invoiceNumber,
      nameHash: cardNameHash(decision.name), amountCents, sourceFingerprint: invoiceSourceFingerprint(row) },
    approvalId: input.gate.approvalId,
    pipelineId: input.pipelineId, contactId: input.contactId,
    opportunityId: creationPlaceholderId(decision.invoiceId), jobberClientId: input.jobberClientId,
    expected: { stageId: decision.stageId, status: "open", amountCents: 0, nameHash: cardNameHash(null) },
    target: { stageId: decision.stageId, amountCents, nameHash: cardNameHash(decision.name), updateName: true },
    source: { observedAt: input.observedAt, storedInvoiceIds: [decision.invoiceId], invoices },
  };

  let intentId: string;
  // Recorded BEFORE the claim is attempted. If `prepare` fails we do not know
  // whether it recorded anything, and the safe reading of "do not know" is
  // "claimed".
  input.claimedInvoiceIds.add(decision.invoiceId);
  try {
    intentId = await input.writer.prepare(intent);
  } catch (err: any) {
    // Nothing was POSTed, but `prepare` has halted the writer; say so plainly
    // rather than letting the next card try and fail the same way.
    return { state: "failed", cardId: null, to, claimed: true,
      reason: `Durable creation claim refused; remaining card writes halted. ${err?.message ?? err}` };
  }
  let created: GhlOpportunity | undefined;
  try {
    await input.writer.assertPending(intentId);
    created = await io.createOpportunity({ pipelineId: input.pipelineId, pipelineStageId: decision.stageId,
      contactId: input.contactId, name: decision.name, monetaryValue: decision.monetaryValue });
    if (!created?.id) throw new Error("GHL did not return the created card");
    const accepted = await io.readOpportunity(created.id);
    if (accepted.id !== created.id || accepted.pipelineId !== input.pipelineId
        || accepted.contactId !== input.contactId || accepted.status !== "open"
        || accepted.pipelineStageId !== decision.stageId || accepted.monetaryValue !== decision.monetaryValue
        || accepted.name !== decision.name) throw new Error("Created card state not confirmed");
    await input.writer.confirm(intentId);
  } catch (err: any) {
    await input.writer.block();
    return { state: "failed", cardId: created?.id ?? null, to, claimed: true,
      reason: `Creation outcome unconfirmed; remaining card writes halted. ${err?.message ?? err}` };
  }
  return { state: "applied", cardId: created.id, to, claimed: true,
    reason: "Card created in Invoice Sent against verified Jobber source; no Overdue move and no enrollment claimed" };
}

const stageOf = (input: ApplyInvoiceCardPlanInput, role: keyof StageIds) => input.stageIds[role];
