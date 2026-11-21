/**
 * WHO IS THE PAYER? Resolving a Jobber customer to one GoHighLevel contact.
 *
 * GoHighLevel permits exactly one open opportunity per contact, so the unit of
 * the invoice board is the CONTACT, not the Jobber customer. That is not a
 * preference; it is what the platform allows. Everything here follows from it.
 *
 * The old per-invoice path resolved a Jobber customer straight to a contact and
 * refused whenever the mapping was not one-to-one. Measured against production
 * on 2026-11-20, of the 40 customers with an unpaid in-scope invoice:
 *
 *     26  matched on the contact's primary email
 *      1  matched on phone (customer had no email)
 *     13  were refused, and so got no card at all
 *
 * The 13 refusals were not one problem but four, and only some are the code's
 * to fix. This module fixes the ones that are, and refuses the rest LOUDLY and
 * with a reason a person can act on, because they need a change in GoHighLevel
 * that no amount of matching logic can substitute for.
 *
 *   FIXED - one email, several Jobber customers (5 customers, 4 emails).
 *     A franchise with two locations bills from one address; a property manager
 *     pays for several sites. The old code could not tell which Jobber record
 *     "owned" the contact, so it refused. But the question was wrong: the
 *     contact owes the SUM. Grouping by email and summing is both correct and
 *     the only thing that fits one-open-opportunity-per-contact. Note this only
 *     places a card where the email also resolves to a SINGLE contact; 3 of
 *     these 4 emails are duplicated in GoHighLevel and still need a merge.
 *
 *   FIXED - the email is on the contact as a secondary address.
 *     Selection looked only at `email`; `additionalEmails` was consulted for
 *     conflicts but never for matching. Now both are matched on.
 *
 *   FIXED - the customer has an email with no contact, but a usable phone.
 *     Phone matching only ran for customers with NO email at all, so a customer
 *     whose email was absent from GoHighLevel was refused even when their phone
 *     identified them unambiguously. Phone is now a fallback, not an either/or.
 *
 *   NOT FIXED, AND NOT FIXABLE HERE - several contacts share one email.
 *     Two contacts, one address. Picking one by guesswork risks dunning the
 *     wrong record and leaving the real one silent. Open-card evidence looks
 *     tempting - in 1 of the 5 measured cases exactly one duplicate held the
 *     live card - but it cannot be used: `strictGhlIdentityHold` refuses any
 *     contact whose email also sits on another contact, so no choice made here
 *     would survive the guard, and overriding the guard would relax a duplicate
 *     protection. This module therefore refuses, and says which contact looks
 *     live so the duplicates can be MERGED in GoHighLevel. All 5 need that
 *     merge. The same is true of a missing contact: it has to be created.
 *
 * WHAT COUNTS AS A LIVE CARD. A card with status `won` or `lost` is finished
 * business and is treated as history: it neither identifies a contact nor
 * blocks a new card. Only `open` cards do either. Production carries 188
 * `closed out / won` cards, and letting those speak would have made almost every
 * contact look live. Stage protection still applies to open cards, so a card a
 * person parked in Late Fee Invoice Sent, Invoice Canceled, Quote Sent or
 * Closed Out is still never touched - that check lives in the card plan.
 *
 * ON THE OWNERSHIP GUARD. `strictGhlIdentityHold` refuses when a contact's
 * identifiers belong to "another Jobber customer". For a resolved group, the
 * co-payers are not another customer - they are the same payer. This module
 * therefore runs that guard with the whole group treated as the owner, and
 * every other customer still treated as a competitor. No check is removed: a
 * phone that disagrees, a secondary address that overlaps a third party, or a
 * second contact holding the same identifiers all still refuse. See
 * `competitorsExcluding`.
 *
 * This module is pure. It performs no I/O and makes no GoHighLevel call, so it
 * can be exercised against fixtures without touching the live board.
 */

import { canonicalPhone, matchPhoneCustomer, phoneMayShareOwner } from "./ghl-phone-match";
import { strictGhlIdentityHold } from "./ghl-write-identity";
import type { GhlContact } from "./ghl";

export type ResolverCustomer = Readonly<{
  id: string;
  jobberClientId: string;
  email?: string | null;
  phone?: string | null;
  /** Jobber's name for the customer. Needed only to CREATE a contact. */
  name?: string | null;
  /** Jobber's billing address. Copied onto a created contact, nothing else. */
  address1?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
}>;

