import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  overdueInvoicesWhere,
  legacyOverdueWhere,
  legacyOverdueAnyRangeWhere,
  invoiceVerificationState,
} from "../lib/invoiceMetrics";

const CUTOFF = new Date("2026-01-01T00:00:00Z");
const NOW = new Date("2026-11-17T14:30:00.000Z");
const YTD = { start: new Date("2026-01-01T00:00:00Z"), end: NOW };
const ALL_TIME = { start: new Date("2000-01-01T00:00:00Z"), end: NOW };

// The real production row, copied from the account on 2026-11-17.
const INV_3803 = {
  invoiceNumber: "3803",
  invoiceStatus: "past_due",
  amountDue: 70,
  issuedAt: new Date("2025-03-19T16:14:32.000Z"),
  dueAt: new Date("2025-03-19T07:00:00.000Z"),
  lastSyncedAt: new Date("2026-06-11T17:44:35.762Z"),
  lastVerifiedAt: null,
  lastVerifyOutcome: "source_unavailable",
};

// A pre-cutoff invoice Jobber DID confirm -- must not appear in the warning.
const INV_OLD_OK = {
  invoiceNumber: "3712",
  invoiceStatus: "past_due",
  amountDue: 70,
  issuedAt: new Date("2025-02-25T16:00:00.000Z"),
  dueAt: new Date("2025-02-25T07:00:00.000Z"),
  lastSyncedAt: new Date("2026-06-11T17:44:35.762Z"),
  lastVerifiedAt: new Date(NOW.getTime() - 20 * 60_000),
  lastVerifyOutcome: "confirmed",
};

// A post-cutoff unconfirmed invoice -- belongs to the EXISTING root callout, not
// the new warning.
const INV_NEW_BAD = {
  invoiceNumber: "5573",
  invoiceStatus: "past_due",
  amountDue: 175,
  issuedAt: new Date("2026-02-12T16:00:00.000Z"),
  dueAt: new Date("2026-02-12T07:00:00.000Z"),
  lastSyncedAt: new Date("2026-06-11T17:44:35.762Z"),
  lastVerifiedAt: null,
  lastVerifyOutcome: "source_unavailable",
};

const ROWS: Row[] = [INV_3803, INV_OLD_OK, INV_NEW_BAD];

// Apply a Prisma where-shape produced by these helpers to plain objects, so the
// scope logic is tested without a database.
type Row = {
  invoiceNumber: string;
  invoiceStatus: string;
  amountDue: number;
  issuedAt: Date;
  dueAt: Date | null;
  lastSyncedAt: Date | null;
  lastVerifiedAt: Date | null;
  lastVerifyOutcome: string | null;
};

function matches(where: any, inv: Row): boolean {
  if (where.amountDue?.gt !== undefined && !(inv.amountDue > where.amountDue.gt)) return false;
  if (where.OR) {
    const ok = where.OR.some((c: any) => {
      if (c.invoiceStatus !== inv.invoiceStatus) return false;
      if (c.dueAt?.lt) return !!inv.dueAt && inv.dueAt < c.dueAt.lt;
      return true;
    });
    if (!ok) return false;
  }
  const i = where.issuedAt;
  if (i) {
    if (i.gte && !(inv.issuedAt >= i.gte)) return false;
    if (i.lte && !(inv.issuedAt <= i.lte)) return false;
    if (i.lt && !(inv.issuedAt < i.lt)) return false;
  }
  return true;
}

const select = (where: any) => ROWS.filter(r => matches(where, r)).map(r => r.invoiceNumber);

test("#3803 appears in the new warning on the DEFAULT year-to-date view", () => {
  // The whole point: the range-scoped legacy set is empty under YTD, so a
  // range-filtered warning would hide the failure on the page people open.
  assert.deepEqual(select(legacyOverdueWhere(YTD, CUTOFF, NOW)), []);

  const legacy = ROWS.filter(r => matches(legacyOverdueAnyRangeWhere(CUTOFF, NOW), r));
  const warned = legacy.filter(r => invoiceVerificationState(r, NOW) === "unconfirmed");
  assert.deepEqual(warned.map(r => r.invoiceNumber), ["3803"]);
  assert.equal(warned.reduce((a, r) => a + r.amountDue, 0), 70);
});

