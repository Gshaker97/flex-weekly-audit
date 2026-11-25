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
 *   - It cannot move a card into "Invoice Overdue" until someone has written
 *     down that the legacy workflow's sending is off. The legacy "Fixed
 *     Automation" workflow triggers on a pipeline-stage change
 *     (`exactOpportunityTrigger`), so while it is live the Overdue move IS the
 *     send - to real customers, about invoices that are months old, and a text
 *     cannot be unsent. `legacySendingFromEnv` is the only way to say otherwise,
 *     it names the workflow and the day it was switched off, and with nothing
 *     set the answer is no. The owner is turning those automations off first and
 *     this is what lets that decision be recorded rather than assumed.
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
import { invoiceNumbersInCardName, legacySendingIsOff, STAGE_OVERDUE, STAGE_PAID, STAGE_SENT,
  type ExistingCard, type InvoiceCardAction, type InvoiceCardPlan,
  type LegacySendingEvidence } from "./ghl-invoice-card-plan";

/** What a caller may do beyond the safe default. Every field defaults to NO. */
export type WriteAllowances = Readonly<{
  overdueMoves: boolean;
  paidExits: boolean;
  /**
   * Retire a COMBINED card whose every named invoice is settled, to Paid at a
   * zero balance. Separate from `paidExits` on purpose: that one also starts
   * moving each single invoice's card as it is paid, which is a much larger
   * change to the board and not what was asked for on 2026-11-25.
   */
  combinedPaidExits: boolean;
}>;
const NOTHING_EXTRA: WriteAllowances = Object.freeze({
  overdueMoves: false, paidExits: false, combinedPaidExits: false });

/** A sane ceiling on how much one run may change, whatever the environment says. */
export const MAX_WRITE_BUDGET = 120;
export const DEFAULT_WRITE_BUDGET = 60;

export type StageIds = Readonly<{ sent: string; overdue: string; paid: string }>;

/**
 * Every invoice any past run has already claimed a card for, in this pipeline.
 *
 * An abandoned claim is skipped, for the same reason `invoiceCardCreationClaimed`
 * skips it: the provider was read back and the card provably is not there, so
 * the invoice still needs one. This is only the fast pre-check; the binding
 * version of the same rule lives in `assertCreationHistory`.
 */
export function claimedInvoiceIdsFromHistory(history: readonly CycleJournalEntry[],
  scope: { locationId: string; pipelineId: string }): Set<string> {
  const out = new Set<string>();
  for (const entry of history) {
    if (entry.state === "abandoned") continue;
    const c = entry.intent.creation;
    if (c && c.locationId === scope.locationId && c.pipelineId === scope.pipelineId) out.add(c.invoiceId);
  }
  return out;
}

/**
 * A hard ceiling on how long one claimed write may wait for GoHighLevel.
 *
 * `ghlFetch` already aborts a single stalled request after 10s, but a write is
 * a CHAIN of requests (the mutation, then the read-back), and a GET inside that
 * chain may legitimately sleep through three 429 backoffs. This bounds the
 * whole claimed window instead of each hop, so the gap between "claim recorded"
 * and "outcome known" can never grow without limit.
 */
export const WRITE_ATTEMPT_TIMEOUT_MS = 20_000;
/** The same, for the read that establishes what actually happened. */
export const WRITE_VERIFY_TIMEOUT_MS = 20_000;

/**
 * Bound a provider call. Rejecting the race does not cancel the underlying
 * request - `ghlFetch`'s own AbortController does that - it stops the WRITER
 * waiting on it, which is the thing that used to hang a run.
 */
