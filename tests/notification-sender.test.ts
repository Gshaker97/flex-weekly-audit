import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createNotificationSenderReader, inspectNotificationSender, NOTIFICATION_SENDER_CONTRACT,
  type NotificationSenderBinding, type NotificationSenderFetch, type NotificationSenderHandle,
  type NotificationSenderOptions } from "../lib/notification-sender";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const EXPECTED: NotificationSenderBinding = { accountId: "synthetic-account", locationId: "synthetic-location", expectedNumber: "+16025550122" };
const EXPECTED_URL = "https://services.leadconnectorhq.com/phone-system/numbers/location/synthetic-location?page=0&pageSize=100&skipNumberPool=false";
const TOKEN = "synthetic-fake-token";
/** All identities and values are synthetic. Shape combines public docs and the sanitized observed projection. */
function body(): any {
  return { status: "success", statusCode: 200, message: "OK", data: {
    numbers: [{ phoneNumber: EXPECTED.expectedNumber, isDefaultNumber: true,
      capabilities: { fax: false, mms: true, sms: true, voice: true } }],
    page: 0, pageSize: 100, accountStatus: "active", isUnderLc: true,
  } };
}
type Response = Awaited<ReturnType<NotificationSenderFetch>>;
function bytesResponse(chunks: Uint8Array[], patch: Partial<Response> = {}): Response {
  return { status: 200, url: EXPECTED_URL, redirected: false,
    body: new ReadableStream<Uint8Array>({ start(controller) {
      for (const bytes of chunks) controller.enqueue(bytes);
      controller.close();
    } }), ...patch };
}
const response = (value: unknown = body(), patch: Partial<Response> = {}) =>
  bytesResponse([new TextEncoder().encode(JSON.stringify(value))], patch);
function setup(fetch: NotificationSenderFetch = async () => response(), patch: Partial<NotificationSenderOptions> = {}) {
  let current = NOW, calls = 0;
  const options: NotificationSenderOptions = { fetch: async (url, init) => { calls++; return fetch(url, init); },
    credential: TOKEN, accountId: EXPECTED.accountId, locationId: EXPECTED.locationId,
    scopes: ["phonenumbers.read"], now: () => new Date(current), ...patch };
  const reader = createNotificationSenderReader(options);
  return { reader, options, calls: () => calls, clock: (at: number) => { current = at; } };
}
async function observed(ctx = setup()) {
  const result = await ctx.reader.read(EXPECTED);
  assert.equal(result.state, "observed"); assert.ok(result.handle);
  const facts = inspectNotificationSender(result.handle); assert.ok(facts);
  return { result, facts, handle: result.handle, ctx };
}

