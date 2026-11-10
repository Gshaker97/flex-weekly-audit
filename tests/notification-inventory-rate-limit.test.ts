import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditFailure, INVOICE_QUERY, LIMITS } from '../scripts/source-audit/core';
import { Budget, JobberReader } from '../scripts/source-audit/transport';
import { readNotificationInventory, inspectNotificationInventory, notificationInventoryFailure, NOTIFICATION_INVENTORY_QUERY } from '../lib/notification-inventory';

const NOW = Date.parse('2026-11-10T16:00:00Z');
const secret = 'PRIVATE_ERROR_OR_PARTIAL_ROW';
const json = (value: unknown) => new Response(JSON.stringify(value));
const cost = (available = 9000, requested = 1000, rate = 500, actual: number | null = requested) => ({ cost: {
  requestedQueryCost: requested, actualQueryCost: actual,
  throttleStatus: { maximumAvailable: 10000, currentlyAvailable: available, restoreRate: rate },
} });
const row = (id: string, status = 'paid') => ({ id, invoiceNumber: id, invoiceStatus: status,
  amounts: { total: 100, invoiceBalance: status === 'paid' ? 0 : 100 },
  issuedDate: '2026-10-01', dueDate: '2026-10-31', client: { id: 'owner' } });
const page = (id = 'one', more = false, extensions: unknown = cost(), cursor = id) => ({
  extensions, data: { account: { id: 'account' }, invoices: {
    nodes: [row(id)], pageInfo: { hasNextPage: more, endCursor: cursor },
  } },
});
const throttle = (extensions: unknown = cost(0, 1000, 500, 0)) => ({ extensions,
  errors: [{ message: secret, extensions: { code: 'THROTTLED' } }], data: page(secret).data,
});
type Reply = unknown | (() => unknown);
async function fixture(replies: Reply[], run: (f: ReturnType<typeof setup>) => Promise<void>) {
  const real = Date.now; let now = NOW; Date.now = () => now;
  function setup() {
    const expiry = new Date(NOW + 900000), budget = new Budget(), bodies: string[] = [], sleeps: number[] = [];
    budget.pause = async ms => { budget.check(); sleeps.push(ms); now += ms; budget.check(); };
    const reader = new JobberReader(secret, expiry, budget, async (_url, init) => {
      bodies.push(init!.body as string);
      assert.ok(bodies.length <= replies.length, 'unexpected provider request');
      const next = replies[bodies.length - 1], payload = typeof next === 'function' ? next() : next;
      return payload instanceof Response ? payload : json(payload);
    });
    const request = { version: 1 as const, accountId: 'account', locationId: 'location', reviewRef: 'review',
      expiresAt: new Date(NOW + 300000).toISOString() };
    return { reader, expiry, budget, bodies, sleeps, request, advance: (ms: number) => { now += ms; },
      options: { notificationReadRateLimit: true as const, maxAttempts: 3, deadlineAt: NOW + 300000 },
      scan: async () => inspectNotificationInventory(await readNotificationInventory(request,
        { locationId: () => 'location', tokenExpiresAt: () => expiry, query: reader.query.bind(reader) })),
    };
  }
  try { await run(setup()); } finally { Date.now = real; }
}
function held(result: Awaited<ReturnType<typeof inspectNotificationInventory>>, code: string, pages = 0) {
  assert.equal(result.coverage, 'partial-held'); assert.equal(result.pages, pages);
  assert.equal(result.terminalPageObserved, false); assert.equal(result.invoiceCount, 0); assert.deepEqual(result.rows, []);
  assert.equal(result.failure?.code, code); assert.deepEqual(result.holds, ['account_invoice_inventory_incomplete_or_unverified']);
  assert.equal(result.identityVerified, false); assert.equal(result.productionSendCapability, false);
  assert.equal(JSON.stringify(result).includes(secret), false);
}

test('depleted success bucket paces the next exact page from requested cost, not actual cost', () =>
  fixture([page('one', true, cost(0, 1200, 600, 100)), page('two')], async f => {
    const result = await f.scan();
    assert.equal(result.coverage, 'complete-account-invoices'); assert.equal(result.pages, 2); assert.equal(result.invoiceCount, 2);
    assert.deepEqual(f.sleeps, [2000]); assert.equal(f.budget.retries, 0);
    assert.deepEqual(f.bodies.map(b => JSON.parse(b).variables), [{ after: null }, { after: 'one' }]);
    assert.ok(f.bodies.every(b => JSON.parse(b).query === NOTIFICATION_INVENTORY_QUERY));
  }));
