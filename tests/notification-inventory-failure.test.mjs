import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const pick = (module, name) => module[name] ?? module.default?.[name];
const inventory = await import("../lib/notification-inventory.ts");
const classify = pick(inventory, "notificationInventoryFailure");
const readInventory = pick(inventory, "readNotificationInventory");
const inspectInventory = pick(inventory, "inspectNotificationInventory");
const queryText = pick(inventory, "NOTIFICATION_INVENTORY_QUERY");
const core = await import("../scripts/source-audit/core.ts");
const AuditFailure = pick(core, "AuditFailure");
const coordinator = pick(await import("../lib/notification-recurring-coordinator.ts"), "createRecurringNotificationCoordinator");
const sentinel = "PRIVATE_SENTINEL_NOT_FOR_OUTPUT";
const unknown = { code: "INVENTORY_UNEXPECTED_FAILURE", facts: {} };

for (const code of ["SOURCE_PAGE_LIMIT", "SOURCE_RECORD_LIMIT", "SOURCE_CONNECTION_MISSING",
  "SOURCE_PAGE_MALFORMED", "SOURCE_PAGE_OVERSIZE", "SOURCE_EMPTY_CONTINUATION", "SOURCE_CURSOR_MISSING",
  "SOURCE_EMPTY_CURSOR_INVALID", "SOURCE_CURSOR_REPEATED", "INVALID_SOURCE_INVOICE_ID", "SOURCE_ID_REPEATED",
  "RUN_TIME_LIMIT", "EXISTING_TOKEN_EXPIRED_OR_NEAR_EXPIRY", "EXISTING_TOKEN_INSUFFICIENT_RUN_COVERAGE",
  "RESPONSE_BYTE_LIMIT", "EMPTY_RESPONSE_BODY", "INVALID_JSON_RESPONSE", "NON_READ_QUERY_REJECTED",
  "PROBE_TIME_LIMIT", "EXISTING_CONNECTION_AUTHORIZATION_FAILED", "SOURCE_HTTP_ERROR",
  "SOURCE_RESPONSE_MALFORMED", "SOURCE_ERRORS_MALFORMED", "SOURCE_GRAPHQL_ERROR", "SOURCE_DATA_MISSING",
  "SOURCE_REQUEST_TIMEOUT", "SOURCE_NETWORK_ERROR", "SOURCE_RETRIES_EXHAUSTED",
  "SOURCE_RATE_LIMIT_METADATA_INVALID", "SOURCE_RATE_LIMIT_UNRECOVERABLE", "SOURCE_RATE_LIMIT_SCOPE_INVALID",
  "INVENTORY_SCOPE_OR_DEADLINE", "INVENTORY_ACCOUNT_CHANGED"])
  test(`inventory diagnostic retains allowlisted ${code}`, () => {
    assert.deepEqual(classify(new AuditFailure(code)), { code, facts: {} });
  });

test("inventory diagnostic copies only finite numeric/boolean own allowlisted facts, never text or accessors", () => {
  let accesses = 0;
  const raw = { pages: 165, invoices: true, bytes: NaN, httpStatus: 403, expiryRemainingMinutes: -1,
    requiredMinutes: Infinity, graphqlErrorCount: sentinel, [sentinel]: 123, headers: { Authorization: sentinel } };
  const failure = new AuditFailure("SOURCE_HTTP_ERROR", raw);
  for (const key of ["message", "stack", "cause", "response", "headers", "toJSON"])
    Object.defineProperty(failure, key, { get() { accesses++; throw Error(sentinel); } });
  Object.defineProperty(raw, "requiredMinutes", { get() { accesses++; throw Error(sentinel); } });
  const result = classify(failure);
  assert.deepEqual(result, { code: "SOURCE_HTTP_ERROR", facts: { pages: 165, invoices: true, httpStatus: 403, expiryRemainingMinutes: -1 } });
  assert.equal(accesses, 0); assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.facts));
  raw.pages = 999; assert.equal(result.facts.pages, 165); assert.equal(JSON.stringify(result).includes(sentinel), false);
  for (const value of [NaN, Infinity, -Infinity, "123", null, {}, [], 3n])
    assert.deepEqual(classify(new AuditFailure("SOURCE_PAGE_LIMIT", { pages: value })).facts, {});
  const inherited = Object.create({ pages: 123 }); inherited.bytes = 4;
  assert.deepEqual(classify(new AuditFailure("SOURCE_PAGE_LIMIT", inherited)).facts, { bytes: 4 });
});

