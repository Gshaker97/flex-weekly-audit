/** LOCAL ONLY: bounded admission plan, never permission to write or send.
 * No provider imports; production writer integration is a separate adapter.
 */
import { createHash } from 'node:crypto';
import { planOpportunityDueDate, type BindingInput, type DateField } from './invoice-workflow-binding';
import { invoiceCalendarDate, invoiceReminderClock, invoiceReminderMilestones } from './invoice-reminder-clock';

export type BootstrapScope = { locationId: string; pipelineId: string; contactId: string;
  opportunityId: string; jobberClientId: string; invoiceId: string; workflowId: string };
export type BootstrapEnrollmentHistory = { kind: "no_prior" } | {
  kind: "retired_reviewed"; retiredExecutionIds: string[];
  retirementEvidenceRef: string; historyEvidenceRef: string;
  historySinceIssuedOn: string; completeContactHistorySinceIssue: true;
  allRetainedFixedExecutionsForContactRetired: true; noAmbiguousRelevantActions: true; noActiveRetainedExecution: true;
  milestones: Array<{ dayPastDue: number; audience: "homeowner" | "internal";
    priorAttempt: "none" | "attempted" | "unknown" }>;
};
export type BootstrapReview = BootstrapScope & {
  sourceFingerprint: string; cycleKey: string; dueOn: string;
  reviewedAt: string; expiresAt: string; reviewRef: string;
  clearanceMode?: "historical_review_v1";
  category: "maintenance" | "irrigation"; categoryReviewRef: string;
  noPriorCurrentCycleEnrollment?: boolean; noActiveOldCycle: true;
  enrollmentHistory?: BootstrapEnrollmentHistory;
};
export type BootstrapEvidence = {
  approvalId: string; policySha256: string; workflowId: string;
  reviewRef: string; nativeSkipRouteQaRef: string;
  observedAt: string; expiresAt: string;
  reminderPublished: true; closureDraft: true; completeInventoryMatches: true;
  exactOpportunityTrigger: true; sentTransitionCannotSendOrEnroll: true;
  dateOnlyCannotSendOrEnroll: true; sourceDateAnchoredWaits: true;
  pastAndDueNowMilestonesSkipped: true; futurePaymentChannelAndFactGuards: true;
};
export type BootstrapHistory = { complete: boolean; observedAt: string; entries: Array<{
  scope: BootstrapScope; phase: 'bootstrap' | 'enroll' | 'other';
  state: 'pending' | 'confirmed' | 'unknown';
}> };
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** Scope-based key deliberately excludes mutable source date/fingerprint: an edit
 * cannot mint another enrollment right for the same immutable invoice cycle. */
export const bootstrapCycleKey = (s: BootstrapScope) => hash([
  1,s.locationId,s.workflowId,s.jobberClientId,s.invoiceId,
]);
const scopeKeys = ['locationId','pipelineId','contactId','opportunityId','jobberClientId','invoiceId','workflowId'] as const;
const validRef = (v: unknown) => typeof v === 'string' && v.trim() === v && v.length > 0 && v.length <= 512;
const fresh = (at: string, now: number) => Number.isFinite(Date.parse(at)) && Date.parse(at) <= now && now - Date.parse(at) <= 900_000;
const caps = Object.freeze({ write: false, send: false, enroll: false });

