import test from "node:test";
import assert from "node:assert/strict";
import { planLadderStep, type LadderStepInput } from "../lib/notification-ladder-plan";
import { ORIGINAL_DAY10_SMS_BODY } from "../lib/notification-copy-policy";

/** A step that passes every check, so each test can spoil exactly one thing. */
const step = (over: Partial<LadderStepInput> = {}): LadderStepInput => ({
  dayPastDue: 10,
  category: "maintenance",
  scheduledOn: "2026-11-24",
  today: "2026-11-24",
  invoiceId: "Z2lkOi8vSm9iYmVyL0ludm9pY2UvMQ",
  invoiceNumber: "7226",
  balanceMinor: 16000,
  currency: "USD",
  invoiceIssuedOn: "2026-11-03",
  jobberClientId: "client-1",
  homeownerContactId: "contact-1",
  assignee: null,
  holds: [],
  alreadySent: false,
  termsEvidence: null,
  suspensionEvidence: null,
  ...over,
});

test("a homeowner rung plans ONE message on two channels, same words", () => {
  const action = planLadderStep(step());
  assert.equal(action.kind, "send_message");
  if (action.kind !== "send_message") return;
  assert.deepEqual([...action.channels], ["sms", "email"]);
  assert.equal(action.body, ORIGINAL_DAY10_SMS_BODY);
  assert.equal(action.email.body, action.body, "the email must carry the text's exact words");
  assert.equal(action.email.subject, "Invoice #7226 is 10 days past due");
  assert.equal(action.contactId, "contact-1");
});

test("every homeowner rung does it, not just day 10", () => {
  for (const day of [10, 20, 25, 30]) {
    const action = planLadderStep(step({ dayPastDue: day }));
    assert.equal(action.kind, "send_message", `day ${day}`);
    if (action.kind !== "send_message") continue;
    assert.deepEqual([...action.channels], ["sms", "email"], `day ${day}`);
    assert.equal(action.email.body, action.body, `day ${day} words must match`);
    assert.equal(action.email.subject, `Invoice #7226 is ${day} days past due`, `day ${day}`);
  }
});

test("an invoice number the subject cannot use holds the whole pair", () => {
  // Not a text with no email: half a pair is not what was approved. The
  // existing invoice_number_missing guard fires first, which is the same answer.
  const action = planLadderStep(step({ invoiceNumber: "   " }));
  assert.equal(action.kind, "hold");
  if (action.kind !== "hold") return;
  assert.ok(action.reasons.includes("invoice_number_missing"), action.reasons.join(","));
});

test("an internal rung is still a task and messages nobody", () => {
  const action = planLadderStep(step({
    dayPastDue: 21,
    assignee: { userId: "u1", locationId: "l1", approvalRef: "owner-approved" } as any,
  }));
  assert.notEqual(action.kind, "send_message", "day 21 must never message the customer");
});

test("a rung whose words fail their validator still sends neither half", () => {
  // Day 15 without the written-policy evidence: the fee warning is unsupported.
  const action = planLadderStep(step({ dayPastDue: 15, termsEvidence: null }));
  assert.equal(action.kind, "hold");
  if (action.kind !== "hold") return;
  assert.ok(
    action.reasons.includes("invoice_terms_or_written_policy_must_support_the_fee_warning"),
    action.reasons.join(","));
});

test("an upstream hold still blocks both halves", () => {
  const action = planLadderStep(step({ holds: ["contact_opted_out"] }));
  assert.equal(action.kind, "hold");
  if (action.kind !== "hold") return;
  assert.ok(action.reasons.includes("contact_opted_out"));
});

test("no destination contact means no pair at all", () => {
  for (const contactId of [null, "", "not a valid id!"]) {
    const action = planLadderStep(step({ homeownerContactId: contactId }));
    assert.equal(action.kind, "hold", String(contactId));
    if (action.kind !== "hold") continue;
    assert.ok(action.reasons.includes("no_usable_homeowner_contact"), action.reasons.join(","));
  }
});
