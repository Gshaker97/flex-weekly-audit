// Tests for the 2026-11-23 decision: chase every invoice that is owed and past
// due, let Jobber alone name the service type, stop holding an owner who has
// several unpaid invoices, and keep the one-text-one-email-per-customer-per-day
// cap as the only thing that limits delivery.
//
// All identities, amounts and labels below are synthetic.
import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateReminders, PAST_DUE_CATCH_UP_DAY,
  type ReminderCandidate, type ReminderEvaluationReaders, type SourceInvoice, type PriorSend,
  type SendChannel,
} from "../lib/reminder-evaluation";
import { resolveServiceType, serviceTypeIsConfirmed } from "../lib/reminder-service-type";
import { planDailyReminders } from "../lib/reminder-daily-plan";

const IN_WINDOW = new Date("2026-11-13T16:05:00Z"); // 09:05 Phoenix
const TWO_EXCLUSIONS = ["synthetic-client-excluded-a", "synthetic-client-excluded-b"];

function candidate(patch: Partial<ReminderCandidate> = {}): ReminderCandidate {
  return {
    jobberInvoiceId: "synthetic-invoice", invoiceNumber: "9001", clientName: "Synthetic Client",
    jobberClientId: "synthetic-client", email: "synthetic@example.test", phone: "4805550100", ...patch,
  };
}
/**
 * Maintenance, and ONLY Jobber says so — the case that used to be held forever,
 * since a GoHighLevel tag can never assert maintenance.
 *
 * Due 2026-11-10, so on 2026-11-13 this invoice is 3 days past due: owed, late,
 * and on no ladder milestone at all. Deliberately not day 10, which belongs to
 * the hourly sender and is always held by this runner.
 */
function sourceInvoice(patch: Partial<SourceInvoice> = {}): SourceInvoice {
  return {
    invoiceStatus: "past_due", totalCents: 13700, balanceCents: 13700,
    issuedDate: "2026-11-03T16:00:00Z", dueDate: "2026-11-10T07:00:00Z",
    clientId: "synthetic-client",
    clientTags: ["Maintenance Plan"], lineItemNames: ["Monthly Maintenance"], ...patch,
  };
}
function readers(patch: Partial<ReminderEvaluationReaders> = {}): ReminderEvaluationReaders {
  return {
    readInvoice: async () => sourceInvoice(),
    matchContacts: async () => [{ id: "synthetic-contact", tags: [], dnd: false,
      phone: "+14805550100", email: "synthetic@example.test" }],
    cardsForContact: async () => [{ id: "synthetic-card", stage: "invoice overdue", status: "open" }],
    sendHistory: async () => ({ complete: true, sends: [] }),
    ...patch,
  };
}
/** Both channels on a catch-up, matching the live runner's policy. */
const CHANNELS = (step: { dayPastDue: number; audience: string }): readonly SendChannel[] =>
  step.dayPastDue === PAST_DUE_CATCH_UP_DAY || step.dayPastDue === 21 ? ["email", "sms"] : ["sms"];

const run = (opts: Partial<Parameters<typeof evaluateReminders>[0]> = {}) => evaluateReminders({
  candidates: [candidate()], readers: readers(), now: IN_WINDOW,
  verifiedExclusions: TWO_EXCLUSIONS, milestoneChannels: CHANNELS, ...opts,
});
/** The same run with the past-due chase on, which is how the live runner calls it. */
const chase = (opts: Partial<Parameters<typeof evaluateReminders>[0]> = {}) =>
  run({ pastDueCatchUp: true, ...opts });
const holdsOf = (row: { holds: string[] }) => row.holds.join(" | ");

// --- 1. Jobber alone names the service type -------------------------------

test("Jobber alone confirms the service type, for maintenance as well as irrigation", () => {
  for (const [tag, line, expected] of [
    ["Maintenance Plan", "Monthly Maintenance", "maintenance"],
    ["Irrigation Promotion", "Irrigation Diagnostic Promotion", "irrigation"],
  ] as const) {
    const resolution = resolveServiceType({ jobberClientTags: [tag], jobberLineItemNames: [line], ghlContactTags: [] });
    assert.equal(resolution.source, "jobber_only");
    assert.equal(resolution.category, expected);
    assert.equal(serviceTypeIsConfirmed(resolution), true, `${expected} must now be confirmed by Jobber alone`);
  }
});

