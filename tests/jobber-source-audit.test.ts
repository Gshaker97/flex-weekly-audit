import test from 'node:test';
import { createHash } from 'node:crypto';
import { reportLines } from '../scripts/source-audit/output';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { AuditFailure, CacheRow, cents, compare, dateValue, deriveTargets, INVOICE_QUERY, LIMITS, normalize, paginate, shape } from '../scripts/source-audit/core';
import { boundedJson, Budget, capabilityProbe, expiryMinutes, JobberReader, requireToken, requireTokenRunCoverage } from '../scripts/source-audit/transport';

function invoice(id = 'opaque-1', extra: Record<string, unknown> = {}) {
  return { id, invoiceNumber: '100', invoiceStatus: 'past_due', subtotal: 100,
    amounts: { total: 110, invoiceBalance: 50, subtotal: 100, discountAmount: 0 },
    issuedDate: '2026-10-01', dueDate: '2026-10-31', createdAt: '2026-10-01T00:00:00Z', client: { id: 'owner-1' }, ...extra };
}
function cache(extra: Partial<CacheRow> = {}): CacheRow {
  return { jobberInvoiceId: 'opaque-1', invoiceNumber: '100', invoiceStatus: 'past_due', total: 110, subtotal: 100,
    amountDue: 50, amountPaid: 60, issuedAt: new Date('2026-10-01T00:00:00Z'), dueAt: new Date('2026-10-31T00:00:00Z'),
    createdAtJobber: new Date('2026-10-01T00:00:00Z'), paidAt: null, customerId: 'local-1', customer: { jobberClientId: 'owner-1' },
    lastSyncedAt: new Date('2026-11-01T00:00:00Z'), ...extra };
}
function page(nodes: unknown[], hasNextPage = false, endCursor: unknown = nodes.length ? 'cursor-1' : null) { return { invoices: { nodes, pageInfo: { hasNextPage, endCursor } } }; }
async function expectFailure(action: () => unknown, code: string) { await assert.rejects(async () => action(), (e: unknown) => e instanceof AuditFailure && e.code === code); }
const response = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
const tomorrow = () => new Date(Date.now() + 86400_000);

