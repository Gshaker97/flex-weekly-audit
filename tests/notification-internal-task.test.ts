import test from "node:test";
import assert from "node:assert/strict";
import {
  constructInternalTask, internalTaskDay, INTERNAL_TASK_CONTRACT,
  type InternalTaskRequest,
} from "../lib/notification-internal-task";

/**
 * The ladder's two internal steps: Angie calls at day 21, Angie decides on
 * collections at day 35.
 *
 * A task written into a real colleague's list is an outward-facing act, so this
 * module builds the request and cannot send it. These tests pin that, and pin
 * that a task can never be created without a named, approved owner — a task
 * assigned to nobody is worse than no task, because it looks handled.
 */

const ANGIE = { userId: "xCWSTIXHgovSgllIdKaw", displayName: "Angie Wiggins", approvalRef: "owner-2026-11-18" };

const request = (over: Partial<InternalTaskRequest> = {}): InternalTaskRequest => ({
  kind: "day21-call", assignee: ANGIE, contactId: "contact-1",
  invoiceNumber: "7226", invoiceId: "inv-1", dueOn: "2026-11-25",
  balanceMinor: 16_000, currency: "USD", ...over,
});

// ------------------------------------------------------- it cannot send

test("the contract declares no production write capability", () => {
  assert.equal(INTERNAL_TASK_CONTRACT.productionWriteCapability, false);
  assert.equal(INTERNAL_TASK_CONTRACT.automaticRetry, false);
  assert.equal(INTERNAL_TASK_CONTRACT.maximumAttempts, 1);
});

test("the best possible outcome is a constructed, unsent request", () => {
  const result = constructInternalTask(request());
  assert.equal(result.state, "constructed_disabled");
  assert.equal(result.productionWriteCapability, false);
  assert.deepEqual([...result.reasons], []);
});

test("the descriptor carries no credential and nowhere to put one", () => {
  const result = constructInternalTask(request());
  const headers = result.descriptor!.headers as Record<string, string>;
  assert.deepEqual(Object.keys(headers).sort(), ["Content-Type", "Version"]);
  assert.ok(!("Authorization" in headers));
  assert.ok(!JSON.stringify(result.descriptor).toLowerCase().includes("bearer"));
});

// --------------------------------------------------------- a task needs an owner

test("a task with no assignee is held, not created unowned", () => {
  const result = constructInternalTask(request({ assignee: undefined as never }));
  assert.equal(result.state, "held");
  assert.equal(result.descriptor, null);
  assert.ok(result.reasons.includes("no_assignee"));
});

test("an unusable or unapproved assignee is held", () => {
  assert.ok(constructInternalTask(request({ assignee: { ...ANGIE, userId: "" } }))
    .reasons.includes("assignee_user_id_unusable"));
  assert.ok(constructInternalTask(request({ assignee: { ...ANGIE, userId: "has spaces" } }))
    .reasons.includes("assignee_user_id_unusable"));
  assert.ok(constructInternalTask(request({ assignee: { ...ANGIE, approvalRef: "" } }))
    .reasons.includes("assignee_not_approved"));
  assert.ok(constructInternalTask(request({ assignee: { ...ANGIE, displayName: "  " } }))
    .reasons.includes("assignee_display_name_missing"));
});

test("the assignee's name never resolves the id: only the id assigns the work", () => {
  // A display name typo must not be able to send the task to the wrong person,
  // so the name appears in the body and the id alone in assignedTo.
  const result = constructInternalTask(request({
    assignee: { ...ANGIE, displayName: "Sarah (per the policy document)" } }));
  assert.equal(result.descriptor!.body.assignedTo, ANGIE.userId);
  assert.match(result.descriptor!.body.body, /Sarah \(per the policy document\)/);
});

// ------------------------------------------------------------- the two tasks

test("day 21 is the call and day 35 is the collections decision", () => {
  assert.equal(internalTaskDay("day21-call"), 21);
  assert.equal(internalTaskDay("day35-collections"), 35);
});

