import { createHash, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient, SyncRun } from "@prisma/client";
import { prisma } from "./prisma";
import { invoiceCalendarDate } from "./invoice-reminder-clock";

export type SyncEntrypoint = "http" | "standalone_cron";
const JOURNAL_PREFIX = "FLEX_GHL_WRITE_JOURNAL_V1:";
const JOURNAL_LIMIT = 1024 * 1024;
const BLOCKED_MESSAGE = "Sync is blocked pending operator review. No later sync or GHL write may resume automatically.";

export class SyncAdmissionError extends Error {
  constructor(public readonly code: "cron_only" | "busy" | "invalid_mode") {
    super(code === "cron_only" ? "Manual and HTTP sync are disabled; the standalone cron owns sync."
      : code === "busy" ? "An existing sync is running or blocked and requires completion or operator review."
      : "Invalid SYNC_ADMISSION_MODE; sync is disabled.");
  }
}
export class SyncWriterBlockedError extends Error {
  constructor() { super(BLOCKED_MESSAGE); }
}
export function assertSyncAdmission(entrypoint: SyncEntrypoint, env = process.env): void {
  const mode = env.SYNC_ADMISSION_MODE ?? "mixed";
  if (mode !== "mixed" && mode !== "cron_only") throw new SyncAdmissionError("invalid_mode");
  if (mode === "cron_only" && entrypoint !== "standalone_cron") throw new SyncAdmissionError("cron_only");
}

// Short transactions only. An acknowledged barrier must be committed before
// external effects; never put HTTP work inside a rollbackable DB transaction.
async function durable<T>(db: PrismaClient, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return db.$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL synchronous_commit = on`;
    return work(tx);
  }, { isolationLevel: "ReadCommitted", maxWait: 2000, timeout: 5000 });
}
export async function admitSyncRun(opts: {
  entrypoint: SyncEntrypoint; triggeredBy?: "manual" | "cron"; full?: boolean;
}, db: PrismaClient = prisma) {
  assertSyncAdmission(opts.entrypoint);
  return durable(db, async tx => {
    // Serializes check-and-create across all NEW-VERSION processes. Old writers
    // must be stopped at cutover. No age-based expiry or automatic recovery.
    const lock = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(1927231041, 1) AS locked`;
    if (!lock[0]?.locked) throw new SyncAdmissionError("busy");
    if (await tx.syncRun.findFirst({ where: { status: { in: ["running", "blocked"] } }, select: { id: true } })) {
      throw new SyncAdmissionError("busy");
    }
    const lastComplete = await tx.syncRun.findFirst({ where: { status: "complete" }, orderBy: { completedAt: "desc" } });
    const lastFull = await tx.syncRun.findFirst({ where: { status: "complete", mode: "full" }, orderBy: { completedAt: "desc" } });
    const doFull = Boolean(opts.full) || !lastComplete || !lastFull?.completedAt || Date.now() - lastFull.completedAt.getTime() > 7 * 86400_000;
    const since = doFull || !lastComplete ? null : new Date(lastComplete.startedAt.getTime() - 86400_000);
    const run = await tx.syncRun.create({ data: { status: "running", triggeredBy: opts.triggeredBy ?? "manual", mode: doFull ? "full" : "incremental" } });
    return { run, since };
  });
}

