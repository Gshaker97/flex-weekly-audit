import test from "node:test";
import assert from "node:assert/strict";
import { phoneExitStage, phoneSourcePlan, PhoneInvoiceEvidence } from "../lib/ghl-phone-state";

const now = new Date("2026-11-07T00:00:00Z");
const invoice: PhoneInvoiceEvidence = {
  id: "synthetic-invoice", client: { id: "synthetic-client" }, invoiceStatus: "past_due",
  amounts: { total: 100, invoiceBalance: 100 }, issuedDate: "2026-05-01",
  createdAt: null, dueDate: "2026-06-01",
};
const plan = (source: PhoneInvoiceEvidence[]) => phoneSourcePlan("synthetic-client", [invoice.id], source, now);
const invalidAmounts: Array<[string, unknown]> = [
  ["missing amounts", undefined], ["null amounts", null],
  ["missing total", { invoiceBalance: 1 }], ["missing balance", { total: 100 }],
  ["null total", { total: null, invoiceBalance: 1 }], ["null balance", { total: 100, invoiceBalance: null }],
  ["string total", { total: "100", invoiceBalance: 1 }], ["string balance", { total: 100, invoiceBalance: "1" }],
  ["NaN total", { total: NaN, invoiceBalance: 1 }], ["NaN balance", { total: 100, invoiceBalance: NaN }],
  ["infinite total", { total: Infinity, invoiceBalance: 1 }], ["infinite balance", { total: 100, invoiceBalance: Infinity }],
  ["negative total", { total: -100, invoiceBalance: 1 }], ["negative balance", { total: 100, invoiceBalance: -1 }],
  ["balance above total", { total: 100, invoiceBalance: 150 }],
  ["zero total with debt", { total: 0, invoiceBalance: 1 }],
  ["sub-cent total", { total: 100.001, invoiceBalance: 1 }], ["sub-cent balance", { total: 100, invoiceBalance: 1.001 }],
  ["small nonzero sub-cent balance", { total: 100, invoiceBalance: 0.000000001 }],
  ["near-cent total", { total: 100.000000001, invoiceBalance: 1 }],
  ["near-cent balance", { total: 100, invoiceBalance: 1.000000001 }],
  ["unsafe integer-cent total", { total: Number.MAX_SAFE_INTEGER, invoiceBalance: 1 }],
  ["unsafe integer-cent balance", { total: Number.MAX_SAFE_INTEGER, invoiceBalance: Number.MAX_SAFE_INTEGER }],
];
for (const [label, amounts] of invalidAmounts) {
  test(`source planner holds ${label} for Overdue and Sent plans`, () => {
    for (const invoiceStatus of ["past_due", "awaiting_payment"]) {
      const source = [{ ...invoice, invoiceStatus, dueDate: "2099-01-01", amounts: amounts as PhoneInvoiceEvidence["amounts"] }];
      assert.equal(plan(source), null);
      assert.equal(phoneExitStage("synthetic-client", [invoice.id], source, now), null);
    }
  });
}
test("explicit paid and zero balance still require a known valid cent total", () => {
  for (const total of [null, undefined, "100", NaN, Infinity, -1, 100.001, 100.000000001, Number.MAX_SAFE_INTEGER]) {
    assert.equal(plan([{ ...invoice, invoiceStatus: "paid", amounts: { total: total as number, invoiceBalance: 0 } }]), null);
  }
  for (const total of [0, 0.29, 19.99, 100]) {
    assert.deepEqual(plan([{ ...invoice, invoiceStatus: "paid", issuedDate: null, amounts: { total, invoiceBalance: 0 } }]),
      { stage: "Invoice Paid", total: 0, count: 0 });
  }
});
test("zero balance alone and paid with positive or credit balances never imply Paid", () => {
  for (const invoiceStatus of ["past_due", "awaiting_payment", "unknown", "void", "bad_debt", null]) {
    assert.equal(plan([{ ...invoice, invoiceStatus, amounts: { total: 100, invoiceBalance: 0 } }]), null);
  }
  for (const invoiceBalance of [0.01, -0.01, 0.001]) {
    assert.equal(plan([{ ...invoice, invoiceStatus: "paid", amounts: { total: 100, invoiceBalance } }]), null);
  }
});
test("ordinary decimal cents survive binary floating point and aggregate in integer cents", () => {
  for (const value of [0.01, 0.29, 19.99, 100.01]) {
    assert.deepEqual(plan([{ ...invoice, amounts: { total: value, invoiceBalance: value } }]),
      { stage: "Invoice Overdue", total: value, count: 1 });
  }
  for (const invoiceStatus of ["past_due", "awaiting_payment"]) {
    const source = [0.1, 0.2].map((invoiceBalance, index) => ({ ...invoice,
      id: index ? "second" : invoice.id, invoiceStatus, dueDate: "2099-01-01",
      amounts: { total: 100, invoiceBalance },
    }));
    assert.deepEqual(plan(source), { stage: invoiceStatus === "past_due" ? "Invoice Overdue" : "Invoice Sent", total: 0.3, count: 2 });
  }
});
test("overflow of otherwise valid per-invoice cents holds the full source group", () => {
  for (const invoiceStatus of ["past_due", "awaiting_payment"]) {
    const source = [invoice.id, "second"].map(id => ({ ...invoice, id, invoiceStatus, dueDate: "2099-01-01",
      amounts: { total: 50000000000000, invoiceBalance: 50000000000000 },
    }));
    assert.equal(plan(source), null);
  }
});
test("a safe cent sum that loses a cent when converted back to dollars is held", () => {
  const large = { ...invoice, amounts: { total: 90071992547409.7, invoiceBalance: 90071992547409.7 } };
  assert.deepEqual(plan([large]), { stage: "Invoice Overdue", total: 90071992547409.7, count: 1 });
  assert.equal(plan([large, { ...invoice, id: "second", amounts: { total: 0.01, invoiceBalance: 0.01 } }]), null);
});
test("an invalid uncached sibling holds valid debt or paid evidence for the same owner", () => {
  for (const first of [invoice, { ...invoice, invoiceStatus: "paid", amounts: { total: 100, invoiceBalance: 0 } }]) {
    assert.equal(plan([first, { ...invoice, id: "uncached", amounts: { total: 100, invoiceBalance: 150 } }]), null);
  }
});
test("missing stored source coverage and unknown sibling status remain holds", () => {
  assert.equal(plan([]), null);
  assert.equal(plan([{ ...invoice, id: "other" }]), null);
  assert.equal(plan([invoice, { ...invoice, id: "uncached", invoiceStatus: "unknown" }]), null);
});
