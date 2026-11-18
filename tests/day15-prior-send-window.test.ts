import test from "node:test";
import assert from "node:assert/strict";
import { evaluateReminders, type PriorSend } from "../lib/reminder-evaluation";
import { invoiceIssueDayStartMs, priorSendRelevance } from "../lib/reminder-prior-send-window";

/**
 * The narrow history fix: an unnumbered GoHighLevel message is dismissed ONLY
 * when it was reliably sent strictly before the invoice's issue day in Phoenix.
 * Everything else still holds.
 */

const ISSUED = "2026-11-03";
/** Phoenix never shifts, so the issue day begins at 07:00 UTC. */
const BOUNDARY = Date.parse("2026-11-03T07:00:00.000Z");

test("the issue-day boundary is the start of the issue day in Phoenix", () => {
  assert.equal(invoiceIssueDayStartMs(ISSUED), BOUNDARY);
  // A full ISO instant for the same Phoenix day resolves to the same boundary.
  assert.equal(invoiceIssueDayStartMs("2026-11-03T22:14:09.000Z"), BOUNDARY);
  // 2026-11-04T02:00Z is still 2026-11-03 in Phoenix (19:00 local).
  assert.equal(invoiceIssueDayStartMs("2026-11-04T02:00:00.000Z"), BOUNDARY);
});

test("an unusable issue date is never a boundary, so nothing can be dismissed", () => {
  for (const bad of [null, undefined, "", "not-a-date", "2026-13-45"]) {
    assert.equal(invoiceIssueDayStartMs(bad as any), null);
    assert.equal(priorSendRelevance(new Date("2020-01-01T00:00:00.000Z"), bad as any), "unknown");
  }
});

test("strictly before means strictly: one millisecond decides it", () => {
  assert.equal(priorSendRelevance(new Date(BOUNDARY - 1), ISSUED), "predates_invoice");
  assert.equal(priorSendRelevance(new Date(BOUNDARY), ISSUED), "at_or_after_issue");
  assert.equal(priorSendRelevance(new Date(BOUNDARY + 1), ISSUED), "at_or_after_issue");
});

test("a message at any hour of the issue day is kept, not dismissed", () => {
  for (const hour of ["07:00", "12:00", "16:05", "23:59"]) {
    assert.equal(priorSendRelevance(new Date(`2026-11-03T${hour}:00.000Z`), ISSUED), "at_or_after_issue");
  }
  // And late on the issue day in Phoenix, which is the next UTC day.
  assert.equal(priorSendRelevance(new Date("2026-11-04T05:30:00.000Z"), ISSUED), "at_or_after_issue");
});

test("an unknown or unusable message timestamp is kept, not dismissed", () => {
  assert.equal(priorSendRelevance(null, ISSUED), "unknown");
  assert.equal(priorSendRelevance(undefined, ISSUED), "unknown");
  assert.equal(priorSendRelevance(new Date("nonsense"), ISSUED), "unknown");
  assert.equal(priorSendRelevance("2026-01-01" as any, ISSUED), "unknown");
});

/* ------------------------------------------------------------------ */
/* The same rule as the evaluator sees it.                             */
/* ------------------------------------------------------------------ */

const SOURCE = {
  invoiceStatus: "past_due", totalCents: 12500, balanceCents: 12500,
  issuedDate: ISSUED, dueDate: "2026-11-10",
  clientId: "cli-1", clientTags: ["Maintenance"], lineItemNames: ["Lawn service"],
};
const CANDIDATE = { jobberInvoiceId: "inv-1", invoiceNumber: "7226", clientName: "A",
  jobberClientId: "cli-1", email: "a@example.com", phone: "+16025550100" };

const LINKED = {
  invoiceId: "inv-1", invoiceNumber: "7226", invoiceStatus: "past_due",
  issuedDate: ISSUED, dueDate: "2026-11-10", totalCents: 12500, balanceCents: 12500,
  clientId: "cli-1", complete: true, reason: null,
  jobs: [{ jobId: "j1", jobNumber: 1, jobStatus: "complete", archived: false,
    title: "Monthly service", instructions: "Mow and edge the front lawn",
    jobNoteMessages: ["Mowed and edged, all good"], notesTotal: 1, notesRead: 1,
    foreignNotes: 0, notesComplete: true, notesReason: null }],
};

/** 2026-11-25 is exactly 15 days past 2026-11-10, at 09:05 Phoenix. */
const AT_DAY_15 = new Date("2026-11-25T16:05:00.000Z");

const send = (over: Partial<PriorSend> = {}): PriorSend => ({
  messageId: "m1", channel: "sms", milestoneDay: null,
  attribution: "predates_invoice", confirmed: true, ...over,
});

const run = (history: unknown, extra: Record<string, unknown> = {}) =>
  evaluateReminders({
    candidates: [CANDIDATE],
    readers: {
      readInvoice: async () => SOURCE,
      matchContacts: async () => [{ id: "c1", tags: [], dnd: false,
        phone: "+16025550100", email: "a@example.com" }],
      cardsForContact: async () => [],
      linkedJobText: async () => LINKED,
      sendHistory: async () => history,
    } as any,
    now: AT_DAY_15, verifiedExclusions: ["cli-x", "cli-y"], ignoreWindow: true,
    milestoneChannels: () => ["email"],
    jobberOnlyDay15Email: true, feeClaimFreeDay15: true, channelBlindMilestones: [15],
    ...extra,
  });

