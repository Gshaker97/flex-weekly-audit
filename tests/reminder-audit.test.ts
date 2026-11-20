import test from "node:test";
import assert from "node:assert/strict";
import {
  auditChannel, auditInvoice, summariseAudit, calendarDaysBetween,
  verdictNeedsAttention, NEEDS_ATTENTION, VERDICT_ORDER,
  type AuditSubject, type AuditChannelSubject, type AuditVerdict,
} from "../lib/reminder-audit";

/**
 * The audit exists to tell two things apart that look identical from outside:
 *
 *   a hold  — we looked, and decided not to send. The system working.
 *   a gap   — we never looked. Nobody finds out. The crack.
 *
 * Every test below defends that boundary, or defends the rule that an input the
 * audit could not read becomes NEITHER of them. An audit that quietly reports
 * "all clear" because it could not see is worse than no audit, so the bias is
 * always towards `audit_inconclusive`.
 */

const AUDIT_ON = "2026-11-18";

const channel = (over: Partial<AuditChannelSubject> = {}): AuditChannelSubject => ({
  channel: "email", expectation: "eligible", suppressedReason: null,
  ledger: [], delivery: [], deliveryComplete: true, ...over,
});

const subject = (over: Partial<AuditSubject> = {}): AuditSubject => ({
  invoiceId: "inv-1", invoiceNumber: "7226", milestoneDay: 15,
  milestoneOn: "2026-11-10", openNow: true, balanceCents: 16_000, paidOn: null,
  invoiceHolds: [], holdsComplete: true, ledgerComplete: true,
  channels: [channel()], ...over,
});

const verdictOf = (s: AuditSubject, c?: AuditChannelSubject, on = AUDIT_ON) =>
  auditChannel(s, c ?? s.channels[0], on).verdict;

// ------------------------------------------------------------ the crack itself

test("unpaid, past its milestone, nothing sent and nothing explaining it is a MISS", () => {
  const finding = auditChannel(subject(), channel(), AUDIT_ON);
  assert.equal(finding.verdict, "missed_no_explanation");
  assert.equal(finding.needsAttention, true);
  assert.equal(finding.ageDays, 8);
  assert.match(finding.reason, /unpaid_8_days_past_its_milestone/);
});

test("the same invoice with a hold today is a DECISION, not a miss", () => {
  const finding = auditChannel(
    subject(), channel({ expectation: "suppressed", suppressedReason: "destination_contact_email_consent_unknown" }),
    AUDIT_ON);
  assert.equal(finding.verdict, "held_explained_by_todays_hold");
  assert.equal(finding.needsAttention, false);
  assert.equal(finding.reason, "destination_contact_email_consent_unknown");
});

test("an invoice-level hold also explains the silence", () => {
  assert.equal(
    verdictOf(subject({ invoiceHolds: ["ambiguous_destination_contacts: 3 exact matches, not merged"] })),
    "held_explained_by_todays_hold");
});

test("an invoice-level hold is reported by its machine prefix, never its detail", () => {
  const finding = auditChannel(
    subject({ invoiceHolds: ["ambiguous_destination_contacts: 3 exact matches, not merged"] }),
    channel(), AUDIT_ON);
  assert.equal(finding.reason, "ambiguous_destination_contacts");
});

test('"suppressed" with no reason given is NOT an explanation', () => {
  // A caller that forgets to pass the reason must not be able to turn a gap
  // into a hold just by asserting one.
  assert.equal(verdictOf(subject(), channel({ expectation: "suppressed", suppressedReason: null })),
    "audit_inconclusive");
  assert.equal(verdictOf(subject(), channel({ expectation: "suppressed", suppressedReason: "   " })),
    "audit_inconclusive");
});

// ------------------------------------------------- nothing unreadable passes

test("an unreadable milestone date is inconclusive, not a pass and not a miss", () => {
  assert.equal(verdictOf(subject({ milestoneOn: null })), "audit_inconclusive");
  assert.equal(verdictOf(subject({ milestoneOn: "10/11/2026" })), "audit_inconclusive");
});

