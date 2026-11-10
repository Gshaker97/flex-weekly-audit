import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  GHL_NOTIFICATION_CONTRACT, parseGhlRecipient, buildGhlMessageRequest, parseGhlAcceptance,
  parseGhlMessageReceipt, parseGhlEmailReceipt, reconcileGhlReceipts, inspectGhlPrivateEvidence,
  createGhlReadOnlyReader, type GhlMessageBinding, type GhlConstructionInput, type GhlConstructionResult,
  type GhlHttpObservation, type GhlReadFetch, type GhlSmsReceiptSuffixPolicy,
} from "../lib/notification-ghl-contract";

const VERSION = "2021-07-28", BODY = "Synthetic invoice reminder. Never send this fixture.";
const NOW = "2026-11-09T17:00:00.000Z";
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const binding = (channel: "sms" | "email" = "sms"): GhlMessageBinding => ({
  accountId: "synthetic-account", locationId: "synthetic-location", contactId: "synthetic-contact", channel,
  destination: channel === "sms" ? "+16025550111" : "homeowner@example.test",
  sender: channel === "sms" ? "+16025550122" : "billing@example.test",
  eventKey: '["notification-v1","synthetic-account","invoice-1",10,"homeowner"]', invoiceId: "invoice-1", bodyHash: digest(BODY),
});
function contact(patch: Record<string, unknown> = {}) {
  return { contact: { id: "synthetic-contact", locationId: "synthetic-location", phone: "+16025550111",
    email: "homeowner@example.test", dnd: false, dndSettings: { SMS: { status: "inactive" }, Email: { status: "inactive" } }, ...patch } };
}
function input(channel: "sms" | "email" = "sms"): GhlConstructionInput {
  const b = binding(channel);
  return { binding: b, body: BODY, contentType: "text/plain", ...(channel === "email" ? { subject: "Synthetic reminder" } : {}),
    recipient: parseGhlRecipient({ version: VERSION, body: contact(), expected: b }),
    senderReview: { accountId: b.accountId, locationId: b.locationId, channel, sender: b.sender,
      scope: "conversations/message.write", approved: true, validated: true, evidenceRef: "synthetic-sender-review" },
    review: { mode: "reviewed-construction-only", version: VERSION, accountId: b.accountId,
      locationId: b.locationId, channel, proposedStatus: "pending", evidenceRef: "synthetic-contract-assumption" } };
}
const http = (body: unknown, statusCode: unknown = 200): GhlHttpObservation => ({ version: VERSION, statusCode, body });
function accepted(channel: "sms" | "email" = "sms", patch: Record<string, unknown> = {}) {
  return parseGhlAcceptance(buildGhlMessageRequest(input(channel)), http({ messageId: "message-1", conversationId: "conversation-1",
    ...(channel === "email" ? { emailMessageId: "individual-1" } : {}), ...patch }));
}
function message(status: unknown = "delivered", patch: Record<string, unknown> = {}) {
  return { id: "message-1", locationId: "synthetic-location", contactId: "synthetic-contact", conversationId: "conversation-1",
    messageType: "TYPE_SMS", type: 2, direction: "outbound", source: "api", body: BODY, contentType: "text/plain",
    dateAdded: "2026-11-09T16:59:59.000Z", from: "+16025550122", to: "+16025550111", status, ...patch };
}
function emailMessage(status: unknown = "delivered", patch: Record<string, unknown> = {}) {
  return { id: "individual-1", threadId: "message-1", locationId: "synthetic-location", contactId: "synthetic-contact",
    conversationId: "conversation-1", direction: "outbound", source: "api", body: BODY, contentType: "text/plain",
    dateAdded: "2026-11-09T16:59:59.000Z", from: "billing@example.test", to: ["homeowner@example.test"],
    subject: "Synthetic reminder", status, ...patch };
}

