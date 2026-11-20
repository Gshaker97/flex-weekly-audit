import test from "node:test";
import assert from "node:assert/strict";
import {
  planInvoiceCards, desiredStageForInvoice, legacySendingIsOff, invoiceNumbersInCardName,
  STAGE_SENT, STAGE_OVERDUE, STAGE_PAID, PROTECTED_STAGES,
  type InvoiceCardInput, type InvoiceFact, type ExistingCard, type LegacySendingEvidence,
} from "../lib/ghl-invoice-card-plan";

/**
 * One card per invoice, with one writer.
 *
 * The two properties that matter most, and that these tests exist to stop
 * sliding back:
 *   1. a card already named "#7226" is adopted, never renamed - otherwise our
 *      sync and the owner's Zaps overwrite each other forever;
 *   2. nothing moves INTO "Invoice Overdue" until the legacy workflow's sending
 *      is proven off, because that move can enrol a customer and text them
 *      about an invoice months old.
 */

const WORKFLOW = "3beac037-e7c5-461f-bcef-688e7f8f7010";
const OFF: LegacySendingEvidence = {
  source: "operator-confirmed-workflow-sending-disabled", workflowId: WORKFLOW,
  disabledOn: "2026-11-20", observedAt: "2026-11-20T16:00:00.000Z", evidenceRef: "owner-2026-11-20",
};
const NOW = new Date("2026-11-20T17:00:00.000Z");

const invoice = (over: Partial<InvoiceFact> = {}): InvoiceFact => ({
  invoiceId: "inv-1", invoiceNumber: "7226", status: "awaiting_payment",
  totalDollars: 137, balanceDollars: 137, issuedDate: "2026-10-01", dueDate: "2026-10-15", ...over,
});
const card = (over: Partial<ExistingCard> = {}): ExistingCard => ({
  id: "card-1", name: "Someone - invoice #7226", stageName: STAGE_SENT, status: "open", monetaryValue: 137, ...over,
});
const openClock = { daysPastDue: 0, isOverdue: false, sentOn: "2026-10-01" };
const overdueClock = { daysPastDue: 36, isOverdue: true, sentOn: "2026-10-01" };

const plan = (over: Partial<InvoiceCardInput> = {}) => planInvoiceCards({
  contactId: "contact-1", label: "Someone", invoices: [invoice()], cards: [card()],
  clocks: { "inv-1": openClock }, legacyWorkflowId: WORKFLOW, now: NOW, ...over,
});

// ------------------------------------------------- adopt, never rename

test("a card that already names the invoice is ADOPTED, not renamed", () => {
  const p = plan({ cards: [card({ name: "Zapier made this #7226", monetaryValue: 99 })] });
  assert.equal(p.actions.length, 1);
  const a = p.actions[0];
  assert.equal(a.state, "adopt");
  if (a.state !== "adopt") return;
  assert.equal(a.cardId, "card-1");
  assert.equal(a.monetaryValue, 137);
  assert.deepEqual([...a.changes], ["value"]);
  // No "name" anywhere in an adopt action: it cannot rename.
  assert.ok(!("name" in a), "adopt must carry no name");
});

test("the amount is corrected to the live balance and the stage to the live status", () => {
  const p = plan({ invoices: [invoice({ status: "paid", balanceDollars: 0 })],
    cards: [card({ stageName: STAGE_SENT, monetaryValue: 137 })] });
  const a = p.actions[0];
  assert.equal(a.state, "adopt");
  if (a.state !== "adopt") return;
  assert.equal(a.stage, STAGE_PAID);
  assert.equal(a.monetaryValue, 0);
  assert.deepEqual([...a.changes].sort(), ["stage", "value"]);
});

test("a card already correct is adopted with no changes", () => {
  const p = plan();
  const a = p.actions[0];
  assert.equal(a.state === "adopt" && a.changes.length, 0);
});

test("a card is matched by the invoice number anywhere in its name", () => {
  for (const name of ["#7226", "Invoice #7226 - Someone", "Someone #7226 (late)", "x # 7226 y"]) {
    const p = plan({ cards: [card({ name })] });
    assert.equal(p.actions[0].state, "adopt", name);
  }
});

test("a different invoice number is not a match, so a card is created instead", () => {
  const p = plan({ cards: [card({ name: "Someone - invoice #9999" })] });
  assert.equal(p.actions[0].state, "create");
  assert.deepEqual([...p.untouched], [{ cardId: "card-1", reason: "card_names_an_invoice_we_cannot_see" }]);
});

test("two cards naming one invoice is an ambiguity, not a race to pick one", () => {
  const p = plan({ cards: [card({ id: "a" }), card({ id: "b", name: "dup #7226" })] });
  assert.equal(p.actions[0].state, "hold");
  assert.ok(p.actions[0].reasons.includes("multiple_cards_name_this_invoice"));
});

// ------------------------------------------------- the Overdue gate

