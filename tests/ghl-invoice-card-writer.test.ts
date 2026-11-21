import test from "node:test";
import assert from "node:assert/strict";
import { writerFixture } from "./helpers/sync-writer-fixture";
import {
  applyInvoiceCardPlan, claimedInvoiceIdsFromHistory, decideInvoiceCardWrite, invoiceCardWriteGate,
  DEFAULT_WRITE_BUDGET, MAX_WRITE_BUDGET, legacySendingFromEnv,
  type InvoiceCardWriteIo, type InvoiceCardWriteReport, type StageIds, type WriteAllowances,
} from "../lib/ghl-invoice-card-writer";
import { cardNameHash, creationPlaceholderId, invoiceSourceFingerprint,
  type CycleJournalEntry, type GhlWriteIntent } from "../lib/sync-writer-control";
import type { InvoiceCardAction, InvoiceCardPlan } from "../lib/ghl-invoice-card-plan";
import type { PhoneInvoiceEvidence } from "../lib/ghl-phone-state";
import type { GhlOpportunity } from "../lib/ghl";

const STAGES: StageIds = { sent: "stage-sent", overdue: "stage-overdue", paid: "stage-paid" };
const CONTACT = "contact-1", CLIENT = "jobber-1", PIPELINE = "pipeline-1", LOCATION = "location-1";
const INVOICE = "invoice-1", NUMBER = "7226";
const NAME = `Invoice #${NUMBER} — Someone`;

const invoice = (over: Partial<PhoneInvoiceEvidence> = {}): PhoneInvoiceEvidence => ({
  id: INVOICE, invoiceNumber: NUMBER, client: { id: CLIENT }, invoiceStatus: "past_due",
  amounts: { total: 300, invoiceBalance: 137.5 }, issuedDate: "2026-09-01", createdAt: "2026-09-01",
  dueDate: "2026-10-01", ...over,
});

const adopt = (over: Partial<Extract<InvoiceCardAction, { state: "adopt" }>> = {}) => ({
  state: "adopt" as const, invoiceId: INVOICE, invoiceNumber: NUMBER, cardId: "card-1",
  desiredStage: "Invoice Sent", stage: "Invoice Sent", monetaryValue: 137.5,
  changes: ["value"] as ("stage" | "value")[], reasons: [] as string[], ...over,
});
const create = (over: Partial<Extract<InvoiceCardAction, { state: "create" }>> = {}) => ({
  state: "create" as const, invoiceId: INVOICE, invoiceNumber: NUMBER,
  desiredStage: "Invoice Sent", stage: "Invoice Sent" as const, monetaryValue: 137.5,
  name: NAME, reasons: [] as string[], ...over,
});
const plan = (...actions: InvoiceCardAction[]): InvoiceCardPlan => ({
  actions, untouched: [],
  summary: { adopt: actions.filter(a => a.state === "adopt").length, create: actions.filter(a => a.state === "create").length,
    hold: 0, skip: 0, untouched: 0 },
});

const ALLOW_OVERDUE: WriteAllowances = { overdueMoves: true, paidExits: false };
const ALLOW_PAID: WriteAllowances = { overdueMoves: false, paidExits: true };

// --- the two gates --------------------------------------------------------

test("by default, asking for nothing extra means Overdue and Paid are both refused", () => {
  const od = decideInvoiceCardWrite(adopt({ stage: "Invoice Overdue", desiredStage: "Invoice Overdue", changes: ["stage"] }), STAGES);
  assert.equal(od.state === "refuse" && od.reason, "overdue_move_needs_recorded_proof_the_legacy_workflow_is_off");
  const paid = decideInvoiceCardWrite(adopt({ stage: "Invoice Paid", monetaryValue: 0, changes: ["stage"] }), STAGES);
  assert.equal(paid.state === "refuse" && paid.reason, "paid_invoices_are_out_of_scope_for_now");
});

test("an Overdue move is allowed only once the legacy workflow is recorded as off", () => {
  const action = adopt({ stage: "Invoice Overdue", desiredStage: "Invoice Overdue", changes: ["stage"] });
  const allowed = decideInvoiceCardWrite(action, STAGES, ALLOW_OVERDUE);
  assert.equal(allowed.state === "write" && allowed.role, "overdue");
  assert.equal(allowed.state === "write" && allowed.stageId, STAGES.overdue);
  // And permission for Paid does not quietly carry over to Overdue.
  assert.equal(decideInvoiceCardWrite(action, STAGES, ALLOW_PAID).state, "refuse");
});

