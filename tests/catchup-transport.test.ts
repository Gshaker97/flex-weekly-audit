import test from "node:test";
import assert from "node:assert/strict";
import {
  CATCHUP_TRANSPORT_MODE, catchupTransportReadiness, createCatchupTransport,
} from "../lib/catchup-transport";
import {
  approveCatchupManifest, buildCatchupManifest, catchupRequestSha256,
  type CatchupApproval, type CatchupAttestation,
} from "../lib/catchup-attestation";
import { GHL_NOTIFICATION_CONTRACT, type GhlRequestDescriptor } from "../lib/notification-ghl-contract";
import { constructCatchupRequest } from "../lib/catchup-dispatch";
import { planCatchupBatch } from "../lib/catchup-plan";
import { parseGhlRecipient } from "../lib/notification-ghl-contract";
import { CATCHUP_PAY_LINK_HOST } from "../lib/catchup-copy";

const ACCOUNT = "flexx", LOCATION = "loc-1", CONTACT = "contact-abc123";
const PHONE = "+16025550100", EMAIL = "jessica@example.test", VER = "2021-07-28";
const CREDENTIAL = "test-credential-not-a-real-key";
const URL = GHL_NOTIFICATION_CONTRACT.baseUrl + GHL_NOTIFICATION_CONTRACT.sendPath;
const SCOPES = [GHL_NOTIFICATION_CONTRACT.writeScope];

/** A response the acceptance parser would be happy with. */
const ok = (status = 201, payload: unknown = { messageId: "m-1", conversationId: "c-1" }) => ({
  status,
  body: new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(payload))); controller.close(); },
  }),
});

/**
 * A descriptor shaped exactly like the contract's, for the negative cases.
 * The "a REAL constructed request..." test below proves the real one matches.
 */
const descriptor = (over: Partial<GhlRequestDescriptor> = {}, body = "hello"): GhlRequestDescriptor =>
  Object.freeze({
    method: "POST", url: URL,
    headers: Object.freeze({ Version: VER, "Content-Type": "application/json" }),
    body: Object.freeze({ status: "pending", message: body }),
    serializedBody: JSON.stringify({ status: "pending", message: body }),
    maximumAttempts: 1, automaticRetry: false, productionSendCapability: false,
    ...over,
  }) as GhlRequestDescriptor;

const attest = (d: GhlRequestDescriptor, over: Partial<CatchupAttestation> = {}): CatchupAttestation => ({
  requestSha256: catchupRequestSha256(d.serializedBody),
  channel: "sms", clientName: "Jessica Noonan", invoiceNumbers: ["7272"],
  balanceMinorTotal: 9000, daysPastDue: [8], destinationLast4: "0100",
  subject: null, body: "approved words", ...over,
});

function approvalFor(entries: CatchupAttestation[]): CatchupApproval {
  const m = buildCatchupManifest({
    preparedAt: "2026-11-24T16:45:00.000Z", sendDate: "2026-11-24",
    accountId: ACCOUNT, locationId: LOCATION,
    smsSender: "+16028548131", emailSender: "preston@flexxlandscaping.com", entries,
  });
  return approveCatchupManifest(m, m.manifestSha256).approval!;
}

const options = (approval: CatchupApproval, fetchImpl: unknown, over: Record<string, unknown> = {}) => ({
  mode: CATCHUP_TRANSPORT_MODE, fetch: fetchImpl as never, credential: CREDENTIAL,
  accountId: ACCOUNT, locationId: LOCATION, scopes: SCOPES, approval,
  now: () => new Date("2026-11-24T16:45:00.000Z"), ...over,
}) as never;

test("readiness names every missing piece, and claims nothing when empty", () => {
  const r = catchupTransportReadiness({});
  assert.equal(r.ready, false);
  for (const expected of ["explicit_transport_mode_required", "http_client_required", "clock_required",
    "credential_missing_or_malformed", "account_id_required", "location_id_required",
    "write_scope_required", "approved_manifest_required"]) {
    assert.ok(r.missing.includes(expected), `${expected} missing from ${r.missing.join(",")}`);
  }
  assert.equal(r.approvedMessages, 0);
});

test("WITHOUT THE EXPLICIT MODE IT IS NOT READY, even with a valid approval", () => {
  const d = descriptor();
  const approval = approvalFor([attest(d)]);
  const r = catchupTransportReadiness({ ...(options(approval, async () => ok()) as object), mode: undefined } as never);
  assert.equal(r.ready, false);
  assert.ok(r.missing.includes("explicit_transport_mode_required"));
});