export interface GhlWriteIntent {
  approvalId?: string;
  pipelineId: string;
  contactId: string;
  opportunityId: string;
  jobberClientId: string;
  expected: { stageId: string; status: "open"; amountCents: number; nameHash: string };
  target: { stageId: string; amountCents: number; nameHash: string; updateName: boolean; status?: "open" };
  source: {
    observedAt: string;
    storedInvoiceIds: string[];
    invoices: Array<{ id: string; jobberClientId: string; invoiceStatus: string;
      totalCents: number; balanceCents: number; issuedDate: string | null; createdAt: string | null; dueDate: string | null }>;
  };
  // Optional exact blank-only date repair. No stage/amount/name side effects.
  // Retained in the same durable journal before the single provider attempt.
  dateField?: { locationId: string; fieldId: string; key: "opportunity.due_date";
    invoiceId: string; expectedValue: "" | null; targetValue: string; sourceFingerprint: string };
}
interface JournalEntry { id: string; state: "pending" | "confirmed"; preparedAt: string; confirmedAt?: string; fingerprint: string; intent: GhlWriteIntent }
interface Journal { version: 1; runId: string; warnings: string | null; writes: JournalEntry[] }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const cardNameHash = (name: string | null | undefined) => hash(JSON.stringify(name ?? null));
const identity = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 512;
const minor = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const digest = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const date = (v: unknown) => v === null || (typeof v === "string" && v.length <= 64 && Number.isFinite(new Date(v).getTime()));
function validateIntent(v: GhlWriteIntent): void {
  if (!v || ![v.pipelineId, v.contactId, v.opportunityId, v.jobberClientId, v.expected?.stageId, v.target?.stageId].every(identity)
      || v.expected?.status !== "open" || !minor(v.expected?.amountCents) || !minor(v.target?.amountCents)
      || !digest(v.expected?.nameHash) || !digest(v.target?.nameHash) || typeof v.target?.updateName !== "boolean"
      || !v.source || typeof v.source.observedAt !== "string" || !date(v.source.observedAt)
      || !Array.isArray(v.source.storedInvoiceIds) || !v.source.storedInvoiceIds.length || !v.source.storedInvoiceIds.every(identity)
      || !Array.isArray(v.source.invoices) || !v.source.invoices.length) throw new SyncWriterBlockedError();
  const ids = new Set<string>();
  for (const i of v.source.invoices) {
    if (!i || !identity(i.id) || ids.has(i.id) || i.jobberClientId !== v.jobberClientId
        || !["paid", "past_due", "awaiting_payment"].includes(i.invoiceStatus)
        || !minor(i.totalCents) || !minor(i.balanceCents) || i.balanceCents > i.totalCents
        || (i.invoiceStatus === "paid" ? i.balanceCents !== 0 : i.balanceCents <= 0)
        || !date(i.issuedDate) || !date(i.createdAt) || !date(i.dueDate)) throw new SyncWriterBlockedError();
    ids.add(i.id);
  }
  if (new Set(v.source.storedInvoiceIds).size !== v.source.storedInvoiceIds.length || v.source.storedInvoiceIds.some(id => !ids.has(id))) throw new SyncWriterBlockedError();
  if (v.dateField !== undefined) {
    const f = v.dateField;
    const source = v.source.invoices.find(i => i.id === f?.invoiceId);
    if (!f || !identity(f.locationId) || !identity(f.fieldId) || f.key !== "opportunity.due_date"
        || !source || !v.source.storedInvoiceIds.includes(f.invoiceId)
        || !["past_due", "awaiting_payment"].includes(source.invoiceStatus) || source.balanceCents <= 0
        || (f.expectedValue !== "" && f.expectedValue !== null) || !digest(f.sourceFingerprint)
        || !/^\d{4}-\d{2}-\d{2}$/.test(f.targetValue) || invoiceCalendarDate(f.targetValue) !== f.targetValue
        || invoiceCalendarDate(source.dueDate) !== f.targetValue
        || v.target.status !== v.expected.status || v.target.stageId !== v.expected.stageId || v.target.amountCents !== v.expected.amountCents
        || v.target.nameHash !== v.expected.nameHash || v.target.updateName) throw new SyncWriterBlockedError();
  }
}
function journal(message: string | null, runId: string): Journal | null {
  if (!message?.startsWith(JOURNAL_PREFIX)) return null;
  try {
    const value = JSON.parse(message.slice(JOURNAL_PREFIX.length)) as Journal;
    if (value.version !== 1 || value.runId !== runId || !(value.warnings === null || typeof value.warnings === "string") || !Array.isArray(value.writes)) throw new Error();
    const ids = new Set<string>();
    for (const entry of value.writes) {
      if (!identity(entry.id) || ids.has(entry.id) || !["pending", "confirmed"].includes(entry.state)
          || typeof entry.preparedAt !== "string" || !date(entry.preparedAt)
          || (entry.state === "confirmed" && (typeof entry.confirmedAt !== "string" || !date(entry.confirmedAt)))) throw new Error();
      validateIntent(entry.intent);
      if (entry.fingerprint !== hash(JSON.stringify(entry.intent))) throw new Error();
      ids.add(entry.id);
    }
    return value;
  } catch { throw new SyncWriterBlockedError(); }
}
function serialize(value: Journal): string {
  const text = JOURNAL_PREFIX + JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > JOURNAL_LIMIT) throw new SyncWriterBlockedError();
  return text;
}
export function publicSyncErrorMessage(message: string | null): string | null {
  // Never return partial or malformed journals, or their private source values.
  if (message?.startsWith(JOURNAL_PREFIX)) return "Private GHL write evidence retained. A running or blocked sync requires operator review before another run.";
  return message;
}
export function publicSyncRun<T extends { errorMessage: string | null }>(run: T): T {
  return { ...run, errorMessage: publicSyncErrorMessage(run.errorMessage) };
}

