import test from "node:test";
import assert from "node:assert/strict";
import { assembleCatchupSenders } from "../lib/catchup-senders";
import {
  approveCatchupManifest, buildCatchupManifest, catchupRequestSha256,
  type CatchupApproval, type CatchupAttestation,
} from "../lib/catchup-attestation";
import { CATCHUP_EMAIL_SENDER, CATCHUP_SMS_SENDER } from "../lib/catchup-sender-policy";
import { CATCHUP_SMS_SUFFIX } from "../lib/catchup-copy";

const ACCOUNT = "flexx", LOCATION = "loc-1";
const SCOPE = { accountId: ACCOUNT, locationId: LOCATION };

const entry: CatchupAttestation = Object.freeze({
  requestSha256: catchupRequestSha256('{"status":"pending","message":"hi"}'),
  channel: "sms", clientName: "Jessica Noonan", invoiceNumbers: ["7272"],
  balanceMinorTotal: 9000, daysPastDue: [8], destinationLast4: "0100",
  subject: null, body: "hi",
});

function approvalWith(over: Record<string, unknown> = {}): { approval: CatchupApproval; hash: string } {
  const m = buildCatchupManifest({
    preparedAt: "2026-11-24T16:45:00.000Z", sendDate: "2026-11-24",
    accountId: ACCOUNT, locationId: LOCATION,
    smsSender: CATCHUP_SMS_SENDER.number, emailSender: CATCHUP_EMAIL_SENDER.address,
    entries: [entry], ...over,
  } as never);
  return { approval: approveCatchupManifest(m, m.manifestSha256).approval!, hash: m.manifestSha256 };
}

test("an approved manifest assembles both reviewed senders", () => {
  const { approval, hash } = approvalWith();
  const a = assembleCatchupSenders(approval, SCOPE);
  assert.equal(a.state, "assembled", a.reasons.join(","));
  assert.ok(a.senders);
  assert.equal(a.senders?.sms.senderReview.sender, CATCHUP_SMS_SENDER.number);
  assert.equal(a.senders?.email.senderReview.sender, CATCHUP_EMAIL_SENDER.address);
  assert.equal(a.senders?.sms.senderReview.approved, true);
  assert.equal(a.senders?.sms.senderReview.validated, true);
  assert.equal(a.senders?.email.senderReview.channel, "email");
  assert.equal((a.senders?.sms.smsReceiptSuffixPolicy as { suffix: string }).suffix, CATCHUP_SMS_SUFFIX);
  // Traceable: every review names the approval it came from.
  assert.equal(a.senders?.sms.senderReview.evidenceRef, `catchup-manifest:${hash}`);
  assert.equal(a.senders?.email.review.evidenceRef, `catchup-manifest:${hash}`);
});

test("THE UNVERIFIED EMAIL DOMAIN IS REPORTED, NOT HIDDEN AND NOT ENFORCED", () => {
  const { approval } = approvalWith();
  const a = assembleCatchupSenders(approval, SCOPE);
  assert.equal(a.emailSendingDomainVerified, CATCHUP_EMAIL_SENDER.sendingDomainVerified);
  assert.equal(a.emailSendingDomainVerified, false, "nothing has proven the domain yet");
  assert.equal(a.state, "assembled", "and that does not block assembly - it is a deliverability fact");
});

test("A MANIFEST NAMING A DIFFERENT SENDER IS REFUSED", () => {
  // The pinned policy is the second end of the chain: an edited manifest cannot
  // introduce a sender nobody chose.
  const sms = assembleCatchupSenders(approvalWith({ smsSender: "+15555550123" }).approval, SCOPE);
  assert.equal(sms.state, "held");
  assert.ok(sms.reasons.includes("manifest_sms_sender_is_not_the_pinned_sender"), sms.reasons.join(","));

  const email = assembleCatchupSenders(approvalWith({ emailSender: "someone@elsewhere.test" }).approval, SCOPE);
  assert.equal(email.state, "held");
  assert.ok(email.reasons.includes("manifest_email_sender_is_not_the_pinned_sender"), email.reasons.join(","));
});

test("a manifest for another account or location is refused", () => {
  const { approval } = approvalWith();
  const wrongAccount = assembleCatchupSenders(approval, { accountId: "someone-else", locationId: LOCATION });
  assert.equal(wrongAccount.state, "held");
  assert.ok(wrongAccount.reasons.includes("manifest_account_mismatch"));

  const wrongLocation = assembleCatchupSenders(approval, { accountId: ACCOUNT, locationId: "other-loc" });
  assert.equal(wrongLocation.state, "held");
  assert.ok(wrongLocation.reasons.includes("manifest_location_mismatch"));
});