test("the day 21 task asks for a call and says the earlier texts went out", () => {
  const result = constructInternalTask(request({ kind: "day21-call" }));
  const body = result.descriptor!.body;
  assert.match(body.title, /^Call about past-due invoice #7226 \(USD 160\.00, day 21\)$/);
  assert.match(body.body, /Day 21 of the past-due ladder/);
  assert.match(body.body, /days 10, 15 and 20/);
  assert.match(body.body, /record the outcome on this task/);
});

test("the day 35 task is a DECISION and says nothing was referred automatically", () => {
  // The single most important line in the whole module: the system must never
  // let anyone believe it sent an invoice to collections by itself.
  const result = constructInternalTask(request({ kind: "day35-collections", dueOn: "2026-12-15" }));
  const body = result.descriptor!.body;
  assert.match(body.title, /^Decide on collections for past-due invoice #7226 \(USD 160\.00, day 35\)$/);
  assert.match(body.body, /This is a DECISION for you to make, not something the system has done/);
  assert.match(body.body, /Nothing has been referred to collections automatically/);
});

test("an unknown task kind is held", () => {
  const result = constructInternalTask(request({ kind: "day99-whatever" as never }));
  assert.equal(result.state, "held");
  assert.ok(result.reasons.includes("unknown_internal_task_kind"));
});

// ------------------------------------------------------------- the wire body

test("the task is due at 09:05 Phoenix on the milestone date", () => {
  // Phoenix never observes DST, so 16:05Z is 09:05 local all year — the same
  // window the texts use.
  const result = constructInternalTask(request({ dueOn: "2026-11-25" }));
  assert.equal(result.descriptor!.body.dueDate, "2026-11-25T16:05:00.000Z");
  const july = constructInternalTask(request({ dueOn: "2026-07-04" }));
  assert.equal(july.descriptor!.body.dueDate, "2026-07-04T16:05:00.000Z");
});

test("the task starts open, never pre-completed", () => {
  assert.equal(constructInternalTask(request()).descriptor!.body.completed, false);
});

test("the url hangs the task off the contact and escapes the id", () => {
  const result = constructInternalTask(request({ contactId: "abc_123-XY" }));
  assert.equal(result.descriptor!.url,
    "https://services.leadconnectorhq.com/contacts/abc_123-XY/tasks");
});

test("the serialized body matches the body exactly", () => {
  const result = constructInternalTask(request());
  assert.deepEqual(JSON.parse(result.descriptor!.serializedBody), result.descriptor!.body);
});

test("a task carries the invoice number and balance, never a customer name", () => {
  const result = constructInternalTask(request());
  const text = JSON.stringify(result.descriptor);
  assert.match(text, /#7226/);
  assert.match(text, /USD 160\.00/);
  // Nothing identifying is modelled at all, so nothing identifying can leak.
  assert.ok(!/@/.test(text));
});

// ------------------------------------------------------------- bad input

test("a malformed invoice, date, balance or currency is held", () => {
  assert.ok(constructInternalTask(request({ dueOn: "25/11/2026" })).reasons.includes("due_date_unusable"));
  assert.ok(constructInternalTask(request({ balanceMinor: 0 })).reasons.includes("balance_not_positive"));
  assert.ok(constructInternalTask(request({ balanceMinor: -100 })).reasons.includes("balance_not_positive"));
  assert.ok(constructInternalTask(request({ balanceMinor: 1.5 })).reasons.includes("balance_not_positive"));
  assert.ok(constructInternalTask(request({ currency: "dollars" })).reasons.includes("currency_unusable"));
  assert.ok(constructInternalTask(request({ invoiceNumber: "" })).reasons.includes("invoice_number_missing"));
  assert.ok(constructInternalTask(request({ contactId: "a/b" })).reasons.includes("contact_id_unusable"));
});

test("a wholly malformed request is held rather than thrown", () => {
  for (const bad of [null, undefined, 42, "task"]) {
    const result = constructInternalTask(bad as never);
    assert.equal(result.state, "held");
    assert.equal(result.descriptor, null);
  }
});

test("every reason is reported at once, deduplicated and sorted", () => {
  const result = constructInternalTask(request({
    dueOn: "", balanceMinor: 0, currency: "x", invoiceNumber: "" }));
  assert.equal(result.state, "held");
  assert.ok(result.reasons.length >= 4);
  assert.deepEqual([...result.reasons], [...result.reasons].sort());
  assert.equal(new Set(result.reasons).size, result.reasons.length);
});
