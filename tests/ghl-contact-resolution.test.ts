import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  competitorsExcluding, contactEmails, isLiveCard, resolvePayers,
  type ResolverCard, type ResolverCustomer,
} from "../lib/ghl-contact-resolution";
import type { GhlContact } from "../lib/ghl";

// All invented. Phones are valid US forms so the strict guard can canonicalise
// them; an uncanonicalisable phone makes the guard refuse on format alone.
const cust = (n: number, email: string | null, phone: string | null = null): ResolverCustomer =>
  ({ id: `cu${n}`, jobberClientId: `J${n}`, email, phone });
const contact = (id: string, email: string | null, phone: string | null = null,
  extraEmails: string[] = []): GhlContact =>
  ({ id, email, phone, additionalEmails: extraEmails.map(e => ({ email: e })) });
const card = (id: string, contactId: string, stageName: string, status: string): ResolverCard =>
  ({ id, contactId, stageName, status, monetaryValue: 100, name: id });

const run = (
  customers: ResolverCustomer[], contacts: GhlContact[], cards: ResolverCard[] = [],
  allCustomers: ResolverCustomer[] = customers,
) => resolvePayers({ customers, allCustomers, contacts, cards });

test("a plain primary-email match resolves to one payer", () => {
  const c = cust(1, "ana@example.test", "4805550101");
  const { payers, holds } = run([c], [contact("C1", "ana@example.test", "4805550101")]);
  assert.equal(holds.length, 0);
  assert.equal(payers.length, 1);
  assert.equal(payers[0].contactId, "C1");
  assert.equal(payers[0].via, "primary_email");
  assert.deepEqual(payers[0].customers.map(x => x.jobberClientId), ["J1"]);
});

test("the email matches on a SECONDARY address, which the old path ignored", () => {
  const c = cust(1, "billing@example.test", "4805550102");
  const only = contact("C1", "front-desk@example.test", "4805550102", ["billing@example.test"]);
  const { payers, holds } = run([c], [only]);
  assert.equal(holds.length, 0, holds.map(h => h.reason).join("; "));
  assert.equal(payers[0].contactId, "C1");
  assert.equal(payers[0].via, "secondary_email");
});

test("two Jobber customers on one email become ONE card for the shared contact", () => {
  const a = cust(1, "shared@example.test");
  const b = cust(2, "shared@example.test");
  const { payers, holds } = run([a, b], [contact("C1", "shared@example.test")]);
  assert.equal(holds.length, 0, holds.map(h => h.reason).join("; "));
  assert.equal(payers.length, 1, "one contact can hold only one open card");
  assert.deepEqual([...payers[0].customers.map(x => x.jobberClientId)].sort(), ["J1", "J2"]);
});

test("co-payers do not count as a rival owner, but an outsider still does", () => {
  const a = cust(1, "shared@example.test");
  const b = cust(2, "shared@example.test");
  // An unrelated Jobber customer also carries the contact's address.
  const outsider = cust(9, "shared@example.test");
  const contacts = [contact("C1", "shared@example.test")];
  const grouped = run([a, b], contacts, [], [a, b, outsider]);
  // The outsider is in scope as a competitor, and it genuinely conflicts.
  assert.equal(grouped.payers.length, 0);
  assert.match(grouped.holds[0].reason, /ownership guard/);
  // With no outsider, the same group resolves.
  const clean = run([a, b], contacts, [], [a, b]);
  assert.equal(clean.payers.length, 1);
  assert.equal(clean.holds.length, 0);
});

test("duplicate contacts on one email are refused and told to merge", () => {
  const c = cust(1, "dupe@example.test");
  const { payers, holds } = run([c], [
    contact("C1", "dupe@example.test"),
    contact("C2", "dupe@example.test"),
  ]);
  assert.equal(payers.length, 0);
  assert.equal(holds.length, 1);
  assert.match(holds[0].reason, /2 GoHighLevel contacts carry this email/);
  assert.match(holds[0].reason, /Merge the duplicate contacts in GoHighLevel/);
  assert.deepEqual([...holds[0].candidateContactIds].sort(), ["C1", "C2"]);
});

test("duplicates are STILL refused when one of them holds the live card", () => {
  // The tempting case: C2 is demonstrably in use. It is refused anyway, because
  // the ownership guard would veto it and overriding that relaxes a duplicate
  // protection. The reason names C2 so a person can merge into it.
  const c = cust(1, "dupe@example.test");
  const { payers, holds } = run([c], [
    contact("C1", "dupe@example.test"),
    contact("C2", "dupe@example.test"),
  ], [card("K1", "C2", "Invoice Sent", "open")]);
  assert.equal(payers.length, 0);
  assert.match(holds[0].reason, /one of them holds the open card \(C2\)/);
});