for (const channel of ["sms", "email"] as const) {
  test(`${channel}: exact contact and both suppression checks are required`, () => {
    const expected = binding(channel), key = channel === "sms" ? "SMS" : "Email";
    assert.equal(parseGhlRecipient({ version: VERSION, body: contact(), expected }).state, "allowed");
    for (const patch of [{ dnd: true }, { dndSettings: { [key]: { status: "active" } } }, { dndSettings: { [key]: { status: "permanent" } } }])
      assert.equal(parseGhlRecipient({ version: VERSION, body: contact(patch), expected }).state, "blocked");
    for (const patch of [{ dnd: undefined }, { dnd: "false" }, { dndSettings: undefined }, { dndSettings: {} },
      { dndSettings: { [key]: { status: "opted_in" } } }, { dndSettings: { [key]: { status: "inactive" }, [channel]: { status: "active" } } },
      { dndSettings: { [channel]: { status: "inactive" } } }, { id: undefined }, { locationId: undefined },
      { id: "wrong-contact" }, { locationId: "wrong-location" }])
      assert.notEqual(parseGhlRecipient({ version: VERSION, body: contact(patch), expected }).state, "allowed");
  });
  test(`${channel}: only the exact approved destination is selected; no fallback`, () => {
    const expected = binding(channel), field = channel === "sms" ? "phone" : "email";
    for (const value of [undefined, "", channel === "sms" ? "602-555-0111" : "Homeowner@example.test", "other@example.test"])
      assert.equal(parseGhlRecipient({ version: VERSION, body: contact({ [field]: value }), expected }).state, "held");
    const additionalField = channel === "sms" ? "additionalPhones" : "additionalEmails";
    assert.equal(parseGhlRecipient({ version: VERSION, body: contact({ [field]: "other", [additionalField]: [{ [field]: expected.destination }] }), expected }).state, "allowed");
    assert.equal(parseGhlRecipient({ version: VERSION, body: contact({ [additionalField]: [{}] }), expected }).state, "held");
  });
  test(`${channel}: documented global omission defaults false without inventing a channel default`, () => {
    const body = contact(), expected = binding(channel), key = channel === "sms" ? "SMS" : "Email";
    delete (body.contact as Record<string, unknown>).dnd;
    assert.equal(parseGhlRecipient({ version: VERSION, body, expected }).state, "allowed");
    for (const status of ["active", "permanent"]) {
      const blocked = { contact: { ...body.contact, dndSettings: { [key]: { status } } } };
      assert.equal(parseGhlRecipient({ version: VERSION, body: blocked, expected }).state, "blocked");
    }
    delete (body.contact as Record<string, unknown>).dndSettings;
    const missing = parseGhlRecipient({ version: VERSION, body, expected });
    assert.equal(missing.state, "held");
    assert.deepEqual(missing.reasons, ["channel_dnd_unknown"]);
    for (const malformed of [undefined, null, 0, "false"]) {
      const result = parseGhlRecipient({ version: VERSION, body: contact({ dnd: malformed }), expected });
      assert.equal(result.state, "held");
      assert.ok(result.reasons.includes("global_dnd_unknown"));
    }
  });
}

test("unversioned/lowercase and missing contact wrappers cannot be silently accepted", () => {
  for (const version of [undefined, null, "v3", "2023-02-21"])
    assert.equal(parseGhlRecipient({ version, body: contact(), expected: binding() }).state, "held");
  for (const body of [null, [], {}, contact().contact, { data: contact() }])
    assert.equal(parseGhlRecipient({ version: VERSION, body, expected: binding() }).state, "held");
});
test("inbound DND does not substitute for outbound suppression", () => {
  assert.equal(parseGhlRecipient({ version: VERSION, body: contact({ inboundDndSettings: { all: { status: "active" } } }), expected: binding() }).state, "allowed");
  assert.equal(parseGhlRecipient({ version: VERSION, body: contact({ dnd: undefined, dndSettings: undefined, inboundDndSettings: { all: { status: "inactive" } } }), expected: binding() }).state, "held");
});
test("malformed object accessors cannot become parsed facts", () => {
  const malicious = Object.defineProperty({}, "contact", { get() { throw new Error("must not read"); } });
  assert.equal(parseGhlRecipient({ version: VERSION, body: malicious, expected: binding() }).state, "held");
  assert.equal(parseGhlRecipient({ version: VERSION, body: contact(), expected: { ...binding(), destination: "+1 6025550111" } }).state, "held");
});
test("unreviewed contract is held by default; fabricated delivered/read requests are refused", () => {
  const value = input();
  assert.equal(buildGhlMessageRequest({ ...value, review: undefined }).state, "held");
  for (const proposedStatus of ["delivered", "read", "failed", undefined]) {
    const result = buildGhlMessageRequest({ ...value, review: { ...value.review!, proposedStatus } } as unknown as GhlConstructionInput);
    assert.equal(result.state, "held"); assert.equal(result.request, null);
  }
});
test("SMS descriptor is exact, immutable, credential-free and never executable", () => {
  const result = buildGhlMessageRequest(input());
  assert.equal(result.state, "constructed_disabled"); assert.equal(result.productionSendCapability, false);
  assert.deepEqual(result.request, { method: "POST", url: "https://services.leadconnectorhq.com/conversations/messages",
    headers: { Version: VERSION, "Content-Type": "application/json" }, body: { type: "SMS", contactId: "synthetic-contact",
      fromNumber: "+16025550122", toNumber: "+16025550111", message: BODY, status: "pending" },
    serializedBody: JSON.stringify({ type: "SMS", contactId: "synthetic-contact", fromNumber: "+16025550122", toNumber: "+16025550111", message: BODY, status: "pending" }),
    maximumAttempts: 1, automaticRetry: false, productionSendCapability: false });
  assert.ok(Object.isFrozen(result.request)); assert.ok(Object.isFrozen(result.request!.body));
  for (const key of ["invoiceId", "opportunityId", "appointmentId", "idempotencyKey", "scheduledTimestamp", "threadId", "attachments", "Authorization"])
    assert.equal(JSON.stringify(result.request).includes(`"${key}"`), false);
});
test("email text and HTML are exact independent channels, without CC/BCC or fallback", () => {
  const value = input("email"), textResult = buildGhlMessageRequest(value);
  assert.equal(textResult.request!.body.emailTo, value.binding.destination);
  assert.equal(textResult.request!.body.emailFrom, value.binding.sender);
  assert.equal(textResult.request!.body.type, "Email"); assert.equal(textResult.request!.body.message, BODY);
  const html = "<p>Synthetic &amp; exact</p>\n", htmlResult = buildGhlMessageRequest({ ...value, body: html,
    binding: { ...value.binding, bodyHash: digest(html) }, contentType: "text/html" });
  assert.equal(htmlResult.request!.body.html, html); assert.equal("message" in htmlResult.request!.body, false);
  assert.equal(buildGhlMessageRequest({ ...value, subject: undefined }).state, "held");
});
test("forged or cloned recipient permission, contact drift, sender drift and content drift all hold", () => {
  const value = input();
  const variants: GhlConstructionInput[] = [
    { ...value, recipient: { ...value.recipient } }, { ...value, binding: { ...value.binding, contactId: "wrong-contact" } },
    { ...value, binding: { ...value.binding, destination: "+16025550199" } }, { ...value, body: BODY + " " },
    { ...value, binding: { ...value.binding, sender: "+16025550199" } },
    { ...value, senderReview: { ...value.senderReview, locationId: "wrong-location" } },
    { ...value, senderReview: { ...value.senderReview, accountId: "wrong-account" } },
    { ...value, review: { ...value.review!, channel: "email" } },
  ];
  for (const variant of variants) assert.equal(buildGhlMessageRequest(variant).state, "held");
  for (const patch of [{ approved: false }, { validated: false }, { scope: "conversations/message.readonly" }, { evidenceRef: "" }])
    assert.equal(buildGhlMessageRequest({ ...value, senderReview: { ...value.senderReview, ...patch } } as unknown as GhlConstructionInput).state, "held");
});

