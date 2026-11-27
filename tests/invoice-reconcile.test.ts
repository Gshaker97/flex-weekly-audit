import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_RECENTLY_PAID_DAYS, RECONCILE_INTERVAL_HOURS, RECONCILE_PANEL_LOOKBACK_RUNS,
  groupReasons, latestReconcileRun, plainReconcileHold, reconcileDue, reconcileScopeWhere,
  recentlyPaidDays,
} from "../lib/invoice-reconcile";
import {
  publicSyncErrorMessage, syncRunDiagnostics, RECONCILE_LIST_LIMIT, type SyncRunReconcile,
} from "../lib/sync-writer-control";
import { planOpenInvoiceStatusRefresh, type OpenInvoiceSnapshot } from "../lib/open-invoice-status-refresh";

const PREFIX = "FLEX_GHL_WRITE_JOURNAL_V1:";
const envelope = (runId: string, extra: Record<string, unknown>) =>
  PREFIX + JSON.stringify({ version: 1, runId, warnings: null, writes: [], ...extra });

const env = (over: Record<string, string> = {}) => ({ ...over } as unknown as NodeJS.ProcessEnv);

const stamp = (over: Partial<SyncRunReconcile> = {}): SyncRunReconcile => ({
  at: "2026-11-27T22:00:00.000Z", checkedInvoices: 350, checkedCards: 700,
  corrected: 12, corrections: [], held: 3, holds: [], holdReasons: [], cardReasons: [],
  scope: "Checked 350 invoices.", ...over,
} as SyncRunReconcile);

// ---------------------------------------------------------------------------
// SCOPE. The whole point of the reconcile is that it chooses what to read by
// risk, not by what Jobber reported as changed.
// ---------------------------------------------------------------------------

test("the scope covers all four risk buckets", () => {
  const now = new Date("2026-11-27T12:00:00Z");
  const where = reconcileScopeWhere(now, 45, ["6830", "780"]) as any;
  assert.equal(where.OR.length, 5);
  assert.deepEqual(where.OR[0], { invoiceStatus: { in: ["awaiting_payment", "past_due"] } });
  // The bucket that fixes the measured bug: paid, with money still on it.
  assert.deepEqual(where.OR[1], { invoiceStatus: "paid", amountDue: { gt: 0 } });
  // Recently paid, dated off the ISSUE date because `paidAt` is a copy of it on
  // every row in this database and is not a payment date.
  assert.deepEqual(where.OR[2], { invoiceStatus: "paid", issuedAt: { gte: new Date("2026-10-13T12:00:00Z") } });
  assert.deepEqual(where.OR[3],
    { invoiceStatus: "paid", issuedAt: null, createdAtJobber: { gte: new Date("2026-10-13T12:00:00Z") } });
  assert.deepEqual(where.OR[4], { invoiceNumber: { in: ["6830", "780"] } });
});

test("NO CARD CLAUSE AT ALL when no card names an invoice", () => {
  // An empty `in: []` would be a clause that matches nothing, which is harmless
  // but reads as though cards were considered and excluded. Leaving it out says
  // what actually happened.
  const where = reconcileScopeWhere(new Date(), 45, []) as any;
  assert.equal(where.OR.length, 4);
  assert.ok(!JSON.stringify(where).includes("invoiceNumber"));
});

test("duplicate and unusable card invoice numbers are collapsed", () => {
  const where = reconcileScopeWhere(new Date(), 45,
    ["6830", "6830", "", "780", null as any, undefined as any, "780"]) as any;
  assert.deepEqual(where.OR[4], { invoiceNumber: { in: ["6830", "780"] } });
});

test("the day window moves the cutoff and nothing else", () => {
  const now = new Date("2026-11-27T00:00:00Z");
  const narrow = reconcileScopeWhere(now, 1, []) as any;
  const wide = reconcileScopeWhere(now, 180, []) as any;
  assert.deepEqual(narrow.OR[2].issuedAt, { gte: new Date("2026-11-26T00:00:00Z") });
  assert.deepEqual(wide.OR[2].issuedAt, { gte: new Date("2026-05-31T00:00:00Z") });
  assert.deepEqual(narrow.OR[0], wide.OR[0]);
  assert.deepEqual(narrow.OR[1], wide.OR[1]);
});

