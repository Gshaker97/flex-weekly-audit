import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { admitSyncRun, SyncRunWriter, cardNameHash, publicSyncErrorMessage, type GhlWriteIntent } from "../lib/sync-writer-control";
import { approvedGhlCards } from "../lib/ghl-write-intent";
import { inBatches } from "../lib/sync";
import { prisma } from "../lib/prisma";
import { GET, POST } from "../app/api/sync/run/route";
import { GET as statusGet } from "../app/api/sync/status/route";
import { writerFixture } from "./helpers/sync-writer-fixture";

const intent: GhlWriteIntent = {
  approvalId: "synthetic-release", pipelineId: "pipeline", contactId: "contact", opportunityId: "card", jobberClientId: "owner",
  expected: { stageId: "sent", status: "open", amountCents: 10000, nameHash: cardNameHash("Synthetic") },
  target: { stageId: "paid", amountCents: 0, nameHash: cardNameHash("Synthetic"), updateName: false },
  source: { observedAt: "2026-11-07T00:00:00Z", storedInvoiceIds: ["invoice"], invoices: [{ id: "invoice", jobberClientId: "owner", invoiceStatus: "paid",
    totalCents: 10000, balanceCents: 0, issuedDate: "2026-05-01", createdAt: null, dueDate: "2026-06-01" }] },
};
const prefix = "FLEX_GHL_WRITE_JOURNAL_V1:";
const saved = (f: ReturnType<typeof writerFixture>) => JSON.parse(f.rows[0].errorMessage.slice(prefix.length));

