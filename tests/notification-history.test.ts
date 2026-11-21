import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readNotificationHistory, inspectNotificationHistory, composeNotificationHistoryAttempts,
  projectAccessibleGhlExternalHistory, inspectAccessibleGhlExternalHistory, composeAccessibleGhlExternalAttempts,
  NOTIFICATION_HISTORY_CONTRACT as C, type NotificationHistoryGet, type NotificationHistoryIO,
  type NotificationHistoryRequest } from "../lib/notification-history";
import { eventKey, type Event } from "../lib/notification-gate";
import { notificationEventHash } from "../lib/notification-ledger";
import { createNotificationRunner, type NotificationRunnerDependencies } from "../lib/notification-runner";
import type { NotificationLedgerDatabase } from "../lib/notification-ledger";
import { createHash } from "node:crypto";

const START = Date.parse("2026-11-09T16:05:00Z");
const event: Event = { accountId: "account", invoiceId: "invoice", dayPastDue: 10, audience: "homeowner",
  sourceRevision: "source", ownerRevision: "owner", ownerId: "owner", homeownerContactId: "contact",
  issuedDate: "2026-10-20", dueDate: "2026-10-30", balanceMinor: 5000, currency: "USD", category: null,
  recipientId: "contact", contactId: "contact", channel: "sms", destination: "+16025550100",
  templateId: "template", templateVersion: "1", bodyDigest: "a".repeat(64), claimedFacts: [] };
const request: NotificationHistoryRequest = { scope: { accountId: "account", locationId: "location", contactId: "contact",
  invoiceId: "invoice", issuedDate: event.issuedDate, audience: "homeowner" }, reviewRef: "synthetic-review" };
const conversation = (id = "c1") => ({ id, contactId: "contact", locationId: "location" });
const message = (id = "m1", extra: Record<string, unknown> = {}) => ({ id, type: 2, messageType: "TYPE_SMS",
  locationId: "location", contactId: "contact", conversationId: "c1", dateAdded: "2026-11-08T10:00:00Z",
  direction: "inbound", status: "delivered", ...extra });
const page = (messages: any[] = [], nextPage = false, lastMessageId = messages.at(-1)?.id ?? "") => ({
  messages: { messages, nextPage, lastMessageId } });
const response = (body: unknown, status = 200) => ({ status, body: new ReadableStream<Uint8Array>({ start(c) {
  c.enqueue(new TextEncoder().encode(JSON.stringify(body))); c.close();
} }) });
function ledger(e: Event = event, providerMessageId: string | null = "m1", state = "accepted", id = "row1") {
  return { id, accountId: e.accountId, invoiceId: e.invoiceId, dayPastDue: e.dayPastDue, audience: e.audience,
    contactId: e.contactId, channel: e.channel, eventKey: eventKey(e), eventPayload: e,
    eventHash: notificationEventHash(e), state, providerMessageId };
}
function fixture() {
  let now = START;
  const calls: NotificationHistoryGet[] = [], queries: string[] = [];
  const data: { pages: any[]; rows: Record<string, unknown>[]; status: number; fail: boolean; hook?: () => void } = {
    pages: [{ conversations: [conversation()], total: 1 }, page([message()])], rows: [], status: 200, fail: false };
  const io: NotificationHistoryIO = { accountId: "account", locationId: "location", now: () => new Date(now),
    select: async (sql, params) => { queries.push(sql); assert.match(sql, /^\/\* notification-history:read-only \*\/\nSELECT/);
      assert.match(sql, /WHERE "accountId" = \$1 AND "contactId" = \$2 ORDER BY "id" LIMIT 1001$/);
      assert.deepEqual(params, ["account", "contact"]); return structuredClone(data.rows); },
    get: async r => { calls.push(r); data.hook?.(); if (data.fail) throw new Error("sensitive raw transport error");
      return response(data.pages.shift(), data.status); } };
  return { data, io, calls, queries, tick: (ms: number) => { now += ms; }, now: () => new Date(now),
    read: () => readNotificationHistory(request, io) };
}
async function snapshot(f: ReturnType<typeof fixture>) { return inspectNotificationHistory(await f.read()); }