export async function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_timed_out_after_${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type WriteDecision =
  | Readonly<{ state: "write"; kind: "adopt"; role: "sent" | "overdue" | "paid"; cardId: string;
      stageId: string; monetaryValue: number; invoiceId: string; invoiceNumber: string }>
  | Readonly<{ state: "write"; kind: "create"; role: "sent"; stageId: string; name: string;
      monetaryValue: number; invoiceId: string; invoiceNumber: string }>
  | Readonly<{ state: "write"; kind: "combine"; role: "sent" | "overdue" | "paid"; cardId: string;
      stageId: string; monetaryValue: number;
      invoiceIds: readonly string[]; invoiceNumbers: readonly string[] }>
  | Readonly<{ state: "nothing"; reason: string }>
  | Readonly<{ state: "refuse"; reason: string }>;

/**
 * Whether one planned action is something this writer may carry out, and if so
 * exactly what it will send. Pure: no environment, no clock, no I/O.
 */
export function decideInvoiceCardWrite(
  action: InvoiceCardAction, stageIds: StageIds, allow: WriteAllowances = NOTHING_EXTRA
): WriteDecision {
  if (!action || (action.state !== "adopt" && action.state !== "create" && action.state !== "combine")) {
    return Object.freeze({ state: "nothing", reason: "action_is_not_a_write" });
  }
  const amount = moneyCents(action.monetaryValue);
  if (amount === null) return Object.freeze({ state: "refuse", reason: "monetary_value_unusable" });

  // The gates, checked against the stage this plan would ACTUALLY write.
  if (action.stage !== STAGE_SENT && action.stage !== STAGE_PAID && action.stage !== STAGE_OVERDUE) {
    return Object.freeze({ state: "refuse", reason: "target_stage_is_not_writable" });
  }
  if (action.stage === STAGE_OVERDUE && !allow.overdueMoves) {
    return Object.freeze({ state: "refuse", reason: "overdue_move_needs_recorded_proof_the_legacy_workflow_is_off" });
  }
  // Phase one ignores settled invoices entirely, by the owner's instruction on
  // 2026-11-20: get the picture of what is OWED right first.
  // Retiring a combined card whose every named invoice is settled is its OWN
  // allowance, asked for on 2026-11-25. It is deliberately not folded into
  // `paidExits`: that switch would also start moving every single invoice's
  // card out of Sent as it is paid, which is a far larger change to the board
  // than the one that was asked for, and is still the owner's to make.
  if (action.stage === STAGE_PAID && !allow.paidExits
      && !(action.state === "combine" && allow.combinedPaidExits)) {
    return Object.freeze({ state: "refuse", reason: "paid_invoices_are_out_of_scope_for_now" });
  }
  const role = action.stage === STAGE_PAID ? "paid" as const
    : action.stage === STAGE_OVERDUE ? "overdue" as const : "sent" as const;
  const stageId = role === "paid" ? stageIds.paid : role === "overdue" ? stageIds.overdue : stageIds.sent;
  if (!stageId) return Object.freeze({ state: "refuse", reason: "stage_id_unresolved" });
  // A pipeline whose stages share an id cannot be reasoned about at all.
  if (new Set([stageIds.sent, stageIds.overdue, stageIds.paid]).size !== 3) {
    return Object.freeze({ state: "refuse", reason: "pipeline_stage_ids_are_not_distinct" });
  }
  if (role !== "overdue" && stageId === stageIds.overdue) {
    return Object.freeze({ state: "refuse", reason: "resolved_stage_is_unexpectedly_the_overdue_stage" });
  }
  // A Paid card carries nothing. This is a guard, not a formality: it is half
  // the reason a Paid write cannot reach the legacy ladder's first branch.
  if (role === "paid" && amount !== 0) {
    return Object.freeze({ state: "refuse", reason: "paid_card_must_carry_a_zero_balance" });
  }

  if (action.state === "combine") {
    // A combined card MAY be retired to Paid, but only as a retirement: a zero
    // balance (enforced above) and - checked in `combineCard` against its own
    // fresh read - a name that enumerates exactly the invoices being written,
    // which is the only thing that can establish that nothing else is owed on
    // it. A card naming no invoice can never pass that check, so the amount on
    // a card standing for "whatever this customer owes" is never zeroed.
    if (role === "paid" && !allow.combinedPaidExits) {
      return Object.freeze({ state: "refuse", reason: "retiring_a_paid_combined_card_is_not_switched_on" });
    }
    if (role !== "paid" && amount <= 0) {
      return Object.freeze({ state: "refuse", reason: "a_combined_card_must_carry_what_is_still_owed" });
    }
    if (!action.invoiceIds.length || action.invoiceIds.length !== action.invoiceNumbers.length) {
      return Object.freeze({ state: "refuse", reason: "combined_card_invoice_set_unusable" });
    }
    if (new Set(action.invoiceIds).size !== action.invoiceIds.length
        || new Set(action.invoiceNumbers).size !== action.invoiceNumbers.length
        || !action.invoiceIds.every(id => typeof id === "string" && id.trim())
        || !action.invoiceNumbers.every(n => typeof n === "string" && n.trim())) {
      return Object.freeze({ state: "refuse", reason: "combined_card_invoice_set_unusable" });
    }
    if (!action.changes.length) return Object.freeze({ state: "nothing", reason: "card_already_matches_these_invoices" });
    if (!action.cardId?.trim()) return Object.freeze({ state: "refuse", reason: "card_id_missing" });
    return Object.freeze({ state: "write", kind: "combine", role, cardId: action.cardId, stageId,
      monetaryValue: action.monetaryValue,
      invoiceIds: Object.freeze([...action.invoiceIds]), invoiceNumbers: Object.freeze([...action.invoiceNumbers]) });
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
  | Readonly<{ open: true; approvalId: string; budget: number; allow: WriteAllowances }>
  | Readonly<{ open: false; reason: string }>;

/**
 * The owner's recorded statement that the legacy workflow can no longer send,
 * read from the environment rather than hardcoded, so it carries WHICH workflow
 * and WHEN - and so withdrawing it is one variable, not a deploy.
 *
 *   GHL_LEGACY_INVOICE_WORKFLOW_ID  the workflow that was switched off
 *   GHL_LEGACY_SENDING_DISABLED     "YYYY-MM-DD|how we know"
 *
 * Returns null unless both are present and well formed, and null means no
 * Overdue move happens. There is no default, no inference from an empty value,
 * and no "it was probably off" - the whole point is that somebody looked.
 */
export function legacySendingFromEnv(
  env: Record<string, string | undefined> = process.env,
  /**
   * The run's own clock reading, threaded in BY THE CALLER.
   *
   * It must be the same `Date` the gate will check this evidence against.
   * `legacySendingIsOff` rejects evidence observed after its `now` - a check
   * from the future is a clock problem - and a caller that captures `now`,
   * does a sync's worth of work, and only then reads the environment would
   * otherwise stamp `observedAt` minutes LATER than that `now`. The evidence
   * would be refused on every run, and the Overdue move withheld silently.
   * `lib/sync.ts` is exactly that caller.
   */
  now: Date = new Date(),
): LegacySendingEvidence | null {
  const workflowId = env.GHL_LEGACY_INVOICE_WORKFLOW_ID?.trim();
  const raw = env.GHL_LEGACY_SENDING_DISABLED?.trim();
  if (!workflowId || !raw) return null;
  const [disabledOn, ...rest] = raw.split("|");
  const evidenceRef = rest.join("|").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(disabledOn?.trim() ?? "") || !evidenceRef) return null;
  const day = disabledOn.trim();
  // A date that is not a real day, or is in the future, is a mistake not a fact.
  const parsed = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) return null;
  if (parsed.getTime() > now.getTime()) return null;
  return Object.freeze({ source: "operator-confirmed-workflow-sending-disabled",
    workflowId, disabledOn: day, observedAt: now.toISOString(), evidenceRef });
}

/**
 * May this process write cards at all? A separate switch from
 * `GHL_INVOICE_WRITE_MODE` on purpose: turning the per-customer sync to `sync`
 * must not turn this on, and turning this on must not turn that on.
 */
export function invoiceCardWriteGate(
  env: Record<string, string | undefined> = process.env,
  /** One clock reading for the whole decision; see `legacySendingFromEnv`. */
  now: Date = new Date(),
): InvoiceCardWriteGate {
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
  // Every allowance is OFF unless something explicitly says otherwise. Paid is
  // opt-in because phase one deliberately ignores settled invoices; Overdue is
  // opt-in because it is the stage change the legacy workflow sends on; and
  // retiring a settled combined card is its own switch so that it can be turned
  // on - as it was on 2026-11-25 - without turning on the other.
  return Object.freeze({ open: true, approvalId, budget, allow: Object.freeze({
    overdueMoves: legacySendingIsOff(
      legacySendingFromEnv(env, now), env.GHL_LEGACY_INVOICE_WORKFLOW_ID?.trim() ?? "", now),
    paidExits: env.GHL_PER_INVOICE_PAID_EXITS_ENABLED === "true",
    // `paidExits` implies it: a caller allowed to move any paid invoice's card
    // is certainly allowed to retire a card whose invoices are all paid.
    combinedPaidExits: env.GHL_PER_INVOICE_PAID_EXITS_ENABLED === "true"
      || env.GHL_PER_INVOICE_COMBINED_PAID_EXITS_ENABLED === "true",
  }) });
}

export interface InvoiceCardWriteReport {
  invoiceId: string;
  invoiceNumber: string | null;
  cardId: string | null;
  kind: "adopt" | "create" | "combine";
  action: "applied" | "unchanged" | "hold" | "failed";
  reason: string;
  to?: { stageId: string; monetaryValue: number; name?: string };
  /**
   * On a `combine`, every invoice the one card now stands for. Present so the
   * log still reads one line per invoice while recording that the line is a
   * share of a card, not a card of its own.
   */
  coveredInvoiceNumbers?: readonly string[];
}

type Writer = Pick<SyncRunWriter, "prepare" | "assertPending" | "confirm" | "abandon" | "block"> &
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
  /**
   * How long a claimed write, and the read that establishes its outcome, may
   * take. Defaults to the module constants; present so a test can drive a
   * genuine hang without waiting 20 seconds for it.
   */
  deadlines?: Readonly<{ attemptMs: number; verifyMs: number }>;
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
    if (action.state !== "adopt" && action.state !== "create" && action.state !== "combine") continue;
    const kind = action.state;
    const decision = decideInvoiceCardWrite(action, stageIds, input.gate.allow);
    // One `combine` is ONE write covering several invoices, so every report it
    // produces is the same outcome repeated per invoice. `report` is what the
    // morning log and the dashboard read, and both are per invoice.
    const rows: readonly { invoiceId: string; invoiceNumber: string | null }[] = action.state === "combine"
      ? action.invoiceIds.map((invoiceId, i) => ({ invoiceId, invoiceNumber: action.invoiceNumbers[i] ?? null }))
      : [{ invoiceId: action.invoiceId, invoiceNumber: action.invoiceNumber }];
    const cardOf = action.state === "create" ? null : action.cardId;
    const covered = action.state === "combine" ? { coveredInvoiceNumbers: action.invoiceNumbers } : {};
    const say = (entry: Omit<InvoiceCardWriteReport, "invoiceId" | "invoiceNumber" | "kind" | "cardId">,
      cardId: string | null = cardOf) => {
      for (const row of rows) input.report({ ...row, cardId, kind, ...covered, ...entry });
    };
    const base = { invoiceId: rows[0].invoiceId, invoiceNumber: rows[0].invoiceNumber, cardId: cardOf, kind } as const;

    if (decision.state === "nothing") { say({ action: "unchanged", reason: decision.reason }); continue; }
    if (decision.state === "refuse") { say({ action: "hold", reason: decision.reason }); continue; }
    if (input.spend.remaining <= 0) { say({ action: "hold", reason: "run_write_budget_exhausted" }); continue; }

    try {
      const outcome = decision.kind === "create" ? await createCard(input, io, decision)
        : decision.kind === "combine" ? await combineCard(input, io, decision)
        : await adoptCard(input, io, decision);
      if (outcome.state === "applied") { applied += 1; input.spend.remaining -= 1; }
      say({ action: outcome.state, reason: outcome.reason, ...(outcome.to ? { to: outcome.to } : {}) },
        outcome.cardId ?? cardOf);
      if (outcome.state === "failed") return { applied, halted: true };
    } catch (err: any) {
      // Everything a card write can be expected to get wrong is handled inside
      // the helpers and comes back as a hold. An exception reaching here is
      // therefore unexplained, and an unexplained failure in a writer whose
      // claim may already be durable is a halt, not a skipped card.
      await input.writer.block();
      say({ action: "failed",
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
    // Bounded like every other provider call: a stalled pre-flight read is
    // one card held, and must never be a stalled run.
    current = await withDeadline(io.readOpportunity(decision.cardId), attemptMs(input), "card_preflight_read");
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
  const landed = (card: GhlOpportunity) => card.id === decision.cardId && card.pipelineId === current.pipelineId
    && card.contactId === current.contactId && card.status === "open"
    && card.pipelineStageId === decision.stageId && card.monetaryValue === decision.monetaryValue
    && (card.name ?? null) === (current.name ?? null);
  // Still exactly as the plan found it: the PUT did not take effect.
  const untouched = (card: GhlOpportunity) => card.id === decision.cardId && card.pipelineId === current.pipelineId
    && card.contactId === current.contactId && card.status === current.status
    && card.pipelineStageId === current.pipelineStageId && card.monetaryValue === current.monetaryValue
    && (card.name ?? null) === (current.name ?? null);

  try {
    await input.writer.assertPending(intentId);
    await withDeadline(io.moveOpportunityToStage(decision.cardId, decision.stageId, decision.monetaryValue),
      attemptMs(input), "card_move");
    const accepted = await withDeadline(io.readOpportunity(decision.cardId), attemptMs(input), "card_readback");
    if (!landed(accepted)) throw new Error("Post-write card state not confirmed");
    await input.writer.confirm(intentId);
  } catch (err: any) {
    return await resolveUnlandedWrite(input, io, {
      intentId, to, cardId: decision.cardId, failure: err?.message ?? String(err),
      look: () => io.readOpportunity(decision.cardId),
      // An adopt always has a card id, so a null here means the card itself has
      // gone - which is not "the write did not land", it is unknown.
      verdict: card => card === null ? "unknown" : landed(card) ? "landed" : untouched(card) ? "absent" : "unknown",
      absentReason: "card_move_did_not_take_effect",
      absentEvidence: `fresh read of ${decision.cardId} still shows stage ${current.pipelineStageId}`
        + ` and amount ${current.monetaryValue}, exactly as before the write`,
      appliedReason: "Stage and amount were already correct on re-read; the write had landed before the error",
    });
  }
  return { state: "applied", cardId: decision.cardId, to, claimed: true,
    reason: decision.role === "paid" ? "Moved to Paid against verified Jobber settlement; card carries a zero balance"
      : decision.role === "overdue" ? "Moved to Overdue against verified Jobber source, with recorded proof the legacy workflow cannot send"
      : "Stage and amount corrected from verified Jobber source" };
}

/**
 * TAKE OVER ONE CARD FOR SEVERAL INVOICES.
 *
 * Same shape as `adoptCard` - fresh read, pre-flight comparison, durable claim,
 * read-back, the shared unlanded-write recovery - and differs in exactly three
 * ways, each of which is the point of it:
 *
 *   1. The name check is a SUBSET check, not an equality check. A card that
 *      names #7286 and #7304 is allowed to be written for both of them; a card
 *      that names no invoice is allowed to be written for whatever the customer
 *      owes. What is still refused is a card whose name has come to mention an
 *      invoice this write does not cover - the amount would then be for a
 *      different set of invoices than the name claims.
 *   2. The durable claim records EVERY invoice the card now stands for, so the
 *      journal says what the money on it is for.
 *   3. Every covered invoice is re-checked against the verified source and the
 *      balances must still add up to exactly the amount being written. A
 *      payment landing between plan and write changes the total, and a total
 *      that no longer matches is held rather than written.
 *
 * It still NEVER renames a card, never writes a status and never reopens a
 * closed card. It MAY move one into Paid, but only as a retirement: a zero
 * balance, a name that enumerates exactly the invoices being written, and a
 * verified source saying every one of them is settled. A card standing for
 * "whatever this customer owes" names no invoice, so it can never pass that.
 */
async function combineCard(
  input: ApplyInvoiceCardPlanInput, io: InvoiceCardWriteIo,
  decision: Extract<WriteDecision, { kind: "combine" }>
): Promise<Outcome> {
  const to = { stageId: decision.stageId, monetaryValue: decision.monetaryValue };
  const held = (reason: string): Outcome => ({ state: "hold", reason, cardId: decision.cardId, to, claimed: false });

  let current: GhlOpportunity;
  try {
    current = await withDeadline(io.readOpportunity(decision.cardId), attemptMs(input), "card_preflight_read");
  } catch (err: any) {
    return held(`fresh_card_read_failed_${err?.message ?? err}`);
  }
  if (current.id !== decision.cardId || current.pipelineId !== input.pipelineId
      || current.contactId !== input.contactId || current.status !== "open") return held("card_ownership_or_status_changed_before_write");
  if (![stageOf(input, "sent"), stageOf(input, "overdue"), stageOf(input, "paid")].includes(current.pipelineStageId ?? "")) {
    return held("card_is_in_a_protected_or_unknown_stage");
  }
  // The name may say nothing about invoices, or may name some or all of the
  // ones being written - but never one that is not in this set.
  const covered = new Set(decision.invoiceNumbers);
  const named = invoiceNumbersInCardName(current.name);
  if (named.some(n => !covered.has(n))) return held("card_names_an_invoice_this_write_does_not_cover");
  // RETIRING one is stricter in the one way that matters. Zeroing a card says
  // "nothing this card stands for is still owed", and only a name that lists
  // every one of them can establish that. So here the two sets must match
  // exactly - checked against this fresh read, not against the plan's older
  // view of the name - and a card naming nothing can never be retired.
  if (decision.role === "paid" && (named.length < 2 || named.length !== covered.size)) {
    return held("only_a_card_that_names_every_invoice_it_covers_can_be_retired");
  }

  const seen = input.preflight.get(decision.cardId);
  if (!seen) return held("card_was_not_in_the_preflight_snapshot");
  if ((current.monetaryValue ?? null) !== seen.monetaryValue || (current.name ?? null) !== seen.name
      || (current.status ?? null) !== seen.status) return held("card_changed_since_the_plan_was_made");

  if (current.pipelineStageId === decision.stageId && current.monetaryValue === decision.monetaryValue) {
    return { state: "unchanged", reason: "fresh_read_already_matches_the_target", cardId: decision.cardId, to, claimed: false };
  }

  // Re-check the whole set against the verified source. The amount on a
  // combined card is only meaningful as the sum of what it covers, so a stale
  // sum is refused outright rather than written and corrected later.
  const invoices = buildInvoiceSourceEvidence(input.source, input.jobberClientId);
  const target = moneyCents(decision.monetaryValue);
  if (!invoices || target === null) return held("source_evidence_unavailable");
  let owed = 0;
  for (const id of decision.invoiceIds) {
    const row = invoices.find(i => i.id === id);
    if (!row) return held("source_evidence_unavailable");
    if (decision.role === "paid") {
      // Retiring the card asserts every one of these is settled, so the source
      // has to say so about every one of them, by status AND by balance.
      if (row.invoiceStatus !== "paid" || row.balanceCents !== 0) return held("one_of_these_invoices_is_not_settled");
      continue;
    }
    if (row.invoiceStatus === "paid" || row.balanceCents <= 0) return held("one_of_these_invoices_is_no_longer_unpaid");
    owed += row.balanceCents;
  }
  if (owed !== target) return held("these_invoices_no_longer_add_up_to_the_amount_planned");

  const intent = buildGhlWriteIntent({ current, to, jobberClientId: input.jobberClientId,
    source: input.source, storedInvoiceIds: [...decision.invoiceIds], observedAt: input.observedAt });
  // `to` carries no `name`, so the durable record says updateName: false.
  if (!intent || intent.target.updateName || intent.target.nameHash !== cardNameHash(current.name)) {
    return held("card_or_source_evidence_unavailable_or_would_rename");
  }
  if (intent.approvalId !== input.gate.approvalId) return held("write_approval_changed_before_write");

  let intentId: string;
  try {
    intentId = await input.writer.prepare(intent);
  } catch (err: any) {
    return { state: "failed", cardId: decision.cardId, to, claimed: true,
      reason: `Durable write claim refused; remaining card writes halted. ${err?.message ?? err}` };
  }
  const landed = (card: GhlOpportunity) => card.id === decision.cardId && card.pipelineId === current.pipelineId
    && card.contactId === current.contactId && card.status === "open"
    && card.pipelineStageId === decision.stageId && card.monetaryValue === decision.monetaryValue
    && (card.name ?? null) === (current.name ?? null);
  const untouched = (card: GhlOpportunity) => card.id === decision.cardId && card.pipelineId === current.pipelineId
    && card.contactId === current.contactId && card.status === current.status
    && card.pipelineStageId === current.pipelineStageId && card.monetaryValue === current.monetaryValue
    && (card.name ?? null) === (current.name ?? null);

  try {
    await input.writer.assertPending(intentId);
    await withDeadline(io.moveOpportunityToStage(decision.cardId, decision.stageId, decision.monetaryValue),
      attemptMs(input), "card_move");
    const accepted = await withDeadline(io.readOpportunity(decision.cardId), attemptMs(input), "card_readback");
    if (!landed(accepted)) throw new Error("Post-write card state not confirmed");
    await input.writer.confirm(intentId);
  } catch (err: any) {
    return await resolveUnlandedWrite(input, io, {
      intentId, to, cardId: decision.cardId, failure: err?.message ?? String(err),
      look: () => io.readOpportunity(decision.cardId),
      verdict: card => card === null ? "unknown" : landed(card) ? "landed" : untouched(card) ? "absent" : "unknown",
      absentReason: "combined_card_move_did_not_take_effect",
      absentEvidence: `fresh read of ${decision.cardId} still shows stage ${current.pipelineStageId}`
        + ` and amount ${current.monetaryValue}, exactly as before the write`,
      appliedReason: "Stage and amount were already correct on re-read; the write had landed before the error",
    });
  }
  const which = `${decision.invoiceIds.length} invoice${decision.invoiceIds.length === 1 ? "" : "s"}`
    + ` (${decision.invoiceNumbers.map(n => `#${n}`).join(", ")})`;
  return { state: "applied", cardId: decision.cardId, to, claimed: true,
    reason: decision.role === "paid"
      ? `One card retired to Paid at a zero balance; it named only ${which}, and the verified`
        + " Jobber source shows every one of them settled; name and status untouched"
      : `One card adopted for ${which} against verified Jobber source;`
        + (decision.role === "overdue"
          ? " moved to Overdue with recorded proof the legacy workflow cannot send; name and status untouched"
          : " name and status untouched") };
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
    live = await withDeadline(io.listContactOpportunities(input.contactId, input.pipelineId),
      attemptMs(input), "contact_cards_preflight_read");
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
  const landed = (card: GhlOpportunity) => card.pipelineId === input.pipelineId
    && card.contactId === input.contactId && card.status === "open"
    && card.pipelineStageId === decision.stageId && card.monetaryValue === decision.monetaryValue
    && card.name === decision.name;
  try {
    await input.writer.assertPending(intentId);
    created = await withDeadline(io.createOpportunity({ pipelineId: input.pipelineId, pipelineStageId: decision.stageId,
      contactId: input.contactId, name: decision.name, monetaryValue: decision.monetaryValue }),
      attemptMs(input), "card_create");
    if (!created?.id) throw new Error("GHL did not return the created card");
    const accepted = await withDeadline(io.readOpportunity(created.id), attemptMs(input), "card_readback");
    if (accepted.id !== created.id || !landed(accepted)) throw new Error("Created card state not confirmed");
    await input.writer.confirm(intentId);
  } catch (err: any) {
    // The card has no id to look up - that is the whole reason a creation is
    // claimed against the invoice - so the question "did it land?" is answered
    // by re-listing this contact's cards and looking for this invoice's number.
    return await resolveUnlandedWrite(input, io, {
      intentId, to, cardId: created?.id ?? null, failure: err?.message ?? String(err),
      look: async () => {
        const cards = await io.listContactOpportunities(input.contactId, input.pipelineId);
        // If the POST answered with an id, THAT card is the only thing worth
        // looking at. A card created with the wrong name would not be found by
        // a name search, and releasing the claim then would let a later run
        // create a second one - which is the single mistake a customer sees.
        if (created?.id) {
          return cards.find(c => c.id === created!.id) ?? null;
        }
        const named = cards.filter(c => invoiceNumbersInCardName(c.name).includes(decision.invoiceNumber));
        // Two cards for one invoice is the duplicate this writer exists to
        // prevent. Never resolve that automatically.
        if (named.length > 1) throw new Error(`${named.length} cards already name invoice ${decision.invoiceNumber}`);
        return named[0] ?? null;
      },
      // With an id in hand, "not in the list" means the POST answered about a
      // card that is not there: that is unknown, not absent. Without an id, no
      // card naming this invoice is genuine evidence that nothing was created.
      //
      // The residual risk is a POST that created the card but errored, and a
      // list that has not yet caught up. The next run's own pre-flight list
      // holds if a card for this invoice exists, so a duplicate would need the
      // card to be invisible on two reads an hour apart.
      verdict: card => card === null
        ? (created?.id ? "unknown" : "absent")
        : landed(card) && (!created?.id || card.id === created.id) ? "landed" : "unknown",
      absentReason: "creation_post_did_not_create_a_card",
      absentEvidence: `fresh complete read of contact ${input.contactId} in pipeline ${input.pipelineId}`
        + ` shows no card naming invoice ${decision.invoiceNumber}`,
      appliedReason: "Card was found already created and correct on re-read; the POST had landed before the error",
    });
  }
  return { state: "applied", cardId: created.id, to, claimed: true,
    reason: "Card created in Invoice Sent against verified Jobber source; no Overdue move and no enrollment claimed" };
}

const stageOf = (input: ApplyInvoiceCardPlanInput, role: keyof StageIds) => input.stageIds[role];
const attemptMs = (i: ApplyInvoiceCardPlanInput) => i.deadlines?.attemptMs ?? WRITE_ATTEMPT_TIMEOUT_MS;
const verifyMs = (i: ApplyInvoiceCardPlanInput) => i.deadlines?.verifyMs ?? WRITE_VERIFY_TIMEOUT_MS;

/**
 * ESTABLISH WHAT ACTUALLY HAPPENED TO A CLAIMED WRITE THAT ERRORED.
 *
 * This is the recovery that was missing. Before it, any error between "claim
 * recorded" and "outcome read back" left the claim pending and the run blocked
 * forever: no later sync could start (`admitSyncRun` refuses while a run is
 * blocked) and no card could be written (a pending entry blocks the writer).
 * One unanswered request on 2026-11-25 stopped every sync for thirteen hours.
 *
 * So instead of assuming the worst, go and look. There are exactly three
 * answers, and only one of them is still a halt:
 *
 *   landed  - the provider shows the write, complete and correct. Confirm the
 *             claim and count the write. This is the case where the mutation
 *             succeeded and only the read-back or the confirm failed.
 *   absent  - the provider was read successfully and plainly does not show the
 *             write. Abandon the claim, recording that observation, and hold
 *             this one card. The run carries on and a later run may retry.
 *   unknown - the read failed, or showed something that is neither the old nor
 *             the new state, or showed a duplicate. Block, exactly as before.
 *             Fail-closed is preserved for the only case that needs it.
 *
 * The verification read is itself bounded, so this can never be the thing that
 * hangs. If it times out the answer is `unknown`, which blocks - a timeout is
 * not evidence of absence and is never treated as such.
 */
async function resolveUnlandedWrite(
  input: ApplyInvoiceCardPlanInput, io: InvoiceCardWriteIo,
  spec: {
    intentId: string;
    to: { stageId: string; monetaryValue: number; name?: string };
    cardId: string | null;
    failure: string;
    look: () => Promise<GhlOpportunity | null>;
    verdict: (card: GhlOpportunity | null) => "landed" | "absent" | "unknown";
    absentReason: string;
    absentEvidence: string;
    appliedReason: string;
  },
): Promise<Outcome> {
  const halt = (reason: string): Outcome =>
    ({ state: "failed", cardId: spec.cardId, to: spec.to, claimed: true, reason });

  let found: GhlOpportunity | null;
  try {
    found = await withDeadline(spec.look(), verifyMs(input), "write_verification_read");
  } catch (err: any) {
    await input.writer.block();
    return halt(`Write outcome unconfirmed and could not be established; remaining card writes halted.`
      + ` Original failure: ${spec.failure}. Verification failed: ${err?.message ?? err}`);
  }

  const verdict = spec.verdict(found);
  if (verdict === "unknown") {
    await input.writer.block();
    return halt(`Write outcome unconfirmed and the card is in neither the old nor the new state;`
      + ` remaining card writes halted. Original failure: ${spec.failure}`);
  }

  // Both remaining paths settle the claim. If settling it throws, the writer
  // has already blocked itself and this stays a halt - an outcome we could not
  // record durably is not an outcome we may act on.
  if (verdict === "landed") {
    try {
      await input.writer.confirm(spec.intentId);
    } catch (err: any) {
      return halt(`Write landed but the claim could not be confirmed; remaining card writes halted.`
        + ` Original failure: ${spec.failure}. Confirm failed: ${err?.message ?? err}`);
    }
    return { state: "applied", cardId: found?.id ?? spec.cardId, to: spec.to, claimed: true,
      reason: `${spec.appliedReason}. Original failure: ${spec.failure}` };
  }

  try {
    await input.writer.abandon(spec.intentId, { reason: spec.absentReason,
      evidence: spec.absentEvidence, observedAt: new Date().toISOString() });
  } catch (err: any) {
    return halt(`Write did not land but the claim could not be released; remaining card writes halted.`
      + ` Original failure: ${spec.failure}. Release failed: ${err?.message ?? err}`);
  }
  return { state: "hold", cardId: spec.cardId, to: spec.to, claimed: false,
    reason: `Write did not land and its claim was released, so a later run may retry;`
      + ` this card is unchanged. ${spec.absentEvidence}. Original failure: ${spec.failure}` };
}