export function planExistingOverdueBootstrap(input: {
  snapshot: BindingInput & { field: DateField; unchangedCardFieldsSha256: string }; cohort: BootstrapReview[];
  effects: BootstrapEvidence; history: BootstrapHistory;
}) {
  const hold = (reason: string) => ({ state: 'held' as const, reason, capabilities: caps });
  const s = input.snapshot, e = input.effects, h = input.history, now = Date.parse(s.now);
  if (!Number.isFinite(now)) return hold('invalid_clock');
  if (!/^[a-f0-9]{64}$/.test(s.unchangedCardFieldsSha256)) return hold('complete_card_readback_missing');
  const date = planOpportunityDueDate(s);
  if (!date.intent) return hold('source_identity_card_or_date_unverified');
  if (s.card.stageId !== s.stageIds.overdue) return hold('not_existing_overdue');
  // Explicit invoice references are insufficient: all unpaid owner invoices must
  // be enumerated and exactly one must match, regardless of binding method.
  const unpaid = s.source.invoices.filter(i => i.jobberClientId === s.binding.jobberClientId && (i.status !== 'paid' || i.balanceCents !== 0));
  if (unpaid.length !== 1 || unpaid[0].id !== s.binding.invoiceId) return hold('not_unique_unpaid_owner');
  const clock = invoiceReminderClock(unpaid[0].issuedDate, unpaid[0].dueDate, new Date(now));
  if (!clock?.isOverdue) return hold('not_source_overdue');
  if (!e || ![e.approvalId,e.workflowId,e.reviewRef,e.nativeSkipRouteQaRef].every(validRef)
      || !/^[a-f0-9]{64}$/.test(e.policySha256) || !fresh(e.observedAt,now)
      || !Number.isFinite(Date.parse(e.expiresAt)) || Date.parse(e.expiresAt) <= now
      || [e.reminderPublished,e.closureDraft,e.completeInventoryMatches,e.exactOpportunityTrigger,
        e.sentTransitionCannotSendOrEnroll,e.dateOnlyCannotSendOrEnroll,e.sourceDateAnchoredWaits,
        e.pastAndDueNowMilestonesSkipped,e.futurePaymentChannelAndFactGuards].some(v => v !== true)) return hold('native_effects_or_skip_policy_unverified');
  const scope: BootstrapScope = { ...Object.fromEntries(scopeKeys.filter(k => k !== 'workflowId').map(k => [k,s.binding[k]])), workflowId:e.workflowId } as BootstrapScope;
  if (!scopeKeys.every(k => validRef(scope[k]))) return hold('invalid_scope');
  const cohort = input.cohort;
  if (!Array.isArray(cohort) || !cohort.length || cohort.length > 500
      || new Set(cohort.map(c => c.opportunityId)).size !== cohort.length
      || new Set(cohort.map(c => c.cycleKey)).size !== cohort.length) return hold('invalid_bounded_cohort');
  const r = cohort.find(c => scopeKeys.every(k => c[k] === scope[k]));
  if (!r || !validRef(r.reviewRef) || r.cycleKey !== bootstrapCycleKey(scope)
      || r.sourceFingerprint !== date.intent.sourceFingerprint || r.dueOn !== clock.dueOn
      || !Number.isFinite(Date.parse(r.reviewedAt)) || Date.parse(r.reviewedAt) > now
      || (r.clearanceMode !== undefined && r.clearanceMode !== 'historical_review_v1')
      || (r.clearanceMode !== 'historical_review_v1' && (!fresh(r.reviewedAt,now)
        || Date.parse(r.expiresAt) > Date.parse(r.reviewedAt) + 900_000))
      || !Number.isFinite(Date.parse(r.expiresAt)) || Date.parse(r.expiresAt) <= now
      || Date.parse(r.expiresAt) > Date.parse(e.expiresAt)
      || r.noActiveOldCycle !== true) return hold('exact_review_missing_changed_or_expired');
  if (!h || h.complete !== true || !fresh(h.observedAt,now) || !Array.isArray(h.entries)) return hold('history_unavailable');
  if (h.entries.some(v => (v.state !== 'confirmed' && v.scope.locationId === scope.locationId
        && (v.scope.contactId === scope.contactId || v.scope.opportunityId === scope.opportunityId))
      || (v.phase !== 'other' && bootstrapCycleKey(v.scope) === r.cycleKey))) return hold('prior_attempt_or_uncertain_write');
  if (!['maintenance','irrigation'].includes(r.category) || !validRef(r.categoryReviewRef)
      || (unpaid[0].category !== null && unpaid[0].category !== r.category)) return hold('reviewed_category_missing_or_conflicting');
  const milestones = invoiceReminderMilestones(r.category,unpaid[0].issuedDate,unpaid[0].dueDate,new Date(now));
  if (!milestones) return hold('category_unverified');
  const scheduled = milestones.map(m => ({ dayPastDue:m.dayPastDue, audience:m.audience,
    scheduledAt:`${m.scheduledOn}T09:00:00-07:00` }));
  const future = scheduled.filter(m => Date.parse(m.scheduledAt) > now);
  if (!future.length) return hold('no_future_milestones');
  // Retired native history is reviewed evidence, not a replacement for the
  // durable no-repeat claim above. No variant can waive a local prior attempt.
  const enrollmentHistory: BootstrapEnrollmentHistory = r.enrollmentHistory ?? {kind:'no_prior'};
  if (enrollmentHistory.kind === 'no_prior') {
    if (r.noPriorCurrentCycleEnrollment !== true) return hold('no_prior_enrollment_review_missing');
  } else if (enrollmentHistory.kind === 'retired_reviewed') {
    const x=enrollmentHistory;
    if (r.noPriorCurrentCycleEnrollment === true || !validRef(x.retirementEvidenceRef) || !validRef(x.historyEvidenceRef)
      || x.historySinceIssuedOn !== invoiceCalendarDate(unpaid[0].issuedDate) || x.completeContactHistorySinceIssue !== true
      || x.allRetainedFixedExecutionsForContactRetired !== true || x.noAmbiguousRelevantActions !== true || x.noActiveRetainedExecution !== true
      || !Array.isArray(x.retiredExecutionIds) || !x.retiredExecutionIds.length || x.retiredExecutionIds.length>500
      || !x.retiredExecutionIds.every(validRef) || new Set(x.retiredExecutionIds).size!==x.retiredExecutionIds.length
      || !Array.isArray(x.milestones) || x.milestones.length!==scheduled.length
      || x.milestones.some(m=>!m || !['none','attempted'].includes(m.priorAttempt))
      || scheduled.some(m=>x.milestones.filter(p=>p.dayPastDue===m.dayPastDue && p.audience===m.audience).length!==1)
      || future.some(m=>x.milestones.find(p=>p.dayPastDue===m.dayPastDue && p.audience===m.audience)?.priorAttempt!=='none'))
      return hold('retired_execution_history_missing_ambiguous_or_replay_risk');
  } else return hold('unsupported_enrollment_history_review');
  const claim = { version:1 as const, scope, sentStageId:s.stageIds.sent, overdueStageId:s.stageIds.overdue, cycleKey:r.cycleKey, sourceFingerprint:r.sourceFingerprint,
    dueOn:r.dueOn, policySha256:e.policySha256, approvalId:e.approvalId, reviewRef:r.reviewRef,
    category:r.category, categoryReviewRef:r.categoryReviewRef, enrollmentHistory:structuredClone(enrollmentHistory), expiresAt:r.expiresAt, clearanceMode:r.clearanceMode ?? "short_lived_v1" };
  return { state:'local_candidate' as const, capabilities:caps, claim,
    claimSha256:hash(claim), skipped:scheduled.filter(m => Date.parse(m.scheduledAt) <= now), future,
    steps: [{ kind:'bootstrap_stage', from:s.stageIds.overdue, to:s.stageIds.sent },
      { kind:'source_date', fieldId:s.field.id, dueOn:clock.dueOn },
      { kind:'enroll_stage', from:s.stageIds.sent, to:s.stageIds.overdue }],
    integrationBlocked:'durable_bootstrap_phase_and_reviewed_skip_route_hook_required' as const };
}

