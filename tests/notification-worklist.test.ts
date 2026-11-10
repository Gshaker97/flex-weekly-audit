import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { planNotificationWorklist, NOTIFICATION_WORKLIST_LIMIT, type NotificationWorklistInvoice } from "../lib/notification-worklist";
import { eventKey } from "../lib/notification-gate";

const NOW = new Date("2026-11-10T16:05:00.000Z");
function invoice(id = "synthetic-invoice", tags: readonly string[] | null = []): NotificationWorklistInvoice {
  return { accountId: "synthetic-account", locationId: "synthetic-location", invoiceId: id, ownerId: "synthetic-owner",
    homeownerContactId: `synthetic-contact-${id}`, issuedDate: "2026-10-20", dueDate: "2026-10-31", status: "open", balanceMinor: 13700,
    contactTags: tags === null ? null : { kind: "complete-ghl-contact-tags", accountId: "synthetic-account", locationId: "synthetic-location",
      contactId: `synthetic-contact-${id}`, tags, observedAt: "2026-11-10T16:04:59.000Z", expiresAt: "2026-11-10T16:05:59.000Z",
      sourceRef: "synthetic-contact-get" } };
}
const plan = (row = invoice(), at = NOW) => planNotificationWorklist([row], at);

test("verified absence of the existing irrigation tag plans the maintenance branch and all six milestones", () => {
  const result = plan();
  assert.deepEqual(result.homeowner.map(x => x.dayPastDue), [10, 15, 20, 25, 30]);
  assert.deepEqual(result.internalDigests.flatMap(d => d.members.map(x => x.dayPastDue)), [21]);
  assert.equal(result.homeowner[0].scheduledOn, "2026-11-10"); assert.equal(result.homeowner[0].timing, "current_window");
  assert.ok(result.homeowner.every(x => x.category === "maintenance" && !x.dispatchEligible));
  assert.equal(result.coverage, "supplied-invoices-only"); assert.equal(result.sourceCoverageVerified, false);
});
test("exact irrigation tag retains only common homeowner Day10/15 and internal Day21", () => {
  const result = plan(invoice("irrigation", ["irrigation"]));
  assert.deepEqual(result.homeowner.map(x => x.dayPastDue), [10, 15]);
  assert.equal(result.internalDigests.length, 1); assert.equal(result.internalDigests[0].members[0].dayPastDue, 21);
  assert.ok(result.homeowner.every(x => x.category === "irrigation"));
});
test("unknown tag availability never blocks common Day10/15/21 or silently invents maintenance", () => {
  const result = plan(invoice("unknown", null));
  for (const day of [10, 15]) {
    const item = result.homeowner.find(x => x.dayPastDue === day)!;
    assert.equal(item.category, null); assert.deepEqual(item.planningHolds, []);
  }
  assert.deepEqual(result.internalDigests[0].members[0].planningHolds, []);
  for (const day of [20, 25, 30]) assert.ok(result.homeowner.find(x => x.dayPastDue === day)!.planningHolds.includes("maintenance_contact_tag_branch_unresolved"));
  assert.deepEqual(result.homeowner[0].requiredFacts, []);
});
for (const kind of ["stale", "future", "wrong account", "wrong location", "wrong contact", "missing provenance", "noncanonical timestamp", "case", "bad tags"])
  test(`${kind} tag evidence cannot assert the other/maintenance branch`, () => {
    const row = structuredClone(invoice()) as any;
    if (kind === "stale") row.contactTags.observedAt = "2026-11-10T16:04:00.000Z";
    if (kind === "future") row.contactTags.observedAt = "2026-11-10T16:05:01.000Z";
    if (kind === "wrong account") row.contactTags.accountId = "other";
    if (kind === "wrong location") row.contactTags.locationId = "other";
    if (kind === "wrong contact") row.contactTags.contactId = "other";
    if (kind === "missing provenance") row.contactTags.sourceRef = "";
    if (kind === "noncanonical timestamp") row.contactTags.observedAt = "2026-11-10 16:04:59";
    if (kind === "case") row.contactTags.tags = ["Irrigation"];
    if (kind === "bad tags") row.contactTags.tags = [null];
    const result = plan(row); assert.equal(result.homeowner[0].category, null); assert.deepEqual(result.homeowner[0].planningHolds, []);
    assert.ok(result.homeowner.find(x => x.dayPastDue === 20)!.planningHolds.includes("maintenance_contact_tag_branch_unresolved"));
  });