test("the day window never widens to everything on a bad setting", () => {
  assert.equal(recentlyPaidDays(env()), DEFAULT_RECENTLY_PAID_DAYS);
  assert.equal(recentlyPaidDays(env({ RECONCILE_RECENTLY_PAID_DAYS: "90" })), 90);
  assert.equal(recentlyPaidDays(env({ RECONCILE_RECENTLY_PAID_DAYS: "1" })), 1);
  for (const bad of ["", "nope", "0", "-5", "99999", "1e9", "NaN", "45.9.1"]) {
    const got = recentlyPaidDays(env({ RECONCILE_RECENTLY_PAID_DAYS: bad }));
    assert.ok(got >= 1 && got <= 400, `${bad} -> ${got}`);
  }
  // A fractional value is floored, never rounded up past the cap.
  assert.equal(recentlyPaidDays(env({ RECONCILE_RECENTLY_PAID_DAYS: "45.9" })), 45);
  assert.equal(recentlyPaidDays(env({ RECONCILE_RECENTLY_PAID_DAYS: "400" })), 400);
  assert.equal(recentlyPaidDays(env({ RECONCILE_RECENTLY_PAID_DAYS: "401" })), DEFAULT_RECENTLY_PAID_DAYS);
});

// ---------------------------------------------------------------------------
// WHEN IT RUNS. "At least once a day" has to survive a late, slow or skipped
// run, so it is an interval since the last reconcile, not a time of day.
// ---------------------------------------------------------------------------

test("a reconcile is due when none has ever run", () => {
  assert.equal(reconcileDue(null, new Date(), env()), true);
});

