import test from "node:test";
import assert from "node:assert/strict";
import { COLLECTIONS_SINCE } from "../lib/lateInvoices";
import {
  DAY15_EMAIL_ISSUED_ON_OR_AFTER, DAY15_EMAIL_ISSUED_SINCE,
  DAY15_EMAIL_WITHHELD_INVOICE_NUMBERS,
  day15EmailAmountsArePositive, day15EmailIsWithheld, day15EmailIssueWindow,
} from "../lib/reminder-email-window";
import { classifyJobText, classifyLinkedJobRework, classifyOneNote, classifyReworkNotes } from "../lib/reminder-rework-notes";

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
  assert.equal(classifyReworkNotes(true, "   ").reason, "job_has_no_readable_text");
  assert.equal(classifyReworkNotes(true, "bad � text").reason, "job_notes_unreadable");
});

test("notes: only a phrase asserting warranty or no charge excludes", () => {
  for (const note of [
    "Valve replaced under warranty",
    "Warranty repair on the head we installed",
    "warrantied the controller",
    "Replaced the emitter at no charge",
    "no charge to the client for the trip",
    "free of charge, our error",
    "completed at no cost to the client",
    "redid the trim at our expense",
    "Callback on the same zone, we will cover the parts",
  ]) {
    const result = classifyOneNote(note);
    assert.equal(result.verdict, "excluded", note);
    assert.ok(result.evidence && result.evidence === result.evidence.toLowerCase());
  }
});

test("notes: a bare rework word HOLDS, it does not exclude", () => {
  // These are the real notes that the earlier bare-word rule got wrong.
  const quote = classifyOneNote("Send out quote to client for redoing backyard drip with 1 new valve");
  assert.equal(quote.verdict, "hold");
  assert.equal(quote.reason, "rework_word_without_proof_it_was_free");
  const tree = classifyOneNote("Complete fertilization service and re-do of tree");
  assert.equal(tree.verdict, "hold");
  assert.equal(tree.reason, "rework_word_without_proof_it_was_free");
  for (const note of ["Callback scheduled for Tuesday", "reworking the layout next week"]) {
    assert.equal(classifyOneNote(note).verdict, "hold", note);
  }
});

test("notes: a confirmation must come from ONE note, not two combined", () => {
  const combined = classifyJobText({ title: null, instructions: null, jobNoteMessages: [
    "Send out quote to client for redoing backyard drip",
    "Courtesy call to confirm the gate code",
  ] });
  // "courtesy" alone is ambiguous and "redoing" alone is a bare rework word.
  // Neither note confirms on its own, so the job holds instead of being excluded.
  assert.equal(combined.verdict, "hold");
  const singleNote = classifyJobText({ title: null, instructions: null, jobNoteMessages: [
    "Redoing the valve box at no charge to the client",
  ] });
  assert.equal(singleNote.verdict, "excluded");
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

test("a job with no readable text at all holds (the #7207 case)", () => {
  // Its one linked job carries 26 notes whose messages are all empty strings.
  const empty = classifyJobText({ title: null, instructions: "", jobNoteMessages: ["", "  ", ""] });
  assert.deepEqual(empty, { verdict: "hold", reason: "job_has_no_readable_text", evidence: null });
});

test("linked-job verdict: incomplete reads and no linked job both hold", () => {
  assert.equal(classifyLinkedJobRework({ complete: false, reason: "jobs_read_errored", jobs: [] }).verdict, "hold");
  assert.equal(classifyLinkedJobRework({ complete: true, reason: null, jobs: [] }).reason, "no_linked_job_in_jobber");
  assert.equal(classifyLinkedJobRework({ complete: true, reason: null, jobs: [
    { notesComplete: false, title: null, instructions: null, jobNoteMessages: ["Monthly maintenance"] },
  ] }).reason, "job_notes_read_incomplete");
});

test("linked-job verdict: one warranty job excludes the invoice even beside a clean job", () => {
  const verdict = classifyLinkedJobRework({ complete: true, reason: null, jobs: [
    { notesComplete: true, title: null, instructions: null, jobNoteMessages: ["Monthly maintenance completed"] },
    { notesComplete: true, title: null, instructions: null, jobNoteMessages: ["Head replaced under warranty"] },
  ] });
  assert.equal(verdict.verdict, "excluded");
});

test("linked-job verdict: every job readable and clean clears the invoice", () => {
  const verdict = classifyLinkedJobRework({ complete: true, reason: null, jobs: [
    { notesComplete: true, title: "Monthly service", instructions: "", jobNoteMessages: ["Trimmed and blown"] },
  ] });
  assert.equal(verdict.verdict, "clear");
});