test('THROTTLED then recovery retries identical serialized read/cursor and discards partial error data', () =>
  fixture([throttle(), page('recovered')], async f => {
    const result = await f.scan();
    assert.equal(result.coverage, 'complete-account-invoices'); assert.equal(result.pages, 1);
    assert.deepEqual(result.rows.map(r => r.invoiceId), ['recovered']); assert.deepEqual(f.sleeps, [2000]);
    assert.equal(f.budget.requests, 2); assert.equal(f.budget.retries, 1); assert.equal(f.bodies[0], f.bodies[1]);
  }));
test('repeated GraphQL throttling is bounded to three attempts with numeric-only exhausted diagnostics', () =>
  fixture([page(secret, true), throttle(), throttle(), throttle()], async f => {
    const result = await f.scan(); held(result, 'SOURCE_RETRIES_EXHAUSTED', 1);
    assert.deepEqual(f.sleeps, [2000, 2000]); assert.equal(f.budget.requests, 4); assert.equal(f.budget.retries, 2);
    assert.equal(new Set(f.bodies.slice(1)).size, 1);
    assert.deepEqual(result.failure?.facts, { requestedQueryCost: 1000, actualQueryCost: 0, maximumAvailable: 10000,
      currentlyAvailable: 0, restoreRate: 500, attempts: 3 });
  }));
test('shared consumer drain replaces previous availability with latest throttle metadata', () =>
  fixture([page('one', true, cost(1500)), throttle(cost(100, 1600, 250, 0)), page('two')], async f => {
    const result = await f.scan(); assert.equal(result.invoiceCount, 2); assert.equal(result.terminalPageObserved, true);
    assert.deepEqual(f.sleeps, [6000]); assert.equal(f.budget.retries, 1); assert.equal(f.bodies[1], f.bodies[2]);
  }));
test('shared notification reader learns each query cost and uses latest bucket across query shapes', () =>
  fixture([page('one', false, cost(0, 1000)), throttle(cost(0, 500, 250, 0)),
    page('identity', false, cost(0, 500, 250)), page('two')], async f => {
    await f.reader.query(NOTIFICATION_INVENTORY_QUERY, { after: null }, f.options);
    const source = 'query VerifySyntheticIdentity { account { id } }';
    await f.reader.query(source, {}, f.options); // Unknown cost may throttle once, then becomes known.
    await f.reader.query(NOTIFICATION_INVENTORY_QUERY, { after: 'one' }, f.options);
    assert.deepEqual(f.sleeps, [2000, 4000]); assert.equal(f.budget.retries, 1);
    assert.equal(f.bodies[1], f.bodies[2]); assert.equal(f.budget.requests, 4);
  }));
test('explicit one-attempt notification policy is not silently upgraded by pacing', () =>
  fixture([throttle()], async f => {
    await assert.rejects(f.reader.query(INVOICE_QUERY, { after: null }, { ...f.options, maxAttempts: 1 }),
      (e: any) => e.code === 'SOURCE_RETRIES_EXHAUSTED');
    assert.equal(f.budget.requests, 1); assert.equal(f.budget.retries, 0); assert.deepEqual(f.sleeps, []);
  }));
test('a new source query has its own absolute freshness deadline for cost recovery', () =>
  fixture([page('one', false, cost(0)), throttle(cost(0, 1000, 10, 0))], async f => {
    await f.reader.query(NOTIFICATION_INVENTORY_QUERY, { after: null }, f.options);
    await assert.rejects(f.reader.query('query VerifySyntheticSource { account { id } }', {},
      { ...f.options, deadlineAt: Date.now() + 60000 }), (e: any) => e.code === 'PROBE_TIME_LIMIT');
    assert.equal(f.budget.requests, 2); assert.equal(f.budget.retries, 0); assert.deepEqual(f.sleeps, []);
  }));
