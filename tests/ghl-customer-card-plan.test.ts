/**
 * One card per customer.
 *
 * The test that matters most here is "a customer with four invoices against a
 * GoHighLevel that refuses a second card". That is the exact failure that took
 * production down on 2026-11-20: the per-invoice writer created one card for a
 * contact and GHL then rejected the second for that same contact with
 * OPPORTUNITY_NO_DUPLICATE. The dry runs never caught it because they never
 * called the create endpoint. So this file has a fake endpoint that enforces
 * GHL's real rule, and the plan is driven through it.
 *
 * Customer names, invoice numbers and opportunity ids here are invented. The
 * real ones stay out of this repository.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planCustomerCard, customerCardName,
  STAGE_OVERDUE, STAGE_PAID, STAGE_SENT,
  type CustomerCardInput, type InvoiceClock,
} from "../lib/ghl-customer-card-plan";
import type { ExistingCard, InvoiceFact } from "../lib/ghl-invoice-card-plan";

const NOW = new Date("2026-11-20T12:00:00Z");
const WORKFLOW = "workflow-under-test";

const invoice = (o: Partial<InvoiceFact> & { invoiceId: string }): InvoiceFact => ({
  invoiceId: o.invoiceId,
  invoiceNumber: o.invoiceNumber ?? (o.invoiceId.replace(/\D/g, "") || "1000"),
  status: o.status ?? "awaiting_payment",
  totalDollars: o.totalDollars ?? o.balanceDollars ?? 100,
  balanceDollars: o.balanceDollars ?? 100,
  issuedDate: o.issuedDate ?? "2026-10-01",
  dueDate: o.dueDate ?? "2026-10-31",
});

const clock = (sentOn: string, daysPastDue: number): InvoiceClock =>
  ({ sentOn, daysPastDue, isOverdue: daysPastDue >= 1 });

const plan = (over: Partial<CustomerCardInput> = {}) => planCustomerCard({
  contactId: "contact-1",
  label: "Customer With Four",
  invoices: [],
  cards: [],
  clocks: {},
  legacyWorkflowId: WORKFLOW,
  now: NOW,
  ...over,
});

// --- A fake GoHighLevel that enforces the real one-card-per-contact rule ----

class DuplicateOpportunityError extends Error {
  code = "OPPORTUNITY_NO_DUPLICATE";
  statusCode = 400;
  constructor(public existingId: string) {
    super("Can not create duplicate opportunity for the contact.");
  }
}

/** Mirrors GHL: one open opportunity per contact, second create is a 400. */
class FakeGhl {
  cards = new Map<string, { id: string; contactId: string; name: string; stage: string; value: number }>();
  creates = 0;
  updates = 0;
  private seq = 0;

  create(contactId: string, name: string, stage: string, value: number) {
    this.creates++;
    const clash = [...this.cards.values()].find(c => c.contactId === contactId);
    if (clash) throw new DuplicateOpportunityError(clash.id);
    const id = `opp-${++this.seq}`;
    this.cards.set(id, { id, contactId, name, stage, value });
    return id;
  }

  update(id: string, name: string, stage: string, value: number) {
    this.updates++;
    const card = this.cards.get(id);
    if (!card) throw new Error("no such opportunity");
    Object.assign(card, { name, stage, value });
  }

  forContact(contactId: string): ExistingCard[] {
    return [...this.cards.values()]
      .filter(c => c.contactId === contactId)
      .map(c => ({ id: c.id, name: c.name, stageName: c.stage, status: "open", monetaryValue: c.value }));
  }
}

/** Drive one decision against the fake, the way a writer would. */
function apply(ghl: FakeGhl, contactId: string, decision: ReturnType<typeof planCustomerCard>) {
  if (decision.state === "create") {
    return ghl.create(contactId, decision.target.name, decision.target.stage, decision.target.monetaryValue);
  }
  if (decision.state === "update") {
    ghl.update(decision.cardId, decision.target.name, decision.target.stage, decision.target.monetaryValue);
    return decision.cardId;
  }
  return null;
}

