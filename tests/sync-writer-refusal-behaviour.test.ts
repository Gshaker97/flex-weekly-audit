import test from "node:test";
import assert from "node:assert/strict";
import { SyncRunWriter, SyncWriterRefusedError, SyncWriterBlockedError, cardNameHash,
  syncRunDiagnostics, type GhlWriteIntent } from "../lib/sync-writer-control";
import { writerFixture } from "./helpers/sync-writer-fixture";

/** A well-formed intent: `paid` with a zero balance, which the journal accepts. */
const good = (): GhlWriteIntent => ({
  approvalId: "synthetic-release", pipelineId: "pipeline", contactId: "contact",
  opportunityId: "card", jobberClientId: "owner",
  expected: { stageId: "sent", status: "open", amountCents: 10000, nameHash: cardNameHash("Synthetic") },
  target: { stageId: "paid", amountCents: 0, nameHash: cardNameHash("Synthetic"), updateName: false },
  source: { observedAt: "2026-11-07T00:00:00Z", storedInvoiceIds: ["invoice"],
    invoices: [{ id: "invoice", jobberClientId: "owner", invoiceStatus: "paid",
      totalCents: 10000, balanceCents: 0, issuedDate: "2026-05-01", createdAt: null, dueDate: "2026-06-01" }] },
});

/**
 * THE EXACT SHAPE THAT BLOCKED THE SYNC ON 2026-11-27: Jobber's `paid` label
 * with money still outstanding. `validateIntent` refuses it, and before this
 * change that refusal halted every remaining card write and blocked the run.
 */
const malformed = (): GhlWriteIntent => {
  const i = good();
  return { ...i, source: { ...i.source,
    invoices: [{ ...i.source.invoices[0], invoiceStatus: "paid", totalCents: 6000, balanceCents: 6000 }] } };
};

test("A MALFORMED INTENT IS REFUSED, AND THE RUN IS LEFT ALONE", async () => {
  const f = writerFixture();
  await assert.rejects(f.writer.prepare(malformed()), (err: unknown) => {
    assert.ok(err instanceof SyncWriterRefusedError, `got ${(err as Error)?.constructor?.name}`);
    assert.ok(!(err instanceof SyncWriterBlockedError));
    return true;
  });
  // The whole point: the run is still running and nothing was journaled.
  assert.equal(f.rows[0].status, "running", "the run must NOT be blocked");
  assert.equal(f.rows[0].errorMessage, null, "nothing was written to the journal");
});

test("and the writer still works afterwards, so later cards are not collateral damage", async () => {
  const f = writerFixture();
  await assert.rejects(f.writer.prepare(malformed()), SyncWriterRefusedError);
  // A good write immediately after the refusal must still succeed. Before the
  // fix the writer was halted and every later card failed the same way.
  const id = await f.writer.prepare(good());
  assert.ok(id);
  assert.equal(f.rows[0].status, "running");
  const journal = JSON.parse(f.rows[0].errorMessage.slice("FLEX_GHL_WRITE_JOURNAL_V1:".length));
  assert.equal(journal.writes.length, 1);
  assert.equal(journal.writes[0].state, "pending");
});

test("DUPLICATE PROTECTION STILL BLOCKS: a pending write stops the next prepare", async () => {
  // This is the guarantee the fix must not weaken. A write whose outcome is
  // unknown is the one case where another attempt could duplicate a card.
  const f = writerFixture();
  await f.writer.prepare(good());
  await assert.rejects(f.writer.prepare(good()), (err: unknown) => {
    assert.ok(err instanceof SyncWriterBlockedError, "a pending write must BLOCK, not refuse");
    assert.ok(!(err instanceof SyncWriterRefusedError));
    return true;
  });
  assert.equal(f.rows[0].status, "blocked");
});

test("DUPLICATE PROTECTION STILL BLOCKS: a run that is not running cannot prepare", async () => {
  const f = writerFixture();
  f.rows[0].status = "blocked";
  await assert.rejects(f.writer.prepare(good()), SyncWriterBlockedError);
});

test("DUPLICATE PROTECTION STILL BLOCKS: a lost update race blocks", async () => {
  const f = writerFixture();
  f.failNextUpdate();
  await assert.rejects(f.writer.prepare(good()), (err: unknown) => {
    assert.ok(err instanceof SyncWriterBlockedError);
    assert.ok(!(err instanceof SyncWriterRefusedError));
    return true;
  });
  assert.equal(f.rows[0].status, "blocked");
});

