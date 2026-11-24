import test from "node:test";
import assert from "node:assert/strict";
import {
  CATCHUP_PAY_LINK_HOST, CATCHUP_SMS_SUFFIX, catchupBody, catchupCopyIsValid,
  catchupPayLinkIsUsable, catchupSmsReceiptBody, catchupSubject,
} from "../lib/catchup-copy";

const LINK = `https://${CATCHUP_PAY_LINK_HOST}/client_hubs/abc123/invoices/def456`;
const LINK2 = `https://${CATCHUP_PAY_LINK_HOST}/client_hubs/abc123/invoices/zzz999`;
const one = (over: Record<string, unknown> = {}) => ({
  invoiceNumber: "7272", balanceMinor: 9000, dayPastDue: 7, payLink: LINK, ...over,
});

test("the approved single-invoice wording renders exactly", () => {
  const copy = catchupBody({ clientName: "Jessica Noonan", invoices: [one()] });
  assert.ok(copy);
  assert.equal(copy.body,
    "Hi Jessica, this is Flexx Landscaping. Our records show invoice #7272 for $90.00 is 7 days "
    + `past due. You can view and pay it here: ${LINK}. If you have already paid, please let us `
    + "know. Otherwise please reach out to our office at 602-329-7865 to take care of it or if you "
    + "have any questions. Thank you.");
  assert.equal(copy.subject, "Invoice #7272 is 7 days past due");
  assert.deepEqual([...copy.covers], ["7272"]);
});