/** One admitted run owns all mutation attempts. No automatic unlock/recovery. */
export class SyncRunWriter {
  private halted = false;
  constructor(readonly runId: string, private readonly db: PrismaClient = prisma) {}

  async prepare(intent: GhlWriteIntent): Promise<string> {
    try {
      if (this.halted) throw new SyncWriterBlockedError();
      validateIntent(intent);
      const id = randomUUID();
      await durable(this.db, async tx => {
        const run = await tx.syncRun.findUniqueOrThrow({ where: { id: this.runId } });
        if (run.status !== "running") throw new SyncWriterBlockedError();
        const next = journal(run.errorMessage, this.runId) ?? { version: 1 as const, runId: this.runId, warnings: run.errorMessage, writes: [] };
        if (next.writes.some(w => w.state === "pending")) throw new SyncWriterBlockedError();
        // JSON serialization creates an immutable copy before the provider call.
        next.writes.push({ id, state: "pending", preparedAt: new Date().toISOString(), fingerprint: hash(JSON.stringify(intent)), intent });
        const result = await tx.syncRun.updateMany({ where: { id: run.id, status: "running", errorMessage: run.errorMessage }, data: { errorMessage: serialize(next) } });
        if (result.count !== 1) throw new SyncWriterBlockedError();
      });
      return id;
    } catch { await this.block(); throw new SyncWriterBlockedError(); }
  }
  async assertPending(id: string): Promise<void> {
    try {
      if (this.halted) throw new SyncWriterBlockedError();
      const run = await this.db.syncRun.findUniqueOrThrow({ where: { id: this.runId } });
      const entries = journal(run.errorMessage, this.runId)?.writes;
      if (run.status !== "running" || entries?.at(-1)?.id !== id || entries.at(-1)?.state !== "pending") throw new SyncWriterBlockedError();
    } catch { await this.block(); throw new SyncWriterBlockedError(); }
  }
  async confirm(id: string): Promise<void> {
    try {
      if (this.halted) throw new SyncWriterBlockedError();
      await durable(this.db, async tx => {
        const run = await tx.syncRun.findUniqueOrThrow({ where: { id: this.runId } });
        const next = journal(run.errorMessage, this.runId);
        const entry = next?.writes.at(-1);
        if (run.status !== "running" || !next || entry?.id !== id || entry.state !== "pending") throw new SyncWriterBlockedError();
        entry.state = "confirmed"; entry.confirmedAt = new Date().toISOString();
        const result = await tx.syncRun.updateMany({ where: { id: run.id, status: "running", errorMessage: run.errorMessage }, data: { errorMessage: serialize(next) } });
        if (result.count !== 1) throw new SyncWriterBlockedError();
      });
    } catch { await this.block(); throw new SyncWriterBlockedError(); }
  }
  async block(): Promise<void> {
    this.halted = true;
    // Best effort to make the hold obvious. Failure leaves the original running
    // row and pending journal in place, which is itself a non-expiring barrier.
    try {
      await durable(this.db, tx => tx.syncRun.updateMany({ where: { id: this.runId, status: "running" }, data: { status: "blocked" } }));
    } catch { /* Never clear or replace the durable intent. */ }
  }
  async finish(status: "complete" | "failed", failure?: string): Promise<SyncRun> {
    try {
      const result = await durable(this.db, async tx => {
        const run = await tx.syncRun.findUniqueOrThrow({ where: { id: this.runId } });
        if (run.status === "blocked") throw new SyncWriterBlockedError();
        if (run.status !== "running") throw new SyncWriterBlockedError();
        const saved = journal(run.errorMessage, this.runId);
        if (this.halted || saved?.writes.some(w => w.state === "pending")) throw new SyncWriterBlockedError();
        const changed = await tx.syncRun.updateMany({ where: { id: run.id, status: "running", errorMessage: run.errorMessage }, data: {
          status, completedAt: new Date(),
          // All immutable evidence survives completion and generic error paths.
          ...(!saved && status === "failed" ? { errorMessage: failure ?? "Sync failed" } : {}),
        } });
        if (changed.count !== 1) throw new SyncWriterBlockedError();
        return tx.syncRun.findUniqueOrThrow({ where: { id: run.id } });
      });
      return publicSyncRun(result);
    } catch { await this.block(); throw new SyncWriterBlockedError(); }
  }
}