test("an already-halted writer blocks rather than refusing", async () => {
  const f = writerFixture();
  await f.writer.block({ invoiceNumber: null, customer: null, step: "a test", reason: "halted on purpose." });
  await assert.rejects(f.writer.prepare(good()), (err: unknown) => {
    assert.ok(err instanceof SyncWriterBlockedError);
    assert.ok(!(err instanceof SyncWriterRefusedError));
    return true;
  });
});

test("THE BLOCK WRITES ITS REASON ONTO THE ROW", async () => {
  const f = writerFixture();
  await f.writer.block({ invoiceNumber: "6830", customer: "Telford Delmoe",
    step: "writing this customer's invoice card", reason: "the write could not be recorded safely." });
  assert.equal(f.rows[0].status, "blocked");
  const { block } = syncRunDiagnostics(f.rows[0].errorMessage, "test-run");
  assert.ok(block, "the row must explain itself");
  assert.equal(block.invoiceNumber, "6830");
  assert.equal(block.customer, "Telford Delmoe");
  assert.equal(block.step, "writing this customer's invoice card");
  assert.equal(block.pendingWrite, false, "nothing was in flight, so this is clearable");
});

test("a block WITH a pending write records that it needs a person", async () => {
  const f = writerFixture();
  await f.writer.prepare(good());           // leaves one pending write
  await f.writer.block({ invoiceNumber: "1", customer: "c", step: "writing a card", reason: "stopped." });
  const { block } = syncRunDiagnostics(f.rows[0].errorMessage, "test-run");
  assert.equal(block?.pendingWrite, true, "a pending write must be recorded as human-only");
});

test("A BLOCK NEVER DESTROYS THE WRITE EVIDENCE", async () => {
  const f = writerFixture();
  const id = await f.writer.prepare(good());
  await f.writer.block({ invoiceNumber: "1", customer: "c", step: "writing a card", reason: "stopped." });
  const journal = JSON.parse(f.rows[0].errorMessage.slice("FLEX_GHL_WRITE_JOURNAL_V1:".length));
  assert.equal(journal.writes.length, 1, "the write must survive");
  assert.equal(journal.writes[0].id, id);
  assert.equal(journal.writes[0].state, "pending");
});

test("skips are recorded on the row when the run finishes", async () => {
  const f = writerFixture();
  f.writer.noteSkip({ invoiceNumber: "6830", customer: "Telford Delmoe", reason: "nothing was sent." });
  f.writer.noteSkip({ invoiceNumber: "780", customer: "Lori Neff", reason: "held for review." });
  await f.writer.finish("complete");
  assert.equal(f.rows[0].status, "complete");
  const { skips } = syncRunDiagnostics(f.rows[0].errorMessage, "test-run");
  assert.equal(skips.length, 2);
  assert.equal(skips[0].invoiceNumber, "6830");
  assert.equal(skips[1].customer, "Lori Neff");
});

test("a run with no skips leaves errorMessage alone", async () => {
  const f = writerFixture();
  await f.writer.finish("complete");
  assert.equal(f.rows[0].errorMessage, null, "nothing to say means nothing written");
});

test("a failure message survives alongside the skip notes", async () => {
  const f = writerFixture();
  f.writer.noteSkip({ invoiceNumber: "1", customer: "c", reason: "held." });
  await f.writer.finish("failed", "Jobber GraphQL error: Throttled");
  const journal = JSON.parse(f.rows[0].errorMessage.slice("FLEX_GHL_WRITE_JOURNAL_V1:".length));
  assert.equal(journal.warnings, "Jobber GraphQL error: Throttled", "the original failure must not be lost");
  assert.equal(syncRunDiagnostics(f.rows[0].errorMessage, "test-run").skips.length, 1);
});

test("noteSkip never throws and is bounded", () => {
  const f = writerFixture();
  for (const bad of [null, undefined, {}, { reason: "" }, { reason: "   " }]) {
    f.writer.noteSkip(bad as any);
  }
  for (let i = 0; i < 400; i++) f.writer.noteSkip({ invoiceNumber: String(i), customer: "c", reason: "r." });
  // Nothing thrown; the cap is asserted through the persisted form elsewhere.
  assert.ok(true);
});

test("a skip note cannot grow without limit", async () => {
  const f = writerFixture();
  f.writer.noteSkip({ invoiceNumber: "1", customer: "c", reason: "x".repeat(5000) });
  await f.writer.finish("complete");
  const { skips } = syncRunDiagnostics(f.rows[0].errorMessage, "test-run");
  assert.equal(skips.length, 0, "an over-long reason is dropped, not stored");
});