test("complete accessible history issues opaque facts, before-read proof and bounded absence only", async () => {
  const f = fixture(); f.data.hook = () => f.tick(20);
  const h = await f.read(), s = inspectNotificationHistory(h), c = composeNotificationHistoryAttempts(h, event, f.now());
  assert.equal(s.state, "bounded_ready"); assert.equal(s.apiPaginationComplete, true); assert.equal(s.ledgerReadComplete, true);
  assert.equal(s.observedAt, new Date(START).toISOString()); assert.equal(s.completedAt, new Date(START + 40).toISOString());
  assert.equal(s.expiresAt, new Date(START + 60000).toISOString()); assert.ok(s.boundedAbsence);
  assert.equal(c.attempts?.historyComplete, true); assert.deepEqual(c.attempts?.records, []);
  assert.equal(c.productionSendCapability, false); assert.ok(Object.isFrozen(s)); assert.ok(Object.isFrozen(s.messages[0]));
  assert.ok(s.limitations.includes("deleted_or_inaccessible_messages_not_provable"));
  assert.equal(f.queries.length, 1);
  for (const r of f.calls) {
    assert.equal(r.method, "GET"); assert.equal(r.maximumAttempts, 1); assert.equal(r.automaticRetry, false);
    assert.equal(r.headers.Version, "2021-04-15"); assert.equal(r.redirect, "error");
    assert.equal(new URL(r.url).origin, C.origin); assert.equal("Authorization" in r.headers, false);
  }
  const search = new URL(f.calls[0].url); assert.equal(search.searchParams.get("contactId"), "contact");
  assert.equal(search.searchParams.get("locationId"), "location");
  assert.equal(new URL(f.calls[1].url).searchParams.has("type"), false);
});

test("zero returned conversations is bounded absence, never global completeness", async () => {
  const f = fixture(); f.data.pages = [{ conversations: [], total: 0 }];
  const s = await snapshot(f); assert.equal(s.state, "bounded_ready"); assert.equal(f.calls.length, 1); assert.ok(s.boundedAbsence);
});

test("all conversations and all message cursor pages are read, no date early stop", async () => {
  const f = fixture(); f.data.pages = [{ conversations: [conversation(), conversation("c2")], total: 2 },
    page([message("old", { dateAdded: "2026-10-01T00:00:00Z" })], true),
    page([message("new")]), page([message("other", { conversationId: "c2" })])];
  const s = await snapshot(f); assert.equal(s.state, "bounded_ready"); assert.equal(s.messages.length, 3);
  assert.equal(new URL(f.calls[2].url).searchParams.get("lastMessageId"), "old");
  assert.match(new URL(f.calls[3].url).pathname, /c2\/messages$/);
});

test("unmatched outbound after issue date holds, regardless of wording, invoice-like fields or status", async () => {
  const f = fixture(); f.data.pages[1] = page([message("m1", { direction: "outbound", status: "sent",
    body: "Invoice invoice: day 10 reminder", invoiceId: "invoice", opportunityId: "invoice" })]);
  const h = await f.read(), s = inspectNotificationHistory(h);
  assert.equal(s.state, "held"); assert.equal(s.apiPaginationComplete, true); assert.equal(s.boundedAbsence, null);
  assert.ok(s.reasons.includes("outbound_invoice_attribution_unresolved"));
  assert.deepEqual(s.records, []); assert.equal(composeNotificationHistoryAttempts(h, event, f.now()).attempts, null);
});

test("immutable exact ledger identities survive, including missing provider records and different milestones", async () => {
  const f = fixture(), other = { ...event, dayPastDue: 15 };
  f.data.rows = [ledger(other), ledger(event, "deleted-message", "unknown", "row2")];
  f.data.pages[1] = page([message("m1", { direction: "outbound", status: "sent" })]);
  const s = await snapshot(f);
  assert.equal(s.state, "bounded_ready"); assert.equal(s.boundedAbsence, null);
  assert.deepEqual(s.records, [{ eventKey: eventKey(other), state: "accepted" },
    { eventKey: eventKey(event), state: "unknown" }, { eventKey: eventKey(other), state: "unknown" }]);
  assert.equal(s.messages[0].eventKey, eventKey(other)); assert.equal(s.messages[0].deliveryConfirmed, false);
  assert.equal(s.records.some(r => r.state === "delivered"), false);
});

test("known ledger IDs before issue date still preserve exact attempt records", async () => {
  const f = fixture(); f.data.rows = [ledger()];
  f.data.pages[1] = page([message("m1", { direction: "outbound", dateAdded: "2026-10-01T00:00:00Z", status: "sent" })]);
  const s = await snapshot(f); assert.equal(s.state, "bounded_ready"); assert.equal(s.records.length, 2);
});

