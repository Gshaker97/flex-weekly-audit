/**
 * Jobber's billing address, reduced to what a GoHighLevel contact carries.
 *
 * Two things are easy to break silently here: a blank Jobber field stored as
 * "" instead of null (so a created contact carries a blank street and looks
 * synced), and a dropped `street2` (so a unit or suite number vanishes and the
 * address points at the right building but the wrong door). Most of these
 * tests are about those two.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  EMPTY_BILLING_ADDRESS, billingField, billingStreetLine,
  hasBillingAddress, jobberBillingAddress,
} from "../lib/jobber-billing-address";

// All invented addresses.
const full = {
  street1: "3711 North Hawes Road",
  street2: "Suite 4",
  city: "Mesa",
  province: "Arizona",
  postalCode: "85207",
};

test("a complete address maps field for field", () => {
  const a = jobberBillingAddress({ ...full, street2: null });
  assert.deepEqual({ ...a }, {
    billingStreet: "3711 North Hawes Road",
    billingCity: "Mesa",
    billingState: "Arizona",
    billingPostalCode: "85207",
  });
});

test("Jobber's province becomes the contact's state", () => {
  assert.equal(jobberBillingAddress(full).billingState, "Arizona");
});

test("two street lines are joined, not dropped", () => {
  // Losing "Suite 4" sends someone to the right building and the wrong door.
  assert.equal(jobberBillingAddress(full).billingStreet, "3711 North Hawes Road, Suite 4");
});

test("street2 alone is still an address", () => {
  assert.equal(jobberBillingAddress({ street1: null, street2: "Unit 9" }).billingStreet, "Unit 9");
});

test("street1 alone is unchanged", () => {
  assert.equal(jobberBillingAddress({ street1: "1 Example Way" }).billingStreet, "1 Example Way");
});

test("blank fields become null, never an empty string", () => {
  // Stored as "", these would look like a synced address that is simply empty.
  const a = jobberBillingAddress({ street1: "   ", street2: "", city: "  ", province: "", postalCode: "   " });
  assert.deepEqual({ ...a }, { ...EMPTY_BILLING_ADDRESS });
  for (const v of Object.values(a)) assert.equal(v, null);
});

test("every field is trimmed", () => {
  const a = jobberBillingAddress({ street1: "  1 Example Way  ", city: " Mesa ", province: " AZ ", postalCode: " 85207 " });
  assert.equal(a.billingStreet, "1 Example Way");
  assert.equal(a.billingCity, "Mesa");
  assert.equal(a.billingState, "AZ");
  assert.equal(a.billingPostalCode, "85207");
});

test("a blank street2 does not leave a trailing comma", () => {
  assert.equal(jobberBillingAddress({ street1: "1 Example Way", street2: "   " }).billingStreet, "1 Example Way");
});

test("no billing address at all is all-null, not a throw", () => {
  assert.deepEqual({ ...jobberBillingAddress(null) }, { ...EMPTY_BILLING_ADDRESS });
  assert.deepEqual({ ...jobberBillingAddress(undefined) }, { ...EMPTY_BILLING_ADDRESS });
});

test("a partial address keeps what exists and nulls the rest", () => {
  const a = jobberBillingAddress({ city: "Mesa", postalCode: "85207" });
  assert.equal(a.billingStreet, null);
  assert.equal(a.billingCity, "Mesa");
  assert.equal(a.billingState, null);
  assert.equal(a.billingPostalCode, "85207");
});

test("non-string junk is treated as absent, not coerced", () => {
  const a = jobberBillingAddress({ street1: 42 as never, city: {} as never, postalCode: [] as never });
  assert.equal(a.billingStreet, null);
  assert.equal(a.billingCity, null);
  assert.equal(a.billingPostalCode, null);
});

test("hasBillingAddress is false only when nothing survived", () => {
  assert.equal(hasBillingAddress(jobberBillingAddress(full)), true);
  assert.equal(hasBillingAddress(jobberBillingAddress({ postalCode: "85207" })), true);
  assert.equal(hasBillingAddress(jobberBillingAddress({ street1: "  " })), false);
  assert.equal(hasBillingAddress(EMPTY_BILLING_ADDRESS), false);
});

test("the result is frozen, so no caller can edit a shared address", () => {
  const a = jobberBillingAddress(full);
  assert.equal(Object.isFrozen(a), true);
});

test("the helpers behave on their own", () => {
  assert.equal(billingField("  x "), "x");
  assert.equal(billingField("   "), null);
  assert.equal(billingField(null), null);
  assert.equal(billingStreetLine("a", "b"), "a, b");
  assert.equal(billingStreetLine(null, null), null);
});

// --- the shape the sync spreads into Prisma ------------------------------

test("the keys are exactly the Customer columns the sync writes", () => {
  assert.deepEqual(Object.keys(jobberBillingAddress(full)).sort(),
    ["billingCity", "billingPostalCode", "billingState", "billingStreet"]);
});

test("an address that disappears in Jobber overwrites the stored one with null", () => {
  // The sync spreads this object into both create and update, so a client
  // whose address is deleted in Jobber must not keep a stale one here.
  const gone = jobberBillingAddress(null);
  assert.equal(Object.values(gone).every(v => v === null), true);
  assert.equal(Object.keys(gone).length, 4, "all four columns are always written");
});
