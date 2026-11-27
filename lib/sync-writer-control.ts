import type { BootstrapClaim, BootstrapPhase } from "./ghl-existing-overdue-bootstrap";
import { createHash, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient, SyncRun } from "@prisma/client";
import { prisma } from "./prisma";
import { invoiceCalendarDate } from "./invoice-reminder-clock";
import { staleRunVerdict, STALE_RUN_MIN_AGE_MS } from "./sync-stale-recovery";

export type SyncEntrypoint = "http" | "standalone_cron";
const JOURNAL_PREFIX = "FLEX_GHL_WRITE_JOURNAL_V1:";
const JOURNAL_LIMIT = 1024 * 1024;
/**
 * How old and how quiet a `running` row must be before it is presumed dead.
 * Overridable with SYNC_STALE_RUN_MINUTES for an operator who needs it tighter
 * or looser; a value that is not a positive number falls back to the default
 * rather than disabling the guard.
 */
/**
 * The newest `lastSyncedAt` the sync has stamped on an invoice: the progress
 * signal that tells a slow run apart from a dead one.
 *
 * A failure here is reported as unknown rather than thrown. Admission must end
 * in a clean refusal or a clean start, never in a raw database error - and an
 * unreadable signal refuses, so the fallback is the safe one either way.
 */
async function readRowProgress(
  tx: unknown,
): Promise<{ lastRowProgressAt: Date | null; progressUnknown: boolean }> {
  // Structural, not Prisma-typed: the same gate runs against the test fake,
  // whose transaction client carries only the models those tests need.
  const model = (tx as { invoiceRecord?: { aggregate?: (a: unknown) => Promise<unknown> } })?.invoiceRecord;
  if (typeof model?.aggregate !== "function") return { lastRowProgressAt: null, progressUnknown: true };
  try {
    const r = (await model.aggregate({ _max: { lastSyncedAt: true } })) as
      { _max?: { lastSyncedAt?: Date | null } } | null;
    const at = r?._max?.lastSyncedAt;
    return { lastRowProgressAt: at instanceof Date ? at : null, progressUnknown: false };
  } catch {
    return { lastRowProgressAt: null, progressUnknown: true };
  }
}

export function staleRunThresholdMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.SYNC_STALE_RUN_MINUTES);
  return Number.isFinite(raw) && raw > 0 ? raw * 60_000 : STALE_RUN_MIN_AGE_MS;
}
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

/**
 * A write this writer REFUSED TO START. Nothing was journaled and nothing was
 * sent to the provider, so there is no outcome to be uncertain about and no
 * card that could be duplicated by a later run.
 *
 * This is deliberately a different class from `SyncWriterBlockedError`, and the
 * difference is the whole point. A block means "a write may have left this
 * process and I cannot prove what happened to it", which must stop every later
 * sync until a person looks. A refusal means "this intent is not well-formed,
 * so I did not attempt it" - one card held, the run carries on.
 *
 * Before this existed, `prepare()` funnelled both into a block. On 2026-11-27
 * one malformed intent (invoice #6830: Jobber's `paid` label with $60 still
 * owing, which the journal validator refuses) halted every remaining card write
 * and blocked the hourly sync permanently. Nothing had been sent.
 *
 * ONLY pre-flight validation raises this. A duplicate-claim assertion, a
 * pending write already in the journal, a lost update race and any provider
 * call all still raise `SyncWriterBlockedError`, because any of those can mean
 * a real write is in flight.
 */