test("Arizona issue calendar date is inclusive; pre-midnight outbound can be irrelevant", async () => {
  const f = fixture(); f.data.pages[1] = page([message("m1", { direction: "outbound", dateAdded: "2026-10-20T06:59:59Z" })]);
  assert.equal((await snapshot(f)).state, "bounded_ready");
  const g = fixture(); g.data.pages[1] = page([message("m1", { direction: "outbound", dateAdded: "2026-10-20T07:00:00Z" })]);
  assert.ok((await snapshot(g)).reasons.includes("outbound_invoice_attribution_unresolved"));
});

for (const [kind, mutate, reason] of [
  ["unknown type", (m: any) => { m.messageType = "TYPE_NEW"; }, "message_type_unverified"],
  ["ambiguous example alias", (m: any) => { m.messageType = "SMS"; }, "message_type_unverified"],
  ["conflicting numeric type", (m: any) => { m.type = 1; }, "message_type_unverified"],
  ["unknown direction", (m: any) => { m.direction = "system"; }, "message_direction_unverified"],
  ["missing timestamp", (m: any) => { delete m.dateAdded; }, "message_timestamp_unverified"],
  ["invalid calendar timestamp", (m: any) => { m.dateAdded = "2026-02-30T12:00:00Z"; }, "message_timestamp_unverified"],
  ["future timestamp", (m: any) => { m.dateAdded = "2026-11-10T12:00:00Z"; }, "message_timestamp_unverified"],
  ["wrong contact", (m: any) => { m.contactId = "other"; }, "message_scope_mismatch"],
  ["wrong location", (m: any) => { m.locationId = "other"; }, "message_scope_mismatch"],
  ["wrong conversation", (m: any) => { m.conversationId = "other"; }, "message_scope_mismatch"],
  ["email thread even inbound", (m: any) => { m.messageType = "TYPE_EMAIL"; m.type = 3; }, "email_thread_history_unresolved"],
  ["hidden email thread", (m: any) => { m.meta = { email: {} }; }, "email_thread_history_unresolved"],
] as const) test(`holds ${kind}`, async () => {
  const f = fixture(), m = message(); mutate(m); f.data.pages[1] = page([m]);
  const s = await snapshot(f); assert.equal(s.state, "held"); assert.ok(s.reasons.includes(reason)); assert.equal(s.boundedAbsence, null);
});

test("known call may be ignored only with exact identity, direction and valid timestamp", async () => {
  const f = fixture(); f.data.pages[1] = page([message("call", { messageType: "TYPE_CALL", type: 1, direction: "outbound" })]);
  assert.equal((await snapshot(f)).state, "bounded_ready");
});

test("unknown outcome remains held even with exact provider mapping", async () => {
  const f = fixture(); f.data.rows = [ledger()];
  f.data.pages[1] = page([message("m1", { direction: "outbound", status: "magic-success" })]);
  const s = await snapshot(f); assert.ok(s.reasons.includes("provider_outcome_unknown"));
  assert.equal(s.records[0].state, "accepted"); assert.equal(s.records[1].state, "unknown");
});

for (const kind of ["total larger", "total smaller", "missing total", "duplicate conversation", "wrong conversation contact",
  "duplicate messages", "repeated cursor", "cursor mismatch", "empty continuation", "missing nextPage", "missing wrapper"]) test(`holds incomplete pagination: ${kind}`, async () => {
  const f = fixture();
  if (kind === "total larger") f.data.pages[0].total = 2;
  if (kind === "total smaller") f.data.pages[0].total = 0;
  if (kind === "missing total") delete f.data.pages[0].total;
  if (kind === "duplicate conversation") { f.data.pages[0].conversations.push(conversation()); f.data.pages[0].total = 2; }
  if (kind === "wrong conversation contact") f.data.pages[0].conversations[0].contactId = "other";
  if (kind === "duplicate messages") f.data.pages[1] = page([message(), message()]);
  if (kind === "repeated cursor") f.data.pages = [f.data.pages[0], page([message()], true), page([message()], true)];
  if (kind === "cursor mismatch") f.data.pages[1].messages.lastMessageId = "other";
  if (kind === "empty continuation") f.data.pages[1] = page([], true, "cursor");
  if (kind === "missing nextPage") delete f.data.pages[1].messages.nextPage;
  if (kind === "missing wrapper") f.data.pages[1] = [];
  const s = await snapshot(f); assert.equal(s.state, "held"); assert.equal(s.apiPaginationComplete, false);
});