test("the write scope is required, so a read-only credential cannot send", () => {
  const d = descriptor();
  const approval = approvalFor([attest(d)]);
  const r = catchupTransportReadiness(options(approval, async () => ok(), { scopes: ["contacts.readonly"] }));
  assert.equal(r.ready, false);
  assert.ok(r.missing.includes("write_scope_required"));
});

test("a manifest for another location is refused", () => {
  const d = descriptor();
  const approval = approvalFor([attest(d)]);
  const r = catchupTransportReadiness(options(approval, async () => ok(), { locationId: "someone-else" }));
  assert.equal(r.ready, false);
  assert.ok(r.missing.includes("manifest_location_mismatch"));
});

test("a bad configuration throws rather than silently not sending", () => {
  const d = descriptor();
  const approval = approvalFor([attest(d)]);
  assert.throws(() => createCatchupTransport(options(approval, async () => ok(), { mode: undefined })),
    /invalid_catchup_transport_configuration/);
});

test("AN UNATTESTED MESSAGE IS NOT SENT, and never reaches the network", async () => {
  const approved = descriptor({}, "approved");
  const sneaky = descriptor({}, "NOT approved");
  let calls = 0;
  const t = createCatchupTransport(options(approvalFor([attest(approved)]), async () => { calls += 1; return ok(); }));

  assert.equal(t.covers(sneaky), false);
  const observation = await t.attemptSend(sneaky);
  assert.equal(calls, 0, "no HTTP call was made");
  assert.equal(observation.statusCode, null);
  assert.equal(observation.body, null);
  assert.deepEqual(t.refused.map(r => r.reason), ["message_not_in_approved_manifest"]);
  assert.deepEqual([...t.attempted], []);
});

test("an attested message is posted exactly once and its observation returned", async () => {
  const d = descriptor({}, "approved");
  let calls = 0, sentBody = "";
  const t = createCatchupTransport(options(approvalFor([attest(d)]),
    async (_url: string, init: { body: string }) => { calls += 1; sentBody = init.body; return ok(); }));

  assert.equal(t.covers(d), true, "covers does not consume");
  assert.equal(t.covers(d), true);

  const observation = await t.attemptSend(d);
  assert.equal(calls, 1);
  assert.equal(sentBody, d.serializedBody, "the posted bytes are the approved bytes");
  assert.equal(observation.statusCode, 201);
  assert.equal(observation.version, VER);
  assert.deepEqual(observation.body, { messageId: "m-1", conversationId: "c-1" });
  assert.deepEqual([...t.attempted], [catchupRequestSha256(d.serializedBody)]);
});

test("THE SAME MESSAGE TWICE IS SENT ONCE", async () => {
  const d = descriptor({}, "approved");
  let calls = 0;
  const t = createCatchupTransport(options(approvalFor([attest(d)]), async () => { calls += 1; return ok(); }));

  await t.attemptSend(d);
  const second = await t.attemptSend(d);
  assert.equal(calls, 1, "the provider saw it once");
  assert.equal(second.statusCode, null);
  assert.deepEqual(t.refused.map(r => r.reason), ["message_already_attempted_under_this_approval"]);
});

test("a descriptor that is not the pinned send request is refused, unsent", async () => {
  const d = descriptor({}, "approved");
  const approval = approvalFor([attest(d)]);
  const cases: Array<[string, GhlRequestDescriptor]> = [
    ["descriptor_url_not_pinned_send_path", descriptor({ url: "https://example.test/send" }, "approved")],
    ["descriptor_method_not_post", descriptor({ method: "GET" as never }, "approved")],
    ["descriptor_version_mismatch", descriptor({ headers: Object.freeze({ Version: "2020-01-01", "Content-Type": "application/json" }) as never }, "approved")],
    ["descriptor_retry_policy_mismatch", descriptor({ automaticRetry: true as never }, "approved")],
    ["descriptor_status_not_pending", descriptor({ body: Object.freeze({ status: "sent" }) as never }, "approved")],
  ];
  for (const [reason, bad] of cases) {
    let calls = 0;
    const t = createCatchupTransport(options(approval, async () => { calls += 1; return ok(); }));
    const observation = await t.attemptSend(bad);
    assert.equal(calls, 0, `${reason}: nothing should be posted`);
    assert.equal(observation.statusCode, null);
    assert.deepEqual(t.refused.map(r => r.reason), [reason]);
  }
});

test("an oversized request is refused before it is posted", async () => {
  const huge = "x".repeat(70_000);
  const d = descriptor({}, huge);
  let calls = 0;
  const t = createCatchupTransport(options(approvalFor([attest(d)]), async () => { calls += 1; return ok(); }));
  const observation = await t.attemptSend(d);
  assert.equal(calls, 0);
  assert.equal(observation.statusCode, null);
  assert.deepEqual(t.refused.map(r => r.reason), ["request_byte_limit"]);
});