test('existing invoice query is unfiltered and omits private customer fields', () => {
  assert.match(INVOICE_QUERY, /invoices\(first: 25, after: \$after\)/);
  assert.doesNotMatch(INVOICE_QUERY, /filter|companyName|email|phone|\bname\b|paymentDate|paidAt/);
});
test('enumerates terminal page with stable IDs, preserving duplicate invoice numbers', async () => {
  const seen: unknown[] = [];
  const r = await paginate(async after => { seen.push(after); return after === null ? page([invoice()], true) : page([invoice('opaque-2')], false, 'cursor-2'); });
  assert.deepEqual(seen, [null, 'cursor-1']); assert.equal(r.records.length, 2); assert.equal(r.terminalPageObserved, true);
});
test('empty unfiltered account is a complete terminal result', async () => { assert.equal((await paginate(async () => page([]))).records.length, 0); });
for (const [name, payload, code] of [
  ['missing connection', {}, 'SOURCE_CONNECTION_MISSING'],
  ['missing nodes', { invoices: { pageInfo: { hasNextPage: false } } }, 'SOURCE_PAGE_MALFORMED'],
  ['nonboolean page flag', { invoices: { nodes: [], pageInfo: { hasNextPage: 'false' } } }, 'SOURCE_PAGE_MALFORMED'],
  ['missing cursor', page([invoice()], true, null), 'SOURCE_CURSOR_MISSING'],
  ['empty continuation', page([], true), 'SOURCE_EMPTY_CONTINUATION'],
  ['null node', page([null]), 'INVALID_SOURCE_INVOICE_ID'],
  ['missing ID', page([invoice('', { id: null })]), 'INVALID_SOURCE_INVOICE_ID'],
  ['too many page records', page(Array.from({ length: 26 }, (_, i) => invoice(`id-${i}`))), 'SOURCE_PAGE_OVERSIZE'],
] as const) test(`fails closed on ${name}`, async () => expectFailure(() => paginate(async () => payload), code));
test('repeated cursor fails even on terminal page', async () => { let n = 0; await expectFailure(() => paginate(async () => page([invoice(`id-${n++}`)], n === 1)), 'SOURCE_CURSOR_REPEATED'); });
test('duplicate opaque ID fails, never silently deduplicates', async () => { let n = 0; await expectFailure(() => paginate(async () => page([invoice()], ++n === 1, `cursor-${n}`)), 'SOURCE_ID_REPEATED'); });
test('page bound means incomplete rather than truncated success', async () => expectFailure(() => paginate(async () => page([invoice()], true), { maxPages: 1 }), 'SOURCE_PAGE_LIMIT'));
test('record bound means incomplete', async () => expectFailure(() => paginate(async () => page([invoice(), invoice('id-2')]), { maxRecords: 1 }), 'SOURCE_RECORD_LIMIT'));
test('empty terminal continuation cannot silently truncate read', async () => { let n = 0; await expectFailure(() => paginate(async () => ++n === 1 ? page([invoice()], true) : page([])), 'SOURCE_EMPTY_CONTINUATION'); });
test('money refuses null, empty string, strings, booleans, NaN and subcent precision', () => {
  for (const x of [null, undefined, '', '1.00', false, NaN, Infinity, 1.005]) assert.equal(cents(x), null);
  assert.equal(cents(12345.67), 1234567); assert.equal(cents(-300), -30000); assert.equal(cents(0), 0);
});
test('dates preserve null and unknown scalar shapes, reject invalid calendar date', () => {
  assert.equal(dateValue(null).kind, 'null');
  for (const x of [undefined, 1790000000, { iso8601: '2026-01-01' }, '2026-02-30', '2026-01-01T00:00:00']) assert.equal(dateValue(x).kind, 'unknown');
  assert.equal(shape({}), 'object'); assert.equal(dateValue('2026-10-01').day, '2026-10-01');
  assert.equal(dateValue('2026-10-01T23:00:00-07:00').day, '2026-10-01');
});
test('exact match uses opaque ID and verifies amount/date/owner fields', () => {
  const r = compare([normalize(invoice())], [cache()]); assert.equal(r.comparison.matching, 1); assert.equal(r.comparison.differing, 0);
});
test('date and ownership differences are labeled without logging dates or local ownership IDs', () => {
  const r = compare([normalize(invoice())], [cache({ dueAt: new Date('2026-11-02'), customer: { jobberClientId: 'owner-2' } })]);
  assert.equal(r.comparison.fieldDifferences.dueDate, 1); assert.equal(r.comparison.fieldDifferences.ownerId, 1);
  const text = JSON.stringify(r.details); assert.doesNotMatch(text, /2026-11-02|local-1/); assert.match(text, /owner-2/);
});
test('compares cached amountPaid only as unverified arithmetic, never cash', () => {
  const r = compare([normalize(invoice())], [cache({ amountPaid: 110, paidAt: new Date('2026-10-01') })]);
  assert.equal(r.comparison.fieldDifferences['storedAmountPaid-vs-totalMinusBalance'], 1);
  assert.equal(r.paymentEvidence.verifiedCashTotal, null); assert.equal(r.paymentEvidence.cachedPaidDateEqualsIssueDate, 1);
  assert.equal(r.paymentEvidence.actualPaymentDatesAvailable, false);
});
test('paid positive conflicts do not net against paid negative credits', () => {
  const rows = [normalize(invoice('p', { invoiceStatus: 'paid', amounts: { total: 100, invoiceBalance: 100, subtotal: 100, discountAmount: 0 } })),
    normalize(invoice('n', { invoiceStatus: 'paid', amounts: { total: 100, invoiceBalance: -300, subtotal: 100, discountAmount: 0 } }))];
  const r = compare(rows, []); assert.equal(r.source.paidPositiveBalanceCents, 10000); assert.equal(r.source.negativeBalanceCents, -30000); assert.equal(r.source.paidPositiveCount, 1);
});
test('missing or zero balance does not infer paid status', () => {
  const unknown = normalize(invoice('u', { amounts: { total: 110, subtotal: 100 } }));
  const zero = normalize(invoice('z', { amounts: { total: 110, invoiceBalance: 0, subtotal: 100, discountAmount: 0 } }));
  assert.equal(unknown.balance, null); assert.equal(unknown.invoiceStatus, 'past_due'); assert.equal(zero.invoiceStatus, 'past_due');
  assert.equal(compare([unknown, zero], []).source.unknownBalanceCount, 1);
});
test('duplicate display numbers are retained, and targets resolve every exact ID', () => {
  const r = compare([normalize(invoice('a', { invoiceNumber: 'duplicate-100', invoiceStatus: 'void' })), normalize(invoice('b', { invoiceNumber: 'duplicate-100', invoiceStatus: 'paid' }))], [cache({ jobberInvoiceId: 'a', invoiceNumber: 'duplicate-100' }), cache({ jobberInvoiceId: 'b', invoiceNumber: 'duplicate-100' })], ['duplicate-100']);
  assert.deepEqual(r.targetResolution[0].sourceIds, ['a', 'b']); assert.equal(r.duplicateInvoiceNumbers.source[0].ids.length, 2);
  assert.equal(r.comparison.sourceOnly, 0); assert.equal(r.comparison.cacheOnly, 0);
});
test('source-only and cache-only are explicit, never labeled deleted', () => {
  const r = compare([normalize(invoice('source'))], [cache({ jobberInvoiceId: 'cache' })]);
  assert.equal(r.comparison.sourceOnly, 1); assert.equal(r.comparison.cacheOnly, 1); assert.doesNotMatch(JSON.stringify(r.details), /deleted/);
});
test('unknown dates and statuses are visible but raw arbitrary text is not logged', () => {
  const r = compare([normalize(invoice('u', { invoiceStatus: 'SECRET-PRIVATE-UNKNOWN', issuedDate: { private: 'SECRET' } }))], []);
  assert.equal(r.source.byStatus.unknown.count, 1); assert.equal(r.sourceDateShapes.issuedDate.object, 1); assert.doesNotMatch(JSON.stringify(r), /SECRET/);
});
test('report strips unexpected names and contact data', () => {
  const r = compare([normalize(invoice('id', { name: 'PRIVATE NAME', client: { id: 'opaque-client', name: 'PRIVATE NAME', email: 'secret@example.com', phone: '555-999-8888' } }))], []);
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE|example.com|555-999/);
});
test('detail truncation is explicit while totals and differences cover all rows', () => {
  const rows = [normalize(invoice('a')), normalize(invoice('b')), normalize(invoice('c', { invoiceNumber: 'target' }))];
  const r = compare(rows, [], ['target'], 1); assert.equal(r.detailsTruncated, true); assert.equal(r.omittedDetailCount, 2);
  assert.equal(r.source.count, 3); assert.equal(r.comparison.sourceOnly, 3); assert.equal(r.details[0].id, 'c');
});
test('coarse token expiry is reported without refresh', async () => {
  const now = Date.now(); assert.equal(expiryMinutes(new Date(now + 125000), now), 2);
  await expectFailure(() => requireToken(new Date(now + 20000), now), 'EXISTING_TOKEN_EXPIRED_OR_NEAR_EXPIRY');
  requireToken(new Date(now + 60000), now);
});
test('transport uses fixed existing endpoint/version, query-only, no redirects', async () => {
  let calls = 0;
  const reader = new JobberReader('fake-token', tomorrow(), new Budget(), (async (url, init) => {
    calls++; assert.equal(url, 'https://api.getjobber.com/api/graphql'); assert.equal(init?.redirect, 'error');
    assert.equal((init?.headers as Record<string, string>)['X-JOBBER-GRAPHQL-VERSION'], '2025-04-16');
    assert.equal((JSON.parse(init?.body as string)).query, INVOICE_QUERY); return response({ data: page([]) });
  }) as typeof fetch);
  await reader.page(null); assert.equal(calls, 1);
  await expectFailure(() => reader.query('mutation { change }'), 'NON_READ_QUERY_REJECTED'); assert.equal(calls, 1);
});
test('any partial GraphQL error prevents success', async () => {
  const reader = new JobberReader('fake', tomorrow(), new Budget(), (async () => response({ data: page([invoice()]), errors: [{ message: 'PRIVATE', extensions: { code: 'FORBIDDEN' } }] })) as typeof fetch);
  await expectFailure(() => reader.page(null), 'SOURCE_GRAPHQL_ERROR');
});
test('401 never refreshes or retries and does not expose response body', async () => {
  let calls = 0;
  const reader = new JobberReader('fake', tomorrow(), new Budget(), (async () => { calls++; return new Response('SECRET', { status: 401 }); }) as typeof fetch);
  await expectFailure(() => reader.page(null), 'EXISTING_CONNECTION_AUTHORIZATION_FAILED'); assert.equal(calls, 1);
});
test('retry budget is bounded to three, and errors stay sanitized', async () => {
  const budget = new Budget(); budget.pause = async () => {};
  const reader = new JobberReader('fake', tomorrow(), budget, (async () => new Response('SECRET', { status: 429 })) as typeof fetch);
  await expectFailure(() => reader.page(null), 'SOURCE_RETRIES_EXHAUSTED'); assert.equal(budget.requests, 3); assert.equal(budget.retries, 2);
});
test('network exceptions containing secrets are never surfaced raw', async () => {
  const reader = new JobberReader('fake', tomorrow(), new Budget(), (async () => { throw new Error('SECRET https://token'); }) as typeof fetch);
  await expectFailure(() => reader.page(null), 'SOURCE_NETWORK_ERROR');
});
test('byte bound includes streamed bodies', async () => {
  const budget = new Budget(), c = new AbortController();
  await expectFailure(() => boundedJson(new Response('x'.repeat(LIMITS.maxResponseBytes + 1)), budget, c), 'RESPONSE_BYTE_LIMIT'); assert.equal(c.signal.aborted, true);
});
test('byte bound rejects oversized content length before buffering', async () => {
  await expectFailure(() => boundedJson(new Response('{}', { headers: { 'content-length': String(LIMITS.maxResponseBytes + 1) } }), new Budget(), new AbortController()), 'RESPONSE_BYTE_LIMIT');
});
test('capability probe returns matching field names/types only, and gracefully fails', async () => {
  const reader = new JobberReader('fake', tomorrow(), new Budget(), (async () => response({ data: { __type: { fields: [
    { name: 'sentAt', type: { kind: 'SCALAR', name: 'ISO8601DateTime' } },
    { name: 'payments', type: { kind: 'NON_NULL', name: null, ofType: { kind: 'OBJECT', name: 'PaymentConnection' } } },
    { name: 'customerName', type: { kind: 'SCALAR', name: 'String' } },
  ] } } })) as typeof fetch);
  const r = await capabilityProbe(reader); assert.equal(r.available, true); assert.deepEqual(r.fields.map(({ name, type }) => ({ name, type })), [{ name: 'sentAt', type: 'ISO8601DateTime' }, { name: 'payments', type: 'PaymentConnection!' }]);
  const failed = new JobberReader('fake', tomorrow(), new Budget(), (async () => response({ errors: [{ message: 'SECRET' }] })) as typeof fetch);
  const fail = await capabilityProbe(failed); assert.equal(fail.available, false); assert.doesNotMatch(JSON.stringify(fail), /SECRET/);
});
test('runtime refuses local execution before any database/network use', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/audit-jobber-source.ts', '--run-in-deployment'], { cwd: process.cwd(), encoding: 'utf8', env: { PATH: process.env.PATH, NODE_ENV: 'test' } });
  assert.equal(result.status, 2); const parsed = JSON.parse(result.stdout); assert.equal(parsed.code, 'EXISTING_RAILWAY_DEPLOYMENT_REQUIRED'); assert.equal(parsed.requests, 0);
});
test('script imports no mutating app sync, auth or GHL code; reads DB only', () => {
  const code = readFileSync('scripts/audit-jobber-source.ts', 'utf8');
  assert.match(code, /SET TRANSACTION READ ONLY/); assert.doesNotMatch(code, /lib\/(sync|jobber|ghl)|(?:invoiceRecord|jobberAuth)\.(?:upsert|update|create|delete)|refreshToken/);
});

