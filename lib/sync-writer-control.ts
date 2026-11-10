import type { BootstrapClaim, BootstrapPhase } from "./ghl-existing-overdue-bootstrap";
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
export type BootstrapJournalClaim = { claim: BootstrapClaim; claimSha256: string;
  phase: "claim" | BootstrapPhase; claimId?: string };
export interface GhlWriteIntent {
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
export interface JournalEntry { id: string; state: "pending" | "confirmed"; preparedAt: string; confirmedAt?: string; fingerprint: string; intent: GhlWriteIntent; paidDateReadback?: PaidDateReadback; removalAcknowledgment?: WorkflowRemovalAcknowledgment }
interface Journal { version: 1; runId: string; warnings: string | null; writes: JournalEntry[] }
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
      if (!identity(entry.id) || ids.has(entry.id) || !["pending", "confirmed"].includes(entry.state)
          || typeof entry.preparedAt !== "string" || !date(entry.preparedAt)
          || (entry.state === "confirmed" && (typeof entry.confirmedAt !== "string" || !date(entry.confirmedAt)))) throw new Error();
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

  async readCycleHistory(): Promise<CycleJournalEntry[]> { return cycleHistory(this.db); }

  async prepare(intent: GhlWriteIntent): Promise<string> {
    try {
      if (this.halted) throw new SyncWriterBlockedError();
      validateIntent(intent);
      const id = randomUUID();
      await durable(this.db, async tx => {
        const run = await tx.syncRun.findUniqueOrThrow({ where: { id: this.runId } });
        if (run.status !== "running") throw new SyncWriterBlockedError();
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