// ---------------------------------------------------------------------------

test("four invoices for one customer produce ONE card, and GHL never sees a second create", () => {
  const ghl = new FakeGhl();
  const contactId = "contact-four";
  const invoices = [
    invoice({ invoiceId: "i1", invoiceNumber: "9101", balanceDollars: 180, issuedDate: "2026-09-01", dueDate: "2026-10-01" }),
    invoice({ invoiceId: "i2", invoiceNumber: "9102", balanceDollars: 180, issuedDate: "2026-09-15", dueDate: "2026-10-15" }),
    invoice({ invoiceId: "i3", invoiceNumber: "9103", balanceDollars: 180, issuedDate: "2026-10-01", dueDate: "2026-10-31" }),
    invoice({ invoiceId: "i4", invoiceNumber: "9105", balanceDollars: 180, issuedDate: "2026-10-15", dueDate: "2026-11-15" }),
  ];
  const clocks = {
    i1: clock("2026-09-01", 50), i2: clock("2026-09-15", 36),
    i3: clock("2026-10-01", 20), i4: clock("2026-10-15", 5),
  };

  // Run the plan four times, exactly as four hourly syncs would.
  for (let i = 0; i < 4; i++) {
    const decision = plan({ contactId, label: "Customer With Four", invoices, clocks, cards: ghl.forContact(contactId) });
    apply(ghl, contactId, decision);
  }

  assert.equal(ghl.cards.size, 1, "exactly one card for the customer");
  assert.equal(ghl.creates, 1, "create was attempted exactly once, so GHL never had the chance to refuse");
  const card = [...ghl.cards.values()][0];
  assert.equal(card.value, 720, "value is the total unpaid, not one invoice");
  for (const n of ["9101", "9102", "9103", "9105"]) {
    assert.ok(card.name.includes(`#${n}`), `name lists invoice ${n}`);
  }
  assert.ok(card.name.includes("due 2026-10-01"), "name carries each due date");
});

test("the fake really does enforce GHL's rule, so the test above is meaningful", () => {
  const ghl = new FakeGhl();
  ghl.create("c", "first", STAGE_SENT, 1);
  assert.throws(() => ghl.create("c", "second", STAGE_SENT, 2), (err: any) => {
    assert.equal(err.code, "OPPORTUNITY_NO_DUPLICATE");
    assert.equal(err.statusCode, 400);
    return true;
  });
});

test("the old per-invoice shape would have failed against the same fake", () => {
  // Regression guard: this is what production actually attempted.
  const ghl = new FakeGhl();
  ghl.create("contact-two", "Invoice #9201 — Customer With Two", STAGE_SENT, 350);
  assert.throws(() => ghl.create("contact-two", "Invoice #9202 — Customer With Two", STAGE_SENT, 137),
    (err: any) => err.code === "OPPORTUNITY_NO_DUPLICATE");
});

test("stage and timing follow the OLDEST unpaid invoice", () => {
  const decision = plan({
    invoices: [
      invoice({ invoiceId: "new", invoiceNumber: "9002", balanceDollars: 50, issuedDate: "2026-11-10", dueDate: "2026-12-10" }),
      invoice({ invoiceId: "old", invoiceNumber: "9001", balanceDollars: 50, issuedDate: "2026-08-01", dueDate: "2026-09-01", status: "past_due" }),
    ],
    clocks: { new: clock("2026-11-10", -20), old: clock("2026-08-01", 80) },
    legacySending: {
      source: "operator-confirmed-workflow-sending-disabled", workflowId: WORKFLOW,
      disabledOn: "2026-11-20", observedAt: "2026-11-20T10:00:00Z", evidenceRef: "owner confirmed",
    },
  });
  assert.equal(decision.state, "create");
  if (decision.state !== "create") return;
  assert.equal(decision.target.oldest?.invoiceNumber, "9001");
  assert.equal(decision.target.oldest?.daysPastDue, 80, "timing comes from the oldest, not the newest");
  assert.equal(decision.target.stage, STAGE_OVERDUE);
  assert.equal(decision.target.monetaryValue, 100, "but the value is still the total of both");
});

