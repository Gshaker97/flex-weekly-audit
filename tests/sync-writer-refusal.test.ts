import test from "node:test";
import assert from "node:assert/strict";
import { SyncWriterRefusedError, SyncWriterBlockedError, syncRunDiagnostics,
  publicSyncErrorMessage, SKIP_LIMIT } from "../lib/sync-writer-control";
import { plainCardSkipReason } from "../lib/card-skip-language";

const PREFIX = "FLEX_GHL_WRITE_JOURNAL_V1:";
const envelope = (runId: string, extra: Record<string, unknown>) =>
  PREFIX + JSON.stringify({ version: 1, runId, warnings: null, writes: [], ...extra });

test("A REFUSAL IS A DIFFERENT CLASS FROM A BLOCK", () => {
  // The whole fix rests on callers being able to tell these apart: one holds a
  // card, the other stops every later sync.
  const refused = new SyncWriterRefusedError("source_invoice_amounts_or_status_incoherent");
  assert.ok(refused instanceof SyncWriterRefusedError);
  assert.ok(!(refused instanceof SyncWriterBlockedError));
  assert.equal(refused.reason, "source_invoice_amounts_or_status_incoherent");
  assert.ok(!(new SyncWriterBlockedError() instanceof SyncWriterRefusedError));
});

test("the skip report round-trips off the run row", () => {
  const msg = envelope("run1", { skips: [
    { invoiceNumber: "6830", customer: "Telford Delmoe", reason: "nothing was sent." },
    { invoiceNumber: null, customer: null, reason: "held for another reason." },
  ] });
  const { skips, block } = syncRunDiagnostics(msg, "run1");
  assert.equal(block, null);
  assert.equal(skips.length, 2);
  assert.equal(skips[0].invoiceNumber, "6830");
  assert.equal(skips[0].customer, "Telford Delmoe");
  assert.equal(skips[1].invoiceNumber, null);
});

test("the block note says which invoice, which step and whether a write was in flight", () => {
  const msg = envelope("run1", { block: {
    invoiceNumber: "6830", customer: "Telford Delmoe", step: "writing this customer's invoice card",
    reason: "the write could not be recorded safely.", pendingWrite: false,
    at: "2026-11-27T20:13:01.000Z" } });
  const { block } = syncRunDiagnostics(msg, "run1");
  assert.ok(block);
  assert.equal(block.invoiceNumber, "6830");
  assert.equal(block.step, "writing this customer's invoice card");
  assert.equal(block.pendingWrite, false);
});

test("a journal for a DIFFERENT run tells us nothing", () => {
  const msg = envelope("run1", { skips: [{ invoiceNumber: "1", customer: "x", reason: "y." }] });
  assert.deepEqual(syncRunDiagnostics(msg, "run2"), { skips: [], block: null, reconcile: null });
});

test("A MALFORMED NOTE IS DROPPED, NEVER THROWN ON", () => {
  // The journal is the write evidence. Losing it because somebody wrote a bad
  // sentence into the envelope would be far worse than losing the sentence.
  for (const skips of [null, 42, "nope", [null], [{}], [{ reason: "" }], [{ reason: "   " }]]) {
    const out = syncRunDiagnostics(envelope("r", { skips }), "r");
    assert.deepEqual(out.skips, [], JSON.stringify(skips));
  }
  // A block missing its step or reason is not a block note.
  assert.equal(syncRunDiagnostics(envelope("r", { block: { reason: "x." } }), "r").block, null);
  assert.equal(syncRunDiagnostics(envelope("r", { block: { step: "x" } }), "r").block, null);
  // Not JSON at all.
  assert.deepEqual(syncRunDiagnostics(PREFIX + "{{{", "r"), { skips: [], block: null, reconcile: null });
  // Not a journal at all.
  assert.deepEqual(syncRunDiagnostics("Jobber GraphQL error: Throttled", "r"), { skips: [], block: null, reconcile: null });
  assert.deepEqual(syncRunDiagnostics(null, "r"), { skips: [], block: null, reconcile: null });
});

