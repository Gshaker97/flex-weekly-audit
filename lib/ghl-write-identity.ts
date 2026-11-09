import { coveragePermitsOmissions, type IdentityCoverageEvidence } from "./ghl-identity-coverage";
import { jobberGraphQL } from "./jobber";
import type { GhlContact } from "./ghl";
import { boundedMalformedUsPhoneDigits, canonicalPhone, phoneMayShareOwner } from "./ghl-phone-match";

type CustomerIdentity = { jobberClientId: string; email?: string | null; phone?: string | null };
export type FreshJobberIdentity = { id: string; emails: Array<{ address: string; primary: boolean }>; phones: Array<{ number: string; primary: boolean }> };
const hasPhone = (value?: string | null) => typeof value === "string" && !!value.trim();
// Seven-digit domestic suffixes can only identify a possible competing owner.
// The explicitly bounded malformed US form uses conflict-only digit witnesses.
// Other nonempty unsupported formats cannot safely exclude a competing owner.
const unresolvedPhone = (value?: string | null) => hasPhone(value) && !canonicalPhone(value) && !boundedMalformedUsPhoneDigits(value)
  && !/^[2-9]\d{6}$/.test(value!.replace(/[ ().-]/g, ""));
const overlapsPhone = (a?: string | null, b?: string | null) => {
  const ca = canonicalPhone(a), cb = canonicalPhone(b);
  return !!((ca && phoneMayShareOwner(b, ca)) || (cb && phoneMayShareOwner(a, cb)));
};
const emailKey = (value?: string | null) => value?.trim().toLowerCase() || null;
const emails = (contact: GhlContact) => [contact.email, ...(contact.additionalEmails ?? []).map(e => e.email)].filter((v): v is string => typeof v === "string" && !!v.trim());
const phones = (contact: GhlContact) => [contact.phone, ...(contact.additionalPhones ?? []).map(p => p.phone)].filter((v): v is string => typeof v === "string" && !!v.trim());
export function validGhlContactIdentity(contact: GhlContact): boolean {
  return (contact.email == null || typeof contact.email === "string") && (contact.phone == null || typeof contact.phone === "string")
    && (contact.additionalEmails == null || Array.isArray(contact.additionalEmails) && contact.additionalEmails.every(e => e && typeof e.email === "string"))
    && (contact.additionalPhones == null || Array.isArray(contact.additionalPhones) && contact.additionalPhones.every(p => p && typeof p.phone === "string"));
}
export function strictGhlIdentityHold(customer: CustomerIdentity, customers: CustomerIdentity[], contacts: GhlContact[], selectedId: string): string | null {
  if (contacts.some(c => !validGhlContactIdentity(c))) return "GHL primary or secondary identity field shape is unverified";
  const selected = contacts.find(c => c.id === selectedId);
  if (!selected) return "Selected GHL identity is missing";
  const email = emailKey(customer.email), phone = canonicalPhone(customer.phone), contactPhone = canonicalPhone(selected.phone);
  if (phone && contactPhone && phone !== contactPhone) return "Contact phone disagrees with Jobber customer";
  if (phone && contacts.some(c => c.id !== selectedId && phones(c).some(p => phoneMayShareOwner(p, phone)))) return "Email/phone or secondary contact ownership conflict";
  if (email && contacts.some(c => c.id !== selectedId && emails(c).some(e => emailKey(e) === email))) return "Secondary contact email ownership conflict";
  const selectedEmails = new Set(emails(selected).map(emailKey));
  const selectedPhones = phones(selected);
  if ((hasPhone(customer.phone) && !phone) || selectedPhones.some(p => !canonicalPhone(p))) return "Relevant primary/secondary phone format is unverified";
  if (contacts.some(c => c.id !== selectedId && (emails(c).some(e => selectedEmails.has(emailKey(e)))
      || phones(c).some(p => selectedPhones.some(selectedPhone => overlapsPhone(p, selectedPhone))
        || (selectedPhones.length > 0 && unresolvedPhone(p)))))) return "Selected contact identifiers overlap another GHL contact";
  if (customers.some(c => c.jobberClientId !== customer.jobberClientId &&
      ((emailKey(c.email) && selectedEmails.has(emailKey(c.email))) || selectedPhones.some(p => overlapsPhone(c.phone, p)) || (selectedPhones.length > 0 && unresolvedPhone(c.phone))))) return "Selected contact identifier belongs to another Jobber customer";
  if (phone && customers.some(c => c.jobberClientId !== customer.jobberClientId && phoneMayShareOwner(c.phone, phone))) return "Phone shared by Jobber customers";
  return null;
}