test("acceptance is never delivery, and an individual email ID is not synthesized", () => {
  const result = accepted(); assert.equal(result.state, "accepted"); assert.equal(result.deliveryConfirmed, false);
  assert.equal(result.invoiceAttributionVerified, false); assert.equal(result.retryAllowed, false);
  const emailWithoutId = accepted("email", { emailMessageId: undefined });
  assert.equal(emailWithoutId.state, "accepted"); assert.equal(emailWithoutId.emailMessageId, null);
  assert.equal(parseGhlEmailReceipt(emailWithoutId, http(emailMessage()), NOW).state, "unknown");
});
test("malformed, unrecognized, rate-limited and uncertain acceptance never permits retries", () => {
  const request = buildGhlMessageRequest(input());
  for (const body of [null, {}, { id: "message-1" }, { messageId: "message-1" }, { messageId: [], conversationId: "conversation-1" },
    { messageId: "message-1", conversationId: "conversation-1", status: "delivered" },
    { messageId: "message-1", conversationId: "conversation-1", messageIds: ["message-1", "message-2"] },
    { messageId: "message-1", conversationId: "conversation-1", error: "failed" },
    { messageId: "message-1", conversationId: "conversation-1", emailMessageId: "email-1" }]) {
    const result = parseGhlAcceptance(request, http(body));
    assert.equal(result.state, "unknown"); assert.equal(result.retryAllowed, false); assert.equal(result.deliveryConfirmed, false);
  }
  for (const code of [202, 204, 302, 400, 401, 403, 429, 500, 503, undefined]) {
    const result = parseGhlAcceptance(request, { ...http({ messageId: "message-1", conversationId: "conversation-1" }), statusCode: code });
    assert.equal(result.state, "unknown"); assert.equal(result.retryAllowed, false);
  }
  assert.equal(parseGhlAcceptance({ ...request }, http({ messageId: "message-1", conversationId: "conversation-1" })).state, "unknown");
  assert.equal(accepted("email", { emailMessageId: "message-1" }).state, "unknown");
});
test("fake POST boundary records one inert exchange and does not auto-retry a timeout or 429", async () => {
  // Test-local simulator only. The library deliberately exports no callable POST transport.
  for (const outcome of ["timeout", 429, 500, 200] as const) {
    let exchanges = 0;
    const built = buildGhlMessageRequest(input());
    const fakeExchange = async (request: GhlConstructionResult["request"]) => {
      exchanges++; assert.equal(request?.method, "POST"); assert.equal(request?.automaticRetry, false);
      assert.equal(request?.maximumAttempts, 1);
      if (outcome === "timeout") throw new Error("synthetic lost acknowledgment");
      return http({ messageId: "message-1", conversationId: "conversation-1" }, outcome);
    };
    let response: GhlHttpObservation;
    try { response = await fakeExchange(built.request); } catch { response = http(null, 0); }
    const result = parseGhlAcceptance(built, response);
    assert.equal(exchanges, 1); assert.equal(result.retryAllowed, false); assert.equal(result.deliveryConfirmed, false);
  }
});