export type BootstrapPlanInput = Parameters<typeof planExistingOverdueBootstrap>[0];
export type Candidate = Extract<ReturnType<typeof planExistingOverdueBootstrap>, { state:'local_candidate' }>;
export type BootstrapClaim = Candidate['claim'];
export type BootstrapPhase = 'bootstrap_stage' | 'source_date' | 'enroll_stage';
/** Adapter MUST persist claim + pending attempts atomically with writer admission.
 * claimOnce is an irreversible attempt marker even if no provider write follows.
 * readFresh.history excludes no entries; own claim is represented separately by
 * assertClaim, while history contains all OTHER claims. Adapter must enforce this
 * exact exclusion by returned claim ID, never by invoice/contact broad filtering.
 */
export type BootstrapAdapter = {
  readFresh: (ownClaimId?: string) => Promise<BootstrapPlanInput>;
  claimOnce: (claim: Candidate['claim'], digest: string) => Promise<string>;
  assertClaim: (claimId: string, digest: string) => Promise<void>;
  prepare: (claimId: string, phase: BootstrapPhase, expected: BootstrapPlanInput['snapshot']) => Promise<string>;
  assertPending: (attemptId: string) => Promise<void>;
  // Adapter retains the ORIGINAL branded snapshot outside these plain clones,
  // rechecks its 5-minute coverage/policy immediately here after assertPending,
  // and never treats the cloned planning snapshot as identity authorization.
  write: (attemptId: string, scope: BootstrapScope, step: Candidate['steps'][number]) => Promise<void>;
  confirm: (attemptId: string, readback: BootstrapPlanInput['snapshot']) => Promise<void>;
  block: (reason: string) => Promise<void>;
};
/** Disabled without exact local feature flag, no default production adapter.
 * Every write has durable attempt admission, two fresh evidence checks and exact
 * readback. Neither a timeout nor an expired review is retried or renewed here.
 */