/**
 * A contact this run would add to GoHighLevel, built from Jobber's own record.
 *
 * Only ever produced when the customer could be proved absent from the board
 * on BOTH identifiers - see `contactCreationCheck`. The card that should follow
 * is planned separately by the caller, against `placeholderContactId`, which is
 * not a GoHighLevel id and must never be sent to GoHighLevel.
 */
export type PlannedContactCreation = Readonly<{
  customer: ResolverCustomer;
  name: string;
  email: string | null;
  phone: string | null;
  address1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  /** How absence was proved, for the run log. */
  via: "email_and_phone_both_absent" | "email_absent_no_phone" | "phone_absent_no_email";
  placeholderContactId: string;
}>;

/** A card as the board reports it. `stageName` is already resolved by the caller. */
export type ResolverCard = Readonly<{
  id: string;
  contactId?: string | null;
  stageName?: string | null;
  status?: string | null;
  monetaryValue?: number | null;
  name?: string | null;
}>;

/** One contact, and every Jobber customer whose unpaid invoices it answers for. */
export type ResolvedPayer = Readonly<{
  contactId: string;
  customers: readonly ResolverCustomer[];
  /** Live cards only. Finished (`won`/`lost`) cards are excluded as history. */
  openCards: readonly ResolverCard[];
  /**
   * Cards this contact already carries that are FINISHED (`won`/`lost`). They
   * are history: they never identify the contact and never block a new card.
   * Carried so the card plan can say it is starting a fresh card rather than
   * reopening a closed one - see the note on restarting below.
   */
  finishedCards: readonly ResolverCard[];
  /** How the contact was identified, for the run log. */
  via: "primary_email" | "secondary_email" | "phone_fallback";
}>;

export type PayerHold = Readonly<{
  customerIds: readonly string[];
  jobberClientIds: readonly string[];
  candidateContactIds: readonly string[];
  reason: string;
}>;

export type ResolutionInput = Readonly<{
  /** Only the customers that actually want a card this run. */
  customers: readonly ResolverCustomer[];
  /** Every Jobber customer, for competitor checks. Not just the wanted ones. */
  allCustomers: readonly ResolverCustomer[];
  contacts: readonly GhlContact[];
  cards: readonly ResolverCard[];
}>;

const emailKey = (value?: string | null) => value?.trim().toLowerCase() || null;
const text = (value?: string | null) => typeof value === "string" && !!value.trim();

/** Primary address plus every secondary one, lowercased. */
export function contactEmails(contact: GhlContact): string[] {
  return [contact.email, ...(contact.additionalEmails ?? []).map(e => e?.email)]
    .map(emailKey)
    .filter((v): v is string => !!v);
}

/** A card is live only while it is open. `won`/`lost` is finished business. */
export function isLiveCard(card: ResolverCard): boolean {
  return (card.status ?? "").toLowerCase() === "open";
}

/**
 * Every customer except the resolved group. The group is one payer, so its own
 * members must not be read as competing owners; everyone else still is.
 */
export function competitorsExcluding(
  all: readonly ResolverCustomer[],
  group: readonly ResolverCustomer[],
): ResolverCustomer[] {
  const mine = new Set(group.map(g => g.jobberClientId));
  return all.filter(c => !mine.has(c.jobberClientId));
}

function liveCardsOf(cards: readonly ResolverCard[], contactId: string): ResolverCard[] {
  return cards.filter(c => c.contactId === contactId && isLiveCard(c));
}

function finishedCardsOf(cards: readonly ResolverCard[], contactId: string): ResolverCard[] {
  return cards.filter(c => c.contactId === contactId && !isLiveCard(c));
}

/**
 * MAY THIS CUSTOMER'S CONTACT BE CREATED?
 *
 * Reached only after email matching and the phone fallback have both failed to
 * name a contact. That is not the same as proving the customer is absent, and
 * the difference is the whole of this function: `matchPhoneCustomer` reports
 * "missing or ambiguous" for BOTH "no contact carries this phone" and "three
 * contacts do", and creating on the second would plant a duplicate beside the
 * records we have spent days merging.
 *
 * So absence is proved here, directly and on both identifiers, and anything
 * short of proof holds:
 *
 *   - the email names no contact, primary or secondary (the caller has already
 *     established this; a non-empty candidate list never reaches here);
 *   - no contact's phone canonicalises to the customer's;
 *   - no contact carries a phone that merely MIGHT be the customer's - a
 *     malformed or partial number that `phoneMayShareOwner` cannot rule out.
 *     An unreadable number on the board is not evidence of absence;
 *   - the customer's own phone canonicalises. If we cannot read Jobber's own
 *     number we cannot search for it, so we cannot claim it is absent;
 *   - no other Jobber customer shares the phone, which would make the new
 *     contact's identity ambiguous the moment it existed;
 *   - the customer carries at least one identifier. With neither an email nor
 *     a phone there is nothing to deduplicate on, now or ever;
 *   - Jobber has a name to create the contact under;
 *   - the customer is not part of a shared-email group. Several Jobber
 *     customers behind one address are one payer, but they are not one
 *     identity: there is no single name, phone or billing address to create
 *     the contact from. That stays a hold for a person to resolve.
 *
 * Returns the proof when creation is safe, or the reason it is not.
 */