test("agreement still confirms, and conflict and unknown still do not", () => {
  const agreed = resolveServiceType({ jobberClientTags: ["Irrigation Promotion"],
    jobberLineItemNames: [], ghlContactTags: ["irrigation"] });
  assert.equal(agreed.source, "agreed");
  assert.equal(serviceTypeIsConfirmed(agreed), true);

  // Jobber contradicts itself.
  const conflict = resolveServiceType({ jobberClientTags: ["Maintenance Plan"],
    jobberLineItemNames: ["Irrigation Diagnostic"], ghlContactTags: [] });
  assert.equal(conflict.source, "conflict");
  assert.equal(conflict.category, null);
  assert.equal(serviceTypeIsConfirmed(conflict), false);

  // Jobber says nothing; a GoHighLevel tag alone cannot decide it.
  const unknown = resolveServiceType({ jobberClientTags: [], jobberLineItemNames: [], ghlContactTags: ["irrigation"] });
  assert.equal(unknown.source, "unknown");
  assert.equal(serviceTypeIsConfirmed(unknown), false);
});

test("a maintenance invoice Jobber alone names is no longer held on service type", async () => {
  const plan = await chase();
  const row = plan.rows[0];
  assert.equal(row.categorySource, "jobber_only");
  assert.ok(!row.holds.some(hold => hold.startsWith("service_type_")),
    `expected no service_type hold, got: ${holdsOf(row)}`);
  assert.equal(row.decision, "eligible", holdsOf(row));
});

// --- 2. An owner with several unpaid invoices is not held ------------------

test("several unpaid invoices for one owner no longer hold the row", async () => {
  const plan = await chase({
    candidates: [
      candidate({ jobberInvoiceId: "synthetic-invoice-a", invoiceNumber: "9001" }),
      candidate({ jobberInvoiceId: "synthetic-invoice-b", invoiceNumber: "9002" }),
      candidate({ jobberInvoiceId: "synthetic-invoice-c", invoiceNumber: "9003" }),
    ],
  });
  assert.equal(plan.rows.length, 3);
  for (const row of plan.rows) {
    assert.ok(!row.holds.some(hold => hold.startsWith("owner_has_multiple_unpaid_invoices")),
      `expected no owner-multiple hold, got: ${holdsOf(row)}`);
    assert.equal(row.unpaidInvoicesForOwner, 3, "the count is still reported for review");
    assert.equal(row.decision, "eligible", holdsOf(row));
  }
});

test("three eligible invoices for one owner still deliver one text and one email", async () => {
  const candidates = ["a", "b", "c"].map(suffix =>
    candidate({ jobberInvoiceId: `synthetic-invoice-${suffix}`, invoiceNumber: `900${suffix}` }));
  const plan = await chase({ candidates });
  const daily = planDailyReminders({ rows: plan.rows, candidates, phoenixDate: plan.phoenixDate! });
  assert.equal(daily.customersWithASend, 1);
  assert.equal(daily.smsPicked, 1, "one text, not three");
  assert.equal(daily.emailPicked, 1, "one email, not three");
  assert.ok(daily.droppedToCap > 0, "the extras are dropped by the cap, not by a hold");
});

// --- 3. Past-due catch-up --------------------------------------------------
test("an invoice past due with no milestone today is NOT chased unless asked", async () => {
  const plan = await run();
  const row = plan.rows[0];
  assert.equal(row.decision, "not_due");
  assert.equal(row.pastDueCatchUp, false);
  assert.ok(row.holds.some(hold => hold.startsWith("not_due_today")), holdsOf(row));
});

