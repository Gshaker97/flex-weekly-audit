import test from "node:test";
import assert from "node:assert/strict";
import {
  LADDER_CUSTOMER_CHANNELS, ladderEmail, ladderEmailMatchesText, ladderEmailSubject,
} from "../lib/notification-ladder-email";
import {
  LADDER_CUSTOMER_MESSAGE_DAYS, LADDER_CUSTOMER_SMS_DAYS, LADDER_INTERNAL_TASK_DAYS,
  ladderCustomerChannels, ladderDelivery, ladderMilestoneIsCustomerMessage,
} from "../lib/notification-ladder-sender-policy";

test("every homeowner rung delivers on BOTH channels", () => {
  for (const day of [10, 15, 20, 25, 30]) {
    assert.equal(ladderDelivery(day), "customer_message", `day ${day}`);
    assert.equal(ladderMilestoneIsCustomerMessage(day), true, `day ${day}`);
    assert.deepEqual([...ladderCustomerChannels(day)], ["sms", "email"], `day ${day}`);
  }
  assert.deepEqual([...LADDER_CUSTOMER_MESSAGE_DAYS], [10, 15, 20, 25, 30]);
});

test("an internal rung still messages nobody", () => {
  for (const day of [21, 35]) {
    assert.equal(ladderDelivery(day), "internal_task", `day ${day}`);
    assert.equal(ladderMilestoneIsCustomerMessage(day), false, `day ${day}`);
    assert.deepEqual([...ladderCustomerChannels(day)], [], `day ${day}`);
  }
  assert.deepEqual([...LADDER_INTERNAL_TASK_DAYS], [21, 35]);
});

test("a day that is not a rung delivers nothing", () => {
  for (const day of [0, 1, 9, 11, 40, -5, 1.5, NaN]) {
    assert.equal(ladderDelivery(day), null, `day ${day}`);
    assert.deepEqual([...ladderCustomerChannels(day)], [], `day ${day}`);
  }
});

test("the old export name still resolves, to the same days", () => {
  // A caller reading the removed name would otherwise get undefined and send
  // nothing, silently.
  assert.deepEqual([...LADDER_CUSTOMER_SMS_DAYS], [...LADDER_CUSTOMER_MESSAGE_DAYS]);
});

test("the channel list is frozen, in a fixed order", () => {
  assert.deepEqual([...LADDER_CUSTOMER_CHANNELS], ["sms", "email"]);
  assert.ok(Object.isFrozen(LADDER_CUSTOMER_CHANNELS));
});

test("the email body IS the text body, byte for byte", () => {
  const body = "This is a reminder that your invoice is 20 days past due. Call 602-329-7865.";
  const email = ladderEmail({ body, invoiceNumber: "7226", dayPastDue: 20 });
  assert.ok(email);
  assert.equal(email.body, body, "the email must not paraphrase the text");
  assert.ok(ladderEmailMatchesText(email, body));
  // And the guard catches a body that differs, which is what the planner relies on.
  assert.equal(ladderEmailMatchesText(email, body + " PS"), false);
  assert.equal(ladderEmailMatchesText(null, body), false);
});

test("the subject names the invoice and the days, and claims nothing", () => {
  assert.equal(ladderEmailSubject("7226", 15), "Invoice #7226 is 15 days past due");
  assert.equal(ladderEmailSubject("  7226  ", 30), "Invoice #7226 is 30 days past due");
  for (const day of [10, 15, 20, 25, 30]) {
    const subject = ladderEmailSubject("7226", day)!;
    // Every claim about the account lives in the validated body. A subject that
    // asserted a fee or a suspension would be an unchecked claim.
    assert.doesNotMatch(subject, /late\s*fee|3\s*%|suspend|collections?|has been applied/i);
    assert.doesNotMatch(subject, /[\r\n]/, "a newline in a subject is a header-injection shape");
  }
});

test("an unusable invoice number or day yields no subject, so the rung holds", () => {
  assert.equal(ladderEmailSubject("", 15), null);
  assert.equal(ladderEmailSubject("   ", 15), null);
  assert.equal(ladderEmailSubject(null as any, 15), null);
  assert.equal(ladderEmailSubject("7226", 0), null);
  assert.equal(ladderEmailSubject("7226", -1), null);
  assert.equal(ladderEmailSubject("7226", 1.5), null);
});

test("no subject and no body means no email, never a half-built one", () => {
  assert.equal(ladderEmail({ body: "words", invoiceNumber: "", dayPastDue: 15 }), null);
  assert.equal(ladderEmail({ body: "", invoiceNumber: "7226", dayPastDue: 15 }), null);
  assert.equal(ladderEmail({ body: "   ", invoiceNumber: "7226", dayPastDue: 15 }), null);
  assert.equal(ladderEmail({ body: null as any, invoiceNumber: "7226", dayPastDue: 15 }), null);
});
