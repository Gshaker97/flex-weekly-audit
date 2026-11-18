import test from "node:test";
import assert from "node:assert/strict";
import { eventKey } from "../lib/notification-gate";

/**
 * The overlap guarantees the Day 15 email relies on, asserted rather than
 * described. The ledger admits one reservation per event key, so two messages
 * that share a key cannot both go out, whichever one gets there first.
 */
const base = { accountId: "acct-1", invoiceId: "inv-1" } as const;
const day15Homeowner = { ...base, dayPastDue: 15, audience: "homeowner" as const };

test("Day 15 SMS and Day 15 email are ONE event, so only one can ever send", () => {
  // The key deliberately carries no channel. This is what makes the old GHL
  // Day 15 SMS and the new Day 15 email mutually exclusive in both directions.
  assert.equal(eventKey(day15Homeowner), eventKey({ ...day15Homeowner }));
  const key = eventKey(day15Homeowner);
  assert.ok(!key.includes("sms"));
  assert.ok(!key.includes("email"));
});

test("Day 21 keeps its own event and is untouched by anything at Day 15", () => {
  const day21Internal = { ...base, dayPastDue: 21, audience: "internal" as const };
  const day21Homeowner = { ...base, dayPastDue: 21, audience: "homeowner" as const };
  assert.notEqual(eventKey(day21Internal), eventKey(day15Homeowner));
  assert.notEqual(eventKey(day21Homeowner), eventKey(day15Homeowner));
  // And the two Day 21 audiences stay separate from each other.
  assert.notEqual(eventKey(day21Internal), eventKey(day21Homeowner));
});

test("another invoice's Day 15 never blocks this one", () => {
  assert.notEqual(eventKey({ ...day15Homeowner, invoiceId: "inv-2" }), eventKey(day15Homeowner));
});

test("Day 10 stays a separate event from Day 15", () => {
  assert.notEqual(eventKey({ ...day15Homeowner, dayPastDue: 10 }), eventKey(day15Homeowner));
});

/**
 * The fee-free waiver, and the two GoHighLevel dependencies that currently stop
 * every Day 15 email regardless of what Jobber says.
 */
import { evaluateReminders } from "../lib/reminder-evaluation";
import { invoiceReminderMilestones } from "../lib/invoice-reminder-clock";
import { resolveServiceType, serviceTypeIsConfirmed } from "../lib/reminder-service-type";

// Irrigation, tagged on BOTH sides, because that is the only combination the
// current service-type rule will confirm. See the maintenance test below.
const SOURCE = {
  invoiceStatus: "past_due", totalCents: 13700, balanceCents: 13700,
  issuedDate: "2026-10-20", dueDate: "2026-11-02",
  clientId: "cli-1", clientTags: ["Irrigation"], lineItemNames: ["Irrigation repair"],
};
const CANDIDATE = { jobberInvoiceId: "inv-1", invoiceNumber: "7207", clientName: "A",
  jobberClientId: "cli-1", email: "a@example.com", phone: "+16025550100" };
const readers = {
  readInvoice: async () => SOURCE,
  matchContacts: async () => [{ id: "c1", tags: ["Irrigation"], dnd: false,
    phone: "+16025550100", email: "a@example.com" }],
  cardsForContact: async () => [{ id: "o1", stage: "invoice overdue", status: "open" }],
  sendHistory: async () => ({ complete: true, sends: [] }),
};
/** 2026-11-17 is exactly 15 days past 2026-11-02, at 09:05 Phoenix. */
const AT_DAY_15 = new Date("2026-11-17T16:05:00.000Z");
const run = (extra: Record<string, unknown> = {}, over: Record<string, unknown> = {}) =>
  evaluateReminders({ candidates: [CANDIDATE], readers: { ...readers, ...over } as any, now: AT_DAY_15,
    verifiedExclusions: ["cli-x", "cli-y"], ignoreWindow: true,
    milestoneChannels: () => ["email"], ...extra });

test("without the waiver, day 15 holds on the unproven 3% fee fact", async () => {
  const plan = await run();
  assert.equal(plan.rows[0].milestoneDay, 15);
  assert.ok(plan.rows[0].holds.some(h => h.startsWith("milestone_requires_unverified_facts")));
});

test("with the fee-free waiver, the same invoice is eligible and still sends nothing", async () => {
  const plan = await run({ feeClaimFreeDay15: true });
  assert.deepEqual(plan.rows[0].holds, []);
  assert.equal(plan.rows[0].decision, "eligible");
  assert.equal(plan.sendsAttempted, 0);
});

test("the waiver reaches no other milestone", async () => {
  // Day 21 is internal; the waiver is homeowner-only, so it cannot touch it.
  const plan = await evaluateReminders({ candidates: [CANDIDATE], readers: readers as any,
    now: new Date("2026-11-23T16:05:00.000Z"), verifiedExclusions: ["cli-x", "cli-y"],
    ignoreWindow: true, milestoneChannels: () => ["email"], feeClaimFreeDay15: true });
  assert.equal(plan.rows[0].milestoneDay, 21);
  assert.equal(plan.rows[0].audience, "internal");
});