for (const kind of ["hash", "event identity", "duplicate provider", "unknown ledger state", "too many rows", "ledger failure", "inbound mapped"]) test(`holds untrusted ledger: ${kind}`, async () => {
  const f = fixture(); f.data.rows = [ledger()];
  f.data.pages[1] = page([message("m1", { direction: "outbound" })]);
  if (kind === "hash") f.data.rows[0].eventHash = "0".repeat(64);
  if (kind === "event identity") f.data.rows[0].invoiceId = "other";
  if (kind === "duplicate provider") f.data.rows.push(ledger({ ...event, dayPastDue: 15 }, "m1", "accepted", "row2"));
  if (kind === "unknown ledger state") f.data.rows[0].state = "successful";
  if (kind === "too many rows") f.data.rows = Array.from({ length: 1001 }, (_, i) => ledger(event, null, "pending", `row${i}`));
  if (kind === "ledger failure") (f.io as any).select = async () => { throw new Error("secret"); };
  if (kind === "inbound mapped") f.data.pages[1] = page([message()]);
  const s = await snapshot(f); assert.equal(s.state, "held"); assert.equal(s.boundedAbsence, null);
});

for (const status of [301, 401, 403, 429, 500]) test(`HTTP ${status} holds without retry`, async () => {
  const f = fixture(); f.data.status = status; const s = await snapshot(f);
  assert.equal(s.state, "held"); assert.equal(f.calls.length, 1); assert.equal(s.requests, 1);
});
test("uncertain GET holds once without exposing raw error", async () => {
  const f = fixture(); f.data.fail = true; const s = await snapshot(f);
  assert.equal(s.state, "held"); assert.equal(f.calls.length, 1); assert.equal(JSON.stringify(s).includes("sensitive"), false);
});

test("byte limit, malformed JSON and UTF-8 are enforced on actual streamed parser", async () => {
  for (const bytes of [new TextEncoder().encode(" ".repeat(C.maxResponseBytes + 1)), new TextEncoder().encode("{"), new Uint8Array([255])]) {
    const f = fixture(); let calls = 0;
    (f.io as any).get = async () => { calls++; return { status: 200, body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }) }; };
    assert.equal((await snapshot(f)).state, "held"); assert.equal(calls, 1);
  }
});

test("time budget uses before-read clock, blocks stale facts and stops further reads", async () => {
  const f = fixture(); f.data.hook = () => f.tick(C.maxReadMs);
  assert.equal((await snapshot(f)).state, "held"); assert.equal(f.calls.length, 1);
  const g = fixture(), h = await g.read(); g.tick(60_000);
  assert.equal(composeNotificationHistoryAttempts(h, event, g.now()).attempts, null);
});

test("opaque handles cannot be forged, cloned or re-scoped; internal recipient unsupported", async () => {
  const f = fixture(), h = await f.read();
  for (const fake of [{}, structuredClone(h), inspectNotificationHistory(h)])
    assert.throws(() => inspectNotificationHistory(fake as any), /unrecognized_history_handle/);
  for (const delta of [{ invoiceId: "other" }, { contactId: "other" }, { issuedDate: "2026-10-21" }, { audience: "internal" }])
    assert.equal(composeNotificationHistoryAttempts(h, { ...event, ...delta } as Event, f.now()).attempts, null);
  assert.equal(composeNotificationHistoryAttempts(h, event, new Date(START - 1)).attempts, null);
});

test("scope validation rejects wrong account/location and unsupported internal pilot without IO", async () => {
  for (const delta of [{ accountId: "other" }, { locationId: "other" }, { audience: "internal" }, { issuedDate: "2026-02-30" }]) {
    const f = fixture(); await assert.rejects(readNotificationHistory({ ...request, scope: { ...request.scope, ...delta } } as any, f.io));
    assert.equal(f.calls.length, 0); assert.equal(f.queries.length, 0);
  }
});