export function contactCreationCheck(
  customer: ResolverCustomer,
  group: readonly ResolverCustomer[],
  allCustomers: readonly ResolverCustomer[],
  contacts: readonly GhlContact[],
): { ok: true; via: PlannedContactCreation["via"] } | { ok: false; reason: string } {
  if (group.length > 1) {
    return { ok: false, reason: "several Jobber customers share this email and none has a contact; there is no single name, phone or address to create one from. Add or merge the contact in GoHighLevel" };
  }
  const email = emailKey(customer.email);
  const rawPhone = text(customer.phone) ? customer.phone : null;
  if (!email && !rawPhone) {
    return { ok: false, reason: "the customer has neither an email nor a phone, so a created contact could never be matched again" };
  }

  if (rawPhone) {
    const canonical = canonicalPhone(rawPhone);
    if (!canonical) {
      return { ok: false, reason: "the customer's phone cannot be read, so absence from GoHighLevel cannot be proved; correct the number in Jobber" };
    }
    const exact = contacts.filter(c => canonicalPhone(c.phone) === canonical);
    if (exact.length) {
      return { ok: false, reason: `${exact.length} GoHighLevel contact(s) already carry this phone; resolve them in GoHighLevel rather than adding another` };
    }
    const uncertain = contacts.filter(c => !canonicalPhone(c.phone) && phoneMayShareOwner(c.phone, canonical));
    if (uncertain.length) {
      return { ok: false, reason: `${uncertain.length} GoHighLevel contact(s) carry an unreadable phone that may be this one; correct them in GoHighLevel rather than adding another` };
    }
    if (allCustomers.some(c => c.jobberClientId !== customer.jobberClientId && phoneMayShareOwner(c.phone, canonical))) {
      return { ok: false, reason: "another Jobber customer shares this phone, so a new contact's owner would be ambiguous" };
    }
  }

  // Last, because it is the least informative refusal: if the identifiers
  // themselves are the problem, say so instead.
  if (!text(customer.name)) {
    return { ok: false, reason: "no GoHighLevel contact carries this email or phone, and Jobber has no name to create one from; add the contact in GoHighLevel" };
  }

  return {
    ok: true,
    via: email && rawPhone ? "email_and_phone_both_absent"
      : email ? "email_absent_no_phone"
      : "phone_absent_no_email",
  };
}

const trimmed = (v?: string | null): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

/**
 * Resolve each wanted customer to one contact, grouping co-payers that share an
 * email. Returns the payers that can be acted on and the ones that cannot, each
 * with a reason naming what a person has to change in GoHighLevel.
 */