export async function bootstrapExistingOverdue(input: {
  enabled?: boolean; adapter: BootstrapAdapter;
}) {
  if (input.enabled !== true) return { state:'held' as const, reason:'existing_overdue_bootstrap_disabled' };
  const a = input.adapter;
  let claimed = false;
  try {
    const initial = structuredClone(await a.readFresh());
    const plan = planExistingOverdueBootstrap(initial);
    if (plan.state !== 'local_candidate') return plan;
    const claimId = await a.claimOnce(structuredClone(plan.claim),plan.claimSha256);
    claimed = true;
    if (!validRef(claimId)) throw new Error('bootstrap_claim_acknowledgment_invalid');
    let expected = structuredClone(initial.snapshot);
    // Observed timestamps are freshness evidence, not stable card contents.
    const cardState = (s: typeof expected) => JSON.stringify({ card:{...s.card,observedAt:undefined}, field:s.field, binding:s.binding, stageIds:s.stageIds, unchangedCardFieldsSha256:s.unchangedCardFieldsSha256 });
    const check = async () => {
      await a.assertClaim(claimId,plan.claimSha256);
      const live = structuredClone(await a.readFresh(claimId));
      if (cardState(live.snapshot) !== cardState(expected)) throw new Error('bootstrap_live_card_changed');
      // Admission is always re-evaluated against original Overdue entry semantics;
      // actual current stage was separately checked above against confirmed state.
      const validation = structuredClone(live);
      validation.snapshot.card.stageId = initial.snapshot.stageIds.overdue;
      const next = planExistingOverdueBootstrap(validation);
      if (next.state !== 'local_candidate' || next.claimSha256 !== plan.claimSha256) throw new Error(next.state !== 'local_candidate' ? 'bootstrap_review_source_effects_or_history_changed: '+next.reason : 'bootstrap_claim_changed');
      return live.snapshot;
    };
    for (const step of plan.steps) {
      const before = await check();
      if (step.kind === 'source_date' && before.field.currentValue === plan.claim.dueOn) continue;
      const phase = step.kind as BootstrapPhase;
      const attemptId = await a.prepare(claimId,phase,structuredClone(before));
      if (!validRef(attemptId)) throw new Error('bootstrap_attempt_acknowledgment_invalid');
      await check();
      await a.assertPending(attemptId);
      await a.write(attemptId,structuredClone(plan.claim.scope),structuredClone(step));
      if (step.kind === 'source_date') expected.field.currentValue = plan.claim.dueOn;
      else expected.card.stageId = step.to!;
      const readback = await check();
      await a.confirm(attemptId,readback);
    }
    return { state:'applied' as const, claimId, cycleKey:plan.claim.cycleKey };
  } catch (error) {
    // Also block on lost claim acknowledgment: claim may have committed.
    await a.block(claimed ? 'bootstrap_after_claim_failed_no_retry' : 'bootstrap_admission_failed_unknown_claim');
    throw error;
  }
}