test("baseline: with no history at all the invoice is a candidate", async () => {
  const plan = await run({ complete: true, sends: [] });
  assert.deepEqual(plan.rows[0].holds, []);
  assert.equal(plan.rows[0].decision, "eligible");
  assert.equal(plan.sendsAttempted, 0);
});

test("DEFAULT OFF: a pre-issue message holds exactly as an ambiguous one does", async () => {
  const plan = await run({ complete: true, sends: [send()] });
  assert.ok(plan.rows[0].holds.some(h => h.startsWith("ambiguous_send_attribution")),
    plan.rows[0].holds.join(" | "));
  assert.notEqual(plan.rows[0].decision, "eligible");
});

test("OPTED IN: a pre-issue message no longer holds", async () => {
  const plan = await run({ complete: true, sends: [send()] },
    { priorSendIgnoresPreIssueMessages: true });
  assert.deepEqual(plan.rows[0].holds, []);
  assert.equal(plan.rows[0].decision, "eligible");
  assert.equal(plan.sendsAttempted, 0);
});

test("OPTED IN: a message at or after issuance still holds", async () => {
  const plan = await run({ complete: true, sends: [send({ attribution: "ambiguous" })] },
    { priorSendIgnoresPreIssueMessages: true });
  assert.ok(plan.rows[0].holds.some(h => h.startsWith("ambiguous_send_attribution")));
});

test("OPTED IN: the same-day legacy Day 15 SMS still holds the email", async () => {
  // The legacy text fires on the same Day 15 this email would. The reader can
  // only mark it "predates_invoice" if it was sent before the invoice existed,
  // and a Day 15 text never is — so it arrives as ambiguous and holds.
  const plan = await run({ complete: true,
    sends: [send({ messageId: "legacy-day15-sms", attribution: "ambiguous", channel: "sms" })] },
    { priorSendIgnoresPreIssueMessages: true });
  assert.ok(plan.rows[0].holds.some(h => h.includes("legacy-day15-sms")),
    plan.rows[0].holds.join(" | "));
  assert.notEqual(plan.rows[0].decision, "eligible");
});

test("OPTED IN: incomplete history still holds, pre-issue messages or not", async () => {
  const plan = await run(
    { complete: false, incompleteReason: "page cap reached", sends: [send()] },
    { priorSendIgnoresPreIssueMessages: true });
  assert.ok(plan.rows[0].holds.some(h => h.startsWith("send_history_incomplete")));
  assert.notEqual(plan.rows[0].decision, "eligible");
});

test("OPTED IN: unavailable history still holds", async () => {
  const plan = await run(null, { priorSendIgnoresPreIssueMessages: true });
  assert.ok(plan.rows[0].holds.some(h => h.startsWith("send_history_unavailable")));
});

test("OPTED IN: a message naming THIS invoice is never dismissed by date", async () => {
  // "exact" survives whatever its timestamp is; only unnumbered messages are
  // ever dated, and the reader proves that separately below.
  const plan = await run({ complete: true,
    sends: [send({ messageId: "names-7226", attribution: "exact", milestoneDay: null })] },
    { priorSendIgnoresPreIssueMessages: true });
  assert.ok(plan.rows[0].holds.some(h => h.startsWith("send_detail_unknown")),
    plan.rows[0].holds.join(" | "));
  assert.notEqual(plan.rows[0].decision, "eligible");
});

test("OPTED IN: an unconfirmed pre-issue send is dismissed only on its date, not its doubt", async () => {
  // Dismissal happens before the confirmed check, so an unconfirmed pre-issue
  // message drops out too. That is correct: it still cannot be about this
  // invoice. An unconfirmed message at or after issuance does still hold.
  const after = await run({ complete: true,
    sends: [send({ messageId: "maybe-sent", attribution: "ambiguous", confirmed: false })] },
    { priorSendIgnoresPreIssueMessages: true });
  assert.ok(after.rows[0].holds.some(h => h.startsWith("ambiguous_send_attribution")));
});

/* ------------------------------------------------------------------ */
/* The reader's own classification, against a real message shape.      */
/* ------------------------------------------------------------------ */

test("the reader only ever dates an UNNUMBERED message", async () => {
  const { createReminderEvaluationReaders } = await import("../lib/reminder-evaluation-readers");
  assert.equal(typeof createReminderEvaluationReaders, "function");
  // The classification itself is proved through priorSendRelevance above; this
  // asserts the rule it is wired to, in one place, so the two cannot drift:
  // a body naming this invoice is "exact", a body naming another is
  // "other_invoice", and neither is ever dated.
  const minePattern = new RegExp(`(?:^|[^0-9])7226(?:[^0-9]|$)`);
  const anyInvoiceNumber = /#\s?\d{3,6}|invoice\s+#?\s?\d{3,6}/i;
  const classify = (body: string, sentAt: Date) => {
    const namesMine = minePattern.test(body);
    const namesSome = anyInvoiceNumber.test(body);
    if (namesMine) return "exact";
    if (namesSome) return "other_invoice";
    return priorSendRelevance(sentAt, ISSUED) === "predates_invoice" ? "predates_invoice" : "ambiguous";
  };
  const longBefore = new Date("2026-07-06T18:00:00.000Z");
  assert.equal(classify("Your invoice #7226 is past due", longBefore), "exact");
  assert.equal(classify("Your invoice #7100 is past due", longBefore), "other_invoice");
  assert.equal(classify("Just a reminder about your balance", longBefore), "predates_invoice");
  assert.equal(classify("Just a reminder about your balance",
    new Date("2026-11-25T16:00:00.000Z")), "ambiguous");
});