test("SMS delivery requires all exact exposed receipt identities", () => {
  const acceptance = accepted();
  assert.equal(parseGhlMessageReceipt(acceptance, http(message()), NOW).deliveryConfirmed, true);
  for (const key of ["id", "locationId", "contactId", "conversationId", "from", "to", "body", "messageType", "direction", "source", "contentType", "dateAdded", "type"])
    for (const value of [undefined, "forged"]) {
      const result = parseGhlMessageReceipt(acceptance, http(message("delivered", { [key]: value })), NOW);
      assert.equal(result.state, "unknown", key); assert.equal(result.deliveryConfirmed, false, key);
    }
  assert.equal(parseGhlMessageReceipt(acceptance, http(message("delivered", { messageType: "SMS" })), NOW).state, "unknown");
  assert.equal(parseGhlMessageReceipt(acceptance, http({ message: message() }), NOW).state, "unknown");
  assert.equal(parseGhlMessageReceipt({ ...acceptance }, http(message()), NOW).state, "unknown");
});
test("email requires individual ID, exact thread relationship, sender, singleton audience and subject", () => {
  const acceptance = accepted("email");
  assert.equal(parseGhlEmailReceipt(acceptance, http(emailMessage()), NOW).deliveryConfirmed, true);
  for (const patch of [{ id: "message-1" }, { threadId: undefined }, { threadId: "different-thread" }, { to: "homeowner@example.test" },
    { to: ["homeowner@example.test", "other@example.test"] }, { from: "Billing <billing@example.test>" },
    { cc: ["other@example.test"] }, { bcc: ["other@example.test"] }, { subject: "other subject" },
    { body: BODY + " " }, { attachments: ["https://example.test/attachment"] }, { locationId: undefined }, { contactId: "other-contact" }]) {
    const result = parseGhlEmailReceipt(acceptance, http(emailMessage("delivered", patch)), NOW);
    assert.equal(result.state, "unknown"); assert.equal(result.deliveryConfirmed, false);
  }
  assert.equal(parseGhlMessageReceipt(acceptance, http(message("delivered", { messageType: "TYPE_EMAIL", type: 3 })), NOW).state, "unknown");
  assert.equal(parseGhlEmailReceipt(accepted(), http(emailMessage()), NOW).state, "unknown");
});
test("pinned receipt version and response status are required", () => {
  const acceptance = accepted();
  for (const response of [{ ...http(message()), version: "v3" }, http(message(), 404), http(null), http([])])
    assert.equal(parseGhlMessageReceipt(acceptance, response, NOW).state, "unknown");
  assert.equal(parseGhlMessageReceipt(acceptance, http(message()), "invalid").state, "unknown");
  assert.equal(parseGhlMessageReceipt(acceptance, http(message("delivered", { dateAdded: "2027-01-01T00:00:00Z" })), NOW).state, "unknown");
});
test("raw statuses retain channel-specific meaning, including known non-delivery statuses", () => {
  const sms = accepted(), email = accepted("email");
  for (const [status, state] of Object.entries({ pending: "pending", scheduled: "pending", sent: "sent", delivered: "delivered",
    failed: "failed", undelivered: "failed", opt_out: "suppressed", connected: "unknown", read: "unknown", opened: "unknown", clicked: "unknown", accepted: "unknown" })) {
    const result = parseGhlMessageReceipt(sms, http(message(status)), NOW);
    assert.equal(result.state, state, status); assert.equal(result.deliveryConfirmed, status === "delivered", status);
  }
  for (const status of ["opened", "read"]) {
    const result = parseGhlEmailReceipt(email, http(emailMessage(status)), NOW);
    assert.equal(result.state, "engagement"); assert.equal(result.deliveryConfirmed, false);
  }
  for (const status of ["clicked", "opt_out", "connected", "accepted", undefined, null, 123, { delivered: true }])
    assert.equal(parseGhlEmailReceipt(email, http(emailMessage("delivered", { status })), NOW).state, "unknown");
});
test("raw error/status is preserved privately, not serialized or turned into successful delivery", () => {
  const acceptance = accepted(), rawError = "Synthetic provider failure: exact diagnostic / untouched";
  const failed = parseGhlMessageReceipt(acceptance, http(message("failed", { error: rawError })), NOW);
  assert.equal(failed.state, "failed"); assert.equal(inspectGhlPrivateEvidence(failed)!.rawError, rawError);
  assert.equal(JSON.stringify(failed).includes(rawError), false);
  const conflicting = parseGhlMessageReceipt(acceptance, http(message("delivered", { error: rawError })), NOW);
  assert.equal(conflicting.state, "unknown"); assert.equal(conflicting.deliveryConfirmed, false);
  assert.equal(inspectGhlPrivateEvidence(conflicting)!.rawStatus, "delivered");
  const malformed = parseGhlMessageReceipt(acceptance, http(message("delivered", { error: { detail: "raw object" } })), NOW);
  assert.equal(malformed.state, "unknown"); assert.deepEqual(inspectGhlPrivateEvidence(malformed)!.rawError, { detail: "raw object" });
});
test("body matches never assert invoice attribution", () => {
  const result = parseGhlMessageReceipt(accepted(), http(message()), NOW);
  assert.equal(result.deliveryConfirmed, true); assert.equal(result.invoiceAttributionVerified, false);
});
test("delayed receipt can progress from pending to delivered without resending", () => {
  const acceptance = accepted();
  const pending = parseGhlMessageReceipt(acceptance, http(message("pending")), NOW);
  const sent = parseGhlMessageReceipt(acceptance, http(message("sent")), "2026-11-09T17:01:00.000Z");
  const delivered = parseGhlMessageReceipt(acceptance, http(message()), "2026-11-09T17:02:00.000Z");
  const result = reconcileGhlReceipts([pending, sent, delivered]);
  assert.equal(result.state, "delivered"); assert.equal(result.deliveryConfirmed, true); assert.equal(result.retryAllowed, false);
  const failed = parseGhlMessageReceipt(acceptance, http(message("failed")), "2026-11-09T17:03:00.000Z");
  assert.equal(reconcileGhlReceipts([pending, sent, failed]).state, "failed");
  assert.equal(reconcileGhlReceipts([delivered, failed]).state, "unknown");
});
test("conflicts, regression, missing observations, forged results and wrong acceptance cannot be washed away", () => {
  const acceptance = accepted(), delivered = parseGhlMessageReceipt(acceptance, http(message()), NOW);
  const pending = parseGhlMessageReceipt(acceptance, http(message("pending")), "2026-11-09T17:01:00.000Z");
  const wrong = parseGhlMessageReceipt(acceptance, http(message("delivered", { contactId: "wrong-contact" })), "2026-11-09T16:59:59.500Z");
  const different = parseGhlMessageReceipt(accepted(), http(message()), "2026-11-09T17:02:00.000Z");
  for (const observations of [[], [delivered, pending], [pending, delivered], [wrong, delivered], [{ ...delivered }], [delivered, different]]) {
    const result = reconcileGhlReceipts(observations);
    assert.equal(result.state, "unknown"); assert.equal(result.deliveryConfirmed, false); assert.equal(result.retryAllowed, false);
  }
});