test('requires enough existing token lifetime for the entire bounded run', async () => {
  const now = Date.now();
  await expectFailure(() => requireTokenRunCoverage(new Date(now + 14 * 60000), now), 'EXISTING_TOKEN_INSUFFICIENT_RUN_COVERAGE');
  requireTokenRunCoverage(new Date(now + 16 * 60000), now);
});

test('bounded log parts reconstruct the complete report with a hash and manifest', () => {
  const report = { values: Array.from({ length: 1000 }, (_, i) => ({ id: `opaque-${i}`, note: '\"nested\" Unicode 🪴' })) };
  const lines = reportLines(report);
  for (const line of lines) assert.ok(Buffer.byteLength(line) < 5500);
  const events = lines.map(l => JSON.parse(l)), manifest = events.at(-1);
  assert.equal(manifest.event, 'report-complete');
  const reconstructed = events.slice(0, -1).map(x => x.payload).join('');
  assert.deepEqual(JSON.parse(reconstructed), report);
  assert.equal(createHash('sha256').update(reconstructed).digest('hex'), manifest.sha256);
  assert.equal(Buffer.byteLength(reconstructed), manifest.bytes);
});

test('review targets derive from current cache conflicts, credits, voids and duplicate numbers', () => {
  const rows = [cache({ jobberInvoiceId: 'a', invoiceNumber: 'credit', invoiceStatus: 'paid', amountDue: -300 }), cache({ jobberInvoiceId: 'b', invoiceNumber: 'void', invoiceStatus: 'void' }), cache({ jobberInvoiceId: 'c', invoiceNumber: 'duplicate' }), cache({ jobberInvoiceId: 'd', invoiceNumber: 'duplicate' })];
  assert.deepEqual(deriveTargets(rows), ['credit', 'duplicate', 'void']);
  const r = compare([], rows, deriveTargets(rows));
  assert.equal(r.details.length, 4);
});

