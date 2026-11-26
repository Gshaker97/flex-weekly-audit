import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { invoiceIsSettled, invoicePaidAt } from "../lib/invoice-paid-date";

/**
 * The invoice sync's GraphQL query, with GraphQL `#` comments stripped so a
 * mention in a comment can never pass for a requested field.
 */
const invoicesQuery = (): string => {
  const src = readFileSync(new URL("../lib/jobber.ts", import.meta.url), "utf8");
  const from = src.slice(src.indexOf("const INVOICES_QUERY"));
  return from.slice(0, from.indexOf("`;")).replace(/#[^\n]*/g, "");
};

/** A Jobber invoice node, settled unless a case says otherwise. */
const inv = (over: Partial<Parameters<typeof invoicePaidAt>[0]> = {}) => ({
  receivedDate: "2026-11-25T00:00:00Z",
  amounts: { total: 487, invoiceBalance: 0 },
  ...over,
});

test("a settled invoice is paid on the date the money arrived, not the date it was issued", () => {
  // The whole point. The old code stored the issue date here.
  const when = invoicePaidAt(inv({ receivedDate: "2026-11-25T00:00:00Z" }));
  assert.equal(when?.toISOString(), "2026-11-25T00:00:00.000Z");
});

test("a date-only value from Jobber is kept as given", () => {
  // Jobber reports these as ISO8601DateTime but has been seen to send a plain
  // calendar date. It must parse, not become null.
  assert.equal(invoicePaidAt(inv({ receivedDate: "2026-11-03" }))?.toISOString(),
    "2026-11-03T00:00:00.000Z");
});

test("an unsettled invoice has no payment date, whatever the source says", () => {
  // A receivedDate on an invoice that still owes money is not a payment date,
  // and was seen once in 250 real invoices. It must not be stored.
  for (const amounts of [
    { total: 487, invoiceBalance: 137 },   // part paid
    { total: 487, invoiceBalance: -10 },   // credit balance
    { total: 0, invoiceBalance: 0 },       // zero-dollar invoice
    { total: null, invoiceBalance: 0 },    // unreadable total
  ]) {
    assert.equal(invoicePaidAt(inv({ amounts })), null, JSON.stringify(amounts));
  }
});

test("a settled invoice with no readable payment date stores nothing, and never a guess", () => {
  // Null is the honest answer. Filling this in from the issue date is the bug
  // being fixed, so none of these may come back with a date on them.
  for (const receivedDate of [null, undefined, "", "   ", "not a date"]) {
    assert.equal(invoicePaidAt(inv({ receivedDate })), null, JSON.stringify(receivedDate));
  }
});

test("the payment date is never taken from the issue or due date", () => {
  // Belt and braces: the function is given no issue date at all, so it could
  // not reach for one even if someone later wanted it to.
  const node: any = inv({ receivedDate: null });
  node.issuedDate = "2026-11-11";
  node.dueDate = "2026-11-18";
  node.createdAt = "2026-11-11";
  assert.equal(invoicePaidAt(node), null);
});

test("settled means nothing owed on a real total", () => {
  assert.equal(invoiceIsSettled(inv()), true);
  assert.equal(invoiceIsSettled(inv({ amounts: { total: 487, invoiceBalance: 0.01 } })), false);
  assert.equal(invoiceIsSettled(inv({ amounts: { total: 0, invoiceBalance: 0 } })), false);
  assert.equal(invoiceIsSettled(inv({ amounts: null })), false);
  assert.equal(invoiceIsSettled({} as any), false);
});

test("the settled test and the payment date agree on every invoice", () => {
  // These two are written side by side into the same row. A row that says paid
  // with no date is fine; a row with a date that is NOT settled is a bug.
  for (const amounts of [
    { total: 487, invoiceBalance: 0 }, { total: 487, invoiceBalance: 487 },
    { total: 0, invoiceBalance: 0 }, { total: 100, invoiceBalance: -5 },
  ]) {
    for (const receivedDate of ["2026-11-25", null]) {
      const node = inv({ amounts, receivedDate });
      if (invoicePaidAt(node) !== null) assert.equal(invoiceIsSettled(node), true,
        `dated but not settled: ${JSON.stringify({ amounts, receivedDate })}`);
    }
  }
});

test("an instant is preserved, so a late-evening payment is not shifted a day", () => {
  const when = invoicePaidAt(inv({ receivedDate: "2026-11-25T23:30:00Z" }));
  assert.equal(when?.toISOString(), "2026-11-25T23:30:00.000Z");
});

// ---- THE QUERY HAS TO ASK FOR IT. ---------------------------------------
// `invoicePaidAt` returns null when the source carries no `receivedDate`, and
// a field dropped from the query looks exactly like a source that has none:
// every paid row would quietly go back to having no payment date, with no
// error anywhere. These read the query text because that is the thing that
// would break.

test("the invoice sync asks Jobber for receivedDate", () => {
  const body = invoicesQuery();
  assert.match(body, /\breceivedDate\b/, "INVOICES_QUERY must request receivedDate");
  assert.match(body, /\bissuedDate\b/, "and still request issuedDate");
});

test("the invoice sync does not pull payment records on every invoice", () => {
  // Deliberate. `paymentRecords` is a nested connection, and this feed
  // paginates to thousands of invoices; it matched the cheap `receivedDate`
  // scalar on 200 of 200 paid invoices when measured, so the cost buys
  // nothing. If someone needs individual payments, give them their own query.
  const body = invoicesQuery();
  assert.doesNotMatch(body, /paymentRecords/);
});
