import test from "node:test";
import assert from "node:assert/strict";
import { closeRunForShutdown, shutdownReason, type AbandonableRun } from "../lib/sync-run-shutdown";
import { cardNameHash, type GhlWriteIntent } from "../lib/sync-writer-control";
import { writerFixture } from "./helpers/sync-writer-fixture";

const AT = new Date("2026-11-24T00:03:58.000Z");

/** A well-formed write intent, so a pending claim is the real thing. */
const intent: GhlWriteIntent = {
  approvalId: "synthetic-release", pipelineId: "pipeline", contactId: "contact",
  opportunityId: "card", jobberClientId: "owner",
  expected: { stageId: "sent", status: "open", amountCents: 10000, nameHash: cardNameHash("Synthetic") },
  target: { stageId: "paid", amountCents: 0, nameHash: cardNameHash("Synthetic"), updateName: false },
  source: { observedAt: "2026-11-07T00:00:00Z", storedInvoiceIds: ["invoice"], invoices: [{
    id: "invoice", jobberClientId: "owner", invoiceStatus: "paid", totalCents: 10000,
    balanceCents: 0, issuedDate: "2026-05-01", createdAt: null, dueDate: "2026-06-01" }] },
};

const fromWriter = (f: ReturnType<typeof writerFixture>): AbandonableRun => ({
  runId: f.rows[0].id,
  abandon: async reason => { await f.writer.finish("failed", reason); },
});

test("no run in flight closes nothing", async () => {
  assert.equal(await closeRunForShutdown(null, "SIGTERM", () => AT), "no_run");
  assert.equal(await closeRunForShutdown(undefined, "SIGTERM", () => AT), "no_run");
});

test("a run with nothing in doubt is given up, with the signal and time recorded", async () => {
  const reasons: string[] = [];
  const active: AbandonableRun = { runId: "run-a", abandon: async r => { reasons.push(r); } };
  assert.equal(await closeRunForShutdown(active, "SIGTERM", () => AT), "closed");
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /SIGTERM/);
  assert.match(reasons[0], /2026-11-24T00:03:58\.000Z/);
  assert.match(reasons[0], /redeployed mid-run/);
  assert.match(reasons[0], /no write intent was pending/i);
});

test("a refused close is reported, never thrown, so shutdown still proceeds", async () => {
  const active: AbandonableRun = {
    runId: "run-b",
    abandon: async () => { throw new Error("Sync is blocked pending operator review."); },
  };
  assert.equal(await closeRunForShutdown(active, "SIGTERM", () => AT), "left_for_review");
});

test("the recorded reason names the signal it was actually given", () => {
  assert.match(shutdownReason("SIGINT", AT), /Container received SIGINT/);
  assert.match(shutdownReason("SIGTERM", AT), /Container received SIGTERM/);
});

// The two tests below drive the REAL writer, so the module's safety claim is
// checked against the code that actually runs, not against a stub.

test("against the real writer, a clean run is marked failed and admission is freed", async () => {
  const f = writerFixture();
  assert.equal(await closeRunForShutdown(fromWriter(f), "SIGTERM", () => AT), "closed");
  assert.equal(f.rows[0].status, "failed", "a clean run must not stay running");
  assert.ok(f.rows[0].completedAt, "a closed run gets a completion time");
  assert.match(String(f.rows[0].errorMessage), /SIGTERM/);
});

test("against the real writer, a pending write leaves the run BLOCKED, not failed", async () => {
  const f = writerFixture();
  // A claimed-but-unconfirmed GoHighLevel write is exactly the uncertain case
  // the non-expiring barrier exists for. Shutdown must not clear it away.
  await f.writer.prepare(structuredClone(intent));
  assert.equal(await closeRunForShutdown(fromWriter(f), "SIGTERM", () => AT), "left_for_review");
  assert.equal(f.rows[0].status, "blocked", "an uncertain write must still stop the next sync");
  assert.ok(String(f.rows[0].errorMessage).startsWith("FLEX_GHL_WRITE_JOURNAL_V1:"),
    "the durable write evidence is never replaced by a shutdown note");
  assert.doesNotMatch(String(f.rows[0].errorMessage), /SIGTERM/);
});

test("shutdown is idempotent in effect: a second close finds nothing to do", async () => {
  const f = writerFixture();
  assert.equal(await closeRunForShutdown(fromWriter(f), "SIGTERM", () => AT), "closed");
  // finish() refuses a run that is no longer running, so a repeat is harmless.
  assert.equal(await closeRunForShutdown(fromWriter(f), "SIGINT", () => AT), "left_for_review");
  assert.equal(f.rows[0].status, "failed", "the first outcome stands");
});