test('unknown/null scalar pairs are unverifiable rather than matching', () => {
  const source = normalize(invoice('id', { invoiceStatus: 'unknown-a', amounts: null, client: null, invoiceNumber: null }));
  const r = compare([source], [cache({ jobberInvoiceId: 'id', invoiceStatus: 'unknown-b', total: NaN, subtotal: NaN, amountDue: NaN, invoiceNumber: null, customer: null, customerId: null })]);
  assert.equal(r.comparison.matching, 0);
  for (const name of ['status', 'totalCents', 'balanceCents', 'subtotalCents', 'ownerId', 'invoiceNumber']) assert.equal(r.comparison.fieldDifferences[`${name}-unverifiable`], 1);
});
test('oversized declared response aborts and cancels without reading its body', async () => {
  let cancelled = false; const controller = new AbortController();
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const response = new Response(body, { headers: { 'content-length': String(LIMITS.maxResponseBytes + 1) } });
  await expectFailure(() => boundedJson(response, new Budget(), controller), 'RESPONSE_BYTE_LIMIT');
  assert.equal(cancelled, true); assert.equal(controller.signal.aborted, true);
});

test('runtime rejects a different Railway service before database access', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/audit-jobber-source.ts', '--run-in-deployment'], { cwd: process.cwd(), encoding: 'utf8', env: { PATH: process.env.PATH, NODE_ENV: 'test', RAILWAY_SERVICE_ID: 'wrong', RAILWAY_ENVIRONMENT_ID: 'wrong', RAILWAY_DEPLOYMENT_ID: 'synthetic', DATABASE_URL: 'postgresql://not-used.invalid/no' } });
  assert.equal(result.status, 2); const parsed = JSON.parse(result.stdout); assert.equal(parsed.code, 'WRONG_RAILWAY_SERVICE_OR_ENVIRONMENT'); assert.equal(parsed.requests, 0);
});