test("an overdue invoice does NOT move into Overdue while the legacy workflow can send", () => {
  const p = plan({ clocks: { "inv-1": overdueClock }, cards: [card({ stageName: STAGE_SENT })] });
  const a = p.actions[0];
  assert.equal(a.state, "adopt");
  if (a.state !== "adopt") return;
  assert.equal(a.desiredStage, STAGE_OVERDUE, "the evidence still says Overdue");
  assert.equal(a.stage, STAGE_SENT, "but it stays where it is");
  assert.ok(!a.changes.includes("stage"));
  assert.ok(a.reasons.includes("overdue_move_withheld_until_legacy_workflow_sending_is_off"));
});

test("with proof the workflow's sending is off, the Overdue move is allowed", () => {
  const p = plan({ clocks: { "inv-1": overdueClock }, cards: [card({ stageName: STAGE_SENT })], legacySending: OFF });
  const a = p.actions[0];
  assert.equal(a.state === "adopt" && a.stage, STAGE_OVERDUE);
  assert.ok(a.state === "adopt" && a.changes.includes("stage"));
  assert.deepEqual(a.state === "adopt" ? [...a.reasons] : ["x"], []);
});

test("a NEW card for an overdue invoice is created in Sent, never Overdue", () => {
  const p = plan({ clocks: { "inv-1": overdueClock }, cards: [], legacySending: OFF });
  const a = p.actions[0];
  assert.equal(a.state, "create");
  if (a.state !== "create") return;
  assert.equal(a.desiredStage, STAGE_OVERDUE);
  assert.equal(a.stage, STAGE_SENT, "a card appearing in Overdue is itself an enrollment");
  assert.ok(a.reasons.includes("created_in_sent_not_overdue_to_avoid_legacy_enrollment"));
});

test("moving to Paid or Sent is never gated: neither can enrol anyone", () => {
  const paid = plan({ invoices: [invoice({ status: "paid", balanceDollars: 0 })], cards: [card({ stageName: STAGE_OVERDUE })] });
  assert.equal(paid.actions[0].state === "adopt" && paid.actions[0].stage, STAGE_PAID);
  const sent = plan({ cards: [card({ stageName: STAGE_PAID })] });
  assert.equal(sent.actions[0].state === "adopt" && sent.actions[0].stage, STAGE_SENT);
});

test("only evidence about THIS workflow, in the past, opens the gate", () => {
  assert.equal(legacySendingIsOff(OFF, WORKFLOW, NOW), true);
  assert.equal(legacySendingIsOff(OFF, "another-workflow", NOW), false);
  assert.equal(legacySendingIsOff(null, WORKFLOW, NOW), false);
  assert.equal(legacySendingIsOff(undefined, WORKFLOW, NOW), false);
  assert.equal(legacySendingIsOff({ ...OFF, source: "i_turned_it_off" } as never, WORKFLOW, NOW), false);
  assert.equal(legacySendingIsOff({ ...OFF, evidenceRef: "" }, WORKFLOW, NOW), false);
  assert.equal(legacySendingIsOff({ ...OFF, disabledOn: "20/11/2026" }, WORKFLOW, NOW), false);
  assert.equal(legacySendingIsOff({ ...OFF, observedAt: "not a time" }, WORKFLOW, NOW), false);
  assert.equal(legacySendingIsOff({ ...OFF, observedAt: "2026-11-21T00:00:00.000Z" }, WORKFLOW, NOW), false);
});

// ------------------------------------------------- what it refuses to touch

test("our own per-customer cards are left alone, flagged for retiring", () => {
  const p = plan({ cards: [card({ id: "old", name: "Someone - 3 overdue invoices" })] });
  assert.equal(p.actions[0].state, "create", "the invoice still gets its own card");
  assert.deepEqual([...p.untouched], [{ cardId: "old", reason: "legacy_per_customer_card_needs_retiring" }]);
});

test("a bare-name card is left alone", () => {
  const p = plan({ cards: [card({ id: "bare", name: "Someone" })] });
  assert.deepEqual([...p.untouched], [{ cardId: "bare", reason: "card_is_not_tied_to_an_invoice" }]);
});

test("a card in a protected stage is never moved out of it", () => {
  for (const stage of PROTECTED_STAGES) {
    const p = plan({ cards: [card({ stageName: stage })] });
    assert.equal(p.actions[0].state, "hold", stage);
    assert.ok(p.actions[0].reasons.includes("card_is_in_a_protected_stage"), stage);
  }
});

test("a closed card is never reopened", () => {
  for (const status of ["won", "lost", "abandoned", ""]) {
    const p = plan({ cards: [card({ status })] });
    assert.equal(p.actions[0].state, "hold", status);
    assert.ok(p.actions[0].reasons.includes("card_is_not_open_and_is_never_reopened"), status);
  }
});

// ------------------------------------------------- identity and scope

test("an invoice with no readable number is held: the number is the only link", () => {
  for (const n of [null, "", "   "]) {
    const p = plan({ invoices: [invoice({ invoiceNumber: n })] });
    assert.equal(p.actions[0].state, "hold");
    assert.ok(p.actions[0].reasons.includes("invoice_number_missing"));
  }
});

