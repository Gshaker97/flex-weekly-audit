import test from "node:test";
import assert from "node:assert/strict";
import {
  LADDER_SMS_SENDER, LADDER_CUSTOMER_SMS_DAYS, LADDER_INTERNAL_TASK_DAYS,
  ladderDelivery, ladderSenderReview, ladderMilestoneIsCustomerMessage,
} from "../lib/notification-ladder-sender-policy";
import { buildGhlMessageRequest, parseGhlRecipient } from "../lib/notification-ghl-contract";
import { notificationBodyDigest } from "../lib/notification-ledger";
import { DAY20_SMS_BODY } from "../lib/notification-ladder-copy";

/**
 * The owner's two decisions of 2026-11-19, pinned: the number every ladder text
 * sends from, and day 21 being a task and not a message.
 */

test("the approved sending number is the proven one, and is pinned", () => {
  assert.equal(LADDER_SMS_SENDER.number, "+16028548131");
  assert.match(LADDER_SMS_SENDER.number, /^\+1\d{10}$/);
  assert.ok(LADDER_SMS_SENDER.approvalRef.includes("2026-11-19"));
  assert.equal(LADDER_SMS_SENDER.scope, "conversations/message.write");
});

test("the sender review states the approval and carries no credential", () => {
  const review = ladderSenderReview("account-1", "location-1");
  assert.equal(review.approved, true);
  assert.equal(review.validated, true);
  assert.equal(review.sender, LADDER_SMS_SENDER.number);
  assert.equal(review.channel, "sms");
  const serialized = JSON.stringify(review).toLowerCase();
  assert.ok(!serialized.includes("bearer") && !serialized.includes("token"));
});

test("the contract accepts this review and sends from that number", () => {
  const ACCOUNT = "account-1", LOCATION = "location-1", CONTACT = "contact-1", PHONE = "+14805550000";
  const recipient = parseGhlRecipient({
    version: "2021-07-28",
    body: { contact: { id: CONTACT, locationId: LOCATION, phone: PHONE, dndSettings: {} } },
    expected: { accountId: ACCOUNT, locationId: LOCATION, contactId: CONTACT, channel: "sms", destination: PHONE },
  });
  assert.equal(recipient.state, "allowed", JSON.stringify(recipient.reasons));
  const result = buildGhlMessageRequest({
    binding: {
      accountId: ACCOUNT, locationId: LOCATION, contactId: CONTACT, channel: "sms", destination: PHONE,
      eventKey: "k", invoiceId: "inv-1", sender: LADDER_SMS_SENDER.number,
      bodyHash: notificationBodyDigest(DAY20_SMS_BODY),
    },
    recipient, senderReview: ladderSenderReview(ACCOUNT, LOCATION),
    review: { mode: "reviewed-construction-only", version: "2021-07-28", evidenceRef: "r",
      accountId: ACCOUNT, locationId: LOCATION, channel: "sms", proposedStatus: "pending" },
    body: DAY20_SMS_BODY, contentType: "text/plain",
  });
  assert.equal(result.state, "constructed_disabled", JSON.stringify(result.reasons));
  assert.equal(JSON.parse(result.request!.serializedBody).fromNumber, LADDER_SMS_SENDER.number);
});

test("a different number is not approved to send", () => {
  const review = ladderSenderReview("account-1", "location-1");
  assert.notEqual(review.sender, "+14802501488", "the location phone is not the texting number");
});

test("day 21 and day 35 deliver internal work, never a message", () => {
  assert.equal(ladderDelivery(21), "internal_task");
  assert.equal(ladderDelivery(35), "internal_task");
  assert.equal(ladderMilestoneIsCustomerMessage(21), false);
  assert.equal(ladderMilestoneIsCustomerMessage(35), false);
  assert.deepEqual([...LADDER_INTERNAL_TASK_DAYS], [21, 35]);
});

test("the customer rungs are exactly 10, 15, 20, 25 and 30", () => {
  assert.deepEqual([...LADDER_CUSTOMER_SMS_DAYS], [10, 15, 20, 25, 30]);
  for (const day of LADDER_CUSTOMER_SMS_DAYS) assert.equal(ladderMilestoneIsCustomerMessage(day), true);
});

test("every rung is one thing or the other, never both and never neither", () => {
  const all = [...LADDER_CUSTOMER_SMS_DAYS, ...LADDER_INTERNAL_TASK_DAYS];
  assert.equal(new Set(all).size, all.length, "no day may be in both lists");
  assert.deepEqual([...all].sort((a, b) => a - b), [10, 15, 20, 21, 25, 30, 35]);
});

test("a day that is not on the ladder delivers nothing", () => {
  for (const day of [0, 1, 9, 14, 22, 36, -1, 1.5, Number.NaN]) {
    assert.equal(ladderDelivery(day), null, String(day));
    assert.equal(ladderMilestoneIsCustomerMessage(day), false, String(day));
  }
});
