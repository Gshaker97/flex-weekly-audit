/** LOCAL activation candidate. No message engine, workflow edit or new send rights.
 * A date PUT and a stage PUT are separate, durably journaled provider attempts.
 * Missing reviewed effect/QA policy deliberately fails closed (draft runbook).
 */
import type { BootstrapReview } from "./ghl-existing-overdue-bootstrap";
import { readConfiguredStandingIdentityPolicy } from "./ghl-standing-identity";
import { createHash } from "node:crypto";
import { validateReviewedWorkflowInventory, verifyPaidCycleWorkflowInventory, type ReviewedWorkflowInventory } from "./ghl-paid-cycle-workflows";
import { readWorkflowStates, readOpportunity, setOpportunityDueDate, moveOpportunityToStage, type GhlOpportunity } from "./ghl";
import { assertSnapshotWriteFreshness, assertSnapshotIdentityCoverage, cloneVerifiedSnapshot, readVerifiedDateRepairSnapshot, type DateReadinessScope } from "./ghl-date-readiness";
import { cardScopeMatches, dateJournalIntent, type DateRepairSnapshot } from "./ghl-opportunity-date-repair";
import { planOpportunityDueDate } from "./invoice-workflow-binding";
import { addInvoiceCalendarDays, invoiceReminderClock } from "./invoice-reminder-clock";
import { moneyCents } from "./ghl-phone-state";
import { approvedGhlCards } from "./ghl-write-intent";
import { cardNameHash, type GhlWriteIntent, type SyncRunWriter } from "./sync-writer-control";

export const DUE_DATE_LOCATION = "HDnGCHKTomL53dHe8KLs";
export const DUE_DATE_FIELD = "0JiuBziS4foqfka1jQyQ";
type Writer = Pick<SyncRunWriter, "prepare" | "assertPending" | "confirm" | "block"> & Partial<Pick<SyncRunWriter, "readCycleHistory">>;
/** Explicitly approved private deployment policy, pinned as a whole. Review
 * covers exact workflow definitions, complete listener inventory and one-time
 * same-location/date-field QA. Fresh metadata pins that review on every step.
 * Missing QA evidence is an activation hold, not inferred from a successful PUT.
 */