test("a forged approval assembles nothing", () => {
  const forged = Object.freeze({ kind: "catchup-approved-manifest" }) as unknown as CatchupApproval;
  const a = assembleCatchupSenders(forged, SCOPE);
  assert.equal(a.state, "held");
  assert.equal(a.senders, null);
  assert.ok(a.reasons.includes("approval_not_recognized"));
});

test("a missing scope is refused rather than guessed", () => {
  const { approval } = approvalWith();
  const a = assembleCatchupSenders(approval, { accountId: "", locationId: "" });
  assert.equal(a.state, "held");
  assert.ok(a.reasons.includes("account_id_required"));
  assert.ok(a.reasons.includes("location_id_required"));
});

test("THE REQUEST BYTES ARE THE SAME AT PREPARE TIME AND AT SEND TIME", async () => {
  // The linchpin. The manifest records the hash of a request constructed with
  // the PREPARATION senders; the transport checks the hash of one constructed
  // with the APPROVED senders. If the review refs leaked into the wire body
  // those hashes would differ and every approved message would be refused.
  const { constructCatchupRequest } = await import("../lib/catchup-dispatch");
  const { planCatchupBatch } = await import("../lib/catchup-plan");
  const { parseGhlRecipient } = await import("../lib/notification-ghl-contract");
  const { CATCHUP_PAY_LINK_HOST } = await import("../lib/catchup-copy");
  const { catchupPreparationSenders } = await import("../lib/catchup-senders");

  const CONTACT = "contact-abc123", PHONE = "+16025550100", EMAIL = "jessica@example.test";
  const plan = planCatchupBatch([{
    accountId: ACCOUNT, jobberClientId: "client-1", clientName: "Jessica Noonan",
    contactId: CONTACT, exactContactMatches: 1, phone: PHONE, email: EMAIL,
    smsOptedOut: false, emailOptedOut: false,
    invoices: [{ invoiceId: "inv-7272", invoiceNumber: "7272", balanceMinor: 9000, dueOn: "2026-11-17",
      payLink: `https://${CATCHUP_PAY_LINK_HOST}/client_hubs/abc123/invoices/def456` }],
  }], "2026-11-24");
  const action = plan.actions.find(a => a.state === "send")!;
  assert.ok(action.state === "send");

  const recipient = (channel: "sms" | "email") => parseGhlRecipient({
    version: "2021-07-28",
    body: { contact: { id: CONTACT, locationId: LOCATION, phone: PHONE, email: EMAIL, dndSettings: {} } },
    expected: { accountId: ACCOUNT, locationId: LOCATION, contactId: CONTACT, channel,
      destination: channel === "sms" ? PHONE : EMAIL },
  });

  const prep = catchupPreparationSenders(SCOPE);
  const approved = assembleCatchupSenders(approvalWith().approval, SCOPE).senders!;

  for (const send of action.sends) {
    const ch = send.channel as "sms" | "email";
    const ctx = (s: typeof prep) => ({
      accountId: ACCOUNT, locationId: LOCATION,
      senderReview: ch === "sms" ? s.sms.senderReview : s.email.senderReview,
      review: ch === "sms" ? s.sms.review : s.email.review,
      recipient: recipient(ch), scheduledOn: "2026-11-24",
      ...(ch === "sms" ? { smsReceiptSuffixPolicy: s.sms.smsReceiptSuffixPolicy } : {}),
    });
    const a = constructCatchupRequest(action, send, ctx(prep) as never);
    const b = constructCatchupRequest(action, send, ctx(approved) as never);
    assert.equal(a.state, "constructed", `${ch} prepare: ${a.reasons.join(",")}`);
    assert.equal(b.state, "constructed", `${ch} approved: ${b.reasons.join(",")}`);
    assert.equal(a.request!.serializedBody, b.request!.serializedBody,
      `${ch}: prepare-time and send-time bytes must be identical`);
    assert.equal(catchupRequestSha256(a.request!.serializedBody),
      catchupRequestSha256(b.request!.serializedBody));
    assert.ok(!a.request!.serializedBody.includes("catchup-preparation-only"),
      `${ch}: no review ref may leak into the wire body`);
  }
});