test("inventory diagnostic rejects arbitrary errors, unknown codes, inherited fields and hostile accessors/proxies", () => {
  let accesses = 0;
  for (const error of [null, sentinel, { name: "AuditFailure", code: "SOURCE_HTTP_ERROR", facts: {} }, new Error(sentinel),
    new AuditFailure(sentinel), new AuditFailure("CACHE_ID_INVALID"),
    ...[null, "private", [], 9].map(facts => new AuditFailure("SOURCE_HTTP_ERROR", facts))])
    assert.deepEqual(classify(error), unknown);
  for (const key of ["name", "code", "facts"]) {
    const accessor = new AuditFailure("SOURCE_HTTP_ERROR");
    Object.defineProperty(accessor, key, { get() { accesses++; throw Error(sentinel); } });
    assert.deepEqual(classify(accessor), unknown);
    const inherited = new AuditFailure("SOURCE_HTTP_ERROR"), value = inherited[key];
    delete inherited[key]; Object.setPrototypeOf(inherited, { [key]: value });
    assert.deepEqual(classify(inherited), unknown);
  }
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { accesses++; throw Error(sentinel); } });
  assert.deepEqual(classify(new AuditFailure("SOURCE_HTTP_ERROR", proxy)), unknown);
  assert.deepEqual(classify(new Proxy(new AuditFailure("SOURCE_HTTP_ERROR"), {
    getOwnPropertyDescriptor() { accesses++; throw Error(sentinel); },
  })), unknown);
  assert.equal(accesses, 0);
});

const json = payload => new Response(JSON.stringify(payload), { status: 200 });
const firstPage = () => json({ extensions: { cost: { requestedQueryCost: 1000, actualQueryCost: 1000, throttleStatus: { maximumAvailable: 10000, currentlyAvailable: 9000, restoreRate: 500 } } }, data: { account: { id: "synthetic-account" }, invoices: {
  nodes: [{ id: sentinel, invoiceNumber: sentinel, invoiceStatus: "paid", amounts: { total: 100, invoiceBalance: 0 },
    issuedDate: "2026-10-01", dueDate: "2026-10-31", client: { id: sentinel } }],
  pageInfo: { hasNextPage: true, endCursor: sentinel },
} } });
const request = () => ({ version: 1, accountId: "synthetic-account", locationId: "synthetic-location",
  reviewRef: "synthetic-review", expiresAt: new Date(Date.now() + 900_000).toISOString() });
