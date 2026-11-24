import test from "node:test";
import assert from "node:assert/strict";
import {
  CATCHUP_EMAIL_ONLY_EXCEPTIONS, CATCHUP_EMAIL_SENDER, CATCHUP_SMS_SENDER,
  catchupEmailOnlyReasons, catchupIsEmailOnly,
} from "../lib/catchup-sender-policy";
import { LADDER_SMS_SENDER } from "../lib/notification-ladder-sender-policy";
import { planCatchupRecipient, type CatchupRecipientInput } from "../lib/catchup-plan";
import { CATCHUP_PAY_LINK_HOST } from "../lib/catchup-copy";

const LINK = `https://${CATCHUP_PAY_LINK_HOST}/client_hubs/abc123/invoices/def456`;
const SEND_ON = "2026-11-24";

const invoice = (over: Record<string, unknown> = {}) => ({
  invoiceId: "inv-1", invoiceNumber: "7272", balanceMinor: 9000,
  dueOn: "2026-11-17", payLink: LINK, ...over,
});
const recipient = (over: Partial<CatchupRecipientInput> = {}): CatchupRecipientInput => ({
  accountId: "acct-1", jobberClientId: "client-1", clientName: "Jessica Noonan",
  contactId: "contact-abc123", exactContactMatches: 1,
  phone: "+16025550100", email: "jessica@example.test",
  smsOptedOut: false, emailOptedOut: false, invoices: [invoice()], ...over,
});

test("the pinned email sender is the address GHL gives for this location", () => {
  assert.equal(CATCHUP_EMAIL_SENDER.address, "preston@flexxlandscaping.com");
  assert.equal(CATCHUP_EMAIL_SENDER.source, "ghl-location-record");
  assert.ok(CATCHUP_EMAIL_SENDER.evidenceRef.includes("/locations/"));
});

test("THE SENDING DOMAIN IS NOT CLAIMED AS VERIFIED", () => {
  // No API endpoint reports this, so it must stay false until a person checks
  // the GHL UI. A true here would be an unproven deliverability claim.
  assert.equal(CATCHUP_EMAIL_SENDER.sendingDomainVerified, false);
});

test("the SMS sender is the pinned ladder sender, not a second copy", () => {
  assert.equal(CATCHUP_SMS_SENDER, LADDER_SMS_SENDER);
  assert.equal(CATCHUP_SMS_SENDER.number, "+16028548131");
});

test("the email-only list is exactly the two approved invoices", () => {
  assert.deepEqual(Object.keys(CATCHUP_EMAIL_ONLY_EXCEPTIONS).sort(), ["7259", "7299"]);
  assert.equal(CATCHUP_EMAIL_ONLY_EXCEPTIONS["7259"].clientName, "Joshua Heyrend");
  assert.equal(CATCHUP_EMAIL_ONLY_EXCEPTIONS["7299"].clientName, "Brian Carey");
  // Each carries its own reason: the two are email-only for different causes.
  assert.notEqual(CATCHUP_EMAIL_ONLY_EXCEPTIONS["7259"].reason,
    CATCHUP_EMAIL_ONLY_EXCEPTIONS["7299"].reason);
});

test("only a listed invoice is email-only", () => {
  assert.equal(catchupIsEmailOnly(["7259"]), true);
  assert.equal(catchupIsEmailOnly(["7299"]), true);
  assert.equal(catchupIsEmailOnly([" 7259 "]), true, "whitespace must not defeat the list");
  for (const not of [["7272"], ["7226"], [], ["" ], ["?"], [null as never]]) {
    assert.equal(catchupIsEmailOnly(not), false, JSON.stringify(not));
  }
  assert.equal(catchupIsEmailOnly(null as never), false);
});

test("ONE LISTED INVOICE DOES NOT MAKE A MIXED CUSTOMER EMAIL-ONLY", () => {
  // Otherwise a customer owed two invoices would silently lose their text.
  assert.equal(catchupIsEmailOnly(["7259", "7272"]), false);
  assert.equal(catchupIsEmailOnly(["7272", "7299"]), false);
});

test("a listed invoice with no phone plans email only, and says why", () => {
  const action = planCatchupRecipient(recipient({
    clientName: "Joshua Heyrend", phone: null,
    invoices: [invoice({ invoiceNumber: "7259", balanceMinor: 6600, dueOn: "2026-11-14" })],
  }), SEND_ON);
  assert.equal(action.state, "send");
  if (action.state !== "send") return;
  assert.deepEqual(action.sends.map(s => s.channel), ["email"]);
  assert.equal(action.emailOnly, true);
  assert.deepEqual([...action.emailOnlyReasons!], ["7259:no_phone_in_jobber_or_ghl"]);
});

test("Brian Carey is email-only for the OTHER reason, recorded as such", () => {
  const action = planCatchupRecipient(recipient({
    clientName: "Brian Carey", phone: null,
    invoices: [invoice({ invoiceNumber: "7299", balanceMinor: 10000, dueOn: "2026-11-19" })],
  }), SEND_ON);
  assert.equal(action.state, "send");
  if (action.state !== "send") return;
  assert.deepEqual([...action.emailOnlyReasons!],
    ["7299:jobber_has_a_phone_but_the_ghl_contact_does_not"]);
});

test("AN UNLISTED CUSTOMER WITH NO PHONE STILL HOLDS", () => {
  const action = planCatchupRecipient(recipient({ phone: null }), SEND_ON);
  assert.equal(action.state, "hold");
  if (action.state !== "hold") return;
  assert.ok(action.reasons.includes("no_phone_on_contact"), action.reasons.join(","));
});

test("a listed invoice WITH a phone still gets both halves", () => {
  // The exception is about a missing phone, not a licence to drop the text.
  const action = planCatchupRecipient(recipient({
    clientName: "Brian Carey",
    invoices: [invoice({ invoiceNumber: "7299", balanceMinor: 10000, dueOn: "2026-11-19" })],
  }), SEND_ON);
  assert.equal(action.state, "send");
  if (action.state !== "send") return;
  assert.deepEqual(action.sends.map(s => s.channel), ["sms", "email"]);
  assert.equal(action.emailOnly, undefined);
});

test("an opt-out still holds a listed invoice", () => {
  const action = planCatchupRecipient(recipient({
    phone: null, emailOptedOut: true,
    invoices: [invoice({ invoiceNumber: "7259", dueOn: "2026-11-14" })],
  }), SEND_ON);
  assert.equal(action.state, "hold");
  if (action.state !== "hold") return;
  assert.ok(action.reasons.includes("contact_opted_out_of_email"), action.reasons.join(","));
});

test("an email is still required of an email-only recipient", () => {
  const action = planCatchupRecipient(recipient({
    phone: null, email: null,
    invoices: [invoice({ invoiceNumber: "7259", dueOn: "2026-11-14" })],
  }), SEND_ON);
  assert.equal(action.state, "hold");
  if (action.state !== "hold") return;
  assert.ok(action.reasons.includes("no_email_on_contact"), action.reasons.join(","));
});

test("the reasons list is stable and de-duplicated", () => {
  assert.deepEqual([...catchupEmailOnlyReasons(["7259", "7259"])], ["7259:no_phone_in_jobber_or_ghl"]);
  assert.deepEqual([...catchupEmailOnlyReasons(["7272"])], []);
  assert.deepEqual([...catchupEmailOnlyReasons(null as never)], []);
});