// Only introspection is allowed in the capability expansion; no business values.
test('probe includes communications/terms and follows discovered connection/node schemas only', async () => {
  const scalar = (name: string) => ({ kind: 'SCALAR', name });
  const obj = (name: string) => ({ kind: 'OBJECT', name });
  const schemas: Record<string, unknown> = {
    Invoice: { fields: [
      { name: 'invoiceNet', type: scalar('Int') },
      { name: 'linkedCommunications', type: obj('MessageConnection'), args: [{ name: 'first', type: scalar('Int') }] },
      { name: 'paymentRecords', type: obj('PaymentConnection') },
      { name: 'lineItems', type: obj('ItemConnection') },
    ] },
    MessageConnection: { fields: [{ name: 'nodes', type: { kind: 'NON_NULL', ofType: { kind: 'LIST', ofType: { kind: 'NON_NULL', ofType: obj('Message') } } } }] },
    PaymentConnection: { fields: [{ name: 'nodes', type: obj('Payment') }] },
    ItemConnection: { fields: [{ name: 'nodes', type: obj('Item') }] },
    Message: { fields: [{ name: 'sentAt', type: scalar('ISO8601DateTime') }] },
    Payment: { fields: [{ name: 'transactionDate', type: scalar('ISO8601DateTime') }, { name: 'amount', type: scalar('Float') }] },
    Item: { fields: [{ name: 'quantity', type: scalar('Float') }] },
  };
  const seen: string[] = [];
  const reader = new JobberReader('fake', tomorrow(), new Budget(), (async (_url, init) => {
    const body = JSON.parse(init?.body as string); assert.match(body.query, /__type/); assert.doesNotMatch(body.query, /\binvoices\s*\(/);
    seen.push(body.variables.typeName); return response({ data: { __type: schemas[body.variables.typeName] } });
  }) as typeof fetch);
  const r = await capabilityProbe(reader); assert.equal(r.available, true); assert.equal(r.requests, 7); assert.equal(r.childSchemaComplete, true);
  assert.deepEqual(r.fields.find(f => f.name === 'linkedCommunications')?.args, [{ name: 'first', type: 'Int' }]);
  assert.ok(r.fields.some(f => f.name === 'invoiceNet')); assert.ok(seen.includes('Payment')); assert.equal(r.businessFieldValuesFetched, false);
});
test('child schema failure is fail-soft and does not retry introspection', async () => {
  let requests = 0;
  const reader = new JobberReader('fake', tomorrow(), new Budget(), (async () => {
    requests++; return requests === 1 ? response({ data: { __type: { fields: [{ name: 'paymentRecords', type: { kind: 'OBJECT', name: 'PaymentConnection' } }] } } }) : new Response('SECRET', { status: 429 });
  }) as typeof fetch);
  const r = await capabilityProbe(reader); assert.equal(r.available, true); assert.equal(r.childSchemaComplete, false); assert.equal(requests, 2); assert.doesNotMatch(JSON.stringify(r), /SECRET/);
});

test('schema traversal obeys twelve-request bound and supports union nodes', async () => {
  let calls = 0;
  const obj = (name: string) => ({ kind: 'OBJECT', name });
  const reader = new JobberReader('fake', tomorrow(), new Budget(), (async (_url, init) => {
    calls++; const name = JSON.parse(init?.body as string).variables.typeName;
    const type = name === 'Invoice' ? { fields: [{ name: 'paymentRecords', type: obj('Connection') }] } :
      name === 'Connection' ? { fields: [{ name: 'nodes', type: { kind: 'UNION', name: 'PaymentUnion' } }] } :
      { kind: 'UNION', fields: null, possibleTypes: [obj(`${name}A`), obj(`${name}B`)] };
    return response({ data: { __type: type } });
  }) as typeof fetch);
  const r = await capabilityProbe(reader); assert.equal(calls, 12); assert.equal(r.childSchemaComplete, false); assert.equal(r.childReason, 'PROBE_REQUEST_LIMIT');
});

test('unresolved required schema references never claim complete child discovery', async () => {
  for (const atRoot of [true, false]) {
    let wrapped: Record<string, unknown> = { kind: 'OBJECT', name: 'Payment' };
    for (let n = 0; n < 7; n++) wrapped = { kind: 'NON_NULL', ofType: wrapped };
    const reader = new JobberReader('fake', tomorrow(), new Budget(), (async (_url, init) => {
      const name = JSON.parse(init?.body as string).variables.typeName;
      return response({ data: { __type: { fields: name === 'Invoice' ? [{ name: 'paymentRecords', type: atRoot ? wrapped : { kind: 'OBJECT', name: 'Connection' } }] : [{ name: 'nodes', type: wrapped }] } } });
    }) as typeof fetch);
    const r = await capabilityProbe(reader); assert.equal(r.childSchemaComplete, false); assert.equal(r.unresolvedRequiredType, true); assert.equal(r.childReason, 'SCHEMA_METADATA_INCOMPLETE');
  }
});
test('root argument truncation makes schema discovery explicitly incomplete', async () => {
  const reader = new JobberReader('fake', tomorrow(), new Budget(), (async () => response({ data: { __type: { fields: [{ name: 'invoiceNet', type: { kind: 'SCALAR', name: 'Int' }, args: Array.from({ length: 21 }, (_, i) => ({ name: `arg${i}`, type: { kind: 'SCALAR', name: 'Int' } })) }] } } })) as typeof fetch);
  const r = await capabilityProbe(reader); assert.equal(r.fields[0].args.length, 20); assert.equal(r.rootSchemaIncomplete, true); assert.equal(r.childSchemaComplete, false); assert.equal(r.childReason, 'SCHEMA_METADATA_INCOMPLETE');
});
