import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  issuedInvoiceWhere, openReceivablesWhere, balanceReviewWhere,
  overdueInvoicesWhere, legacyOverdueWhere, invoiceValueIncluded,
  invoiceReviewReason, totalLessBalance, sumInvoiceMonths,
} from "../lib/invoiceMetrics";

const date = (s: string) => new Date(`${s}T12:00:00-07:00`);
const range = { start: date("2026-01-15"), end: date("2026-01-20"), label: "Test", isMonthOverMonth: false };
const cutoff = new Date("2026-01-01T00:00:00Z");

// Minimal evaluator for only the Prisma filters exercised by this module.
function matches(record: any, where: any = {}): boolean {
  return Object.entries(where).every(([key, rule]: [string, any]) => {
    if (key === "OR") return rule.some((r: any) => matches(record, r));
    if (key === "AND") return rule.every((r: any) => matches(record, r));
    if (key === "NOT") return !matches(record, rule);
    const value = record[key];
    if (rule == null || typeof rule !== "object" || rule instanceof Date) return value === rule;
    return Object.entries(rule).every(([op, expected]: [string, any]) => {
      if (op === "in") return expected.includes(value);
      if (op === "notIn") return value != null && !expected.includes(value);
      if (op === "not") return value !== expected;
      if (value == null) return false;
      if (op === "gte") return value >= expected;
      if (op === "lte") return value <= expected;
      if (op === "gt") return value > expected;
      if (op === "lt") return value < expected;
      return value === expected;
    });
  });
}

const invoices = [
  { id: "paid", invoiceStatus: "paid", total: 100, amountDue: 0 },
  { id: "open", invoiceStatus: "awaiting_payment", total: 200, amountDue: 200 },
  { id: "partial", invoiceStatus: "past_due", total: 100, amountDue: 60 },
  { id: "paid-conflict", invoiceStatus: "paid", total: 50, amountDue: 50 },
  { id: "void", invoiceStatus: "void", total: 40, amountDue: 0 },
  { id: "draft", invoiceStatus: "draft", total: 25, amountDue: 25 },
  { id: "unknown", invoiceStatus: null, total: 30, amountDue: 30 },
  { id: "credit", invoiceStatus: "paid", total: 100, amountDue: -20 },
  { id: "bad-debt", invoiceStatus: "bad_debt", total: 35, amountDue: 0 },
  { id: "zero-overdue", invoiceStatus: "past_due", total: 10, amountDue: 0 },
].map(i => ({ ...i, jobberInvoiceId: i.id, invoiceNumber: i.id, issuedAt: date("2026-01-16"), dueAt: date("2026-01-16"), amountPaid: 999, customer: null, clientName: "Synthetic" }));
invoices.push({ ...invoices[2], id: "legacy", invoiceNumber: "legacy", issuedAt: date("2025-12-10") });

test("billing excludes draft, void and unknown, retaining bad debt as historical billing", () => {
  assert.deepEqual(invoices.filter(i => matches(i, issuedInvoiceWhere(range))).map(i => i.id), ["paid", "open", "partial", "paid-conflict", "credit", "bad-debt", "zero-overdue"]);
  assert.equal(invoiceValueIncluded("future-new-status"), false);
});
test("positive paid/non-open conflicts are retained separately, without netting credit balances", () => {
  assert.deepEqual(invoices.filter(i => matches(i, openReceivablesWhere(range))).map(i => i.id), ["open", "partial"]);
  assert.deepEqual(invoices.filter(i => matches(i, balanceReviewWhere(range))).map(i => i.id), ["paid-conflict", "draft", "unknown"]);
  assert.match(invoiceReviewReason(invoices[3]), /verify in Jobber/);
});
test("collections cutoff and legacy populations partition positive past due, excluding zero balances", () => {
  const all = { start: date("2000-01-01"), end: date("2026-12-31") };
  assert.deepEqual(invoices.filter(i => matches(i, overdueInvoicesWhere(all, cutoff))).map(i => i.id), ["partial"]);
  assert.deepEqual(invoices.filter(i => matches(i, legacyOverdueWhere(all, cutoff))).map(i => i.id), ["legacy"]);
});
test("open status with zero or negative balance is flagged, not assumed settled", () => {
  assert.match(invoiceReviewReason({ invoiceStatus: "past_due", amountDue: 0 }), /verify source and payment evidence/);
  assert.match(invoiceReviewReason({ invoiceStatus: "awaiting_payment", amountDue: -20 }), /zero or negative balance/);
  assert.equal(invoiceReviewReason({ invoiceStatus: "paid", amountDue: 0 }), "");
});
test("balance reduction is arithmetic only, preserving credits rather than pretending cash", () => {
  assert.equal(totalLessBalance(100, 60), 40);
  assert.equal(totalLessBalance(40, 0), 40); // can be a void, not a payment
  assert.equal(totalLessBalance(100, -20), 120);
});
test("monthly bucket uses Arizona time at UTC month boundaries", () => {
  const result = sumInvoiceMonths([{ issuedAt: new Date("2026-02-01T02:00:00Z"), total: 20 }, { issuedAt: new Date("2026-02-01T08:00:00Z"), total: 30 }]);
  assert.equal(result.get("2026-01"), 20);
  assert.equal(result.get("2026-02"), 30);
});

