import test from "node:test";
import assert from "node:assert/strict";
import { invoiceCalendarDate, invoiceReminderClock, invoiceReminderMilestones, addInvoiceCalendarDays } from "../lib/invoice-reminder-clock";
import { phoneSourcePlan, PhoneInvoiceEvidence } from "../lib/ghl-phone-state";

const invoice: PhoneInvoiceEvidence = { id: "synthetic-invoice", client: { id: "synthetic-owner" },
  invoiceStatus: "awaiting_payment", amounts: { total: 100, invoiceBalance: 100 },
  issuedDate: "2026-11-01", dueDate: "2026-11-08", createdAt: "2026-10-31T12:00:00Z" };
const plan = (now: string, patches: Partial<PhoneInvoiceEvidence>[] = [{}]) =>
  phoneSourcePlan("synthetic-owner", [invoice.id], patches.map(p => ({ ...invoice, ...p })), new Date(now));

test("day two is the next Arizona date, not the due timestamp plus 24 hours", () => {
  for (const due of ["2026-11-08", "2026-11-08T07:00:00Z", "2026-11-08T23:59:59-07:00"]) {
    const onDue = invoiceReminderClock("2026-11-01", due, new Date("2026-11-09T06:59:59.999Z"))!;
    assert.equal(onDue.daysPastDue, 0); assert.equal(onDue.isOverdue, false);
    assert.equal(onDue.overdueOn, "2026-11-09");
    const next = invoiceReminderClock("2026-11-01", due, new Date("2026-11-09T07:00:00Z"))!;
    assert.equal(next.daysPastDue, 1); assert.equal(next.isOverdue, true);
  }
});

test("date-only source values never shift to the previous day; timestamps honor offsets", () => {
  assert.equal(invoiceCalendarDate("2026-11-08"), "2026-11-08");
  assert.equal(invoiceCalendarDate("2026-11-08T00:00:00Z"), "2026-11-07");
  assert.equal(invoiceCalendarDate("2026-11-08T07:00:00Z"), "2026-11-08");
  assert.equal(invoiceCalendarDate("2026-11-08T00:00:00-07:00"), "2026-11-08");
});

test("invalid or ambiguous source dates are held, never normalized or createdAt-substituted", () => {
  for (const invalid of [null, "", "2026-02-30", "2026-02-30T07:00:00Z", "2026-13-01", "2026-11-08T00:00:00", "11/08/2026", "2026-11-08T24:00:00Z", "2026-11-08T00:00:00+25:00"]) {
    assert.equal(invoiceCalendarDate(invalid), null);
    assert.equal(plan("2026-11-09T12:00:00Z", [{ dueDate: invalid }]), null);
    assert.equal(plan("2026-11-09T12:00:00Z", [{ issuedDate: invalid }]), null);
  }
  assert.equal(invoiceReminderClock("2026-11-10", "2026-11-09", new Date("2026-11-11")), null);
  assert.equal(invoiceReminderClock("2026-11-10", "2026-11-15", new Date("2026-11-09")), null);
  assert.equal(invoiceReminderClock("2026-11-01", "2026-11-08", new Date(NaN)), null);
});

test("net zero, seven and fifteen terms all use due date, not issue date", () => {
  for (const [dueDate, dayTwo] of [["2026-11-01", "2026-11-02"], ["2026-11-08", "2026-11-09"], ["2026-11-16", "2026-11-17"]]) {
    assert.equal(plan(`${dueDate}T20:00:00Z`, [{ dueDate }])?.stage, "Invoice Sent");
    assert.equal(plan(`${dayTwo}T07:00:00Z`, [{ dueDate }])?.stage, "Invoice Overdue");
  }
});

test("past_due status cannot bypass the clock or missing due date", () => {
  assert.equal(plan("2026-11-08T20:00:00Z", [{ invoiceStatus: "past_due" }]), null);
  assert.equal(plan("2026-11-09T07:00:00Z", [{ invoiceStatus: "past_due" }])?.stage, "Invoice Overdue");
  assert.equal(plan("2026-11-09T07:00:00Z", [{ invoiceStatus: "past_due", dueDate: null }]), null);
});