test("local module has no production callsite, ambient credentials or provider write method", () => {
  const source = readFileSync("lib/notification-history.ts", "utf8");
  assert.doesNotMatch(source, /process\.env|\bfetch\s*\(|method:\s*"(?:POST|PUT|PATCH|DELETE)"/);
  assert.equal(C.productionSendCapability, false);
});

test("stalled actual HTTP stream is deadline-bounded and canceled, with no retry", async () => {
  const f = fixture(); let canceled = 0, calls = 0;
  const originalSelect = f.io.select;
  (f.io as any).select = async (...args: Parameters<typeof originalSelect>) => {
    const result = await originalSelect(...args); f.tick(C.maxReadMs - 2); return result;
  };
  (f.io as any).get = async () => { calls++; return { status: 200, body: new ReadableStream<Uint8Array>({ cancel() { canceled++; } }) }; };
  const s = await snapshot(f); assert.equal(s.state, "held"); assert.ok(s.reasons.includes("history_deadline"));
  assert.equal(calls, 1); assert.equal(canceled, 1);
});

test("bounded page count holds rather than claiming truncated history is complete", async () => {
  const f = fixture(); f.data.pages = [{ conversations: [conversation()], total: 1 },
    ...Array.from({ length: 101 }, (_, n) => page([message(`m${n}`)], true))];
  const s = await snapshot(f); assert.equal(s.state, "held"); assert.ok(s.reasons.includes("history_request_limit"));
  assert.equal(f.calls.length, C.maxRequests); assert.equal(s.requests, C.maxRequests); assert.equal(s.apiPaginationComplete, false);
});

test("all stream chunks and aggregate response bytes are bounded", async () => {
  const f = fixture(); (f.io as any).get = async () => ({ status: 200, body: new ReadableStream<Uint8Array>({ start(c) {
    for (let i = 0; i <= C.maxChunks; i++) c.enqueue(new Uint8Array()); c.close();
  } }) });
  assert.ok((await snapshot(f)).reasons.includes("history_chunk_limit"));
  const g = fixture(); g.data.pages = [{ conversations: [conversation()], total: 1 },
    ...Array.from({ length: 5 }, (_, n) => ({ ...page([message(`m${n}`)], true), ignored: "x".repeat(900000) }))];
  const s = await snapshot(g); assert.equal(s.state, "held"); assert.ok(s.reasons.includes("history_byte_limit"));
});

test("two independent reads retain their own observation times; no future/rewound clock laundering", async () => {
  const f = fixture(), a = await f.read(); f.tick(10);
  f.data.pages = [{ conversations: [], total: 0 }]; const b = await f.read();
  assert.notEqual(inspectNotificationHistory(a).observedAt, inspectNotificationHistory(b).observedAt);
  assert.equal(inspectNotificationHistory(a).expiresAt, new Date(START + C.proofLifetimeMs).toISOString());
  const g = fixture(); g.data.hook = () => g.tick(-10); assert.equal((await snapshot(g)).state, "held");
});

test("external projection is opaque, scope-limited, original-expiry and never claims local-ledger coverage", async () => {
  const f = fixture(); f.data.rows = [ledger(event, null, "reserved")];
  const h = await f.read(), projection = projectAccessibleGhlExternalHistory(h);
  assert.ok(projection.handle);
  const s = inspectAccessibleGhlExternalHistory(projection.handle), full = inspectNotificationHistory(h);
  assert.equal(s.coverage, "accessible-ghl-external-message-history-only");
  assert.equal(s.requiresIndependentLocalLedgerUnion, true); assert.deepEqual(s.records, []);
  assert.deepEqual(full.localLedgerRecords, [{ eventKey: eventKey(event), state: "reserved" }]);
  assert.deepEqual(full.externalMessageRecords, []); assert.deepEqual(full.records, full.localLedgerRecords);
  for (const fake of [{}, structuredClone(projection.handle), h, s])
    assert.throws(() => inspectAccessibleGhlExternalHistory(fake as any), /unrecognized_external_history_handle/);
  assert.throws(() => inspectNotificationHistory(projection.handle as any), /unrecognized_history_handle/);
  assert.equal(composeAccessibleGhlExternalAttempts(projection.handle, { ...event, invoiceId: "other" }, f.now()).attempts, null);
  assert.equal(composeAccessibleGhlExternalAttempts(projection.handle, { ...event, audience: "internal" }, f.now()).attempts, null);
  assert.equal(s.observedAt, full.observedAt); assert.equal(s.expiresAt, full.expiresAt);
  f.tick(60000); assert.equal(composeAccessibleGhlExternalAttempts(projection.handle, event, f.now()).attempts, null);
});

test("mapped external messages can never be removed by projecting away local-only rows", async () => {
  const f = fixture(); f.data.rows = [ledger(event, "m1", "reserved")];
  f.data.pages[1] = page([message("m1", { direction: "outbound", status: "sent" })]);
  const h = await f.read(), projection = projectAccessibleGhlExternalHistory(h); assert.ok(projection.handle);
  assert.deepEqual(inspectNotificationHistory(h).records,
    [{ eventKey: eventKey(event), state: "reserved" }, { eventKey: eventKey(event), state: "unknown" }]);
  assert.deepEqual(composeAccessibleGhlExternalAttempts(projection.handle, event, f.now()).attempts?.records,
    [{ eventKey: eventKey(event), state: "unknown" }]);
});

for (const duplicate of [false, true]) test(`external projection refuses ${duplicate ? "duplicate" : "unmatched"} outbound history`, async () => {
  const f = fixture(); f.data.rows = [ledger(event, null, "reserved")];
  const m = message("unmatched", { direction: "outbound", status: "sent" });
  f.data.pages[1] = page(duplicate ? [m, m] : [m]);
  const h = await f.read(); assert.equal(projectAccessibleGhlExternalHistory(h).handle, null);
  assert.equal(inspectNotificationHistory(h).localLedgerRecords[0].state, "reserved");
});

// Real runner + real source/gate/ledger/transport modules, with fake storage and HTTP only.
// The history adapter never sees the runner's reservation capability; final exclusion is
// performed exclusively by the existing runner against fresh actual ledger SELECT rows.
let runnerSequence = 0;
async function exerciseRunnerHistory(kind: "prior-milestones" | "accepted" | "unknown" | "unmatched" | "duplicates" | "foreign-reservation") {
  const realNow = Date.now; let ms = START; Date.now = () => ms;
  try {
    const tick = () => { ms++; }, invoiceId = `history-invoice-${++runnerSequence}`;
    const rows = new Map<string, Record<string, any>>(), operations: string[] = [], inspections: ReturnType<typeof inspectNotificationHistory>[] = [];
    let posts = 0, prepared: Event | undefined;
    const query = async (sql: string, values: readonly unknown[]): Promise<Record<string, any>[]> => {
      const op = /notification-(?:history|runner|ledger):([a-z-]+)/.exec(sql)?.[1]; assert.ok(op); operations.push(op);
      if (op === "read-only") return structuredClone([...rows.values()].filter(r => r.accountId === values[0] && r.contactId === values[1]));
      if (op === "history") return structuredClone([...rows.values()].filter(r => r.accountId === values[0] && r.eventKey === values[1]));
      if (op === "reserve") {
        if ([...rows.values()].some(r => r.eventKey === values[2])) return [];
        const row = { id: values[0], reservationToken: values[1], eventKey: values[2], accountId: values[3],
          invoiceId: values[4], dayPastDue: values[5], audience: values[6], contactId: values[7], scheduledOn: values[8],
          channel: values[9], eventPayload: JSON.parse(values[10] as string), eventHash: values[13], bodyHash: values[14],
          destinationHash: values[15], state: "reserved", providerMessageId: null };
        rows.set(row.id as string, row);
        if (kind === "foreign-reservation") row.reservationToken = "foreign";
        return [{ id: row.id }];
      }
      const row = rows.get(values[0] as string);
      if (!row || row.reservationToken !== values[1] || row.eventHash !== values[2] || row.bodyHash !== values[3] ||
          row.destinationHash !== values[4] || row.state !== (op === "outcome" ? "pending" : "reserved")) return [];
      if (op === "pending") row.state = "pending";
      if (op === "outcome") { row.state = values[5]; row.providerMessageId = values[6]; }
      return [{ id: row.id }];
    };
    const database: NotificationLedgerDatabase = { transaction: work => work({ query: async <R extends Record<string, unknown>>(sql: string, values: readonly unknown[]) =>
      await query(sql, values) as R[] }) };
    const owner = { jobberClientId: "owner", email: "owner@example.test", phone: "+16025550100" };
    const quarantine = [{ jobberClientId: "missing-a", email: null, phone: null }, { jobberClientId: "missing-b", email: null, phone: null }];
    const fresh = { id: "owner", emails: [{ address: owner.email, primary: true }], phones: [{ number: owner.phone, primary: true }] };
    const config = { credential: "synthetic-history-token", accountId: "account", locationId: "location" };
    const sender = { accountId: "account", locationId: "location", channel: "sms", sender: "+16025550101",
      scope: "conversations/message.write", approved: true, validated: true, evidenceRef: "synthetic-sender" } as const;
    const body = "SYNTHETIC HISTORY TEST ONLY", digest = (s: string) => createHash("sha256").update(s).digest("hex");
    const dependencies: NotificationRunnerDependencies = {
      sourceRequest: { version: 1, reviewRef: "synthetic-review", expiresAt: new Date(START + 300000).toISOString(),
        scope: { locationId: "location", jobberClientId: "owner", contactId: "contact", invoiceId },
        originalInvoice: { totalMinor: 5000, issuedDate: event.issuedDate, dueDate: event.dueDate },
        identityCoveragePolicy: { accountId: "account", reviewRef: "synthetic-quarantine", reviewedAt: new Date(START - 1000).toISOString(),
          expiresAt: new Date(START + 300000).toISOString(), quarantine: [quarantine[0], quarantine[1]] } },
      sourceIO: { locationId: () => "location", customers: async () => { tick(); return [owner, ...quarantine]; },
        contacts: async () => { tick(); return [{ id: "contact", locationId: "location", email: owner.email, phone: owner.phone }]; },
        storedInvoices: async () => [{ jobberInvoiceId: invoiceId }],
        quarantineCounts: async () => quarantine.map(q => ({ jobberClientId: q.jobberClientId, jobs: 0, invoices: 0 })),
        query: async <T = any>(q: string): Promise<T> => {
          tick(); let result: any;
          if (q.includes("VerifyExplicitIdentityCoverage")) result = { account: { id: "account" }, clients: {
            nodes: q.includes("isArchived: false") ? [fresh] : [], pageInfo: { hasNextPage: false, endCursor: null } } };
          else if (q.includes("VerifyQuarantinedIdentity")) result = { account: { id: "account" }, client: null };
          else if (q.includes("VerifyDateOwnerInvoices")) result = { account: { id: "account" }, client: { id: "owner", invoices: {
            nodes: [{ id: invoiceId, invoiceNumber: "1234", client: { id: "owner" }, invoiceStatus: "past_due",
              amounts: { total: 50, invoiceBalance: 50 }, issuedDate: event.issuedDate, dueDate: event.dueDate }],
            pageInfo: { hasNextPage: false, endCursor: null } } } };
          else result = { account: { id: "account" }, client: fresh, invoice: { id: invoiceId, client: { id: "owner" } } };
          return structuredClone(result) as T;
        } }, database,
      contact: { ...config, scopes: ["contacts.readonly"], fetch: async (_url, init) => {
        tick(); assert.equal(init.method, "GET"); return response({ contact: { id: "contact", locationId: "location",
          phone: owner.phone, email: owner.email, dnd: false, dndSettings: { SMS: { status: "inactive" } } } });
      } },
      transport: { ...config, scopes: ["conversations/message.write"], fetch: async (_url, init) => {
        assert.equal(init.method, "POST"); posts++;
        assert.equal([...rows.values()].find(r => r.eventKey === eventKey(prepared!))?.state, "pending");
        return response({ messageId: "synthetic-new-message", conversationId: "c1" });
      } },
      prepare: async s => {
        prepared = { ...event, invoiceId, sourceRevision: s.sourceRevision, ownerRevision: s.ownerRevision, bodyDigest: digest(body) };
        if (kind === "accepted" || kind === "unknown") rows.set("prior", ledger(prepared, "old-provider", kind, "prior"));
        if (kind === "prior-milestones") {
          rows.set("prior-accepted", ledger({ ...prepared, dayPastDue: 15 }, "old-accepted", "accepted", "prior-accepted"));
          rows.set("prior-unknown", ledger({ ...prepared, dayPastDue: 20 }, null, "unknown", "prior-unknown"));
        }
        return { event: prepared, body, contentType: "text/plain", sender,
          constructionReview: { mode: "reviewed-construction-only", version: "2021-07-28", proposedStatus: "pending",
            evidenceRef: "synthetic-construction", accountId: "account", locationId: "location", channel: "sms" } };
      },
      readExternal: async (s, e) => {
        tick(); const h = await readNotificationHistory({ ...request, scope: { ...request.scope, invoiceId } }, {
          accountId: "account", locationId: "location", now: () => new Date(ms), select: query, get: async r => {
            tick(); assert.equal(r.method, "GET");
            if (new URL(r.url).pathname.endsWith("/search")) return response({ conversations: [conversation()], total: 1 });
            const m = message("unmatched", { direction: "outbound", status: "sent" });
            return response(page(kind === "unmatched" ? [m] : kind === "duplicates" ? [m, m] : []));
          } });
        inspections.push(inspectNotificationHistory(h));
        const projection = projectAccessibleGhlExternalHistory(h);
        if (!projection.handle) throw new Error("external_history_held");
        const attempts = composeAccessibleGhlExternalAttempts(projection.handle, e, new Date(ms)).attempts;
        if (!attempts) throw new Error("external_history_not_fresh");
        const p = { observedAt: new Date(ms).toISOString(), expiresAt: new Date(ms + 30000).toISOString(), sourceRef: "synthetic-independent-inputs" };
        return { metadata: { ...p, accountId: e.accountId, invoiceId, sourceRevision: s.sourceRevision, currency: "USD", category: null, categoryVerified: false },
          recipient: { ...p, accountId: e.accountId, recipientId: e.recipientId, contactId: e.contactId, audience: e.audience,
            channel: e.channel, destination: e.destination, destinationVerified: true, exactSourceIdentity: true, internalRecipientApproved: false },
          template: { ...p, approved: true, accountId: e.accountId, id: e.templateId, version: e.templateVersion,
            bodyDigest: e.bodyDigest, audience: e.audience, dayPastDue: e.dayPastDue, channel: e.channel, claimedFacts: [] },
          channelAuthorization: { ...p, approved: true, eventKey: eventKey(e), recipientId: e.recipientId, channel: e.channel, destination: e.destination },
          facts: [], attempts };
      },
      review: async (construction, e, binding) => {
        const requestSha256 = digest(construction.request!.serializedBody);
        return { mode: "reviewed-one-attempt", event: e, binding, sender, reviewedAt: new Date(ms).toISOString(),
          expiresAt: new Date(ms + 30000).toISOString(),
          statusSemantics: { verified: true, version: "2021-07-28", status: "pending", evidenceRef: "synthetic-only" },
          content: { approved: true, requestSha256, evidenceRef: "synthetic-content" },
          authorization: { approved: true, timingApproved: true, requestSha256, evidenceRef: "synthetic-authorization" } };
      },
    };
    const result = await createNotificationRunner({ mode: "reviewed-one-event-candidate", dependencies }).runOne();
    return { result, posts, rows, operations, inspections, event: prepared! };
  } finally { Date.now = realNow; }
}

test("real runner makes a new reservation without external projection repeating it; older local records remain", async () => {
  const f = await exerciseRunnerHistory("prior-milestones");
  assert.equal(f.result.state, "accepted", JSON.stringify({ result: f.result, operations: f.operations, inspections: f.inspections })); assert.equal(f.posts, 1);
  assert.equal(f.result.reservationCreated, true); assert.equal(f.rows.size, 3);
  const final = f.inspections.at(-1)!;
  assert.deepEqual(final.localLedgerRecords.map(r => r.state).sort(), ["accepted", "reserved", "unknown"]);
  assert.equal(final.externalMessageRecords.length, 0); assert.equal(final.records.length, 3);
  assert.equal(f.rows.get("prior-accepted")!.state, "accepted"); assert.equal(f.rows.get("prior-unknown")!.state, "unknown");
  assert.equal(f.operations.filter(op => op === "reserve").length, 1);
});

for (const kind of ["accepted", "unknown", "unmatched", "duplicates", "foreign-reservation"] as const)
  test(`real runner independently holds ${kind} with external-only projection`, async () => {
    const f = await exerciseRunnerHistory(kind); assert.notEqual(f.result.state, "accepted", JSON.stringify(f.result));
    assert.equal(f.posts, 0);
    if (kind === "accepted" || kind === "unknown") {
      assert.ok(f.result.reasons.some(r => r.endsWith(`prior_attempt:${kind}`)), JSON.stringify(f.result));
      assert.equal(f.rows.get("prior")!.state, kind); assert.equal(f.result.reservationCreated, false);
    }
    if (kind === "foreign-reservation") assert.equal(f.result.reservationCreated, true);
  });