test("factory is inert; one explicit GET pins host/path/query/version/headers and refuses redirects", async () => {
  let seen = false;
  const ctx = setup(async (url, init) => {
    seen = true;
    assert.equal(url, EXPECTED_URL); assert.equal(init.method, "GET"); assert.equal(init.redirect, "error");
    assert.deepEqual(init.headers, { Authorization: `Bearer ${TOKEN}`, Version: "v3", Accept: "application/json" });
    assert.ok(init.signal instanceof AbortSignal); assert.equal(init.signal.aborted, false);
    assert.equal("body" in init, false); assert.ok(Object.isFrozen(init.headers));
    return response();
  });
  assert.equal(seen, false); assert.equal(ctx.calls(), 0);
  await observed(ctx); assert.equal(ctx.calls(), 1);
});
test("exact sender fact is opaque and immutable; absent echoes, totals and compliance remain unknown", async () => {
  const { result, handle, facts } = await observed();
  assert.equal(JSON.stringify(handle), "{}"); assert.equal(JSON.stringify(result).includes(EXPECTED.expectedNumber), false);
  assert.equal(JSON.stringify(result).includes(TOKEN), false); assert.ok(Object.isFrozen(handle)); assert.ok(Object.isFrozen(facts));
  assert.ok(Object.isFrozen(facts.capabilities)); assert.ok(Object.isFrozen(result.reasons));
  assert.equal(facts.accountId, EXPECTED.accountId); assert.equal(facts.locationId, EXPECTED.locationId);
  assert.equal(facts.expectedNumber, EXPECTED.expectedNumber); assert.equal(facts.accountBinding, "caller-supplied");
  assert.equal(facts.locationBinding, "request-path"); assert.equal(facts.responseLocationId, null); assert.equal(facts.numberLocationId, null);
  assert.equal(facts.total, null); assert.equal(facts.inventoryComplete, null); assert.equal(facts.globalUniquenessVerified, false);
  assert.equal(facts.returnedEntries, 1); assert.equal(facts.matchingEntriesInPage, 1);
  assert.deepEqual(facts.capabilities, { sms: true, mms: true, voice: true, fax: false });
  assert.equal(facts.accountStatus, "active"); assert.equal(facts.isUnderLc, true); assert.equal(facts.isDefaultNumber, true);
  for (const key of ["senderApproved", "writeScopeVerified", "deliveryVerified", "consentVerified", "productionSendCapability"] as const)
    assert.equal(facts[key], false);
  assert.equal(facts.a2pRegistration, null); assert.equal(result.productionSendCapability, false);
});
test("observation starts before IO, expires at sixty seconds, and cannot be reissued by inspection", async () => {
  const ctx = setup(async () => { ctx.clock(NOW + 7000); return response(); });
  const { handle, facts } = await observed(ctx);
  assert.equal(facts.observedAt, new Date(NOW).toISOString());
  assert.equal(facts.expiresAt, new Date(NOW + 60_000).toISOString());
  ctx.clock(NOW + 59_999); assert.equal(inspectNotificationSender(handle), facts);
  ctx.clock(NOW + 60_000); assert.equal(inspectNotificationSender(handle), null);
  ctx.clock(NOW + 1000); assert.equal(inspectNotificationSender(handle), null);
});
test("copied, serialized, forged and null handles cannot supply sender facts", async () => {
  const { handle } = await observed();
  for (const fake of [{ ...handle }, JSON.parse(JSON.stringify(handle)), {}, null, 1, "handle"])
    assert.equal(inspectNotificationSender(fake as NotificationSenderHandle), null);
});
test("scope and exact account/location/number are checked before any read", async () => {
  for (const scopes of [[], ["conversations/message.write"], ["phonenumbers.write"], ["PHONENUMBERS.READ"]]) {
    const ctx = setup(undefined, { scopes });
    assert.equal((await ctx.reader.read(EXPECTED)).state, "held"); assert.equal(ctx.calls(), 0);
  }
  const ctx = setup();
  for (const patch of [{ accountId: "other" }, { locationId: "other" }, { expectedNumber: "6025550122" },
    { expectedNumber: "+1 6025550122" }, { expectedNumber: "" }, { expectedNumber: "+10000000000" }, { locationId: "../other" }])
    assert.equal((await ctx.reader.read({ ...EXPECTED, ...patch })).state, "held");
  assert.equal(ctx.calls(), 0);
});
test("opaque caller account IDs are exact bindings and are not URL identifiers", async () => {
  const accountId = "gid://Synthetic/Account/123==", ctx = setup(undefined, { accountId });
  const result = await ctx.reader.read({ ...EXPECTED, accountId });
  assert.ok(result.handle); assert.equal(inspectNotificationSender(result.handle)?.accountId, accountId);
  assert.equal(ctx.calls(), 1);
});
test("invalid factory configuration throws sanitized errors without IO or clock access", () => {
  let calls = 0;
  const base: NotificationSenderOptions = { fetch: async () => { calls++; return response(); }, credential: TOKEN,
    accountId: EXPECTED.accountId, locationId: EXPECTED.locationId, scopes: ["phonenumbers.read"],
    now: () => { calls++; throw new Error(TOKEN); } };
  for (const patch of [{ credential: "" }, { credential: TOKEN + "\r\nsecret" }, { credential: "x".repeat(8193) },
    { locationId: "../secret" }, { accountId: "" }, { accountId: "bad\naccount" }, { timeoutMs: 0 }, { timeoutMs: 30_001 }, { timeoutMs: NaN },
    { fetch: undefined }, { now: undefined }, { scopes: null }, { scopes: [1] }])
    assert.throws(() => createNotificationSenderReader({ ...base, ...patch } as NotificationSenderOptions),
      { message: "invalid_sender_reader_configuration" });
  const accessor = Object.defineProperty({}, "credential", { get() { calls++; throw new Error(TOKEN); } });
  assert.throws(() => createNotificationSenderReader(accessor as NotificationSenderOptions), { message: "invalid_sender_reader_configuration" });
  assert.equal(calls, 0);
});
test("configuration and expected bindings are snapshotted before asynchronous IO", async () => {
  let resolve!: (value: Response) => void;
  const ctx = setup(() => new Promise<Response>(r => { resolve = r; }));
  const request = { ...EXPECTED };
  const work = ctx.reader.read(request);
  request.expectedNumber = "+16025550199"; request.locationId = "other";
  (ctx.options.scopes as string[]).length = 0;
  (ctx.options as any).credential = "changed"; (ctx.options as any).locationId = "changed";
  resolve(response());
  const result = await work; assert.ok(result.handle);
  assert.equal(inspectNotificationSender(result.handle)?.expectedNumber, EXPECTED.expectedNumber);
  assert.equal(inspectNotificationSender(result.handle)?.locationId, EXPECTED.locationId);
});
test("documented envelope and observed page/account schema are required without alternate aliases", async () => {
  const variants = [null, [], {}, body().data, { data: body().data }, { ...body(), status: "failed" },
    { ...body(), statusCode: 201 }, { ...body(), message: undefined }, { ...body(), data: [] }];
  for (const change of [
    (b: any) => { delete b.data.numbers; }, (b: any) => { b.data.numbers = {}; },
    (b: any) => { delete b.data.page; }, (b: any) => { b.data.page = 1; },
    (b: any) => { b.data.pageSize = 50; }, (b: any) => { b.data.pageSize = "100"; },
    (b: any) => { delete b.data.accountStatus; }, (b: any) => { b.data.accountStatus = "suspended"; },
    (b: any) => { b.data.accountStatus = "ACTIVE"; }, (b: any) => { b.data.numbers = Array(101).fill(b.data.numbers[0]); },
  ]) { const b = body(); change(b); variants.push(b); }
  for (const variant of variants) {
    const ctx = setup(async () => response(variant));
    assert.equal((await ctx.reader.read(EXPECTED)).state, "held"); assert.equal(ctx.calls(), 1);
  }
});
test("only the exact number is selected, never a default, owner, forwarding number or alias", async () => {
  for (const entry of [null, {}, { number: EXPECTED.expectedNumber },
    { phoneNumber: "602-555-0122", capabilities: { sms: true } },
    { phoneNumber: "+16025550199", isDefaultNumber: true, forwardingNumber: EXPECTED.expectedNumber, linkedUser: EXPECTED.expectedNumber, capabilities: { sms: true } }]) {
    const b = body(); b.data.numbers = [entry];
    assert.equal((await setup(async () => response(b)).reader.read(EXPECTED)).state, "held");
  }
  const b = body(); b.data.numbers[0].isDefaultNumber = false;
  b.data.numbers.push({ phoneNumber: "+16025550199", isDefaultNumber: true });
  const { facts } = await observed(setup(async () => response(b)));
  assert.equal(facts.expectedNumber, EXPECTED.expectedNumber); assert.equal(facts.isDefaultNumber, false);
});
test("duplicate matching rows and malformed rows cannot hide ambiguous identity", async () => {
  for (const other of [body().data.numbers[0], { ...body().data.numbers[0], capabilities: { sms: false } },
    null, {}, { phoneNumber: "bad" }]) {
    const b = body(); b.data.numbers.push(other);
    assert.equal((await setup(async () => response(b)).reader.read(EXPECTED)).state, "held");
  }
});
test("SMS must be an exact true boolean; other capabilities do not substitute", async () => {
  for (const capabilities of [undefined, null, {}, { SMS: true }, { sms: "true" }, { sms: 1 },
    { sms: false, mms: true, voice: true }, { sms: true, fax: "false" }]) {
    const b = body(); b.data.numbers[0].capabilities = capabilities;
    assert.equal((await setup(async () => response(b)).reader.read(EXPECTED)).state, "held");
  }
  const b = body(); b.data.numbers[0].capabilities = { sms: true };
  delete b.data.isUnderLc; delete b.data.numbers[0].isDefaultNumber;
  const { facts } = await observed(setup(async () => response(b)));
  assert.deepEqual(facts.capabilities, { sms: true, mms: null, voice: null, fax: null });
  assert.equal(facts.isUnderLc, null); assert.equal(facts.isDefaultNumber, null);
});
test("optional location echoes and totals are exact when present, absence is not fabricated", async () => {
  for (const patch of [{ locationId: "other" }, { locationId: null }, { total: 0 }, { total: -1 },
    { total: 1.5 }, { total: "1" }, { total: null }, { isUnderLc: "true" }]) {
    const b = body(); Object.assign(b.data, patch);
    assert.equal((await setup(async () => response(b)).reader.read(EXPECTED)).state, "held");
  }
  const wrong = body(); wrong.data.numbers[0].locationId = "other";
  assert.equal((await setup(async () => response(wrong)).reader.read(EXPECTED)).state, "held");
  for (const total of [1, 1000]) {
    const b = body(); b.data.locationId = EXPECTED.locationId; b.data.numbers[0].locationId = EXPECTED.locationId; b.data.total = total;
    const ctx = setup(async () => response(b)); const { facts } = await observed(ctx);
    assert.equal(facts.responseLocationId, EXPECTED.locationId); assert.equal(facts.numberLocationId, EXPECTED.locationId);
    assert.equal(facts.total, total); assert.equal(facts.inventoryComplete, null); assert.equal(ctx.calls(), 1);
  }
});
test("provider extras cannot manufacture approval, compliance, consent or write scope", async () => {
  const b = body(); Object.assign(b.data, { a2pApproved: true, scopes: ["conversations/message.write"], approved: true, consent: true });
  const { facts } = await observed(setup(async () => response(b)));
  assert.equal(facts.a2pRegistration, null); assert.equal(facts.writeScopeVerified, false);
  assert.equal(facts.senderApproved, false); assert.equal(facts.consentVerified, false);
});
test("non-200 and redirects, including client-followed redirects, hold without retry", async () => {
  for (const patch of [{ status: 201 }, { status: 204 }, { status: 301 }, { status: 401 }, { status: 403 },
    { status: 429 }, { status: 500 }, { status: NaN }, { redirected: true }, { redirected: undefined },
    { url: "https://example.invalid/" }, { url: "" }, { body: null }]) {
    const ctx = setup(async () => response(body(), patch as Partial<Response>));
    assert.equal((await ctx.reader.read(EXPECTED)).state, "held"); assert.equal(ctx.calls(), 1);
  }
});
test("transport and parser exceptions are sanitized, never logged or exposed", async () => {
  for (const fetch of [async () => { throw new Error(TOKEN + EXPECTED.expectedNumber); },
    async () => bytesResponse([new TextEncoder().encode('{"secret":"' + TOKEN + '"')]),
    async () => ({ ...response(), body: { getReader() { throw new Error(TOKEN); } } })] as NotificationSenderFetch[]) {
    const ctx = setup(fetch), result = await ctx.reader.read(EXPECTED);
    assert.equal(result.state, "held"); assert.equal(ctx.calls(), 1);
    assert.equal(JSON.stringify(result).includes(TOKEN), false); assert.equal(JSON.stringify(result).includes(EXPECTED.expectedNumber), false);
  }
});
test("UTF-8 supports split multibyte sequences but rejects malformed and truncated bytes", async () => {
  const b = body(); b.message = "Synthetic ✓";
  const bytes = new TextEncoder().encode(JSON.stringify(b));
  await observed(setup(async () => bytesResponse(Array.from(bytes, byte => new Uint8Array([byte])))));
  for (const bytes of [new Uint8Array([0xff]), new Uint8Array([0xc0, 0xaf]), new Uint8Array([0xe2, 0x82])]) {
    const ctx = setup(async () => bytesResponse([bytes]));
    assert.equal((await ctx.reader.read(EXPECTED)).state, "held"); assert.equal(ctx.calls(), 1);
  }
});
test("oversize streams, too many chunks and empty chunks hold and cancel", async () => {
  for (const chunks of [[new Uint8Array(NOTIFICATION_SENDER_CONTRACT.responseBytes + 1)],
    Array.from({ length: NOTIFICATION_SENDER_CONTRACT.responseChunks + 1 }, () => new Uint8Array([32])),
    [new Uint8Array()]]) {
    let canceled = 0, signal: AbortSignal | undefined, reads = 0;
    const ctx = setup(async (_url, init) => { signal = init.signal;
      return { status: 200, url: EXPECTED_URL, redirected: false, body: { getReader: () => ({
        read: async () => reads < chunks.length ? { done: false, value: chunks[reads++] } : { done: true },
        cancel: async () => { canceled++; },
      }) } };
    });
    assert.equal((await ctx.reader.read(EXPECTED)).state, "held");
    assert.ok(canceled > 0); assert.equal(signal!.aborted, true); assert.equal(ctx.calls(), 1);
  }
});
test("invalid stream terminal records and reads hold, even with otherwise valid JSON", async () => {
  for (const chunk of [{ done: "true" }, { done: true, value: new Uint8Array([32]) }, { done: false, value: "json" }, undefined]) {
    const ctx = setup(async () => ({ status: 200, url: EXPECTED_URL, redirected: false, body: { getReader: () => ({
      read: async () => chunk as any, cancel: async () => {},
    }) } }));
    assert.equal((await ctx.reader.read(EXPECTED)).state, "held");
  }
});
test("deadline bounds a hanging fetch that ignores cancellation, with no late fact or retry", async () => {
  let resolve!: (r: Response) => void, signal!: AbortSignal;
  const ctx = setup(async (_url, init) => { signal = init.signal; return new Promise(r => { resolve = r; }); }, { timeoutMs: 10 });
  const result = await ctx.reader.read(EXPECTED);
  assert.equal(result.state, "held"); assert.equal(signal.aborted, true); assert.equal(ctx.calls(), 1);
  resolve(response()); await new Promise(r => setTimeout(r, 5));
  assert.equal(result.handle, null); assert.equal(ctx.calls(), 1);
});
test("deadline also bounds hanging streams and cancellation that never settles", async () => {
  let canceled = false, signal!: AbortSignal;
  const ctx = setup(async (_url, init) => { signal = init.signal; return {
    status: 200, url: EXPECTED_URL, redirected: false, body: { getReader: () => ({
      read: () => new Promise(() => {}), cancel: () => { canceled = true; return new Promise(() => {}); },
    }) },
  }; }, { timeoutMs: 10 });
  assert.equal((await ctx.reader.read(EXPECTED)).state, "held");
  assert.equal(canceled, true); assert.equal(signal.aborted, true); assert.equal(ctx.calls(), 1);
});
test("stale or backward clocks during read hold; backward clocks invalidate already-issued facts", async () => {
  for (const next of [NOW - 1, NOW + 60_000, NaN]) {
    const ctx = setup(async () => { ctx.clock(next); return response(); });
    assert.equal((await ctx.reader.read(EXPECTED)).state, "held");
  }
  const { ctx, handle } = await observed(); ctx.clock(NOW + 5000); assert.ok(inspectNotificationSender(handle));
  ctx.clock(NOW + 4000); assert.equal(inspectNotificationSender(handle), null);
  ctx.clock(NOW + 6000); assert.equal(inspectNotificationSender(handle), null);
  const invalid = setup(undefined, { now: () => new Date(NaN) });
  assert.equal((await invalid.reader.read(EXPECTED)).state, "held"); assert.equal(invalid.calls(), 0);
});
test("adapter remains unwired, without ambient credentials, provider mutation or imports", () => {
  const source = readFileSync(new URL("../lib/notification-sender.ts", import.meta.url), "utf8");
  assert.equal(/process\.env|globalThis\.fetch|console\.|method:\s*["'](?:POST|PATCH|PUT|DELETE)/.test(source), false);
  assert.equal(/^import\s/m.test(source), false);
  assert.equal(NOTIFICATION_SENDER_CONTRACT.automaticRetry, false); assert.equal(NOTIFICATION_SENDER_CONTRACT.maximumRequests, 1);
});
