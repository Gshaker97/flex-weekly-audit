import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { eventKey, type Request } from "../lib/notification-gate";
import { createNotificationLedger, type NotificationLedgerDatabase, type NotificationLedgerTransaction,
  type NotificationReservation } from "../lib/notification-ledger";
import { buildGhlMessageRequest, parseGhlRecipient, inspectGhlPrivateEvidence, type GhlConstructionInput } from "../lib/notification-ghl-contract";
import { createGhlOneAttemptTransport, reviewGhlTransportConstruction, GHL_TRANSPORT_LIMITS,
  type GhlPostFetch, type GhlTransportReview, type GhlReviewedTransportHandle, type GhlTransportOptions } from "../lib/notification-ghl-transport";
import { fixture, BODY, NOW } from "./fixtures/notification-fixture.mjs";

const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
let sequence = 0;
function setup(channel: "sms" | "email" = "sms") {
  const gate: Request = JSON.parse(JSON.stringify(fixture({ channel })).replaceAll("synthetic-invoice", `synthetic-invoice-${++sequence}`));
  const b = { accountId: gate.event.accountId, locationId: "synthetic-location", contactId: gate.event.contactId, channel,
    destination: gate.event.destination, sender: channel === "sms" ? "+12025550124" : "billing@example.invalid",
    invoiceId: gate.event.invoiceId, eventKey: eventKey(gate.event), bodyHash: gate.event.bodyDigest };
  const sender = { accountId: b.accountId, locationId: b.locationId, channel, sender: b.sender,
    approved: true, validated: true, scope: "conversations/message.write", evidenceRef: "synthetic-sender-review" } as const;
  const constructionInput: GhlConstructionInput = { binding: b, body: BODY, contentType: "text/plain",
    ...(channel === "email" ? { subject: "Synthetic invoice reminder" } : {}), senderReview: sender,
    recipient: parseGhlRecipient({ version: "2021-07-28", expected: b, body: { contact: { id: b.contactId,
      locationId: b.locationId, phone: b.channel === "sms" ? b.destination : undefined, email: b.channel === "email" ? b.destination : undefined,
      dnd: false, dndSettings: { SMS: { status: "inactive" }, Email: { status: "inactive" } } } } }),
    review: { mode: "reviewed-construction-only", version: "2021-07-28", accountId: b.accountId,
      locationId: b.locationId, channel, proposedStatus: "pending", evidenceRef: "synthetic-assumption" } };
  const construction = buildGhlMessageRequest(constructionInput);
  assert.equal(construction.state, "constructed_disabled");
  const requestSha256 = hash(construction.request!.serializedBody);
  const review: GhlTransportReview = { mode: "reviewed-one-attempt", event: gate.event, binding: b,
    reviewedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 30_000).toISOString(), sender,
    statusSemantics: { verified: true, version: "2021-07-28", status: "pending", evidenceRef: "synthetic-only-status-review" },
    content: { approved: true, requestSha256, evidenceRef: "synthetic-only-content-review" },
    authorization: { approved: true, timingApproved: true, requestSha256, evidenceRef: "synthetic-only-attempt-approval" } };
  return { gate, binding: b, constructionInput, construction, review };
}
function handle(value: ReturnType<typeof setup>): GhlReviewedTransportHandle {
  const reviewed = reviewGhlTransportConstruction(value.construction, value.review, NOW);
  assert.equal(reviewed.state, "reviewed_candidate"); assert.ok(reviewed.handle); return reviewed.handle;
}
function response(body: unknown = { messageId: "message-1", conversationId: "conversation-1" }, status = 200): Awaited<ReturnType<GhlPostFetch>> {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return { status, body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
}
type Row = { id: string; token: string; eventHash: string; bodyHash: string; destinationHash: string; state: string; providerId?: string };
type Operation = "reserve" | "assert" | "pending" | "outcome";
/** Fake transactions only. Uses the real ledger factory and original opaque ledger capabilities. */
class FakeDatabase implements NotificationLedgerDatabase {
  rows = new Map<string, Row>();
  operations: Operation[] = [];
  fault: { operation: Operation; phase: "before_commit" | "after_commit" } | null = null;
  hook: ((operation: Operation) => Promise<void> | void) | null = null;
  async transaction<T>(work: (tx: NotificationLedgerTransaction) => Promise<T>): Promise<T> {
    let operation: Operation | undefined;
    const draft = new Map([...this.rows].map(([id, row]) => [id, { ...row }]));
    const result = await work({ query: async <R extends Record<string, unknown>>(statement: string, values: readonly unknown[]) => {
      operation = /notification-ledger:(reserve|assert|pending|outcome)/.exec(statement)?.[1] as Operation;
      if (!operation) throw new Error("unknown synthetic operation");
      this.operations.push(operation);
      if (operation === "reserve") {
        const row: Row = { id: values[0] as string, token: values[1] as string, eventHash: values[13] as string,
          bodyHash: values[14] as string, destinationHash: values[15] as string, state: "reserved" };
        draft.set(row.id, row); return [{ id: row.id }] as unknown as R[];
      }
      const row = draft.get(values[0] as string);
      if (!row || row.token !== values[1] || row.eventHash !== values[2] || row.bodyHash !== values[3] || row.destinationHash !== values[4] ||
          row.state !== (operation === "outcome" ? "pending" : "reserved")) return [];
      if (operation === "pending") row.state = "pending";
      if (operation === "outcome") { row.state = values[5] as string; row.providerId = values[6] as string; }
      return [{ id: row.id }] as unknown as R[];
    } });
    if (this.hook && operation) await this.hook(operation);
    const trip = (phase: "before_commit" | "after_commit") => {
      if (this.fault && this.fault.operation === operation && this.fault.phase === phase) { this.fault = null; throw new Error("synthetic-fake-token lost acknowledgment"); }
    };
    trip("before_commit"); this.rows = draft; trip("after_commit"); return result;
  }
}
async function context(value = setup(), fetch: GhlPostFetch = async () => response(), patch: Partial<GhlTransportOptions> = {}) {
  const db = new FakeDatabase(), ledger = createNotificationLedger(db);
  const claim = await ledger.reserve({ event: value.gate.event, body: BODY, destination: value.gate.event.destination,
    contactId: value.gate.event.contactId, channel: value.gate.event.channel, scheduledOn: "2026-11-09" });
  assert.equal(claim.state, "reserved"); if (claim.state !== "reserved") throw new Error("fixture failed");
  let clock = NOW.getTime();
  const options: GhlTransportOptions = { mode: "reviewed-one-attempt", fetch, credential: "synthetic-fake-token",
    accountId: value.binding.accountId, locationId: value.binding.locationId, scopes: ["conversations/message.write"],
    ledger, now: () => new Date(clock), ...patch };
  const transport = createGhlOneAttemptTransport(options);
  return { ...value, db, ledger, transport, options, reservation: claim.reservation, setClock: (value: number) => { clock = value; } };
}

test("descriptor alone, cloned/serialized review handles and unknown handles cannot invoke HTTP or the ledger", async () => {
  let calls = 0;
  const ctx = await context(setup(), async () => { calls++; return response(); });
  const reviewed = handle(ctx);
  for (const forged of [ctx.construction, { ...reviewed }, JSON.parse(JSON.stringify(reviewed)), {}, null]) {
    assert.equal((await ctx.transport.attempt(forged as GhlReviewedTransportHandle, ctx.reservation, ctx.gate)).state, "held");
  }
  assert.equal(calls, 0); assert.deepEqual(ctx.db.operations, ["reserve"]);
});
test("contract, sender, body, exact destination and timing/attempt approval cannot be omitted or assumed", () => {
  for (const mutate of [
    (r: any) => { r.statusSemantics.verified = false; }, (r: any) => { r.statusSemantics.status = "delivered"; },
    (r: any) => { r.statusSemantics.status = "read"; }, (r: any) => { r.statusSemantics.version = "v3"; },
    (r: any) => { r.statusSemantics.evidenceRef = ""; }, (r: any) => { r.sender.validated = false; },
    (r: any) => { r.sender.sender = "+12025550999"; }, (r: any) => { r.sender.locationId = "wrong-location"; },
    (r: any) => { r.content.approved = false; }, (r: any) => { r.content.requestSha256 = "wrong"; },
    (r: any) => { r.authorization.approved = false; }, (r: any) => { r.authorization.timingApproved = false; },
    (r: any) => { r.authorization.requestSha256 = "wrong"; }, (r: any) => { r.binding.destination = "+12025550999"; },
    (r: any) => { r.event.invoiceId = "wrong-invoice"; }, (r: any) => { r.expiresAt = "2026-11-09T16:01:01.000Z"; },
    (r: any) => { r.reviewedAt = "2026-11-09T16:00:01.000Z"; },
  ]) {
    const value = setup(), review = structuredClone(value.review); mutate(review);
    assert.equal(reviewGhlTransportConstruction(value.construction, review, NOW).state, "held");
  }
  const value = setup();
  assert.equal(reviewGhlTransportConstruction({ ...value.construction }, value.review, NOW).state, "held");
  handle(value); assert.equal(reviewGhlTransportConstruction(value.construction, value.review, NOW).state, "held");
});
for (const channel of ["sms", "email"] as const) {
  test(`${channel}: real ledger assertion and acknowledged pending commit precede the exact single POST`, async () => {
    let calls = 0;
    const value = setup(channel);
    const ctx = await context(value, async (url, init) => {
      calls++;
      assert.equal(ctx.db.rows.get(ctx.reservation.id)!.state, "pending");
      assert.deepEqual(ctx.db.operations, ["reserve", "assert", "pending"]);
      assert.equal(url, "https://services.leadconnectorhq.com/conversations/messages");
      assert.equal(init.method, "POST"); assert.equal(init.redirect, "error"); assert.ok(init.signal instanceof AbortSignal);
      assert.deepEqual(init.headers, { Authorization: "Bearer synthetic-fake-token", Version: "2021-07-28", "Content-Type": "application/json", Accept: "application/json" });
      assert.equal(init.body, value.construction.request!.serializedBody);
      return response({ messageId: "message-1", conversationId: "conversation-1", ...(channel === "email" ? { emailMessageId: "individual-1" } : {}) });
    });
    const reviewed = handle(ctx), result = await ctx.transport.attempt(reviewed, ctx.reservation, ctx.gate);
    assert.equal(result.state, "accepted"); assert.equal(result.attempted, true); assert.equal(result.outcomePersisted, true);
    assert.equal(result.deliveryConfirmed, false); assert.equal(result.invoiceAttributionVerified, false); assert.equal(result.retryAllowed, false);
    assert.equal(result.productionSendCapability, false); assert.equal(ctx.db.rows.get(ctx.reservation.id)!.state, "accepted");
    assert.equal((await ctx.transport.attempt(reviewed, ctx.reservation, ctx.gate)).state, "held"); assert.equal(calls, 1);
  });
}
test("default-disabled and wrong configured account/location/scope never reach the ledger or POST", async () => {
  for (const patch of [{ mode: undefined }, { accountId: "wrong-account" }, { locationId: "wrong-location" }, { scopes: [] }]) {
    let calls = 0;
    const ctx = await context(setup(), async () => { calls++; return response(); }, patch);
    assert.equal((await ctx.transport.attempt(handle(ctx), ctx.reservation, ctx.gate)).state, "held");
    assert.equal(calls, 0); assert.deepEqual(ctx.db.operations, ["reserve"]);
  }
});
test("cloned, foreign, token-changed and digest-drift reservations cannot bypass the real ledger", async () => {
  for (const change of ["clone", "token", "eventHash", "bodyHash", "destinationHash", "foreign"] as const) {
    let calls = 0;
    const ctx = await context(setup(), async () => { calls++; return response(); });
    let reservation: NotificationReservation = { ...ctx.reservation };
    if (change === "token") reservation = { ...ctx.reservation, token: "forged" };
    if (["eventHash", "bodyHash", "destinationHash"].includes(change)) reservation = { ...ctx.reservation, [change]: "0".repeat(64) };
    if (change === "foreign") reservation = (await context(setup())).reservation;
    assert.equal((await ctx.transport.attempt(handle(ctx), reservation, ctx.gate)).state, "held"); assert.equal(calls, 0);
  }
});
test("paid, blocked, changed or stale final source/recipient evidence prevents pending and POST", async () => {
  for (const change of ["paid", "dnd", "body", "stale", "owner"] as const) {
    let calls = 0;
    const ctx = await context(setup(), async () => { calls++; return response(); });
    const gate = structuredClone(ctx.gate) as any;
    if (change === "paid") gate.final.source.status = "paid";
    if (change === "dnd") gate.final.dnd.state = "blocked";
    if (change === "body") gate.event.bodyDigest = "0".repeat(64);
    if (change === "stale") gate.final.source.expiresAt = NOW.toISOString();
    if (change === "owner") gate.final.owner.ownerId = "wrong-owner";
    assert.equal((await ctx.transport.attempt(handle(ctx), ctx.reservation, gate)).state, "held");
    assert.equal(calls, 0); assert.deepEqual(ctx.db.operations, ["reserve"]);
  }
});
test("concurrent attempts across transport instances consume one original handle before any await", async () => {
  let calls = 0;
  const ctx = await context(setup(), async () => { calls++; return response(); });
  const other = createGhlOneAttemptTransport(ctx.options), reviewed = handle(ctx);
  const results = await Promise.all([ctx.transport.attempt(reviewed, ctx.reservation, ctx.gate), other.attempt(reviewed, ctx.reservation, ctx.gate)]);
  assert.deepEqual(results.map(r => r.state).sort(), ["accepted", "held"]); assert.equal(calls, 1);
});
test("rebuilding a new descriptor and review cannot replay the same logical event in this process", async () => {
  let calls = 0;
  const ctx = await context(setup(), async () => { calls++; return response(); });
  assert.equal((await ctx.transport.attempt(handle(ctx), ctx.reservation, ctx.gate)).state, "accepted");
  const construction = buildGhlMessageRequest(ctx.constructionInput), second = reviewGhlTransportConstruction(construction, ctx.review, NOW);
  assert.ok(second.handle);
  assert.equal((await createGhlOneAttemptTransport(ctx.options).attempt(second.handle, ctx.reservation, ctx.gate)).state, "held"); assert.equal(calls, 1);
});
test("a pending transaction that has not acknowledged cannot invoke POST", async () => {
  let calls = 0, release!: () => void, entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const ctx = await context(setup(), async () => { calls++; return response(); });
  ctx.db.hook = async operation => { if (operation === "pending") { entered(); await new Promise<void>(resolve => { release = resolve; }); } };
  const pending = ctx.transport.attempt(handle(ctx), ctx.reservation, ctx.gate);
  await enteredPromise; assert.equal(calls, 0); assert.equal(ctx.db.rows.get(ctx.reservation.id)!.state, "reserved");
  release(); assert.equal((await pending).state, "accepted"); assert.equal(calls, 1);
});
for (const phase of ["before_commit", "after_commit"] as const) {
  test(`pending ${phase} failure never invokes POST or retries the ledger transition`, async () => {
    let calls = 0;
    const ctx = await context(setup(), async () => { calls++; return response(); });
    ctx.db.fault = { operation: "pending", phase };
    const reviewed = handle(ctx), result = await ctx.transport.attempt(reviewed, ctx.reservation, ctx.gate);
    assert.equal(result.state, "unknown"); assert.equal(result.attempted, false); assert.equal(calls, 0);
    assert.equal((await ctx.transport.attempt(reviewed, ctx.reservation, ctx.gate)).state, "held");
    assert.equal(ctx.db.operations.filter(op => op === "pending").length, 1);
    assert.equal(ctx.db.rows.get(ctx.reservation.id)!.state, phase === "before_commit" ? "reserved" : "pending");
  });
  test(`outcome ${phase} failure preserves uncertainty after exactly one POST`, async () => {
    let calls = 0;
    const ctx = await context(setup(), async () => { calls++; return response(); });
    ctx.db.fault = { operation: "outcome", phase };
    const result = await ctx.transport.attempt(handle(ctx), ctx.reservation, ctx.gate);
    assert.equal(result.state, "unknown"); assert.equal(result.attempted, true); assert.equal(result.outcomePersisted, false);
    assert.equal(result.acceptance!.state, "accepted"); assert.equal(result.deliveryConfirmed, false); assert.equal(calls, 1);
    assert.equal(ctx.db.operations.filter(op => op === "outcome").length, 1);
    assert.equal(ctx.db.rows.get(ctx.reservation.id)!.state, phase === "before_commit" ? "pending" : "accepted");
  });
}
test("approval and source expiration during the pending commit both stop POST after acknowledgment", async () => {
  for (const expires of ["review", "source"] as const) {
    let calls = 0;
    const ctx = await context(setup(), async () => { calls++; return response(); });
    const review = { ...ctx.review, expiresAt: new Date(NOW.getTime() + (expires === "review" ? 1000 : 60_000)).toISOString() };
    const reviewed = reviewGhlTransportConstruction(ctx.construction, review, NOW).handle!;
    ctx.db.hook = operation => { if (operation === "pending") ctx.setClock(NOW.getTime() + (expires === "review" ? 1000 : 30_000)); };
    const result = await ctx.transport.attempt(reviewed, ctx.reservation, ctx.gate);
    assert.equal(result.state, "held"); assert.equal(result.attempted, false); assert.equal(calls, 0);
    assert.equal(ctx.db.rows.get(ctx.reservation.id)!.state, "unknown"); assert.equal(result.outcomePersisted, true);
  }
});
test("provider errors, malformed acceptance, redirects, 429 and 5xx all become durable unknown with one request", async () => {
  for (const fault of ["throw", "malformed", "false-delivery", 201, 302, 400, 401, 429, 500, 503] as const) {
    let calls = 0;
    const ctx = await context(setup(), async () => {
      calls++; if (fault === "throw") throw new Error("synthetic-fake-token private upstream error");
      if (fault === "malformed") return response({ msg: "queued" });
      if (fault === "false-delivery") return response({ messageId: "message-1", conversationId: "conversation-1", status: "delivered" });
      return response({ messageId: "message-1", conversationId: "conversation-1", error: "exact synthetic provider error" }, fault);
    });
    const reviewed = handle(ctx), result = await ctx.transport.attempt(reviewed, ctx.reservation, ctx.gate);
    assert.equal(result.state, "unknown"); assert.equal(result.outcomePersisted, true); assert.equal(result.deliveryConfirmed, false);
    assert.equal(ctx.db.rows.get(ctx.reservation.id)!.state, "unknown"); assert.equal(calls, 1);
    assert.equal(JSON.stringify(result).includes("synthetic-fake-token"), false);
    if (typeof fault === "number") assert.equal(inspectGhlPrivateEvidence(result.acceptance!)!.rawError, "exact synthetic provider error");
    assert.equal((await ctx.transport.attempt(reviewed, ctx.reservation, ctx.gate)).state, "held"); assert.equal(calls, 1);
  }
});
test("timeout consumes the one attempt, aborts, and ignores a late successful response", async () => {
  let calls = 0, finish!: (value: Awaited<ReturnType<GhlPostFetch>>) => void, signal: AbortSignal | undefined;
  const ctx = await context(setup(), async (_url, init) => { calls++; signal = init.signal; return new Promise(resolve => { finish = resolve; }); }, { timeoutMs: 5 });
  const result = await ctx.transport.attempt(handle(ctx), ctx.reservation, ctx.gate);
  assert.equal(result.state, "unknown"); assert.equal(signal!.aborted, true); assert.equal(calls, 1);
  finish(response()); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(ctx.db.rows.get(ctx.reservation.id)!.state, "unknown"); assert.equal(ctx.db.operations.filter(op => op === "outcome").length, 1);
});
test("stream byte bound aborts and cancels without reading the whole response", async () => {
  let reads = 0, cancel = 0, signal: AbortSignal | undefined;
  const ctx = await context(setup(), async (_url, init) => { signal = init.signal; return { status: 200, body: { getReader: () => ({
    read: async () => { reads++; return { done: false, value: new Uint8Array(40_000) }; }, cancel: async () => { cancel++; },
  }) } }; });
  const result = await ctx.transport.attempt(handle(ctx), ctx.reservation, ctx.gate);
  assert.equal(result.state, "unknown"); assert.equal(reads, 2); assert.ok(cancel >= 1); assert.equal(signal!.aborted, true);
});
test("absent, malformed UTF-8, empty-chunk and stalled streams cannot fabricate acceptance", async () => {
  for (const fault of ["absent", "utf8", "empty", "stalled", "json"] as const) {
    const ctx = await context(setup(), async () => {
      if (fault === "absent") return { status: 200, body: null };
      return { status: 200, body: { getReader: () => ({
        read: async () => fault === "stalled" ? new Promise(() => {}) : ({ done: false,
          value: fault === "empty" ? new Uint8Array() : fault === "utf8" ? new Uint8Array([255]) : new TextEncoder().encode("invalid") }),
        cancel: async () => {},
      }) } };
    }, { timeoutMs: 5 });
    assert.equal((await ctx.transport.attempt(handle(ctx), ctx.reservation, ctx.gate)).state, "unknown");
  }
});
test("review/body/request snapshots cannot be changed while admission is in flight", async () => {
  let entered!: () => void, resume!: () => void, calls = 0;
  const entry = new Promise<void>(resolve => { entered = resolve; });
  const ctx = await context(setup(), async (_url, init) => { calls++; assert.equal(init.body, ctx.construction.request!.serializedBody); return response(); });
  ctx.db.hook = async operation => { if (operation === "assert") { entered(); await new Promise<void>(resolve => { resume = resolve; }); } };
  const reviewed = handle(ctx), gate = structuredClone(ctx.gate) as any;
  const pending = ctx.transport.attempt(reviewed, ctx.reservation, gate);
  await entry; gate.event.bodyDigest = "bad"; gate.final.source.status = "paid";
  (ctx.review as any).expiresAt = "2100-01-01T00:00:00.000Z";
  resume(); assert.equal((await pending).state, "accepted"); assert.equal(calls, 1);
});
test("request byte cap rejects the review before ledger or transport entry", () => {
  const value = setup(), body = "x".repeat(GHL_TRANSPORT_LIMITS.requestBytes);
  const b = { ...value.binding, bodyHash: hash(body) }, event = { ...value.gate.event, bodyDigest: b.bodyHash };
  const construction = buildGhlMessageRequest({ ...value.constructionInput, binding: b, body });
  assert.equal(construction.state, "constructed_disabled");
  const requestSha256 = hash(construction.request!.serializedBody);
  const result = reviewGhlTransportConstruction(construction, { ...value.review, binding: b, event,
    content: { ...value.review.content, requestSha256 }, authorization: { ...value.review.authorization, requestSha256 } }, NOW);
  assert.equal(result.state, "held"); assert.ok(result.reasons.includes("request_byte_limit"));
});
test("transport has no ambient secrets, default fetch, automatic retry, wiring or production flag", () => {
  const source = readFileSync(new URL("../lib/notification-ghl-transport.ts", import.meta.url), "utf8");
  assert.equal(/process\.env|globalThis\.fetch|productionSendCapability:\s*true|setInterval|\.reserve\(/.test(source), false);
  assert.equal(source.includes('redirect: "error"'), true);
  assert.equal(GHL_TRANSPORT_LIMITS.maximumAttempts, 1); assert.equal(GHL_TRANSPORT_LIMITS.automaticRetry, false);
});

test("an already-pending reservation cannot be sent through a dispatcher that marks pending twice", async () => {
  let calls = 0;
  const ctx = await context(setup(), async () => { calls++; return response(); });
  assert.equal(await ctx.ledger.assertReserved(ctx.reservation), true);
  assert.equal(await ctx.ledger.markPending(ctx.reservation), true);
  const result = await ctx.transport.attempt(handle(ctx), ctx.reservation, ctx.gate);
  assert.equal(result.state, "held"); assert.equal(calls, 0);
  assert.equal(ctx.db.operations.filter(op => op === "pending").length, 1);
});
test("uncertain ownership assertion stops before pending and never leaks underlying error content", async () => {
  let calls = 0;
  const ctx = await context(setup(), async () => { calls++; return response(); });
  ctx.db.fault = { operation: "assert", phase: "after_commit" };
  const result = await ctx.transport.attempt(handle(ctx), ctx.reservation, ctx.gate);
  assert.equal(result.state, "held"); assert.equal(calls, 0);
  assert.deepEqual(ctx.db.operations, ["reserve", "assert"]);
  assert.equal(JSON.stringify(result).includes("synthetic-fake-token"), false);
});
test("expiry during ownership assertion stops before the pending transition", async () => {
  let calls = 0;
  const ctx = await context(setup(), async () => { calls++; return response(); });
  const reviewed = handle(ctx);
  ctx.db.hook = operation => { if (operation === "assert") ctx.setClock(NOW.getTime() + 30_000); };
  const result = await ctx.transport.attempt(reviewed, ctx.reservation, ctx.gate);
  assert.equal(result.state, "held"); assert.equal(calls, 0);
  assert.deepEqual(ctx.db.operations, ["reserve", "assert"]);
});
