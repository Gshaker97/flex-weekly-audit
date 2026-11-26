import type { PrismaClient } from "@prisma/client";
import { SyncRunWriter } from "../../lib/sync-writer-control";

export function writerFixture(initial = true) {
  let serial = 0;
  const rows: any[] = initial ? [{ id: "test-run", status: "running", errorMessage: null, startedAt: new Date(), completedAt: null, mode: "full", triggeredBy: "cron" }] : [];
  const calls: string[] = [];
  let afterCommit: (() => void) | undefined;
  let beforeUpdate: (() => void) | undefined;
  const matches = (row: any, where: any = {}) => Object.entries(where).every(([key, value]) =>
    value && typeof value === "object" && "in" in value ? (value.in as unknown[]).includes(row[key]) : row[key] === value);
  const model = {
    findMany: async () => structuredClone(rows.filter(row => row.errorMessage?.startsWith("FLEX_GHL_WRITE_JOURNAL_V1:"))),
    findFirst: async ({ where }: any) => rows.find(row => matches(row, where)) ?? null,
    findUniqueOrThrow: async ({ where }: any) => { const row = rows.find(row => matches(row, where)); if (!row) throw new Error("Synthetic missing run"); return structuredClone(row); },
    create: async ({ data }: any) => { const row = { id: `run-${++serial}`, status: "running", errorMessage: null, startedAt: new Date(), completedAt: null, ...data }; rows.push(row); return structuredClone(row); },
    updateMany: async ({ where, data }: any) => { beforeUpdate?.(); const selected = rows.filter(row => matches(row, where)); selected.forEach(row => Object.assign(row, data)); return { count: selected.length }; },
  };
  // The progress signal admission reads to tell a slow run from a dead one.
  // `undefined` means the model is absent entirely, which admission must treat
  // as unreadable and therefore refuse on.
  let lastSyncedAt: Date | null | undefined = null;
  const invoiceRecord = { aggregate: async () => ({ _max: { lastSyncedAt } }) };
  let tail: Promise<unknown> = Promise.resolve();
  const db = {
    syncRun: model,
    invoiceRecord,
    $transaction: async (fn: (tx: any) => unknown) => {
      const previous = tail; let unlock!: () => void; tail = new Promise<void>(resolve => { unlock = resolve; });
      await previous; const before = structuredClone(rows);
      try {
        const result = await fn({ syncRun: model, ...(lastSyncedAt === undefined ? {} : { invoiceRecord }), $executeRaw: async () => { calls.push("synchronous-commit"); return 0; }, $queryRaw: async () => [{ locked: true }] });
        calls.push("commit"); unlock(); afterCommit?.(); return result;
      } catch (error) {
        // A fault after commit intentionally cannot roll back committed rows.
        if (calls.at(-1) !== "commit") rows.splice(0, rows.length, ...before);
        unlock(); throw error;
      }
    },
  } as unknown as PrismaClient;
  return { db, rows, calls, writer: new SyncRunWriter("test-run", db),
    /** The newest invoice write admission will see. `undefined` hides the model. */
    setRowProgress: (at: Date | null | undefined) => { lastSyncedAt = at; },
    loseNextCommit: () => { afterCommit = () => { afterCommit = undefined; throw new Error("Synthetic lost commit reply"); }; },
    failNextUpdate: () => { beforeUpdate = () => { beforeUpdate = undefined; throw new Error("Synthetic DB unavailable"); }; },
  };
}