test("an unreadable audit date is inconclusive", () => {
  assert.equal(verdictOf(subject(), channel(), "not-a-date"), "audit_inconclusive");
});

test("an incomplete ledger read is inconclusive even when everything else looks fine", () => {
  // This is the dangerous one: a half-read ledger looks exactly like an empty
  // ledger, and an empty ledger on an unpaid invoice reads as a MISS. A partial
  // read must never be able to manufacture a miss OR hide a real one.
  assert.equal(verdictOf(subject({ ledgerComplete: false })), "audit_inconclusive");
  assert.equal(
    verdictOf(subject({ ledgerComplete: false, channels: [channel({ ledger: [{ state: "accepted", providerMessageId: "m1" }] })] })),
    "audit_inconclusive");
});

test("an unreadable live invoice status is inconclusive", () => {
  assert.equal(verdictOf(subject({ openNow: null })), "audit_inconclusive");
});

test("a decision that could not be recomputed is inconclusive, never a miss", () => {
  assert.equal(verdictOf(subject({ holdsComplete: false })), "audit_inconclusive");
  assert.equal(verdictOf(subject(), channel({ expectation: "unknown" })), "audit_inconclusive");
});

test("settled with no payment date on record is inconclusive, not a pass", () => {
  // We cannot tell whether it was paid before its milestone (correct silence)
  // or after it (a miss that got lucky), so we claim neither.
  assert.equal(verdictOf(subject({ openNow: false, paidOn: null })), "audit_inconclusive");
});

test("an unparseable payment date is inconclusive", () => {
  assert.equal(verdictOf(subject({ openNow: false, paidOn: "last Tuesday" })), "audit_inconclusive");
});

test("an unrecognised ledger state is inconclusive rather than assumed sent", () => {
  assert.equal(
    verdictOf(subject(), channel({ ledger: [{ state: "somethingelse", providerMessageId: "m1" }] })),
    "audit_inconclusive");
  assert.equal(
    verdictOf(subject(), channel({ ledger: [{ state: "", providerMessageId: "m1" }] })),
    "audit_inconclusive");
});

test("an invoice with no channel to audit becomes a finding, not a silent drop", () => {
  // Returning nothing would take the invoice out of the reconciliation, which
  // is precisely how a gap hides.
  const findings = auditInvoice(subject({ channels: [] }), AUDIT_ON);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].verdict, "audit_inconclusive");
  assert.equal(findings[0].reason, "no_channel_was_audited");
  assert.equal(findings[0].needsAttention, true);
});

// -------------------------------------------------------- the future is not a miss

test("a milestone still in the future is not yet due, whatever else is true", () => {
  assert.equal(verdictOf(subject({ milestoneOn: "2026-11-25" })), "not_yet_due");
  assert.equal(verdictOf(subject({ milestoneOn: "2026-11-19", openNow: true, invoiceHolds: [] })), "not_yet_due");
});

test("the milestone day itself is in scope, not excused as future", () => {
  const finding = auditChannel(subject({ milestoneOn: AUDIT_ON }), channel(), AUDIT_ON);
  assert.equal(finding.ageDays, 0);
  assert.equal(finding.verdict, "missed_no_explanation");
});

// --------------------------------------------------------------- judging a send

test("accepted plus a provider delivery receipt is the only way to claim delivered", () => {
  assert.equal(
    verdictOf(subject(), channel({
      ledger: [{ state: "accepted", providerMessageId: "m1" }],
      delivery: [{ providerMessageId: "m1", status: "delivered" }],
    })),
    "sent_and_delivered");
});

test("accepted alone is NOT delivered: our own 201 proves nothing reached anyone", () => {
  assert.equal(
    verdictOf(subject(), channel({ ledger: [{ state: "accepted", providerMessageId: "m1" }], delivery: [] })),
    "sent_delivery_unconfirmed");
});