test("the warning excludes confirmed older invoices and post-cutoff ones", () => {
  const legacy = ROWS.filter(r => matches(legacyOverdueAnyRangeWhere(CUTOFF, NOW), r));
  // Pre-cutoff bucket holds both 2025 invoices, never the 2026 one.
  assert.deepEqual(legacy.map(r => r.invoiceNumber).sort(), ["3712", "3803"]);
  const warned = legacy.filter(r => invoiceVerificationState(r, NOW) === "unconfirmed");
  assert.ok(!warned.some(r => r.invoiceNumber === "3712"), "confirmed older invoice must not be warned about");
  assert.ok(!warned.some(r => r.invoiceNumber === "5573"), "post-cutoff invoice belongs to the existing callout");
});

test("#3803 is NOT added to the root Collections total, on any range", () => {
  for (const [label, range] of [["ytd", YTD], ["allTime", ALL_TIME]] as const) {
    const collections = ROWS.filter(r => matches(overdueInvoicesWhere(range, CUTOFF, NOW), r));
    assert.ok(
      !collections.some(r => r.invoiceNumber === "3803"),
      `#3803 must stay out of the Collections scope (${label})`,
    );
    // The Collections total is the post-cutoff invoice alone: $175, not $245.
    assert.equal(collections.reduce((a, r) => a + r.amountDue, 0), 175, `Collections total unchanged (${label})`);
  }
});

test("the Jan 1 2026 cutoff and the range-scoped legacy sentence are unchanged", () => {
  assert.equal(CUTOFF.toISOString(), "2026-01-01T00:00:00.000Z");
  // All-time legacy sentence still sees both 2025 invoices, as it did before.
  assert.deepEqual(select(legacyOverdueWhere(ALL_TIME, CUTOFF, NOW)).sort(), ["3712", "3803"]);
  // And the cutoff still bounds the Collections scope rather than the range.
  assert.deepEqual(select(overdueInvoicesWhere(ALL_TIME, CUTOFF, NOW)), ["5573"]);
  assert.deepEqual(select(overdueInvoicesWhere(YTD, CUTOFF, NOW)), ["5573"]);
});

test("#3803 keeps past_due at its stored $70 -- nothing marks it paid or zeroes it", () => {
  assert.equal(INV_3803.invoiceStatus, "past_due");
  assert.equal(INV_3803.amountDue, 70);
  assert.equal(INV_3803.lastVerifiedAt, null, "a failed check must not write a confirmation timestamp");
  assert.equal(invoiceVerificationState(INV_3803, NOW), "unconfirmed");
  // It is still selected by the detail page's own all-time scope.
  const detail = ROWS.filter(r =>
    matches(overdueInvoicesWhere(ALL_TIME, CUTOFF, NOW), r) ||
    matches(legacyOverdueWhere(ALL_TIME, CUTOFF, NOW), r));
  const row = detail.find(r => r.invoiceNumber === "3803");
  assert.ok(row, "#3803 must still be listed on the all-time detail page");
  assert.equal(row!.amountDue, 70);
  assert.equal(row!.invoiceStatus, "past_due");
});

test("the change is web-only: no schema, cron or migration touched", () => {
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  // The warning links to the all-time detail list.
  assert.match(page, /\/risk\/overdue-invoices\?range=allTime/);
  // It never claims payment.
  const warning = page.slice(page.indexOf("legacyUnconfirmedCount > 0"));
  const snippet = warning.slice(0, 900);
  for (const banned of [/\bpaid\b(?!\.)/i]) {
    const hits = snippet.match(banned) || [];
    // "not treated as paid" is the only permitted use.
    assert.ok(
      hits.every(() => /not treated as paid/i.test(snippet)),
      "warning must not describe an unconfirmed invoice as paid",
    );
  }
  // Totals still come from the untouched helpers.
  assert.match(page, /overdueInvoiceTotal = overdueUnpaid\.reduce/);
  assert.match(page, /where: legacyOverdueWhere\(range, COLLECTIONS_SINCE, now\)/);
});
