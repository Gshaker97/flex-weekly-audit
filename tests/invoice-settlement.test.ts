import test from "node:test";
import assert from "node:assert/strict";
import { invoiceSettlement, isOwing, isSettled, settledOrOwingStatus,
  KNOWN_INVOICE_STATUSES, NEVER_COLLECT_STATUSES, OWING_STATUSES } from "../lib/invoice-settlement";

test("THE CASE THIS EXISTS FOR: paid, with the money still outstanding", () => {
  // Jobber invoice #6830. A $60 card payment taken 2026-09-10 and refunded in
  // full four minutes later. The PaymentRecord still reads adjustmentType
  // PAYMENT for $60; only jobberPaymentTransactionStatus REFUNDED and a
  // refunds entry say otherwise. paymentsTotal went back to 0 and
  // invoiceBalance back to 6000, but the label never moved off `paid`.
  assert.equal(invoiceSettlement("paid", 6000, 6000), "owing");
  assert.equal(isOwing("paid", 6000, 6000), true);
  assert.equal(isSettled("paid", 6000, 6000), false);
});

test("and the other shape of it: paid, with only a deposit ever paid", () => {
  // #780 Lori Neff: $14,145.50 of $28,291 paid, label still `paid`.
  assert.equal(invoiceSettlement("paid", 2829100, 1414550), "owing");
  // #362 Eric Bennett: $80, no payment record at all, label still `paid`.
  assert.equal(invoiceSettlement("paid", 8000, 8000), "owing");
});

test("paid with nothing outstanding is settled, as it always was", () => {
  assert.equal(invoiceSettlement("paid", 9000, 0), "settled");
  assert.equal(isSettled("paid", 9000, 0), true);
  assert.equal(isOwing("paid", 9000, 0), false);
});

test("a credit balance is not a debt", () => {
  assert.equal(invoiceSettlement("paid", 9000, -500), "settled");
  assert.equal(invoiceSettlement("awaiting_payment", 9000, -1), "settled");
});

test("an open label with nothing outstanding is settled, whatever the label says", () => {
  // The mirror image of the bug. The balance decides both directions.
  assert.equal(invoiceSettlement("awaiting_payment", 9000, 0), "settled");
  assert.equal(invoiceSettlement("past_due", 9000, 0), "settled");
});

test("VOID, DRAFT AND BAD DEBT ARE NEVER OWING, WHATEVER THE BALANCE", () => {
  // The protection a balance-only rule would have thrown away. These carry a
  // balance in Jobber and are nobody's receivable.
  for (const status of NEVER_COLLECT_STATUSES) {
    assert.equal(invoiceSettlement(status, 9000, 9000), "excluded", status);
    assert.equal(isOwing(status, 9000, 9000), false, status);
    // Excluded is NOT settled either, so nothing retires a card on this basis.
    assert.equal(isSettled(status, 9000, 0), false, status);
  }
});

test("an unknown or missing status is unreadable, never a decision", () => {
  for (const status of [null, undefined, "", "   ", "something_new", "PAID_IN_FULL"]) {
    assert.equal(invoiceSettlement(status, 9000, 9000), "unreadable", String(status));
    assert.equal(isOwing(status, 9000, 9000), false, String(status));
    assert.equal(isSettled(status, 9000, 0), false, String(status));
  }
});

test("case and surrounding space do not change the answer", () => {
  assert.equal(invoiceSettlement(" PAID ", 6000, 6000), "owing");
  assert.equal(invoiceSettlement("Void", 6000, 6000), "excluded");
  assert.equal(invoiceSettlement("Past_Due", 6000, 0), "settled");
});

test("unusable amounts are unreadable, not guessed at", () => {
  for (const [total, balance] of [[null, 6000], [6000, null], [undefined, undefined],
                                  [Number.NaN, 6000], [6000, Number.NaN],
                                  [6000, 1.5], [1.5, 6000],
                                  [6000, 9000], [-100, -100]] as const) {
    assert.equal(invoiceSettlement("paid", total as number, balance as number), "unreadable",
      `${String(total)}/${String(balance)}`);
  }
});

test("a balance above the total is unreadable, not a bigger debt", () => {
  // The guard that stops a nonsense figure reaching a customer's hand.
  assert.equal(invoiceSettlement("past_due", 6000, 6001), "unreadable");
  assert.equal(isOwing("past_due", 6000, 6001), false);
});

test("every known status is classified, and the lists agree with each other", () => {
  for (const status of KNOWN_INVOICE_STATUSES) {
    assert.notEqual(invoiceSettlement(status, 9000, 9000), "unreadable", status);
  }
  // Widened to string so these are real runtime checks, not assertions the
  // type system has already made true and erased.
  const known: readonly string[] = KNOWN_INVOICE_STATUSES;
  const never: readonly string[] = NEVER_COLLECT_STATUSES;
  for (const status of OWING_STATUSES as readonly string[]) {
    assert.ok(known.includes(status), status);
    assert.ok(!never.includes(status), status);
    assert.equal(invoiceSettlement(status, 9000, 9000), "owing", status);
  }
  for (const status of never) {
    assert.ok(known.includes(status), status);
    assert.equal(invoiceSettlement(status, 9000, 9000), "excluded", status);
  }
});

test("the stored label corrects paid-while-owing, using the due date", () => {
  assert.equal(settledOrOwingStatus("paid", 6000, 6000, true), "past_due");
  assert.equal(settledOrOwingStatus("paid", 6000, 6000, false), "awaiting_payment");
});

test("the stored label corrects settled-while-open", () => {
  assert.equal(settledOrOwingStatus("awaiting_payment", 9000, 0, false), "paid");
  assert.equal(settledOrOwingStatus("past_due", 9000, 0, true), "paid");
});

test("THE STORED LABEL DOES NOT RE-REFEREE past_due AGAINST awaiting_payment", () => {
  // Deliberately out of scope. Jobber already calls these owing, which of the
  // two it is belongs to the due date, and every consumer that cares computes
  // that itself. Rewriting thousands of correct rows is not this fix's job.
  assert.equal(settledOrOwingStatus("awaiting_payment", 9000, 9000, true), "awaiting_payment");
  assert.equal(settledOrOwingStatus("past_due", 9000, 9000, false), "past_due");
  assert.equal(settledOrOwingStatus("awaiting_payment", 9000, 9000, false), "awaiting_payment");
  assert.equal(settledOrOwingStatus("past_due", 9000, 9000, true), "past_due");
});

test("the stored label leaves alone what it cannot improve on", () => {
  for (const status of ["void", "draft", "bad_debt"]) {
    assert.equal(settledOrOwingStatus(status, 9000, 9000, true), status, status);
  }
  assert.equal(settledOrOwingStatus("something_new", 9000, 9000, true), "something_new");
  assert.equal(settledOrOwingStatus(null, 9000, 9000, true), null);
  // Unreadable amounts must not invent a label either.
  assert.equal(settledOrOwingStatus("paid", null, 6000, true), "paid");
});

test("the module reads no clock, database or environment", () => {
  // Same inputs, same answer, whatever the environment says. Guards against
  // anyone reaching for process.env in here to gate the behaviour later.
  const before = invoiceSettlement("paid", 6000, 6000);
  process.env.JOBBER_PAID_BALANCE_CORRECTION_ENABLED = "false";
  assert.equal(invoiceSettlement("paid", 6000, 6000), before);
  delete process.env.JOBBER_PAID_BALANCE_CORRECTION_ENABLED;
});
