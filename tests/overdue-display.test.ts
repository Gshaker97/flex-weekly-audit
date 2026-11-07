import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { overdueInvoicesWhere, legacyOverdueWhere, overdueDisplayBasis } from "../lib/invoiceMetrics";

const cutoff = new Date("2026-01-01T00:00:00Z");
const now = new Date("2026-06-10T19:00:00Z");
const range = { start: new Date("2025-01-01T00:00:00Z"), end: new Date("2026-06-30T23:59:59Z"), label: "Synthetic range", isMonthOverMonth: false };
const before = new Date(now.getTime() - 1);
const after = new Date(now.getTime() + 1);
function row(id: string, invoiceStatus: string | null, amountDue: number, dueAt: Date | null, issuedAt = new Date("2026-04-01T12:00:00Z")) {
  return { id, jobberInvoiceId: id, invoiceNumber: id, clientName: "Synthetic", customer: null, invoiceStatus, amountDue, total: Math.max(amountDue, 0), amountPaid: 0, dueAt, issuedAt };
}
function matches(record: any, where: any = {}): boolean {
  return Object.entries(where).every(([key, rule]: [string, any]) => {
    if (key === "OR") return rule.some((r: any) => matches(record, r));
    if (key === "AND") return rule.every((r: any) => matches(record, r));
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
      throw new Error(`Unsupported test filter ${op}`);
    });
  });
}
const fixtures = [
  row("explicit-null", "past_due", 20, null),
  row("explicit-past", "past_due", 30, before),
  row("aged-awaiting", "awaiting_payment", 40, before),
  row("explicit-future", "past_due", 15, after),
  row("at-boundary", "awaiting_payment", 50, now),
  row("future", "awaiting_payment", 60, after),
  row("no-due", "awaiting_payment", 70, null),
  ...["paid", "void", "draft", "bad_debt", "new-status", null].map((s, i) => row(`excluded-${i}`, s, 80, before)),
  row("awaiting-zero", "awaiting_payment", 0, before),
  row("past-zero", "past_due", 0, before),
  row("past-credit", "past_due", -5, before),
  row("awaiting-credit", "awaiting_payment", -5, before),
  row("legacy-aged", "awaiting_payment", 11, before, new Date(cutoff.getTime() - 1)),
  row("legacy-status", "past_due", 12, null, new Date(cutoff.getTime() - 1)),
];

test("strict stored-instant aging adds awaiting rows without changing status or duplicating explicit rows", () => {
  const where = overdueInvoicesWhere(range, cutoff, now);
  const result = fixtures.filter(r => matches(r, where));
  assert.deepEqual(result.map(r => r.id), ["explicit-null", "explicit-past", "aged-awaiting", "explicit-future"]);
  assert.equal(result.reduce((s, r) => s + r.amountDue, 0), 105);
  assert.equal(new Set(result.map(r => r.id)).size, result.length);
  assert.equal(result.find(r => r.id === "aged-awaiting")?.invoiceStatus, "awaiting_payment");
});

test("null/future/exact-boundary awaiting dates and nonpositive/non-open rows never age into overdue", () => {
  const selected = fixtures.filter(r => matches(r, overdueInvoicesWhere(range, cutoff, now))).map(r => r.id);
  for (const id of ["at-boundary", "future", "no-due", "awaiting-zero", "past-zero", "past-credit", "awaiting-credit", ...Array.from({length:6},(_,i)=>`excluded-${i}`)]) {
    assert.ok(!selected.includes(id), id);
  }
  assert.equal(overdueDisplayBasis(row("invalid", "awaiting_payment", 1, new Date("invalid")), now), null);
  assert.throws(() => overdueInvoicesWhere(range, cutoff, new Date("invalid")), /Invalid display reference/);
});

test("cutoff and selected issue bounds stay inclusive and legacy rows stay separate", () => {
  const scoped = { start: cutoff, end: new Date("2026-02-01T00:00:00Z") };
  const rows = [
    row("cutoff", "awaiting_payment", 1, before, cutoff),
    row("end", "awaiting_payment", 1, before, scoped.end),
    row("after-end", "awaiting_payment", 1, before, new Date(scoped.end.getTime()+1)),
    row("before-cutoff", "awaiting_payment", 1, before, new Date(cutoff.getTime()-1)),
    row("missing-issued", "past_due", 1, before, null as any),
  ];
  assert.deepEqual(rows.filter(r=>matches(r,overdueInvoicesWhere(scoped,cutoff,now))).map(r=>r.id), ["cutoff","end"]);
  assert.deepEqual(fixtures.filter(r=>matches(r,legacyOverdueWhere(range,cutoff,now))).map(r=>r.id), ["legacy-aged","legacy-status"]);
  assert.deepEqual(fixtures.filter(r=>matches(r,legacyOverdueWhere(scoped,cutoff,now))), []);
  // Collections remains unfiltered by a selected end date, as before.
  assert.ok(matches(rows[2],overdueInvoicesWhere(undefined,cutoff,now)));
});

