import { canonicalPhone, matchPhoneCustomer, phoneMayShareOwner } from './phone-match';
import { Card, Contact, Pipeline, StageClass } from './snapshot';
import { GhlPreviewFailure as Failure, GHL_LIMITS, id } from './transport';
export type PreviewCustomer = { jobberClientId: string; email?: string | null; phone?: string | null };
export type PreviewCachedInvoice = { jobberInvoiceId: string; jobberClientId: string | null };
/** Fresh invoice amounts must already be normalized to integer cents. */
export type PreviewFreshInvoice = { id: string; owner: string | null; invoiceStatus: string | null; balance: number | null };
export type PreviewInput = { customers: PreviewCustomer[]; customerSnapshotComplete?: boolean; cachedInvoices: PreviewCachedInvoice[];
  freshInvoices?: PreviewFreshInvoice[]; freshInvoicesComplete?: boolean };
const emailKey = (v?: string | null) => v?.trim().toLowerCase() || null;
const unique = <T>(items: T[]) => [...new Set(items)];
export function phoneFormat(v?: string | null) {
  if (!v?.trim()) return 'missing';
  const phone = canonicalPhone(v);
  if (!phone) return 'unsupported';
  if (!phone.startsWith('+1')) return 'explicit_international';
  if (v.trim().startsWith('+')) return 'explicit_us';
  return v.replace(/\D/g, '').length === 10 ? 'domestic_us_10_digits' : 'domestic_us_11_digits';
}
function histogram(values: string[]) { const out: Record<string, number> = {}; for (const v of values) out[v] = (out[v] ?? 0) + 1; return out; }
function duplicateGroups(values: Array<string | null>) { const counts = histogram(values.filter((v): v is string => !!v)); return Object.values(counts).filter(n => n > 1).length; }
export function validateInput(input: PreviewInput): void {
  for (const array of [input.customers, input.cachedInvoices, input.freshInvoices ?? []]) if (!Array.isArray(array) || array.length > GHL_LIMITS.maxRecords) throw new Failure('LOCAL_INPUT_LIMIT_OR_SHAPE');
  const owners = new Set<string>(), cached = new Set<string>(), fresh = new Set<string>();
  for (const c of input.customers) {
    if (!id(c?.jobberClientId) || owners.has(c.jobberClientId) || (c.email != null && typeof c.email !== 'string') || (c.phone != null && typeof c.phone !== 'string')) throw new Failure('CUSTOMER_INPUT_INVALID_OR_DUPLICATE');
    owners.add(c.jobberClientId);
  }
  for (const c of input.cachedInvoices) {
    if (!id(c?.jobberInvoiceId) || cached.has(c.jobberInvoiceId) || (c.jobberClientId !== null && !id(c.jobberClientId))) throw new Failure('CACHE_INVOICE_INPUT_INVALID_OR_DUPLICATE');
    cached.add(c.jobberInvoiceId);
  }
  for (const c of input.freshInvoices ?? []) {
    if (!id(c?.id) || fresh.has(c.id) || (c.owner !== null && !id(c.owner)) || (c.balance !== null && !Number.isSafeInteger(c.balance))) throw new Failure('FRESH_INVOICE_INPUT_INVALID_OR_DUPLICATE');
    fresh.add(c.id);
  }
  if (input.freshInvoicesComplete && !input.freshInvoices) throw new Failure('FRESH_COMPLETE_WITHOUT_INVOICES');
}
function identity(customer: PreviewCustomer, customers: PreviewCustomer[], contacts: Contact[]) {
  const email = emailKey(customer.email), phone = canonicalPhone(customer.phone);
  const exactEmail = email ? contacts.filter(c => emailKey(c.email) === email) : [];
  const exactPhone = phone ? contacts.filter(c => canonicalPhone(c.phone) === phone) : [];
  const secondary = contacts.filter(c => (email && c.additionalEmails.some(x => emailKey(x) === email)) ||
    (phone && c.additionalPhones.some(x => phoneMayShareOwner(x, phone))));
  const match = matchPhoneCustomer(customer, customers, contacts);
  const candidateIds = unique([...exactEmail, ...exactPhone, ...secondary].map(c => c.id).concat(match.candidateIds));
  const holds: string[] = [];
  let contactId: string | null = null;
  if (email) {
    if (customers.filter(c => emailKey(c.email) === email).length !== 1) holds.push('EMAIL_SHARED_BY_JOBBER_CUSTOMERS');
    if (exactEmail.length !== 1) holds.push(exactEmail.length ? 'AMBIGUOUS_EXACT_EMAIL_CONTACTS' : 'NO_EXISTING_EXACT_EMAIL_CONTACT');
    else contactId = exactEmail[0].id;
    if (phone && exactPhone.some(c => c.id !== contactId)) holds.push('EMAIL_PHONE_CONTACT_CONFLICT');
    if (phone && customers.some(c => c.jobberClientId !== customer.jobberClientId && phoneMayShareOwner(c.phone, phone))) holds.push('PHONE_SHARED_BY_JOBBER_CUSTOMERS');
  } else {
    if (!phone?.startsWith('+1')) holds.push(customer.phone?.trim() ? 'UNSUPPORTED_US_PHONE_FORMAT' : 'NO_CONTACT_IDENTITY');
    else if (!match.contactId) {
      const reason = match.reason;
      holds.push(reason === 'phone shared by Jobber customers' ? 'PHONE_SHARED_BY_JOBBER_CUSTOMERS' :
        reason === 'GHL email belongs to another Jobber customer' ? 'GHL_EMAIL_BELONGS_TO_OTHER_JOBBER_CUSTOMER' :
        match.candidateIds.length ? 'AMBIGUOUS_PHONE_CONTACTS' : 'NO_EXISTING_EXACT_PHONE_CONTACT');
    } else contactId = match.contactId;
  }
  if (secondary.some(c => c.id !== contactId)) holds.push('SECONDARY_CONTACT_FIELD_OWNERSHIP_CONFLICT');
  const selected = contacts.find(c => c.id === contactId);
  if (selected) {
    const contactPhone = canonicalPhone(selected.phone), contactEmail = emailKey(selected.email);
    if (!selected.contactShapeValid) holds.push('CONTACT_FIELD_SHAPE_UNVERIFIED');
    if (phone && contactPhone && phone !== contactPhone) holds.push('CONTACT_PHONE_DISAGREES');
    if (contactPhone && customers.some(c => c.jobberClientId !== customer.jobberClientId && phoneMayShareOwner(c.phone, contactPhone))) holds.push('CONTACT_PHONE_BELONGS_TO_OTHER_JOBBER_CUSTOMER');
    if (contactEmail && customers.some(c => c.jobberClientId !== customer.jobberClientId && emailKey(c.email) === contactEmail)) holds.push('CONTACT_EMAIL_BELONGS_TO_OTHER_JOBBER_CUSTOMER');
  }
  return { jobberClientId: customer.jobberClientId, method: email ? 'exact_email' : 'exact_us_phone',
    contactId: holds.length ? null : contactId, candidateContactIds: candidateIds, holds };
}
function sourceEvidence(owner: string, input: PreviewInput) {
  const cached = input.cachedInvoices.filter(c => c.jobberClientId === owner);
  const fresh = (input.freshInvoices ?? []).filter(c => c.owner === owner);
  const byId = new Map((input.freshInvoices ?? []).map(c => [c.id, c]));
  const missing = cached.filter(c => !byId.has(c.jobberInvoiceId)).length;
  const changed = cached.filter(c => byId.has(c.jobberInvoiceId) && byId.get(c.jobberInvoiceId)?.owner !== owner).length;
  const unknownStatus = fresh.filter(c => !['paid', 'past_due', 'awaiting_payment'].includes(c.invoiceStatus ?? '')).length;
  const unknownBalance = fresh.filter(c => c.balance === null).length;
  const paidPositive = fresh.filter(c => c.invoiceStatus === 'paid' && c.balance !== null && c.balance > 0).length;
  const positive = fresh.filter(c => c.balance !== null && c.balance > 0).length;
  const negative = fresh.filter(c => c.balance !== null && c.balance < 0).length;
  const zeroNonPaid = fresh.filter(c => c.balance === 0 && c.invoiceStatus !== 'paid').length;
  const unresolvedOwner = (input.freshInvoices ?? []).some(c => c.owner === null);
  const holds: string[] = [];
  if (!input.freshInvoicesComplete) holds.push('FRESH_SOURCE_COMPLETENESS_UNVERIFIED');
  if (!fresh.length) holds.push('NO_FRESH_INVOICES_FOR_OWNER');
  if (missing) holds.push('CACHED_INVOICE_MISSING_FROM_FRESH_SOURCE');
  if (changed) holds.push('INVOICE_OWNER_CHANGED');
  if (unresolvedOwner) holds.push('FRESH_INVOICE_OWNER_UNRESOLVED');
  if (unknownStatus || unknownBalance) holds.push('SOURCE_STATUS_OR_BALANCE_UNVERIFIED');
  if (paidPositive) holds.push('PAID_STATUS_WITH_POSITIVE_BALANCE');
  if (negative) holds.push('CREDIT_BALANCE_REQUIRES_REVIEW');
  if (zeroNonPaid) holds.push('ZERO_BALANCE_WITHOUT_PAID_STATUS');
  return { cachedInvoiceCount: cached.length, freshInvoiceCount: fresh.length,
    missingCachedInvoiceCount: missing, changedOwnerCount: changed, positiveBalanceCount: positive,
    negativeBalanceCount: negative, unknownStatusCount: unknownStatus, unknownBalanceCount: unknownBalance,
    paidPositiveConflictCount: paidPositive, pastDueCount: fresh.filter(c => c.invoiceStatus === 'past_due').length,
    explicitlyPaidCount: fresh.filter(c => c.invoiceStatus === 'paid').length, holds };
}
export function analyzeSnapshot(input: PreviewInput, contacts: Contact[], cards: Card[], pipeline: Pipeline, check: () => void = () => {}) {
  validateInput(input);
  check();
  const relevant = new Set([...input.cachedInvoices.map(c => c.jobberClientId), ...(input.freshInvoices ?? []).map(c => c.owner)].filter((x): x is string => !!x));
  const identities = input.customers.map(c => { check(); return identity(c, input.customers, contacts); });
  const customers = identities.filter(c => relevant.has(c.jobberClientId)).map(c => {
    check();
    const matchingCards = cards.filter(card => !!card.contactId && c.candidateContactIds.includes(card.contactId));
    const exactCards = c.contactId ? cards.filter(card => card.contactId === c.contactId) : [];
    const holds = [...c.holds];
    if (input.customerSnapshotComplete !== true) holds.push('CUSTOMER_SNAPSHOT_COMPLETENESS_UNVERIFIED');
    if (contacts.some(contact => !contact.contactShapeValid)) holds.push('CONTACT_SNAPSHOT_IDENTITY_FIELDS_UNVERIFIED');
    if (input.customers.some(customer => relevant.has(customer.jobberClientId) && !emailKey(customer.email) && customer.phone?.trim() && !canonicalPhone(customer.phone))) holds.push('RELEVANT_CUSTOMER_PHONE_FORMAT_UNVERIFIED');
    if (c.contactId && exactCards.length !== 1) holds.push(exactCards.length ? 'MULTIPLE_EXISTING_CARDS_ALL_STATUSES' : 'NO_EXISTING_CARD_CREATION_DISABLED');
    if (!pipeline.requiredStagesPresent) holds.push('REQUIRED_PIPELINE_STAGES_MISSING');
    const source = sourceEvidence(c.jobberClientId, input);
    return { ...c, candidateCardIds: matchingCards.map(card => card.id), source, holds: unique([...holds, ...source.holds]) };
  });
  const cardReports = cards.map(card => {
    check();
    const contact = contacts.find(c => c.id === card.contactId);
    const owners = identities.filter(c => !!card.contactId && c.candidateContactIds.includes(card.contactId));
    const eligibleOwners = customers.filter(c => c.contactId === card.contactId);
    const stage: StageClass = card.stageId ? pipeline.stages.get(card.stageId) ?? 'other' : 'other';
    const holds: string[] = [];
    if (!card.ownerShapeValid) holds.push('CARD_CONTACT_OWNERSHIP_UNVERIFIED');
    if (!contact) holds.push('CARD_CONTACT_NOT_IN_COMPLETE_SNAPSHOT');
    if (owners.length !== 1) holds.push(owners.length ? 'CARD_HAS_MULTIPLE_JOBBER_OWNER_CANDIDATES' : 'NO_EXACT_JOBBER_OWNER');
    if (eligibleOwners.length !== 1) holds.push('EXACT_RELEVANT_JOBBER_OWNER_UNVERIFIED');
    for (const c of customers.filter(c => c.candidateCardIds.includes(card.id))) holds.push(...c.holds);
    if (card.status !== 'open') holds.push('CLOSED_OR_UNKNOWN_CARD_NO_REOPEN');
    if (!['sent', 'overdue', 'paid'].includes(stage)) holds.push('SPECIAL_OR_UNKNOWN_STAGE_PROTECTED');
    if (card.contactId && cards.filter(c => c.contactId === card.contactId).length !== 1) holds.push('MULTIPLE_EXISTING_CARDS_ALL_STATUSES');
    if (!pipeline.requiredStagesPresent) holds.push('REQUIRED_PIPELINE_STAGES_MISSING');
    const identityAndPipelineHolds = unique(holds);
    const dndHolds: string[] = [];
    if (contact?.globalDnd === true) dndHolds.push('GLOBAL_DND_ENABLED');
    if (contact?.globalDnd == null) dndHolds.push('GLOBAL_DND_UNKNOWN');
    for (const [channel, value] of [['SMS', contact?.smsDnd], ['EMAIL', contact?.emailDnd], ['CALL', contact?.callDnd]] as const) {
      if (value === 'active' || value === 'permanent') dndHolds.push(`${channel}_DND_ENABLED`);
      else if (value !== 'inactive') dndHolds.push(`${channel}_DND_UNKNOWN`);
    }
    return { opportunityId: card.id, contactId: card.contactId, pipelineId: pipeline.id, stageId: card.stageId,
      stageClass: stage, status: card.status, candidateJobberClientIds: owners.map(c => c.jobberClientId),
      uniqueJobberClientId: owners.length === 1 && eligibleOwners.length === 1 && eligibleOwners[0].holds.length === 0 ? eligibleOwners[0].jobberClientId : null,
      existingCardCandidate: identityAndPipelineHolds.length === 0,
      dnd: { global: contact?.globalDnd ?? null, sms: contact?.smsDnd ?? 'unknown', email: contact?.emailDnd ?? 'unknown', call: contact?.callDnd ?? 'unknown' },
      holds: unique([...identityAndPipelineHolds, ...dndHolds]),
      communicationPermission: 'not_verified', smsCapability: 'not_verified', mutationAllowed: false };
  });
  const stageCounts = histogram(cardReports.map(c => c.stageClass));
  const expected = { sent: 107, paid: 10, overdue: 11, closed_out: 188 };
  return {
    counts: { cacheCustomers: input.customers.length, relevantCustomers: relevant.size,
      relevantCustomersMissingCacheContact: [...relevant].filter(owner => !input.customers.some(c => c.jobberClientId === owner)).length,
      cachedInvoicesWithUnknownOwner: input.cachedInvoices.filter(c => c.jobberClientId === null).length,
      contacts: contacts.length, cards: cards.length, customersReviewed: customers.length,
      existingCardCandidates: cardReports.filter(c => c.existingCardCandidate).length,
      cardsHeld: cardReports.filter(c => c.holds.length > 0).length,
      byStage: stageCounts, byStatus: histogram(cardReports.map(c => c.status)),
      historicalBaseline: { expectedTotal: 316, expectedByStage: expected, observedMatches: cards.length === 316 && Object.entries(expected).every(([k, n]) => stageCounts[k] === n), notACompletenessTest: true } },
    phoneFormats: { cachedCustomerPhones: histogram(input.customers.map(c => phoneFormat(c.phone))), ghlPrimaryPhones: histogram(contacts.map(c => phoneFormat(c.phone))) },
    ambiguity: { jobberEmailGroups: duplicateGroups(input.customers.map(c => emailKey(c.email))), jobberPhoneGroups: duplicateGroups(input.customers.map(c => canonicalPhone(c.phone))),
      ghlPrimaryEmailGroups: duplicateGroups(contacts.map(c => emailKey(c.email))), ghlPrimaryPhoneGroups: duplicateGroups(contacts.map(c => canonicalPhone(c.phone))),
      customersWithMultipleCandidateContacts: customers.filter(c => c.candidateContactIds.length > 1).length,
      cardsWithMultipleJobberOwnerCandidates: cardReports.filter(c => c.candidateJobberClientIds.length > 1).length,
      contactsWithMultipleCards: duplicateGroups(cards.map(c => c.contactId)) },
    contactFieldShapes: { invalidContactFieldCount: contacts.filter(c => !c.contactShapeValid).length,
      globalDndUnknown: contacts.filter(c => c.globalDnd === null).length, smsDndUnknown: contacts.filter(c => c.smsDnd === 'unknown').length,
      emailDndUnknown: contacts.filter(c => c.emailDnd === 'unknown').length, callDndUnknown: contacts.filter(c => c.callDnd === 'unknown').length },
    customers, cards: cardReports,
  };
}