test("a new card is created in Sent even when Overdue moves are allowed", () => {
  // The plan never creates straight into Overdue, and the writer would not
  // either: a new card gets one run in Sent first.
  const decision = decideInvoiceCardWrite(create({ desiredStage: "Invoice Overdue" }), STAGES, ALLOW_OVERDUE);
  assert.equal(decision.state === "write" && decision.stageId, STAGES.sent);
});

test("a stage this writer does not know is refused, not guessed", () => {
  const decision = decideInvoiceCardWrite(adopt({ stage: "Late Fee Invoice Sent", changes: ["stage"] }), STAGES, ALLOW_OVERDUE);
  assert.equal(decision.state === "refuse" && decision.reason, "target_stage_is_not_writable");
});

test("a pipeline whose stage ids are not distinct is refused outright", () => {
  const decision = decideInvoiceCardWrite(adopt(), { ...STAGES, sent: STAGES.overdue });
  assert.equal(decision.state === "refuse" && decision.reason, "pipeline_stage_ids_are_not_distinct");
});

test("an unresolved stage id is refused", () => {
  assert.equal(decideInvoiceCardWrite(adopt(), { ...STAGES, sent: "" }).state, "refuse");
});

// --- the recorded evidence ------------------------------------------------

test("with nothing recorded, there is no proof the legacy workflow is off", () => {
  assert.equal(legacySendingFromEnv({}), null);
  assert.equal(legacySendingFromEnv({ GHL_LEGACY_INVOICE_WORKFLOW_ID: "w" }), null);
  assert.equal(legacySendingFromEnv({ GHL_LEGACY_SENDING_DISABLED: "2026-11-21|checked" }), null);
});

test("recorded proof names the workflow and the day it was switched off", () => {
  const evidence = legacySendingFromEnv({ GHL_LEGACY_INVOICE_WORKFLOW_ID: "w",
    GHL_LEGACY_SENDING_DISABLED: "2026-11-20|owner turned every GHL automation off" });
  assert.equal(evidence?.workflowId, "w");
  assert.equal(evidence?.disabledOn, "2026-11-20");
  assert.equal(evidence?.evidenceRef, "owner turned every GHL automation off");
  assert.equal(evidence?.source, "operator-confirmed-workflow-sending-disabled");
});

test("a date that is not a real past day, or a claim with no reason, is not proof", () => {
  for (const raw of ["2026-11-20", "|checked", "2026-13-01|checked", "2026-02-30|checked",
                     "2099-01-01|checked", "yesterday|checked", "2026-11-20|", "  |  "]) {
    assert.equal(legacySendingFromEnv({ GHL_LEGACY_INVOICE_WORKFLOW_ID: "w",
      GHL_LEGACY_SENDING_DISABLED: raw }), null, raw);
  }
});

// --- the decision ---------------------------------------------------------

test("a Sent adopt is a write that carries the invoice's balance", () => {
  const decision = decideInvoiceCardWrite(adopt(), STAGES);
  assert.deepEqual(decision, { state: "write", kind: "adopt", role: "sent", cardId: "card-1",
    stageId: STAGES.sent, monetaryValue: 137.5, invoiceId: INVOICE, invoiceNumber: NUMBER });
});

test("a Paid adopt, once allowed, must carry nothing at all", () => {
  const ok = decideInvoiceCardWrite(adopt({ stage: "Invoice Paid", monetaryValue: 0, changes: ["stage"] }), STAGES, ALLOW_PAID);
  assert.equal(ok.state === "write" && ok.role, "paid");
  const bad = decideInvoiceCardWrite(adopt({ stage: "Invoice Paid", monetaryValue: 12.5, changes: ["stage"] }), STAGES, ALLOW_PAID);
  assert.equal(bad.state === "refuse" && bad.reason, "paid_card_must_carry_a_zero_balance");
});

test("an adopt with nothing to change is not a write", () => {
  const decision = decideInvoiceCardWrite(adopt({ changes: [] }), STAGES);
  assert.deepEqual(decision, { state: "nothing", reason: "card_already_matches_the_invoice" });
});