test("paying one invoice recalculates the card instead of making another", () => {
  const ghl = new FakeGhl();
  const contactId = "contact-two";
  const clocks = { a: clock("2026-10-01", 20), b: clock("2026-10-10", 11) };
  const both = [
    invoice({ invoiceId: "a", invoiceNumber: "9201", balanceDollars: 350, issuedDate: "2026-10-01" }),
    invoice({ invoiceId: "b", invoiceNumber: "9202", balanceDollars: 137, issuedDate: "2026-10-10" }),
  ];
  apply(ghl, contactId, plan({ contactId, label: "Customer With Two", invoices: both, clocks, cards: [] }));
  assert.equal([...ghl.cards.values()][0].value, 487);

  // #9202 is paid.
  const afterPayment = [
    both[0],
    invoice({ invoiceId: "b", invoiceNumber: "9202", balanceDollars: 0, totalDollars: 137, status: "paid", issuedDate: "2026-10-10" }),
  ];
  const next = plan({ contactId, label: "Customer With Two", invoices: afterPayment, clocks, cards: ghl.forContact(contactId) });
  assert.equal(next.state, "update");
  if (next.state !== "update") return;
  assert.ok(next.changes.includes("value") && next.changes.includes("name"));
  apply(ghl, contactId, next);

  assert.equal(ghl.creates, 1, "still only ever one create");
  const card = [...ghl.cards.values()][0];
  assert.equal(card.value, 350);
  assert.ok(!card.name.includes("#9202"), "the settled invoice drops off the card");
  assert.ok(card.name.includes("#9201"));
});

test("when every invoice is paid the card moves to Paid carrying zero", () => {
  const ghl = new FakeGhl();
  const contactId = "contact-two";
  const clocks = { a: clock("2026-10-01", 20) };
  apply(ghl, contactId, plan({
    contactId, label: "Customer With Two", clocks, cards: [],
    invoices: [invoice({ invoiceId: "a", invoiceNumber: "9201", balanceDollars: 350, issuedDate: "2026-10-01" })],
  }));

  const settled = plan({
    contactId, label: "Customer With Two", clocks, cards: ghl.forContact(contactId),
    invoices: [invoice({ invoiceId: "a", invoiceNumber: "9201", balanceDollars: 0, totalDollars: 350, status: "paid", issuedDate: "2026-10-01" })],
  });
  assert.equal(settled.state, "update");
  if (settled.state !== "update") return;
  assert.equal(settled.target.stage, STAGE_PAID);
  assert.equal(settled.target.monetaryValue, 0);
  apply(ghl, contactId, settled);
  assert.equal([...ghl.cards.values()][0].stage, STAGE_PAID);
});

test("an existing card is reused, so the card already on the board is adopted", () => {
  const existing: ExistingCard = {
    id: "existing-card-1", name: "Invoice #9201 — Customer With Two",
    stageName: STAGE_SENT, status: "open", monetaryValue: 350,
  };
  const decision = plan({
    contactId: "contact-two", label: "Customer With Two", cards: [existing],
    invoices: [
      invoice({ invoiceId: "a", invoiceNumber: "9201", balanceDollars: 350, issuedDate: "2026-10-01" }),
      invoice({ invoiceId: "b", invoiceNumber: "9202", balanceDollars: 137, issuedDate: "2026-10-10" }),
    ],
    clocks: { a: clock("2026-10-01", 20), b: clock("2026-10-10", 11) },
  });
  assert.equal(decision.state, "update");
  if (decision.state !== "update") return;
  assert.equal(decision.cardId, "existing-card-1", "the card the per-invoice writer left behind");
  assert.equal(decision.target.monetaryValue, 487);
});

