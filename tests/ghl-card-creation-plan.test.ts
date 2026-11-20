import test from "node:test";
import assert from "node:assert/strict";
import {
  planCardCreation, describeCardCreation, CARD_CREATION_STAGE, type CardCreationInput,
} from "../lib/ghl-card-creation-plan";

/**
 * The single most important property: a NEW card is created in "Invoice Sent"
 * and never in "Invoice Overdue", however overdue the invoice is.
 *
 * Creating in Overdue would trigger the legacy Fixed Automation workflow, which
 * is driven by an opportunity event, and could fire reminders at a customer
 * whose invoice is already months old. The Sent transition provably cannot send
 * or enrol anyone.
 */

const input = (over: Partial<CardCreationInput> = {}): CardCreationInput => ({
  contactId: "contact-1", existingCardCount: 0,
  verified: { stage: "Invoice Sent", total: 16_000, count: 1 },
  label: "Example Customer", ...over,
});

test("a card is created in Invoice Sent", () => {
  const plan = planCardCreation(input());
  assert.equal(plan.state, "create");
  if (plan.state !== "create") return;
  assert.equal(plan.stageName, "Invoice Sent");
  assert.equal(CARD_CREATION_STAGE, "Invoice Sent");
  assert.equal(plan.monetaryValue, 16_000);
  assert.equal(plan.deferredFromOverdue, false);
});

test("an OVERDUE invoice still creates in Sent, and says why", () => {
  const plan = planCardCreation(input({ verified: { stage: "Invoice Overdue", total: 203_94, count: 3 } }));
  assert.equal(plan.state, "create");
  if (plan.state !== "create") return;
  assert.equal(plan.stageName, "Invoice Sent", "never create straight into Overdue");
  assert.equal(plan.deferredFromOverdue, true);
  assert.deepEqual([...plan.reasons], ["created_in_sent_not_overdue_to_avoid_legacy_enrollment"]);
});

test("no stage other than Sent is ever reachable", () => {
  for (const stage of ["Invoice Sent", "Invoice Overdue"]) {
    const plan = planCardCreation(input({ verified: { stage, total: 100, count: 1 } }));
    assert.equal(plan.state === "create" && plan.stageName, "Invoice Sent", stage);
  }
});

test("the card name matches the shape the sync already maintains", () => {
  const one = planCardCreation(input({ verified: { stage: "Invoice Sent", total: 500, count: 1 } }));
  assert.equal(one.state === "create" && one.name, "Example Customer - 1 unpaid invoice");
  const many = planCardCreation(input({ verified: { stage: "Invoice Overdue", total: 500, count: 4 } }));
  assert.equal(many.state === "create" && many.name, "Example Customer - 4 unpaid invoices");
});

test("a contact that already has a card gets no second one", () => {
  for (const count of [1, 2, 7]) {
    const plan = planCardCreation(input({ existingCardCount: count }));
    assert.equal(plan.state, "hold", String(count));
    assert.ok(plan.state === "hold" && plan.reasons.includes("contact_already_has_a_card"));
  }
});

test("a paid customer gets no card: the board is for who owes money", () => {
  const plan = planCardCreation(input({ verified: { stage: "Invoice Paid", total: 16_000, count: 1 } }));
  assert.equal(plan.state, "hold");
  assert.ok(plan.state === "hold" && plan.reasons.includes("nothing_outstanding_so_no_card_needed"));
});

test("without a verified Jobber plan nothing is created", () => {
  const plan = planCardCreation(input({ verified: null }));
  assert.equal(plan.state, "hold");
  assert.deepEqual(plan.state === "hold" ? [...plan.reasons] : [], ["no_verified_jobber_plan"]);
});

test("a balance that is not a whole number of dollars still gets a card", () => {
  // phoneSourcePlan reports DOLLARS (it returns cents / 100), and a GoHighLevel
  // monetaryValue is a currency amount. An integer check here would have
  // refused a card to every customer owing e.g. $137.50 — which is most of
  // them — so this is pinned.
  for (const total of [137.5, 0.29, 1_234.07]) {
    const plan = planCardCreation(input({ verified: { stage: "Invoice Overdue", total, count: 2 } }));
    assert.equal(plan.state, "create", String(total));
    assert.equal(plan.state === "create" && plan.monetaryValue, total, "passed through unchanged");
  }
});

test("a sub-cent balance is not a real invoice balance and holds", () => {
  for (const total of [0.001, 137.509]) {
    const plan = planCardCreation(input({ verified: { stage: "Invoice Sent", total, count: 1 } }));
    assert.equal(plan.state, "hold", String(total));
    assert.ok(plan.state === "hold" && plan.reasons.includes("verified_total_not_positive"));
  }
});

test("an unusable total, count, stage, contact or label holds", () => {
  const cases: Array<[Partial<CardCreationInput>, string]> = [
    [{ verified: { stage: "Invoice Sent", total: 0, count: 1 } }, "verified_total_not_positive"],
    [{ verified: { stage: "Invoice Sent", total: -5, count: 1 } }, "verified_total_not_positive"],
    [{ verified: { stage: "Invoice Sent", total: Number.NaN, count: 1 } }, "verified_total_not_positive"],
    [{ verified: { stage: "Invoice Sent", total: Number.POSITIVE_INFINITY, count: 1 } }, "verified_total_not_positive"],
    [{ verified: { stage: "Invoice Sent", total: 100, count: 0 } }, "verified_invoice_count_not_positive"],
    [{ verified: { stage: "Closed Out", total: 100, count: 1 } }, "verified_stage_unrecognised"],
    [{ contactId: "" }, "no_single_contact_resolved"],
    [{ label: "   " }, "card_label_missing"],
    [{ existingCardCount: -1 }, "existing_card_count_unreadable"],
    [{ existingCardCount: 1.5 }, "existing_card_count_unreadable"],
  ];
  for (const [over, reason] of cases) {
    const plan = planCardCreation(input(over));
    assert.equal(plan.state, "hold", reason);
    assert.ok(plan.state === "hold" && plan.reasons.includes(reason),
      `${reason} -> ${plan.state === "hold" ? plan.reasons.join(",") : "created"}`);
  }
});

test("a wholly malformed input holds rather than throwing", () => {
  for (const bad of [null, undefined, 42, "card"]) {
    assert.equal(planCardCreation(bad as never).state, "hold");
  }
});

test("every reason is deduplicated and sorted", () => {
  const plan = planCardCreation(input({ contactId: "", label: "", existingCardCount: 3,
    verified: { stage: "nope", total: 0, count: 0 } }));
  assert.equal(plan.state, "hold");
  if (plan.state !== "hold") return;
  assert.deepEqual([...plan.reasons], [...plan.reasons].sort());
  assert.equal(new Set(plan.reasons).size, plan.reasons.length);
});

test("the log line carries no customer detail", () => {
  const plan = planCardCreation(input({ verified: { stage: "Invoice Overdue", total: 9_900, count: 2 } }));
  const line = describeCardCreation(plan);
  assert.match(line, /create in Invoice Sent value=9900/);
  assert.match(line, /deferred to Sent/);
  assert.ok(!line.includes("Example Customer"));
  assert.match(describeCardCreation(planCardCreation(input({ verified: null }))), /^hold: /);
});