test("an unreadable provider outcome leaves delivery unconfirmed", () => {
  assert.equal(
    verdictOf(subject(), channel({
      ledger: [{ state: "accepted", providerMessageId: "m1" }],
      delivery: [{ providerMessageId: "m1", status: "delivered" }],
      deliveryComplete: false,
    })),
    "sent_delivery_unconfirmed");
});

test("a delivery receipt for a DIFFERENT message does not confirm this one", () => {
  assert.equal(
    verdictOf(subject(), channel({
      ledger: [{ state: "accepted", providerMessageId: "m1" }],
      delivery: [{ providerMessageId: "m2", status: "delivered" }],
    })),
    "sent_delivery_unconfirmed");
});

test("accepted without a provider message id cannot be confirmed", () => {
  assert.equal(
    verdictOf(subject(), channel({ ledger: [{ state: "accepted", providerMessageId: null }] })),
    "sent_delivery_unconfirmed");
});

test("a failed provider status means the customer was never reminded", () => {
  for (const status of ["failed", "undelivered", "bounced", "rejected", "error", "FAILED"]) {
    assert.equal(
      verdictOf(subject(), channel({
        ledger: [{ state: "accepted", providerMessageId: "m1" }],
        delivery: [{ providerMessageId: "m1", status }],
      })),
      "sent_but_delivery_failed", status);
    }
});

test("an unknown provider status is unconfirmed, not delivered and not failed", () => {
  for (const status of ["pending", "queued", "", null]) {
    assert.equal(
      verdictOf(subject(), channel({
        ledger: [{ state: "accepted", providerMessageId: "m1" }],
        delivery: [{ providerMessageId: "m1", status }],
      })),
      "sent_delivery_unconfirmed", String(status));
  }
});

test("a send left reserved or pending is a half-finished attempt, not a send", () => {
  for (const state of ["reserved", "pending"]) {
    const finding = auditChannel(subject(), channel({ ledger: [{ state, providerMessageId: null }] }), AUDIT_ON);
    assert.equal(finding.verdict, "send_attempt_left_incomplete", state);
    assert.equal(finding.needsAttention, true);
  }
});

test("a provider rejection is its own verdict", () => {
  assert.equal(verdictOf(subject(), channel({ ledger: [{ state: "rejected", providerMessageId: null }] })),
    "send_rejected_by_provider");
});

test('a ledger outcome of "unknown" leaves delivery unconfirmed', () => {
  assert.equal(verdictOf(subject(), channel({ ledger: [{ state: "unknown", providerMessageId: null }] })),
    "sent_delivery_unconfirmed");
});

test("two ledger rows for one invoice, milestone and channel is a double send", () => {
  const finding = auditChannel(subject(), channel({
    ledger: [{ state: "accepted", providerMessageId: "m1" }, { state: "accepted", providerMessageId: "m2" }],
    delivery: [{ providerMessageId: "m1", status: "delivered" }, { providerMessageId: "m2", status: "delivered" }],
  }), AUDIT_ON);
  // Both delivered, and it is still a problem: the customer was messaged twice.
  assert.equal(finding.verdict, "sent_more_than_once");
  assert.equal(finding.needsAttention, true);
});

test("a message the provider has but the ledger does not is a records failure", () => {
  const finding = auditChannel(subject(), channel({ ledger: [], providerShowsOurMessage: true }), AUDIT_ON);
  assert.equal(finding.verdict, "sent_without_a_ledger_row");
  assert.equal(finding.needsAttention, true);
});

test("the ledger outranks the provider: a recorded send is judged on the ledger", () => {
  // providerShowsOurMessage is consulted ONLY when the ledger is empty, so it
  // can never downgrade a properly recorded send.
  assert.equal(
    verdictOf(subject(), channel({
      ledger: [{ state: "accepted", providerMessageId: "m1" }],
      delivery: [{ providerMessageId: "m1", status: "delivered" }],
      providerShowsOurMessage: true,
    })),
    "sent_and_delivered");
});

// ------------------------------------------------------------- paid invoices

