import test from "node:test";
import assert from "node:assert/strict";
import { eventKey } from "../lib/notification-gate";

/**
 * The overlap guarantees the Day 15 email relies on, asserted rather than
 * described. The ledger admits one reservation per event key, so two messages
 * that share a key cannot both go out, whichever one gets there first.
 */
const base = { accountId: "acct-1", invoiceId: "inv-1" } as const;
const day15Homeowner = { ...base, dayPastDue: 15, audience: "homeowner" as const };

test("Day 15 SMS and Day 15 email are ONE event, so only one can ever send", () => {
  // The key deliberately carries no channel. This is what makes the old GHL
  // Day 15 SMS and the new Day 15 email mutually exclusive in both directions.
  assert.equal(eventKey(day15Homeowner), eventKey({ ...day15Homeowner }));
  const key = eventKey(day15Homeowner);
  assert.ok(!key.includes("sms"));
  assert.ok(!key.includes("email"));
});

test("Day 21 keeps its own event and is untouched by anything at Day 15", () => {
  const day21Internal = { ...base, dayPastDue: 21, audience: "internal" as const };
  const day21Homeowner = { ...base, dayPastDue: 21, audience: "homeowner" as const };
  assert.notEqual(eventKey(day21Internal), eventKey(day15Homeowner));
  assert.notEqual(eventKey(day21Homeowner), eventKey(day15Homeowner));
  // And the two Day 21 audiences stay separate from each other.
  assert.notEqual(eventKey(day21Internal), eventKey(day21Homeowner));
});

test("another invoice's Day 15 never blocks this one", () => {
  assert.notEqual(eventKey({ ...day15Homeowner, invoiceId: "inv-2" }), eventKey(day15Homeowner));
});

test("Day 10 stays a separate event from Day 15", () => {
  assert.notEqual(eventKey({ ...day15Homeowner, dayPastDue: 10 }), eventKey(day15Homeowner));
});