test("a create targets Sent, carries the name, and is never made for $0", () => {
  const decision = decideInvoiceCardWrite(create(), STAGES);
  assert.equal(decision.state === "write" && decision.stageId, STAGES.sent);
  assert.equal(decision.state === "write" && decision.kind === "create" && decision.name, NAME);
  assert.equal(decideInvoiceCardWrite(create({ monetaryValue: 0 }), STAGES).state, "refuse");
  assert.equal(decideInvoiceCardWrite(create({ name: "   " }), STAGES).state, "refuse");
});

test("holds and skips are never writes", () => {
  for (const state of ["hold", "skip"] as const) {
    const decision = decideInvoiceCardWrite({ state, invoiceId: INVOICE, invoiceNumber: NUMBER, cardId: null, reasons: [] } as any, STAGES);
    assert.deepEqual(decision, { state: "nothing", reason: "action_is_not_a_write" });
  }
});

test("money that is not money is refused, not rounded", () => {
  for (const value of [Number.NaN, Infinity, -1, 0.001] as number[]) {
    assert.equal(decideInvoiceCardWrite(adopt({ monetaryValue: value }), STAGES).state, "refuse");
  }
});

// --- the gate -------------------------------------------------------------

const baseEnv = { GHL_PER_INVOICE_CARD_WRITES_ENABLED: "true", GHL_WRITE_APPROVAL_ID: "reviewed-plan-1", GHL_LOCATION_ID: LOCATION };

test("writing is off unless it is explicitly turned on", () => {
  assert.deepEqual(invoiceCardWriteGate({}), { open: false, reason: "per_invoice_card_writes_not_enabled" });
  // Crucially, the per-customer sync mode does NOT turn this on.
  assert.equal(invoiceCardWriteGate({ GHL_INVOICE_WRITE_MODE: "sync" }).open, false);
});

test("the gate needs an approval token and a location", () => {
  assert.equal(invoiceCardWriteGate({ ...baseEnv, GHL_WRITE_APPROVAL_ID: "" }).open, false);
  assert.equal(invoiceCardWriteGate({ ...baseEnv, GHL_WRITE_APPROVAL_ID: "has spaces" }).open, false);
  assert.equal(invoiceCardWriteGate({ ...baseEnv, GHL_LOCATION_ID: "  " }).open, false);
});

test("a fully configured gate opens with a bounded budget and no extra allowances", () => {
  assert.deepEqual(invoiceCardWriteGate(baseEnv), { open: true, approvalId: "reviewed-plan-1",
    budget: DEFAULT_WRITE_BUDGET, allow: { overdueMoves: false, paidExits: false } });
});

test("the gate turns Overdue on only from recorded proof about the SAME workflow", () => {
  const on = invoiceCardWriteGate({ ...baseEnv, GHL_LEGACY_INVOICE_WORKFLOW_ID: "legacy-w",
    GHL_LEGACY_SENDING_DISABLED: "2026-11-20|owner switched them off" });
  assert.equal(on.open && on.allow.overdueMoves, true);
  // Proof naming a different workflow proves nothing about this one.
  const mismatched = invoiceCardWriteGate({ ...baseEnv, GHL_LEGACY_INVOICE_WORKFLOW_ID: "legacy-w",
    GHL_LEGACY_SENDING_DISABLED: "2026-11-20|" });
  assert.equal(mismatched.open && mismatched.allow.overdueMoves, false);
});

test("a budget that does not parse closes the gate; it never falls back to the default", () => {
  for (const raw of ["0", "ten", "-1", String(MAX_WRITE_BUDGET + 1), "1e3", " 5"]) {
    assert.equal(invoiceCardWriteGate({ ...baseEnv, GHL_PER_INVOICE_CARD_WRITE_BUDGET: raw }).open, false, raw);
  }
});

test("Paid exits are off until explicitly asked for, and never by accident", () => {
  for (const raw of [undefined, "", "false", "1", "yes", "TRUE"]) {
    const gate = invoiceCardWriteGate({ ...baseEnv, ...(raw === undefined ? {} : { GHL_PER_INVOICE_PAID_EXITS_ENABLED: raw }) });
    assert.equal(gate.open && gate.allow.paidExits, false, String(raw));
  }
  const on = invoiceCardWriteGate({ ...baseEnv, GHL_PER_INVOICE_PAID_EXITS_ENABLED: "true" });
  assert.equal(on.open && on.allow.paidExits, true);
});

// --- history --------------------------------------------------------------