test("paid before its milestone means nothing was ever owed", () => {
  const finding = auditChannel(
    subject({ openNow: false, paidOn: "2026-11-05", milestoneOn: "2026-11-10" }), channel(), AUDIT_ON);
  assert.equal(finding.verdict, "paid_before_its_milestone");
  assert.equal(finding.needsAttention, false);
});

test("paid ON its milestone day still counts as paid before: nothing was owed that morning", () => {
  assert.equal(
    verdictOf(subject({ openNow: false, paidOn: "2026-11-10", milestoneOn: "2026-11-10" })),
    "paid_before_its_milestone");
});

test("paid AFTER its milestone with nothing sent earns no credit", () => {
  // Not a crack — the money arrived — but not evidence the reminder works
  // either, so it gets its own bucket rather than being counted as a success.
  const finding = auditChannel(
    subject({ openNow: false, paidOn: "2026-11-14", milestoneOn: "2026-11-10" }), channel(), AUDIT_ON);
  assert.equal(finding.verdict, "paid_after_its_milestone_never_sent");
  assert.equal(finding.needsAttention, false);
});

test("a paid invoice we DID send to is still judged on the send", () => {
  assert.equal(
    verdictOf(subject({ openNow: false, paidOn: "2026-11-14" }), channel({
      ledger: [{ state: "accepted", providerMessageId: "m1" }],
      delivery: [{ providerMessageId: "m1", status: "delivered" }],
    })),
    "sent_and_delivered");
});

// --------------------------------------------------------- per-channel verdicts

test("one invoice can be delivered on one channel and missed on the other", () => {
  const findings = auditInvoice(subject({
    channels: [
      channel({ channel: "sms", ledger: [{ state: "accepted", providerMessageId: "m1" }],
        delivery: [{ providerMessageId: "m1", status: "delivered" }] }),
      channel({ channel: "email" }),
    ],
  }), AUDIT_ON);
  assert.equal(findings.length, 2);
  assert.equal(findings.find(f => f.channel === "sms")!.verdict, "sent_and_delivered");
  assert.equal(findings.find(f => f.channel === "email")!.verdict, "missed_no_explanation");
});

test("a text that delivered does not cover an email that bounced", () => {
  const findings = auditInvoice(subject({
    channels: [
      channel({ channel: "sms", ledger: [{ state: "accepted", providerMessageId: "m1" }],
        delivery: [{ providerMessageId: "m1", status: "delivered" }] }),
      channel({ channel: "email", ledger: [{ state: "accepted", providerMessageId: "m2" }],
        delivery: [{ providerMessageId: "m2", status: "failed" }] }),
    ],
  }), AUDIT_ON);
  assert.equal(findings.find(f => f.channel === "email")!.verdict, "sent_but_delivery_failed");
  assert.equal(findings.filter(f => f.needsAttention).length, 1);
});

// ------------------------------------------------------------------ date maths

test("calendar days are counted in whole Phoenix days", () => {
  assert.equal(calendarDaysBetween("2026-11-10", "2026-11-18"), 8);
  assert.equal(calendarDaysBetween("2026-11-18", "2026-11-18"), 0);
  assert.equal(calendarDaysBetween("2026-11-25", "2026-11-18"), -7);
  // Across a month and a year boundary, where a naive subtraction goes wrong.
  assert.equal(calendarDaysBetween("2026-10-31", "2026-11-01"), 1);
  assert.equal(calendarDaysBetween("2026-12-31", "2027-01-01"), 1);
});

test("unusable dates give null rather than a wrong number", () => {
  assert.equal(calendarDaysBetween("", "2026-11-18"), null);
  assert.equal(calendarDaysBetween("2026-11-18", "18/11/2026"), null);
  assert.equal(calendarDaysBetween("2026-13-45", "2026-11-18"), null);
});

// -------------------------------------------------------------- the summary

