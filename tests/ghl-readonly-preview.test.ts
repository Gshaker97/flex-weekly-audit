import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runGhlReadonlyPreview } from '../scripts/source-audit/ghl-readonly-preview';
import { analyzeSnapshot, phoneFormat, PreviewInput } from '../scripts/ghl-preview/analysis';
import { canonicalPhone, matchPhoneCustomer } from '../scripts/ghl-preview/phone-match';
import { readAllContacts, readAllPipelineCards, readContact, readInvoicePipeline, Pipeline } from '../scripts/ghl-preview/snapshot';
import { assertReadOnlyRequest, GhlReadonlyReader, GHL_ORIGIN, GHL_VERSION, GHL_LIMITS } from '../scripts/ghl-preview/transport';
const locationId = 'test-location', apiKey = 'DUMMY_NEVER_VALID';
const input = (): PreviewInput => ({ customers: [{ jobberClientId: 'jobber-1', email: 'private@example.test', phone: '(602) 555-0101' }],
  cachedInvoices: [{ jobberInvoiceId: 'invoice-1', jobberClientId: 'jobber-1' }],
  freshInvoices: [{ id: 'invoice-1', owner: 'jobber-1', invoiceStatus: 'past_due', balance: 72000 }], freshInvoicesComplete: true, customerSnapshotComplete: true });
const contact = (overrides: Record<string, unknown> = {}) => ({ id: 'contact-1', locationId, email: 'private@example.test', phone: '+16025550101', dnd: false,
  dndSettings: { SMS: { status: 'inactive' }, Email: { status: 'inactive' }, Call: { status: 'inactive' } }, ...overrides });