test("a customer with an email no contact carries falls back to phone", () => {
  // The old path only tried phone for customers with NO email at all.
  const c = cust(1, "absent@example.test", "4805550103");
  const { payers, holds } = run([c], [contact("C1", "someone@example.test", "4805550103")]);
  assert.equal(holds.length, 0, holds.map(h => h.reason).join("; "));
  assert.equal(payers[0].contactId, "C1");
  assert.equal(payers[0].via, "phone_fallback");
});

test("no contact and no usable phone is refused with an actionable reason", () => {
  const c = cust(1, "absent@example.test", null);
  const { payers, holds } = run([c], [contact("C1", "someone@example.test")]);
  assert.equal(payers.length, 0);
  // Nameless in Jobber, so there is nothing to create a contact FROM: still a
  // hold, and the reason still names the action a person has to take.
  assert.match(holds[0].reason, /no GoHighLevel contact carries this email/);
  assert.match(holds[0].reason, /add the contact in GoHighLevel/);
});

test("a shared billing email with no contact is never resolved by one member's phone", () => {
  // Whose phone is it? The group tells us nothing, so do not guess.
  const a = cust(1, "shared@example.test", "4805550104");
  const b = cust(2, "shared@example.test", null);
  const { payers, holds } = run([a, b], [contact("C1", "other@example.test", "4805550104")]);
  assert.equal(payers.length, 0);
  assert.match(holds[0].reason, /several Jobber customers share this email/);
  assert.deepEqual([...holds[0].jobberClientIds].sort(), ["J1", "J2"]);
});

test("a won card is history: it neither identifies a contact nor blocks one", () => {
  const c = cust(1, "ana@example.test");
  const { payers } = run([c], [contact("C1", "ana@example.test")], [
    card("K1", "C1", "Closed Out", "won"),
    card("K2", "C1", "Invoice Sent", "open"),
  ]);
  assert.equal(payers.length, 1);
  assert.deepEqual(payers[0].openCards.map(k => k.id), ["K2"], "only the open card is live");
});

test("a contact whose only card is won is reported with no live cards", () => {
  const c = cust(1, "ana@example.test");
  const { payers } = run([c], [contact("C1", "ana@example.test")],
    [card("K1", "C1", "Closed Out", "won")]);
  assert.equal(payers.length, 1);
  assert.equal(payers[0].openCards.length, 0, "so the plan will create, not reuse");
});

test("two live cards on the resolved contact are passed through for the plan to refuse", () => {
  // Resolution's job is the payer, not the card. The plan holds on >1 card.
  const c = cust(1, "ana@example.test");
  const { payers } = run([c], [contact("C1", "ana@example.test")], [
    card("K1", "C1", "Invoice Sent", "open"),
    card("K2", "C1", "Invoice Overdue", "open"),
  ]);
  assert.equal(payers[0].openCards.length, 2);
});

test("a phone that disagrees with the contact is refused by the guard", () => {
  const c = cust(1, "ana@example.test", "4805550105");
  const { payers, holds } = run([c], [contact("C1", "ana@example.test", "4805550106")]);
  assert.equal(payers.length, 0);
  assert.match(holds[0].reason, /ownership guard/);
});

test("each customer and each email is resolved once only", () => {
  const a = cust(1, "shared@example.test");
  const b = cust(2, "shared@example.test");
  const c = cust(3, "solo@example.test");
  const { payers } = run([a, b, c], [
    contact("C1", "shared@example.test"),
    contact("C2", "solo@example.test"),
  ]);
  assert.equal(payers.length, 2);
  const covered = payers.flatMap(p => p.customers.map(x => x.jobberClientId));
  assert.equal(covered.length, new Set(covered).size, "no customer appears twice");
});

test("helpers behave", () => {
  assert.deepEqual(contactEmails(contact("C1", "A@Example.test", null, ["b@example.test"])),
    ["a@example.test", "b@example.test"]);
  assert.equal(isLiveCard({ id: "k", status: "open" }), true);
  assert.equal(isLiveCard({ id: "k", status: "won" }), false);
  assert.equal(isLiveCard({ id: "k", status: null }), false);
  const all = [cust(1, "a@example.test"), cust(2, "b@example.test")];
  assert.deepEqual(competitorsExcluding(all, [all[0]]).map(c => c.jobberClientId), ["J2"]);
});

test("a customer with no email and no usable phone is refused, not skipped", () => {
  const c = cust(1, null, "nonsense");
  const { payers, holds } = run([c], [contact("C1", "ana@example.test")]);
  assert.equal(payers.length, 0);
  assert.equal(holds.length, 1);
  // An unreadable Jobber number cannot be searched for, so absence from the
  // board cannot be proved and no contact may be created from it.
  assert.match(holds[0].reason, /phone cannot be read/);
});