const cases = [
  ["HTTP 401", () => new Response(sentinel, { status: 401 }), "EXISTING_CONNECTION_AUTHORIZATION_FAILED", { httpStatus: 401 }],
  ["HTTP 400", () => new Response(sentinel, { status: 400 }), "SOURCE_HTTP_ERROR", { httpStatus: 400 }],
  ["HTTP 429", () => new Response(sentinel, { status: 429 }), "SOURCE_RETRIES_EXHAUSTED", {}],
  ["HTTP 503", () => new Response(sentinel, { status: 503 }), "SOURCE_RETRIES_EXHAUSTED", {}],
  ["all GraphQL THROTTLED without metadata", () => json({ errors: [{ message: sentinel, extensions: { code: "THROTTLED" } }] }), "SOURCE_RATE_LIMIT_METADATA_INVALID", {}],
  ["GraphQL error", () => json({ errors: [{ message: sentinel, extensions: { code: sentinel } }] }), "SOURCE_GRAPHQL_ERROR", { graphqlErrorCount: 1 }],
  ["invalid JSON", () => new Response(sentinel), "INVALID_JSON_RESPONSE", {}],
  ["network error", () => { throw new Error(sentinel); }, "SOURCE_NETWORK_ERROR", {}],
];
for (const [label, response, code, facts] of cases) test(`mixed loader graphs: real reader ${label} stays partial-held with no rows, retry, or private data`, async () => {
  const { register } = createRequire(import.meta.url)("tsx/cjs/api");
  const registered = register({ namespace: `inventory-failure-${label.replace(/\W/g, "")}` });
  try {
    const transport = registered.require(fileURLToPath(new URL("../scripts/source-audit/transport.ts", import.meta.url)), import.meta.url);
    let calls = 0, thrown;
    const expiry = new Date(Date.now() + 3_600_000), budget = new transport.Budget();
    budget.pause = () => { throw Error("no retry or pacing change allowed"); };
    const reader = new transport.JobberReader(sentinel, expiry, budget, async (input, init) => {
      assert.equal(input, pick(core, "JOBBER_ENDPOINT")); assert.equal(init.method, "POST"); assert.equal(init.redirect, "error");
      const body = JSON.parse(init.body); assert.equal(body.query, queryText);
      assert.deepEqual(body.variables, { after: calls === 0 ? null : sentinel });
      return ++calls === 1 ? firstPage() : response();
    });
    const io = { locationId: () => "synthetic-location", tokenExpiresAt: () => expiry,
      query: async (q, variables, options) => {
        assert.equal(options.maxAttempts, 3); assert.equal(options.notificationReadRateLimit, true); assert.ok(Number.isFinite(options.deadlineAt));
        try { return await reader.query(q, variables, options); } catch (error) { thrown = error; throw error; }
      } };
    const result = inspectInventory(await readInventory(request(), io));
    assert.ok(thrown); assert.equal(thrown instanceof AuditFailure, false, "regression must use different constructors");
    assert.equal(result.coverage, "partial-held"); assert.equal(result.terminalPageObserved, false);
    assert.equal(result.pages, 1); assert.equal(result.invoiceCount, 0); assert.deepEqual(result.rows, []);
    assert.deepEqual(result.holds, ["account_invoice_inventory_incomplete_or_unverified"]);
    assert.equal(result.failure.code, code);
    for (const [key, value] of Object.entries(facts)) assert.equal(result.failure.facts[key], value);
    assert.equal(calls, 2); assert.equal(budget.requests, 2); assert.equal(budget.retries, 0);
    assert.equal(result.identityVerified, false); assert.equal(result.productionSendCapability, false);
    assert.equal(JSON.stringify(result).includes(sentinel), false); assert.equal("retryableCause" in result.failure, false);
    assert.ok(Object.isFrozen(result.failure)); assert.ok(Object.isFrozen(result.failure.facts));
  } finally { registered.unregister(); }
});