export type NativeHourlyPaymentGuard = {
  kind: "native_hourly_sync"; intervalMinutes: 60; cronExpression: string;
  scheduleReviewRef: string; sourceSyncBeforeGhlReviewRef: string;
  nativeStageAndPositiveValueGuardReviewRef: string; nativeChannelSuppressionReviewRef: string;
  stalePaymentRiskAcceptanceRef: string;
};
export type RecurringEffectsPolicy = {
  version: 1; approvalId: string; expiresAt: string; locationId: string;
  pipelineId: string; sentStageId: string; overdueStageId: string;
  reminderId: string; closureId: string; inventory: ReviewedWorkflowInventory;
  existingOverdueBootstrap?: { reviewRef: string; nativeSkipRouteQaRef: string;
    sentTransitionReviewRef: string; futureFactGuardReviewRef: string; exclusiveCycleWriterReviewRef: string;
    cohort: BootstrapReview[] };
  directRemoval?: { apiVersion: "v3"; contractSha256: string; evidenceRef: string;
    residualDispatchAndExternalEnrollmentRiskAcceptanceRef: string; singleCycleWriterReviewRef: string };
  nativeReset?: { cleanupWorkflowId: string; contractSha256: string; evidenceRef: string };
  // Exact, short-lived current-cohort review. Never automatically renew or infer
  // clearance for a later invoice from Sent. Native cleanup/reset is separate.
  executionClearance: Array<{ opportunityId: string; invoiceId: string; jobberClientId: string; contactId: string;
    sourceFingerprint: string; reviewedAt: string; expiresAt: string; reviewRef: string;
    noPriorCurrentCycleEnrollment: true; noActiveOldCycle: true }>;
  definitionReviewRef: string; listenerInventoryReviewRef: string; dateOnlyTriggerQaRef: string;
  contract: { exactOpportunityStageTriggerOnly: true; sourceDueDateAnchoredWaits: true;
    freshPaymentAndChannelGuards?: true; paymentGuard?: NativeHourlyPaymentGuard; noCatchupOrRetainedExecutionReplay: true;
    unrelatedDateListenersAbsent: true; dateOnlyUpdateCannotEnrollOrSend: true };
};
export function readRecurringEffectsPolicy(env: Record<string,string | undefined>, now: Date, journalOwned = false): RecurringEffectsPolicy | null {
  const raw = env.GHL_RECURRING_DUE_DATE_POLICY;
  if (!raw || Buffer.byteLength(raw, "utf8") > 65536
      || createHash("sha256").update(raw).digest("hex") !== env.GHL_RECURRING_DUE_DATE_POLICY_SHA256) return null;
  try {
    const p: RecurringEffectsPolicy = JSON.parse(raw);
    const ref = (v: unknown) => typeof v === "string" && v.trim().length > 0 && v.length <= 512;
    const payment = p?.contract?.paymentGuard;
    const paymentGuardReviewed = payment
      ? p.contract.freshPaymentAndChannelGuards === undefined && payment.kind === "native_hourly_sync"
        && payment.intervalMinutes === 60
        && /^(?:[0-5]?\d) \* \* \* \*$/.test(payment.cronExpression)
        && [payment.scheduleReviewRef,payment.sourceSyncBeforeGhlReviewRef,
          payment.nativeStageAndPositiveValueGuardReviewRef,payment.nativeChannelSuppressionReviewRef,
          payment.stalePaymentRiskAcceptanceRef].every(ref)
      : p?.contract?.freshPaymentAndChannelGuards === true;
    if (p?.version !== 1 || p.approvalId !== env.GHL_WRITE_APPROVAL_ID || !ref(p.approvalId)
        || p.locationId !== DUE_DATE_LOCATION || p.locationId !== env.GHL_LOCATION_ID
        || !Number.isFinite(Date.parse(p.expiresAt)) || Date.parse(p.expiresAt) <= now.getTime()
        || ![p.pipelineId,p.sentStageId,p.overdueStageId,p.reminderId,p.closureId,p.definitionReviewRef,
          p.listenerInventoryReviewRef,p.dateOnlyTriggerQaRef].every(ref)
        || p.sentStageId === p.overdueStageId || p.reminderId === p.closureId
        || !p.contract || !paymentGuardReviewed || ![p.contract.exactOpportunityStageTriggerOnly,p.contract.sourceDueDateAnchoredWaits,
          p.contract.noCatchupOrRetainedExecutionReplay,
          p.contract.unrelatedDateListenersAbsent,p.contract.dateOnlyUpdateCannotEnrollOrSend].every(v => v === true)) return null;
    if (!Array.isArray(p.executionClearance)) return null;
    if (!journalOwned && (!Array.isArray(p.executionClearance) || !p.executionClearance.length || p.executionClearance.length > 500
        || new Set(p.executionClearance.map(c => c?.opportunityId)).size !== p.executionClearance.length
        || p.executionClearance.some(c => !c || ![c.opportunityId,c.invoiceId,c.jobberClientId,c.contactId,c.reviewRef].every(ref)
          || !/^[a-f0-9]{64}$/.test(c.sourceFingerprint) || c.noPriorCurrentCycleEnrollment !== true || c.noActiveOldCycle !== true
          || !Number.isFinite(Date.parse(c.reviewedAt)) || !Number.isFinite(Date.parse(c.expiresAt))
          || Date.parse(c.reviewedAt) > now.getTime() || Date.parse(c.expiresAt) <= now.getTime()
          || Date.parse(c.expiresAt) > Date.parse(c.reviewedAt) + 15 * 60_000
          || Date.parse(c.expiresAt) > Date.parse(p.expiresAt)))) return null;
    validateReviewedWorkflowInventory(p.inventory, p.locationId);
    if (p.inventory.entries.find(w => w.id === p.reminderId)?.status !== "published"
        || p.inventory.entries.find(w => w.id === p.closureId)?.status !== "draft") return null;
    return p;
  } catch { return null; }
}
const defaults = {
  readFresh: (scope: DateReadinessScope) => {
    const policy = readConfiguredStandingIdentityPolicy(), pin = JSON.stringify(policy);
    return readVerifiedDateRepairSnapshot(scope, undefined, undefined, policy,
      () => JSON.stringify(readConfiguredStandingIdentityPolicy()) === pin);
  }, workflows: readWorkflowStates,
  updateDate: setOpportunityDueDate, readCard: readOpportunity, moveStage: moveOpportunityToStage,
};
const fields = (c: GhlOpportunity) => (c.customFields ?? []).slice().sort((a,b) => a.id.localeCompare(b.id));
const sameCard = (a: GhlOpportunity, b: GhlOpportunity) => a.id === b.id && a.locationId === b.locationId
  && a.contactId === b.contactId && a.pipelineId === b.pipelineId && a.pipelineStageId === b.pipelineStageId
  && a.status === b.status && a.name === b.name && a.monetaryValue === b.monetaryValue
  && JSON.stringify(fields(a)) === JSON.stringify(fields(b));