test("without recorded proof the legacy workflow is off, no card is moved to Overdue", () => {
  const decision = plan({
    cards: [{ id: "c1", name: "x", stageName: STAGE_SENT, status: "open", monetaryValue: 10 }],
    invoices: [invoice({ invoiceId: "a", invoiceNumber: "9003", balanceDollars: 10, status: "past_due", issuedDate: "2026-09-01" })],
    clocks: { a: clock("2026-09-01", 40) },
  });
  assert.equal(decision.state, "update");
  if (decision.state !== "update") return;
  assert.equal(decision.target.stage, STAGE_SENT, "stays where it is");
  assert.ok(!decision.changes.includes("stage"));
});

test("a new card is created in Sent even when the oldest invoice is already overdue", () => {
  const decision = plan({
    invoices: [invoice({ invoiceId: "a", invoiceNumber: "9003", balanceDollars: 10, status: "past_due", issuedDate: "2026-09-01" })],
    clocks: { a: clock("2026-09-01", 40) },
  });
  assert.equal(decision.state, "create");
  if (decision.state !== "create") return;
  assert.equal(decision.target.stage, STAGE_SENT);
});

test("one unreadable invoice holds the whole customer rather than understating the total", () => {
  const decision = plan({
    invoices: [
      invoice({ invoiceId: "good", invoiceNumber: "9003", balanceDollars: 100, issuedDate: "2026-10-01" }),
      invoice({ invoiceId: "bad", invoiceNumber: "9004", balanceDollars: -5, issuedDate: "2026-10-01" }),
    ],
    clocks: { good: clock("2026-10-01", 20), bad: clock("2026-10-01", 20) },
  });
  assert.equal(decision.state, "hold");
  if (decision.state !== "hold") return;
  assert.ok(decision.reasons.includes("invoice_amounts_unusable"));
});

test("two cards on one contact is a hold, never a guess about which to use", () => {
  const decision = plan({
    cards: [
      { id: "c1", name: "a", stageName: STAGE_SENT, status: "open", monetaryValue: 1 },
      { id: "c2", name: "b", stageName: STAGE_SENT, status: "open", monetaryValue: 2 },
    ],
    invoices: [invoice({ invoiceId: "a", invoiceNumber: "9003", balanceDollars: 10, issuedDate: "2026-10-01" })],
    clocks: { a: clock("2026-10-01", 20) },
  });
  assert.equal(decision.state, "hold");
  if (decision.state !== "hold") return;
  assert.ok(decision.reasons.includes("contact_has_more_than_one_card_in_this_pipeline"));
});

test("a card parked in a protected stage is never touched", () => {
  for (const stageName of ["Late Fee Invoice Sent", "Invoice Canceled", "Closed Out", "Quote Sent"]) {
    const decision = plan({
      cards: [{ id: "c1", name: "a", stageName, status: "open", monetaryValue: 1 }],
      invoices: [invoice({ invoiceId: "a", invoiceNumber: "9003", balanceDollars: 10, issuedDate: "2026-10-01" })],
      clocks: { a: clock("2026-10-01", 20) },
    });
    assert.equal(decision.state, "hold", stageName);
  }
});

test("an invoice issued before the window does not appear on the card", () => {
  const decision = plan({
    windowStart: "2026-07-21",
    invoices: [
      invoice({ invoiceId: "old", invoiceNumber: "9007", balanceDollars: 275, issuedDate: "2026-03-01" }),
      invoice({ invoiceId: "in", invoiceNumber: "9003", balanceDollars: 100, issuedDate: "2026-10-01" }),
    ],
    clocks: { old: clock("2026-03-01", 200), in: clock("2026-10-01", 20) },
  });
  assert.equal(decision.state, "create");
  if (decision.state !== "create") return;
  assert.equal(decision.target.monetaryValue, 100);
  assert.ok(!decision.target.name.includes("#9007"));
});

