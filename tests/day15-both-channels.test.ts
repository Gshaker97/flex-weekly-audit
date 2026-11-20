import test from "node:test";
import assert from "node:assert/strict";
import { eventKey, milestonePlanKey, planKeyOfEventKey, planBatch, type Event } from "../lib/notification-gate";

/**
 * A Day 15 reminder goes out on BOTH channels: one text and one email.
 *
 * Approved by the account owner on 2026-11-18. Before that, the ledger key was
 * channel-blind and the two channels were one event, so only one could ever go.
 *
 * These tests pin what the change does AND what it deliberately keeps:
 *   - two channels for one milestone  -> two events, both may send
 *   - the same channel twice          -> still one event, still cannot repeat
 *   - two milestones for one contact  -> still a conflict (the daily cap)
 *   - a prior attempt on ANY channel  -> that milestone counts as attempted
 */

const EVENT = {
  accountId: "acct-1", invoiceId: "inv-1", dayPastDue: 15, audience: "homeowner" as const,
  channel: "email" as const, contactId: "contact-1",
};

test("the two channels of one milestone are two different keys", () => {
  assert.notEqual(eventKey({ ...EVENT, channel: "email" }), eventKey({ ...EVENT, channel: "sms" }));
});

test("a milestone's plan key is the same whichever channel is asked about", () => {
  assert.equal(milestonePlanKey({ ...EVENT, channel: "email" } as any),
               milestonePlanKey({ ...EVENT, channel: "sms" } as any));
});

test("a message key maps back to its own milestone, from either channel", () => {
  const plan = milestonePlanKey(EVENT as any);
  assert.equal(planKeyOfEventKey(eventKey({ ...EVENT, channel: "email" })), plan);
  assert.equal(planKeyOfEventKey(eventKey({ ...EVENT, channel: "sms" })), plan);
});

test("a key that cannot be read maps to null, never to some milestone", () => {
  for (const bad of ["", "{}", "[]", "not json", JSON.stringify(["notification-v1", "a", "b", 15, "homeowner"]),
                     JSON.stringify(["notification-v2", "a", "b", 15, "homeowner"]),
                     JSON.stringify(["notification-v2", "a", "b", 15, "homeowner", "sms", "extra"]),
                     JSON.stringify(["notification-v2", "", "b", 15, "homeowner", "sms"]),
                     JSON.stringify(["notification-v2", "a", "b", 1.5, "homeowner", "sms"]),
                     JSON.stringify(["notification-v2", "a", "b", 15, "nobody", "sms"]),
                     milestonePlanKey(EVENT as any)]) {
    assert.equal(planKeyOfEventKey(bad), null, bad);
  }
});

test("a plan key is never a message key: a plan item cannot occupy a real send", () => {
  const plan = milestonePlanKey(EVENT as any);
  for (const channel of ["email", "sms"] as const) {
    assert.notEqual(plan, eventKey({ ...EVENT, channel }));
  }
});

// ------------------------------------------------------------------- planBatch

/**
 * Evidence is deliberately empty. `planNotification` will hold these requests
 * for every missing proof, which is correct and irrelevant here: the assertions
 * below read ONLY the two batch-level reasons, so a hold for anything else
 * cannot make a batch test pass or fail by accident.
 */
const NO_EVIDENCE = {
  source: {}, owner: {}, recipient: {}, dnd: {}, template: {},
  channelAuthorization: {}, facts: [], attempts: { records: [] },
} as any;

const request = (patch: Partial<Event> = {}) => ({
  preflight: NO_EVIDENCE, final: NO_EVIDENCE,
  event: {
    accountId: "acct-1", invoiceId: "inv-1", dayPastDue: 15, audience: "homeowner",
    sourceRevision: "r", ownerRevision: "r", ownerId: "owner-1", homeownerContactId: "contact-1",
    issuedDate: "2026-10-20", dueDate: "2026-11-02", balanceMinor: 13700, currency: "USD",
    category: null, recipientId: "contact-1", contactId: "contact-1", channel: "email",
    destination: "a@example.com", templateId: "t", templateVersion: "1",
    bodyDigest: "0".repeat(64), claimedFacts: [],
    ...patch,
  } as Event,
}) as any;

const reasonsFor = (requests: any[]) =>
  planBatch(requests, new Date("2026-11-17T16:05:00.000Z"))
    .map(plan => plan.reasons.filter(reason =>
      reason === "duplicate_event_in_batch" || reason === "simultaneous_contact_event_conflict"));

test("one text and one email for the same milestone is not a conflict", () => {
  assert.deepEqual(reasonsFor([request({ channel: "email" }), request({ channel: "sms" })]), [[], []]);
});

test("the same channel twice in one batch is still a duplicate", () => {
  const reasons = reasonsFor([request({ channel: "email" }), request({ channel: "email" })]);
  for (const entry of reasons) {
    assert.ok(entry.includes("duplicate_event_in_batch"), entry.join(" | "));
    assert.ok(entry.includes("simultaneous_contact_event_conflict"), entry.join(" | "));
  }
});

test("two different invoices for one contact still conflict: the daily cap holds", () => {
  const reasons = reasonsFor([request({ invoiceId: "inv-1" }), request({ invoiceId: "inv-2" })]);
  for (const entry of reasons) {
    assert.ok(entry.includes("simultaneous_contact_event_conflict"), entry.join(" | "));
  }
});

test("two different milestone days for one contact still conflict", () => {
  const reasons = reasonsFor([request({ dayPastDue: 15 }), request({ dayPastDue: 21 })]);
  for (const entry of reasons) {
    assert.ok(entry.includes("simultaneous_contact_event_conflict"), entry.join(" | "));
  }
});

test("a channel pair for one milestone plus a third message is a conflict", () => {
  // Two channels is the most a contact may hold. A third, whatever it is, is not.
  const reasons = reasonsFor([request({ channel: "email" }), request({ channel: "sms" }),
                              request({ channel: "email", invoiceId: "inv-2" })]);
  for (const entry of reasons) {
    assert.ok(entry.includes("simultaneous_contact_event_conflict"), entry.join(" | "));
  }
});

test("different contacts never conflict with each other", () => {
  assert.deepEqual(reasonsFor([
    request({ contactId: "contact-1", channel: "email" }),
    request({ contactId: "contact-2", channel: "email", invoiceId: "inv-2" }),
  ]), [[], []]);
});