export async function syncRecurringDueDateBeforeStage(input: {
  scope: DateReadinessScope; expectedCard: GhlOpportunity;
  target: { stageId: string; monetaryValue: number; name?: string };
  mode: string; phoneOwner: boolean; writer: Writer;
  env?: Record<string,string | undefined>; now?: () => Date; deps?: typeof defaults;
}) {
  const env = { ...(input.env ?? process.env) }, now = input.now ?? (() => new Date()), deps = input.deps ?? defaults;
  const held = (reason: string) => ({ state: "held" as const, reason });
  if (env.GHL_RECURRING_DUE_DATE_ENABLED !== "true") return held("recurring_due_date_disabled");
  if (input.mode !== "sync" || env.GHL_INVOICE_WRITE_MODE !== "sync" || env.SYNC_ADMISSION_MODE !== "cron_only"
      || (input.phoneOwner && env.GHL_PHONE_WRITES_ENABLED !== "true")
      || input.scope.locationId !== DUE_DATE_LOCATION || env.GHL_LOCATION_ID !== DUE_DATE_LOCATION
      || !approvedGhlCards(env).has(input.scope.opportunityId)) return held("existing_write_gates_not_satisfied");
  const ownershipEnabled = env.GHL_CYCLE_OWNERSHIP_ENABLED === "true";
  const policy = readRecurringEffectsPolicy(env, now(), ownershipEnabled);
  if (!policy || policy.pipelineId !== input.expectedCard.pipelineId || policy.sentStageId !== input.expectedCard.pipelineStageId
      || policy.overdueStageId !== input.target.stageId) return held("reviewed_effect_policy_or_date_only_QA_missing_activation_hold");
  const history = ownershipEnabled && input.writer.readCycleHistory ? await input.writer.readCycleHistory() : [];
  if (history.some(w => w.intent.cycle?.phase === "enroll" && w.intent.cycle.locationId === input.scope.locationId
      && w.intent.cycle.workflowId === policy.reminderId && w.intent.cycle.invoiceId === input.scope.invoiceId
      && w.intent.jobberClientId === input.scope.jobberClientId)) return held("invoice_cycle_already_attempted_no_reenrollment");
  const reset = history.find(w => w.state === "confirmed" && w.intent.cycle?.phase === "reset_stage"
    && w.intent.cycle.locationId === input.scope.locationId && w.intent.cycle.workflowId === policy.reminderId
    && w.intent.cycle.invoiceId === input.scope.invoiceId && w.intent.opportunityId === input.scope.opportunityId
    && w.intent.contactId === input.scope.contactId && w.intent.jobberClientId === input.scope.jobberClientId);
  const clearance = policy.executionClearance?.find(c => c.opportunityId === input.scope.opportunityId
    && c.invoiceId === input.scope.invoiceId && c.jobberClientId === input.scope.jobberClientId && c.contactId === input.scope.contactId);
  const clearanceFresh = clearance && Date.parse(clearance.reviewedAt) <= now().getTime()
    && Date.parse(clearance.expiresAt) > now().getTime() && Date.parse(clearance.expiresAt) <= Date.parse(clearance.reviewedAt) + 15 * 60_000
    && clearance.noPriorCurrentCycleEnrollment === true && clearance.noActiveOldCycle === true;
  if (!reset && !clearanceFresh) return held("exact_current_cycle_execution_clearance_missing");
  if (ownershipEnabled && !input.writer.readCycleHistory) return held("durable_cycle_history_unavailable");
  const effects = async () => {
    if (!readRecurringEffectsPolicy(env, now(), !!reset)) return false;
    await verifyPaidCycleWorkflowInventory(policy.inventory, policy.locationId, deps.workflows);
    return !!readRecurringEffectsPolicy(env, now(), !!reset);
  };
  let admitted = false;
  try {
    if (!await effects()) return held("published_reminder_effect_contract_unverified_activation_hold");
    const fresh = async () => {
      const s = cloneVerifiedSnapshot(await deps.readFresh(input.scope)); s.now = now().toISOString();
      const p = planOpportunityDueDate(s);
      const invoice = s.source.invoices.find(i => i.id === input.scope.invoiceId);
      const clock = invoice && invoiceReminderClock(invoice.issuedDate, invoice.dueDate, now());
      if (p.state === "held" || !p.intent || !cardScopeMatches(s)
          || (!reset && p.intent.sourceFingerprint !== clearance!.sourceFingerprint)
          || s.binding.method !== "unique_unpaid_invoice" || s.field.id !== DUE_DATE_FIELD
          || s.binding.locationId !== input.scope.locationId || s.binding.contactId !== input.scope.contactId
          || s.binding.opportunityId !== input.scope.opportunityId || s.binding.jobberClientId !== input.scope.jobberClientId
          || s.binding.invoiceId !== input.scope.invoiceId || s.card.stageId !== s.stageIds.sent
          || input.target.stageId !== s.stageIds.overdue || moneyCents(input.target.monetaryValue) !== s.card.amountCents
          || !clock || clock.daysPastDue < 1
          || Date.parse(`${addInvoiceCalendarDays(clock.dueOn, 10)}T09:00:00-07:00`) <= now().getTime()
          || (p.state === "already_aligned" && s.field.currentValue !== p.intent.targetValue)) throw new Error("Recurring date/source/card plan held");
      // Overdue starts on due+1. A delayed sync may enter only while the first
      // Day10 09:00 Arizona milestone is still future. No catch-up or clock reset.
      assertSnapshotIdentityCoverage(s);
      return { s, p };
    };
    const first = await fresh();
    if (!sameCard(first.s.currentCard, input.expectedCard)) return held("card_changed_since_sync_preflight");
    const fingerprint = first.p.intent!.sourceFingerprint;
    let expected = first.s.currentCard;
    const check = async (aligned: boolean) => {
      const f = await fresh();
      if (f.p.intent!.sourceFingerprint !== fingerprint || !sameCard(f.s.currentCard, expected)
          || (aligned && f.p.state !== "already_aligned")) throw new Error("Source or card changed between date and stage steps");
      if (!await effects()) throw new Error("Workflow effects changed between date and stage steps");
      assertSnapshotIdentityCoverage(f.s);
      return f;
    };
    if (first.p.state === "repair_candidate") {
      const intent = dateJournalIntent(first.s, env.GHL_WRITE_APPROVAL_ID!);
      if (!intent) return held("date_journal_evidence_unavailable");
      assertSnapshotIdentityCoverage(first.s);
      admitted = true;
      const id = await input.writer.prepare(intent);
      await input.writer.assertPending(id);
      const f = await check(false);
      await input.writer.assertPending(id);
      assertSnapshotWriteFreshness(f.s,now());
      await deps.updateDate(input.scope.opportunityId, DUE_DATE_FIELD, f.p.intent!.targetValue);
      const after = await deps.readCard(input.scope.opportunityId);
      const expectedAfter = { ...expected, customFields: [...(expected.customFields ?? []).filter(v => v.id !== DUE_DATE_FIELD),
        { id: DUE_DATE_FIELD, fieldValue: f.p.intent!.targetValue }] };
      if (!sameCard(after, expectedAfter)) throw new Error("Date-only readback not confirmed");
      await input.writer.confirm(id);
      expected = after;
    }
    // Fresh complete source/identity/card/effects AFTER confirmed date readback.
    const beforeStage = await check(true);
    const before = { stageId: beforeStage.s.card.stageId, status: "open" as const,
      amountCents: beforeStage.s.card.amountCents, nameHash: cardNameHash(expected.name) };
    const intent: GhlWriteIntent = { approvalId: env.GHL_WRITE_APPROVAL_ID, pipelineId: expected.pipelineId!,
      contactId: input.scope.contactId, opportunityId: input.scope.opportunityId, jobberClientId: input.scope.jobberClientId,
      expected: before, target: { stageId: input.target.stageId, amountCents: before.amountCents,
        nameHash: cardNameHash(input.target.name ?? expected.name), updateName: input.target.name !== undefined },
      source: { observedAt: beforeStage.s.source.observedAt,
        storedInvoiceIds: beforeStage.s.source.invoices.map(i => i.id).sort(),
        invoices: beforeStage.s.source.invoices.map(i => ({ id:i.id, jobberClientId:i.jobberClientId, invoiceStatus:i.status,
          totalCents:i.totalCents, balanceCents:i.balanceCents, issuedDate:i.issuedDate, dueDate:i.dueDate, createdAt:null })).sort((a,b) => a.id.localeCompare(b.id)) } };
    if (ownershipEnabled) intent.cycle = { version: 1, locationId: input.scope.locationId,
      workflowId: policy.reminderId, invoiceId: input.scope.invoiceId, dueOn: first.p.intent!.targetValue, phase: "enroll",
      ...(reset ? { predecessorInvoiceId: reset.intent.cycle!.predecessorInvoiceId } : {}) };
    assertSnapshotIdentityCoverage(beforeStage.s);
    admitted = true;
    const stageId = await input.writer.prepare(intent);
    await input.writer.assertPending(stageId);
    const finalStage = await check(true);
    await input.writer.assertPending(stageId);
    assertSnapshotWriteFreshness(finalStage.s,now());
    await deps.moveStage(input.scope.opportunityId, input.target.stageId, input.target.monetaryValue, input.target.name);
    const afterStage = await deps.readCard(input.scope.opportunityId);
    if (!sameCard(afterStage, { ...expected, pipelineStageId: input.target.stageId, monetaryValue: input.target.monetaryValue,
      name: input.target.name ?? expected.name })) throw new Error("Stage readback not confirmed");
    await input.writer.confirm(stageId);
    return { state: "applied" as const, opportunityId: input.scope.opportunityId, dueOn: first.p.intent!.targetValue };
  } catch (error) {
    if (!admitted) return held(error instanceof Error ? error.message : "Fresh evidence unavailable");
    await input.writer.block();
    throw error; // Unknown results are never retried, compensated or silently resumed.
  }
}
