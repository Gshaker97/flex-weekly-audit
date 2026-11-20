import test from "node:test";
import assert from "node:assert/strict";
import { addressKey, chooseDestinationByAddress } from "../lib/reminder-destination-address";
import { evaluateReminders } from "../lib/reminder-evaluation";

/**
 * One person can be several Jobber clients, one per service address.
 *
 * Measured in this account on 2026-11-18: of 30 past-due invoices whose customer
 * matches more than one GoHighLevel contact, 7 are separate Jobber clients
 * sharing an email — a landlord or a second property, not a duplicate record.
 * Account-wide, 32 emails cover more than one Jobber client.
 *
 * Choosing by email there would post one property's invoice against another
 * property's record. These tests pin the address rule that resolves it, and
 * pin that it relaxes nothing: a contact chosen by address still faces every
 * check it would have faced as a sole match.
 */

// ---------------------------------------------------------------- addressKey

test("an address needs a number, a street word and an area to be comparable", () => {
  assert.equal(addressKey(null), null);
  assert.equal(addressKey({}), null);
  assert.equal(addressKey({ street1: "   " }), null);
  // no street number
  assert.equal(addressKey({ street1: "Main Street", postalCode: "85001" }), null);
  // number but no street word
  assert.equal(addressKey({ street1: "123", postalCode: "85001" }), null);
  // neither postcode nor city: a number and a street name repeat across towns
  assert.equal(addressKey({ street1: "123 Main St" }), null);
});

test("the same place written two ways gives one key", () => {
  const a = addressKey({ street1: "123 E Main St", city: "Mesa", postalCode: "85001" });
  const b = addressKey({ street1: "123 East Main Street.", city: "mesa", postalCode: "85001-1234" });
  assert.ok(a);
  assert.equal(a, b);
});

test("every street-type and direction abbreviation in the table collapses", () => {
  const long = addressKey({ street1: "77 Northwest Juniper Boulevard", postalCode: "85001" });
  assert.equal(addressKey({ street1: "77 NW Juniper Blvd", postalCode: "85001" }), long);
  assert.equal(addressKey({ street1: "9 S Oak Ave", postalCode: "85001" }),
    addressKey({ street1: "9 South Oak Avenue", postalCode: "85001" }));
  assert.equal(addressKey({ street1: "4 W Pine Dr", postalCode: "85001" }),
    addressKey({ street1: "4 West Pine Drive", postalCode: "85001" }));
});

test("a unit or suite marker does not split one address in two", () => {
  const plain = addressKey({ street1: "500 Palm Rd", postalCode: "85282" });
  for (const suffixed of ["500 Palm Rd Apt 4", "500 Palm Rd #12", "500 Palm Rd Unit B",
                          "500 Palm Rd Ste 300", "500 Palm Rd Bldg 2"]) {
    assert.equal(addressKey({ street1: suffixed, postalCode: "85282" }), plain, suffixed);
  }
});

test("a different street number or a different postcode is a different place", () => {
  const base = addressKey({ street1: "123 Main St", postalCode: "85001" });
  assert.notEqual(addressKey({ street1: "125 Main St", postalCode: "85001" }), base);
  assert.notEqual(addressKey({ street1: "123 Main St", postalCode: "85002" }), base);
  assert.notEqual(addressKey({ street1: "123 Oak St", postalCode: "85001" }), base);
});

test("the city stands in for a missing postcode, and does not collide with one", () => {
  const byCity = addressKey({ street1: "123 Main St", city: "Gilbert" });
  assert.ok(byCity);
  assert.equal(addressKey({ street1: "123 main street", city: "  GILBERT " }), byCity);
  // A postcode key and a city key are different keys, so a half-known address
  // never matches a fully-known one by accident.
  assert.notEqual(addressKey({ street1: "123 Main St", city: "Gilbert", postalCode: "85001" }), byCity);
});

test("a postcode too short to be a postcode is not used as one", () => {
  assert.equal(addressKey({ street1: "123 Main St", postalCode: "85" }), null);
  assert.equal(addressKey({ street1: "123 Main St", postalCode: "85", city: "Mesa" }),
    addressKey({ street1: "123 Main St", city: "Mesa" }));
});

// -------------------------------------------------- chooseDestinationByAddress

const PROPERTY = { street1: "123 E Main St", city: "Mesa", postalCode: "85001" };
const OTHER = { street1: "900 W Oak Ave", city: "Tempe", postalCode: "85282" };