test("the summary reconciles: every finding lands in exactly one verdict", () => {
  const findings = [
    auditChannel(subject(), channel(), AUDIT_ON),
    auditChannel(subject({ openNow: false, paidOn: "2026-11-05" }), channel(), AUDIT_ON),
    auditChannel(subject(), channel({ expectation: "suppressed", suppressedReason: "destination_contact_opted_out" }), AUDIT_ON),
  ];
  const summary = summariseAudit(findings, AUDIT_ON);
  assert.equal(summary.reconciliation.ok, true);
  assert.equal(summary.reconciliation.counted, 3);
  assert.equal(summary.total, 3);
});

test("every verdict the module can produce appears in the report order", () => {
  // If a new verdict is added without being ordered, the reconciliation would
  // silently drop it. This test is what makes that impossible.
  const all: AuditVerdict[] = [
    "not_yet_due", "sent_and_delivered", "sent_delivery_unconfirmed", "sent_but_delivery_failed",
    "send_rejected_by_provider", "send_attempt_left_incomplete", "sent_more_than_once",
    "sent_without_a_ledger_row", "paid_before_its_milestone", "paid_after_its_milestone_never_sent",
    "held_explained_by_todays_hold", "missed_no_explanation", "audit_inconclusive",
  ];
  for (const verdict of all) assert.ok(VERDICT_ORDER.includes(verdict), verdict);
  assert.equal(VERDICT_ORDER.length, all.length);
});

test("a clean audit is only clean when nothing needs attention", () => {
  const quiet = summariseAudit([
    auditChannel(subject({ openNow: false, paidOn: "2026-11-05" }), channel(), AUDIT_ON),
    auditChannel(subject(), channel({ expectation: "suppressed", suppressedReason: "destination_contact_opted_out" }), AUDIT_ON),
  ], AUDIT_ON);
  assert.equal(quiet.clean, true);

  const noisy = summariseAudit([auditChannel(subject(), channel(), AUDIT_ON)], AUDIT_ON);
  assert.equal(noisy.clean, false);
});

test("a single unreadable invoice is enough to stop the audit calling itself clean", () => {
  const summary = summariseAudit([
    auditChannel(subject({ openNow: false, paidOn: "2026-11-05" }), channel(), AUDIT_ON),
    auditChannel(subject({ milestoneOn: null }), channel(), AUDIT_ON),
  ], AUDIT_ON);
  assert.equal(summary.clean, false);
  assert.equal(summary.attention.length, 1);
});

test("attention is ordered worst first, with a miss above a delivery failure", () => {
  const summary = summariseAudit([
    auditChannel(subject(), channel({
      ledger: [{ state: "accepted", providerMessageId: "m1" }],
      delivery: [{ providerMessageId: "m1", status: "failed" }] }), AUDIT_ON),
    auditChannel(subject(), channel(), AUDIT_ON),
  ], AUDIT_ON);
  assert.equal(summary.attention[0].verdict, "missed_no_explanation");
  assert.equal(summary.attention[1].verdict, "sent_but_delivery_failed");
});

test("within one verdict, the oldest is reported first", () => {
  const summary = summariseAudit([
    auditChannel(subject({ milestoneOn: "2026-11-16" }), channel(), AUDIT_ON),
    auditChannel(subject({ milestoneOn: "2026-10-01" }), channel(), AUDIT_ON),
  ], AUDIT_ON);
  assert.equal(summary.attention[0].ageDays, 48);
  assert.equal(summary.attention[1].ageDays, 2);
});

test("holds are grouped by reason with the money and the oldest age behind each", () => {
  const consent = (num: string, on: string) => auditChannel(
    subject({ invoiceNumber: num, milestoneOn: on, balanceCents: 10_000 }),
    channel({ expectation: "suppressed", suppressedReason: "destination_contact_email_consent_unknown" }),
    AUDIT_ON);
  const summary = summariseAudit([
    consent("7226", "2026-11-10"), consent("7232", "2026-10-20"),
    auditChannel(subject({ invoiceNumber: "6982", balanceCents: 5_000 }),
      channel({ expectation: "suppressed", suppressedReason: "ambiguous_destination_contacts" }), AUDIT_ON),
  ], AUDIT_ON);
  assert.equal(summary.holds.length, 2);
  assert.equal(summary.holds[0].reason, "destination_contact_email_consent_unknown");
  assert.equal(summary.holds[0].count, 2);
  assert.equal(summary.holds[0].balanceCents, 20_000);
  assert.equal(summary.holds[0].oldestAgeDays, 29);
  assert.deepEqual([...summary.holds[0].invoices], ["#7226", "#7232"]);
  assert.equal(summary.holds[1].count, 1);
});