test("a number shared by two invoices cannot identify a card", () => {
  const p = plan({ invoices: [invoice({ invoiceId: "a" }), invoice({ invoiceId: "b" })],
    clocks: { a: openClock, b: openClock } });
  assert.equal(p.actions.length, 2);
  for (const a of p.actions) assert.ok(a.reasons.includes("invoice_number_is_not_unique"));
});

test("an invoice before the collections cutoff is skipped, not held", () => {
  const p = plan({ clocks: { "inv-1": { ...openClock, sentOn: "2025-12-31" } } });
  assert.equal(p.actions[0].state, "skip");
  assert.ok(p.actions[0].reasons.includes("before_collections_cutoff"));
});

test("a paid invoice with no card needs none", () => {
  const p = plan({ invoices: [invoice({ status: "paid", balanceDollars: 0 })], cards: [] });
  assert.equal(p.actions[0].state, "skip");
  assert.ok(p.actions[0].reasons.includes("paid_invoice_needs_no_card"));
});

test("a balance that is not a whole number of dollars is carried exactly", () => {
  const p = plan({ invoices: [invoice({ totalDollars: 137.5, balanceDollars: 137.5 })] });
  assert.equal(p.actions[0].state === "adopt" && p.actions[0].monetaryValue, 137.5);
});

// ------------------------------------------------- the stage rules themselves

test("each invoice's own facts pick its stage", () => {
  const s = (over: Partial<InvoiceFact>, clock = openClock) => desiredStageForInvoice(invoice(over), clock);
  assert.deepEqual(s({ status: "paid", balanceDollars: 0 }), { stage: STAGE_PAID, balance: 0 });
  assert.deepEqual(s({}), { stage: STAGE_SENT, balance: 137 });
  assert.deepEqual(s({}, overdueClock), { stage: STAGE_OVERDUE, balance: 137 });
  assert.deepEqual(s({ status: "past_due" }, overdueClock), { stage: STAGE_OVERDUE, balance: 137 });
});

test("contradictory, void, zero and unusable invoices support no stage", () => {
  const s = (over: Partial<InvoiceFact>, clock: typeof openClock | null = openClock) =>
    desiredStageForInvoice(invoice(over), clock);
  assert.equal(s({ status: "past_due" }).stage, null, "past_due before its own due date");
  assert.match((s({ status: "past_due" }) as { reason: string }).reason, /contradicts/);
  assert.equal(s({ status: "void" }).stage, null);
  assert.equal(s({ status: null }).stage, null);
  assert.equal(s({ totalDollars: 0, balanceDollars: 0 }).stage, null);
  assert.equal(s({ balanceDollars: 500 }).stage, null, "balance over total");
  assert.equal(s({ totalDollars: null }).stage, null);
  assert.equal(s({ balanceDollars: 0.001 }).stage, null, "sub-cent");
  assert.equal(s({}, null).stage, null, "no clock");
});

// ------------------------------------------------- shape of the result

test("the summary counts what the actions actually say", () => {
  const p = planInvoiceCards({
    contactId: "contact-1", label: "Someone", legacyWorkflowId: WORKFLOW, now: NOW,
    invoices: [invoice({ invoiceId: "a", invoiceNumber: "1001" }),
               invoice({ invoiceId: "b", invoiceNumber: "1002" }),
               invoice({ invoiceId: "c", invoiceNumber: null }),
               invoice({ invoiceId: "d", invoiceNumber: "1004", status: "paid", balanceDollars: 0 })],
    cards: [card({ id: "c1", name: "x #1001" }), card({ id: "bare", name: "Someone" })],
    clocks: { a: openClock, b: openClock, c: openClock, d: openClock },
  });
  assert.deepEqual(p.summary, { adopt: 1, create: 1, hold: 1, skip: 1, untouched: 1 });
  assert.equal(p.actions.length, p.summary.adopt + p.summary.create + p.summary.hold + p.summary.skip);
});

test("invoice numbers are read out of a card name, deduplicated", () => {
  assert.deepEqual([...invoiceNumbersInCardName("a #7226 b #7226 c #9001")], ["7226", "9001"]);
  assert.deepEqual([...invoiceNumbersInCardName("no numbers here")], []);
  assert.deepEqual([...invoiceNumbersInCardName("#12")], [], "too short to be an invoice number");
  assert.deepEqual([...invoiceNumbersInCardName(null)], []);
});

test("a malformed input plans nothing rather than throwing", () => {
  for (const bad of [null, undefined, 42, "cards", { contactId: "c" }]) {
    const p = planInvoiceCards(bad as never);
    assert.equal(p.actions.length, 0);
    assert.deepEqual(p.summary, { adopt: 0, create: 0, hold: 0, skip: 0, untouched: 0 });
  }
});

test("a new card's name carries the invoice number and no contact detail", () => {
  const p = plan({ cards: [] });
  const a = p.actions[0];
  assert.equal(a.state === "create" && a.name, "Someone - invoice #7226");
  assert.ok(!JSON.stringify(p).includes("@"));
});