test("mixed labels are surfaced while the inspected exact irrigation-tag rule still wins", () => {
  const result = plan(invoice("mixed", ["maintenance", "irrigation"]));
  assert.deepEqual(result.homeowner.map(x => x.dayPastDue), [10, 15]);
  assert.ok(result.homeowner[0].categoryNotes.includes("mixed_labels_exact_irrigation_rule_retained"));
});
test("all conditional copy remains unapproved and required effects are never asserted", () => {
  const result = plan();
  assert.deepEqual(result.homeowner.find(x => x.dayPastDue === 15)!.requiredFacts, ["three_percent_fee_applied"]);
  for (const day of [20, 25]) assert.deepEqual(result.homeowner.find(x => x.dayPastDue === day)!.requiredFacts, ["recurring_late_fee_policy"]);
  assert.deepEqual(result.homeowner.find(x => x.dayPastDue === 30)!.requiredFacts, ["service_suspended", "collections_after_day_35_policy"]);
  assert.ok(result.homeowner.filter(x => x.dayPastDue !== 10).every(x => x.copyStatus === "conditional_copy_unapproved"));
  assert.equal(result.homeowner[0].copyStatus, "bind_existing_day10_authorization");
  assert.doesNotMatch(JSON.stringify(result), /"approved":true|"value":true|currency|destination|bodyDigest/);
});
test("multiple invoices share one future Angie digest without losing any per-invoice key", () => {
  const rows = [invoice("one", []), invoice("two", ["irrigation"]), invoice("three", null)];
  const result = planNotificationWorklist(rows, NOW), digest = result.internalDigests[0];
  assert.equal(result.internalDigests.length, 1); assert.equal(digest.members.length, 3);
  assert.equal(digest.recipientRole, "angie"); assert.equal(digest.templateApproval, "unresolved"); assert.equal(digest.dispatchEligible, false);
  assert.deepEqual(digest.members.map(x => x.eventKey).sort(), rows.map(row => eventKey({ ...row, dayPastDue: 21, audience: "internal" })).sort());
  assert.ok(digest.runtimeChecks.includes("durably_claim_digest_and_every_member_without_partial_replay"));
});
test("separate dates, accounts and locations never merge into one internal digest", () => {
  const a = invoice("a"), b = { ...invoice("b"), dueDate: "2026-11-01" }, c = { ...invoice("c"), accountId: "other-account" },
    d = { ...invoice("d"), locationId: "other-location" };
  assert.equal(planNotificationWorklist([a, b, c, d], NOW).internalDigests.length, 4);
});
test("same-contact customer conflicts preserve all invoice events and never choose a winner", () => {
  const a = invoice("a"), b = { ...invoice("b"), homeownerContactId: a.homeownerContactId };
  const result = planNotificationWorklist([a, b], NOW);
  assert.equal(result.homeowner.length, 10); assert.equal(result.contactDayConflicts.length, 5);
  assert.ok(result.homeowner.every(x => x.planningHolds.includes("homeowner_contact_day_conflict")));
  assert.equal(result.internalDigests[0].members.length, 2);
});
test("duplicate/conflicting source invoice rows hold both rather than choosing newer or last", () => {
  const a = invoice(), result = planNotificationWorklist([a, { ...a, dueDate: "2026-11-01" }], NOW);
  assert.equal(result.homeowner.length, 0); assert.equal(result.internalDigests.length, 0);
  assert.equal(result.invoiceHolds.length, 2); assert.ok(result.invoiceHolds.every(x => x.reason === "duplicate_or_conflicting_source_invoice"));
});
for (const [time, expected] of [["2026-11-10T15:59:59.999Z", "waiting_for_09"], ["2026-11-10T16:00:00.000Z", "current_window"],
  ["2026-11-10T16:14:59.999Z", "current_window"], ["2026-11-10T16:15:00.000Z", "missed_no_catch_up"],
  ["2026-11-11T16:00:00.000Z", "past_reconcile"], ["2026-11-09T16:00:00.000Z", "future"]] as const)
  test(`Arizona timing ${time} is ${expected}, with no catch-up`, () => {
    const result = plan(invoice(), new Date(time)); assert.equal(result.homeowner.find(x => x.dayPastDue === 10)!.timing, expected);
  });