test('elapsed refill is credited conservatively from metadata receipt', () =>
  fixture([page('one', true, cost(0)), page('two')], async f => {
    await f.reader.query(NOTIFICATION_INVENTORY_QUERY, { after: null }, f.options);
    f.advance(750);
    await f.reader.query(NOTIFICATION_INVENTORY_QUERY, { after: 'one' }, f.options);
    assert.deepEqual(f.sleeps, [1250]);
  }));
test('zero-deficit throttles are still bounded without guessing a bucket or backoff', () =>
  fixture([throttle(cost(5000, 1000, 500, 0)), throttle(cost(5000, 1000, 500, 0)), throttle(cost(5000, 1000, 500, 0))], async f => {
    held(await f.scan(), 'SOURCE_RETRIES_EXHAUSTED'); assert.equal(f.budget.requests, 3); assert.deepEqual(f.sleeps, []);
  }));

const malformed: [string, unknown][] = [
  ['missing extensions', undefined], ['null cost', { cost: null }], ['missing cost', {}],
  ['missing requested cost', { cost: { actualQueryCost: 0, throttleStatus: cost().cost.throttleStatus } }],
  ['string requested', { cost: { ...cost().cost, requestedQueryCost: '1000' } }],
  ['zero requested', cost(0, 0)], ['negative requested', cost(0, -1)], ['nonfinite requested', cost(0, Infinity)],
  ['missing actual', { cost: { requestedQueryCost: 1000, throttleStatus: cost().cost.throttleStatus } }],
  ['null actual', cost(0, 1000, 500, null)], ['negative actual', cost(0, 1000, 500, -1)], ['actual above requested', cost(0, 1000, 500, 1001)],
  ['negative availability', cost(-1)], ['availability above maximum', cost(10001)],
  ['zero restore', cost(0, 1000, 0)], ['negative restore', cost(0, 1000, -1)],
  ['string restore', { cost: { ...cost().cost, throttleStatus: { ...cost().cost.throttleStatus, restoreRate: '500' } } }],
  ['missing maximum', { cost: { ...cost().cost, throttleStatus: { currentlyAvailable: 0, restoreRate: 500 } } }],
];
for (const [label, extensions] of malformed) test(`unknown cost metadata holds without retry: ${label}`, () =>
  fixture([page(secret, true), { ...throttle(), extensions }], async f => {
    held(await f.scan(), 'SOURCE_RATE_LIMIT_METADATA_INVALID', 1); assert.equal(f.budget.requests, 2);
    assert.equal(f.budget.retries, 0); assert.deepEqual(f.sleeps, []);
  }));
test('successful read missing cost metadata holds before publishing rows', () =>
  fixture([{ data: page(secret).data }], async f => { held(await f.scan(), 'SOURCE_RATE_LIMIT_METADATA_INVALID'); }));
test('successful read with null actual cost holds', () =>
  fixture([page(secret, false, cost(0, 1000, 500, null))], async f => { held(await f.scan(), 'SOURCE_RATE_LIMIT_METADATA_INVALID'); }));
test('requested cost above the reported bucket capacity holds as unrecoverable', () =>
  fixture([throttle(cost(0, 11000, 500, 0))], async f => {
    held(await f.scan(), 'SOURCE_RATE_LIMIT_UNRECOVERABLE'); assert.equal(f.budget.requests, 1); assert.deepEqual(f.sleeps, []);
  }));

for (const status of [400, 401, 403, 429, 500, 503]) test(`inventory does not retry HTTP ${status}`, () =>
  fixture([new Response(secret, { status })], async f => {
    const code = [401, 403].includes(status) ? 'EXISTING_CONNECTION_AUTHORIZATION_FAILED' : status === 429 || status >= 500 ? 'SOURCE_RETRIES_EXHAUSTED' : 'SOURCE_HTTP_ERROR';
    held(await f.scan(), code); assert.equal(f.budget.requests, 1); assert.equal(f.budget.retries, 0); assert.deepEqual(f.sleeps, []);
  }));