const creationEntry = (over: Partial<GhlWriteIntent["creation"] & {}> = {}): CycleJournalEntry => ({
  id: "entry-1", runId: "run-1", state: "confirmed", preparedAt: "2026-11-20T00:00:00.000Z",
  confirmedAt: "2026-11-20T00:00:01.000Z", fingerprint: "x",
  intent: {
    creation: { version: 1, stageRole: "sent", locationId: LOCATION, pipelineId: PIPELINE, stageId: STAGES.sent,
      contactId: CONTACT, jobberClientId: CLIENT, invoiceId: INVOICE, invoiceNumber: NUMBER,
      nameHash: cardNameHash(NAME), amountCents: 13750, sourceFingerprint: "y", ...over },
  } as any,
});

test("only creations in this pipeline and location count as claimed", () => {
  const history = [creationEntry(), creationEntry({ invoiceId: "other-pipeline", pipelineId: "pipeline-2" }),
    creationEntry({ invoiceId: "other-location", locationId: "location-2" }),
    { ...creationEntry(), intent: {} as any }];
  assert.deepEqual([...claimedInvoiceIdsFromHistory(history, { locationId: LOCATION, pipelineId: PIPELINE })], [INVOICE]);
});

// --- applying -------------------------------------------------------------

type Harness = {
  io: InvoiceCardWriteIo; puts: any[]; posts: any[]; reads: string[];
  live: GhlOpportunity[]; cards: Map<string, GhlOpportunity>;
  readFails?: boolean; listFails?: boolean; putFails?: boolean;
};
function harness(cards: GhlOpportunity[] = [], live?: GhlOpportunity[]): Harness {
  const h: Harness = { io: null as any, puts: [], posts: [], reads: [], live: live ?? cards,
    cards: new Map(cards.map(c => [c.id, structuredClone(c)])) };
  h.io = {
    readOpportunity: async (id: string) => {
      h.reads.push(id);
      if (h.readFails) throw new Error("Synthetic read failure");
      const card = h.cards.get(id);
      if (!card) throw new Error("Unverified GHL opportunity readback");
      return structuredClone(card);
    },
    listContactOpportunities: async () => {
      if (h.listFails) throw new Error("Synthetic list failure");
      return structuredClone(h.live);
    },
    moveOpportunityToStage: async (id: string, stageId: string, monetaryValue?: number, name?: string) => {
      h.puts.push({ id, stageId, monetaryValue, name });
      if (h.putFails) throw new Error("Synthetic PUT failure");
      const card = h.cards.get(id)!;
      card.pipelineStageId = stageId;
      if (monetaryValue != null) card.monetaryValue = monetaryValue;
      if (name != null) card.name = name;
    },
    createOpportunity: async (opts: any) => {
      h.posts.push(opts);
      const made: GhlOpportunity = { id: "card-new", pipelineId: opts.pipelineId, pipelineStageId: opts.pipelineStageId,
        contactId: opts.contactId, status: "open", monetaryValue: opts.monetaryValue, name: opts.name };
      h.cards.set(made.id, made);
      return made;
    },
  };
  return h;
}

const openCard = (over: Partial<GhlOpportunity> = {}): GhlOpportunity => ({
  id: "card-1", pipelineId: PIPELINE, pipelineStageId: STAGES.sent, contactId: CONTACT,
  status: "open", monetaryValue: 99, name: NAME, ...over,
});

async function run(p: InvoiceCardPlan, h: Harness, over: Record<string, any> = {}) {
  const fixture = writerFixture();
  const reports: InvoiceCardWriteReport[] = [];
  const prepared: GhlWriteIntent[] = [];
  const writer = {
    prepare: async (intent: GhlWriteIntent) => { prepared.push(structuredClone(intent)); return fixture.writer.prepare(intent); },
    assertPending: fixture.writer.assertPending.bind(fixture.writer),
    confirm: fixture.writer.confirm.bind(fixture.writer),
    block: fixture.writer.block.bind(fixture.writer),
    readCycleHistory: fixture.writer.readCycleHistory.bind(fixture.writer),
  };
  const preflightCards: GhlOpportunity[] = over.preflightCards ?? [...h.cards.values()];
  const preflight = new Map(preflightCards.map(c =>
    [c.id, { id: c.id, name: c.name ?? null, status: c.status ?? null, stageName: null, monetaryValue: c.monetaryValue ?? null }] as const));
  const result = await applyInvoiceCardPlan({
    plan: p, contactId: CONTACT, jobberClientId: CLIENT, pipelineId: PIPELINE, locationId: LOCATION,
    stageIds: STAGES, gate: { open: true, approvalId: "reviewed-plan-1", budget: 60,
      allow: { overdueMoves: false, paidExits: true, ...(over.allow ?? {}) }, ...(over.gate ?? {}) },
    source: over.source ?? [invoice()], observedAt: "2026-11-20T09:00:00.000Z",
    preflight, spend: over.spend ?? { remaining: 60 }, claimedInvoiceIds: over.claimedInvoiceIds ?? new Set<string>(),
    writer: over.writer ?? writer, report: entry => reports.push(entry), io: h.io,
  });
  return { result, reports, prepared, fixture };
}