// Independent, unfiltered identity read, including all returned secondary fields.
// No partial-page success and no reuse of the incremental customer cache.
export async function readFreshJobberIdentities(): Promise<FreshJobberIdentity[]> {
  const query = `query VerifyGhlIdentityOwnership($after: String) { clients(first: 25, after: $after) {
    pageInfo { hasNextPage endCursor } nodes { id emails { address primary } phones { number primary } }
  } }`;
  const rows: FreshJobberIdentity[] = [], ids = new Set<string>(), cursors = new Set<string>();
  let after: string | null = null;
  for (let page = 0; page < 1000; page++) {
    const data: any = await jobberGraphQL(query, { after });
    const c = data?.clients;
    if (!Array.isArray(c?.nodes) || c.nodes.length > 25 || typeof c.pageInfo?.hasNextPage !== "boolean") throw new Error("Incomplete fresh Jobber identity snapshot");
    for (const row of c.nodes) {
      if (typeof row?.id !== "string" || !row.id || ids.has(row.id)
          || !Array.isArray(row.emails) || row.emails.some((e: any) => typeof e?.address !== "string" || typeof e.primary !== "boolean")
          || !Array.isArray(row.phones) || row.phones.some((p: any) => typeof p?.number !== "string" || typeof p.primary !== "boolean")
          || row.emails.filter((e: any) => e.primary).length > 1 || row.phones.filter((p: any) => p.primary).length > 1) throw new Error("Unverified fresh Jobber identity fields");
      ids.add(row.id); rows.push(row);
    }
    if (!c.pageInfo.hasNextPage) return rows;
    after = c.pageInfo.endCursor;
    if (typeof after !== "string" || !after || cursors.has(after) || !c.nodes.length) throw new Error("Truncated fresh Jobber identity snapshot");
    cursors.add(after);
  }
  throw new Error("Fresh Jobber identity snapshot exceeded limit");
}
export function verifyFreshGhlIdentity(customer: CustomerIdentity, customers: CustomerIdentity[], contacts: GhlContact[], selectedId: string, source: FreshJobberIdentity[], coverage?: IdentityCoverageEvidence): string | null {
  if (customers.some(c => !source.some(s => s.id === c.jobberClientId)) && !coveragePermitsOmissions(coverage, customers, source, customer.jobberClientId)) return "Fresh Jobber identity snapshot omits a cached owner";
  const fresh = source.find(c => c.id === customer.jobberClientId);
  const selected = contacts.find(c => c.id === selectedId);
  if (!fresh || !selected) return "Fresh owner/contact identity unavailable";
  const primaryEmail = (fresh.emails.find(e => e.primary) ?? fresh.emails[0])?.address;
  const primaryPhone = (fresh.phones.find(p => p.primary) ?? fresh.phones[0])?.number;
  if ((hasPhone(primaryPhone) && !canonicalPhone(primaryPhone)) || (hasPhone(customer.phone) && !canonicalPhone(customer.phone))) return "Fresh/cached primary phone cannot establish unchanged identity";
  if (emailKey(primaryEmail) !== emailKey(customer.email) || canonicalPhone(primaryPhone) !== canonicalPhone(customer.phone)) return "Jobber primary identity changed since cache";
  const sourceEmails = new Set(fresh.emails.map(e => emailKey(e.address)).filter(Boolean));
  const sourcePhones = fresh.phones.map(p => p.number).filter(hasPhone);
  const contactEmails = new Set(emails(selected).map(emailKey));
  const contactPhones = phones(selected);
  const relevantEmails = new Set([...sourceEmails, ...contactEmails]);
  const relevantPhones = [...sourcePhones, ...contactPhones];
  if (relevantPhones.some(p => !canonicalPhone(p))) return "Fresh/selected secondary phone format is unverified";
  if (source.some(c => c.id !== fresh.id && (c.emails.some(e => relevantEmails.has(emailKey(e.address)))
      || c.phones.some(p => relevantPhones.some(phone => overlapsPhone(p.number, phone)) || (relevantPhones.length > 0 && unresolvedPhone(p.number)))))) return "Fresh primary/secondary Jobber ownership conflict";
  if (contacts.some(c => c.id !== selectedId && (emails(c).some(e => sourceEmails.has(emailKey(e)))
      || phones(c).some(p => sourcePhones.some(phone => overlapsPhone(p, phone)) || (sourcePhones.length > 0 && unresolvedPhone(p)))))) return "Fresh Jobber secondary identity selects another GHL contact";
  return strictGhlIdentityHold(customer, customers, contacts, selectedId);
}
