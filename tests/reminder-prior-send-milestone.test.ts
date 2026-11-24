import test from "node:test";
import assert from "node:assert/strict";
import {
  FEE_TEMPLATE_DAY, impliedDueDate, matchMessageToInvoice, readMilestone, statedDueDates,
} from "../lib/reminder-prior-send-milestone";

/**
 * The bodies below are Flexx's real legacy templates, trimmed. They are the
 * reason this module exists: not one of them carries an invoice number or an
 * amount, so the day count is the only thing in them that names an invoice.
 */
const DAY_10 = "Hello Rory, This is a friendly reminder your invoice is 10 days past due. "
  + "We kindly ask this invoice be paid as soon as possible to avoid any late fees.";
const DAY_20 = "Hello Rory, This is a reminder that your invoice is 20 days past due. "
  + "This invoice will continue to incur late fees every 15 days.";
const DAY_30 = "Hello Rory, This is your final reminder that your invoice is 30 days past due. "
  + "Your maintenance services have been temporarily suspended until payment is received.";
const FEE = "Hello Rory, This is your reminder that your invoice is past due. "
  + "A late fee of 3% has been applied and we kindly ask this invoice be paid.";
const SALES = "Hey Rory, this is Preston Johnson from Flex Landscaping just saw you claimed "
  + "our offer. I'm gonna be calling you in a second.";
const GENERIC = "Hi Mike Mcgee, Just a friendly reminder that the invoice is still unpaid. "
  + "Please note that a late fee may be charged if it is not settled today.";

// Phoenix is UTC-7 all year, so 18:00Z is the same calendar day there.
const at = (iso: string) => new Date(iso);

test("a stated day count is read; a sales text and the generic template are not", () => {
  assert.deepEqual(readMilestone(DAY_10), { dayPastDue: 10, basis: "stated" });
  assert.deepEqual(readMilestone(DAY_20), { dayPastDue: 20, basis: "stated" });
  assert.deepEqual(readMilestone(DAY_30), { dayPastDue: 30, basis: "stated" });
  assert.deepEqual(readMilestone(FEE), { dayPastDue: FEE_TEMPLATE_DAY, basis: "fee_template" });
  assert.equal(readMilestone(SALES), null, "a sales text names no milestone");
  assert.equal(readMilestone(GENERIC), null, "the old generic reminder states no day count");
  assert.equal(readMilestone(""), null);
  assert.equal(readMilestone(null), null);
});

test("a day count that is not a ladder rung is not read as a milestone", () => {
  // Flexx's rungs are 10/15/20/21/25/30/35. A body quoting anything else is
  // not one of its reminders, so it must keep holding rather than be matched.
  assert.equal(readMilestone("your invoice is 45 days past due"), null);
  assert.equal(readMilestone("your invoice is 7 days past due"), null);
});

test("a figure that is not a day count is never mistaken for one", () => {
  assert.equal(readMilestone("Please call us on 602-329-7865 about your past due invoice"), null);
  assert.equal(readMilestone("A credit of 20 dollars was applied; your invoice is past due"), null);
  assert.equal(readMilestone("10 days until your service visit"), null,
    "'past due' must follow the day count");
});

test("the implied due date is the day count subtracted in Phoenix", () => {
  // Rory's real day 10: sent Sep 26, so the invoice fell due Sep 16.
  assert.equal(impliedDueDate(at("2026-09-26T18:00:00Z"), 10), "2026-09-16");
  // Late UTC evening is still the same Phoenix day, not the next one.
  assert.equal(impliedDueDate(at("2026-10-14T22:30:00Z"), 30), "2026-09-14");
  // Early UTC morning is the PREVIOUS Phoenix day.
  assert.equal(impliedDueDate(at("2026-06-20T03:00:00Z"), 10), "2026-06-09");
  assert.equal(impliedDueDate(null, 10), null);
  assert.equal(impliedDueDate(new Date("nonsense"), 10), null);
});

test("Rory's whole ladder resolves to the one invoice it was really about", () => {
  // Invoice #6884 fell due 2026-09-16. Every rung lands on that date.
  const due = "2026-09-16";
  const ladder: readonly [string, string, number][] = [
    [DAY_10, "2026-09-26T18:00:00Z", 10],
    [FEE, "2026-10-01T18:00:00Z", 15],
    [DAY_20, "2026-10-06T18:00:00Z", 20],
    ["your invoice is 25 days past due", "2026-10-11T18:00:00Z", 25],
    [DAY_30, "2026-10-16T18:00:00Z", 30],
  ];
  for (const [body, sent, day] of ladder) {
    const verdict = matchMessageToInvoice({ body, sentAt: at(sent), invoiceDueDate: due });
    assert.equal(verdict.outcome, "this_invoice", `day ${day} should match #6884`);
    assert.equal(verdict.outcome === "this_invoice" && verdict.dayPastDue, day);
  }
});