test("a create claims the invoice, posts into Sent, reads back, and confirms", async () => {
  process.env.GHL_WRITE_APPROVAL_ID = "reviewed-plan-1";
  const h = harness([], []);
  const { result, reports, prepared, fixture } = await run(plan(create()), h);
  assert.equal(result.applied, 1);
  assert.equal(result.halted, false);
  assert.deepEqual(h.posts, [{ pipelineId: PIPELINE, pipelineStageId: STAGES.sent, contactId: CONTACT,
    name: NAME, monetaryValue: 137.5 }]);
  assert.equal(reports[0].action, "applied");
  assert.equal(reports[0].cardId, "card-new");

  // The durable claim: against the invoice, into the "sent" role, with the
  // exact name and balance, and nothing enrollment-shaped anywhere on it.
  const claim = prepared[0].creation!;
  assert.equal(claim.stageRole, "sent");
  assert.equal(claim.invoiceId, INVOICE);
  assert.equal(claim.amountCents, 13750);
  assert.equal(claim.nameHash, cardNameHash(NAME));
  assert.equal(claim.sourceFingerprint, invoiceSourceFingerprint({ id: INVOICE, invoiceStatus: "past_due",
    totalCents: 30000, balanceCents: 13750, issuedDate: "2026-09-01", dueDate: "2026-10-01" }));
  assert.equal(prepared[0].opportunityId, creationPlaceholderId(INVOICE));
  assert.equal(prepared[0].cycle, undefined);
  assert.equal(prepared[0].bootstrap, undefined);
  assert.equal(prepared[0].workflowRemoval, undefined);
  // And the journal really holds it, confirmed.
  const journal = JSON.parse(fixture.rows[0].errorMessage.split("FLEX_GHL_WRITE_JOURNAL_V1:")[1]);
  assert.equal(journal.writes.length, 1);
  assert.equal(journal.writes[0].state, "confirmed");
});

test("a create is refused when a card for that invoice already exists live", async () => {
  const h = harness([], [openCard({ id: "card-elsewhere", pipelineStageId: STAGES.paid })]);
  const { result, reports } = await run(plan(create()), h);
  assert.equal(result.applied, 0);
  assert.deepEqual(h.posts, []);
  assert.equal(reports[0].reason, "a_card_for_this_invoice_already_exists");
});

test("a create is refused when an earlier run already claimed that invoice", async () => {
  const h = harness([], []);
  const { reports } = await run(plan(create()), h, { claimedInvoiceIds: new Set([INVOICE]) });
  assert.deepEqual(h.posts, []);
  assert.equal(reports[0].reason, "creation_already_claimed_for_this_invoice");
});

test("a create is refused when the contact's cards cannot be read completely", async () => {
  const h = harness([], []); h.listFails = true;
  const { result, reports } = await run(plan(create()), h);
  assert.deepEqual(h.posts, []);
  assert.equal(result.halted, false);
  assert.match(reports[0].reason, /^contact_card_read_failed/);
});

test("a create is refused when the invoice was paid or re-balanced since the plan", async () => {
  for (const over of [{ invoiceStatus: "paid", amounts: { total: 300, invoiceBalance: 0 } },
                      { amounts: { total: 300, invoiceBalance: 200 } }]) {
    const h = harness([], []);
    const { reports } = await run(plan(create()), h, { source: [invoice(over)] });
    assert.deepEqual(h.posts, []);
    assert.equal(reports[0].action, "hold");
  }
});

test("an adopt corrects the stage and amount and never sends a name", async () => {
  const h = harness([openCard({ pipelineStageId: STAGES.paid, monetaryValue: 0 })]);
  const { result, reports, prepared } = await run(
    plan(adopt({ changes: ["stage", "value"] })), h);
  assert.equal(result.applied, 1);
  assert.deepEqual(h.puts, [{ id: "card-1", stageId: STAGES.sent, monetaryValue: 137.5, name: undefined }]);
  assert.equal(prepared[0].target.updateName, false);
  assert.equal(prepared[0].target.nameHash, cardNameHash(NAME));
  assert.equal(reports[0].action, "applied");
});

