import test from "node:test";
import assert from "node:assert/strict";
import { closeRunOnShutdown } from "../lib/sync-shutdown";

const JP = "FLEX_GHL_WRITE_JOURNAL_V1:";
const RUN = "run-1";

const journal = (states: string[]) => JP + JSON.stringify({
  version: 1, runId: RUN, warnings: null,
  writes: states.map((state, i) => ({ id: `w-${i}`, state, preparedAt: "2026-11-26T02:00:00Z" })),
});

/** A stand-in Prisma that records what was asked of it. */
function fakeDb(row: { status: string; errorMessage: string | null } | null,
                opts: { updates?: number; throwOn?: "find" | "update" } = {}) {
  const calls: any[] = [];
  const db: any = {
    syncRun: {
      findUnique: async (q: any) => {
        calls.push({ op: "findUnique", where: q.where });
        if (opts.throwOn === "find") throw new Error("database is down");
        return row;
      },
      updateMany: async (q: any) => {
        calls.push({ op: "updateMany", where: q.where, data: q.data });
        if (opts.throwOn === "update") throw new Error("write rejected");
        return { count: opts.updates ?? 1 };
      },
    },
  };
  return { db, calls };
}

test("a running run with no pending write is abandoned, with a note explaining why", () => {
  // The ordinary case: a deploy replaced the container mid-run.
  return (async () => {
    const { db, calls } = fakeDb({ status: "running", errorMessage: null });
    assert.equal(await closeRunOnShutdown(RUN, "SIGTERM", db), "abandoned");
    const w = calls.find(c => c.op === "updateMany");
    assert.equal(w.data.status, "abandoned");
    assert.ok(w.data.completedAt instanceof Date);
    assert.match(w.data.errorMessage, /Shut down by SIGTERM/);
    assert.match(w.data.errorMessage, /next hourly sync may start normally/);
    // Guarded on the status, so it cannot stomp a run that just finished.
    assert.deepEqual(w.where, { id: RUN, status: "running" });
  })();
});

test("a PENDING write moves the run to blocked, not abandoned", async () => {
  // The important one. An unknown write outcome must keep the next sync
  // refused rather than invite a duplicate card.
  const { db, calls } = fakeDb({ status: "running", errorMessage: journal(["confirmed", "pending"]) });
  assert.equal(await closeRunOnShutdown(RUN, "SIGTERM", db), "blocked_pending_write");
  const w = calls.find(c => c.op === "updateMany");
  assert.equal(w.data.status, "blocked");
  assert.equal("errorMessage" in w.data, false, "the write journal must be preserved");
});

test("an unreadable journal is treated as a pending write", async () => {
  // Not being able to read the evidence is not evidence of safety.
  for (const bad of [JP + "{not json", JP + '{"version":1}', JP + '{"writes":"nope"}']) {
    const { db, calls } = fakeDb({ status: "running", errorMessage: bad });
    assert.equal(await closeRunOnShutdown(RUN, "SIGTERM", db), "blocked_pending_write", bad.slice(0, 40));
    assert.equal(calls.find(c => c.op === "updateMany").data.status, "blocked");
  }
});

test("a settled journal is abandoned but never written over", async () => {
  const { db, calls } = fakeDb({ status: "running", errorMessage: journal(["confirmed", "abandoned"]) });
  assert.equal(await closeRunOnShutdown(RUN, "SIGTERM", db), "abandoned");
  const w = calls.find(c => c.op === "updateMany");
  assert.equal(w.data.status, "abandoned");
  assert.equal("errorMessage" in w.data, false, "the write journal must be preserved");
});

test("a run that already finished is left exactly as it is", async () => {
  for (const status of ["complete", "failed", "abandoned", "blocked"]) {
    const { db, calls } = fakeDb({ status, errorMessage: null });
    assert.equal(await closeRunOnShutdown(RUN, "SIGTERM", db), "already_finished", status);
    assert.equal(calls.some(c => c.op === "updateMany"), false, `${status} must not be written to`);
  }
});

test("a missing run writes nothing", async () => {
  const { db, calls } = fakeDb(null);
  assert.equal(await closeRunOnShutdown(RUN, "SIGTERM", db), "not_found");
  assert.equal(calls.some(c => c.op === "updateMany"), false);
});

test("losing the race writes nothing further", async () => {
  // The run finished between the read and the guarded write.
  const { db } = fakeDb({ status: "running", errorMessage: null }, { updates: 0 });
  assert.equal(await closeRunOnShutdown(RUN, "SIGTERM", db), "already_finished");
});

test("it never throws out of a signal handler", async () => {
  for (const throwOn of ["find", "update"] as const) {
    const { db } = fakeDb({ status: "running", errorMessage: null }, { throwOn });
    assert.equal(await closeRunOnShutdown(RUN, "SIGTERM", db), "failed", throwOn);
  }
});

test("it only ever touches the one run it was given", async () => {
  const { db, calls } = fakeDb({ status: "running", errorMessage: null });
  await closeRunOnShutdown("run-abc", "SIGINT", db);
  for (const c of calls) assert.equal(c.where.id, "run-abc");
});

test("the signal name reaches the note", async () => {
  const { db, calls } = fakeDb({ status: "running", errorMessage: null });
  await closeRunOnShutdown(RUN, "SIGINT", db);
  assert.match(calls.find(c => c.op === "updateMany").data.errorMessage, /Shut down by SIGINT/);
});