test("admission serializes check-create and has no stale-run expiry", async () => {
  delete process.env.SYNC_ADMISSION_MODE;
  const f = writerFixture(false);
  const results = await Promise.allSettled([admitSyncRun({ entrypoint: "http" }, f.db), admitSyncRun({ entrypoint: "standalone_cron" }, f.db)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  f.rows[0].startedAt = new Date("2000-01-01");
  await assert.rejects(admitSyncRun({ entrypoint: "standalone_cron" }, f.db), /running or blocked/);
  f.rows[0].status = "blocked";
  await assert.rejects(admitSyncRun({ entrypoint: "standalone_cron" }, f.db), /running or blocked/);
});
test("both HTTP verbs reject cron-labeled admission before any DB or provider work", async () => {
  process.env.SYNC_ADMISSION_MODE = "cron_only"; process.env.CRON_SECRET = "synthetic";
  (prisma.syncRun as any).findFirst = async () => { throw new Error("Unexpected DB action"); };
  globalThis.fetch = async () => { throw new Error("Unexpected provider action"); };
  for (const handler of [GET, POST]) {
    const response = await handler(new NextRequest("http://localhost/api/sync/run?cron_secret=synthetic", { headers: { "x-cron-secret": "synthetic" } }));
    assert.equal(response.status, 503); assert.match((await response.json()).error, /standalone cron/);
  }
  delete process.env.SYNC_ADMISSION_MODE; delete process.env.CRON_SECRET;
});
test("pending evidence is committed before use, immutable and retained on confirmed finalization", async () => {
  const f = writerFixture(); f.rows[0].errorMessage = "Prior synthetic warning";
  const input = structuredClone(intent); const id = await f.writer.prepare(input);
  assert.equal(saved(f).writes[0].state, "pending"); assert.deepEqual(saved(f).writes[0].intent, intent);
  assert.equal(saved(f).warnings, "Prior synthetic warning"); assert.ok(f.calls.includes("synchronous-commit"));
  input.target.amountCents = 99; assert.equal(saved(f).writes[0].intent.target.amountCents, 0);
  await f.writer.assertPending(id); await f.writer.confirm(id);
  const evidence = f.rows[0].errorMessage;
  const result = await f.writer.finish("complete");
  assert.equal(f.rows[0].errorMessage, evidence); assert.equal(result.status, "complete");
  assert.ok(!result.errorMessage?.includes('"owner"')); assert.ok(!result.errorMessage?.includes(prefix));
});
for (const finalStatus of ["complete", "failed"] as const) {
  test(`pending journal cannot be erased by ${finalStatus} finalization`, async () => {
    const f = writerFixture(); await f.writer.prepare(intent); const before = f.rows[0].errorMessage;
    await assert.rejects(f.writer.finish(finalStatus, "generic error"));
    assert.equal(f.rows[0].status, "blocked"); assert.equal(f.rows[0].errorMessage, before);
    await assert.rejects(admitSyncRun({ entrypoint: "standalone_cron" }, f.db));
  });
}
test("a reconstructed writer after a crash cannot overwrite a pending intent", async () => {
  const f = writerFixture(); await f.writer.prepare(intent); const before = f.rows[0].errorMessage;
  await assert.rejects(new SyncRunWriter("test-run", f.db).prepare(intent));
  assert.equal(f.rows[0].errorMessage, before); assert.equal(f.rows[0].status, "blocked");
});
for (const method of ["prepare", "confirm"] as const) {
  test(`lost ${method} commit acknowledgment preserves evidence and blocks`, async () => {
    const f = writerFixture(); const id = method === "confirm" ? await f.writer.prepare(intent) : "";
    f.loseNextCommit(); await assert.rejects(method === "prepare" ? f.writer.prepare(intent) : f.writer.confirm(id));
    assert.equal(f.rows[0].status, "blocked"); assert.equal(saved(f).writes.length, 1);
    assert.equal(saved(f).writes[0].state, method === "prepare" ? "pending" : "confirmed");
    await assert.rejects(admitSyncRun({ entrypoint: "standalone_cron" }, f.db));
  });
}
test("ordinary later failure retains every confirmed intent", async () => {
  const f = writerFixture(); const id = await f.writer.prepare(intent); await f.writer.confirm(id);
  const before = f.rows[0].errorMessage; await f.writer.finish("failed", "generic later failure");
  assert.equal(f.rows[0].errorMessage, before); assert.equal(f.rows[0].status, "failed");
});
test("corrupt journal fails closed and never appears in public error/status payloads", async () => {
  const f = writerFixture(); const broken = prefix + '{"secret":"synthetic-private-value"'; f.rows[0].errorMessage = broken;
  await assert.rejects(f.writer.finish("failed", "replace")); assert.equal(f.rows[0].errorMessage, broken);
  assert.ok(!publicSyncErrorMessage(broken)?.includes("synthetic-private-value"));
  (prisma.syncRun as any).findFirst = async () => f.rows[0];
  const body = await (await statusGet()).json(); assert.equal(body.run.status, "blocked");
  assert.ok(!JSON.stringify(body).includes("synthetic-private-value"));
  const page = readFileSync(new URL("../app/risk/overdue/page.tsx", import.meta.url), "utf8");
  assert.ok(page.includes("publicSyncErrorMessage(lastSync.errorMessage)"));
});
test("a rejected batch drains delayed siblings before admission may be released", async () => {
  const f = writerFixture(); let release!: () => void; let siblingDone = false; let finalized = false;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const operation = inBatches([0, 1], async index => {
    if (!index) throw new Error("synthetic first failure");
    await delayed; siblingDone = true;
  }).catch(async () => { assert.equal(siblingDone, true); await f.writer.finish("failed", "synthetic"); finalized = true; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(finalized, false); assert.equal(f.rows[0].status, "running");
  await assert.rejects(admitSyncRun({ entrypoint: "standalone_cron" }, f.db));
  release(); await operation; assert.equal(finalized, true);
  assert.ok((await admitSyncRun({ entrypoint: "standalone_cron" }, f.db)).run.id);
});
test("allowlist requires explicit plan identity and rejects malformed or oversized lists", () => {
  const env = { GHL_WRITE_APPROVAL_ID: "reviewed-release-1", GHL_APPROVED_OPPORTUNITY_IDS: JSON.stringify(Array.from({ length: 50 }, (_, i) => `card-${i}`)) };
  assert.equal(approvedGhlCards(env).size, 50);
  for (const patch of [{ GHL_WRITE_APPROVAL_ID: undefined }, { GHL_WRITE_APPROVAL_ID: " " }, { GHL_APPROVED_OPPORTUNITY_IDS: "{}" },
    { GHL_APPROVED_OPPORTUNITY_IDS: '["duplicate","duplicate"]' }, { GHL_APPROVED_OPPORTUNITY_IDS: '[" card"]' },
    { GHL_APPROVED_OPPORTUNITY_IDS: JSON.stringify(Array.from({ length: 501 }, (_, i) => `card-${i}`)) }]) assert.equal(approvedGhlCards({ ...env, ...patch }).size, 0);
});
