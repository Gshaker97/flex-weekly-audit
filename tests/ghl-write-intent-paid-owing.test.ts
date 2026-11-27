import test from "node:test";
import assert from "node:assert/strict";
import { buildInvoiceSourceEvidence } from "../lib/ghl-write-intent";
import type { PhoneInvoiceEvidence } from "../lib/ghl-phone-state";

const CLIENT = "Z2lkOi8vSm9iYmVyL0NsaWVudC8x";
const OBSERVED = "2026-11-27T20:13:01.000Z"; // the run that halted

function evidence(over: Partial<PhoneInvoiceEvidence> & {
  total?: number; balance?: number;
} = {}): PhoneInvoiceEvidence {
  const { total = 60, balance = 60, ...rest } = over;
  return {
    id: "Z2lkOi8vSm9iYmVyL0ludm9pY2UvMTcxNTYwODk3",
    invoiceNumber: "6830",
    client: { id: CLIENT },
    invoiceStatus: "paid",
    amounts: { total, invoiceBalance: balance },
    issuedDate: "2026-09-10T15:23:22.000Z",
    createdAt: "2026-09-10T15:23:22.000Z",
    dueDate: "2026-09-10T07:00:00.000Z",
    ...rest,
  };
}

test("THE HALT THIS FIXES: paid-with-a-balance becomes an owing label, not a refused intent", () => {
  // Invoice #6830 on the live account: Jobber says `paid`, $60 is outstanding.
  // The durable journal's validator requires `paid` to carry a zero balance, so
  // left uncorrected this intent threw inside prepare(), halted every remaining
  // card write and blocked the sync pending operator review (2026-11-27 20:02Z).
  const out = buildInvoiceSourceEvidence([evidence()], CLIENT, OBSERVED);
  assert.ok(out, "evidence must be usable, not null");
  assert.equal(out.length, 1);
  assert.equal(out[0].invoiceStatus, "past_due");
  assert.equal(out[0].balanceCents, 6000);
  assert.equal(out[0].totalCents, 6000);
});

test("the corrected label is one the journal validator accepts", () => {
  // The exact predicate from validateIntent: a `paid` row must owe nothing, and
  // any other row must owe something. This is what used to throw.
  for (const [total, balance] of [[6000, 6000], [2829100, 1414550], [8000, 8000]] as const) {
    const row = buildInvoiceSourceEvidence(
      [evidence({ total, balance })], CLIENT, OBSERVED)![0];
    assert.ok(["paid", "past_due", "awaiting_payment"].includes(row.invoiceStatus), row.invoiceStatus);
    const ok = row.invoiceStatus === "paid" ? row.balanceCents === 0 : row.balanceCents > 0;
    assert.ok(ok, `validateIntent would refuse ${row.invoiceStatus}/${row.balanceCents}`);
  }
});

test("a paid invoice that really is settled is left exactly as it was", () => {
  const row = buildInvoiceSourceEvidence(
    [evidence({ total: 6000, balance: 0 })], CLIENT, OBSERVED)![0];
  assert.equal(row.invoiceStatus, "paid");
  assert.equal(row.balanceCents, 0);
});

test("an owing label with nothing left owing is corrected the other way", () => {
  // Also a refusal before: `past_due` with a zero balance failed the
  // "must owe something" half of the same predicate.
  const row = buildInvoiceSourceEvidence(
    [evidence({ invoiceStatus: "past_due", total: 6000, balance: 0 })], CLIENT, OBSERVED)![0];
  assert.equal(row.invoiceStatus, "paid");
  assert.equal(row.balanceCents, 0);
});

test("Jobber's own owing label is never re-refereed", () => {
  for (const status of ["past_due", "awaiting_payment"]) {
    const row = buildInvoiceSourceEvidence(
      [evidence({ invoiceStatus: status, total: 6000, balance: 6000 })], CLIENT, OBSERVED)![0];
    assert.equal(row.invoiceStatus, status);
  }
});

test("the invented label follows the due date, in Phoenix", () => {
  // Due yesterday in Phoenix -> past_due. Due tomorrow -> awaiting_payment.
  const past = buildInvoiceSourceEvidence(
    [evidence({ dueDate: "2026-11-26T07:00:00.000Z" })], CLIENT, OBSERVED)![0];
  assert.equal(past.invoiceStatus, "past_due");
  const future = buildInvoiceSourceEvidence(
    [evidence({ dueDate: "2026-12-25T07:00:00.000Z" })], CLIENT, OBSERVED)![0];
  assert.equal(future.invoiceStatus, "awaiting_payment");
});

test("AN UNREADABLE AMOUNT HOLDS ONE CARD AND DOES NOT HALT THE WRITER", () => {
  // A balance above the total is the case validateIntent would have thrown on.
  // Null here means the caller holds this one card, which is the whole point of
  // deciding it in this builder rather than inside prepare().
  assert.equal(buildInvoiceSourceEvidence(
    [evidence({ total: 6000, balance: 6001 })], CLIENT, OBSERVED), null);
});

test("a void or draft invoice is still a null answer, as before", () => {
  for (const status of ["void", "draft", "bad_debt"]) {
    assert.equal(buildInvoiceSourceEvidence(
      [evidence({ invoiceStatus: status })], CLIENT, OBSERVED), null, status);
  }
});

test("one customer's paid-but-owing invoice does not poison another's evidence", () => {
  // The halt was account-wide: every later card write in the run stopped. This
  // builder is per-customer, so the other customer's rows must come back clean.
  const other = evidence({ id: "other", invoiceNumber: "1", client: { id: "OTHER" } });
  const out = buildInvoiceSourceEvidence([evidence(), other], CLIENT, OBSERVED);
  assert.equal(out?.length, 1);
  assert.equal(out![0].invoiceStatus, "past_due");
});
