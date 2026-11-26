import test from "node:test";
import assert from "node:assert/strict";
import {
  planInvoiceCards, desiredStageForInvoice, legacySendingIsOff, invoiceNumbersInCardName,
  STAGE_SENT, STAGE_OVERDUE, STAGE_PAID, PROTECTED_STAGES, invoiceCardName,
  COLLECTIONS_CUTOFF, DEFAULT_LOOKBACK_MONTHS, invoiceWindowStart, overdueMoveIsHeldByOwner,
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

test("a card naming an invoice we cannot see blocks a second card for this contact", () => {
  // GoHighLevel refuses a second opportunity for a contact that already has
  // one, so planning a creation here would be planning a 400. And the card
  // cannot be shared either: its name says #9999, so writing this invoice's
  // money onto it would leave the name describing a different invoice.
  const p = plan({ cards: [card({ name: "Someone - invoice #9999" })] });
  assert.equal(p.actions[0].state, "hold");
  assert.ok(p.actions[0].reasons.includes("contact_already_has_a_card_so_no_second_card_can_be_created"));
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

test("our own per-customer card is ADOPTED for the invoice, not left behind", () => {
  // Changed by the account owner on 2026-11-25. Creating this invoice its own
  // card is impossible - GoHighLevel refuses a second one for the contact - so
  // the card that is already there is taken over instead of being flagged for
  // retirement and ignored.
  const p = plan({ cards: [card({ id: "old", name: "Someone - 3 overdue invoices", monetaryValue: 400 })] });
  assert.equal(p.actions.length, 1);
  const a = p.actions[0];
  assert.equal(a.state, "combine");
  if (a.state !== "combine") return;
  assert.equal(a.cardId, "old");
  assert.deepEqual([...a.invoiceNumbers], ["7226"]);
  assert.equal(a.monetaryValue, 137, "the amount becomes what is actually owed");
  assert.deepEqual([...a.changes], ["value"]);
  assert.ok(!("name" in a), "a combine must carry no name");
  assert.deepEqual([...p.untouched], [], "an adopted card is not also untouched");
});

test("a bare-name card is adopted too", () => {
  const p = plan({ cards: [card({ id: "bare", name: "Someone" })] });
  assert.equal(p.actions[0].state, "combine");
  assert.deepEqual([...p.untouched], []);
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

test("an invoice older than the window is skipped, not held", () => {
  const p = plan({ clocks: { "inv-1": { ...openClock, sentOn: "2025-12-31" } } });
  assert.equal(p.actions[0].state, "skip");
  assert.ok(p.actions[0].reasons.includes("outside_the_lookback_window"));
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

// Both of these were found on live invoices. Neither changes what happens to a
// card - the invoice is held exactly as before - but a hold nobody can read is
// a hold nobody can act on, so each contradiction now names itself.
test("a paid label over an outstanding balance names the contradiction", () => {
  const out = desiredStageForInvoice(
    invoice({ status: "paid", totalDollars: 60, balanceDollars: 60 }), openClock);
  assert.equal(out.stage, null, "still held: not chased, not zeroed");
  assert.equal((out as { reason: string }).reason, "paid_label_contradicts_the_outstanding_balance");

  // The settled case is untouched, and a part-paid invoice still reads as one.
  assert.deepEqual(desiredStageForInvoice(
    invoice({ status: "paid", totalDollars: 60, balanceDollars: 0 }), openClock),
    { stage: STAGE_PAID, balance: 0 });
  assert.equal(desiredStageForInvoice(
    invoice({ status: "paid", totalDollars: 60, balanceDollars: 0.5 }), openClock).stage, null);
});

test("a draft is held as a draft, not as broken dates", () => {
  // A real one: a draft carrying a balance with no issue or due date at all.
  const out = desiredStageForInvoice(
    invoice({ status: "draft", totalDollars: 85, balanceDollars: 85 }), null);
  assert.equal(out.stage, null, "a draft owes nothing yet");
  assert.equal((out as { reason: string }).reason, "draft_invoice_not_yet_issued");

  // Named by its status even when it does have a clock, so the reason does not
  // depend on which fields happen to be filled in.
  assert.equal((desiredStageForInvoice(
    invoice({ status: "draft" }), openClock) as { reason: string }).reason,
    "draft_invoice_not_yet_issued");

  // And a genuinely unreadable date on a non-draft still says so.
  assert.equal((desiredStageForInvoice(
    invoice({ status: "awaiting_payment" }), null) as { reason: string }).reason,
    "invoice_dates_unusable");
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
  // Invoice "c" has no number, so this customer has an invoice whose standing
  // could not be read. The orphan #1002 is therefore held rather than shared
  // onto the bare card: a combined amount that silently leaves out an invoice
  // nobody could read would be wrong on the board and wrong in the journal.
  assert.deepEqual(p.summary, { adopt: 1, combine: 0, create: 0, hold: 2, skip: 1, untouched: 1 });
  assert.ok(p.actions.some(a => a.state === "hold" && a.invoiceNumber === "1002"
    && a.reasons.includes("another_invoice_for_this_customer_could_not_be_read")));
  assert.equal(p.actions.length,
    p.summary.adopt + p.summary.combine + p.summary.create + p.summary.hold + p.summary.skip);
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
    assert.deepEqual(p.summary, { adopt: 0, combine: 0, create: 0, hold: 0, skip: 0, untouched: 0 });
  }
});

test("a new card is named the way this sync has always named them", () => {
  // `Invoice #7226 \u2014 Someone` is the exact format opportunityName() produced
  // from 2026-06-19 until creation was removed on 2026-11-06, and the 39 cards
  // still on the board read this way. A new card must be indistinguishable from
  // them, or the next run will not match its own work.
  const p = plan({ cards: [] });
  const a = p.actions[0];
  assert.equal(a.state === "create" && a.name, "Invoice #7226 \u2014 Someone");
  assert.equal(invoiceCardName("7226", "Someone"), "Invoice #7226 \u2014 Someone");
  assert.equal(invoiceCardName(" 7226 ", "  Someone  "), "Invoice #7226 \u2014 Someone");
  assert.ok(!JSON.stringify(p).includes("@"));
});

test("a card this plan creates is one the NEXT run can find again", () => {
  // The round trip that makes adopt-not-overwrite work at all.
  const created = invoiceCardName("7226", "Someone");
  assert.deepEqual([...invoiceNumbersInCardName(created)], ["7226"]);
  const next = plan({ cards: [card({ name: created })] });
  assert.equal(next.actions[0].state, "adopt");
});

// --- the rolling lookback window -----------------------------------------

test("the window is four calendar months back from today", () => {
  assert.equal(invoiceWindowStart(new Date("2026-11-20T19:00:00Z")), "2026-07-20");
  assert.equal(invoiceWindowStart(new Date("2027-03-15T00:00:00Z")), "2026-11-15");
});

test("the window clamps to the last day of a shorter month", () => {
  // Four months back from 31 October is 30 June, not 1 July.
  assert.equal(invoiceWindowStart(new Date("2026-10-31T12:00:00Z")), "2026-06-30");
  // And from 31 December it is 31 August, which does have a 31st.
  assert.equal(invoiceWindowStart(new Date("2026-12-31T12:00:00Z")), "2026-08-31");
  // Leap-year February, four months on from 29 February 2028.
  assert.equal(invoiceWindowStart(new Date("2028-06-29T12:00:00Z"), 4), "2028-02-29");
  assert.equal(invoiceWindowStart(new Date("2028-06-30T12:00:00Z"), 4), "2028-02-29");
});

test("the window never reaches back past the Collections cutoff", () => {
  // A 60-month lookback would be 2021, which is not on the table.
  assert.equal(invoiceWindowStart(new Date("2026-11-20T00:00:00Z"), 60), COLLECTIONS_CUTOFF);
  assert.equal(invoiceWindowStart(new Date("2026-03-01T00:00:00Z"), 4), COLLECTIONS_CUTOFF);
});

test("a nonsense window falls back to the cutoff, never to no window at all", () => {
  for (const months of [0, -1, 0.5, Number.NaN, 121, Infinity]) {
    assert.equal(invoiceWindowStart(new Date("2026-11-20T00:00:00Z"), months), COLLECTIONS_CUTOFF, String(months));
  }
  assert.equal(invoiceWindowStart(new Date("not a date")), COLLECTIONS_CUTOFF);
});

test("an invoice issued before the window is out of scope, not held as a fault", () => {
  const clock = { daysPastDue: 200, isOverdue: true, sentOn: "2026-03-01" };
  const out = desiredStageForInvoice(
    { invoiceId: "i", invoiceNumber: "7000", status: "past_due", totalDollars: 100,
      balanceDollars: 100, issuedDate: "2026-03-01", dueDate: "2026-04-01" }, clock, "2026-07-20");
  assert.deepEqual(out, { stage: null, reason: "outside_the_lookback_window" });
});

test("an invoice inside the window keeps its stage", () => {
  const clock = { daysPastDue: 40, isOverdue: true, sentOn: "2026-09-01" };
  const out = desiredStageForInvoice(
    { invoiceId: "i", invoiceNumber: "7000", status: "past_due", totalDollars: 100,
      balanceDollars: 100, issuedDate: "2026-09-01", dueDate: "2026-10-01" }, clock, "2026-07-20");
  assert.deepEqual(out, { stage: "Invoice Overdue", balance: 100 });
});

test("a malformed window is treated as the widest SAFE boundary, not as no boundary", () => {
  const facts = { invoiceId: "i", invoiceNumber: "7000", status: "past_due" as const, totalDollars: 100,
    balanceDollars: 100, issuedDate: "2025-06-01", dueDate: "2025-07-01" };
  const clock = { daysPastDue: 500, isOverdue: true, sentOn: "2025-06-01" };
  for (const window of ["", "yesterday", "2025-01-01", "20260720"]) {
    // 2025 is before the Collections cutoff either way, so it stays out.
    assert.deepEqual(desiredStageForInvoice(facts, clock, window),
      { stage: null, reason: "outside_the_lookback_window" }, window);
  }
});

test("the plan skips an out-of-window invoice and creates nothing for it", () => {
  const result = planInvoiceCards({
    contactId: "contact-1", label: "Someone", legacyWorkflowId: "w", windowStart: "2026-07-20",
    now: new Date("2026-11-20T19:00:00Z"),
    invoices: [{ invoiceId: "old", invoiceNumber: "6000", status: "past_due", totalDollars: 100,
      balanceDollars: 100, issuedDate: "2026-02-01", dueDate: "2026-03-01" }],
    cards: [],
    clocks: { old: { daysPastDue: 260, isOverdue: true, sentOn: "2026-02-01" } },
  });
  assert.deepEqual(result.summary, { adopt: 0, combine: 0, create: 0, hold: 0, skip: 1, untouched: 0 });
  assert.deepEqual(result.actions[0], { state: "skip", invoiceId: "old", invoiceNumber: "6000",
    reasons: ["outside_the_lookback_window"] });
});

// ------------------------------------------------- taking over a combined card
//
// Added 2026-11-25 at the account owner's instruction. GoHighLevel rejects a
// second opportunity for a contact that already has one, so for any customer
// who already has a card, one-card-per-invoice is unreachable and refusing to
// touch their card keeps their invoices off the board entirely. These tests fix
// what "taking it over" is allowed to mean.

/** Elizabeth Brungs's real card, 2026-11-25: one card, two invoices. */
const BRUNGS = "Elizabeth Brungs — 2 unpaid invoices, $487.00 · #7286 $137.00 due 2026-11-18 · #7304 $350.00 due 2026-11-19";
const two = (over: Partial<InvoiceCardInput> = {}) => planInvoiceCards({
  contactId: "contact-1", label: "Elizabeth Brungs", legacyWorkflowId: WORKFLOW, now: NOW,
  invoices: [
    invoice({ invoiceId: "i-7286", invoiceNumber: "7286", status: "past_due", totalDollars: 137, balanceDollars: 137 }),
    invoice({ invoiceId: "i-7304", invoiceNumber: "7304", status: "past_due", totalDollars: 350, balanceDollars: 350 }),
  ],
  cards: [card({ id: "brungs", name: BRUNGS, stageName: STAGE_SENT, monetaryValue: 487 })],
  clocks: { "i-7286": overdueClock, "i-7304": overdueClock },
  legacySending: OFF, ...over,
});

test("a card naming two invoices becomes ONE action covering both", () => {
  const p = two();
  assert.equal(p.actions.length, 1, "one card, one write");
  const a = p.actions[0];
  assert.equal(a.state, "combine");
  if (a.state !== "combine") return;
  assert.equal(a.cardId, "brungs");
  assert.deepEqual([...a.invoiceIds], ["i-7286", "i-7304"]);
  assert.deepEqual([...a.invoiceNumbers], ["7286", "7304"]);
  assert.equal(a.monetaryValue, 487, "the amount is the sum of both balances");
  assert.equal(a.stage, STAGE_OVERDUE, "either invoice being overdue makes the card overdue");
  assert.deepEqual([...a.changes], ["stage"]);
  assert.ok(!("name" in a), "a combine must carry no name");
  assert.deepEqual([...p.untouched], [], "the adopted card is not also reported untouched");
});

test("the combined amount is the sum in cents, never a float sum", () => {
  const p = two({ invoices: [
    invoice({ invoiceId: "i-7286", invoiceNumber: "7286", status: "past_due", totalDollars: 0.1, balanceDollars: 0.1 }),
    invoice({ invoiceId: "i-7304", invoiceNumber: "7304", status: "past_due", totalDollars: 0.2, balanceDollars: 0.2 }),
  ] });
  const a = p.actions[0];
  assert.equal(a.state, "combine");
  if (a.state !== "combine") return;
  assert.equal(a.monetaryValue, 0.3, "0.1 + 0.2 must be 0.3, not 0.30000000000000004");
});

test("a combined card still waits for proof the legacy workflow cannot send", () => {
  const p = two({ legacySending: null });
  const a = p.actions[0];
  assert.equal(a.state, "combine");
  if (a.state !== "combine") return;
  assert.equal(a.desiredStage, STAGE_OVERDUE, "the evidence still says overdue");
  assert.equal(a.stage, STAGE_SENT, "but it is not moved there");
  assert.ok(a.reasons.includes("overdue_move_withheld_until_legacy_workflow_sending_is_off"));
});

test("a settled invoice on a combined card is accounted for, not added to the total", () => {
  const p = two({ invoices: [
    invoice({ invoiceId: "i-7286", invoiceNumber: "7286", status: "paid", totalDollars: 137, balanceDollars: 0 }),
    invoice({ invoiceId: "i-7304", invoiceNumber: "7304", status: "past_due", totalDollars: 350, balanceDollars: 350 }),
  ] });
  const combined = p.actions.find(a => a.state === "combine");
  assert.ok(combined && combined.state === "combine");
  if (!combined || combined.state !== "combine") return;
  assert.equal(combined.monetaryValue, 350, "only what is still owed");
  assert.deepEqual([...combined.invoiceNumbers], ["7304"]);
  assert.ok(p.actions.some(a => a.state === "skip" && a.invoiceNumber === "7286"
    && a.reasons.includes("paid_invoice_is_covered_by_a_shared_card")));
});

test("a combined card naming an invoice this plan cannot see is left alone", () => {
  // Its name claims #9999 too, and nothing here can say what #9999 owes, so
  // any total written onto this card could be missing that invoice's money.
  const p = two({ cards: [card({ id: "brungs", name: "Someone — #7286, #7304, #9999", monetaryValue: 487 })] });
  assert.equal(p.actions.length, 2);
  for (const a of p.actions) {
    assert.equal(a.state, "hold");
    assert.ok(a.reasons.includes("shared_card_names_an_invoice_this_plan_cannot_account_for"));
  }
});

test("a combined card in a protected stage or closed is never written", () => {
  for (const stage of PROTECTED_STAGES) {
    const p = two({ cards: [card({ id: "brungs", name: BRUNGS, stageName: stage })] });
    assert.ok(p.actions.every(a => a.state === "hold"), stage);
    assert.ok(p.actions[0].reasons.includes("shared_card_is_in_a_protected_stage"), stage);
  }
  for (const status of ["won", "lost", "", null]) {
    const p = two({ cards: [card({ id: "brungs", name: BRUNGS, status })] });
    assert.ok(p.actions.every(a => a.state === "hold"), String(status));
    assert.ok(p.actions[0].reasons.includes("shared_card_is_not_open_and_is_never_reopened"), String(status));
  }
});

test("invoices with no card share the customer's one unnamed card", () => {
  const p = two({ cards: [card({ id: "agg", name: "Elizabeth Brungs — 2 unpaid invoices", monetaryValue: 0 })] });
  assert.equal(p.actions.length, 1);
  const a = p.actions[0];
  assert.equal(a.state, "combine");
  if (a.state !== "combine") return;
  assert.equal(a.cardId, "agg");
  assert.deepEqual([...a.invoiceNumbers], ["7286", "7304"]);
  assert.equal(a.monetaryValue, 487);
  assert.deepEqual([...a.changes].sort(), ["stage", "value"]);
});

test("an invoice is never folded into a card that names a DIFFERENT invoice", () => {
  // #7286 has its own card. #7304 must not be written onto it: the card would
  // read "Invoice #7286" while carrying both invoices' money.
  const p = two({ cards: [card({ id: "own", name: "Invoice #7286 — Elizabeth Brungs", monetaryValue: 137 })] });
  const adopt = p.actions.find(a => a.state === "adopt");
  assert.ok(adopt, "#7286 keeps its own card");
  assert.equal(adopt?.state === "adopt" ? adopt.cardId : null, "own");
  const held = p.actions.find(a => a.state === "hold");
  assert.ok(held, "#7304 is held, not folded in");
  assert.equal(held?.invoiceNumber, "7304");
  assert.ok(held?.reasons.includes("contact_already_has_a_card_so_no_second_card_can_be_created"));
  assert.ok(!p.actions.some(a => a.state === "combine"));
});

test("two cards that could both stand for the invoices is an ambiguity", () => {
  const p = two({ cards: [card({ id: "a", name: "Elizabeth Brungs" }), card({ id: "b", name: "Brungs residence" })] });
  assert.equal(p.actions.length, 2);
  for (const a of p.actions) {
    assert.equal(a.state, "hold");
    assert.ok(a.reasons.includes("several_cards_could_stand_for_this_customers_invoices"));
  }
});

test("a contact with no card at all still gets cards created, one per invoice", () => {
  const p = two({ cards: [] });
  assert.equal(p.actions.length, 2);
  for (const a of p.actions) assert.equal(a.state, "create");
  assert.deepEqual(p.actions.map(a => a.state === "create" ? a.name : null),
    ["Invoice #7286 — Elizabeth Brungs", "Invoice #7304 — Elizabeth Brungs"]);
  assert.ok(p.actions.every(a => a.state === "create" && a.stage === STAGE_SENT),
    "and still in Sent, never straight into Overdue");
});

test("a card is adopted for one invoice when that is all the customer owes", () => {
  const p = two({
    invoices: [invoice({ invoiceId: "i-7286", invoiceNumber: "7286", status: "past_due", balanceDollars: 137, totalDollars: 137 })],
    clocks: { "i-7286": overdueClock },
    cards: [card({ id: "agg", name: "Elizabeth Brungs — 1 overdue invoice", monetaryValue: 137, stageName: STAGE_SENT })],
  });
  assert.equal(p.actions.length, 1);
  const a = p.actions[0];
  assert.equal(a.state, "combine");
  if (a.state !== "combine") return;
  assert.deepEqual([...a.invoiceNumbers], ["7286"]);
  assert.deepEqual([...a.changes], ["stage"], "only the stage is wrong");
});

test("the owner's standing hold stops the Overdue move but still fixes the amount", () => {
  // "Keep #7171 and Sherrie Woods held." The ladder's eligibility test is the
  // Overdue stage, so moving their card there would re-admit them to it.
  for (const label of ["Sherrie Woods", "  sherrie   woods  ", "Paula Rose"]) {
    const p = two({ label, cards: [card({ id: "agg", name: `${label} — 2 unpaid invoices`, monetaryValue: 1 })] });
    const a = p.actions[0];
    assert.equal(a.state, "combine", label);
    if (a.state !== "combine") return;
    assert.equal(a.desiredStage, STAGE_OVERDUE, label);
    assert.equal(a.stage, STAGE_SENT, `${label} must not be moved into Overdue`);
    assert.ok(a.reasons.includes("overdue_move_held_by_owner_instruction"), label);
    assert.equal(a.monetaryValue, 487, "but the board still shows what is owed");
    assert.ok(a.changes.includes("value"), label);
  }
});

test("the owner's hold also covers invoice #7171 whatever the customer is called", () => {
  const p = two({
    label: "Paula Someone-Else",
    invoices: [invoice({ invoiceId: "i-7171", invoiceNumber: "7171", status: "past_due", totalDollars: 137, balanceDollars: 137 })],
    clocks: { "i-7171": overdueClock },
    cards: [card({ id: "agg", name: "Paula Someone-Else — 1 overdue invoice", monetaryValue: 137 })],
  });
  const a = p.actions[0];
  assert.equal(a.state, "combine");
  if (a.state !== "combine") return;
  assert.equal(a.stage, STAGE_SENT);
  assert.ok(a.reasons.includes("overdue_move_held_by_owner_instruction"));
});

test("a customer the hold does not name is moved normally", () => {
  assert.equal(overdueMoveIsHeldByOwner("Elizabeth Brungs", ["7286", "7304"]), false);
  assert.equal(overdueMoveIsHeldByOwner("Sherrie Woods", []), true);
  assert.equal(overdueMoveIsHeldByOwner(null, ["7171"]), true);
  assert.equal(overdueMoveIsHeldByOwner(null, []), false);
  const brungs = two().actions[0];
  assert.equal(brungs.state, "combine");
  assert.equal(brungs.state === "combine" ? brungs.stage : null, STAGE_OVERDUE);
});

// ---- RETIRING A COMBINED CARD WHOSE INVOICES ARE ALL SETTLED --------------
//
// Phase one left such a card where it was. The owner asked on 2026-11-25 for a
// card that NAMES every invoice it covers to be retired once all of them are
// paid: the name is the boundary of what the card stands for, so if every
// number on it is settled, the card stands for nothing still owed.

/** Both of Brungs's invoices paid, which is how they read from 2026-11-25. */
const bothPaid = (over: Partial<InvoiceCardInput> = {}) => two({
  invoices: [
    invoice({ invoiceId: "i-7286", invoiceNumber: "7286", status: "paid", totalDollars: 137, balanceDollars: 0 }),
    invoice({ invoiceId: "i-7304", invoiceNumber: "7304", status: "paid", totalDollars: 350, balanceDollars: 0 }),
  ],
  ...over,
});

test("a card naming only settled invoices is retired to Paid at zero", () => {
  const p = bothPaid();
  const a = p.actions.find(x => x.state === "combine");
  assert.ok(a && a.state === "combine", "the card itself is acted on");
  if (!a || a.state !== "combine") return;
  assert.equal(a.cardId, "brungs");
  assert.equal(a.stage, STAGE_PAID);
  assert.equal(a.desiredStage, STAGE_PAID, "nothing withholds a retirement");
  assert.equal(a.monetaryValue, 0, "a retired card carries nothing");
  assert.deepEqual([...a.invoiceNumbers], ["7286", "7304"], "every invoice it named");
  assert.deepEqual([...a.invoiceIds], ["i-7286", "i-7304"]);
  assert.deepEqual([...a.changes].sort(), ["stage", "value"]);
  assert.ok(a.reasons.includes("card_names_only_settled_invoices_so_it_is_retired_to_paid"));
  assert.ok(!("name" in a), "a retirement must carry no name");
  assert.deepEqual([...p.untouched], [], "it is not also reported untouched");
  // The invoices themselves still need no card of their own.
  for (const n of ["7286", "7304"]) {
    assert.ok(p.actions.some(x => x.state === "skip" && x.invoiceNumber === n
      && x.reasons.includes("paid_invoice_is_covered_by_a_shared_card")), n);
  }
});

test("a card already in Paid at zero is reported with nothing to change", () => {
  const p = bothPaid({ cards: [card({ id: "brungs", name: BRUNGS, stageName: STAGE_PAID, monetaryValue: 0 })] });
  const a = p.actions.find(x => x.state === "combine");
  assert.ok(a && a.state === "combine");
  if (!a || a.state !== "combine") return;
  assert.deepEqual([...a.changes], [], "the writer turns an empty change list into no write at all");
});

test("one unpaid invoice on the card means it is revalued, never retired", () => {
  // The whole hazard: zeroing a card that still stands for money owed.
  const p = bothPaid({ invoices: [
    invoice({ invoiceId: "i-7286", invoiceNumber: "7286", status: "paid", totalDollars: 137, balanceDollars: 0 }),
    invoice({ invoiceId: "i-7304", invoiceNumber: "7304", status: "past_due", totalDollars: 350, balanceDollars: 350 }),
  ] });
  const combined = p.actions.filter(x => x.state === "combine");
  assert.equal(combined.length, 1, "one action for the card, not one per pass");
  const a = combined[0];
  if (a.state !== "combine") return;
  assert.equal(a.stage, STAGE_OVERDUE);
  assert.equal(a.monetaryValue, 350, "what is still owed");
  assert.deepEqual([...a.invoiceNumbers], ["7304"]);
});

test("a card naming a settled invoice AND one it cannot see is left alone", () => {
  // #9999 is not in this run at all, so nothing here can say it is settled -
  // and a card carrying that unknown must not be declared paid off.
  const p = bothPaid({ cards: [card({ id: "brungs", name: "Brungs — #7286, #7304, #9999", monetaryValue: 487 })] });
  assert.ok(!p.actions.some(a => a.state === "combine"), "the card is not written");
  const holds = p.actions.filter(a => a.state === "hold");
  assert.equal(holds.length, 2, "one per settled invoice on that card");
  for (const h of holds) assert.ok(h.reasons.includes("shared_card_names_an_invoice_this_plan_cannot_account_for"));
});

test("a settled invoice whose partner could not be read retires nothing", () => {
  // #7304 has no readable number, so it cannot be matched to the card by name
  // and the card's own #7304 is therefore unaccounted for.
  const p = bothPaid({ invoices: [
    invoice({ invoiceId: "i-7286", invoiceNumber: "7286", status: "paid", totalDollars: 137, balanceDollars: 0 }),
    invoice({ invoiceId: "i-7304", invoiceNumber: "", status: "paid", totalDollars: 350, balanceDollars: 0 }),
  ] });
  assert.ok(!p.actions.some(a => a.state === "combine"));
  assert.ok(p.actions.some(a => a.state === "hold" && a.reasons.includes("invoice_number_missing")));
  assert.ok(p.actions.some(a => a.state === "hold" && a.invoiceNumber === "7286"
    && a.reasons.includes("shared_card_names_an_invoice_this_plan_cannot_account_for")));
});

test("a card standing for whatever the customer owes is never retired", () => {
  // It names no invoice, so "all of them are paid" is not something its name
  // can establish. Nothing is written, and nothing is held either: a paid
  // invoice with no card of its own simply needs none.
  const p = bothPaid({ cards: [card({ id: "agg", name: "Elizabeth Brungs — 2 unpaid invoices", monetaryValue: 487 })] });
  assert.ok(!p.actions.some(a => a.state === "combine"), "the unnamed card is left as it is");
  assert.ok(!p.actions.some(a => a.state === "hold"));
  for (const n of ["7286", "7304"]) {
    assert.ok(p.actions.some(a => a.state === "skip" && a.invoiceNumber === n
      && a.reasons.includes("paid_invoice_needs_no_card")), n);
  }
  assert.deepEqual(p.untouched.map(u => u.cardId), ["agg"]);
});

test("a settled card in a protected stage or closed is never retired", () => {
  for (const stage of PROTECTED_STAGES) {
    const p = bothPaid({ cards: [card({ id: "brungs", name: BRUNGS, stageName: stage })] });
    assert.ok(!p.actions.some(a => a.state === "combine"), stage);
    assert.ok(p.actions.some(a => a.state === "hold" && a.reasons.includes("shared_card_is_in_a_protected_stage")), stage);
  }
  for (const status of ["won", "lost", "", null]) {
    const p = bothPaid({ cards: [card({ id: "brungs", name: BRUNGS, status })] });
    assert.ok(!p.actions.some(a => a.state === "combine"), String(status));
    assert.ok(p.actions.some(a => a.state === "hold"
      && a.reasons.includes("shared_card_is_not_open_and_is_never_reopened")), String(status));
  }
});

test("two combined cards cannot account for each other's settled invoices", () => {
  // #7286 is on one card and #7304 on another. Each card names an invoice the
  // other one's pass settled, and neither may borrow that to retire itself.
  const p = bothPaid({ cards: [
    card({ id: "a", name: "Brungs — #7286, #7304", monetaryValue: 487 }),
    card({ id: "b", name: "Brungs — #7286, #7304 (duplicate)", monetaryValue: 487 }),
  ] });
  // Both cards name both invoices, so each invoice matches two cards.
  assert.ok(!p.actions.some(a => a.state === "combine"));
  assert.ok(p.actions.every(a => a.state === "hold"));
  for (const a of p.actions) assert.ok(a.reasons.includes("multiple_cards_name_this_invoice"));
});
