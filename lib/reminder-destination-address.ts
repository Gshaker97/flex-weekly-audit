/**
 * Which GoHighLevel contact is this invoice's customer, when several match?
 *
 * WHY THIS EXISTS. Matching a destination on email or phone alone returns more
 * than one contact for 30 of the 43 past-due invoices in this account. That was
 * first written off as duplicate records. It is not: measured 2026-11-18, 688
 * distinct customer emails cover 73 Jobber clients, because **32 emails belong
 * to more than one Jobber client**. One person can be several Jobber clients,
 * one per service address — a landlord, a property manager, a second home.
 *
 * Seven of those thirty groups are exactly that, confirmed two independent ways:
 * several separate Jobber clients share the email, AND the GoHighLevel copies
 * differ by both street number and postcode. For those, choosing a contact by
 * email would post one property's invoice against another property's record.
 *
 * So the destination is chosen by ADDRESS, against the service addresses Jobber
 * itself holds for the client that owns this invoice. The rule is deliberately
 * all-or-nothing:
 *
 *   exactly one contact matches a Jobber property address -> that is the one
 *   none match, or two or more match                      -> hold, as before
 *
 * This RELAXES NOTHING. A contact chosen here still faces every check it would
 * have faced as a sole match: global opt-out, the Email consent reading, the
 * Jobber billing-address comparison, the fresh balance, the overlap and prior
 * send history. The only thing that changes is that an answerable question is
 * answered instead of held.
 */

/** One postal address, as either provider states it. Any field may be absent. */
export interface AddressParts {
  street1?: string | null;
  city?: string | null;
  postalCode?: string | null;
}

/**
 * Street-type and direction words that the two systems spell differently for
 * the same place. Measured in this account: four groups differed only by this.
 */
const WORDS: Record<string, string> = {
  st: "street", str: "street", ave: "avenue", av: "avenue", rd: "road",
  dr: "drive", ln: "lane", ct: "court", blvd: "boulevard", bl: "boulevard",
  pl: "place", cir: "circle", trl: "trail", pkwy: "parkway", pky: "parkway",
  hwy: "highway", sq: "square", ter: "terrace", terr: "terrace", way: "way",
  n: "north", s: "south", e: "east", w: "west",
  ne: "northeast", nw: "northwest", se: "southeast", sw: "southwest",
};

/** A unit or suite marker. Dropped: the two systems disagree on it constantly. */
const UNIT = /\b(?:apt|apartment|unit|ste|suite|lot|bldg|building|#)\b.*$/i;

function words(street: string): string[] {
  return street
    .replace(UNIT, " ")
    .replace(/[.,]/g, " ")
    .replace(/[^a-z0-9\s]/gi, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map(word => WORDS[word] ?? word);
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * A comparable key for one address, or null when there is not enough to compare.
 *
 * Requires a street number AND at least one street word, so a bare city or a
 * lone postcode can never match anything. The second component is the postcode
 * when present, else the city; without either the key is null, because a street
 * number and name alone repeat across towns.
 */
export function addressKey(parts: AddressParts | null | undefined): string | null {
  const street = typeof parts?.street1 === "string" ? parts.street1.trim() : "";
  if (!street) return null;
  const pieces = words(street);
  const number = pieces.find(piece => /^\d+[a-z]?$/.test(piece));
  const rest = pieces.filter(piece => piece !== number && !/^\d+$/.test(piece));
  if (!number || rest.length === 0) return null;

  const postal = digitsOnly(typeof parts?.postalCode === "string" ? parts.postalCode : "").slice(0, 5);
  const city = typeof parts?.city === "string"
    ? parts.city.trim().toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ")
    : "";
  const area = postal.length === 5 ? `z:${postal}` : city ? `c:${city}` : "";
  if (!area) return null;

  return `${number}|${rest.join(" ")}|${area}`;
}

export interface AddressChoice {
  /** The single contact the addresses agree on, or null when they do not. */
  contactId: string | null;
  /** Stable machine reason. Safe to log — it carries counts, never an address. */
  reason: string;
}

/**
 * Choose among several exactly-matching contacts using Jobber's own property
 * addresses for the client that owns the invoice.
 *
 * `propertyAddresses` null means Jobber's addresses could not be read, which
 * holds: an unreadable source must never be treated as "no address on file".
 */
export function chooseDestinationByAddress(input: {
  contacts: readonly ({ id: string } & AddressParts)[];
  propertyAddresses: readonly AddressParts[] | null;
}): AddressChoice {
  const contacts = input.contacts ?? [];
  if (contacts.length === 1) {
    return { contactId: contacts[0].id, reason: "single_contact_no_choice_needed" };
  }
  if (contacts.length === 0) {
    return { contactId: null, reason: "no_contacts_to_choose_from" };
  }
  if (!Array.isArray(input.propertyAddresses)) {
    return { contactId: null, reason: "jobber_property_addresses_unreadable" };
  }

  const wanted = new Set(
    input.propertyAddresses.map(addressKey).filter((key): key is string => key !== null),
  );
  if (wanted.size === 0) {
    return { contactId: null, reason: "no_comparable_jobber_property_address" };
  }

  const hits: string[] = [];
  let comparable = 0;
  for (const contact of contacts) {
    const key = addressKey(contact);
    if (key === null) continue;
    comparable++;
    if (wanted.has(key)) hits.push(contact.id);
  }

  // De-duplicated: two contact records at one address are one address match,
  // and must not be mistaken for two different places.
  const distinct = [...new Set(hits)];
  if (distinct.length === 1) {
    return { contactId: distinct[0], reason: "chosen_by_matching_jobber_property_address" };
  }
  if (distinct.length > 1) {
    return { contactId: null,
      reason: `several_contacts_share_the_jobber_property_address: ${distinct.length}` };
  }
  if (comparable === 0) {
    return { contactId: null, reason: "no_contact_has_a_comparable_address" };
  }
  return { contactId: null,
    reason: `no_contact_address_matches_a_jobber_property: ${comparable} compared` };
}
