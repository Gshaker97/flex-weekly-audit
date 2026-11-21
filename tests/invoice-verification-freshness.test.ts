import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { prisma } from "../lib/prisma";
import { invoiceVerificationAgeDays, invoiceVerificationIsStale, invoiceVerificationBasis,
  invoiceVerificationState, invoiceVerificationFailed, oldestInvoiceVerification,
  describeDashboardFreshness, INVOICE_VERIFICATION_STALE_DAYS, INVOICE_VERIFY_CONFIRMED } from "../lib/invoiceMetrics";
import { planOpenInvoiceStatusRefresh, recordInvoiceVerifications,
  OpenInvoiceSnapshot } from "../lib/open-invoice-status-refresh";

const NOW = new Date("2026-11-17T04:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

// The real production row: fully synced 159 days ago, Jobber returns null for it.
const UNCONFIRMABLE = { lastSyncedAt: daysAgo(159), lastVerifiedAt: null, lastVerifyOutcome: "source_unavailable" };
// The common production row: 159 days since a FULL sync, confirmed by the hourly
// check 20 minutes ago. 59 of 73 open invoices looked like this and were wrongly
// reported as unrefreshed.
const CHECKED_RECENTLY = { lastSyncedAt: daysAgo(159), lastVerifiedAt: new Date(NOW.getTime() - 20 * 60_000),
  lastVerifyOutcome: INVOICE_VERIFY_CONFIRMED };

test("age counts from whichever Jobber read confirmed the row last", () => {
  assert.equal(invoiceVerificationAgeDays({ lastSyncedAt: NOW }, NOW), 0);
  assert.equal(invoiceVerificationAgeDays({ lastSyncedAt: daysAgo(159) }, NOW), 159);
  // The hourly check wins when it is newer than the full sync.
  assert.equal(invoiceVerificationAgeDays(CHECKED_RECENTLY, NOW), 0);
  // ...and the full sync wins when IT is newer.
  assert.equal(invoiceVerificationAgeDays({ lastSyncedAt: NOW, lastVerifiedAt: daysAgo(30) }, NOW), 0);
  assert.equal(invoiceVerificationAgeDays({ lastSyncedAt: null, lastVerifiedAt: null }, NOW), null);
  assert.equal(invoiceVerificationAgeDays({ lastSyncedAt: daysAgo(-5) }, NOW), 0);
});

// --- PROOF 1: a recently checked invoice is not falsely flagged ------------

test("PROOF: an invoice confirmed 20 minutes ago is not flagged, despite a 159-day-old full sync", () => {
  assert.equal(invoiceVerificationState(CHECKED_RECENTLY, NOW), "confirmed");
  assert.equal(invoiceVerificationIsStale(CHECKED_RECENTLY, NOW), false);
  assert.equal(invoiceVerificationBasis(CHECKED_RECENTLY, NOW), null);
  const summary = oldestInvoiceVerification([CHECKED_RECENTLY], NOW);
  assert.equal(summary.staleCount, 0, "a confirmed row must not be counted as stale");
  assert.equal(summary.unconfirmedCount, 0);
  assert.doesNotMatch(describeDashboardFreshness(NOW, summary), /NOT confirmed/);
});

test("PROOF: the 59-vs-1 false alarm is gone", () => {
  // 58 rows confirmed hourly + the one Jobber cannot confirm.
  const rows = [...Array(58)].map(() => CHECKED_RECENTLY).concat([UNCONFIRMABLE as any]);
  const summary = oldestInvoiceVerification(rows, NOW);
  assert.equal(summary.total, 59);
  assert.equal(summary.staleCount, 1, "exactly the one unconfirmable row, not 59");
  assert.equal(summary.unconfirmedCount, 1);
});

// --- PROOF 2: the unconfirmable invoice is distinguished, not hidden -------

test("PROOF: the stale unconfirmable invoice is named as unconfirmed, not as paid or refreshed", () => {
  assert.equal(invoiceVerificationState(UNCONFIRMABLE, NOW), "unconfirmed");
  assert.equal(invoiceVerificationFailed(UNCONFIRMABLE), true);
  const basis = invoiceVerificationBasis(UNCONFIRMABLE, NOW)!;
  assert.match(basis, /Jobber could not confirm this invoice/);
  assert.match(basis, /last confirmed 159 days ago/);
  // It must never imply anything about the balance itself.
  assert.doesNotMatch(basis, /paid|unpaid|owes|settled|cleared/i);
});

test("PROOF: the headline keeps the unconfirmable balance and says so", () => {
  const summary = oldestInvoiceVerification([CHECKED_RECENTLY, UNCONFIRMABLE as any], NOW);
  const line = describeDashboardFreshness(new Date("2026-11-17T03:12:00.000Z"), summary);
  assert.match(line, /Last successful sync 2026-11-17 03:12Z/);
  assert.match(line, /1 of 2 shown NOT confirmed from Jobber recently \(oldest 159 days\)/);
  assert.match(line, /1 of those failed its latest check and is still counted at its stored balance/);
  assert.match(line, /not evidence that any one figure here is current/);
});

test("the root dashboard counts unconfirmed rows in the total and labels them separately", () => {
  const source = readFileSync("app/page.tsx", "utf8");
  // The total is reduced over EVERY unpaid overdue row, before any freshness filter.
  assert.match(source, /const overdueInvoiceTotal = overdueUnpaid\.reduce\(\(a, i\) => a \+ \(i\.amountDue \|\| 0\), 0\)/);
  // The unconfirmed figure is an additional sub-total, not a subtraction.
  assert.match(source, /invoiceVerificationState\(i, now\) === "unconfirmed"/);
  assert.match(source, /Jobber could not confirm \(still counted\)/);
  assert.match(source, /lastVerifiedAt: true,\s*\n?\s*lastVerifyOutcome: true/);
  // Nothing filters rows out of the headline population on freshness grounds.
  assert.doesNotMatch(source, /overdueUnpaid\s*\.filter\([^)]*\)\s*\.length\s*;?\s*\/\/\s*headline/);
});

