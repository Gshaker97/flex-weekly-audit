import test from "node:test";
import assert from "node:assert/strict";
import { COLLECTIONS_SINCE } from "../lib/lateInvoices";
import {
  DAY15_EMAIL_ISSUED_ON_OR_AFTER, DAY15_EMAIL_ISSUED_SINCE,
  DAY15_EMAIL_WITHHELD_INVOICE_NUMBERS,
  day15EmailAmountsArePositive, day15EmailIsWithheld, day15EmailIssueWindow,
} from "../lib/reminder-email-window";
import { classifyReworkNotes } from "../lib/reminder-rework-notes";

test("the email programme starts 2026-03-01 and is NOT the dashboard cutoff", () => {
  assert.equal(DAY15_EMAIL_ISSUED_ON_OR_AFTER, "2026-03-01");
  assert.equal(DAY15_EMAIL_ISSUED_SINCE.toISOString(), "2026-03-01T00:00:00.000Z");
  // The two cutoffs must stay independent. If this fails, one was derived from
  // the other and moving the dashboard would silently move who gets emailed.
  assert.notEqual(DAY15_EMAIL_ISSUED_SINCE.getTime(), COLLECTIONS_SINCE.getTime());
  assert.ok(DAY15_EMAIL_ISSUED_SINCE.getTime() > COLLECTIONS_SINCE.getTime());
});

test("issue window: on the boundary is in, the day before is out, forever", () => {
  assert.equal(day15EmailIssueWindow("2026-03-01"), "in_programme");
  assert.equal(day15EmailIssueWindow("2026-02-28"), "before_programme");
  assert.equal(day15EmailIssueWindow("2026-11-17"), "in_programme");
  assert.equal(day15EmailIssueWindow("2025-02-25"), "before_programme"); // #3803's era
});

test("issue window: an unreadable date is never treated as in programme", () => {
  for (const bad of [null, undefined, "", "not-a-date", "2026-13-01", "03/01/2026"]) {
    assert.equal(day15EmailIssueWindow(bad as any), "unusable_issue_date", String(bad));
  }
});

test("amounts: both total and balance must be positive", () => {
  assert.equal(day15EmailAmountsArePositive(7000, 7000).ok, true);
  assert.equal(day15EmailAmountsArePositive(7000, 2500).ok, true);
  assert.equal(day15EmailAmountsArePositive(0, 7000).reason, "source_total_not_positive");
  assert.equal(day15EmailAmountsArePositive(-100, 7000).reason, "source_total_not_positive");
  assert.equal(day15EmailAmountsArePositive(7000, 0).reason, "source_balance_not_positive");
  assert.equal(day15EmailAmountsArePositive(null, 7000).reason, "source_total_unreadable");
  assert.equal(day15EmailAmountsArePositive(7000, null).reason, "source_balance_unreadable");
  assert.equal(day15EmailAmountsArePositive(70.5, 7000).reason, "source_total_unreadable");
});

test("notes: an unmatched job or missing notes HOLDS, never clears or excludes", () => {
  assert.deepEqual(classifyReworkNotes(false, "anything"),
    { verdict: "hold", reason: "job_not_matched_to_invoice", evidence: null });
  assert.equal(classifyReworkNotes(true, null).verdict, "hold");
  assert.equal(classifyReworkNotes(true, "   ").reason, "job_notes_missing");
  assert.equal(classifyReworkNotes(true, "bad � text").reason, "job_notes_unreadable");
});

test("notes: confirmed warranty, callback and no-charge rework are excluded", () => {
  for (const note of [
    "Warranty repair on the valve we installed",
    "warrantied the controller",
    "Callback - sprinkler head we replaced is leaking",
    "call-back for the same zone",
    "redo the trim, no charge",
    "Reworked the edging",
    "free of charge, our error",
    "completed at no cost to the client",
  ]) {
    const result = classifyReworkNotes(true, note);
    assert.equal(result.verdict, "excluded", note);
    assert.equal(result.reason, "confirmed_rework_phrase");
    assert.ok(result.evidence && result.evidence === result.evidence.toLowerCase());
  }
});

test("notes: 'out of warranty' means they DO owe us, so it is not excluded", () => {
  for (const note of [
    "Unit is out of warranty, customer approved the repair",
    "not under warranty any more",
    "warranty expired in 2025",
    "non-warranty service call",
    "No warranty on customer-supplied parts",
  ]) {
    const result = classifyReworkNotes(true, note);
    assert.equal(result.verdict, "hold", note);
    assert.equal(result.reason, "warranty_mentioned_but_negated");
  }
});

test("notes: 'courtesy' alone holds for review; it is not an exclusion", () => {
  const courtesy = classifyReworkNotes(true, "Courtesy blow-out while on site");
  assert.equal(courtesy.verdict, "hold");
  assert.equal(courtesy.reason, "ambiguous_rework_phrase");
  assert.equal(courtesy.evidence, "courtesy");
  // With a confirmed phrase beside it, it becomes a real exclusion.
  assert.equal(classifyReworkNotes(true, "Courtesy re-do of the dead sod").verdict, "excluded");
});

test("notes: ordinary paid work is clear, including the word 'fix'", () => {
  for (const note of [
    "Fixed the broken valve box per estimate",
    "Monthly maintenance visit completed",
    "Installed 2 new emitters, billed",
    "Repair to mainline after customer dug through it",
  ]) {
    assert.equal(classifyReworkNotes(true, note).verdict, "clear", note);
  }
});

test("notes: 'call back' as two words is held, not excluded", () => {
  const scheduling = classifyReworkNotes(true, "Need to call back to schedule the next visit");
  assert.equal(scheduling.verdict, "hold");
  assert.equal(scheduling.reason, "ambiguous_rework_phrase");
});

test("the two invoices the user withheld can never be sendable", () => {
  assert.deepEqual([...DAY15_EMAIL_WITHHELD_INVOICE_NUMBERS].sort(), ["7171", "7246"]);
  assert.equal(day15EmailIsWithheld("7171"), true);
  assert.equal(day15EmailIsWithheld(" 7246 "), true);
  assert.equal(day15EmailIsWithheld("7207"), false);
  assert.equal(day15EmailIsWithheld(null), false);
  assert.equal(day15EmailIsWithheld("71710"), false);
});