test("issuedDate is send date and actual due date controls terms, including month/year and leap boundaries", () => {
  const row = { ...invoice(), issuedDate: "2026-12-20", dueDate: "2026-12-31" };
  const result = plan(row, new Date("2027-01-10T16:00:00.000Z")); assert.equal(result.homeowner[0].scheduledOn, "2027-01-10");
  const leap = { ...row, issuedDate: "2028-02-01", dueDate: "2028-02-20" };
  assert.equal(plan(leap, new Date("2028-03-01T16:00:00.000Z")).homeowner[0].scheduledOn, "2028-03-01");
});
for (const kind of ["paid", "paid positive", "void", "unknown", "open zero", "negative", "fractional", "missing issued", "missing due", "invalid due", "future issued", "wrong date order"])
  test(`${kind} invoice is held without manufacturing missing dates or payment`, () => {
    const row = structuredClone(invoice()) as any;
    if (kind === "paid") { row.status = "paid"; row.balanceMinor = 0; }
    if (kind === "paid positive") row.status = "paid";
    if (kind === "void") row.status = "void";
    if (kind === "unknown") row.status = "unknown";
    if (kind === "open zero") row.balanceMinor = 0;
    if (kind === "negative") row.balanceMinor = -1;
    if (kind === "fractional") row.balanceMinor = 1.1;
    if (kind === "missing issued") row.issuedDate = null;
    if (kind === "missing due") row.dueDate = null;
    if (kind === "invalid due") row.dueDate = "2026-02-30";
    if (kind === "future issued") row.issuedDate = "2027-01-01";
    if (kind === "wrong date order") row.issuedDate = "2026-11-01";
    row.createdAt = "2026-10-01";
    const result = plan(row); assert.equal(result.homeowner.length, 0); assert.equal(result.internalDigests.length, 0); assert.equal(result.invoiceHolds.length, 1);
  });
test("bounded input overflow holds the whole batch rather than silently truncating", () => {
  const rows = Array.from({ length: NOTIFICATION_WORKLIST_LIMIT + 1 }, (_, i) => invoice(`synthetic-${i}`));
  const result = planNotificationWorklist(rows, NOW); assert.deepEqual(result.batchHolds, ["invoice_input_limit_or_shape"]); assert.equal(result.homeowner.length, 0);
  assert.equal(planNotificationWorklist([], NOW).invoiceCount, 0);
  assert.deepEqual(planNotificationWorklist([invoice()], new Date(NaN)).batchHolds, ["invalid_now"]);
});
test("plan is immutable and does not mutate caller rows or depend on input order", () => {
  const rows = [invoice("b"), invoice("a")], before = structuredClone(rows);
  const a = planNotificationWorklist(rows, NOW), b = planNotificationWorklist([...rows].reverse(), NOW);
  assert.deepEqual(rows, before); assert.deepEqual(a.homeowner, b.homeowner); assert.deepEqual(a.internalDigests, b.internalDigests);
  assert.ok(Object.isFrozen(a)); assert.ok(Object.isFrozen(a.internalDigests[0].members)); assert.ok(Object.isFrozen(a.homeowner[0].requiredFacts));
});
test("planner import and use cannot initialize a database or make an ambient network request", () => {
  const script = `
    Object.defineProperty(globalThis, "prisma", { get() { throw new Error("ambient database touched"); } });
    globalThis.fetch = () => { throw new Error("ambient network touched"); };
    import("./lib/notification-worklist.ts").then(m => {
      const x = m.planNotificationWorklist ? m : m.default;
      console.log(JSON.stringify(x.planNotificationWorklist([], new Date("2026-11-10T16:00:00Z"))));
    });
  `;
  const child = spawnSync(process.execPath, ["--import", "tsx", "-e", script], { cwd: process.cwd(), encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 0, child.stderr); assert.equal(JSON.parse(child.stdout).mode, "disabled-planning-only");
});