const card = (overrides: Record<string, unknown> = {}) => ({ id: 'card-1', contactId: 'contact-1', pipelineId: 'pipeline-1', pipelineStageId: 'sent', status: 'open', ...overrides });
const pipeline: Pipeline = { id: 'pipeline-1', stages: new Map([['sent', 'sent'], ['paid', 'paid'], ['overdue', 'overdue'], ['closed', 'closed_out'], ['fee', 'late_fee']]), requiredStagesPresent: true };
const pipelines = { pipelines: [{ id: pipeline.id, name: 'Invoice Pipeline', locationId, stages: [
  { id: 'sent', name: 'Invoice Sent' }, { id: 'paid', name: 'Invoice Paid' }, { id: 'overdue', name: 'Invoice Overdue' }, { id: 'closed', name: 'Closed Out' }, { id: 'fee', name: 'Late Fee' },
] }] };
function reader(responses: unknown[], inspect?: (url: URL, init: RequestInit) => void) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const r = new GhlReadonlyReader({ apiKey, locationId, fetch: (async (url, init) => {
    const u = new URL(String(url)); calls.push({ url: u, init: init! }); inspect?.(u, init!);
    assert.equal(u.origin, GHL_ORIGIN); assert.equal(init?.redirect, 'manual'); assert.equal(new Headers(init?.headers).get('Version'), GHL_VERSION);
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${apiKey}`);
    assert.ok(responses.length, 'unexpected provider call'); const next = responses.shift();
    return next instanceof Response ? next : Response.json(next);
  }) as typeof fetch });
  return { r, calls };
}
const normalizedContacts = (raw: Record<string, unknown>[]) => raw.map(c => readContact(c, locationId));
function analyze(i: PreviewInput, contacts = [contact()], cards = [card()]) {
  return analyzeSnapshot(i, normalizedContacts(contacts), cards.map(c => ({ id: c.id as string, contactId: c.contactId as string, pipelineId: 'pipeline-1', stageId: c.pipelineStageId as string, status: c.status as 'open', ownerShapeValid: true })), pipeline);
}

test('complete preview contains only sanitized IDs, counts, controlled flags; no mutation route or raw contact data', async () => {
  const { r, calls } = reader([pipelines, { contacts: [contact({ firstName: 'SECRET-NAME', searchAfter: [1, 'contact-1'] })], total: 1 }, { opportunities: [card({ name: 'SECRET-TITLE' })], meta: { total: 1 } }]);
  const result = await runGhlReadonlyPreview(input(), { apiKey, locationId, fetch: (r as any).doFetch });
  assert.equal(result.outcome, 'complete');
  if (!('cards' in result)) throw new Error('missing result');
  assert.equal(result.cards[0].existingCardCandidate, true); assert.equal(result.cards[0].mutationAllowed, false);
  assert.equal(result.cards[0].communicationPermission, 'not_verified'); assert.equal(result.cards[0].smsCapability, 'not_verified');
  assert.equal(result.contracts.opportunities.status, 'all'); assert.equal(result.contracts.opportunities.deprecated, true);
  assert.equal(result.provenance.snapshotIsAtomic, false); assert.equal(calls.length, 3);
  const output = JSON.stringify(result);
  for (const forbidden of ['private@example.test', '602', '+16025550101', 'SECRET-NAME', 'SECRET-TITLE', apiKey]) assert.ok(!output.includes(forbidden));
});

test('contacts use unchanged last searchAfter and never combine it with page', async () => {
  const cursor = [123456789, 'contact-1'];
  const { r, calls } = reader([{ contacts: [contact({ searchAfter: cursor })], total: 2 }, { contacts: [contact({ id: 'contact-2' })], total: 2 }]);
  const result = await readAllContacts(r); assert.equal(result.contacts.length, 2); assert.equal(result.pages, 2);
  const first = JSON.parse(calls[0].init.body as string), next = JSON.parse(calls[1].init.body as string);
  assert.equal(first.page, 1); assert.equal(first.fastPagination, false); assert.deepEqual(next.searchAfter, cursor); assert.ok(!('page' in next));
});
for (const [name, responses] of Object.entries({
  'missing total': [{ contacts: [], meta: { total: 0 } }],
  'string total': [{ contacts: [], total: '0' }],
  'changed total': [{ contacts: [contact({ searchAfter: [1, 'a'] })], total: 2 }, { contacts: [contact({ id: 'b' })], total: 3 }],
  'duplicate ID': [{ contacts: [contact(), contact()], total: 2 }],
  'missing cursor': [{ contacts: [contact()], total: 2 }],
  'empty continuation': [{ contacts: [], total: 1 }],
  'wrong location': [{ contacts: [contact({ locationId: 'wrong' })], total: 1 }],
  'total too small': [{ contacts: [contact()], total: 0 }],
  'total over bound': [{ contacts: [], total: GHL_LIMITS.maxRecords + 1 }],
  'repeated cursor': [{ contacts: [contact({ searchAfter: [1, 'a'] })], total: 3 }, { contacts: [contact({ id: 'b', searchAfter: [1, 'a'] })], total: 3 }],
})) test(`contacts reject ${name}`, async () => { const { r } = reader([...responses]); await assert.rejects(readAllContacts(r)); });

test('empty complete contact snapshot is valid', async () => { const { r } = reader([{ contacts: [], total: 0 }]); assert.equal((await readAllContacts(r)).total, 0); });
test('opportunities paginate with status all and ignore supplied nextPageUrl', async () => {
  const { r, calls } = reader([{ opportunities: [card()], meta: { total: 2, startAfter: 123, startAfterId: 'card-1', nextPageUrl: 'https://attacker.test/steal' } },
    { opportunities: [card({ id: 'card-2', status: 'won' })], meta: { total: 2 } }]);
  assert.equal((await readAllPipelineCards(r, pipeline)).cards.length, 2);
  for (const c of calls) { assert.equal(c.url.searchParams.get('status'), 'all'); assert.equal(c.url.searchParams.get('pipeline_id'), pipeline.id); }
  assert.equal(calls[1].url.searchParams.get('startAfter'), '123'); assert.equal(calls[1].url.searchParams.get('startAfterId'), 'card-1');
});
for (const [name, responses] of Object.entries({
  'missing total': [{ opportunities: [], meta: {} }],
  'string total': [{ opportunities: [], meta: { total: '0' } }],
  'duplicate ID': [{ opportunities: [card(), card()], meta: { total: 2 } }],
  'wrong pipeline': [{ opportunities: [card({ pipelineId: 'wrong' })], meta: { total: 1 } }],
  'wrong location': [{ opportunities: [card({ locationId: 'wrong' })], meta: { total: 1 } }],
  'missing cursor': [{ opportunities: [card()], meta: { total: 2 } }],
  'changed total': [{ opportunities: [card()], meta: { total: 2, startAfter: 123, startAfterId: 'a' } }, { opportunities: [], meta: { total: 1 } }],
  'repeated cursor': [{ opportunities: [card()], meta: { total: 3, startAfter: 123, startAfterId: 'a' } }, { opportunities: [card({ id: 'b' })], meta: { total: 3, startAfter: 123, startAfterId: 'a' } }],
  'arbitrary cursor content': [{ opportunities: [card()], meta: { total: 2, startAfter: 'raw-sensitive-text', startAfterId: 'a' } }],
  'total too small': [{ opportunities: [card()], meta: { total: 0 } }],
})) test(`cards reject ${name}`, async () => { const { r } = reader([...responses]); await assert.rejects(readAllPipelineCards(r, pipeline)); });

test('card embedded ownership mismatch is held, never inferred', async () => {
  const { r } = reader([{ opportunities: [card({ contact: { id: 'someone-else' } })], meta: { total: 1 } }]);
  const result = await readAllPipelineCards(r, pipeline); assert.equal(result.cards[0].ownerShapeValid, false);
});
for (const [method, path] of [['PUT', '/opportunities/card-1'], ['POST', '/opportunities/'], ['DELETE', '/contacts/contact-1'], ['POST', '/contacts/'],
  ['GET', '/workflows/'], ['GET', '/contacts/contact-1/workflow'], ['GET', '/conversations/messages'], ['PATCH', '/contacts/search']]) {
  test(`allowlist rejects ${method} ${path}`, () => assert.throws(() => assertReadOnlyRequest(new URL(path, GHL_ORIGIN), method)));
}
test('allowlist rejects other origins, credentials, unknown query fields, fragments and malformed POST bodies', () => {
  for (const url of ['https://attacker.test/contacts/search', `${GHL_ORIGIN}/opportunities/pipelines?locationId=test&query=pii`, `${GHL_ORIGIN}/opportunities/pipelines#fragment`, 'https://user:password@services.leadconnectorhq.com/opportunities/pipelines']) {
    assert.throws(() => assertReadOnlyRequest(new URL(url), 'GET'));
  }
  assert.throws(() => assertReadOnlyRequest(new URL('/contacts/search', GHL_ORIGIN), 'POST', { locationId }));
});
for (const status of [301, 302, 307, 401, 403, 429, 500]) test(`HTTP ${status} is sanitized, not followed or retried`, async () => {
  const { r, calls } = reader([new Response('SECRET_BODY_AND_TOKEN', { status, headers: { location: 'https://attacker.test/steal' } })]);
  await assert.rejects(r.request(`/opportunities/pipelines?locationId=${locationId}`), e => !String(e).includes('SECRET_BODY_AND_TOKEN'));
  assert.equal(calls.length, 1);
});
test('malformed JSON and non-JSON responses are sanitized', async () => {
  for (const response of [new Response('SECRET', { headers: { 'Content-Type': 'application/json' } }), new Response('SECRET', { headers: { 'Content-Type': 'text/html' } })]) {
    const { r } = reader([response]); await assert.rejects(r.request(`/opportunities/pipelines?locationId=${locationId}`), e => !String(e).includes('SECRET'));
  }
});
test('response size limit rejects before reading an oversized declared response', async () => {
  const { r } = reader([new Response('SECRET', { headers: { 'Content-Type': 'application/json', 'Content-Length': String(GHL_LIMITS.responseBytes + 1) } })]);
  await assert.rejects(r.request(`/opportunities/pipelines?locationId=${locationId}`), /GHL_RESPONSE_BYTE_LIMIT/);
});
test('global deadline caps whole helper and returns incomplete without calls', async () => {
  let calls = 0;
  const result = await runGhlReadonlyPreview(input(), { apiKey, locationId, deadlineAt: Date.now() - 1, fetch: (async () => { calls++; throw new Error('SECRET'); }) as typeof fetch });
  assert.equal(result.outcome, 'incomplete'); assert.equal(calls, 0); assert.ok(!JSON.stringify(result).includes('SECRET'));
});
test('unknown network error is sanitized, 5 minute limit enforced', async () => {
  const result = await runGhlReadonlyPreview(input(), { apiKey, locationId, fetch: (async () => { throw new Error('SECRET'); }) as typeof fetch });
  assert.equal(result.outcome, 'incomplete'); assert.ok(!JSON.stringify(result).includes('SECRET'));
  const r = new GhlReadonlyReader({ apiKey, locationId, deadlineAt: Date.now() + 999_999 }); assert.equal(r.deadlineAt - r.startedAt, 300_000);
});
test('pipeline ambiguity and duplicate stages fail closed', async () => {
  for (const response of [{ pipelines: [] }, { pipelines: [...pipelines.pipelines, ...pipelines.pipelines] }, { pipelines: [{ ...pipelines.pipelines[0], stages: [{ id: 'a', name: 'Invoice Sent' }, { id: 'b', name: 'Invoice Sent' }] }] }]) {
    const { r } = reader([response]); await assert.rejects(readInvoicePipeline(r));
  }
});

test('US phone normalization is identical to tested helper; international never guessed US', () => {
  assert.equal(canonicalPhone('(602) 555-0101'), '+16025550101'); assert.equal(canonicalPhone('1 602 555 0101'), '+16025550101');
  assert.equal(canonicalPhone('+44 20 7946 0000'), '+442079460000'); assert.equal(canonicalPhone('6025550101 ext 3'), null);
  assert.equal(phoneFormat('6025550101'), 'domestic_us_10_digits'); assert.equal(phoneFormat('+442079460000'), 'explicit_international');
});
test('three same-phone contacts hold all candidates, not first card', () => {
  const i = input(); i.customers[0].email = null;
  const result = analyze(i, [contact({ email: null }), contact({ id: 'contact-2', email: null }), contact({ id: 'contact-3', email: null })]);
  assert.equal(result.customers[0].contactId, null); assert.equal(result.customers[0].candidateContactIds.length, 3);
  assert.ok(result.customers[0].holds.includes('AMBIGUOUS_PHONE_CONTACTS')); assert.equal(result.cards[0].existingCardCandidate, false);
});
test('won Closed Out card is held, never reopened even with positive fresh source debt', () => {
  const result = analyze(input(), [contact()], [card({ status: 'won', pipelineStageId: 'closed' })]);
  assert.equal(result.cards[0].status, 'won'); assert.equal(result.cards[0].existingCardCandidate, false);
  assert.ok(result.cards[0].holds.includes('CLOSED_OR_UNKNOWN_CARD_NO_REOPEN')); assert.ok(result.cards[0].holds.includes('SPECIAL_OR_UNKNOWN_STAGE_PROTECTED'));
});
test('unique phone-only contact/card resolves without enabling sends', () => {
  const i = input(); i.customers[0].email = null;
  const result = analyze(i, [contact({ email: null })]);
  assert.equal(result.cards[0].existingCardCandidate, true); assert.equal(result.customers[0].method, 'exact_us_phone'); assert.equal(result.cards[0].mutationAllowed, false);
});
test('shared Jobber phones and suffix-only competing contact block identity', () => {
  const i = input(); i.customers[0].email = null; i.customers.push({ jobberClientId: 'jobber-2', phone: '6025550101' });
  assert.equal(analyze(i, [contact({ email: null })]).cards[0].existingCardCandidate, false);
  const j = input(); j.customers[0].email = null;
  const result = matchPhoneCustomer(j.customers[0], j.customers, [contact({ email: null }), contact({ id: 'suffix', phone: '5550101' })]);
  assert.equal(result.contactId, null); assert.equal(result.candidateIds.length, 2);
});
test('duplicate exact email is not selected; fuzzy email is not accepted', () => {
  const duplicate = analyze(input(), [contact(), contact({ id: 'duplicate' })]); assert.equal(duplicate.cards[0].existingCardCandidate, false);
  const i = input(); i.customers[0].phone = null;
  const fuzzy = analyze(i, [contact({ email: 'private+other@example.test', phone: null })]); assert.equal(fuzzy.customers[0].contactId, null);
});
test('email ownership shared with a different Jobber customer is held', () => {
  const i = input(); i.customers.push({ jobberClientId: 'jobber-2', email: 'PRIVATE@example.test' });
  const result = analyze(i); assert.equal(result.cards[0].existingCardCandidate, false); assert.equal(result.cards[0].candidateJobberClientIds.length, 2);
});
test('email and phone pointing at different contacts hold both IDs', () => {
  const result = analyze(input(), [contact({ phone: '+16025550202' }), contact({ id: 'phone-other', email: 'other@example.test' })]);
  assert.equal(result.customers[0].contactId, null); assert.ok(result.customers[0].holds.includes('EMAIL_PHONE_CONTACT_CONFLICT'));
});
test('additional contact identity fields only introduce holds, not automatic matches', () => {
  const result = analyze(input(), [contact(), contact({ id: 'extra', email: null, phone: null, additionalEmails: [{ email: 'private@example.test' }] })]);
  assert.equal(result.cards[0].existingCardCandidate, false); assert.ok(result.customers[0].holds.includes('SECONDARY_CONTACT_FIELD_OWNERSHIP_CONFLICT'));
});
test('multiple cards include closed hidden duplicates', () => {
  const result = analyze(input(), [contact()], [card(), card({ id: 'closed-duplicate', status: 'won' })]);
  assert.ok(result.cards.every(c => !c.existingCardCandidate)); assert.ok(result.cards[0].holds.includes('MULTIPLE_EXISTING_CARDS_ALL_STATUSES'));
});
test('missing existing card means hold, no creation', () => {
  const result = analyze(input(), [contact()], []); assert.ok(result.customers[0].holds.includes('NO_EXISTING_CARD_CREATION_DISABLED'));
});
test('DND active, permanent and missing stay eligibility flags, not consent', () => {
  const r = analyze(input(), [contact({ dnd: true, dndSettings: { SMS: { status: 'permanent' } } })]);
  assert.ok(r.cards[0].holds.includes('GLOBAL_DND_ENABLED')); assert.ok(r.cards[0].holds.includes('SMS_DND_ENABLED'));
  assert.ok(r.cards[0].holds.includes('EMAIL_DND_UNKNOWN')); assert.equal(r.cards[0].communicationPermission, 'not_verified');
  const unknown = analyze(input(), [contact({ dnd: undefined, dndSettings: undefined })]); assert.equal(unknown.cards[0].dnd.global, null);
});
for (const [name, modify, expected] of [
  ['missing fresh source', (i: PreviewInput) => { i.freshInvoicesComplete = false; }, 'FRESH_SOURCE_COMPLETENESS_UNVERIFIED'],
  ['missing cached invoice', (i: PreviewInput) => { i.freshInvoices = []; }, 'CACHED_INVOICE_MISSING_FROM_FRESH_SOURCE'],
  ['owner changed', (i: PreviewInput) => { i.freshInvoices![0].owner = 'other'; }, 'INVOICE_OWNER_CHANGED'],
  ['owner unknown', (i: PreviewInput) => { i.freshInvoices![0].owner = null; }, 'FRESH_INVOICE_OWNER_UNRESOLVED'],
  ['paid-positive conflict', (i: PreviewInput) => { i.freshInvoices![0].invoiceStatus = 'paid'; }, 'PAID_STATUS_WITH_POSITIVE_BALANCE'],
  ['zero without paid', (i: PreviewInput) => { i.freshInvoices![0].balance = 0; }, 'ZERO_BALANCE_WITHOUT_PAID_STATUS'],
  ['credit balance', (i: PreviewInput) => { i.freshInvoices![0].balance = -100; }, 'CREDIT_BALANCE_REQUIRES_REVIEW'],
  ['unknown balance', (i: PreviewInput) => { i.freshInvoices![0].balance = null; }, 'SOURCE_STATUS_OR_BALANCE_UNVERIFIED'],
  ['void not paid', (i: PreviewInput) => { i.freshInvoices![0].invoiceStatus = 'void'; }, 'SOURCE_STATUS_OR_BALANCE_UNVERIFIED'],
] as const) test(`fresh evidence holds ${name}`, () => { const i = input(); modify(i); const r = analyze(i); assert.equal(r.cards[0].existingCardCandidate, false); assert.ok(r.customers[0].holds.includes(expected)); });

test('missing DND, unsupported source phone format and malformed contact identity are counted without exposing data', () => {
  const i = input(); i.customers[0].email = null; i.customers[0].phone = 'SECRET-phone-extension';
  const r = analyze(i, [contact({ email: { unsafe: 'SECRET' }, dnd: undefined })]);
  assert.equal(r.phoneFormats.cachedCustomerPhones.unsupported, 1); assert.equal(r.contactFieldShapes.invalidContactFieldCount, 1);
  assert.equal(r.cards[0].existingCardCandidate, false); assert.ok(!JSON.stringify(r).includes('SECRET'));
});
test('invalid local input fails before network and is sanitized', async () => {
  const i = input(); i.customers[0].jobberClientId = 'SECRET EMAIL@example.test'; let calls = 0;
  const r = await runGhlReadonlyPreview(i, { apiKey, locationId, fetch: (async () => { calls++; throw new Error('unexpected'); }) as typeof fetch });
  assert.equal(r.outcome, 'incomplete'); assert.equal(calls, 0); assert.ok(!JSON.stringify(r).includes('SECRET'));
});
test('historical 316 baseline mismatch is reported, never fabricated as completeness', () => {
  const r = analyze(input()); assert.equal(r.counts.historicalBaseline.observedMatches, false); assert.equal(r.counts.historicalBaseline.notACompletenessTest, true);
});

test('partial cached customer population cannot establish unique identity', () => {
  const i = input(); i.customerSnapshotComplete = false; const result = analyze(i);
  assert.equal(result.cards[0].existingCardCandidate, false); assert.ok(result.customers[0].holds.includes('CUSTOMER_SNAPSHOT_COMPLETENESS_UNVERIFIED'));
});