test("the skip list is bounded", () => {
  const many = Array.from({ length: SKIP_LIMIT + 50 },
    (_, i) => ({ invoiceNumber: String(i), customer: "c", reason: "r." }));
  assert.equal(syncRunDiagnostics(envelope("r", { skips: many }), "r").skips.length, SKIP_LIMIT);
});

test("THE PUBLIC ENDPOINT NAMES NO CUSTOMER AND NO INVOICE", () => {
  // `publicSyncErrorMessage` feeds an unauthenticated status route. It may say
  // what happened and how much; it may not say who.
  const msg = envelope("r", {
    skips: [{ invoiceNumber: "6830", customer: "Telford Delmoe", reason: "nothing was sent." }],
    block: { invoiceNumber: "6830", customer: "Telford Delmoe", step: "writing this customer's invoice card",
      reason: "secret detail", pendingWrite: false, at: "2026-11-27T20:13:01.000Z" } });
  const out = publicSyncErrorMessage(msg)!;
  assert.doesNotMatch(out, /Telford|Delmoe|6830|secret detail/);
  assert.match(out, /blocked/i);
  assert.match(out, /Nothing was sent/i);
});

test("the public endpoint reports a pending write as needing a person", () => {
  const out = publicSyncErrorMessage(envelope("r", { block: {
    step: "writing this customer's invoice card", reason: "r", pendingWrite: true,
    at: "2026-11-27T20:13:01.000Z" } }))!;
  assert.match(out, /already in flight/i);
  assert.match(out, /person/i);
});

test("a run that only held cards does not claim to need operator review", () => {
  // The old canned sentence said every journal meant "requires operator
  // review". A complete run that skipped two cards does not.
  const out = publicSyncErrorMessage(envelope("r", { skips: [
    { invoiceNumber: "1", customer: "a", reason: "r." },
    { invoiceNumber: "2", customer: "b", reason: "r." }] }))!;
  assert.match(out, /2 invoice cards held/i);
  assert.doesNotMatch(out, /operator review/i);
});

test("a settled journal with no notes keeps the sentence it always had", () => {
  assert.match(publicSyncErrorMessage(envelope("r", {}))!, /Private GHL write evidence retained/);
});

test("a plain non-journal message is passed through untouched", () => {
  assert.equal(publicSyncErrorMessage("Jobber API timeout after 30000ms"), "Jobber API timeout after 30000ms");
  assert.equal(publicSyncErrorMessage(null), null);
});

test("every machine reason the card writer can produce becomes a sentence", () => {
  const reasons = ["source_invoice_amounts_or_status_incoherent", "card_changed_since_the_plan_was_made",
    "card_is_in_a_protected_or_unknown_stage", "one_of_these_invoices_is_not_settled",
    "a_card_for_this_invoice_already_exists", "run_write_budget_exhausted",
    "source_evidence_unavailable", "these_invoices_no_longer_add_up_to_the_amount_planned"];
  for (const r of reasons) {
    const s = plainCardSkipReason(r);
    assert.ok(s.length > 20, r);
    assert.doesNotMatch(s, /_/, `${r} still reads like a machine code: ${s}`);
    assert.doesNotMatch(s, /not yet translated/, r);
  }
});

test("an untranslated reason is made readable rather than hidden", () => {
  const s = plainCardSkipReason("some_brand_new_reason");
  assert.match(s, /some brand new reason/);
  assert.match(s, /not yet translated/);
  assert.doesNotMatch(s, /_/);
});

test("the read-failure prefixes are translated without leaking the raw error", () => {
  const s = plainCardSkipReason("fresh_card_read_failed_ECONNRESET at line 9");
  assert.doesNotMatch(s, /ECONNRESET/);
  assert.match(s, /Nothing was sent/i);
});

test("a reason that is already a sentence is left alone", () => {
  const sentence = "this card's write could not be recorded safely, so it was left alone (x)";
  assert.equal(plainCardSkipReason(sentence), sentence);
});

test("an empty reason still says something", () => {
  for (const v of [null, undefined, "", "   "]) {
    assert.ok(plainCardSkipReason(v as any).length > 10, String(v));
  }
});