function fakeResponse(body: unknown, status = 200, raw = false): Awaited<ReturnType<GhlReadFetch>> {
  const data = new TextEncoder().encode(raw ? body as string : JSON.stringify(body));
  return { status, body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(data); controller.close(); } }) };
}
function reader(fetch: GhlReadFetch, patch: Record<string, unknown> = {}) {
  return createGhlReadOnlyReader({ fetch, credential: "synthetic-fake-token", accountId: "synthetic-account", locationId: "synthetic-location",
    scopes: ["contacts.readonly", "conversations/message.readonly"], now: () => new Date(NOW), ...patch });
}
test("GET-only contact and SMS/email receipt readers pin URL, version, credentials and redirect policy", async () => {
  const calls: Array<{ url: string; init: Parameters<GhlReadFetch>[1] }> = [];
  const fake: GhlReadFetch = async (url, init) => {
    calls.push({ url, init });
    return fakeResponse(url.includes("/contacts/") ? contact() : url.includes("/email/") ? emailMessage() : message());
  };
  const reads = reader(fake);
  assert.equal(calls.length, 0);
  assert.equal((await reads.readContact(binding())).state, "allowed");
  assert.equal((await reads.readMessageReceipt(accepted())).state, "delivered");
  assert.equal((await reads.readEmailReceipt(accepted("email"))).state, "delivered");
  assert.deepEqual(calls.map(call => call.url), ["https://services.leadconnectorhq.com/contacts/synthetic-contact",
    "https://services.leadconnectorhq.com/conversations/messages/message-1", "https://services.leadconnectorhq.com/conversations/messages/email/individual-1"]);
  for (const { init } of calls) {
    assert.equal(init.method, "GET"); assert.equal(init.redirect, "error"); assert.equal(init.headers.Version, VERSION);
    assert.equal(init.headers.Authorization, "Bearer synthetic-fake-token"); assert.equal(init.headers.Accept, "application/json");
    assert.ok(init.signal instanceof AbortSignal);
  }
  assert.equal(reads.productionSendCapability, false);
});
test("GET scope, account, invalid ID, wrong receipt channel and forged acceptance stop before HTTP", async () => {
  let calls = 0;
  const fake: GhlReadFetch = async () => { calls++; throw new Error("must not be called"); };
  const reads = reader(fake);
  for (const expected of [{ ...binding(), contactId: "../other?token=x" }, { ...binding(), accountId: "other" }, { ...binding(), locationId: "other" }])
    assert.equal((await reads.readContact(expected)).state, "held");
  assert.equal((await reader(fake, { scopes: [] }).readContact(binding())).state, "held");
  assert.equal((await reader(fake, { scopes: [] }).readMessageReceipt(accepted())).state, "unknown");
  assert.equal((await reads.readEmailReceipt(accepted())).state, "unknown");
  assert.equal((await reads.readMessageReceipt(accepted("email"))).state, "unknown");
  assert.equal((await reads.readEmailReceipt(accepted("email", { emailMessageId: undefined }))).state, "unknown");
  assert.equal((await reads.readMessageReceipt({ ...accepted() })).state, "unknown");
  assert.equal(calls, 0);
});
test("GET errors, redirects, malformed JSON and rate limits are held with one attempt and no secret leaks", async () => {
  for (const fault of ["throw", "json", "large", 301, 429, 500] as const) {
    let calls = 0;
    const fake: GhlReadFetch = async () => {
      calls++;
      if (fault === "throw") throw new Error("synthetic-fake-token private response");
      return fakeResponse(fault === "json" ? "not JSON" : fault === "large" ? " ".repeat(2_000_001) : JSON.stringify(contact()),
        typeof fault === "number" ? fault : 200, true);
    };
    const result = await reader(fake).readContact(binding());
    assert.equal(result.state, "held"); assert.equal(calls, 1); assert.equal(JSON.stringify(result).includes("synthetic-fake-token"), false);
  }
});
test("GET deadline aborts an unresponsive injected client, holds, and never retries", async () => {
  let calls = 0, signal: AbortSignal | undefined;
  const fake: GhlReadFetch = async (_url, init) => { calls++; signal = init.signal; return await new Promise(() => {}); };
  const result = await reader(fake, { timeoutMs: 5 }).readContact(binding());
  assert.equal(result.state, "held"); assert.equal(calls, 1); assert.equal(signal!.aborted, true);
});
test("configuration and recipient inputs are snapshotted across asynchronous read", async () => {
  let resolve!: (response: Awaited<ReturnType<GhlReadFetch>>) => void;
  const fake: GhlReadFetch = () => new Promise(done => { resolve = done; });
  const expected = { ...binding() }, pending = reader(fake).readContact(expected);
  expected.contactId = "mutated-contact"; expected.destination = "+16025550199";
  resolve(fakeResponse(contact()));
  assert.equal((await pending).state, "allowed");
});
test("no production sender, credential imports, global fetch, retry loop, application wiring or automatic scheduling is added", () => {
  const source = readFileSync(new URL("../lib/notification-ghl-contract.ts", import.meta.url), "utf8");
  assert.equal(/process\.env|globalThis\.fetch|import\s.*(?:ghl|prisma|notification-dispatch|notification-ledger)/.test(source), false);
  assert.equal(/fetch\([^\n]*method:\s*["']POST/.test(source), false);
  assert.equal(/productionSendCapability:\s*true/.test(source), false);
  assert.deepEqual(GHL_NOTIFICATION_CONTRACT, { baseUrl: "https://services.leadconnectorhq.com", version: VERSION,
    sendPath: "/conversations/messages", writeScope: "conversations/message.write", productionSendCapability: false, automaticRetry: false, maximumAttempts: 1 });
});

test("GET streaming read aborts and cancels at the byte cap without consuming the entire response", async () => {
  let reads = 0, cancellations = 0, signal: AbortSignal | undefined;
  const fake: GhlReadFetch = async (_url, init) => {
    signal = init.signal;
    return { status: 200, body: { getReader: () => ({
      read: async () => { reads++; return { done: false, value: new Uint8Array(1_000_001) }; },
      cancel: async () => { cancellations++; },
    }) } };
  };
  assert.equal((await reader(fake).readContact(binding())).state, "held");
  assert.equal(reads, 2); assert.equal(cancellations, 1); assert.equal(signal!.aborted, true);
});
test("GET cannot fall back to unbounded text(), absent streams, malformed UTF-8 or stalled body", async () => {
  const absent: GhlReadFetch = async () => ({ status: 200, body: null });
  assert.equal((await reader(absent).readContact(binding())).state, "held");
  const utf8: GhlReadFetch = async () => ({ status: 200, body: new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([0xff, 0xff])); controller.close(); },
  }) });
  assert.equal((await reader(utf8).readContact(binding())).state, "held");
  let aborted: AbortSignal | undefined;
  const stalled: GhlReadFetch = async (_url, init) => { aborted = init.signal;
    return { status: 200, body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => {} }) } };
  };
  assert.equal((await reader(stalled, { timeoutMs: 5 }).readContact(binding())).state, "held");
  assert.equal(aborted!.aborted, true);
});