test("a Paid exit writes a zero balance", async () => {
  const h = harness([openCard({ monetaryValue: 137.5 })]);
  const { result } = await run(plan(adopt({ stage: "Invoice Paid", monetaryValue: 0, changes: ["stage", "value"] })), h,
    { source: [invoice({ invoiceStatus: "paid", amounts: { total: 300, invoiceBalance: 0 } })] });
  assert.equal(result.applied, 1);
  assert.deepEqual(h.puts, [{ id: "card-1", stageId: STAGES.paid, monetaryValue: 0, name: undefined }]);
});

test("a Paid exit is held while settled invoices are out of scope", async () => {
  const h = harness([openCard({ monetaryValue: 137.5 })]);
  const { reports } = await run(plan(adopt({ stage: "Invoice Paid", monetaryValue: 0, changes: ["stage"] })), h,
    { allow: { paidExits: false } });
  assert.deepEqual(h.puts, []);
  assert.equal(reports[0].reason, "paid_invoices_are_out_of_scope_for_now");
});

test("an Overdue move, once allowed, really is written", async () => {
  const h = harness([openCard({ pipelineStageId: STAGES.sent, monetaryValue: 137.5 })]);
  const { result, reports } = await run(
    plan(adopt({ stage: "Invoice Overdue", desiredStage: "Invoice Overdue", changes: ["stage"] })), h,
    { allow: { overdueMoves: true } });
  assert.equal(result.applied, 1);
  assert.deepEqual(h.puts, [{ id: "card-1", stageId: STAGES.overdue, monetaryValue: 137.5, name: undefined }]);
  assert.match(reports[0].reason, /recorded proof the legacy workflow cannot send/);
});

test("an adopt is held when the card drifted since the plan was made", async () => {
  const h = harness([openCard({ monetaryValue: 55 })]);
  const { reports } = await run(plan(adopt()), h, {
    preflightCards: [openCard({ monetaryValue: 99 })],
  });
  assert.deepEqual(h.puts, []);
  assert.equal(reports[0].reason, "card_changed_since_the_plan_was_made");
});

test("an adopt is held when the card is no longer open, no longer ours, or elsewhere", async () => {
  for (const over of [{ status: "won" }, { contactId: "contact-2" }, { pipelineId: "pipeline-2" }]) {
    const h = harness([openCard(over)]);
    const { reports } = await run(plan(adopt()), h);
    assert.deepEqual(h.puts, []);
    assert.equal(reports[0].reason, "card_ownership_or_status_changed_before_write");
  }
});

test("an adopt is held when the card sits in a stage this writer does not own", async () => {
  const h = harness([openCard({ pipelineStageId: "stage-late-fee" })]);
  const { reports } = await run(plan(adopt()), h);
  assert.deepEqual(h.puts, []);
  assert.equal(reports[0].reason, "card_is_in_a_protected_or_unknown_stage");
});

test("an adopt is held when the name no longer names exactly this invoice", async () => {
  for (const name of ["Someone — 3 unpaid invoices", `Invoice #${NUMBER} and #7227`, "Invoice #9999 — Someone", null]) {
    const h = harness([openCard({ name })]);
    const { reports } = await run(plan(adopt()), h);
    assert.deepEqual(h.puts, []);
    assert.equal(reports[0].reason, "card_no_longer_names_exactly_this_invoice", String(name));
  }
});

test("an adopt whose fresh read already matches is not written again", async () => {
  const h = harness([openCard({ pipelineStageId: STAGES.sent, monetaryValue: 137.5 })]);
  const { result, reports } = await run(plan(adopt()), h);
  assert.equal(result.applied, 0);
  assert.deepEqual(h.puts, []);
  assert.equal(reports[0].action, "unchanged");
  assert.equal(reports[0].reason, "fresh_read_already_matches_the_target");
});

test("a failed read holds one card without halting the run", async () => {
  const h = harness([openCard()]); h.readFails = true;
  const { result, reports } = await run(plan(adopt()), h);
  assert.equal(result.halted, false);
  assert.match(reports[0].reason, /^fresh_card_read_failed/);
});