test("one a day: due after the interval, not before", () => {
  const now = new Date("2026-11-27T22:00:00Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000);
  assert.equal(reconcileDue(hoursAgo(1), now, env()), false);
  assert.equal(reconcileDue(hoursAgo(RECONCILE_INTERVAL_HOURS - 1), now, env()), false);
  assert.equal(reconcileDue(hoursAgo(RECONCILE_INTERVAL_HOURS), now, env()), true);
  assert.equal(reconcileDue(hoursAgo(72), now, env()), true);
  // Under 24 hours, so a skipped or slow run still gets a reconcile that day.
  assert.ok(RECONCILE_INTERVAL_HOURS < 24);
});

test("a stamp from the future is a clock problem, not a reconcile", () => {
  const now = new Date("2026-11-27T22:00:00Z");
  assert.equal(reconcileDue(new Date("2026-12-01T00:00:00Z"), now, env()), true);
  assert.equal(reconcileDue(new Date(NaN), now, env()), true);
});

test("one switch forces a reconcile, one switch turns it off", () => {
  const now = new Date("2026-11-27T22:00:00Z");
  const minutesAgo = new Date(now.getTime() - 60_000);
  assert.equal(reconcileDue(minutesAgo, now, env({ RECONCILE_FORCE: "true" })), true);
  assert.equal(reconcileDue(null, now, env({ RECONCILE_ENABLED: "false" })), false);
  // Forcing wins over disabling: an operator asking for one now has said so
  // more recently than whoever set the other value.
  assert.equal(reconcileDue(null, now, env({ RECONCILE_ENABLED: "false", RECONCILE_FORCE: "true" })), true);
  // Anything other than the exact strings leaves the interval in charge.
  for (const v of ["", "1", "yes", "TRUE", "false"]) {
    assert.equal(reconcileDue(minutesAgo, now, env({ RECONCILE_FORCE: v })), false, `force=${v}`);
  }
  for (const v of ["", "0", "no", "FALSE", "true"]) {
    assert.equal(reconcileDue(null, now, env({ RECONCILE_ENABLED: v })), true, `enabled=${v}`);
  }
});

// ---------------------------------------------------------------------------
// THE RECORD. It lives in the run's journal envelope, so there is no schema
// change and the record cannot drift from the run that produced it.
// ---------------------------------------------------------------------------

test("a reconcile stamp round-trips off the run row", () => {
  const full = stamp({
    corrections: [{ invoiceNumber: "6830", customer: "Telford Delmoe", from: "paid", to: "past_due" }],
    holds: [{ invoiceNumber: "7171", customer: "Paula", reason: "Jobber did not return this invoice." }],
    holdReasons: [{ reason: "Jobber did not return this invoice.", count: 1 }],
    cardReasons: [{ reason: "Special stage protected", count: 4 }],
  });
  const out = syncRunDiagnostics(envelope("r", { reconcile: full }), "r").reconcile;
  assert.ok(out);
  assert.equal(out.checkedInvoices, 350);
  assert.equal(out.checkedCards, 700);
  assert.equal(out.corrected, 12);
  assert.deepEqual(out.corrections[0], { invoiceNumber: "6830", customer: "Telford Delmoe", from: "paid", to: "past_due" });
  assert.deepEqual(out.holds[0], { invoiceNumber: "7171", customer: "Paula", reason: "Jobber did not return this invoice." });
  assert.deepEqual(out.cardReasons[0], { reason: "Special stage protected", count: 4 });
});

test("A MALFORMED STAMP IS DROPPED, NEVER THROWN ON", () => {
  // Same one-directional leniency as the rest of the envelope: the journal is
  // the write evidence, and losing it over a bad sentence would be far worse.
  for (const reconcile of [null, 42, "nope", [], {}, { at: "" }, { at: "   " }]) {
    assert.equal(syncRunDiagnostics(envelope("r", { reconcile }), "r").reconcile, null, JSON.stringify(reconcile));
  }
  // Unreadable counts read as zero rather than making the stamp unreadable.
  const odd = syncRunDiagnostics(envelope("r", { reconcile: {
    at: "2026-11-27T22:00:00.000Z", checkedInvoices: "lots", checkedCards: -3, corrected: 1.5,
    held: null, corrections: "nope", holds: 7, holdReasons: [{ count: 2 }], cardReasons: null, scope: 42,
  } }), "r").reconcile;
  assert.ok(odd);
  assert.equal(odd.checkedInvoices, 0);
  assert.equal(odd.checkedCards, 0);
  assert.equal(odd.corrected, 0);
  assert.equal(odd.held, 0);
  assert.deepEqual(odd.corrections, []);
  assert.deepEqual(odd.holds, []);
  assert.deepEqual(odd.holdReasons, []);
  assert.deepEqual(odd.cardReasons, []);
  assert.equal(odd.scope, "");
});

test("a correction with no new label is not a correction", () => {
  const out = syncRunDiagnostics(envelope("r", { reconcile: stamp({
    corrections: [{ invoiceNumber: "1", customer: "x", from: "paid" } as any,
      { invoiceNumber: "2", customer: "y", from: null, to: "paid" }],
  }) }), "r").reconcile;
  assert.equal(out?.corrections.length, 1);
  assert.equal(out?.corrections[0].invoiceNumber, "2");
  assert.equal(out?.corrections[0].from, null);
});

test("the lists are bounded, so one bad day cannot bloat a run row", () => {
  const many = Array.from({ length: RECONCILE_LIST_LIMIT + 50 }, (_, i) =>
    ({ invoiceNumber: String(i), customer: "x", from: "paid", to: "past_due" }));
  const out = syncRunDiagnostics(envelope("r", { reconcile: stamp({ corrections: many }) }), "r").reconcile;
  assert.equal(out?.corrections.length, RECONCILE_LIST_LIMIT);
});

test("a stamp for a DIFFERENT run tells us nothing", () => {
  assert.equal(syncRunDiagnostics(envelope("run1", { reconcile: stamp() }), "run2").reconcile, null);
});

test("a reconcile stamp never disturbs the write evidence", () => {
  // The stamp is a reading of Jobber, not a write. Its presence must leave the
  // journal's own fields exactly as they were.
  const msg = PREFIX + JSON.stringify({ version: 1, runId: "r", warnings: "a note", writes: [], reconcile: stamp() });
  const parsed = JSON.parse(msg.slice(PREFIX.length));
  assert.deepEqual(parsed.writes, []);
  assert.equal(parsed.warnings, "a note");
  assert.ok(syncRunDiagnostics(msg, "r").reconcile);
});

// ---------------------------------------------------------------------------
// WHAT THE PUBLIC ENDPOINT MAY SAY. It is unauthenticated, so counts only.
// ---------------------------------------------------------------------------

test("THE PUBLIC STATUS NAMES NO CUSTOMER AND NO INVOICE", () => {
  const msg = envelope("r", { reconcile: stamp({
    corrections: [{ invoiceNumber: "6830", customer: "Telford Delmoe", from: "paid", to: "past_due" }],
    holds: [{ invoiceNumber: "7171", customer: "Paula Day", reason: "held." }],
  }) });
  const out = publicSyncErrorMessage(msg)!;
  assert.ok(!out.includes("6830"));
  assert.ok(!out.includes("Telford"));
  assert.ok(!out.includes("7171"));
  assert.ok(!out.includes("Paula"));
  assert.match(out, /350 invoices and 700 cards/);
  assert.match(out, /12 labels corrected, 3 held/);
  assert.match(out, /See the dashboard/);
});

test("a block and held cards still outrank the reconcile sentence", () => {
  const blocked = publicSyncErrorMessage(envelope("r", {
    reconcile: stamp(),
    block: { step: "writing this customer's invoice card", reason: "x.", pendingWrite: true, at: "2026-11-27T22:00:00.000Z" },
  }))!;
  assert.match(blocked, /^Sync blocked while writing/);
  const skipped = publicSyncErrorMessage(envelope("r", {
    reconcile: stamp(), skips: [{ invoiceNumber: "1", customer: "x", reason: "y." }],
  }))!;
  assert.match(skipped, /^1 invoice card held this run/);
});

test("a pending write keeps the conservative sentence, reconcile or not", () => {
  const msg = PREFIX + JSON.stringify({ version: 1, runId: "r", warnings: null, reconcile: stamp(),
    writes: [{ id: "a", state: "pending" }] });
  assert.match(publicSyncErrorMessage(msg)!, /requires operator review/);
});

test("singulars read as English", () => {
  const one = publicSyncErrorMessage(envelope("r", { reconcile: stamp({
    checkedInvoices: 1, checkedCards: 1, corrected: 1, held: 1 }) }))!;
  assert.match(one, /1 invoice and 1 card/);
  assert.match(one, /1 label corrected, 1 held/);
});

// ---------------------------------------------------------------------------
// REPORTING. Hundreds of holds have to read as a few lines.
// ---------------------------------------------------------------------------

test("reasons group by count, largest first", () => {
  const grouped = groupReasons(["b", "a", "a", "c", "a", "b"]);
  assert.deepEqual(grouped, [{ reason: "a", count: 3 }, { reason: "b", count: 2 }, { reason: "c", count: 1 }]);
});

test("blank reasons are dropped and ties are stable", () => {
  assert.deepEqual(groupReasons(["", "   ", null as any, undefined as any, 7 as any]), []);
  assert.deepEqual(groupReasons(["b", "a"]), [{ reason: "a", count: 1 }, { reason: "b", count: 1 }]);
  assert.deepEqual(groupReasons([" a ", "a"]), [{ reason: "a", count: 2 }]);
});

test("grouping is bounded", () => {
  const grouped = groupReasons(Array.from({ length: 500 }, (_, i) => `reason ${i}`), 10);
  assert.equal(grouped.length, 10);
});

test("every hold reason the re-check can raise has a plain sentence", () => {
  // The exact strings `planOpenInvoiceStatusRefresh` raises. If one of them
  // changes, this test is where that shows up rather than on the dashboard.
  const source = readFileSync("lib/open-invoice-status-refresh.ts", "utf8");
  const raised = [...source.matchAll(/hold\("([^"]+)"/g)].map(m => m[1]);
  assert.ok(raised.length >= 10, `expected the hold reasons, found ${raised.length}`);
  for (const reason of raised) {
    const plain = plainReconcileHold(reason);
    assert.notEqual(plain, reason, `no plain sentence for: ${reason}`);
    assert.match(plain, /\.$/, `not a sentence: ${plain}`);
  }
});

test("an unrecognised reason is passed through, never swallowed", () => {
  assert.equal(plainReconcileHold("something new nobody translated"), "something new nobody translated");
  assert.equal(plainReconcileHold(""), "");
});

test("the panel finds the newest run that actually reconciled", () => {
  const runs = [
    { id: "c", errorMessage: null },
    { id: "b", errorMessage: envelope("b", { skips: [{ invoiceNumber: "1", customer: "x", reason: "y." }] }) },
    { id: "a", errorMessage: envelope("a", { reconcile: stamp() }) },
    { id: "z", errorMessage: envelope("z", { reconcile: stamp({ at: "2026-11-01T00:00:00.000Z" }) }) },
  ];
  assert.equal(latestReconcileRun(runs)?.id, "a");
  assert.equal(latestReconcileRun([runs[0], runs[1]]), null);
  assert.equal(latestReconcileRun([]), null);
  // Enough runs to cover a day of hourly syncs, or the daily record disappears.
  assert.ok(RECONCILE_PANEL_LOOKBACK_RUNS >= 24);
});

// ---------------------------------------------------------------------------
// THE CORRECTION ITSELF. The behaviour the 12 invoices were waiting on.
// ---------------------------------------------------------------------------

const snapshot = (over: Partial<OpenInvoiceSnapshot> = {}): OpenInvoiceSnapshot => ({
  id: "local-1", jobberInvoiceId: "jobber-1", invoiceStatus: "paid",
  total: 60, amountPaid: 0, amountDue: 60, customerId: "cust-1",
  customer: { jobberClientId: "client-1" }, dueAt: new Date("2026-09-10T00:00:00Z"),
  lastSyncedAt: new Date("2026-11-25T16:09:14Z"), ...over,
});
const live = (over: Record<string, unknown> = {}) => ({
  id: "jobber-1", invoiceStatus: "paid", amounts: { total: 60, invoiceBalance: 60 },
  client: { id: "client-1" }, ...over,
});
const read = (row: unknown) => async (_q: string, vars: Record<string, string>) =>
  Object.fromEntries(Object.entries(vars).map(([k]) => [k.replace("id", "i"), row]));

test("A ROW STORED AS PAID WITH A BALANCE IS NOW CORRECTED, not held", async () => {
  // Invoice #6830: Jobber says paid, $60 still owing, due 2026-09-10. Before
  // 2026-11-27 this was held as "no longer open" and sat wrong indefinitely.
  const plan = await planOpenInvoiceStatusRefresh([snapshot()], read(live()), { paidBalanceCorrection: true });
  assert.equal(plan.checked, 1);
  assert.deepEqual(plan.holds, []);
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].invoiceStatus, "past_due");
  // Status only. The balance already agreed, so nothing invents a new amount.
  assert.equal(plan.updates[0].amountDue, undefined);
  assert.equal(plan.updates[0].amountPaid, undefined);
});