test("stored due timestamps across Arizona midnight use strict instant order, not the sent-day policy clock", () => {
  const due = new Date("2026-06-11T07:00:00Z"); // midnight Arizona
  const item = row("arizona", "awaiting_payment", 1, due);
  assert.equal(overdueDisplayBasis(item,new Date("2026-06-11T06:59:59.999Z")),null);
  assert.equal(overdueDisplayBasis(item,due),null);
  assert.equal(overdueDisplayBasis(item,new Date("2026-06-11T07:00:00.001Z")),"Calculated from stored due date");
  assert.equal(overdueDisplayBasis(row("explicit", "past_due", 1, null),now),"Cached past_due status");
  assert.equal(overdueDisplayBasis(row("utc-midnight", "awaiting_payment", 1,new Date("2026-06-10T00:00:00Z")),now),"Calculated from stored due date");
});

test("actual Collections and report share the same display population and preserve raw status, without writes or network", async () => {
  const queries: unknown[]=[];
  const model=(records:any[])=>({
    findMany:async({where}:any={})=>{queries.push(where);return records.filter(r=>matches(r,where));},
    count:async({where}:any={})=>records.filter(r=>matches(r,where)).length,
    groupBy:async()=>[],
    aggregate:async({where,_sum,_count}:any)=>{const selected=records.filter(r=>matches(r,where));return {_sum:Object.fromEntries(Object.keys(_sum??{}).map(k=>[k,selected.reduce((s,r)=>s+r[k],0)])),...(_count?{_count:selected.length}:{})};},
  });
  (globalThis as any).prisma={invoiceRecord:model(fixtures),jobRecord:model([]),visitRecord:model([]),customer:model([]),timeEntry:model([]),monthlySnapshot:model([]),lateInvoiceCall:model([]),syncRun:{findFirst:async()=>null}};
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>{throw new Error("Unexpected network access");};
  try {
    const {getLateInvoiceCollections}=await import("../lib/lateInvoices");
    const {buildReport}=await import("../lib/report");
    const rows=await getLateInvoiceCollections(now);
    assert.equal(rows.length,4);assert.equal(rows.reduce((s,r)=>s+r.amountDue,0),105);
    const aged=rows.find(r=>r.invoiceNumber==="aged-awaiting")!;
    assert.equal(aged.cachedStatus,"awaiting_payment");assert.equal(aged.displayBasis,"Calculated from stored due date");
    assert.ok(rows.every(r=>r.reminders.every(c=>c.status==="unknown")));
    const report=await buildReport(range,now);
    const section=report.sections.find(s=>s.key==="overdue-invoices")!;
    const rawStatus=section.columns.findIndex(c=>c.header==="Cached Status");
    const basis=section.columns.findIndex(c=>c.header==="Display Basis");
    assert.equal(section.rows.length,rows.length);
    const agedRow=section.rows.find(r=>r[0]==="aged-awaiting")!;
    assert.equal(agedRow[rawStatus],"awaiting_payment");assert.equal(agedRow[basis],aged.displayBasis);
    assert.equal(report.summary.find(s=>s.label==="Overdue Invoices in Collections Scope")?.value,"$105.00");
    assert.match(section.description,/not refreshed source status or the original sent-day reminder clock/);
    assert.equal(report.sections.find(s=>s.key==="legacy-overdue")?.rows.length,2);
    assert.ok(queries.length>0);
  } finally {globalThis.fetch=originalFetch;}
});

test("dashboard and invoice pages disclose stored-date calculation and preserve raw status",()=>{
  for(const path of ["app/page.tsx","app/risk/overdue-invoices/page.tsx","app/risk/late-invoices/page.tsx"]){
    const source=readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
    assert.match(source,/stored due date/);
    assert.match(source,/not refreshed source status/);
    assert.match(source,/original sent-day reminder clock/);
    if(path!=="app/page.tsx")assert.match(source,/Cached status:/);
  }
});