test("one contact needs no choosing", () => {
  const choice = chooseDestinationByAddress({
    contacts: [{ id: "c1", street1: null, city: null, postalCode: null }],
    propertyAddresses: null,
  });
  assert.equal(choice.contactId, "c1");
  assert.equal(choice.reason, "single_contact_no_choice_needed");
});

test("no contacts chooses nothing", () => {
  assert.equal(chooseDestinationByAddress({ contacts: [], propertyAddresses: [PROPERTY] }).contactId, null);
});

test("exactly one contact at the Jobber property address is the destination", () => {
  const choice = chooseDestinationByAddress({
    contacts: [{ id: "c1", ...OTHER }, { id: "c2", ...PROPERTY }],
    propertyAddresses: [PROPERTY],
  });
  assert.equal(choice.contactId, "c2");
  assert.equal(choice.reason, "chosen_by_matching_jobber_property_address");
});

test("the match survives the two systems spelling the street differently", () => {
  const choice = chooseDestinationByAddress({
    contacts: [{ id: "c1", ...OTHER },
               { id: "c2", street1: "123 East Main Street", city: "Mesa", postalCode: "85001-0002" }],
    propertyAddresses: [PROPERTY],
  });
  assert.equal(choice.contactId, "c2");
});

test("a client with several properties matches on any one of them", () => {
  const choice = chooseDestinationByAddress({
    contacts: [{ id: "c1", street1: "55 Palm Rd", city: "Mesa", postalCode: "85203" },
               { id: "c2", ...OTHER }],
    propertyAddresses: [PROPERTY, OTHER],
  });
  assert.equal(choice.contactId, "c2");
});

test("unreadable Jobber addresses hold; unreadable is never 'no address'", () => {
  const choice = chooseDestinationByAddress({
    contacts: [{ id: "c1", ...PROPERTY }, { id: "c2", ...OTHER }],
    propertyAddresses: null,
  });
  assert.equal(choice.contactId, null);
  assert.equal(choice.reason, "jobber_property_addresses_unreadable");
});

test("Jobber addresses too vague to compare hold", () => {
  const choice = chooseDestinationByAddress({
    contacts: [{ id: "c1", ...PROPERTY }, { id: "c2", ...OTHER }],
    propertyAddresses: [{ street1: "Main Street", city: "Mesa" }, {}],
  });
  assert.equal(choice.contactId, null);
  assert.equal(choice.reason, "no_comparable_jobber_property_address");
});

test("two contacts AT the property address hold: that is one place, not a choice", () => {
  const choice = chooseDestinationByAddress({
    contacts: [{ id: "c1", ...PROPERTY },
               { id: "c2", street1: "123 East Main St.", city: "Mesa", postalCode: "85001" }],
    propertyAddresses: [PROPERTY],
  });
  assert.equal(choice.contactId, null);
  assert.equal(choice.reason, "several_contacts_share_the_jobber_property_address: 2");
});

test("no contact at the property address holds, with the compared count", () => {
  const choice = chooseDestinationByAddress({
    contacts: [{ id: "c1", ...OTHER },
               { id: "c2", street1: "7 Cedar Ln", city: "Chandler", postalCode: "85225" }],
    propertyAddresses: [PROPERTY],
  });
  assert.equal(choice.contactId, null);
  assert.equal(choice.reason, "no_contact_address_matches_a_jobber_property: 2 compared");
});

test("contacts with no usable address of their own hold, named separately", () => {
  const choice = chooseDestinationByAddress({
    contacts: [{ id: "c1", street1: null, city: "Mesa", postalCode: "85001" },
               { id: "c2", street1: "", city: null, postalCode: null }],
    propertyAddresses: [PROPERTY],
  });
  assert.equal(choice.contactId, null);
  assert.equal(choice.reason, "no_contact_has_a_comparable_address");
});

test("a contact is never chosen by area alone", () => {
  // Same postcode, different street. Must not match.
  const choice = chooseDestinationByAddress({
    contacts: [{ id: "c1", street1: "999 Elm St", city: "Mesa", postalCode: "85001" },
               { id: "c2", street1: "888 Fir St", city: "Mesa", postalCode: "85001" }],
    propertyAddresses: [PROPERTY],
  });
  assert.equal(choice.contactId, null);
});

// --------------------------------------------------- inside the evaluation

const SOURCE = {
  invoiceStatus: "past_due", totalCents: 13700, balanceCents: 13700,
  issuedDate: "2026-10-20", dueDate: "2026-11-02",
  clientId: "cli-1", clientTags: ["Irrigation"], lineItemNames: ["Irrigation repair"],
  clientBillingEmails: ["a@example.com"],
  clientPropertyAddresses: [PROPERTY],
};
const CANDIDATE = { jobberInvoiceId: "inv-1", invoiceNumber: "7207", clientName: "A",
  jobberClientId: "cli-1", email: "a@example.com", phone: "+16025550100" };