test("not yet due reads awaiting_payment, not past_due", async () => {
  const plan = await planOpenInvoiceStatusRefresh(
    [snapshot({ dueAt: new Date(Date.now() + 10 * 86400_000) })], read(live()), { paidBalanceCorrection: true });
  assert.equal(plan.updates[0]?.invoiceStatus, "awaiting_payment");
});

test("WITH THE GATE OFF, nothing about this changes", async () => {
  const plan = await planOpenInvoiceStatusRefresh([snapshot()], read(live()), { paidBalanceCorrection: false });
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.holds.length, 1);
});

test("a genuinely settled paid row is still left alone", async () => {
  const plan = await planOpenInvoiceStatusRefresh(
    [snapshot({ amountPaid: 60, amountDue: 0 })],
    read(live({ amounts: { total: 60, invoiceBalance: 0 } })), { paidBalanceCorrection: true });
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.holds[0]?.reason, "Cached invoice is no longer open");
});

test("a void, draft or bad-debt invoice is never dragged into collections", async () => {
  for (const invoiceStatus of ["void", "draft", "bad_debt"]) {
    const plan = await planOpenInvoiceStatusRefresh(
      [snapshot()], read(live({ invoiceStatus })), { paidBalanceCorrection: true });
    assert.equal(plan.updates.length, 0, invoiceStatus);
    assert.equal(plan.holds.length, 1, invoiceStatus);
  }
});