export class SyncWriterRefusedError extends Error {
  /** A short machine reason, safe to log. Never a customer detail. */
  readonly reason: string;
  constructor(reason: string) {
    super(`GHL write intent refused before anything was sent: ${reason}`);
    this.reason = reason;
  }
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
    // must be stopped at cutover. A demonstrably dead `running` row IS now
    // recovered automatically, under the guards below; nothing else is.
    const lock = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(1927231041, 1) AS locked`;
    if (!lock[0]?.locked) throw new SyncAdmissionError("busy");

    // A row left `running` or `blocked` still refuses a new sync. What is new
    // is that a `running` row which is DEMONSTRABLY dead no longer refuses it
    // forever: it is abandoned here, under the guards in sync-stale-recovery.ts,
    // and only then does this run proceed. Everything else - above all a
    // pending write journal, and any `blocked` row - refuses exactly as before,
    // and now says out loud why.
    //
    // This runs inside the advisory lock, so two processes cannot both decide a
    // row is dead, and the write is conditional on the status not having moved.
    const blocker = await tx.syncRun.findFirst({
      where: { status: { in: ["running", "blocked"] } },
      orderBy: { startedAt: "desc" },
    });
    if (blocker) {
      // `journal()` THROWS SyncWriterBlockedError on anything it cannot
      // validate. Admission used not to parse the journal at all, so letting
      // that escape here would change a plain "busy" into a blocked-for-review
      // error for a row that is not blocked. Instead a journal we cannot read
      // counts as one pending write: recovery refuses, loudly, and the error
      // stays the one callers already handle.
      let parsed: Journal | null = null;
      let journalUnreadable = false;
      const journalPresent = typeof blocker.errorMessage === "string"
        && blocker.errorMessage.startsWith(JOURNAL_PREFIX);
      if (journalPresent) {
        try { parsed = journal(blocker.errorMessage, blocker.id); }
        catch { journalUnreadable = true; }
      }
      const verdict = staleRunVerdict({
        status: blocker.status,
        startedAt: blocker.startedAt,
        opportunitiesSynced: blocker.ghlOpportunitiesSynced,
        journal: {
          present: journalPresent,
          // An unreadable journal counts as one pending write, not none: a
          // journal we cannot read is not evidence that nothing is in flight.
          pendingWrites: journalUnreadable
            ? 1
            : (parsed?.writes.filter(w => w.state === "pending").length ?? 0),
        },
        ...(await readRowProgress(tx)),
        now: new Date(),
        minAgeMs: staleRunThresholdMs(),
      });

      if (!verdict.recover) {
        // Loudly, every time. A refusal that says nothing is how five hours of
        // hourly syncs went missing without anyone noticing.
        console.error(`[sync] REFUSING TO START. A ${blocker.status} run from`
          + ` ${blocker.startedAt.toISOString()} (id ${blocker.id}) is in the way.`
          + ` Reason: ${verdict.reason}. ${verdict.detail}.`);
        throw new SyncAdmissionError("busy");
      }

      // A settled journal is write evidence and is left exactly as it is;
      // `cycleHistory()` reads it back out of this column. Only a row with no
      // journal has its errorMessage written to.
      const cleared = await tx.syncRun.updateMany({
        where: { id: blocker.id, status: "running" },
        data: verdict.preserveJournal
          ? { status: "abandoned", completedAt: new Date() }
          : { status: "abandoned", completedAt: new Date(), errorMessage: verdict.note },
      });
      if (cleared.count !== 1) throw new SyncAdmissionError("busy");
      console.warn(`[sync] abandoned a dead run to resume hourly syncing:`
        + ` id ${blocker.id}, started ${blocker.startedAt.toISOString()}.`
        + ` ${verdict.note}${verdict.preserveJournal ? " Its write journal was left untouched." : ""}`);
    }
    const lastComplete = await tx.syncRun.findFirst({ where: { status: "complete" }, orderBy: { completedAt: "desc" } });
    const lastFull = await tx.syncRun.findFirst({ where: { status: "complete", mode: "full" }, orderBy: { completedAt: "desc" } });
    const doFull = Boolean(opts.full) || !lastComplete || !lastFull?.completedAt || Date.now() - lastFull.completedAt.getTime() > 7 * 86400_000;
    const since = doFull || !lastComplete ? null : new Date(lastComplete.startedAt.getTime() - 86400_000);
    const run = await tx.syncRun.create({ data: { status: "running", triggeredBy: opts.triggeredBy ?? "manual", mode: doFull ? "full" : "incremental" } });
    return { run, since };
  });
}

export type PaidDateWitness = { version: 1; fieldId: string; ownedValue: string; observedAt: string;
  priorOwnershipJournalId: string; otherFieldsSha256: string };
export type PaidDateReadback = { fieldId: string; value: string | null; observedAt: string; otherFieldsSha256: string };
export type InvoiceCycleClaim = {
  version: 1; locationId: string; workflowId: string; invoiceId: string; dueOn: string;
  phase: "enroll" | "paid" | "reset_date" | "reset_stage";
  predecessorInvoiceId?: string;
  paidDateWitness?: PaidDateWitness;
  cleanup?: { contractSha256: string; observedAt: string; evidenceRef: string;
    oldEnrollmentJournalId: string; oldPaidJournalId: string; orderedClearAcknowledged: boolean; removalJournalId?: string };
};
export type WorkflowRemovalIntent = {
  version: 1; locationId: string; workflowId: string; invoiceId: string;
  oldOwnershipJournalId: string; oldPaidJournalId?: string; contractSha256: string;
  purpose?: "paid_cycle_cancellation";
  ownedDateWitness?: { fieldId: string; value: string; observedAt: string };
  apiVersion: "v3";
};
export type WorkflowRemovalAcknowledgment = { version: 1; httpStatus: 200; succeeded: true; observedAt: string };
/**
 * A card that does not exist yet, claimed BEFORE the POST that creates it.
 *
 * An update can name the card it is about; a creation cannot, so without a
 * durable claim a POST that times out is invisible: the next run cannot tell
 * "never created" from "created, then we lost the answer", and the difference
 * is a duplicate card on a customer's board. The claim names the INVOICE
 * instead, which exists before the card does and never changes.
 *
 * `stageRole: "sent"` is a literal, not a stage id, and that is the point: no
 * durable record of a creation can ever authorize one into any other stage, so
 * a card can never be created straight into "Invoice Overdue" - the transition
 * the legacy Fixed Automation workflow triggers on. A wrong id would be caught
 * by review; a wrong ROLE cannot be written down at all.
 */
export type InvoiceCardCreationClaim = {
  version: 1;
  stageRole: "sent";
  locationId: string;
  pipelineId: string;
  stageId: string;
  contactId: string;
  jobberClientId: string;
  invoiceId: string;
  invoiceNumber: string;
  /** sha256 of the exact name to be POSTed, so the name is evidence too. */
  nameHash: string;
  amountCents: number;
  /** The invoice's own facts, hashed; an edited invoice cannot reuse this claim. */
  sourceFingerprint: string;
};

/**
 * The `opportunityId` a creation intent carries. Deliberately not id-shaped and
 * deliberately derived from the invoice: it reads as what it is, it cannot
 * collide with a GoHighLevel id, and it is the same string on a retry, which is
 * what makes a duplicate claim detectable.
 */
export const creationPlaceholderId = (invoiceId: string) => `pending-creation:${invoiceId}`;

/** The invoice facts a creation claim is bound to. Computed, never trusted. */
export const invoiceSourceFingerprint = (i: { id: string; invoiceStatus: string; totalCents: number;
  balanceCents: number; issuedDate: string | null; dueDate: string | null }) =>
  hash(JSON.stringify([1, i.id, i.invoiceStatus, i.totalCents, i.balanceCents, i.issuedDate, i.dueDate]));

export type BootstrapJournalClaim = { claim: BootstrapClaim; claimSha256: string;
  phase: "claim" | BootstrapPhase; claimId?: string };
export interface GhlWriteIntent {
  creation?: InvoiceCardCreationClaim;
  bootstrap?: BootstrapJournalClaim;
  workflowRemoval?: WorkflowRemovalIntent;
  cycle?: InvoiceCycleClaim;
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
    invoiceId: string; expectedValue: string | null; targetValue: string; sourceFingerprint: string };
}
/**
 * Why a claim was released without the write having landed.
 *
 * `evidence` is the provider observation that PROVED nothing landed - not a
 * guess, not a timeout, not "the request failed". A claim may only be abandoned
 * when the provider has been read back successfully and plainly does not show
 * the write. Anything else is still unknown, and unknown still blocks.
 */
export type WriteAbandonment = { version: 1; reason: string; evidence: string; observedAt: string };
export interface JournalEntry { id: string; state: "pending" | "confirmed" | "abandoned"; preparedAt: string; confirmedAt?: string; abandonedAt?: string; abandonment?: WriteAbandonment; fingerprint: string; intent: GhlWriteIntent; paidDateReadback?: PaidDateReadback; removalAcknowledgment?: WorkflowRemovalAcknowledgment }
/**
 * ONE card the run decided not to write, in plain language, for a person to
 * read on the dashboard. Deliberately NOT write evidence: a skip means nothing
 * was attempted, so none of the journal's integrity rules apply to it, and it
 * carries no opportunity, contact or location id.
 */
export type SyncRunSkip = Readonly<{
  /** The human invoice number, e.g. "6830". */
  invoiceNumber: string | null;
  /** The customer as the dashboard already names them elsewhere. */
  customer: string | null;
  /** A whole sentence, written for Garrison, not a machine code. */
  reason: string;
}>;

/** Why this run blocked, in plain language, so the row that stops the hourly
 * sync explains itself without a log dig. */
export type SyncRunBlockNote = Readonly<{
  invoiceNumber: string | null;
  customer: string | null;
  /** Which part of the run it stopped in, e.g. "writing the invoice card". */
  step: string;
  reason: string;
  /** True only when a write was already in flight, which keeps it human-only. */
  pendingWrite: boolean;
  at: string;
}>;

export const SKIP_LIMIT = 200;
const SKIP_TEXT_LIMIT = 400;

interface Journal {
  version: 1; runId: string; warnings: string | null; writes: JournalEntry[];
  /** Cards held this run. Additive and optional: an older journal has none. */
  skips?: SyncRunSkip[];
  /** Set once, when the run blocks. */
  block?: SyncRunBlockNote;
}

function text(value: unknown, limit = SKIP_TEXT_LIMIT): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= limit ? value.trim() : null;
}

/**
 * Validates the plain-language parts of an envelope. Deliberately lenient in
 * one direction only: anything it cannot read is DROPPED, never thrown on. A
 * malformed skip note must not make a journal unparseable, because the journal
 * is the write evidence and losing it is far worse than losing a sentence.
 */
function readNotes(value: Journal): { skips: SyncRunSkip[]; block: SyncRunBlockNote | null } {
  const skips: SyncRunSkip[] = [];
  if (Array.isArray(value.skips)) {
    for (const s of value.skips.slice(0, SKIP_LIMIT)) {
      const reason = text(s?.reason);
      if (reason) skips.push(Object.freeze({
        invoiceNumber: text(s?.invoiceNumber, 32), customer: text(s?.customer, 200), reason }));
    }
  }
  const b = value.block;
  const blockReason = text(b?.reason), step = text(b?.step, 120);
  const block = blockReason && step ? Object.freeze({
    invoiceNumber: text(b?.invoiceNumber, 32), customer: text(b?.customer, 200),
    step, reason: blockReason, pendingWrite: b?.pendingWrite === true,
    at: text(b?.at, 64) ?? new Date(0).toISOString(),
  }) : null;
  return { skips, block };
}

/**
 * The plain-language diagnostics for one run: why each card was skipped and, if
 * it blocked, what stopped it. Pure, and safe to render on an AUTHENTICATED
 * page. It is not used by `publicSyncErrorMessage`, because that feeds an
 * unauthenticated status endpoint and these notes name customers.
 */
export function syncRunDiagnostics(message: string | null, runId: string): {
  skips: SyncRunSkip[]; block: SyncRunBlockNote | null;
} {
  if (!message?.startsWith(JOURNAL_PREFIX)) return { skips: [], block: null };
  try {
    const value = JSON.parse(message.slice(JOURNAL_PREFIX.length)) as Journal;
    if (value.version !== 1 || value.runId !== runId) return { skips: [], block: null };
    return readNotes(value);
  } catch { return { skips: [], block: null }; }
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const cardNameHash = (name: string | null | undefined) => hash(JSON.stringify(name ?? null));
const identity = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 512;
const minor = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const digest = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const date = (v: unknown) => v === null || (typeof v === "string" && v.length <= 64 && Number.isFinite(new Date(v).getTime()));
function validBootstrapEnrollmentReview(c: BootstrapClaim, issuedDate: string | null): boolean {
  const h=c.enrollmentHistory;
  if(h?.kind==="no_prior")return true;
  if(h?.kind!=="retired_reviewed" || ![h.retirementEvidenceRef,h.historyEvidenceRef].every(identity)
    || h.historySinceIssuedOn!==invoiceCalendarDate(issuedDate) || h.completeContactHistorySinceIssue!==true
    || h.allRetainedFixedExecutionsForContactRetired!==true || h.noAmbiguousRelevantActions!==true || h.noActiveRetainedExecution!==true
    || !Array.isArray(h.retiredExecutionIds) || !h.retiredExecutionIds.length || h.retiredExecutionIds.length>500
    || !h.retiredExecutionIds.every(identity) || new Set(h.retiredExecutionIds).size!==h.retiredExecutionIds.length
    || !Array.isArray(h.milestones))return false;
  const days=c.category==="maintenance"?[10,15,20,21,25,30]:[10,15,21];
  return h.milestones.length===days.length && days.every(d=>h.milestones.filter(m=>m.dayPastDue===d
    && m.audience===(d===21?"internal":"homeowner") && ["none","attempted"].includes(m.priorAttempt)).length===1);
}
function validateIntent(v: GhlWriteIntent): void {
  if (!v || ![v.pipelineId, v.contactId, v.opportunityId, v.jobberClientId, v.expected?.stageId, v.target?.stageId].every(identity)
      || v.expected?.status !== "open" || !minor(v.expected?.amountCents) || !minor(v.target?.amountCents)
      || !digest(v.expected?.nameHash) || !digest(v.target?.nameHash) || typeof v.target?.updateName !== "boolean"
      || !v.source || typeof v.source.observedAt !== "string" || !date(v.source.observedAt)
      || !Array.isArray(v.source.storedInvoiceIds) || !v.source.storedInvoiceIds.length || !v.source.storedInvoiceIds.every(identity)
      || !Array.isArray(v.source.invoices) || !v.source.invoices.length) throw new SyncWriterBlockedError();
  // THE SOURCE INVOICES ARE A REFUSAL, NOT A BLOCK, and the distinction is
  // narrow on purpose.
  //
  // Everything else in this function checks that the intent AGREES WITH ITS OWN
  // CLAIM - that nobody has edited a stage, an amount, a name or a date into a
  // write the journal never authorized. A failure there is tampering or a
  // serious bug, and stopping every later sync is the right answer.
  //
  // This loop checks something different: whether the invoice data READ FROM
  // JOBBER hangs together. Jobber can and does return an incoherent invoice -
  // `paid` with money still owing is the everyday example - and that is not
  // evidence of anything wrong with this system. It is one card we cannot act
  // on, so it is refused before anything is journaled or sent, and the run
  // carries on. Blocking on it cost every hourly sync on 2026-11-27.
  const ids = new Set<string>();
  for (const i of v.source.invoices) {
    if (!i || !identity(i.id) || ids.has(i.id) || i.jobberClientId !== v.jobberClientId
        || !["paid", "past_due", "awaiting_payment"].includes(i.invoiceStatus)
        || !minor(i.totalCents) || !minor(i.balanceCents) || i.balanceCents > i.totalCents
        || (i.invoiceStatus === "paid" ? i.balanceCents !== 0 : i.balanceCents <= 0)
        || !date(i.issuedDate) || !date(i.createdAt) || !date(i.dueDate)) {
      throw new SyncWriterRefusedError("source_invoice_amounts_or_status_incoherent");
    }
    ids.add(i.id);
  }
  if (new Set(v.source.storedInvoiceIds).size !== v.source.storedInvoiceIds.length || v.source.storedInvoiceIds.some(id => !ids.has(id))) throw new SyncWriterBlockedError();
  if (v.creation) {
    // A creation adds a card; it never carries an enrollment, a workflow
    // removal or a date repair, and every field of the claim must agree with
    // the intent it travels in. `expected` describes nothing - no stage move,
    // no money, no name - because there is nothing there yet.
    const c = v.creation, i = v.source.invoices.find(i => i.id === c?.invoiceId);
    if (c.version !== 1 || c.stageRole !== "sent"
        || ![c.locationId, c.pipelineId, c.stageId, c.contactId, c.jobberClientId, c.invoiceId, c.invoiceNumber].every(identity)
        || !digest(c.nameHash) || !digest(c.sourceFingerprint) || !minor(c.amountCents) || c.amountCents <= 0
        || c.pipelineId !== v.pipelineId || c.contactId !== v.contactId || c.jobberClientId !== v.jobberClientId
        || !identity(v.approvalId)
        || v.opportunityId !== creationPlaceholderId(c.invoiceId)
        || v.cycle || v.bootstrap || v.workflowRemoval || v.dateField
        // The invoice must be in the verified source snapshot, must still be
        // unpaid, and must still owe exactly what the claim says it owes.
        || !i || v.source.storedInvoiceIds.length !== 1 || v.source.storedInvoiceIds[0] !== c.invoiceId
        || i.invoiceStatus === "paid" || i.balanceCents <= 0 || i.balanceCents !== c.amountCents
        || invoiceSourceFingerprint(i) !== c.sourceFingerprint
        // Nothing existed before: no stage to leave, no money, no name.
        || v.expected.amountCents !== 0 || v.expected.nameHash !== cardNameHash(null) || v.expected.stageId !== c.stageId
        || v.target.stageId !== c.stageId || v.target.amountCents !== c.amountCents
        || v.target.nameHash !== c.nameHash || !v.target.updateName) throw new SyncWriterBlockedError();
  }
  if (v.bootstrap) {
    const b=v.bootstrap,c=b.claim,i=v.source.invoices.find(i=>i.id===c?.scope?.invoiceId);
    if (!c || c.version!==1 || !c.scope || !Object.values(c.scope).every(identity)
      || ![c.sentStageId,c.overdueStageId,c.approvalId,c.reviewRef,c.categoryReviewRef].every(identity)
      || c.sentStageId===c.overdueStageId || !["maintenance","irrigation"].includes(c.category)
      || !digest(c.policySha256) || !digest(c.sourceFingerprint) || !digest(c.cycleKey)
      || c.cycleKey!==hash(JSON.stringify([1,c.scope.locationId,c.scope.workflowId,c.scope.jobberClientId,c.scope.invoiceId]))
      || b.claimSha256!==hash(JSON.stringify(c)) || typeof c.expiresAt!=="string" || !date(c.expiresAt)
      || !["short_lived_v1","historical_review_v1"].includes(c.clearanceMode)
      || !["claim","bootstrap_stage","source_date","enroll_stage"].includes(b.phase)
      || (b.phase==="claim" ? b.claimId!==undefined : !identity(b.claimId))
      || c.scope.opportunityId!==v.opportunityId || c.scope.contactId!==v.contactId
      || c.scope.pipelineId!==v.pipelineId || c.scope.jobberClientId!==v.jobberClientId || c.approvalId!==v.approvalId
      || !i || !validBootstrapEnrollmentReview(c,i.issuedDate) || i.invoiceStatus==="paid" || invoiceCalendarDate(i.dueDate)!==c.dueOn
      || v.source.invoices.filter(i=>i.invoiceStatus!=="paid").length!==1
      || v.expected.amountCents!==i.balanceCents || v.target.amountCents!==i.balanceCents
      || v.expected.nameHash!==v.target.nameHash || v.target.updateName || v.workflowRemoval
      || v.expected.stageId!==(["claim","bootstrap_stage"].includes(b.phase)?c.overdueStageId:c.sentStageId)
      || v.target.stageId!==(["claim","enroll_stage"].includes(b.phase)?c.overdueStageId:c.sentStageId)
      || (b.phase==="source_date" ? !v.dateField || v.dateField.sourceFingerprint!==c.sourceFingerprint
        : !!v.dateField)
      || (b.phase==="enroll_stage" ? v.cycle?.phase!=="enroll" || v.cycle.invoiceId!==c.scope.invoiceId
        || v.cycle.locationId!==c.scope.locationId || v.cycle.workflowId!==c.scope.workflowId || v.cycle.dueOn!==c.dueOn
        : !!v.cycle)) throw new SyncWriterBlockedError();
  }
  if (v.workflowRemoval) {
    const r = v.workflowRemoval, old = v.source.invoices.find(i => i.id === r.invoiceId);
    if (r.version !== 1 || r.apiVersion !== "v3"
        || ![r.locationId,r.workflowId,r.invoiceId,r.oldOwnershipJournalId].every(identity)
        || !digest(r.contractSha256) || !identity(v.approvalId) || v.cycle || v.dateField
        || !old || old.invoiceStatus !== "paid" || old.balanceCents !== 0
        || (r.purpose === "paid_cycle_cancellation"
          ? r.oldPaidJournalId !== undefined || !r.ownedDateWitness || !identity(r.ownedDateWitness.fieldId)
            || invoiceCalendarDate(r.ownedDateWitness.value)!==r.ownedDateWitness.value
            || typeof r.ownedDateWitness.observedAt!=="string" || !date(r.ownedDateWitness.observedAt)
          : r.purpose !== undefined || !identity(r.oldPaidJournalId) || r.ownedDateWitness!==undefined || v.expected.amountCents!==0)
        || v.target.amountCents !== v.expected.amountCents
        || v.expected.stageId !== v.target.stageId || v.expected.nameHash !== v.target.nameHash
        || v.target.updateName) throw new SyncWriterBlockedError();
  }
  if (v.cycle) {
    const c = v.cycle, source = v.source.invoices.find(i => i.id === c.invoiceId);
    if (c.version !== 1 || ![c.locationId,c.workflowId,c.invoiceId].every(identity)
        || !source || !v.source.storedInvoiceIds.includes(c.invoiceId)
        || invoiceCalendarDate(c.dueOn) !== c.dueOn || (c.phase !== "paid" && invoiceCalendarDate(source.dueDate) !== c.dueOn)
        || !["enroll","paid","reset_date","reset_stage"].includes(c.phase)
        || (c.predecessorInvoiceId !== undefined && (!identity(c.predecessorInvoiceId) || c.predecessorInvoiceId === c.invoiceId))
        || (c.phase.startsWith("reset_") && !c.predecessorInvoiceId)
        || (c.phase === "paid" ? source.invoiceStatus !== "paid" || source.balanceCents !== 0 || v.target.amountCents !== 0
          : source.invoiceStatus === "paid" || source.balanceCents <= 0)
        || (c.phase === "reset_date" ? !v.dateField : !!v.dateField)
        || (["enroll","reset_stage"].includes(c.phase) && (v.expected.stageId === v.target.stageId || v.target.amountCents !== source.balanceCents)))
      throw new SyncWriterBlockedError();
  }
  const witness = v.cycle?.paidDateWitness;
  if (witness && (v.cycle?.phase !== "paid" || witness.version !== 1 || !identity(witness.fieldId)
      || !identity(witness.priorOwnershipJournalId) || witness.ownedValue !== v.cycle.dueOn
      || typeof witness.observedAt !== "string" || !date(witness.observedAt) || !digest(witness.otherFieldsSha256))) throw new SyncWriterBlockedError();
  if (v.dateField !== undefined) {
    const f = v.dateField;
    const source = v.source.invoices.find(i => i.id === f?.invoiceId);
    if (!f || !identity(f.locationId) || !identity(f.fieldId) || f.key !== "opportunity.due_date"
        || !source || !v.source.storedInvoiceIds.includes(f.invoiceId)
        || !["past_due", "awaiting_payment"].includes(source.invoiceStatus) || source.balanceCents <= 0
        || (f.expectedValue !== "" && f.expectedValue !== null
          && !(v.cycle?.phase === "reset_date" && invoiceCalendarDate(f.expectedValue) === f.expectedValue)) || !digest(f.sourceFingerprint)
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
      if (!identity(entry.id) || ids.has(entry.id) || !["pending", "confirmed", "abandoned"].includes(entry.state)
          || typeof entry.preparedAt !== "string" || !date(entry.preparedAt)
          || (entry.state === "confirmed" && (typeof entry.confirmedAt !== "string" || !date(entry.confirmedAt)))) throw new Error();
      // An abandoned claim must carry the observation that released it, and a
      // claim in any other state must carry none. Without that, "abandoned"
      // would be a way to make an unexplained write disappear.
      if (entry.state === "abandoned") {
        const a = entry.abandonment;
        if (typeof entry.abandonedAt !== "string" || !date(entry.abandonedAt) || !a || a.version !== 1
            || !identity(a.reason) || !identity(a.evidence) || !date(a.observedAt)
            || Date.parse(a.observedAt) < Date.parse(entry.preparedAt)) throw new Error();
      } else if (entry.abandonedAt !== undefined || entry.abandonment !== undefined) throw new Error();
      validateIntent(entry.intent);
      if (entry.removalAcknowledgment) validateRemovalAcknowledgment(entry.intent, entry.removalAcknowledgment);
      if (entry.intent.workflowRemoval && (entry.state === "confirmed") !== !!entry.removalAcknowledgment) throw new Error();
      if (entry.paidDateReadback) validatePaidDateReadback(entry.intent, entry.paidDateReadback);
      if (entry.fingerprint !== hash(JSON.stringify(entry.intent))) throw new Error();
      ids.add(entry.id);
    }
    return value;
  } catch { throw new SyncWriterBlockedError(); }
}
export type CycleJournalEntry = JournalEntry & { runId: string };
/** A confirmed reset owns its new invoice even if payment arrives before that
 * invoice ever enrolls. Ownership does not assert workflow enrollment. */
export function latestCycleOwner(history: CycleJournalEntry[], scope: { locationId: string; pipelineId: string;
  opportunityId: string; contactId: string; jobberClientId: string; workflowId?: string }): CycleJournalEntry | undefined {
  return history.filter(w => w.state === "confirmed" && w.intent.cycle
    && ["enroll","reset_stage"].includes(w.intent.cycle.phase) && w.intent.cycle.locationId === scope.locationId
    && (!scope.workflowId || w.intent.cycle.workflowId === scope.workflowId) && w.intent.pipelineId === scope.pipelineId
    && w.intent.opportunityId === scope.opportunityId && w.intent.contactId === scope.contactId && w.intent.jobberClientId === scope.jobberClientId).at(-1);
}
async function cycleHistory(db: Pick<Prisma.TransactionClient, "syncRun">): Promise<CycleJournalEntry[]> {
  // No truncating limit: missing old ownership must never authorize another send.
  const rows = await db.syncRun.findMany({ where: { errorMessage: { startsWith: JOURNAL_PREFIX } },
    select: { id: true, errorMessage: true }, orderBy: [{ startedAt: "asc" }, { id: "asc" }] });
  return rows.flatMap(row => (journal(row.errorMessage, row.id)?.writes ?? []).map(w => ({ ...w, runId: row.id })));
}
/**
 * Has this invoice's card already been claimed, in ANY run?
 *
 * A pending claim counts as loudly as a confirmed one. Pending means a POST was
 * started and never answered, so the card may well exist; treating that as "no
 * card yet" is exactly how a customer ends up with two.
 *
 * An ABANDONED claim is the one exception, and the only reason that state
 * exists. It is not "a POST we gave up on": it is a POST that a successful
 * read-back of the provider proved did not land, recorded with that
 * observation. The card provably does not exist, so the invoice is unclaimed
 * and the next run may create it. Nothing else in this module treats an
 * abandoned entry as either pending or confirmed, which is deliberate - it
 * neither blocks a later run nor authorizes anything.
 */
export function invoiceCardCreationClaimed(history: CycleJournalEntry[],
  scope: { locationId: string; pipelineId: string; invoiceId: string }): CycleJournalEntry | null {
  return history.find(w => w.state !== "abandoned" && w.intent.creation
    && w.intent.creation.locationId === scope.locationId
    && w.intent.creation.pipelineId === scope.pipelineId
    && w.intent.creation.invoiceId === scope.invoiceId) ?? null;
}
function assertCreationHistory(intent: GhlWriteIntent, history: CycleJournalEntry[]): void {
  const c = intent.creation; if (!c) return;
  if (invoiceCardCreationClaimed(history, c)) throw new SyncWriterBlockedError();
}
function assertCycleHistory(intent: GhlWriteIntent, history: CycleJournalEntry[]): void {
  const c = intent.cycle; if (!c) return;
  if(c.phase==="enroll" && history.some(w=>w.intent.bootstrap?.claim.scope.locationId===c.locationId
    && w.intent.bootstrap.claim.scope.workflowId===c.workflowId && w.intent.bootstrap.claim.scope.invoiceId===c.invoiceId
    && w.intent.bootstrap.claim.scope.jobberClientId===intent.jobberClientId
    && (!intent.bootstrap || intent.bootstrap.phase!=="enroll_stage"
      || (w.id!==intent.bootstrap.claimId && w.intent.bootstrap.claimId!==intent.bootstrap.claimId))))throw new SyncWriterBlockedError();
  if (history.some(w => w.state === "pending")) throw new SyncWriterBlockedError();
  const scope = history.filter(w => w.intent.cycle?.locationId === c.locationId && w.intent.cycle.workflowId === c.workflowId
    && w.intent.opportunityId === intent.opportunityId && w.intent.contactId === intent.contactId && w.intent.jobberClientId === intent.jobberClientId);
  // Invoice-ID ownership is stable across date, status and balance changes.
  if (history.some(w => w.intent.cycle?.locationId === c.locationId && w.intent.cycle.workflowId === c.workflowId
      && w.intent.cycle.invoiceId === c.invoiceId && w.intent.jobberClientId === intent.jobberClientId && w.intent.cycle.phase === c.phase))
    throw new SyncWriterBlockedError();
  const confirmed = (phase: InvoiceCycleClaim["phase"], invoiceId: string) => scope.find(w => w.state === "confirmed" && w.intent.cycle?.phase === phase && w.intent.cycle.invoiceId === invoiceId);
  const owner = latestCycleOwner(scope, { ...intent, locationId: c.locationId, workflowId: c.workflowId });
  if (c.phase === "paid" && (!owner || owner.intent.cycle!.invoiceId !== c.invoiceId || owner.intent.cycle!.dueOn !== c.dueOn
      || c.paidDateWitness && c.paidDateWitness.priorOwnershipJournalId !== owner.id)) throw new SyncWriterBlockedError();
  if (c.phase.startsWith("reset_")) {
    const old = owner?.intent.cycle?.invoiceId === c.predecessorInvoiceId ? owner : undefined, paid = confirmed("paid",c.predecessorInvoiceId!);
    if (!old
        || scope.some(w => w.intent.cycle?.phase === "reset_date" && w.intent.cycle.predecessorInvoiceId === c.predecessorInvoiceId
          && w.intent.cycle.invoiceId !== c.invoiceId)) throw new SyncWriterBlockedError();
    const oldSource = intent.source.invoices.find(i => i.id === c.predecessorInvoiceId);
    if (!old || !paid || !paid.intent.cycle?.paidDateWitness || !paid.paidDateReadback
        || paid.intent.cycle.paidDateWitness.priorOwnershipJournalId !== old.id
        || !oldSource || oldSource.invoiceStatus !== "paid" || oldSource.balanceCents !== 0
        || !c.cleanup || !digest(c.cleanup.contractSha256) || !identity(c.cleanup.evidenceRef)
        || typeof c.cleanup.observedAt !== "string" || !date(c.cleanup.observedAt)
        || c.cleanup.oldEnrollmentJournalId !== old.id || c.cleanup.oldPaidJournalId !== paid.id
        || (c.phase === "reset_date" && (intent.dateField?.expectedValue !== old.intent.cycle!.dueOn
          && !(c.cleanup.orderedClearAcknowledged === true && ["",null].includes(intent.dateField?.expectedValue as "" | null))
          || intent.expected.stageId !== paid.intent.target.stageId || intent.expected.amountCents !== 0))) throw new SyncWriterBlockedError();
    if (c.cleanup?.removalJournalId) {
      const removal = history.find(w => w.id === c.cleanup!.removalJournalId);
      const r = removal?.intent.workflowRemoval;
      if (!removal || removal.state !== "confirmed" || !removal.removalAcknowledgment || !r
          || r.oldOwnershipJournalId !== old.id
          || (r.purpose === "paid_cycle_cancellation" ? r.ownedDateWitness?.value!==old.intent.cycle!.dueOn : r.oldPaidJournalId !== paid.id)
          || r.locationId !== c.locationId || r.workflowId !== c.workflowId || r.invoiceId !== c.predecessorInvoiceId
          || r.contractSha256 !== c.cleanup.contractSha256 || c.cleanup.orderedClearAcknowledged
          || c.cleanup.observedAt !== removal.removalAcknowledgment.observedAt
          || removal.intent.opportunityId !== intent.opportunityId || removal.intent.contactId !== intent.contactId
          || removal.intent.jobberClientId !== intent.jobberClientId) throw new SyncWriterBlockedError();
    }
    if (c.phase === "reset_stage" && !confirmed("reset_date",c.invoiceId)) throw new SyncWriterBlockedError();
  }
  if (c.phase === "enroll" && c.predecessorInvoiceId && !confirmed("reset_stage",c.invoiceId)) throw new SyncWriterBlockedError();
}
function assertBootstrapHistory(intent: GhlWriteIntent, history: CycleJournalEntry[]): void {
  const b=intent.bootstrap!,c=b.claim;
  if (Date.parse(c.expiresAt)<=Date.now() || history.some(w=>w.state==="pending")) throw new SyncWriterBlockedError();
  const sameCycle=(w:CycleJournalEntry)=>w.intent.bootstrap?.claim.cycleKey===c.cycleKey
    || w.intent.cycle?.locationId===c.scope.locationId && w.intent.cycle.workflowId===c.scope.workflowId
      && w.intent.jobberClientId===c.scope.jobberClientId && w.intent.cycle.invoiceId===c.scope.invoiceId;
  if(b.phase==="claim"){
    if(history.some(sameCycle))throw new SyncWriterBlockedError();
  }else{
    const claim=history.find(w=>w.id===b.claimId && w.state==="confirmed" && w.intent.bootstrap?.phase==="claim");
    if(!claim || claim.intent.bootstrap?.claimSha256!==b.claimSha256
      || JSON.stringify(claim.intent.source.invoices)!==JSON.stringify(intent.source.invoices)
      || JSON.stringify(claim.intent.source.storedInvoiceIds)!==JSON.stringify(intent.source.storedInvoiceIds)
      || history.some(w=>sameCycle(w) && w.id!==b.claimId && (w.intent.bootstrap?.claimId!==b.claimId
        || w.intent.bootstrap?.claimSha256!==b.claimSha256 || w.intent.bootstrap?.phase===b.phase)))throw new SyncWriterBlockedError();
    const step=(phase:BootstrapPhase)=>history.some(w=>w.state==="confirmed" && w.intent.bootstrap?.claimId===b.claimId && w.intent.bootstrap?.phase===phase);
    if(b.phase!=="bootstrap_stage" && !step("bootstrap_stage"))throw new SyncWriterBlockedError();
    // source_date may be omitted only when the exact current field is already aligned;
    // that observation remains checked immediately before enrollment by the adapter.
  }
}
function assertRemovalHistory(intent: GhlWriteIntent, history: CycleJournalEntry[]): void {
  const r = intent.workflowRemoval!;
  if (history.some(w => w.state === "pending" || w.intent.workflowRemoval?.locationId === r.locationId
      && w.intent.workflowRemoval.workflowId === r.workflowId && w.intent.contactId === intent.contactId
      && w.intent.workflowRemoval.oldOwnershipJournalId === r.oldOwnershipJournalId)) throw new SyncWriterBlockedError();
  const owner = latestCycleOwner(history, {...intent,locationId:r.locationId,workflowId:r.workflowId});
  if (!owner || owner.id !== r.oldOwnershipJournalId || owner.intent.cycle!.invoiceId !== r.invoiceId) throw new SyncWriterBlockedError();
  if (r.purpose === "paid_cycle_cancellation") {
    if (owner.intent.cycle!.phase !== "enroll" || r.ownedDateWitness?.value !== owner.intent.cycle!.dueOn
        || intent.source.invoices.filter(i=>i.invoiceStatus!=="paid").length < 1) throw new SyncWriterBlockedError();
    return;
  }
  const paid = history.find(w => w.id === r.oldPaidJournalId && w.state === "confirmed");
  if (!paid || paid.intent.cycle?.phase !== "paid" || paid.intent.cycle.invoiceId !== r.invoiceId
      || paid.intent.cycle.locationId !== r.locationId || paid.intent.cycle.workflowId !== r.workflowId
      || paid.intent.opportunityId !== intent.opportunityId || paid.intent.contactId !== intent.contactId
      || paid.intent.jobberClientId !== intent.jobberClientId || paid.intent.pipelineId !== intent.pipelineId
      || paid.intent.target.stageId !== intent.expected.stageId || !paid.intent.cycle.paidDateWitness || !paid.paidDateReadback
      || paid.intent.cycle.paidDateWitness.priorOwnershipJournalId !== owner.id
      || intent.source.invoices.some(i => i.id !== r.invoiceId && i.invoiceStatus !== "paid"
        && paid.intent.source.invoices.some(old => old.id === i.id))) throw new SyncWriterBlockedError();
}
function validateRemovalAcknowledgment(intent: GhlWriteIntent, receipt: WorkflowRemovalAcknowledgment): void {
  if (!intent.workflowRemoval || receipt.version !== 1 || receipt.httpStatus !== 200 || receipt.succeeded !== true
      || typeof receipt.observedAt !== "string" || !date(receipt.observedAt)) throw new SyncWriterBlockedError();
}
function validatePaidDateReadback(intent: GhlWriteIntent, receipt: PaidDateReadback): void {
  const w=intent.cycle?.paidDateWitness;
  if(intent.cycle?.phase!=="paid" || !w || receipt.fieldId!==w.fieldId || receipt.otherFieldsSha256!==w.otherFieldsSha256
    || ![w.ownedValue,"",null].includes(receipt.value) || typeof receipt.observedAt!=="string" || !date(receipt.observedAt)
    || Date.parse(receipt.observedAt)<Date.parse(w.observedAt))throw new SyncWriterBlockedError();
}
function serialize(value: Journal): string {
  const text = JOURNAL_PREFIX + JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > JOURNAL_LIMIT) throw new SyncWriterBlockedError();
  return text;
}
export function publicSyncErrorMessage(message: string | null): string | null {
  // Never return partial or malformed journals, or their private source values.
  if (message?.startsWith(JOURNAL_PREFIX)) {
    // This feeds an UNAUTHENTICATED status endpoint, so it reports what
    // happened and how much, never who. Customer names and invoice numbers
    // stay on the authenticated dashboard, via `syncRunDiagnostics`.
    let notes: { skips: SyncRunSkip[]; block: SyncRunBlockNote | null } = { skips: [], block: null };
    let pending = false;
    try {
      const value = JSON.parse(message.slice(JOURNAL_PREFIX.length)) as Journal;
      if (value.version === 1) {
        notes = readNotes(value);
        pending = Array.isArray(value.writes) && value.writes.some(w => w?.state === "pending");
      }
    } catch { /* Fall through to the conservative sentence below. */ }
    if (notes.block) {
      return `Sync blocked while ${notes.block.step}. ${notes.block.pendingWrite
        ? "A GHL write was already in flight, so a person must review it before another sync runs."
        : "Nothing was sent to GoHighLevel. A person must clear it before another sync runs."}`;
    }
    if (!pending && notes.skips.length) {
      return `${notes.skips.length} invoice card${notes.skips.length === 1 ? "" : "s"} held this run. `
        + "See the dashboard for which, and why.";
    }
    return "Private GHL write evidence retained. A running or blocked sync requires operator review before another run.";
  }
  return message;
}
export function publicSyncRun<T extends { errorMessage: string | null }>(run: T): T {
  return { ...run, errorMessage: publicSyncErrorMessage(run.errorMessage) };
}

/** One admitted run owns all mutation attempts. No automatic unlock/recovery. */
export class SyncRunWriter {
  private halted = false;
  /** Cards held this run, in plain language, persisted when the run ends. */
  private readonly skips: SyncRunSkip[] = [];
  constructor(readonly runId: string, private readonly db: PrismaClient = prisma) {}

  /**
   * Merge the plain-language notes into whatever is in `errorMessage` now,
   * without disturbing the write evidence.
   *
   * BEST EFFORT, ALWAYS. Every failure path returns quietly: the caller has
   * already recorded the outcome that matters (a blocked status, a finished
   * run), and losing an explanatory sentence must never turn into losing a
   * journal or failing a run. `writes` is copied through untouched, and the
   * update is conditional on the exact previous value so a concurrent writer
   * cannot be clobbered.
   */
  private async mergeNotes(block: SyncRunBlockNote | null): Promise<void> {
    if (!this.skips.length && !block) return;
    try {
      await durable(this.db, async tx => {
        const run = await tx.syncRun.findUniqueOrThrow({ where: { id: this.runId } });
        let current: Journal;
        try {
          current = journal(run.errorMessage, this.runId)
            ?? { version: 1 as const, runId: this.runId, warnings: run.errorMessage ?? null, writes: [] };
        } catch { return; } // Unreadable journal: leave it exactly as found.
        const existing = readNotes(current);
        const next: Journal = { ...current,
          // `warnings` must be string|null for `journal()` to parse this back.
          warnings: current.warnings ?? null,
          skips: [...existing.skips, ...this.skips].slice(0, SKIP_LIMIT),
          ...(block ?? existing.block ? { block: block ?? existing.block! } : {}) };
        let serialized: string;
        try { serialized = serialize(next); } catch { return; } // Over the size limit.
        await tx.syncRun.updateMany({
          where: { id: this.runId, errorMessage: run.errorMessage }, data: { errorMessage: serialized } });
      });
    } catch { /* Explanations are never worth failing a run over. */ }
  }

  async readCycleHistory(): Promise<CycleJournalEntry[]> { return cycleHistory(this.db); }

  /**
   * Note one card this run decided not to write. In memory only until the run
   * ends, then persisted by `finish()` or `block()`. Never throws: a failure to
   * record a sentence must not affect the run.
   */
  noteSkip(skip: SyncRunSkip): void {
    if (this.skips.length >= SKIP_LIMIT) return;
    const reason = text(skip?.reason);
    if (!reason) return;
    this.skips.push(Object.freeze({
      invoiceNumber: text(skip?.invoiceNumber, 32), customer: text(skip?.customer, 200), reason }));
  }

  async prepare(intent: GhlWriteIntent): Promise<string> {
    // A writer that has already halted cannot be trusted to reason about
    // anything, so this stays a block.
    if (this.halted) { await this.block(); throw new SyncWriterBlockedError(); }
    // PRE-FLIGHT, DELIBERATELY OUTSIDE THE BLOCKING CATCH BELOW.
    //
    // `validateIntent` is pure and runs before the transaction opens, so
    // nothing has been journaled and nothing has been sent either way. But only
    // ONE of its failures is a refusal: incoherent source invoice data, which
    // it raises as `SyncWriterRefusedError`. Everything else it checks is
    // whether the intent agrees with its own claim, and a failure there is a
    // tamper tripwire that must still stop every later sync.
    // No note is written here on purpose. A tampered intent must leave
    // `errorMessage` exactly as it found it - the durable intent is never
    // cleared or replaced - and the caller that knows which invoice and
    // customer this was (the card writer) records the reason straight after.
    try { validateIntent(intent); }
    catch (err) {
      if (err instanceof SyncWriterRefusedError) throw err;
      await this.block();
      throw new SyncWriterBlockedError();
    }
    try {
      const id = randomUUID();
      await durable(this.db, async tx => {
        const run = await tx.syncRun.findUniqueOrThrow({ where: { id: this.runId } });
        if (run.status !== "running") throw new SyncWriterBlockedError();
        if (intent.creation) assertCreationHistory(intent, await cycleHistory(tx));
        if (intent.cycle) assertCycleHistory(intent, await cycleHistory(tx));
        if (intent.workflowRemoval) assertRemovalHistory(intent, await cycleHistory(tx));
        if (intent.bootstrap) assertBootstrapHistory(intent, await cycleHistory(tx));
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
  async confirm(id: string, paidDateReadback?: PaidDateReadback, removalAcknowledgment?: WorkflowRemovalAcknowledgment): Promise<void> {
    try {
      if (this.halted) throw new SyncWriterBlockedError();
      await durable(this.db, async tx => {
        const run = await tx.syncRun.findUniqueOrThrow({ where: { id: this.runId } });
        const next = journal(run.errorMessage, this.runId);
        const entry = next?.writes.at(-1);
        if (run.status !== "running" || !next || entry?.id !== id || entry.state !== "pending") throw new SyncWriterBlockedError();
        if (!!entry.intent.workflowRemoval !== !!removalAcknowledgment) throw new SyncWriterBlockedError();
        if (removalAcknowledgment) {
          validateRemovalAcknowledgment(entry.intent, removalAcknowledgment);
          if (Date.parse(removalAcknowledgment.observedAt) < Date.parse(entry.preparedAt)) throw new SyncWriterBlockedError();
          entry.removalAcknowledgment = structuredClone(removalAcknowledgment);
        }
        if (paidDateReadback) {
          validatePaidDateReadback(entry.intent, paidDateReadback);
          entry.paidDateReadback = structuredClone(paidDateReadback);
        }
        entry.state = "confirmed"; entry.confirmedAt = new Date().toISOString();
        const result = await tx.syncRun.updateMany({ where: { id: run.id, status: "running", errorMessage: run.errorMessage }, data: { errorMessage: serialize(next) } });
        if (result.count !== 1) throw new SyncWriterBlockedError();
      });
    } catch { await this.block(); throw new SyncWriterBlockedError(); }
  }
  /**
   * Release a claim whose write provably did not land, so neither this run nor
   * any later one is wedged by it.
   *
   * The caller must have READ THE PROVIDER BACK SUCCESSFULLY and seen that the
   * write is absent; `abandonment.evidence` records that observation. A failed
   * read, a timeout, or any other "we do not know" must still go to `block`.
   * This method cannot tell the difference, so it is the caller's duty - which
   * is why it is used in exactly two places, both immediately after a
   * successful verification read.
   *
   * The invariants are otherwise identical to `confirm`: the run must still be
   * running, the entry must be the last one, and it must still be pending. On
   * any failure the writer blocks, exactly as before.
   */
  async abandon(id: string, abandonment: Omit<WriteAbandonment, "version">): Promise<void> {
    try {
      if (this.halted) throw new SyncWriterBlockedError();
      await durable(this.db, async tx => {
        const run = await tx.syncRun.findUniqueOrThrow({ where: { id: this.runId } });
        const next = journal(run.errorMessage, this.runId);
        const entry = next?.writes.at(-1);
        if (run.status !== "running" || !next || entry?.id !== id || entry.state !== "pending") throw new SyncWriterBlockedError();
        const record: WriteAbandonment = { version: 1, reason: abandonment.reason,
          evidence: abandonment.evidence, observedAt: abandonment.observedAt };
        if (!identity(record.reason) || !identity(record.evidence) || !date(record.observedAt)
            || Date.parse(record.observedAt) < Date.parse(entry.preparedAt)) throw new SyncWriterBlockedError();
        entry.state = "abandoned"; entry.abandonedAt = new Date().toISOString(); entry.abandonment = record;
        const result = await tx.syncRun.updateMany({ where: { id: run.id, status: "running", errorMessage: run.errorMessage }, data: { errorMessage: serialize(next) } });
        if (result.count !== 1) throw new SyncWriterBlockedError();
      });
    } catch { await this.block(); throw new SyncWriterBlockedError(); }
  }
  /**
   * Hold this run for operator review.
   *
   * `note` is why, in plain language, for the dashboard. The STATUS IS WRITTEN
   * FIRST and the explanation second, so a failure to record the sentence can
   * never cost us the hold itself.
   */
  async block(note?: Omit<SyncRunBlockNote, "at" | "pendingWrite"> & { pendingWrite?: boolean }): Promise<void> {
    this.halted = true;
    // Best effort to make the hold obvious. Failure leaves the original running
    // row and pending journal in place, which is itself a non-expiring barrier.
    try {
      await durable(this.db, tx => tx.syncRun.updateMany({ where: { id: this.runId, status: "running" }, data: { status: "blocked" } }));
    } catch { /* Never clear or replace the durable intent. */ }
    // A block with a write already in flight stays human-only to clear, and
    // says so on the row itself.
    let pendingWrite = note?.pendingWrite === true;
    if (note && note.pendingWrite === undefined) {
      try {
        const run = await this.db.syncRun.findUniqueOrThrow({ where: { id: this.runId } });
        pendingWrite = (journal(run.errorMessage, this.runId)?.writes ?? []).some(w => w.state === "pending");
      } catch { pendingWrite = true; } // Cannot tell: assume the unsafe case.
    }
    await this.mergeNotes(note
      ? { ...note, pendingWrite, at: new Date().toISOString() }
      : null);
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
      // The run is closed; now record why any card was held. Deliberately after
      // the status write, and never able to undo it.
      await this.mergeNotes(null);
      return publicSyncRun(result);
    } catch { await this.block(); throw new SyncWriterBlockedError(); }
  }
}
