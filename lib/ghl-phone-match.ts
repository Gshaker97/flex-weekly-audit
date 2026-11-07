// Phone identity is deliberately narrower than SMS eligibility or permission.
export function canonicalPhone(value?: string | null): string | null {
  const raw = value?.trim() ?? "";
  if (!/^\+?[\d ().-]+$/.test(raw)) return null;
  let phone = raw.replace(/[ ().-]/g, "");
  // User confirmed local-format Flex numbers are US. Explicit international
  // prefixes are preserved rather than rewritten to the account's country.
  if (!phone.startsWith("+")) {
    if (/^\d{10}$/.test(phone)) phone = `+1${phone}`;
    else if (/^1\d{10}$/.test(phone)) phone = `+${phone}`;
    else return null;
  }
  if (phone.startsWith("+1") && !/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(phone)) return null;
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null;
}

type Customer = { jobberClientId: string; email?: string | null; phone?: string | null };
type Contact = { id: string; email?: string | null; phone?: string | null };
// Domestic suffixes only flag competing owners; they never establish a match.
function possibleDomesticOverlap(value: string | null | undefined, canonical: string): boolean {
  if (!value || canonicalPhone(value) || !/^[\d ().-]+$/.test(value.trim())) return false;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 7 && canonical.endsWith(digits);
}
export function phoneMayShareOwner(value: string | null | undefined, canonical: string): boolean {
  return canonicalPhone(value) === canonical || possibleDomesticOverlap(value, canonical);
}
const emailKey = (email?: string | null) => email?.trim().toLowerCase() || null;

// The caller must supply complete snapshots, not the first fuzzy search page.
export function matchPhoneCustomer(customer: Customer, customers: Customer[], contacts: Contact[]): {
  contactId: string | null; candidateIds: string[]; reason?: string;
} {
  const phone = canonicalPhone(customer.phone);
  if (!phone) return { contactId: null, candidateIds: [], reason: "unsupported phone format" };
  const candidates = contacts.filter(c => canonicalPhone(c.phone) === phone);
  const uncertain = contacts.filter(c => possibleDomesticOverlap(c.phone, phone));
  const candidateIds = [...new Set([...candidates, ...uncertain].map(c => c.id))];
  const held = (reason: string) => ({ contactId: null, candidateIds, reason });
  if (uncertain.length || candidateIds.length !== 1) return held("missing or ambiguous GHL phone");
  if (customers.some(c => c.jobberClientId !== customer.jobberClientId && phoneMayShareOwner(c.phone, phone))) {
    return held("phone shared by Jobber customers");
  }
  const contact = candidates[0];
  const email = emailKey(contact.email);
  if (email && customers.some(c => c.jobberClientId !== customer.jobberClientId && emailKey(c.email) === email)) {
    return held("GHL email belongs to another Jobber customer");
  }
  return { contactId: contact.id, candidateIds };
}