for (const errors of [[{ extensions: { code: 'FORBIDDEN' } }],
  [{ extensions: { code: 'THROTTLED' } }, { extensions: { code: 'FORBIDDEN' } }],
  [{ message: 'throttled without recognized code' }]]) test(`non-throttle or mixed GraphQL errors never retry: ${JSON.stringify(errors)}`, () =>
  fixture([{ data: page(secret).data, extensions: cost(), errors }], async f => {
    held(await f.scan(), 'SOURCE_GRAPHQL_ERROR'); assert.equal(f.budget.requests, 1); assert.equal(f.budget.retries, 0);
  }));

test('deadline shorter than required wait holds before sleeping or issuing another read', () =>
  fixture([page(secret, true, cost(0))], async f => {
    f.request.expiresAt = new Date(NOW + 1000).toISOString();
    held(await f.scan(), 'PROBE_TIME_LIMIT', 1); assert.equal(f.budget.requests, 1); assert.deepEqual(f.sleeps, []);
  }));
test('deadline reached during a delayed wait holds without a subsequent read', () =>
  fixture([page(secret, true, cost(0))], async f => {
    f.budget.pause = async ms => { f.sleeps.push(ms); f.advance(300000); };
    held(await f.scan(), 'PROBE_TIME_LIMIT', 1); assert.equal(f.budget.requests, 1); assert.deepEqual(f.sleeps, [2000]);
  }));
test('a logical page wait cannot exceed three existing request windows even with a later global deadline', () =>
  fixture([throttle(cost(0, 1000, 1, 0))], async f => {
    held(await f.scan(), 'PROBE_TIME_LIMIT'); assert.equal(f.budget.requests, 1); assert.deepEqual(f.sleeps, []);
  }));
test('token validity at anticipated wake is checked before sleeping', () =>
  fixture([page(secret, true, cost(0))], async f => {
    const query = f.reader.query.bind(f.reader);
    f.reader.query = async (...args) => { const value = await query(...args); f.expiry.setTime(Date.now() + 31000); return value; };
    held(await f.scan(), 'EXISTING_TOKEN_EXPIRED_OR_NEAR_EXPIRY', 1); assert.equal(f.budget.requests, 1); assert.deepEqual(f.sleeps, []);
  }));
test('token validity is rechecked after a delayed wait', () =>
  fixture([page(secret, true, cost(0))], async f => {
    f.budget.pause = async ms => { f.sleeps.push(ms); f.advance(ms); f.expiry.setTime(Date.now() + 30000); };
    held(await f.scan(), 'EXISTING_TOKEN_EXPIRED_OR_NEAR_EXPIRY', 1); assert.equal(f.budget.requests, 1);
  }));
test('token startup still requires the existing 900-second coverage', () =>
  fixture([], async f => {
    f.expiry.setTime(NOW + 899999);
    await assert.rejects(f.scan(), (e: any) => e.code === 'EXISTING_TOKEN_INSUFFICIENT_RUN_COVERAGE'); assert.equal(f.budget.requests, 0);
  }));
test('late successful response cannot bypass deadline or publish its rows', () =>
  fixture([() => { Date.now = () => NOW + 300000; return page(secret); }], async f => {
    held(await f.scan(), 'PROBE_TIME_LIMIT'); assert.equal(f.budget.requests, 1);
  }));
test('backwards clock during a wait holds instead of manufacturing refill', () =>
  fixture([page(secret, true, cost(0))], async f => {
    f.budget.pause = async () => { f.advance(-1); };
    held(await f.scan(), 'PROBE_TIME_LIMIT', 1); assert.equal(f.budget.requests, 1);
  }));
test('retry payload cannot change if caller mutates its variables during a wait', () =>
  fixture([throttle(), page('one')], async f => {
    const variables = { after: 'original' };
    f.budget.pause = async ms => { variables.after = 'changed'; f.advance(ms); };
    await f.reader.query(NOTIFICATION_INVENTORY_QUERY, variables, f.options);
    assert.equal(f.bodies[0], f.bodies[1]); assert.equal(JSON.parse(f.bodies[1]).variables.after, 'original');
  }));

test('rate mode requires a finite explicit deadline', () =>
  fixture([], async f => {
    for (const [query, deadlineAt] of [[NOTIFICATION_INVENTORY_QUERY, undefined], [NOTIFICATION_INVENTORY_QUERY, Infinity]] as const)
      await assert.rejects(f.reader.query(query, {}, { notificationReadRateLimit: true, deadlineAt }), (e: any) => e.code === 'SOURCE_RATE_LIMIT_SCOPE_INVALID');
    assert.equal(f.budget.requests, 0);
  }));
