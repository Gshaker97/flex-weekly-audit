import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { invoiceVerificationAgeDays, invoiceVerificationIsStale, invoiceVerificationBasis,
  oldestInvoiceVerification, describeDashboardFreshness,
  INVOICE_VERIFICATION_STALE_DAYS } from "../lib/invoiceMetrics";

const NOW = new Date("2026-11-17T04:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

test("age is whole days since Jobber last confirmed the invoice", () => {
  assert.equal(invoiceVerificationAgeDays({ lastSyncedAt: NOW }, NOW), 0);
  assert.equal(invoiceVerificationAgeDays({ lastSyncedAt: daysAgo(1) }, NOW), 1);
  assert.equal(invoiceVerificationAgeDays({ lastSyncedAt: daysAgo(159) }, NOW), 159);
  // A future timestamp is clamped, never negative.
  assert.equal(invoiceVerificationAgeDays({ lastSyncedAt: daysAgo(-5) }, NOW), 0);
});

test("a missing timestamp is treated as unverified, not as fresh", () => {
  assert.equal(invoiceVerificationAgeDays({ lastSyncedAt: null }, NOW), null);
  assert.equal(invoiceVerificationIsStale({ lastSyncedAt: null }, NOW), true);
  assert.match(invoiceVerificationBasis({ lastSyncedAt: null }, NOW)!, /No refresh timestamp recorded/);
});

test("a freshly confirmed invoice reports no basis line", () => {
  assert.equal(invoiceVerificationBasis({ lastSyncedAt: NOW }, NOW), null);
  assert.equal(invoiceVerificationIsStale({ lastSyncedAt: NOW }, NOW), false);
});

test("the real stale record reads as 159 days not fully refreshed", () => {
  const stale = { lastSyncedAt: daysAgo(159) };
  assert.equal(invoiceVerificationIsStale(stale, NOW), true);
  const basis = invoiceVerificationBasis(stale, NOW)!;
  assert.match(basis, /Not fully refreshed for 159 days/);
  // It must NOT claim the balance is unverified: the hourly status refresh may have
  // confirmed it, and that outcome is simply not recorded anywhere.
  assert.doesNotMatch(basis, /unverified|not confirmed/i);
  // And it never claims the invoice is or is not still owed.
  assert.doesNotMatch(basis, /paid|unpaid|owes|settled/i);
});

test("the stale threshold boundary is exact", () => {
  assert.equal(invoiceVerificationIsStale({ lastSyncedAt: daysAgo(INVOICE_VERIFICATION_STALE_DAYS - 1) }, NOW), false);
  assert.equal(invoiceVerificationIsStale({ lastSyncedAt: daysAgo(INVOICE_VERIFICATION_STALE_DAYS) }, NOW), true);
});

test("one day is singular", () => {
  assert.match(invoiceVerificationBasis({ lastSyncedAt: daysAgo(1) }, NOW, 1)!, /for 1 day$/);
});

test("page summary reports the worst row, not the average", () => {
  const rows = [{ lastSyncedAt: NOW }, { lastSyncedAt: daysAgo(159) }, { lastSyncedAt: daysAgo(3) }];
  const summary = oldestInvoiceVerification(rows, NOW);
  assert.equal(summary.total, 3);
  assert.equal(summary.staleCount, 2);
  assert.equal(summary.oldestDays, 159);
});

test("an all-fresh page says so plainly", () => {
  const summary = oldestInvoiceVerification([{ lastSyncedAt: NOW }, { lastSyncedAt: NOW }], NOW);
  const line = describeDashboardFreshness(new Date("2026-11-17T03:12:00.000Z"), summary);
  assert.match(line, /Last successful sync 2026-11-17 03:12Z/);
  assert.match(line, /All 2 shown fully refreshed/);
  assert.doesNotMatch(line, /NOT fully refreshed/);
});

test("a completed sync is never allowed to imply the figures are current", () => {
  const summary = oldestInvoiceVerification([{ lastSyncedAt: NOW }, { lastSyncedAt: daysAgo(159) }], NOW);
  const line = describeDashboardFreshness(new Date("2026-11-17T03:12:00.000Z"), summary);
  // This is the whole point: the run is green AND the page says not to trust it.
  assert.match(line, /Last successful sync/);
  assert.match(line, /1 of 2 shown NOT fully refreshed recently/);
  assert.match(line, /oldest 159 days/);
  assert.match(line, /Per-invoice source confirmation is not recorded/);
  assert.match(line, /not evidence that any one figure here is current/);
});

test("no successful sync is stated, not hidden behind a blank", () => {
  const summary = oldestInvoiceVerification([{ lastSyncedAt: daysAgo(159) }], NOW);
  assert.match(describeDashboardFreshness(null, summary), /No successful sync recorded/);
});

test("an empty page does not claim staleness it cannot have", () => {
  const line = describeDashboardFreshness(new Date("2026-11-17T03:12:00.000Z"), oldestInvoiceVerification([], NOW));
  assert.match(line, /No invoices shown/);
  assert.doesNotMatch(line, /NOT fully refreshed/);
});

// --- the surfaces actually read and display it ----------------------------

test("the root dashboard selects lastSyncedAt and reports the unverified portion", () => {
  const source = readFileSync("app/page.tsx", "utf8");
  // Previously the select omitted lastSyncedAt entirely, so staleness was unknowable.
  assert.match(source, /select: \{ amountDue: true, invoiceStatus: true, lastSyncedAt: true \}/);
  assert.match(source, /oldestInvoiceVerification\(overdueUnpaid, now\)/);
  assert.match(source, /invoiceVerificationIsStale\(i, now\)/);
  assert.match(source, /not fully refreshed recently/);
});

test("the overdue invoices page shows page freshness and a per-row basis", () => {
  const source = readFileSync("app/risk/overdue-invoices/page.tsx", "utf8");
  // Freshness comes from the rows displayed AND the last successful run.
  assert.match(source, /where: \{ status: "complete", completedAt: \{ not: null \} \}/);
  assert.match(source, /describeDashboardFreshness\(lastSuccessfulSync\?\.completedAt \?\? null, verification\)/);
  assert.match(source, /data-testid="dashboard-freshness"/);
  assert.match(source, /invoiceVerificationBasis\(inv, now\)/);
});

test("the status refresh still never advances the verification timestamp", () => {
  // If a held refresh bumped lastSyncedAt, every figure above would read as fresh.
  const source = readFileSync("lib/open-invoice-status-refresh.ts", "utf8");
  assert.match(source, /Source object unavailable; retained last-known state/);
  assert.doesNotMatch(source, /lastSyncedAt: new Date\(\)/);
  assert.doesNotMatch(source, /lastSyncedAt: now/);
});