test("known non-SMS numeric types and rolled-over calendar timestamps cannot establish delivery", () => {
  const acceptance = accepted();
  for (const type of [1, 3, 10])
    assert.equal(parseGhlMessageReceipt(acceptance, http(message("delivered", { type })), NOW).state, "unknown");
  assert.equal(parseGhlMessageReceipt(acceptance, http(message("delivered", { dateAdded: "2026-02-30T00:00:00Z" })), NOW).state, "unknown");
});


// Synthetic values only. Shape mirrors the observed native SMS response, not its private content.
const SYNTHETIC_SUFFIX = "\nReply STOP to unsubscribe.\nThanks, Example Service";
function suffixPolicy(patch: Record<string, unknown> = {}): GhlSmsReceiptSuffixPolicy {
  const b = binding();
  return { mode: "reviewed-exact-native-sms-suffix", version: VERSION, channel: "sms", source: "app",
    accountId: b.accountId, locationId: b.locationId, sender: b.sender,
    suffix: SYNTHETIC_SUFFIX, evidenceRef: "synthetic-separately-trusted-suffix-evidence", ...patch } as GhlSmsReceiptSuffixPolicy;
}
function nativeMessage(patch: Record<string, unknown> = {}) {
  return { message: message("delivered", { source: "app", altId: "synthetic-provider-alt-id", attachments: [],
    dateUpdated: "2026-11-09T16:59:59.500Z", ...patch }), traceId: "synthetic-trace-id" };
}
function nativeAcceptance(policy?: GhlSmsReceiptSuffixPolicy) {
  const built = buildGhlMessageRequest({ ...input(), smsReceiptSuffixPolicy: policy });
  return parseGhlAcceptance(built, http({ messageId: "message-1", conversationId: "conversation-1" }, 201));
}
test("native SMS 201 and existing 200 mean acceptance only; Email 201 is still unverified", () => {
  for (const status of [200, 201]) {
    const result = parseGhlAcceptance(buildGhlMessageRequest(input()), http({ messageId: "message-1", conversationId: "conversation-1" }, status));
    assert.equal(result.state, "accepted"); assert.equal(result.deliveryConfirmed, false);
    assert.equal(result.retryAllowed, false); assert.equal(result.invoiceAttributionVerified, false);
  }
  const result = parseGhlAcceptance(buildGhlMessageRequest(input("email")), http({ messageId: "message-1", conversationId: "conversation-1" }, 201));
  assert.equal(result.state, "unknown"); assert.equal(result.retryAllowed, false);
});
test("201 cannot wash away bad IDs, error outcomes, aliases, wrong version or an unbound construction", () => {
  const built = buildGhlMessageRequest(input()), valid = { messageId: "message-1", conversationId: "conversation-1" };
  for (const patch of [{ messageId: undefined }, { messageId: [] }, { conversationId: "" }, { status: "pending" },
    { error: "synthetic failure" }, { error: null }, { success: true }, { messageIds: ["message-1"] },
    { emailMessageId: "individual-1" }, { id: "other-message" }, { message_id: "other-message" },
    { conversation_id: "other-conversation" }, { accountId: "other-account" }, { locationId: "other-location" },
    { contactId: "other-contact" }, { from: "+16025550199" }, { toNumber: "+16025550199" },
    { message: valid }, { data: valid }]) {
    const result = parseGhlAcceptance(built, http({ ...valid, ...patch }, 201));
    assert.equal(result.state, "unknown", JSON.stringify(patch)); assert.equal(result.retryAllowed, false);
    assert.equal(result.deliveryConfirmed, false);
  }
  for (const body of [null, [], {}, { message: valid }, { data: valid }])
    assert.equal(parseGhlAcceptance(built, http(body, 201)).state, "unknown");
  assert.equal(parseGhlAcceptance({ ...built }, http(valid, 201)).state, "unknown");
  assert.equal(parseGhlAcceptance(built, { ...http(valid, 201), version: "wrong" }).state, "unknown");
});
test("observed native SMS envelope preserves exact identity and does not invent missing fields", () => {
  const acceptance = nativeAcceptance();
  const result = parseGhlMessageReceipt(acceptance, http(nativeMessage()), NOW);
  assert.equal(result.state, "delivered"); assert.equal(result.identityMatched, true);
  assert.equal(result.deliveryConfirmed, true); assert.equal(result.invoiceAttributionVerified, false);
  for (const key of ["id", "locationId", "contactId", "conversationId", "from", "to", "contentType", "dateAdded", "messageType", "type", "source", "direction", "body"]) {
    const missing = nativeMessage(); delete (missing.message as Record<string, unknown>)[key];
    const parsed = parseGhlMessageReceipt(acceptance, http(missing), NOW);
    assert.equal(parsed.state, "unknown", key); assert.equal(parsed.deliveryConfirmed, false, key);
  }
  for (const patch of [{ type: 3 }, { type: 99 }, { source: "api" }, { source: "workflow" }, { source: "unknown" },
    { direction: "inbound" }, { messageType: "SMS" }, { dateUpdated: null }, { dateUpdated: "invalid" },
    { dateUpdated: "2026-11-09T17:00:01.000Z" }, { dateUpdated: "2026-11-09T16:59:58.000Z" }])
    assert.equal(parseGhlMessageReceipt(acceptance, http(nativeMessage(patch)), NOW).state, "unknown");
  assert.equal(parseGhlMessageReceipt(acceptance, http(message("delivered", { source: "app" })), NOW).state, "unknown");
});
test("native envelope is unambiguous and SMS-only; malformed or competing roots never win", () => {
  const acceptance = nativeAcceptance(), valid = nativeMessage();
  for (const body of [{ message: null, traceId: "trace" }, { message: [], traceId: "trace" },
    { message: { message: valid.message }, traceId: "trace" }, { message: valid.message },
    { ...valid, traceId: null }, { ...valid, traceId: "" }, { ...valid, id: "other-message" },
    { ...valid, status: "failed" }, { ...valid, error: "synthetic error" }, { ...valid, data: valid.message },
    { ...valid.message, message: valid.message }, { ...valid.message, data: valid.message },
    { ...valid, message: { ...valid.message, result: valid.message } }]) {
    const result = parseGhlMessageReceipt(acceptance, http(body), NOW);
    assert.equal(result.state, "unknown"); assert.equal(result.deliveryConfirmed, false);
  }
  assert.equal(parseGhlEmailReceipt(accepted("email"), http({ message: emailMessage(), traceId: "trace" }), NOW).state, "unknown");
  assert.equal(parseGhlMessageReceipt({ ...acceptance }, http(valid), NOW).deliveryConfirmed, false);
  const malformed = Object.defineProperty({}, "message", { get() { throw new Error("must not read"); } });
  assert.equal(parseGhlMessageReceipt(acceptance, http(malformed), NOW).state, "unknown");
});
test("all exposed receipt identity aliases must agree without filling absent canonical fields", () => {
  const acceptance = nativeAcceptance();
  const aliases: Record<string, unknown> = { messageId: "message-1", message_id: "message-1", _id: "message-1",
    accountId: "synthetic-account", account_id: "synthetic-account", location_id: "synthetic-location",
    contact_id: "synthetic-contact", conversation_id: "conversation-1", fromNumber: "+16025550122", toNumber: "+16025550111" };
  assert.equal(parseGhlMessageReceipt(acceptance, http(nativeMessage(aliases)), NOW).state, "delivered");
  for (const key of Object.keys(aliases)) {
    assert.equal(parseGhlMessageReceipt(acceptance, http(nativeMessage({ [key]: "mismatch" })), NOW).state, "unknown", key);
    assert.equal(parseGhlMessageReceipt(acceptance, http(nativeMessage({ [key]: null })), NOW).state, "unknown", key);
  }
  assert.equal(parseGhlMessageReceipt(acceptance, http(nativeMessage({ id: undefined, messageId: "message-1" })), NOW).state, "unknown");
});
test("body stays exact by default; separately trusted exact bound suffix policy permits only the reviewed full hash", () => {
  const observedBody = BODY + SYNTHETIC_SUFFIX;
  assert.equal(parseGhlMessageReceipt(nativeAcceptance(), http(nativeMessage({ body: observedBody })), NOW).state, "unknown");
  const acceptance = nativeAcceptance(suffixPolicy());
  assert.equal(parseGhlMessageReceipt(acceptance, http(nativeMessage()), NOW).state, "delivered");
  assert.equal(parseGhlMessageReceipt(acceptance, http(nativeMessage({ body: observedBody })), NOW).state, "delivered");
  for (const body of [observedBody + " extra", observedBody + "\n", observedBody.replace("STOP", "START"),
    observedBody.replace("Example Service", "Other Service"), BODY + "\n" + SYNTHETIC_SUFFIX, BODY + SYNTHETIC_SUFFIX + SYNTHETIC_SUFFIX,
    BODY + "changed" + SYNTHETIC_SUFFIX, "prefix" + observedBody, BODY.slice(1) + SYNTHETIC_SUFFIX]) {
    const result = parseGhlMessageReceipt(acceptance, http(nativeMessage({ body })), NOW);
    assert.equal(result.state, "unknown"); assert.equal(result.deliveryConfirmed, false); assert.equal(result.retryAllowed, false);
  }
  assert.equal(parseGhlMessageReceipt(acceptance, http(message("delivered", { body: observedBody })), NOW).state, "unknown");
});
test("suffix policy is frozen and account/location/sender bound, never content or send authorization", () => {
  for (const patch of [{ accountId: "wrong" }, { locationId: "wrong" }, { sender: "+16025550199" }, { channel: "email" },
    { source: "api" }, { mode: "guess" }, { version: "wrong" }, { evidenceRef: "" }, { suffix: "" }, { suffix: "\n" }, { suffix: null }])
    assert.equal(buildGhlMessageRequest({ ...input(), smsReceiptSuffixPolicy: suffixPolicy(patch) }).state, "held", JSON.stringify(patch));
  assert.equal(buildGhlMessageRequest({ ...input("email"), smsReceiptSuffixPolicy: suffixPolicy() }).state, "held");
  assert.equal(buildGhlMessageRequest({ ...input(), review: undefined, smsReceiptSuffixPolicy: suffixPolicy() }).state, "held");
  assert.equal(buildGhlMessageRequest({ ...input(), recipient: { ...input().recipient }, smsReceiptSuffixPolicy: suffixPolicy() }).state, "held");
  const policy = { ...suffixPolicy() }, built = buildGhlMessageRequest({ ...input(), smsReceiptSuffixPolicy: policy });
  assert.deepEqual(built.request, buildGhlMessageRequest(input()).request);
  assert.equal(built.productionSendCapability, false); assert.equal(built.request!.body.message, BODY);
  policy.suffix = "mutated"; policy.accountId = "changed";
  const acceptance = parseGhlAcceptance(built, http({ messageId: "message-1", conversationId: "conversation-1" }, 201));
  assert.equal(parseGhlMessageReceipt(acceptance, http(nativeMessage({ body: BODY + SYNTHETIC_SUFFIX })), NOW).state, "delivered");
  assert.equal(parseGhlMessageReceipt(acceptance, http(nativeMessage({ body: BODY + "mutated" })), NOW).state, "unknown");
});
test("unmodified native receipt body and errors are retained privately even when a suffix is rejected", () => {
  const rawBody = BODY + SYNTHETIC_SUFFIX + " unexpected", inputBody = nativeMessage({ body: rawBody, status: "delivered", error: "synthetic error" });
  const result = parseGhlMessageReceipt(nativeAcceptance(suffixPolicy()), http(inputBody), NOW);
  assert.equal(result.state, "unknown"); assert.equal(result.retryAllowed, false);
  const evidence = inspectGhlPrivateEvidence(result)!;
  assert.equal(evidence.rawBody, rawBody); assert.equal(evidence.rawStatus, "delivered"); assert.equal(evidence.rawError, "synthetic error");
  inputBody.message.body = "mutated";
  assert.equal(evidence.rawBody, rawBody); assert.equal(JSON.stringify(result).includes(rawBody), false);
});
test("GET-only reader accepts observed SMS shape without granting retry or altering raw evidence", async () => {
  let calls = 0;
  const rawBody = BODY + SYNTHETIC_SUFFIX;
  const fake: GhlReadFetch = async () => { calls++; return fakeResponse(nativeMessage({ body: rawBody })); };
  const result = await reader(fake).readMessageReceipt(nativeAcceptance(suffixPolicy()));
  assert.equal(result.state, "delivered"); assert.equal(calls, 1); assert.equal(result.retryAllowed, false);
  assert.equal(inspectGhlPrivateEvidence(result)!.rawBody, rawBody);
  assert.equal((await reader(fake, { accountId: "wrong" }).readMessageReceipt(nativeAcceptance(suffixPolicy()))).state, "unknown");
  assert.equal(calls, 1);
});