test("a changed total is still a full sync's job, not a label fix", async () => {
  const plan = await planOpenInvoiceStatusRefresh([snapshot()],
    read(live({ amounts: { total: 120, invoiceBalance: 60 } })), { paidBalanceCorrection: true });
  assert.equal(plan.updates.length, 0);
  assert.match(plan.holds[0].reason, /total changed/);
});

test("a different owner in Jobber holds the row", async () => {
  const plan = await planOpenInvoiceStatusRefresh([snapshot()],
    read(live({ client: { id: "someone-else" } })), { paidBalanceCorrection: true });
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.holds[0].reason, "Unknown or changed invoice owner");
});

test("unreadable amounts hold rather than guess", async () => {
  for (const amounts of [{ total: 60, invoiceBalance: null }, { total: null, invoiceBalance: 60 },
    { total: -60, invoiceBalance: 60 }, { total: 60, invoiceBalance: 90 }]) {
    const plan = await planOpenInvoiceStatusRefresh([snapshot()],
      read(live({ amounts })), { paidBalanceCorrection: true });
    assert.equal(plan.updates.length, 0, JSON.stringify(amounts));
    assert.equal(plan.holds.length, 1, JSON.stringify(amounts));
  }
});

test("a missing invoice retains the last known state", async () => {
  const plan = await planOpenInvoiceStatusRefresh([snapshot()], read(null), { paidBalanceCorrection: true });
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.holds[0].reason, "Source object unavailable; retained last-known state");
  assert.equal(plan.verifications[0].outcome, "source_unavailable");
});