test("read-only coordinator preserves cross-module typed inventory failure and publishes no partial work", async () => {
  const { register } = createRequire(import.meta.url)("tsx/cjs/api");
  const registered = register({ namespace: "inventory-coordinator-failure" });
  try {
    const other = registered.require(fileURLToPath(new URL("../scripts/source-audit/core.ts", import.meta.url)), import.meta.url);
    const failure = new other.AuditFailure("SOURCE_HTTP_ERROR", { httpStatus: 400, bytes: 123, message: sentinel });
    assert.equal(failure instanceof AuditFailure, false);
    let calls = 0, forbiddenCalls = 0;
    const forbidden = () => { forbiddenCalls++; throw Error("must not read downstream sources"); };
    const scope = request();
    scope.identityCoveragePolicy = { accountId: scope.accountId, reviewRef: "synthetic-policy",
      reviewedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: scope.expiresAt,
      quarantine: ["synthetic-a", "synthetic-b"].map(jobberClientId => ({ jobberClientId, email: null, phone: null })) };
    const result = await coordinator({ mode: "read-only", scope, runtime: async () => ({
      accountId: scope.accountId, locationId: scope.locationId, verifyActiveHolds() {},
      inventoryIO: { locationId: () => scope.locationId, tokenExpiresAt: () => new Date(Date.now() + 900_000),
        query: async () => { if (++calls === 1) return (await firstPage().json()).data; throw failure; } },
      sourceIO: Object.fromEntries(["locationId", "customers", "contacts", "customer", "contact", "storedInvoices", "quarantineCounts", "query"].map(key => [key, forbidden])),
      contact: { accountId: scope.accountId, locationId: scope.locationId, credential: sentinel, scopes: ["contacts.readonly"], fetch: forbidden },
      history: { accountId: scope.accountId, locationId: scope.locationId, get: forbidden, select: forbidden },
    }) }).run();
    assert.equal(result.state, "held"); assert.equal(result.inventory.coverage, "partial-held"); assert.equal(result.inventory.pages, 1);
    assert.equal(result.inventory.invoices, 0); assert.deepEqual(result.invoices, []); assert.deepEqual(result.internalDigests, []);
    assert.deepEqual(result.inventory.failure, { code: "SOURCE_HTTP_ERROR", facts: { bytes: 123, httpStatus: 400 } });
    assert.deepEqual(result.holds, ["account_invoice_inventory_incomplete_or_unverified"]);
    assert.equal(calls, 2); assert.equal(forbiddenCalls, 0); assert.equal(result.attempts, 0); assert.equal(result.reservationsCreated, 0);
    assert.equal(result.sendCapable, false); assert.equal(result.rolloutReady, false); assert.equal(result.messagePolicyAdmission, "not_evaluated");
    for (const text of [sentinel, scope.accountId, scope.locationId, scope.reviewRef]) assert.equal(JSON.stringify(result).includes(text), false);
  } finally { registered.unregister(); }
});

test("mixed loader graphs retain exhausted numeric cost metadata without publishing throttle response data", async () => {
  const { register } = createRequire(import.meta.url)("tsx/cjs/api");
  const registered = register({ namespace: "inventory-rate-failure" }), real = Date.now;
  let now = real(); Date.now = () => now;
  try {
    const transport = registered.require(fileURLToPath(new URL("../scripts/source-audit/transport.ts", import.meta.url)), import.meta.url);
    const expiry = new Date(now + 900000), budget = new transport.Budget();
    budget.pause = async ms => { now += ms; };
    let calls = 0, failure;
    const reader = new transport.JobberReader(sentinel, expiry, budget, async () => ++calls === 1 ? firstPage() : json({
      data: { private: sentinel }, errors: [{ message: sentinel, extensions: { code: "THROTTLED" } }],
      extensions: { cost: { requestedQueryCost: 357, actualQueryCost: 0,
        throttleStatus: { maximumAvailable: 10000, currentlyAvailable: 0, restoreRate: 500 } } },
    }));
    const result = inspectInventory(await readInventory(request(), { locationId: () => "synthetic-location", tokenExpiresAt: () => expiry,
      query: async (...args) => { try { return await reader.query(...args); } catch (e) { failure = e; throw e; } } }));
    assert.equal(failure instanceof AuditFailure, false); assert.equal(calls, 4); assert.equal(budget.retries, 2);
    assert.equal(result.coverage, "partial-held"); assert.equal(result.pages, 1); assert.deepEqual(result.rows, []);
    assert.deepEqual(result.failure, { code: "SOURCE_RETRIES_EXHAUSTED", facts: { requestedQueryCost: 357, actualQueryCost: 0,
      maximumAvailable: 10000, currentlyAvailable: 0, restoreRate: 500, attempts: 3 } });
    assert.equal(JSON.stringify(result).includes(sentinel), false);
  } finally { Date.now = real; registered.unregister(); }
});