test("an unconfirmed write halts everything and blocks the run", async () => {
  const h = harness([openCard({ pipelineStageId: STAGES.paid, monetaryValue: 0 })]);
  h.putFails = true;
  const { result, reports, fixture } = await run(plan(adopt({ changes: ["stage", "value"] }), create()), h);
  assert.equal(result.applied, 0);
  assert.equal(result.halted, true);
  assert.equal(reports.length, 1, "the second action is never attempted");
  assert.equal(reports[0].action, "failed");
  assert.match(reports[0].reason, /remaining card writes halted/);
  assert.equal(fixture.rows[0].status, "blocked");
  assert.deepEqual(h.posts, []);
});

test("a readback that disagrees with what we asked for is a halt, not a success", async () => {
  const h = harness([openCard({ pipelineStageId: STAGES.paid, monetaryValue: 0 })]);
  // GHL accepts the PUT but lands the card somewhere else.
  const put = h.io.moveOpportunityToStage;
  h.io.moveOpportunityToStage = async (id, stageId, value, name) => {
    await put(id, stageId, value, name);
    h.cards.get(id)!.pipelineStageId = "stage-somewhere-else";
  };
  const { result, reports, fixture } = await run(plan(adopt({ changes: ["stage", "value"] })), h);
  assert.equal(result.applied, 0);
  assert.equal(result.halted, true);
  assert.match(reports[0].reason, /Post-write card state not confirmed/);
  assert.equal(fixture.rows[0].status, "blocked");
});

test("a created card that comes back wrong is a halt, not a success", async () => {
  const h = harness([], []);
  const post = h.io.createOpportunity;
  h.io.createOpportunity = async opts => {
    const made = await post(opts);
    h.cards.get(made.id)!.name = "Something else entirely";
    return made;
  };
  const { result, reports, fixture } = await run(plan(create()), h);
  assert.equal(result.applied, 0);
  assert.equal(result.halted, true);
  assert.match(reports[0].reason, /Created card state not confirmed/);
  assert.equal(fixture.rows[0].status, "blocked");
});

test("the run's write budget bounds how much one run can change", async () => {
  const h = harness([openCard({ pipelineStageId: STAGES.paid, monetaryValue: 0 }),
    openCard({ id: "card-2", name: "Invoice #7227 — Someone", pipelineStageId: STAGES.paid, monetaryValue: 0 })]);
  const spend = { remaining: 1 };
  const { result, reports } = await run(plan(
    adopt({ changes: ["stage", "value"] }),
    adopt({ cardId: "card-2", invoiceId: "invoice-2", invoiceNumber: "7227", changes: ["stage", "value"] }),
  ), h, { spend, source: [invoice(), invoice({ id: "invoice-2", invoiceNumber: "7227" })] });
  assert.equal(result.applied, 1);
  assert.equal(spend.remaining, 0);
  assert.equal(reports[1].action, "hold");
  assert.equal(reports[1].reason, "run_write_budget_exhausted");
  assert.equal(h.puts.length, 1);
});

test("an Overdue action with no recorded proof is held before anything is even read", async () => {
  const h = harness([openCard({ pipelineStageId: STAGES.sent, monetaryValue: 99 })]);
  const { result, reports } = await run(plan(adopt({ stage: "Invoice Overdue", desiredStage: "Invoice Overdue", changes: ["stage"] })), h);
  assert.equal(result.applied, 0);
  assert.deepEqual(h.puts, []);
  assert.deepEqual(h.reads, []);
  assert.equal(reports[0].reason, "overdue_move_needs_recorded_proof_the_legacy_workflow_is_off");
});

// --- the durable journal refuses a malformed creation claim ---------------

async function prepareCreation(mutate: (intent: GhlWriteIntent) => void) {
  const fixture = writerFixture();
  const row = { id: INVOICE, jobberClientId: CLIENT, invoiceStatus: "past_due", totalCents: 30000,
    balanceCents: 13750, issuedDate: "2026-09-01", createdAt: "2026-09-01", dueDate: "2026-10-01" };
  const intent: GhlWriteIntent = {
    creation: { version: 1, stageRole: "sent", locationId: LOCATION, pipelineId: PIPELINE, stageId: STAGES.sent,
      contactId: CONTACT, jobberClientId: CLIENT, invoiceId: INVOICE, invoiceNumber: NUMBER,
      nameHash: cardNameHash(NAME), amountCents: 13750, sourceFingerprint: invoiceSourceFingerprint(row) },
    approvalId: "reviewed-plan-1", pipelineId: PIPELINE, contactId: CONTACT,
    opportunityId: creationPlaceholderId(INVOICE), jobberClientId: CLIENT,
    expected: { stageId: STAGES.sent, status: "open", amountCents: 0, nameHash: cardNameHash(null) },
    target: { stageId: STAGES.sent, amountCents: 13750, nameHash: cardNameHash(NAME), updateName: true },
    source: { observedAt: "2026-11-20T09:00:00.000Z", storedInvoiceIds: [INVOICE], invoices: [row] },
  };
  mutate(intent);
  return fixture.writer.prepare(intent).then(() => "accepted" as const, () => "refused" as const);
}