export function resolvePayers(input: ResolutionInput): {
  payers: readonly ResolvedPayer[];
  holds: readonly PayerHold[];
  creations: readonly PlannedContactCreation[];
} {
  const payers: ResolvedPayer[] = [];
  const holds: PayerHold[] = [];
  const creations: PlannedContactCreation[] = [];
  const doneCustomers = new Set<string>();
  const doneEmails = new Set<string>();

  const hold = (group: readonly ResolverCustomer[], candidateContactIds: string[], reason: string) =>
    holds.push(Object.freeze({
      customerIds: Object.freeze(group.map(g => g.id)),
      jobberClientIds: Object.freeze(group.map(g => g.jobberClientId)),
      candidateContactIds: Object.freeze([...new Set(candidateContactIds)]),
      reason,
    }));

  for (const customer of input.customers) {
    if (doneCustomers.has(customer.id)) continue;
    const email = emailKey(customer.email);

    // --- the group of Jobber customers this one card answers for -------------
    let group: ResolverCustomer[] = [customer];
    if (email) {
      if (doneEmails.has(email)) continue;
      doneEmails.add(email);
      group = input.customers.filter(c => emailKey(c.email) === email);
    }
    for (const g of group) doneCustomers.add(g.id);

    // --- candidate contacts --------------------------------------------------
    let via: ResolvedPayer["via"] = "primary_email";
    let candidates: GhlContact[] = [];
    if (email) {
      candidates = input.contacts.filter(c => emailKey(c.email) === email);
      if (!candidates.length) {
        const secondary = input.contacts.filter(c => contactEmails(c).includes(email));
        if (secondary.length) { candidates = secondary; via = "secondary_email"; }
      }
    }

    // Phone fallback. Runs when the email names no contact at all - including
    // for customers that HAVE an email, which the old path never tried. Only
    // for a lone customer: a shared billing address tells us nothing about
    // whose phone is whose.
    if (!candidates.length) {
      const match = group.length === 1
        ? matchPhoneCustomer(
            { jobberClientId: customer.jobberClientId, email: customer.email, phone: customer.phone },
            input.allCustomers.map(c => ({ jobberClientId: c.jobberClientId, email: c.email, phone: c.phone })),
            input.contacts.map(c => ({ id: c.id, email: c.email, phone: c.phone })),
          )
        : { contactId: null, candidateIds: [] as string[], reason: "shared email group" };

      if (!match.contactId) {
        // Neither identifier named a contact. That is the case this project
        // decided to FIX by adding the contact from Jobber's own record -
        // but only where absence can actually be proved, because "no match"
        // and "too many matches" arrive here looking identical.
        const safe = contactCreationCheck(customer, group, input.allCustomers, input.contacts);
        if (safe.ok) {
          creations.push(Object.freeze({
            customer,
            name: (customer.name as string).trim(),
            email: emailKey(customer.email),
            phone: trimmed(customer.phone),
            address1: trimmed(customer.address1),
            city: trimmed(customer.city),
            state: trimmed(customer.state),
            postalCode: trimmed(customer.postalCode),
            via: safe.via,
            placeholderContactId: `new:${customer.jobberClientId}`,
          }));
          continue;
        }
        hold(group, match.candidateIds, safe.reason);
        continue;
      }
      candidates = input.contacts.filter(c => c.id === match.contactId);
      via = "phone_fallback";
    }

    // --- duplicates are a data problem, not a matching problem --------------
    // Two contacts, one address. This is NOT resolved by guesswork, and not by
    // open-card evidence either: `strictGhlIdentityHold` refuses a selected
    // contact whose email sits on any other contact, so no choice made here
    // could survive it. Overriding that guard would relax a duplicate
    // protection, which is not this module's call to make. Instead, refuse and
    // say which contact looks live, so the merge can be done in GoHighLevel.
    const chosen = candidates[0];
    if (candidates.length > 1) {
      const live = candidates.filter(c => liveCardsOf(input.cards, c.id).length > 0);
      const detail = live.length === 1
        ? `one of them holds the open card (${live[0].id})`
        : `${live.length} of them hold an open card`;
      hold(group, candidates.map(c => c.id),
        `${candidates.length} GoHighLevel contacts carry this email, so the payer is ambiguous; `
        + `${detail}. Merge the duplicate contacts in GoHighLevel`);
      continue;
    }

    if (!chosen || !text(chosen.id)) {
      hold(group, [], "no usable GoHighLevel contact");
      continue;
    }

    // --- the ownership guard, with the group treated as one payer ------------
    // The member under test, plus every customer OUTSIDE the group. Co-payers
    // are simply absent from the competitor list, so the guard never reads them
    // as a rival owner - and every third party is still checked in full.
    const competitors = competitorsExcluding(input.allCustomers, group);
    let guardHold: string | null = null;
    for (const member of group) {
      const reason = strictGhlIdentityHold(
        { jobberClientId: member.jobberClientId, email: member.email, phone: member.phone },
        [member, ...competitors].map(c => ({ jobberClientId: c.jobberClientId, email: c.email, phone: c.phone })),
        [...input.contacts],
        chosen.id,
      );
      if (reason) { guardHold = reason; break; }
    }
    if (guardHold) { hold(group, [chosen.id], `ownership guard: ${guardHold}`); continue; }

    payers.push(Object.freeze({
      contactId: chosen.id,
      customers: Object.freeze(group),
      openCards: Object.freeze(liveCardsOf(input.cards, chosen.id)),
      finishedCards: Object.freeze(finishedCardsOf(input.cards, chosen.id)),
      via,
    }));
  }

  return {
    payers: Object.freeze(payers),
    holds: Object.freeze(holds),
    creations: Object.freeze(creations),
  };
}