test('non-opted-in queries retain existing retry count, backoff, and metadata-independent behavior', () =>
  fixture([new Response(secret, { status: 429 }), new Response(secret, { status: 503 }), { data: page().data, extensions: null }], async f => {
    const result = await f.reader.query(INVOICE_QUERY, { after: null });
    assert.deepEqual(result, page().data); assert.deepEqual(f.sleeps, [1500, 3000]); assert.equal(f.budget.retries, 2);
  }));
test('non-opted-in notification exact/source reads remain one-attempt when requested', () =>
  fixture([throttle()], async f => {
    await assert.rejects(f.reader.query(INVOICE_QUERY, {}, { maxAttempts: 1 }), (e: any) => e.code === 'SOURCE_RETRIES_EXHAUSTED');
    assert.equal(f.budget.requests, 1); assert.equal(f.budget.retries, 0); assert.deepEqual(f.sleeps, []);
  }));
test('all response bytes, including throttle responses, retain the original total byte bound', () =>
  fixture([throttle()], async f => {
    f.budget.bytes = LIMITS.maxTotalBytes;
    held(await f.scan(), 'RESPONSE_BYTE_LIMIT'); assert.equal(f.budget.requests, 1); assert.equal(f.budget.retries, 0);
  }));
test('recovery still enforces invoice uniqueness and never publishes preceding pages', () =>
  fixture([page(secret, true), throttle(), page(secret, false, cost(), 'new-cursor')], async f => {
    held(await f.scan(), 'SOURCE_ID_REPEATED', 2); assert.equal(f.budget.requests, 3);
  }));
test('recovery still enforces terminal cursor uniqueness', () =>
  fixture([page('one', true), throttle(), page(secret, false, cost(), 'one')], async f => {
    held(await f.scan(), 'SOURCE_CURSOR_REPEATED', 2);
  }));
test('numeric cost diagnostics reject strings, booleans, inherited values and accessors', () => {
  const facts = Object.assign(Object.create({ currentlyAvailable: 12 }), {
    requestedQueryCost: 1000, actualQueryCost: true, maximumAvailable: '10000', restoreRate: Infinity, attempts: 3,
  });
  Object.defineProperty(facts, 'restoreRate', { get() { throw Error(secret); } });
  assert.deepEqual(notificationInventoryFailure(new AuditFailure('SOURCE_RETRIES_EXHAUSTED', facts)),
    { code: 'SOURCE_RETRIES_EXHAUSTED', facts: { requestedQueryCost: 1000, attempts: 3 } });
});

test('real reader and paginator finish 165 all-status pages against a synthetic documented-cost bucket', async () => {
  let available = 10000, observedAt = NOW;
  const statuses = ['draft', 'sent', 'awaiting_payment', 'past_due', 'paid', 'void', 'bad_debt', 'deleted'];
  const replies = Array.from({ length: 165 }, (_, index) => () => {
    available = Math.min(10000, available + (Date.now() - observedAt) * 500 / 1000);
    assert.ok(available >= 357, 'paced query must have enough reported bucket capacity');
    available -= 357; observedAt = Date.now();
    const result = page(`page-${index}`, index < 164, cost(available, 357), `cursor-${index}`);
    result.data.invoices.nodes = Array.from({ length: 25 }, (_, n) => row(`row-${index * 25 + n}`, statuses[n % statuses.length]));
    return result;
  });
  await fixture(replies, async f => {
    const result = await f.scan();
    assert.equal(result.coverage, 'complete-account-invoices'); assert.equal(result.terminalPageObserved, true);
    assert.equal(result.pages, 165); assert.equal(result.invoiceCount, 4125); assert.equal(f.budget.requests, 165);
    assert.equal(f.budget.retries, 0); assert.ok(f.sleeps.length > 0); assert.ok(Date.now() < NOW + 300000);
    assert.equal(new Set(result.rows.map(r => r.invoiceId)).size, 4125);
    assert.deepEqual(new Set(result.rows.map(r => r.rawStatus)), new Set(statuses));
  });
});