test("the summary reports invoice numbers only, never a name or contact id", () => {
  const summary = summariseAudit([auditChannel(subject(), channel(), AUDIT_ON)], AUDIT_ON);
  const text = JSON.stringify(summary);
  assert.ok(!/@/.test(text), "no email address may reach a report");
  // The finding carries the invoice id, which is a Jobber opaque id, and the
  // label. Nothing else identifying is modelled at all.
  assert.ok(!("clientName" in summary.attention[0]));
  assert.ok(!("contactId" in summary.attention[0]));
});

test("needs-attention membership is the single source for the flag", () => {
  for (const verdict of NEEDS_ATTENTION) assert.equal(verdictNeedsAttention(verdict), true, verdict);
  for (const verdict of ["not_yet_due", "sent_and_delivered", "held_explained_by_todays_hold",
    "paid_before_its_milestone", "paid_after_its_milestone_never_sent"] as AuditVerdict[]) {
    assert.equal(verdictNeedsAttention(verdict), false, verdict);
  }
});

// ------------------------------------------------- reasons stay readable

test("a repeated hold reason is reported once, not once per message", () => {
  // Measured on real data: the evaluator reports one `ambiguous_send_attribution`
  // per ambiguous message, so #6872 arrived with five copies of it. Joined
  // verbatim that read as five different problems.
  const finding = auditChannel(subject({
    invoiceHolds: ["ambiguous_send_attribution: m1", "ambiguous_send_attribution: m2",
      "ambiguous_send_attribution: m3", "job_notes_hold"],
  }), channel(), AUDIT_ON);
  assert.equal(finding.verdict, "held_explained_by_todays_hold");
  assert.equal(finding.reason, "ambiguous_send_attribution+job_notes_hold");
});

test("deduplicating reasons keeps the hold groups stable", () => {
  // Grouping in the summary keys on the reason string, so two invoices held for
  // the same cause must land in ONE group however many messages each had.
  const held = (num: string, copies: number) => auditChannel(
    subject({ invoiceNumber: num, balanceCents: 10_000,
      invoiceHolds: Array.from({ length: copies }, (_, i) => `ambiguous_send_attribution: m${i}`) }),
    channel(), AUDIT_ON);
  const summary = summariseAudit([held("7087", 2), held("6972", 5)], AUDIT_ON);
  assert.equal(summary.holds.length, 1);
  assert.equal(summary.holds[0].reason, "ambiguous_send_attribution");
  assert.equal(summary.holds[0].count, 2);
});

test("an invoice held on both channels is listed once but counted twice", () => {
  // Counted twice because two messages did not go out; listed once because it
  // is one thing for a person to go and fix.
  const findings = auditInvoice(subject({
    invoiceNumber: "6602", balanceCents: 10_000,
    channels: [
      channel({ channel: "sms", expectation: "suppressed", suppressedReason: "ambiguous_destination_contacts" }),
      channel({ channel: "email", expectation: "suppressed", suppressedReason: "ambiguous_destination_contacts" }),
    ],
  }), AUDIT_ON);
  const summary = summariseAudit([...findings], AUDIT_ON);
  assert.equal(summary.holds[0].count, 2);
  assert.deepEqual([...summary.holds[0].invoices], ["#6602"]);
  // The money must not be double counted into a scarier number... it is the
  // same invoice twice, so this is message-weighted and the report says so.
  assert.equal(summary.holds[0].balanceCents, 20_000);
});