test("A TIMEOUT IS A FINAL UNCERTAIN OUTCOME, NOT A RETRY", async () => {
  const d = descriptor({}, "approved");
  let calls = 0;
  const t = createCatchupTransport(options(approvalFor([attest(d)]),
    async () => { calls += 1; return new Promise(() => {}) as never; }, { timeoutMs: 20 }));

  const observation = await t.attemptSend(d);
  assert.equal(calls, 1);
  assert.equal(observation.statusCode, null, "the outcome is unknown");
  assert.deepEqual([...t.attempted], [catchupRequestSha256(d.serializedBody)],
    "it counts as attempted, so nothing will try it again");
  // And it is spent: a second pass cannot quietly resend it.
  assert.equal(t.covers(d), false);
});

test("a thrown HTTP client is an unknown outcome, still not a retry", async () => {
  const d = descriptor({}, "approved");
  const t = createCatchupTransport(options(approvalFor([attest(d)]),
    async () => { throw new Error("socket closed"); }));
  const observation = await t.attemptSend(d);
  assert.equal(observation.statusCode, null);
  assert.equal(t.covers(d), false, "spent, because we do not know what the provider did");
});

test("a non-JSON response body yields unknown rather than a false success", async () => {
  const d = descriptor({}, "approved");
  const t = createCatchupTransport(options(approvalFor([attest(d)]), async () => ({
    status: 201,
    body: new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode("<html>nope</html>")); c.close(); },
    }),
  })));
  const observation = await t.attemptSend(d);
  assert.equal(observation.statusCode, null);
});

test("A REAL CONSTRUCTED REQUEST PASSES THE TRANSPORT'S OWN GUARDS", async () => {
  // The negative cases above use a hand-shaped descriptor. This one comes from
  // the real construction path, so if the contract's descriptor ever changes
  // shape this test fails instead of production silently refusing every message.
  const link = `https://${CATCHUP_PAY_LINK_HOST}/client_hubs/abc123/invoices/def456`;
  const plan = planCatchupBatch([{
    accountId: ACCOUNT, jobberClientId: "client-1", clientName: "Jessica Noonan",
    contactId: CONTACT, exactContactMatches: 1, phone: PHONE, email: EMAIL,
    smsOptedOut: false, emailOptedOut: false,
    invoices: [{ invoiceId: "inv-7272", invoiceNumber: "7272", balanceMinor: 9000,
      dueOn: "2026-11-17", payLink: link }],
  }], "2026-11-24");
  const action = plan.actions.find(a => a.state === "send");
  assert.ok(action && action.state === "send", "the fixture must plan a send");
  const send = action.sends.find(s => s.channel === "sms")!;

  const recipient = parseGhlRecipient({
    version: VER,
    body: { contact: { id: CONTACT, locationId: LOCATION, phone: PHONE, email: EMAIL, dndSettings: {} } },
    expected: { accountId: ACCOUNT, locationId: LOCATION, contactId: CONTACT, channel: "sms", destination: PHONE },
  });
  const constructed = constructCatchupRequest(action, send, {
    accountId: ACCOUNT, locationId: LOCATION,
    senderReview: { accountId: ACCOUNT, locationId: LOCATION, channel: "sms", sender: "+16028548131",
      scope: GHL_NOTIFICATION_CONTRACT.writeScope, approved: true, validated: true, evidenceRef: "r" },
    review: { mode: "reviewed-construction-only", version: VER, evidenceRef: "r",
      accountId: ACCOUNT, locationId: LOCATION, channel: "sms", proposedStatus: "pending" },
    recipient, scheduledOn: "2026-11-24",
    smsReceiptSuffixPolicy: { mode: "reviewed-exact-native-sms-suffix", version: VER, channel: "sms",
      source: "app", accountId: ACCOUNT, locationId: LOCATION, sender: "+16028548131",
      evidenceRef: "r", suffix: " Reply STOP to opt out." },
  } as never);

  assert.equal(constructed.state, "constructed", constructed.reasons.join(","));
  assert.ok(constructed.request);
  const real = constructed.request!;

  let calls = 0;
  const t = createCatchupTransport(options(approvalFor([attest(real, { body: action.body })]),
    async (_u: string, init: { body: string }) => { calls += 1; assert.equal(init.body, real.serializedBody); return ok(); }));
  assert.equal(t.covers(real), true, "the real descriptor must satisfy every guard");
  const observation = await t.attemptSend(real);
  assert.equal(calls, 1);
  assert.equal(observation.statusCode, 201);
  assert.deepEqual([...t.refused], []);
});