test("actual report and KPIs agree, partial months stay bounded, exports disclaim cash", async () => {
  const jobs = [{ total: 900, completedAt: date("2026-01-10"), isRecurring: false }, { total: 300, completedAt: date("2026-01-16"), isRecurring: false }];
  const model = (records: any[]) => ({
    findMany: async ({ where }: any = {}) => records.filter(r => matches(r, where)),
    count: async ({ where }: any = {}) => records.filter(r => matches(r, where)).length,
    groupBy: async () => [],
    aggregate: async ({ where, _sum, _count }: any) => {
      const selected = records.filter(r => matches(r, where));
      return { _sum: Object.fromEntries(Object.keys(_sum ?? {}).map(k => [k, selected.reduce((sum, r) => sum + r[k], 0)])), ...(_count ? { _count: selected.length } : {}) };
    },
  });
  (globalThis as any).prisma = {
    invoiceRecord: model(invoices), jobRecord: model(jobs), visitRecord: model([]), customer: model([]), timeEntry: model([]),
    monthlySnapshot: { findMany: async () => [{ year: 2025, month: 12, invoicedRevenue: 9999 }, { year: 2026, month: 1, invoicedRevenue: 9999, jobsCompleted: 999, averageJobValue: 999, newCustomers: 999 }] },
    syncRun: { findFirst: async () => null },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Unexpected network access"); };
  try {
    const { buildReport } = await import("../lib/report");
    const { computeDashboardKPIs } = await import("../lib/kpis");
    const { renderReportCsv } = await import("../lib/reportCsv");
    const kpis = await computeDashboardKPIs(range);
    assert.equal(kpis.revenueInRange, 595);
    assert.equal(kpis.outstandingReceivables, 260);
    assert.equal(kpis.balanceReviewTotal, 105);
    assert.equal(kpis.balanceReviewCount, 3);
    assert.equal(kpis.monthlySeries.find(m => m.month === 1)?.invoicedRevenue, 595);
    const report = await buildReport(range);
    assert.equal(report.sections.find(s => s.key === "receivables")?.rows.length, 2);
    assert.equal(report.sections.find(s => s.key === "invoice-review")?.rows.length, 3);
    assert.deepEqual(report.sections.find(s => s.key === "monthly")?.rows[0].slice(1), [595, 1, 300, 0]);
    assert.equal(report.sections.find(s => s.key === "invoices")?.rows.length, 10);
    const rawInvoices = report.sections.find(s => s.key === "invoices")!;
    const reviewIndex = rawInvoices.columns.findIndex(c => c.header === "Review Note");
    assert.ok(reviewIndex >= 0);
    assert.match(String(rawInvoices.rows.find(row => row[0] === "zero-overdue")![reviewIndex]), /verify source and payment evidence/);
    assert.equal(report.summary.find(s => s.label === "Cash Collected")?.value, "Not verified");
    for (const key of ["churn", "new-customers"]) {
      const section = report.sections.find(s => s.key === key)!;
      assert.ok(section.columns.some(c => c.header === "Cached Job Value"));
      assert.match(section.description, /sum of cached linked job totals across statuses; not lifetime invoiced or collected revenue/);
    }
    const recurringSummary = report.summary.find(s => s.label === "Recurring share of estimated visit value")!;
    assert.match(recurringSummary.detail!, /Estimated completed or invoiced visit value in range; not invoice revenue or cash/);
    const csv = renderReportCsv(report);
    assert.doesNotMatch(csv, /Lifetime Revenue/);
    assert.match(csv, /Total Minus Balance/);
    assert.doesNotMatch(csv, /,Paid,/);
    assert.match(csv, /Invoice Balances Requiring Review/i);
  } finally { globalThis.fetch = originalFetch; }
});


test("chart tooltip identifies issued invoice value rather than generic revenue", () => {
  const source = readFileSync(new URL("../components/ui/RevenueLineChart.tsx", import.meta.url), "utf8");
  assert.match(source, /"Issued Invoice Value"/);
  assert.doesNotMatch(source, /"Revenue"/);
});


test("churn page labels cached job totals without lifetime revenue claims", () => {
  const source = readFileSync(new URL("../app/risk/churn/page.tsx", import.meta.url), "utf8");
  assert.match(source, /label="Cached Job Value"/);
  assert.match(source, />Cached Job Value<\/th>/);
  assert.match(source, /Sum of cached linked job totals across statuses; not lifetime invoiced or collected revenue/);
  assert.doesNotMatch(source, /Historical Revenue|Lifetime Revenue|Lifetime revenue|historical revenue/);
});
