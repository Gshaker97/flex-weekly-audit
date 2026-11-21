/**
 * CREATING A CONTACT FROM JOBBER - and refusing to, which matters more.
 *
 * The decision is "when nothing matches, add the contact". The danger is that
 * "nothing matches" and "too much matches" reach the resolver looking the
 * same: `matchPhoneCustomer` reports "missing or ambiguous GHL phone" for an
 * empty candidate list and for a crowded one alike. Creating on the second
 * would plant a duplicate next to the records this project has spent days
 * merging, so most of what follows is about the refusals.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  contactCreationCheck, resolvePayers,
  type ResolverCard, type ResolverCustomer,
} from "../lib/ghl-contact-resolution";
import type { GhlContact } from "../lib/ghl";

// All invented. Phones are valid US forms unless a test is about an unusable one.
const cust = (
  n: number, email: string | null, phone: string | null = null,
  extra: Partial<ResolverCustomer> = {},
): ResolverCustomer => ({
  id: `cu${n}`, jobberClientId: `J${n}`, email, phone,
  name: `Customer ${n}`,
  address1: `${n} Example Way`, city: "Mesa", state: "Arizona", postalCode: "85207",
  ...extra,
});
const contact = (id: string, email: string | null, phone: string | null = null,
  extraEmails: string[] = []): GhlContact =>
  ({ id, email, phone, additionalEmails: extraEmails.map(e => ({ email: e })) });
const card = (id: string, contactId: string, status: string): ResolverCard =>
  ({ id, contactId, stageName: "Invoice Sent", status, monetaryValue: 100, name: id });

const run = (
  customers: ResolverCustomer[], contacts: GhlContact[], cards: ResolverCard[] = [],
  allCustomers: ResolverCustomer[] = customers,
) => resolvePayers({ customers, allCustomers, contacts, cards });

// --- the happy path, which must stay narrow -------------------------------

test("absent on both identifiers: the contact is planned from Jobber's record", () => {
  const c = cust(1, "new@example.test", "4805550111");
  const { payers, holds, creations } = run([c], [contact("C1", "other@example.test", "4805559999")]);
  assert.equal(payers.length, 0);
  assert.equal(holds.length, 0);
  assert.equal(creations.length, 1);
  const made = creations[0];
  assert.equal(made.name, "Customer 1");
  assert.equal(made.email, "new@example.test");
  assert.equal(made.phone, "4805550111");
  assert.equal(made.address1, "1 Example Way");
  assert.equal(made.city, "Mesa");
  assert.equal(made.state, "Arizona");
  assert.equal(made.postalCode, "85207");
  assert.equal(made.via, "email_and_phone_both_absent");
  assert.equal(made.customer.jobberClientId, "J1");
});

test("the placeholder id is marked as not a GoHighLevel id", () => {
  const { creations } = run([cust(1, "new@example.test")], []);
  assert.equal(creations[0].placeholderContactId, "new:J1");
  assert.match(creations[0].placeholderContactId, /^new:/);
});

test("email only, no phone: still created, and said so", () => {
  const { creations, holds } = run([cust(1, "new@example.test", null)], [contact("C1", "other@example.test")]);
  assert.equal(holds.length, 0);
  assert.equal(creations[0].via, "email_absent_no_phone");
  assert.equal(creations[0].phone, null);
});

test("phone only, no email: still created, and said so", () => {
  const { creations, holds } = run([cust(1, null, "4805550111")], [contact("C1", "other@example.test", "4805559999")]);
  assert.equal(holds.length, 0);
  assert.equal(creations[0].via, "phone_absent_no_email");
  assert.equal(creations[0].email, null);
});

test("blank address fields are carried as null, not as empty strings", () => {
  const c = cust(1, "new@example.test", null, { address1: "   ", city: null, state: "", postalCode: undefined });
  const { creations } = run([c], []);
  assert.equal(creations[0].address1, null);
  assert.equal(creations[0].city, null);
  assert.equal(creations[0].state, null);
  assert.equal(creations[0].postalCode, null);
});

// --- the refusals: every way a create could plant a duplicate -------------

test("a contact already carries the phone: matched, never created", () => {
  // The email misses, the phone hits - in a different format. The fallback
  // canonicalises both and resolves it, which is exactly how the duplicate
  // this rule guards against is avoided: by matching instead of creating.
  const c = cust(1, "new@example.test", "4805550111");
  const { creations, holds, payers } = run([c], [contact("C1", "someone@example.test", "480-555-0111")]);
  assert.equal(creations.length, 0, "a contact with this phone exists, so nothing is created");
  assert.equal(holds.length, 0);
  assert.equal(payers.length, 1);
  assert.equal(payers[0].via, "phone_fallback");
  assert.equal(payers[0].contactId, "C1");
});

test("two contacts carry the phone: ambiguous, so refused", () => {
  const c = cust(1, "new@example.test", "4805550111");
  const { creations, holds } = run([c], [
    contact("C1", "a@example.test", "4805550111"),
    contact("C2", "b@example.test", "4805550111"),
  ]);
  assert.equal(creations.length, 0);
  assert.match(holds[0].reason, /already carry this phone/);
});

test("an unreadable phone on the board that MIGHT be this one: refused", () => {
  // A partial or malformed number cannot be ruled out, and an unreadable
  // number is not evidence of absence.
  const c = cust(1, "new@example.test", "4805550111");
  const { creations, holds } = run([c], [contact("C1", "a@example.test", "555-0111")]);
  assert.equal(creations.length, 0);
  assert.match(holds[0].reason, /unreadable phone that may be this one/);
});

test("the customer's own phone is unreadable: refused, because absence cannot be proved", () => {
  const { creations, holds } = run([cust(1, "new@example.test", "nonsense")], []);
  assert.equal(creations.length, 0);
  assert.match(holds[0].reason, /phone cannot be read/);
});

test("another Jobber customer shares the phone: refused as ambiguous", () => {
  const mine = cust(1, "new@example.test", "4805550111");
  const other = cust(2, "other@example.test", "4805550111");
  const { creations, holds } = run([mine], [], [], [mine, other]);
  assert.equal(creations.length, 0);
  assert.match(holds[0].reason, /another Jobber customer shares this phone/);
});

test("no email and no phone: refused, because it could never be matched again", () => {
  const { creations, holds } = run([cust(1, null, null)], []);
  assert.equal(creations.length, 0);
  assert.match(holds[0].reason, /neither an email nor a phone/);
});

test("no name in Jobber: refused, there is nothing to create the contact from", () => {
  const { creations, holds } = run([cust(1, "new@example.test", null, { name: null })], []);
  assert.equal(creations.length, 0);
  assert.match(holds[0].reason, /no name to create one from/);
});

test("several Jobber customers behind one email: still a hold, never a create", () => {
  // One payer, but not one identity: no single name, phone or address exists.
  const a = cust(1, "shared@example.test", "4805550111");
  const b = cust(2, "shared@example.test", "4805550222");
  const { creations, holds, payers } = run([a, b], []);
  assert.equal(creations.length, 0);
  assert.equal(payers.length, 0);
  assert.equal(holds.length, 1);
  assert.match(holds[0].reason, /no single name, phone or address/);
  assert.deepEqual([...holds[0].jobberClientIds].sort(), ["J1", "J2"]);
});

test("the email is on a contact as a SECONDARY address: matched, not created", () => {
  const c = cust(1, "new@example.test", null);
  const { creations, payers } = run([c], [contact("C1", "primary@example.test", null, ["new@example.test"])]);
  assert.equal(creations.length, 0);
  assert.equal(payers.length, 1);
  assert.equal(payers[0].via, "secondary_email");
});

test("duplicate contacts on the email stay a merge hold, never a create", () => {
  const c = cust(1, "dup@example.test", null);
  const { creations, holds } = run([c], [contact("C1", "dup@example.test"), contact("C2", "dup@example.test")]);
  assert.equal(creations.length, 0);
  assert.match(holds[0].reason, /Merge the duplicate contacts/);
});

test("several absent customers each get exactly one contact, with distinct placeholders", () => {
  const a = cust(1, "a@example.test", "4805550111");
  const b = cust(2, "b@example.test", "4805550222");
  const d = cust(3, "c@example.test", null);
  const { creations, holds } = run([a, b, d], []);
  assert.equal(holds.length, 0);
  const ids = creations.map(c => c.customer.jobberClientId);
  assert.deepEqual([...ids].sort(), ["J1", "J2", "J3"]);
  const placeholders = creations.map(c => c.placeholderContactId);
  assert.equal(placeholders.length, new Set(placeholders).size, "one placeholder each");
});

// --- the check in isolation, so its order of refusals is pinned -----------

test("contactCreationCheck reports identifier problems before the missing name", () => {
  const nameless = cust(1, "new@example.test", "nonsense", { name: null });
  const out = contactCreationCheck(nameless, [nameless], [nameless], []);
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.reason, /phone cannot be read/);
});

test("contactCreationCheck passes when both identifiers are provably absent", () => {
  const c = cust(1, "new@example.test", "4805550111");
  const out = contactCreationCheck(c, [c], [c], [contact("C9", "z@example.test", "4805559999")]);
  assert.equal(out.ok, true);
});

// --- a finished card is history, not a blocker ----------------------------

test("a contact whose only card is won gets that card reported as finished", () => {
  const c = cust(1, "ana@example.test", "4805550101");
  const { payers } = run([c], [contact("C1", "ana@example.test", "4805550101")], [card("K1", "C1", "won")]);
  assert.equal(payers.length, 1);
  assert.equal(payers[0].openCards.length, 0, "a won card is not live");
  assert.deepEqual(payers[0].finishedCards.map(k => k.id), ["K1"]);
});

test("an open card is live and is not reported as finished", () => {
  const c = cust(1, "ana@example.test", "4805550101");
  const { payers } = run([c], [contact("C1", "ana@example.test", "4805550101")], [card("K1", "C1", "open")]);
  assert.deepEqual(payers[0].openCards.map(k => k.id), ["K1"]);
  assert.equal(payers[0].finishedCards.length, 0);
});

test("another contact's finished card is not attributed to this payer", () => {
  const c = cust(1, "ana@example.test", "4805550101");
  const { payers } = run([c], [contact("C1", "ana@example.test", "4805550101")], [card("K9", "C9", "won")]);
  assert.equal(payers[0].finishedCards.length, 0);
});