test("awaiting-payment aging works without source updatedAt or status change", () => {
  assert.deepEqual(plan("2026-11-08T20:00:00Z"), { stage: "Invoice Sent", total: 100, count: 1 });
  assert.deepEqual(plan("2026-11-09T07:00:00Z"), { stage: "Invoice Overdue", total: 100, count: 1 });
});

test("known old/zero settled evidence remains explicit; positive paid conflict holds", () => {
  assert.deepEqual(plan("2026-11-09T07:00:00Z", [{ invoiceStatus: "paid", amounts: { total: 100, invoiceBalance: 0 }, issuedDate: null, dueDate: null }]),
    { stage: "Invoice Paid", total: 0, count: 0 });
  assert.equal(plan("2026-11-09T07:00:00Z", [{ invoiceStatus: "paid" }]), null);
  assert.equal(plan("2026-11-09T07:00:00Z", [{ issuedDate: "2025-12-31" }]), null);
});

test("one overdue invoice retains precedence over a later unpaid cycle", () => {
  assert.deepEqual(plan("2026-11-09T07:00:00Z", [{}, { id: "future-invoice", dueDate: "2026-12-01", amounts: { total: 200, invoiceBalance: 200 } }]),
    { stage: "Invoice Overdue", total: 100, count: 1 });
  assert.equal(plan("2026-11-09T07:00:00Z", [{}, { id: "unknown-due", dueDate: null }]), null);
});

test("first text is due plus ten, not stage entry plus ten; no Day 2 text", () => {
  const steps = invoiceReminderMilestones("maintenance", "2026-11-01", "2026-11-08", new Date("2026-11-09T12:00:00Z"))!;
  assert.deepEqual(steps.map(s => s.dayPastDue), [10, 15, 20, 21, 25, 30]);
  assert.equal(steps[0].scheduledOn, "2026-11-18");
  assert.equal(steps.find(s => s.dayPastDue === 21)?.audience, "internal");
  assert.ok(steps.every(s => s.timing === "future"));
});

test("irrigation has only two homeowner texts and day21 internal prompt", () => {
  const steps = invoiceReminderMilestones("irrigation", "2026-11-01", "2026-11-08", new Date("2026-11-09T12:00:00Z"))!;
  assert.deepEqual(steps.map(s => [s.dayPastDue, s.audience]), [[10, "homeowner"], [15, "homeowner"], [21, "internal"]]);
});

test("fee and suspension assertions are evidence requirements, not performed actions", () => {
  const steps = invoiceReminderMilestones("maintenance", "2026-11-01", "2026-11-08", new Date("2026-11-09T12:00:00Z"))!;
  assert.deepEqual(steps.find(s => s.dayPastDue === 15)?.requiredFacts, ["three_percent_fee_applied"]);
  assert.deepEqual(steps.find(s => s.dayPastDue === 30)?.requiredFacts, ["service_suspended", "collections_after_day_35_policy"]);
  assert.equal(steps.some(s => "send" in s || "charge" in s || "suspend" in s), false);
});

test("expired steps are reconcile-only, never an automatic catch-up batch", () => {
  const steps = invoiceReminderMilestones("maintenance", "2026-11-01", "2026-11-08", new Date("2026-11-23T12:00:00Z"))!;
  assert.equal(steps[0].timing, "past_reconcile"); assert.equal(steps[1].timing, "today");
  assert.equal(steps[2].timing, "future");
});

test("month/year and leap-day arithmetic are calendar based", () => {
  assert.equal(addInvoiceCalendarDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addInvoiceCalendarDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addInvoiceCalendarDays("2026-02-28", 1), "2026-03-01");
  assert.equal(addInvoiceCalendarDays("2026-02-30", 1), null);
});