test("a well-formed creation claim is accepted by the durable journal", async () => {
  assert.equal(await prepareCreation(() => {}), "accepted");
});

test("the journal refuses a creation claim that does not hold together", async () => {
  const cases: Array<[string, (i: GhlWriteIntent) => void]> = [
    ["another stage role", i => { (i.creation as any).stageRole = "overdue"; }],
    ["a different stage than the target", i => { i.target.stageId = STAGES.overdue; }],
    ["an opportunity id that is not the invoice's placeholder", i => { i.opportunityId = "card-1"; }],
    ["a name it does not claim", i => { i.target.nameHash = cardNameHash("Something else"); }],
    ["no intention to set the name", i => { i.target.updateName = false; }],
    ["money that disagrees with the invoice", i => { i.target.amountCents = 1; (i.creation as any).amountCents = 1; }],
    ["an expected state that is not empty", i => { i.expected.amountCents = 500; }],
    ["an expected name", i => { i.expected.nameHash = cardNameHash(NAME); }],
    ["a paid invoice", i => { i.source.invoices[0].invoiceStatus = "paid"; i.source.invoices[0].balanceCents = 0; }],
    ["a source fingerprint for different facts", i => { (i.creation as any).sourceFingerprint = cardNameHash("x"); }],
    ["an invoice it cannot see", i => { (i.creation as any).invoiceId = "invoice-elsewhere"; }],
    ["no approval token", i => { delete i.approvalId; }],
    ["a contact that disagrees", i => { (i.creation as any).contactId = "contact-2"; }],
    ["a pipeline that disagrees", i => { (i.creation as any).pipelineId = "pipeline-2"; }],
    ["a zero balance", i => { (i.creation as any).amountCents = 0; i.target.amountCents = 0; i.source.invoices[0].balanceCents = 0; }],
    ["an enrollment riding along", i => { (i as any).cycle = { version: 1, locationId: LOCATION, workflowId: "w", invoiceId: INVOICE, dueOn: "2026-10-01", phase: "enroll" }; }],
    ["more than one stored invoice", i => { i.source.storedInvoiceIds = [INVOICE, "invoice-2"]; }],
  ];
  for (const [label, mutate] of cases) {
    assert.equal(await prepareCreation(mutate), "refused", label);
  }
});

test("the journal refuses a second claim for an invoice it already claimed", async () => {
  const fixture = writerFixture();
  const row = { id: INVOICE, jobberClientId: CLIENT, invoiceStatus: "past_due", totalCents: 30000,
    balanceCents: 13750, issuedDate: "2026-09-01", createdAt: "2026-09-01", dueDate: "2026-10-01" };
  const intent = (): GhlWriteIntent => ({
    creation: { version: 1, stageRole: "sent", locationId: LOCATION, pipelineId: PIPELINE, stageId: STAGES.sent,
      contactId: CONTACT, jobberClientId: CLIENT, invoiceId: INVOICE, invoiceNumber: NUMBER,
      nameHash: cardNameHash(NAME), amountCents: 13750, sourceFingerprint: invoiceSourceFingerprint(row) },
    approvalId: "reviewed-plan-1", pipelineId: PIPELINE, contactId: CONTACT,
    opportunityId: creationPlaceholderId(INVOICE), jobberClientId: CLIENT,
    expected: { stageId: STAGES.sent, status: "open", amountCents: 0, nameHash: cardNameHash(null) },
    target: { stageId: STAGES.sent, amountCents: 13750, nameHash: cardNameHash(NAME), updateName: true },
    source: { observedAt: "2026-11-20T09:00:00.000Z", storedInvoiceIds: [INVOICE], invoices: [row] },
  });
  const first = await fixture.writer.prepare(intent());
  await fixture.writer.confirm(first);
  await assert.rejects(() => fixture.writer.prepare(intent()));
});