// --- the outcome actually gets recorded -----------------------------------

function cached(id: string, patch: Partial<OpenInvoiceSnapshot> = {}): OpenInvoiceSnapshot {
  return { id: `local-${id}`, jobberInvoiceId: id, invoiceStatus: "awaiting_payment", total: 100,
    amountPaid: 0, amountDue: 100, customerId: "local-owner", customer: { jobberClientId: "owner" },
    lastSyncedAt: daysAgo(159), ...patch };
}
const reader = (rows: Record<string, unknown>) => async (_q: string, vars: Record<string, string>) =>
  Object.fromEntries(Object.entries(vars).map(([k, id]) => [k.replace("id", "i"), rows[id]]));

test("a confirmed, unchanged invoice now records a confirmation instead of nothing", async () => {
  const invoice = cached("inv-confirmed");
  const plan = await planOpenInvoiceStatusRefresh([invoice], reader({
    "inv-confirmed": { id: "inv-confirmed", invoiceStatus: "awaiting_payment",
      amounts: { total: 100, invoiceBalance: 100 }, client: { id: "owner" } },
  }));
  assert.equal(plan.updates.length, 0, "nothing to correct");
  assert.equal(plan.holds.length, 0, "nothing held");
  assert.deepEqual(plan.verifications,
    [{ id: "local-inv-confirmed", jobberInvoiceId: "inv-confirmed", outcome: INVOICE_VERIFY_CONFIRMED }]);
});

test("an invoice Jobber returns null for records source_unavailable, not a confirmation", async () => {
  const invoice = cached("inv-gone");
  const plan = await planOpenInvoiceStatusRefresh([invoice], reader({ "inv-gone": null }));
  assert.equal(plan.holds.length, 1);
  assert.deepEqual(plan.verifications,
    [{ id: "local-inv-gone", jobberInvoiceId: "inv-gone", outcome: "source_unavailable" }]);
});

test("a readable invoice whose stored amounts disagree is not called confirmed", async () => {
  const invoice = cached("inv-drifted");
  const plan = await planOpenInvoiceStatusRefresh([invoice], reader({
    "inv-drifted": { id: "inv-drifted", invoiceStatus: "past_due",
      amounts: { total: 100, invoiceBalance: 55 }, client: { id: "owner" } },
  }));
  assert.equal(plan.verifications[0].outcome, "stored_value_differs");
  assert.notEqual(plan.verifications[0].outcome, INVOICE_VERIFY_CONFIRMED);
});

test("every checked invoice gets exactly one outcome", async () => {
  const rows = [cached("a"), cached("b"), cached("c")];
  const plan = await planOpenInvoiceStatusRefresh(rows, reader({
    a: { id: "a", invoiceStatus: "awaiting_payment", amounts: { total: 100, invoiceBalance: 100 }, client: { id: "owner" } },
    b: null,
    c: { id: "c", invoiceStatus: "nonsense", amounts: { total: 100, invoiceBalance: 100 }, client: { id: "owner" } },
  }));
  assert.equal(plan.checked, 3);
  assert.equal(plan.verifications.length, 3);
  assert.deepEqual(plan.verifications.map(v => v.outcome), [INVOICE_VERIFY_CONFIRMED, "source_unavailable", "source_unreadable"]);
});

test("the writer advances the confirmation time ONLY for confirmed rows", async () => {
  const writes: Array<{ where: any; data: any }> = [];
  (prisma.invoiceRecord as any).updateMany = async (u: any) => { writes.push(u); return { count: 1 }; };
  const at = new Date("2026-11-17T04:00:00.000Z");
  await recordInvoiceVerifications([
    { id: "a", jobberInvoiceId: "a", outcome: INVOICE_VERIFY_CONFIRMED },
    { id: "b", jobberInvoiceId: "b", outcome: "source_unavailable" },
    { id: "c", jobberInvoiceId: "c", outcome: INVOICE_VERIFY_CONFIRMED },
  ], at);
  assert.equal(writes.length, 2, "one write per distinct outcome, not per invoice");
  const confirmed = writes.find(w => w.data.lastVerifyOutcome === INVOICE_VERIFY_CONFIRMED)!;
  assert.deepEqual(confirmed.where, { id: { in: ["a", "c"] } });
  assert.deepEqual(confirmed.data, { lastVerifiedAt: at, lastVerifyOutcome: INVOICE_VERIFY_CONFIRMED });
  const failed = writes.find(w => w.data.lastVerifyOutcome === "source_unavailable")!;
  assert.deepEqual(failed.where, { id: { in: ["b"] } });
  assert.deepEqual(failed.data, { lastVerifyOutcome: "source_unavailable" },
    "a failed check must not touch lastVerifiedAt");
  // No status, balance or payment date is ever written by this path.
  for (const w of writes) {
    for (const key of ["invoiceStatus", "amountDue", "amountPaid", "paidAt", "lastSyncedAt"]) {
      assert.equal(key in w.data, false, `${key} must not be written by the verification recorder`);
    }
  }
});