test("with the catch-up on, the same invoice is chased on both channels", async () => {
  const plan = await chase();
  const row = plan.rows[0];
  assert.equal(row.decision, "eligible", holdsOf(row));
  assert.equal(row.pastDueCatchUp, true);
  assert.equal(row.daysPastDue, 3);
  assert.equal(row.milestoneDay, PAST_DUE_CATCH_UP_DAY, "stamped as a catch-up, never as day 10/15/21");
  assert.equal(row.audience, "homeowner", "a chase goes to the customer, never to an internal step");
  assert.deepEqual([...row.channels].map(c => c.channel).sort(), ["email", "sms"]);
  for (const channel of row.channels) assert.equal(channel.decision, "eligible", holdsOf(row));
});

test("the catch-up never fires for an invoice that is not yet past due", async () => {
  // Due 2026-11-20: a week in the future on 2026-11-13.
  const plan = await run({
    readers: readers({ readInvoice: async () => sourceInvoice({
      issuedDate: "2026-11-13T16:00:00Z", dueDate: "2026-11-20T07:00:00Z" }) }),
    pastDueCatchUp: true,
  });
  const row = plan.rows[0];
  assert.equal(row.pastDueCatchUp, false, "nothing is owed late yet");
  assert.notEqual(row.decision, "eligible");
});

test("a long-overdue invoice past its last milestone is chased, not abandoned", async () => {
  // Due 2026-02-12: 274 days past due, well beyond the end of either ladder.
  const plan = await run({
    readers: readers({ readInvoice: async () => sourceInvoice({
      issuedDate: "2026-02-05T16:00:00Z", dueDate: "2026-02-12T07:00:00Z" }) }),
    pastDueCatchUp: true,
  });
  const row = plan.rows[0];
  assert.equal(row.decision, "eligible", holdsOf(row));
  assert.equal(row.pastDueCatchUp, true);
  assert.equal(row.audience, "homeowner",
    "the furthest milestone passed is an internal one; the catch-up must not inherit it");
});

test("a confirmed catch-up send suppresses that channel, so it does not repeat daily", async () => {
  const sent: PriorSend = { messageId: "synthetic-message", channel: "sms",
    milestoneDay: PAST_DUE_CATCH_UP_DAY, attribution: "exact", confirmed: true };
  const plan = await chase({
    readers: readers({ sendHistory: async () => ({ complete: true, sends: [sent] }) }),
  });
  const row = plan.rows[0];
  const sms = row.channels.find(c => c.channel === "sms");
  const email = row.channels.find(c => c.channel === "email");
  assert.equal(sms?.decision, "suppressed", "the text already went out");
  assert.equal(email?.decision, "eligible", "the email is a separate channel and has not");
});

test("a reviewed exclusion is enforced, not merely counted", async () => {
  for (const excludedId of TWO_EXCLUSIONS) {
    const plan = await chase({
      candidates: [candidate({ jobberClientId: excludedId })],
      readers: readers({ readInvoice: async () => sourceInvoice({ clientId: excludedId }) }),
    });
    const row = plan.rows[0];
    assert.equal(row.decision, "held", holdsOf(row));
    assert.ok(row.holds.includes("client_excluded_by_review"), holdsOf(row));
    // Held before anything was read, so no source, no contact, no card.
    assert.equal(row.balanceCents, null, "an excluded client is never even read");
  }
});

test("a client who is NOT excluded is still chased", async () => {
  const plan = await chase();
  assert.ok(!plan.rows[0].holds.includes("client_excluded_by_review"));
  assert.equal(plan.rows[0].decision, "eligible", holdsOf(plan.rows[0]));
});

test("the catch-up never overrides an opt-out", async () => {
  const plan = await chase({
    readers: readers({
      matchContacts: async () => [{ id: "synthetic-contact", tags: [], dnd: true,
        phone: "+14805550100", email: "synthetic@example.test" }],
    }),
  });
  assert.notEqual(plan.rows[0].decision, "eligible", holdsOf(plan.rows[0]));
});

test("the 09:00 window still governs a catch-up", async () => {
  // 09:30 Phoenix, evaluated anyway as a manual review would. The window having
  // closed must skip the send outright, never queue it for later in the day.
  const plan = await chase({ now: new Date("2026-11-13T16:30:00Z"), ignoreWindow: true });
  assert.equal(plan.rows[0].decision, "window_passed", holdsOf(plan.rows[0]));
});