test("a stated day count pointing at another due date dismisses the message", () => {
  // Celine's #7324 fell due 2026-11-23. Her Oct 16 "10 days" text is about an
  // invoice that fell due Oct 6, so it must not hold #7324.
  const verdict = matchMessageToInvoice({
    body: DAY_10, sentAt: at("2026-10-16T23:00:00Z"), invoiceDueDate: "2026-11-23" });
  assert.equal(verdict.outcome, "other_invoice");
  assert.equal(verdict.outcome === "other_invoice" && verdict.impliedDueDate, "2026-10-06");
});

test("the fee template CONFIRMS this invoice's day 15 when the arithmetic lands on it", () => {
  // Hoang's #7087 fell due 2026-10-14; the fee text went out Oct 29.
  const verdict = matchMessageToInvoice({
    body: FEE, sentAt: at("2026-10-29T15:00:00Z"), invoiceDueDate: "2026-10-14" });
  assert.equal(verdict.outcome, "this_invoice");
  assert.equal(verdict.outcome === "this_invoice" && verdict.dayPastDue, 15);
});

test("the fee template alone NEVER dismisses: an inference must not release a hold", () => {
  // Celine's Oct 21 fee text, against an invoice due Nov 23. Day 15 puts it on
  // an Oct 6 invoice - but the text itself says no such thing, so on its own it
  // stays undecided and keeps holding.
  const verdict = matchMessageToInvoice({
    body: FEE, sentAt: at("2026-10-21T23:00:00Z"), invoiceDueDate: "2026-11-23" });
  assert.equal(verdict.outcome, "undecided");
  assert.match(verdict.outcome === "undecided" ? verdict.reason : "", /no message states outright/);
});

test("a stated-day message in the same conversation lets the fee template dismiss", () => {
  // Celine's Oct 16 "10 days" text independently points at an Oct 6 invoice,
  // which is exactly what her Oct 21 fee text implies. Now it is evidence.
  const conversation = [
    { body: DAY_10, sentAt: at("2026-10-16T23:00:00Z") },
    { body: FEE, sentAt: at("2026-10-21T23:00:00Z") },
  ];
  const corroborating = statedDueDates(conversation);
  assert.deepEqual(corroborating, ["2026-10-06"]);
  const verdict = matchMessageToInvoice({
    body: FEE, sentAt: at("2026-10-21T23:00:00Z"), invoiceDueDate: "2026-11-23",
    corroboratingDueDates: corroborating });
  assert.equal(verdict.outcome, "other_invoice");
});

test("a fee template cannot corroborate another fee template", () => {
  // Two guesses are still a guess. statedDueDates must ignore the fee text.
  assert.deepEqual(statedDueDates([
    { body: FEE, sentAt: at("2026-10-21T23:00:00Z") },
    { body: FEE, sentAt: at("2026-10-29T15:00:00Z") },
  ]), []);
});

test("an invoice with no usable due date decides nothing and keeps holding", () => {
  for (const due of [null, undefined, "", "not-a-date"]) {
    const verdict = matchMessageToInvoice({
      body: DAY_10, sentAt: at("2026-09-26T18:00:00Z"), invoiceDueDate: due });
    assert.equal(verdict.outcome, "undecided", `due=${String(due)} must decide nothing`);
  }
});

test("a message with no usable send time decides nothing and keeps holding", () => {
  const verdict = matchMessageToInvoice({
    body: DAY_10, sentAt: null, invoiceDueDate: "2026-09-16" });
  assert.equal(verdict.outcome, "undecided");
  assert.match(verdict.outcome === "undecided" ? verdict.reason : "", /send time/);
});

test("Charles's two ladder cycles separate: the recent one matches, the old one does not", () => {
  // #6872 fell due 2026-09-14. The Sep/Oct cycle is its own; the Jul/Aug cycle
  // belongs to invoices that fell due Jul 14 and Aug 3.
  const due = "2026-09-14";
  const mine = matchMessageToInvoice({
    body: DAY_10, sentAt: at("2026-09-24T22:00:00Z"), invoiceDueDate: due });
  assert.equal(mine.outcome, "this_invoice");
  const older = matchMessageToInvoice({
    body: DAY_10, sentAt: at("2026-08-13T22:00:00Z"), invoiceDueDate: due });
  assert.equal(older.outcome, "other_invoice");
  assert.equal(older.outcome === "other_invoice" && older.impliedDueDate, "2026-08-03");
});