test("a missing column cannot break the hourly refresh", async () => {
  (prisma.invoiceRecord as any).updateMany = async () => { throw new Error('column "lastVerifiedAt" does not exist'); };
  await recordInvoiceVerifications([{ id: "a", jobberInvoiceId: "a", outcome: INVOICE_VERIFY_CONFIRMED }]);
  // Resolving rather than throwing is the assertion: code and migration may be
  // deployed in either order.
});

// --- guards on the rest of the surface ------------------------------------

test("the stale threshold boundary is exact", () => {
  assert.equal(invoiceVerificationIsStale({ lastSyncedAt: daysAgo(INVOICE_VERIFICATION_STALE_DAYS - 1) }, NOW), false);
  assert.equal(invoiceVerificationIsStale({ lastSyncedAt: daysAgo(INVOICE_VERIFICATION_STALE_DAYS) }, NOW), true);
});

test("no verification record at all reads as stale, never as confirmed", () => {
  const row = { lastSyncedAt: daysAgo(159), lastVerifiedAt: null, lastVerifyOutcome: null };
  assert.equal(invoiceVerificationState(row, NOW), "stale");
  assert.equal(invoiceVerificationFailed(row), false);
  assert.match(invoiceVerificationBasis(row, NOW)!, /Not fully refreshed for 159 days/);
  assert.match(invoiceVerificationBasis({ lastSyncedAt: null }, NOW)!, /No refresh timestamp recorded/);
});

test("an all-confirmed page says so plainly", () => {
  const summary = oldestInvoiceVerification([{ lastSyncedAt: NOW }, CHECKED_RECENTLY], NOW);
  const line = describeDashboardFreshness(new Date("2026-11-17T03:12:00.000Z"), summary);
  assert.match(line, /All 2 shown confirmed from Jobber within 2 days/);
  assert.doesNotMatch(line, /NOT confirmed/);
});

test("no successful sync is stated, not hidden behind a blank", () => {
  assert.match(describeDashboardFreshness(null, oldestInvoiceVerification([UNCONFIRMABLE as any], NOW)),
    /No successful sync recorded/);
});

test("an empty page does not claim staleness it cannot have", () => {
  const line = describeDashboardFreshness(new Date("2026-11-17T03:12:00.000Z"), oldestInvoiceVerification([], NOW));
  assert.match(line, /No invoices shown/);
  assert.doesNotMatch(line, /NOT confirmed/);
});

test("the overdue invoices page shows page freshness and a per-row basis", () => {
  const source = readFileSync("app/risk/overdue-invoices/page.tsx", "utf8");
  assert.match(source, /where: \{ status: "complete", completedAt: \{ not: null \} \}/);
  assert.match(source, /describeDashboardFreshness\(lastSuccessfulSync\?\.completedAt \?\? null, verification\)/);
  assert.match(source, /data-testid="dashboard-freshness"/);
  assert.match(source, /invoiceVerificationBasis\(inv, now\)/);
});

test("the full sync timestamp still means only what it meant before", () => {
  const source = readFileSync("lib/open-invoice-status-refresh.ts", "utf8");
  // The hourly refresh must never pretend to be a full refresh.
  assert.doesNotMatch(source, /lastSyncedAt: new Date\(\)/);
  assert.doesNotMatch(source, /lastSyncedAt: at\b/);
  assert.match(source, /Source object unavailable; retained last-known state/);
  // The verification write is outside the correction transaction.
  const tx = source.indexOf("isolationLevel: \"Serializable\"");
  assert.ok(tx > 0 && source.indexOf("await recordInvoiceVerifications(") > tx);
});

test("the migration is additive only", () => {
  const sql = readFileSync("prisma/migrations/20261117060000_invoice_verification_outcome/migration.sql", "utf8");
  assert.match(sql, /ADD COLUMN "lastVerifiedAt" TIMESTAMP\(3\)/);
  assert.match(sql, /ADD COLUMN "lastVerifyOutcome" TEXT/);
  for (const forbidden of [/DROP /i, /UPDATE /i, /DELETE /i, /NOT NULL/i, /DEFAULT /i, /CREATE INDEX/i]) {
    assert.doesNotMatch(sql, forbidden, `migration must not contain ${forbidden}`);
  }
});