test("the name keeps the per-customer wording the old aggregate guard looks for", () => {
  const name = customerCardName("Customer With Old Invoice", [
    { invoiceId: "a", invoiceNumber: "9601", balanceDollars: 99, dueDate: "2026-10-01", sentOn: "2026-09-01", daysPastDue: 50, isOverdue: true },
  ]);
  assert.match(name, /\d+\s+unpaid\s+invoice/i);
  assert.ok(name.startsWith("Customer With Old Invoice — 1 unpaid invoice, $99.00"));
});

// --- Cases the 2026-11-20 production dry run exposed ------------------------
// Both of these held a real customer who should have got a card. Neither is
// hypothetical: the invoice numbers below are the actual offenders.

test("a dateless DRAFT invoice is left off the card, not a reason to hold the customer", () => {
  // Real case: a dateless draft carrying a balance, alongside sent invoices.
  const decision = plan({
    label: "Customer With Four",
    invoices: [
      invoice({ invoiceId: "draft", invoiceNumber: "9301", balanceDollars: 180, totalDollars: 180,
        status: "draft", issuedDate: null, dueDate: null }),
      invoice({ invoiceId: "real", invoiceNumber: "9302", balanceDollars: 180, totalDollars: 180,
        status: "past_due", issuedDate: "2026-08-04", dueDate: "2026-08-04" }),
    ],
    clocks: { draft: null, real: clock("2026-08-04", 108) },
  });
  assert.equal(decision.state, "create", "the customer still gets a card");
  if (decision.state !== "create") return;
  assert.equal(decision.target.monetaryValue, 180, "only the sent invoice counts");
  assert.ok(!decision.target.name.includes("#9301"));
  assert.ok(decision.target.excluded.some(e => e.invoiceNumber === "9301" && /not_a_sent_invoice/.test(e.reason)),
    "but the draft is reported, never silently dropped");
});

test("an ancient invoice with contradictory dates cannot hold a current customer", () => {
  // Real case: a 2024 invoice whose due date precedes its issue date.
  const decision = plan({
    label: "Customer With Old Invoice",
    windowStart: "2026-07-21",
    invoices: [
      invoice({ invoiceId: "ancient", invoiceNumber: "9401", balanceDollars: 1500, totalDollars: 1500,
        status: "past_due", issuedDate: "2024-07-24", dueDate: "2024-07-23" }),
      invoice({ invoiceId: "now", invoiceNumber: "9402", balanceDollars: 99, totalDollars: 99,
        status: "past_due", issuedDate: "2026-10-30", dueDate: "2026-10-30" }),
    ],
    clocks: { ancient: null, now: clock("2026-10-30", 21) },
  });
  assert.equal(decision.state, "create");
  if (decision.state !== "create") return;
  assert.equal(decision.target.monetaryValue, 99, "the 2024 invoice is out of scope, not part of the total");
  assert.ok(decision.target.excluded.some(e => e.invoiceNumber === "9401" && e.reason === "issued_before_the_lookback_window"));
});

test("a date problem on an IN-SCOPE sent invoice still holds the customer", () => {
  // The protection that matters is unchanged: we will not understate a total.
  const decision = plan({
    windowStart: "2026-07-21",
    invoices: [
      invoice({ invoiceId: "broken", invoiceNumber: "9005", balanceDollars: 200, totalDollars: 200,
        status: "past_due", issuedDate: "2026-10-01", dueDate: "2026-09-01" }),
      invoice({ invoiceId: "fine", invoiceNumber: "9006", balanceDollars: 99, totalDollars: 99,
        status: "past_due", issuedDate: "2026-10-30", dueDate: "2026-10-30" }),
    ],
    clocks: { broken: null, fine: clock("2026-10-30", 21) },
  });
  assert.equal(decision.state, "hold");
  if (decision.state !== "hold") return;
  assert.ok(decision.reasons.includes("invoice_dates_unusable"));
});