test("two invoices become one message naming both, with a link each", () => {
  const copy = catchupBody({
    clientName: "Elizabeth Brungs",
    invoices: [one({ invoiceNumber: "7304", balanceMinor: 35000, dayPastDue: 4 }),
      one({ invoiceNumber: "7286", balanceMinor: 13700, dayPastDue: 5, payLink: LINK2 })],
  });
  assert.ok(copy);
  assert.match(copy.body, /2 invoices past due: #7304 for \$350\.00 \(4 days\) and #7286 for \$137\.00 \(5 days\)/);
  assert.ok(copy.body.includes(LINK), "first link must appear");
  assert.ok(copy.body.includes(LINK2), "second link must appear");
  assert.equal(copy.subject, "2 Flexx Landscaping invoices are past due");
  assert.deepEqual([...copy.covers], ["7304", "7286"]);
});

test("one day past due is singular", () => {
  const copy = catchupBody({ clientName: "Ann", invoices: [one({ dayPastDue: 1 })] });
  assert.ok(copy);
  assert.match(copy.body, /is 1 day past due/);
  assert.doesNotMatch(copy.body, /1 days/);
});

test("a name Jobber stored with a double space still greets correctly", () => {
  const copy = catchupBody({ clientName: "Nate  Martin", invoices: [one()] });
  assert.ok(copy);
  assert.match(copy.body, /^Hi Nate, /);
});

test("an unusable name greets without one rather than holding", () => {
  for (const name of [null, "", "   ", "123", "!!"]) {
    const copy = catchupBody({ clientName: name as string, invoices: [one()] });
    assert.ok(copy, String(name));
    assert.match(copy.body, /^Hello, this is Flexx Landscaping\. /, String(name));
  }
});

test("A MISSING VALUE YIELDS NO BODY AT ALL - never a rendered placeholder", () => {
  const bad: Record<string, unknown>[] = [
    { balanceMinor: undefined }, { balanceMinor: null }, { balanceMinor: 0 }, { balanceMinor: -100 },
    { balanceMinor: 90.5 }, { balanceMinor: NaN },
    { invoiceNumber: undefined }, { invoiceNumber: "" }, { invoiceNumber: "abc" },
    { dayPastDue: undefined }, { dayPastDue: 0 }, { dayPastDue: -1 }, { dayPastDue: 1.5 },
    { payLink: undefined }, { payLink: null }, { payLink: "" },
  ];
  for (const over of bad) {
    assert.equal(catchupBody({ clientName: "Ann", invoices: [one(over)] }), null, JSON.stringify(over));
  }
});

test("one bad invoice holds the whole message, it is not quietly dropped", () => {
  const copy = catchupBody({
    clientName: "Elizabeth",
    invoices: [one(), one({ invoiceNumber: "7286", balanceMinor: null })],
  });
  assert.equal(copy, null, "a list the customer would read as complete must not be partial");
});

test("only an https Jobber client hub link is allowed near a customer", () => {
  assert.equal(catchupPayLinkIsUsable(LINK), true);
  for (const bad of [
    `http://${CATCHUP_PAY_LINK_HOST}/x`,
    `https://${CATCHUP_PAY_LINK_HOST}.evil.test/x`,
    "https://evil.test/client_hubs/a/invoices/b",
    `https://user:pw@${CATCHUP_PAY_LINK_HOST}/x`,
    `https://${CATCHUP_PAY_LINK_HOST}/x y`,
    `https://${CATCHUP_PAY_LINK_HOST}/x\nSubject: oops`,
    "not a url", "", null, undefined, 42,
  ]) {
    assert.equal(catchupPayLinkIsUsable(bad as string), false, String(bad));
  }
});

test("a link on the wrong host holds the message", () => {
  assert.equal(catchupBody({
    clientName: "Ann", invoices: [one({ payLink: "https://evil.test/pay" })],
  }), null);
});

test("the copy claims no fee, no suspension and no collections", () => {
  const copy = catchupBody({ clientName: "Ann", invoices: [one()] })!;
  assert.doesNotMatch(copy.body, /late\s*fee/i);
  assert.doesNotMatch(copy.body, /3\s*%/);
  assert.doesNotMatch(copy.body, /suspend/i);
  assert.doesNotMatch(copy.body, /collections?/i);
  assert.doesNotMatch(copy.body, /has been applied/i);
  assert.equal(catchupCopyIsValid(copy.body), true);
});

test("the validator rejects a body that started claiming things", () => {
  for (const bad of [
    "Your invoice is 7 days past due and a late fee of 3% has been applied.",
    "Your services have been temporarily suspended.",
    "This invoice has been sent to collections.",
    "Invoice #7272 for $undefined is 7 days past due.",
    "Invoice #7272 for $NaN is past due.",
    "Hi {FirstName}, your invoice is past due.",
    "", "   ",
  ]) {
    assert.equal(catchupCopyIsValid(bad), false, bad.slice(0, 40));
  }
});

test("the subject names no claim and carries no newline", () => {
  const subject = catchupSubject([one()])!;
  assert.doesNotMatch(subject, /late\s*fee|3\s*%|suspend|collections?|has been applied/i);
  assert.doesNotMatch(subject, /[\r\n]/);
  assert.equal(catchupSubject([]), null);
  assert.equal(catchupSubject(null as never), null);
});

test("the text carries the opt-out line and the email does not", () => {
  const copy = catchupBody({ clientName: "Ann", invoices: [one()] })!;
  const receipt = catchupSmsReceiptBody(copy.body)!;
  assert.ok(receipt.endsWith(CATCHUP_SMS_SUFFIX));
  assert.equal(receipt, copy.body + CATCHUP_SMS_SUFFIX);
  // The shared body - what the email sends and what the ledger records - has no
  // opt-out line in it, so the two channels record the same words.
  assert.doesNotMatch(copy.body, /Reply STOP/);
  assert.equal(catchupSmsReceiptBody(""), null);
  assert.equal(catchupSmsReceiptBody(null as never), null);
});

test("more than ten invoices is not a catch-up message", () => {
  const many = Array.from({ length: 11 }, (_, i) => one({ invoiceNumber: String(7000 + i) }));
  assert.equal(catchupBody({ clientName: "Ann", invoices: many }), null);
});

test("the same invoice twice is a caller bug, not a message", () => {
  assert.equal(catchupBody({ clientName: "Ann", invoices: [one(), one()] }), null);
});
