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
  clientBillingEmails: ["a@example.com"],
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
      matchContacts: async () => [{ id: "c1", tags: [], dnd: false, emailDndStatus: "inactive",
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
  const { createReminderEvaluationReaders, classifyPriorSend } =
    await import("../lib/reminder-evaluation-readers");
  assert.equal(typeof createReminderEvaluationReaders, "function");
  // The REAL classifier is called here, not a copy of it, so the rule and the
  // test cannot drift: a body naming this invoice is "exact", a body naming
  // another is "other_invoice", and neither is ever dated.
  const classify = (body: string, sentAt: Date) => classifyPriorSend({
    body, sentAt, invoiceNumber: "7226", issuedDate: ISSUED, dueDate: "2026-11-10",
  }).attribution;
  const longBefore = new Date("2026-07-06T18:00:00.000Z");
  assert.equal(classify("Your invoice #7226 is past due", longBefore), "exact");
  assert.equal(classify("Your invoice #7100 is past due", longBefore), "other_invoice");
  assert.equal(classify("Just a reminder about your balance", longBefore), "predates_invoice");
  assert.equal(classify("Just a reminder about your balance",
    new Date("2026-11-25T16:00:00.000Z")), "ambiguous");
});

/* ------------------------------------------------------------------ */
/* The day count in a legacy body, through the real classifier.        */
/* ------------------------------------------------------------------ */

test("a legacy reminder's own day count decides which invoice it was about", async () => {
  const { classifyPriorSend } = await import("../lib/reminder-evaluation-readers");
  // #7226 fell due 2026-11-10. Nothing below quotes an invoice number or an
  // amount, which is exactly why the number-only rule could not place them.
  const classify = (body: string, sentAt: Date, corroborating?: string[]) => classifyPriorSend({
    body, sentAt, invoiceNumber: "7226", issuedDate: ISSUED, dueDate: "2026-11-10",
    corroboratingDueDates: corroborating,
  });

  // Day 15 for THIS invoice: 2026-11-10 + 15 = 2026-11-25.
  const mine = classify("your invoice is 15 days past due", new Date("2026-11-25T16:05:00.000Z"));
  assert.equal(mine.attribution, "exact");
  assert.equal(mine.milestoneDay, 15, "the rung comes from the body, so day 15 is closed");

  // The real July text: "10 days past due" on 2026-07-06 means an invoice that
  // fell due 2026-06-26. It cannot hold #7226, and it no longer does.
  const older = classify("your invoice is 10 days past due", new Date("2026-07-06T22:00:00.000Z"));
  assert.equal(older.attribution, "other_invoice");
  assert.equal(older.milestoneDay, null);

  // The fee template states no day count, so on its own it is never released
  // as another invoice's. Here it also predates the invoice, which is a firmer
  // answer than "ambiguous" - and both of them still hold the row.
  const fee = classify("A late fee of 3% has been applied", new Date("2026-08-14T18:00:00.000Z"));
  assert.equal(fee.attribution, "predates_invoice", "an inference must not release a hold");

  // A fee text sent AFTER issuance has neither signal left, so it is ambiguous
  // and holds - the case the number-only rule produced for every legacy text.
  const after = classify("A late fee of 3% has been applied", new Date("2026-11-20T18:00:00.000Z"));
  assert.equal(after.attribution, "ambiguous");
  assert.equal(after.milestoneDay, null);

  // ...but the Aug 9 "10 days" text puts an invoice at due 2026-07-30, which is
  // just what the Aug 14 fee text implies. Corroborated, it is dismissed.
  const corroborated = classify("A late fee of 3% has been applied",
    new Date("2026-08-14T18:00:00.000Z"), ["2026-07-30"]);
  assert.equal(corroborated.attribution, "other_invoice");
});

test("a numbered body is never re-decided by its day count", async () => {
  const { classifyPriorSend } = await import("../lib/reminder-evaluation-readers");
  // Naming the invoice settles it. A day count that disagrees must not demote
  // an exact match to "other_invoice" and let a duplicate through.
  const result = classifyPriorSend({
    body: "Invoice #7226 is 10 days past due", sentAt: new Date("2026-07-06T22:00:00.000Z"),
    invoiceNumber: "7226", issuedDate: ISSUED, dueDate: "2026-11-10",
  });
  assert.equal(result.attribution, "exact");
});


/* ------------------------------------------------------------------ */
/* Email consent, read exactly as the send path reads it.              */
/* ------------------------------------------------------------------ */

const runWithContact = (contact: Record<string, unknown>) =>
  evaluateReminders({
    candidates: [CANDIDATE],
    readers: {
      readInvoice: async () => SOURCE,
      matchContacts: async () => [{ id: "c1", tags: [], dnd: false,
        phone: "+16025550100", email: "a@example.com", ...contact }],
      cardsForContact: async () => [],
      linkedJobText: async () => LINKED,
      sendHistory: async () => ({ complete: true, sends: [] }),
    } as any,
    now: AT_DAY_15, verifiedExclusions: ["cli-x", "cli-y"], ignoreWindow: true,
    milestoneChannels: () => ["email"],
    jobberOnlyDay15Email: true, feeClaimFreeDay15: true, channelBlindMilestones: [15],
    priorSendIgnoresPreIssueMessages: true,
  });

test("an explicit Email inactive is the only thing that counts as consent", async () => {
  const plan = await runWithContact({ emailDndStatus: "inactive" });
  assert.deepEqual(plan.rows[0].holds, []);
  assert.equal(plan.rows[0].decision, "eligible");
});

/**
 * Changed 2026-11-18 by the account owner's decision: a contact with NO Email
 * entry at all may be emailed. Every Flexx customer is in that state, so the
 * previous rule blocked the entire programme. An unreadable value is still not
 * a blank one, and still holds.
 */
test("a blank Email entry now sends: no entry is permission, by decision", async () => {
  for (const contact of [{}, { emailDndStatus: null }, { emailDndStatus: undefined }]) {
    const plan = await runWithContact(contact);
    assert.ok(!plan.rows[0].holds.some(h => h.startsWith("destination_contact_email_consent_unknown")),
      JSON.stringify(contact) + " -> " + plan.rows[0].holds.join(" | "));
  }
});

test("an Email entry we cannot read still holds: unreadable is not blank", async () => {
  // "Inactive" is deliberately absent: this evaluation lowercases the status,
  // so mixed casing reads as consent here. The sender is stricter and requires
  // exact lowercase, so such a contact is held there instead.
  for (const status of ["", "opted_in", "unsubscribed", "0", "yes"]) {
    const plan = await runWithContact({ emailDndStatus: status });
    assert.ok(plan.rows[0].holds.some(h => h.startsWith("destination_contact_email_consent_unknown")),
      status + " -> " + plan.rows[0].holds.join(" | "));
  }
});

test("an explicit Email opt-out holds and is named as an opt-out", async () => {
  for (const status of ["active", "permanent"]) {
    const plan = await runWithContact({ emailDndStatus: status });
    assert.ok(plan.rows[0].holds.includes("destination_contact_email_opted_out"),
      status + " -> " + plan.rows[0].holds.join(" | "));
  }
});

test("an unrecognised Email status holds rather than being read as consent", async () => {
  const plan = await runWithContact({ emailDndStatus: "paused" });
  assert.ok(plan.rows[0].holds.some(h => h.startsWith("destination_contact_email_consent_unknown")),
    plan.rows[0].holds.join(" | "));
});
