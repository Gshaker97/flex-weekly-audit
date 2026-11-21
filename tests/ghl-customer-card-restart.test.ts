/**
 * A FINISHED CARD IS NOT REOPENED.
 *
 * The deployed per-invoice path held 135 changes on "Closed or unknown status;
 * automatic reopening disabled", so a customer whose card had been marked won
 * could never be chased again. The decision is to start a NEW card instead.
 *
 * Mechanically this is almost nothing - the resolver already excludes finished
 * cards from `openCards`, so the plan sees no card and creates one. These tests
 * exist because "almost nothing" is exactly the kind of behaviour that gets
 * broken silently, and because the run log has to say which of the two
 * situations it was in.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { planCustomerCard, STAGE_OVERDUE, STAGE_SENT } from "../lib/ghl-customer-card-plan";
import type { CustomerCardInput } from "../lib/ghl-customer-card-plan";
import type { ExistingCard, InvoiceFact } from "../lib/ghl-invoice-card-plan";

const NOW = new Date("2026-11-21T12:00:00Z");

const invoice = (n: string, balance: number, issued: string, due: string, status = "past_due"): InvoiceFact =>
  ({ invoiceId: `I${n}`, invoiceNumber: n, status, totalDollars: balance, balanceDollars: balance, issuedDate: issued, dueDate: due });

// Sending proof: the legacy workflow is recorded as off, so Overdue moves are
// allowed. Invented evidence, in the exact shape `legacySendingIsOff` demands.
const sendingOff = {
  source: "operator-confirmed-workflow-sending-disabled",
  workflowId: "WF1",
  disabledOn: "2026-11-01",
  observedAt: "2026-11-20T18:00:00.000Z",
  evidenceRef: "test-fixture",
} as const;

const base = (over: Partial<CustomerCardInput> = {}): CustomerCardInput => ({
  contactId: "C1",
  label: "Ana Example",
  invoices: [invoice("6001", 120, "2026-09-01", "2026-09-15")],
  cards: [],
  clocks: { I6001: { daysPastDue: 67, isOverdue: true, sentOn: "2026-09-01" } },
  windowStart: "2026-08-01",
  legacyWorkflowId: "WF1",
  legacySending: sendingOff,
  now: NOW,
  ...over,
});

const openCard = (id: string, stage: string, value: number, name: string): ExistingCard =>
  ({ id, name, stageName: stage, status: "open", monetaryValue: value });

test("a finished card does not block: a new card is created", () => {
  const out = planCustomerCard(base({ cards: [], finishedCardIds: ["K_WON"] }));
  assert.equal(out.state, "create");
});

test("the create says plainly that the previous card was finished", () => {
  const out = planCustomerCard(base({ cards: [], finishedCardIds: ["K_WON"] }));
  assert.equal(out.state, "create");
  if (out.state !== "create") return;
  assert.ok(out.reasons.includes("started_a_new_card_because_the_previous_one_is_finished"),
    `reasons were ${out.reasons.join(", ")}`);
  assert.ok(!out.reasons.includes("no_card_for_this_contact_yet"));
});

test("with no card at all the reason stays the plain first-card one", () => {
  const out = planCustomerCard(base({ cards: [] }));
  assert.equal(out.state, "create");
  if (out.state !== "create") return;
  assert.ok(out.reasons.includes("no_card_for_this_contact_yet"));
  assert.ok(!out.reasons.includes("started_a_new_card_because_the_previous_one_is_finished"));
});

test("an empty finished list is treated as no finished card", () => {
  const out = planCustomerCard(base({ cards: [], finishedCardIds: [] }));
  assert.equal(out.state, "create");
  if (out.state !== "create") return;
  assert.ok(out.reasons.includes("no_card_for_this_contact_yet"));
});

test("a blank id in the finished list does not count as a finished card", () => {
  const out = planCustomerCard(base({ cards: [], finishedCardIds: ["", "   "] }));
  assert.equal(out.state, "create");
  if (out.state !== "create") return;
  assert.ok(out.reasons.includes("no_card_for_this_contact_yet"));
});

test("the restarted card carries the real balance and the right stage", () => {
  const out = planCustomerCard(base({ cards: [], finishedCardIds: ["K_WON"] }));
  assert.equal(out.state, "create");
  if (out.state !== "create") return;
  assert.equal(out.target.monetaryValue, 120);
  assert.equal(out.target.stage, STAGE_OVERDUE);
  assert.match(out.target.name, /Ana Example — 1 unpaid invoice/);
});

test("a restart still starts in Sent when the Overdue move has no proof", () => {
  // Restarting must not become a back door around the sending gate.
  const out = planCustomerCard(base({
    cards: [], finishedCardIds: ["K_WON"], legacySending: null,
  }));
  assert.equal(out.state, "create");
  if (out.state !== "create") return;
  assert.equal(out.target.stage, STAGE_SENT);
  assert.ok(out.reasons.includes("started_a_new_card_because_the_previous_one_is_finished"));
  assert.ok(out.reasons.includes("created_in_sent_because_the_overdue_move_needs_recorded_proof"));
});

test("an OPEN card is still reused, finished history or not", () => {
  // The one-open-card-per-contact rule is untouched by any of this.
  const out = planCustomerCard(base({
    cards: [openCard("K_OPEN", STAGE_SENT, 1, "stale name")],
    finishedCardIds: ["K_WON"],
  }));
  assert.equal(out.state, "update");
  if (out.state !== "update") return;
  assert.equal(out.cardId, "K_OPEN");
  assert.ok(out.reasons.includes("reused_the_contacts_existing_card"));
  assert.ok(!out.reasons.includes("started_a_new_card_because_the_previous_one_is_finished"));
});

test("nothing unpaid and only a finished card: no new card is started", () => {
  // Restarting is for customers who owe again, not for tidying history.
  const out = planCustomerCard(base({
    invoices: [invoice("6001", 0, "2026-09-01", "2026-09-15", "paid")],
    clocks: { I6001: { daysPastDue: 0, isOverdue: false, sentOn: "2026-09-01" } },
    cards: [], finishedCardIds: ["K_WON"],
  }));
  assert.equal(out.state, "skip");
  if (out.state !== "skip") return;
  assert.ok(out.reasons.includes("nothing_unpaid_and_no_card_to_close"));
});

test("a protected open card still refuses, finished history or not", () => {
  const out = planCustomerCard(base({
    cards: [openCard("K_P", "Late Fee Invoice Sent", 120, "parked")],
    finishedCardIds: ["K_WON"],
  }));
  assert.equal(out.state, "hold");
});
