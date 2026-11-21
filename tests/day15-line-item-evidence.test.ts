import test from "node:test";
import assert from "node:assert/strict";
import { classifyLinkedJobRework } from "../lib/reminder-rework-notes";

/**
 * Measured on 2026-11-18: of the 20 invoices then held as unverifiable, 1 job
 * carried a title, 0 carried instructions and 2 carried a note with any words.
 * The notes were not missing - all 152 inspected carried a photo and no text.
 * Flexx crews document with pictures. Line item names exist on all 20 and say
 * what was billed, so they are now read as the description of the work.
 */
const job = (patch: Record<string, unknown> = {}) => ({
  notesComplete: true, title: null, instructions: null, jobNoteMessages: [], ...patch,
});
const run = (patch: Record<string, unknown> = {}) => classifyLinkedJobRework({
  complete: true, reason: null, jobs: [job()], lineItemNames: ["Routine Maintenance"],
  lineItemsComplete: true, ...patch,
} as any);

test("a photo-only job with a line item name is now readable", () => {
  const r = run();
  assert.equal(r.verdict, "clear");
  assert.equal(r.reason, "notes_read_no_rework_phrase");
});

test("the real shapes behind the 20 held invoices all clear", () => {
  for (const name of ["Routine Maintenance", "Winter Rye Seeding",
    "Irrigation Diagnostic Promotion", "Visit on Nov 09, 2026"]) {
    assert.equal(run({ lineItemNames: [name] }).verdict, "clear", name);
  }
});

test("no text on the job AND none on the invoice still holds", () => {
  for (const names of [[], ["   "], undefined]) {
    const r = run({ lineItemNames: names });
    assert.equal(r.verdict, "hold", JSON.stringify(names));
    assert.equal(r.reason, "no_readable_text_on_job_or_invoice");
  }
});

test("a rework word in a LINE ITEM still holds", () => {
  const r = run({ lineItemNames: ["Redo of front yard"] });
  assert.equal(r.verdict, "hold");
  assert.equal(r.reason, "rework_word_without_proof_it_was_free");
});

test("a confirmed warranty line item excludes the invoice", () => {
  const r = run({ lineItemNames: ["Warranty replacement"] });
  assert.equal(r.verdict, "excluded");
  assert.equal(r.reason, "confirmed_warranty_or_no_charge");
});

test("a merely suggestive line item holds for a person rather than excluding", () => {
  // Neither phrase is the confirmed wording, so the existing rule holds them
  // for a human. Line items inherit that caution exactly as notes do.
  for (const name of ["Courtesy trim", "No charge visit"]) {
    const r = run({ lineItemNames: [name] });
    assert.equal(r.verdict, "hold", name);
    assert.equal(r.reason, "ambiguous_rework_phrase", name);
  }
});

test("a clean line item cannot wash out a rework word in the job notes", () => {
  const r = run({ jobs: [job({ jobNoteMessages: ["had to redo the valve"] })],
    lineItemNames: ["Routine Maintenance"] });
  assert.equal(r.verdict, "hold");
  assert.equal(r.reason, "rework_word_without_proof_it_was_free");
});

test("one dirty line item among clean ones still decides", () => {
  const r = run({ lineItemNames: ["Routine Maintenance", "Warranty repair", "Fertilizer"] });
  assert.equal(r.verdict, "excluded");
});

test("an unread page of line items holds rather than judging a partial list", () => {
  const r = run({ lineItemsComplete: false });
  assert.equal(r.verdict, "hold");
  assert.equal(r.reason, "invoice_line_items_read_incomplete");
});

test("the earlier holds are all untouched", () => {
  assert.equal(classifyLinkedJobRework({ complete: false, reason: "x", jobs: [] } as any).reason,
    "linked_jobs_read_incomplete: x");
  assert.equal(classifyLinkedJobRework({ complete: true, reason: null, jobs: [],
    lineItemNames: ["Routine Maintenance"], lineItemsComplete: true } as any).reason,
    "no_linked_job_in_jobber");
  assert.equal(classifyLinkedJobRework({ complete: true, reason: null,
    jobs: [job({ notesComplete: false })], lineItemNames: ["Routine Maintenance"],
    lineItemsComplete: true } as any).reason, "job_notes_read_incomplete");
});

test("a job with text and one without no longer holds on the empty one", () => {
  // Previously the empty job alone forced a hold, even when the invoice and the
  // other job described the work perfectly well.
  const r = run({ jobs: [job({ title: "Monthly service" }), job()] });
  assert.equal(r.verdict, "clear");
});