// ---------------------------------------------------------------------------
// WHAT THE RECONCILE MAY NOT DO. These are the guarantees, asserted against
// the source so a later edit cannot quietly add a send or a second card writer.
// ---------------------------------------------------------------------------

/** The module's CODE, with comments stripped: prose that says "sends no email"
 * must not trip a guard that is looking for a way to send an email. */
function codeOf(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("THE RECONCILE HAS NO WAY TO SEND ANYTHING", () => {
  const source = codeOf("lib/invoice-reconcile.ts");
  for (const forbidden of [/\bfetch\s*\(/, /sendMessage/i, /notification-dispatch/, /notification-sender/,
    /catchup-/, /\bsms\b/i, /\bemail\b/i, /twilio/i, /leadconnectorhq/]) {
    assert.doesNotMatch(source, forbidden, `the reconcile must not reference ${forbidden}`);
  }
  // The stripper has to actually strip, or this test proves nothing.
  assert.ok(!source.includes("it has no transport of any kind"));
  assert.ok(source.includes("runInvoiceStatusRecheck"));
});

test("THE RECONCILE WRITES NO CARD, so it cannot become a second writer", () => {
  const source = codeOf("lib/invoice-reconcile.ts");
  for (const forbidden of [/moveOpportunityToStage/, /createOpportunity/, /applyInvoiceCardPlan/,
    /\.prepare\(/, /\.confirm\(/, /ghl-invoice-card-writer/, /ghl-write-intent/]) {
    assert.doesNotMatch(source, forbidden, `the reconcile must not reference ${forbidden}`);
  }
  // The ONE journal function it may touch is the read used to date the last
  // reconcile, plus the stamp types. Nothing that prepares or confirms a write.
  assert.match(source, /syncRunDiagnostics/);
});

test("THE RECONCILE ONLY EVER WRITES A STATUS LABEL", () => {
  const source = codeOf("lib/invoice-reconcile.ts");
  // It owns no update of its own: every correction goes through the re-check's
  // single pre-image-guarded transaction.
  for (const forbidden of [/\.update\(/, /\.updateMany\(/, /\.upsert\(/, /\.create\(/, /\.delete/, /\$executeRaw/]) {
    assert.doesNotMatch(source, forbidden, `the reconcile must not call ${forbidden}`);
  }
  assert.match(source, /runInvoiceStatusRecheck/);
});

test("the card pass still owns card writes, and the reconcile runs before it", () => {
  const source = codeOf("lib/sync.ts");
  const reconcile = source.indexOf("reconcileInvoiceLabels({");
  const cardPass = source.indexOf("const reconcile = async (customer:");
  assert.ok(reconcile > 0, "the reconcile is wired in");
  assert.ok(cardPass > 0, "the card pass is still there");
  assert.ok(reconcile < cardPass, "stored labels are corrected before any card is judged");
  // The stamp is recorded through the writer, so it lands on the run row and
  // the dashboard, and is never written by a second path.
  assert.match(source, /noteReconcile\?\.\(/);
});

test("A RECONCILE FAILURE IS REPORTED, NEVER FATAL", () => {
  // A reconcile is a reading. Failing to take one must not stop this run, and
  // above all must not leave a row that blocks the next hour.
  const source = codeOf("lib/sync.ts");
  const start = source.indexOf("let reconcileStamp");
  const end = source.indexOf("const phoneCustomers");
  assert.ok(start > 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /catch \(err: any\) \{/);
  assert.match(block, /Full reconcile unavailable/);
  assert.doesNotMatch(block, /throw/);
  assert.doesNotMatch(block, /\.block\(/);
});