test("DEPENDENCY 1: a maintenance invoice can never clear the service-type rule", () => {
  // GoHighLevel is only permitted to positively assert irrigation, so "agreed"
  // is unreachable for maintenance no matter what either system says.
  for (const ghlContactTags of [[], ["Maintenance"], ["Monthly Maintenance"], null]) {
    const resolution = resolveServiceType({
      jobberClientTags: ["Maintenance"], jobberLineItemNames: ["Monthly maintenance"], ghlContactTags,
    });
    assert.equal(resolution.category, "maintenance");
    assert.equal(resolution.source, "jobber_only");
    assert.equal(serviceTypeIsConfirmed(resolution), false, JSON.stringify(ghlContactTags));
  }
  // Only irrigation, tagged on both sides, is ever confirmed.
  assert.equal(serviceTypeIsConfirmed(resolveServiceType({
    jobberClientTags: ["Irrigation"], jobberLineItemNames: ["Irrigation repair"],
    ghlContactTags: ["Irrigation"] })), true);
});

test("DEPENDENCY 1 does not matter for Day 15: the step is identical in both ladders", () => {
  const maintenance = invoiceReminderMilestones("maintenance", "2026-10-20", "2026-11-02", AT_DAY_15);
  const irrigation = invoiceReminderMilestones("irrigation", "2026-10-20", "2026-11-02", AT_DAY_15);
  const day15 = (list: any[]) => list.find(step => step.dayPastDue === 15);
  assert.deepEqual(day15(maintenance!), day15(irrigation!));
  // So a Day-15-only programme never needs the service type resolved at all.
  assert.equal(day15(maintenance!).audience, "homeowner");
  assert.deepEqual(day15(maintenance!).requiredFacts, ["three_percent_fee_applied"]);
});

test("DEPENDENCY 2: a stale GoHighLevel pipeline card blocks an invoice Jobber says is overdue", async () => {
  for (const card of [
    [],
    [{ id: "o1", stage: "new lead", status: "open" }],
    [{ id: "o1", stage: "invoice overdue", status: "won" }],
  ]) {
    const plan = await run({ feeClaimFreeDay15: true }, { cardsForContact: async () => card });
    assert.notEqual(plan.rows[0].decision, "eligible", JSON.stringify(card));
    assert.ok(plan.rows[0].holds.some(h => h.startsWith("no_invoice_pipeline_card") ||
      h.startsWith("card_not_in_overdue_stage") || h.startsWith("card_status_not_open")));
  }
});

test("the protections themselves still bite: opt-out, ambiguity and duplicates", async () => {
  const optedOut = await run({ feeClaimFreeDay15: true },
    { matchContacts: async () => [{ id: "c1", tags: ["Irrigation"], dnd: true, phone: "+16025550100", email: "a@example.com" }] });
  assert.ok(optedOut.rows[0].holds.includes("destination_contact_opted_out"));

  const twoContacts = await run({ feeClaimFreeDay15: true }, { matchContacts: async () => [
    { id: "c1", tags: ["Irrigation"], dnd: false, phone: "+16025550100", email: "a@example.com" },
    { id: "c2", tags: ["Irrigation"], dnd: false, phone: "+16025550100", email: "a@example.com" }] });
  assert.ok(twoContacts.rows[0].holds.some(h => h.startsWith("ambiguous_destination_contacts")));

  const noHistoryAtAll = await run({ feeClaimFreeDay15: true }, { sendHistory: async () => null });
  assert.ok(noHistoryAtAll.rows[0].holds.some(h => h.startsWith("send_history_unavailable")));

});

const SMS_ALREADY_SENT = { complete: true, sends: [
  { messageId: "m1", channel: "sms" as const, milestoneDay: 15,
    attribution: "exact" as const, confirmed: true }] };

test("DIVERGENCE: per-channel evaluation lets the email through after a day-15 SMS", async () => {
  // This is what the evaluation does on its own, and it disagrees with the
  // ledger. Pinned so the disagreement cannot be forgotten.
  const plan = await run({ feeClaimFreeDay15: true }, { sendHistory: async () => SMS_ALREADY_SENT });
  assert.equal(plan.rows[0].decision, "eligible");
  assert.deepEqual(plan.rows[0].channels, [{ channel: "email", decision: "eligible", reason: null }]);
});

test("channelBlindMilestones makes the evaluation agree with the ledger", async () => {
  const plan = await run({ feeClaimFreeDay15: true, channelBlindMilestones: [15] },
    { sendHistory: async () => SMS_ALREADY_SENT });
  assert.notEqual(plan.rows[0].decision, "eligible");
  assert.ok(plan.rows[0].holds.some(h => h.startsWith("milestone_already_sent_on_another_channel")));
  assert.deepEqual(plan.rows[0].channels, [{ channel: "email", decision: "suppressed",
    reason: "already_sent_by_ghl: day 15 email as m1" }]);
  assert.equal(plan.sendsAttempted, 0);
});

test("channel-blindness does not block a DIFFERENT milestone or a different invoice", async () => {
  const otherDay = await run({ feeClaimFreeDay15: true, channelBlindMilestones: [15] },
    { sendHistory: async () => ({ complete: true, sends: [
      { messageId: "m2", channel: "sms" as const, milestoneDay: 21,
        attribution: "exact" as const, confirmed: true }] }) });
  assert.equal(otherDay.rows[0].decision, "eligible");

  const otherInvoice = await run({ feeClaimFreeDay15: true, channelBlindMilestones: [15] },
    { sendHistory: async () => ({ complete: true, sends: [
      { messageId: "m3", channel: "sms" as const, milestoneDay: 15,
        attribution: "other_invoice" as const, confirmed: true }] }) });
  assert.equal(otherInvoice.rows[0].decision, "eligible");
});