const HERE = { id: "c2", tags: ["Irrigation"], dnd: false, emailDndStatus: "inactive",
  phone: "+16025550100", email: "a@example.com", ...PROPERTY };
const ELSEWHERE = { id: "c1", tags: ["Irrigation"], dnd: false, emailDndStatus: "inactive",
  phone: "+16025550100", email: "a@example.com", ...OTHER };
const AT_DAY_15 = new Date("2026-11-17T16:05:00.000Z");

const run = async (source: Record<string, unknown>, contacts: Record<string, unknown>[],
                   onHistory?: (contactId: string | null | undefined) => void) => {
  const result = await evaluateReminders({
    candidates: [CANDIDATE],
    readers: {
      readInvoice: async () => source,
      matchContacts: async () => contacts,
      cardsForContact: async () => [{ id: "o1", stage: "invoice overdue", status: "open" }],
      sendHistory: async (_c: unknown, context: any) => {
        onHistory?.(context?.contactId);
        return { complete: true, sends: [] };
      },
    } as any,
    now: AT_DAY_15, verifiedExclusions: ["cli-x"], ignoreWindow: true,
    milestoneChannels: () => ["email"], feeClaimFreeDay15: true, jobberOnlyDay15Email: true,
  } as any);
  return result.rows[0];
};

const ambiguity = (row: any) =>
  row.holds.filter((hold: string) => hold.startsWith("ambiguous_destination_contacts"));

test("two contacts at two addresses no longer hold once Jobber names the place", async () => {
  const row = await run(SOURCE, [ELSEWHERE, HERE]);
  assert.deepEqual(ambiguity(row), []);
});

test("the resolved contact is the one the history is read for", async () => {
  let asked: string | null | undefined = "unset";
  await run(SOURCE, [ELSEWHERE, HERE], id => { asked = id; });
  assert.equal(asked, "c2");
});

test("without Jobber addresses two contacts still hold, and say why", async () => {
  const { clientPropertyAddresses, ...noAddresses } = SOURCE;
  const row = await run(noAddresses, [ELSEWHERE, HERE]);
  assert.equal(ambiguity(row).length, 1);
  assert.match(ambiguity(row)[0], /2 exact matches, not merged \(jobber_property_addresses_unreadable\)/);
  assert.equal(await run({ ...SOURCE, clientPropertyAddresses: null }, [ELSEWHERE, HERE])
    .then(r => ambiguity(r).length), 1);
});

test("two contacts the address cannot separate still hold, with the reason", async () => {
  const row = await run(SOURCE, [{ ...ELSEWHERE, ...PROPERTY }, HERE]);
  assert.equal(ambiguity(row).length, 1);
  assert.match(ambiguity(row)[0], /several_contacts_share_the_jobber_property_address: 2/);
});

test("a contact chosen by address still faces the global opt-out", async () => {
  const row = await run(SOURCE, [ELSEWHERE, { ...HERE, dnd: true }]);
  assert.deepEqual(ambiguity(row), []);
  assert.ok(row.holds.includes("destination_contact_opted_out"), row.holds.join(" | "));
});

test("a contact chosen by address still faces the Email opt-out", async () => {
  const row = await run(SOURCE, [ELSEWHERE, { ...HERE, emailDndStatus: "active" }]);
  assert.deepEqual(ambiguity(row), []);
  assert.ok(row.holds.includes("destination_contact_email_opted_out"), row.holds.join(" | "));
});

test("a contact chosen by address still has to be one Jobber bills", async () => {
  const row = await run(SOURCE, [ELSEWHERE, { ...HERE, email: "someone-else@example.com" }]);
  assert.deepEqual(ambiguity(row), []);
  assert.ok(row.holds.includes("destination_email_not_a_jobber_billing_email"), row.holds.join(" | "));
});

test("the OTHER contact's opt-out does not travel to the one Jobber points at", async () => {
  // c1 is a different property's record. Its state is not this invoice's.
  const row = await run(SOURCE, [{ ...ELSEWHERE, dnd: true }, HERE]);
  assert.deepEqual(ambiguity(row), []);
  assert.ok(!row.holds.includes("destination_contact_opted_out"), row.holds.join(" | "));
});

test("a single contact is unaffected by any of this", async () => {
  const row = await run({ ...SOURCE, clientPropertyAddresses: null },
    [{ ...HERE, street1: null, city: null, postalCode: null }]);
  assert.deepEqual(ambiguity(row), []);
});
