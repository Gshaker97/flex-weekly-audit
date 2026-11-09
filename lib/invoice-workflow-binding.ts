/** Pure repair/reconciliation plans. No provider, database, enrollment or send calls.
 * Inputs must come from fresh complete source reads or explicit reviewed evidence.
 * A plan is NOT permission to write, resume, retire, enroll or send.
 */
import { createHash } from "node:crypto";
import { invoiceCalendarDate, invoiceReminderMilestones, type InvoiceReminderCategory } from "./invoice-reminder-clock";

export const BINDING_VERSION = 1;
export const capabilities = Object.freeze({ write: false, send: false, resume: false, retire: false, enroll: false });
type SourceInvoice = { id: string; jobberClientId: string; status: string; totalCents: number; balanceCents: number;
  issuedDate: string | null; dueDate: string | null; category: InvoiceReminderCategory | null };
type Snapshot = { observedAt: string; complete: boolean; invoices: SourceInvoice[] };
type Card = { id: string; locationId: string; contactId: string; pipelineId: string; stageId: string;
  status: string; amountCents: number; observedAt: string };
type Binding = { locationId: string; contactId: string; opportunityId: string; pipelineId: string;
  jobberClientId: string; invoiceId: string; method: "explicit_invoice_reference" | "unique_unpaid_invoice";
  evidenceRef: string; identityVerified: boolean; uniqueInvoiceCardVerified: boolean };
export type BindingInput = { now: string; source: Snapshot; card: Card; binding: Binding;
  stageIds: { sent: string; overdue: string } };
type Bound = { ok: true; invoice: SourceInvoice; fingerprint: string; dueOn: string; reasons: string[] };
type Held = { ok: false; reasons: string[] };
const id = (v: unknown): v is string => typeof v === "string" && !!v && v.trim() === v && v.length <= 256;
const cents = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const instant = (v: unknown): number | null => typeof v === "string" && /T\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(v)
  && invoiceCalendarDate(v) ? Date.parse(v) : null;
const fingerprint = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const held = (reasons: string[]): Held => ({ ok: false, reasons: [...new Set(reasons)] });
function isFresh(at: string, now: string): boolean {
  const a = instant(at), n = instant(now);
  return a !== null && n !== null && a <= n && n - a <= 15 * 60_000;
}

/** Current unambiguous one-invoice context, never a first-returned contact card.
 * Full source membership is needed even for a single target: hidden debt or a
 * second cycle must not silently replace an old workflow's invoice context.
 */
export function resolveInvoiceBinding(input: BindingInput): Bound | Held {
  if (!input || !input.source || !input.card || !input.binding) return held(["invalid_input"]);
  const { source, card, binding: b } = input, reasons: string[] = [];
  if (!Array.isArray(source.invoices) || source.complete !== true) return held(["source_snapshot_incomplete"]);
  if (!isFresh(source.observedAt, input.now) || !isFresh(card.observedAt, input.now)) reasons.push("source_or_card_stale");
  if (![b.locationId, b.contactId, b.opportunityId, b.pipelineId, b.jobberClientId, b.invoiceId, b.evidenceRef].every(id)
      || b.identityVerified !== true || b.uniqueInvoiceCardVerified !== true) reasons.push("identity_or_invoice_card_unproven");
  if (card.id !== b.opportunityId || card.contactId !== b.contactId || card.locationId !== b.locationId
      || card.pipelineId !== b.pipelineId || !id(card.stageId)) reasons.push("card_scope_mismatch");
  if (card.status !== "open") reasons.push("protected_card_status");
  if (!input.stageIds || !id(input.stageIds.sent) || !id(input.stageIds.overdue)
      || input.stageIds.sent === input.stageIds.overdue
      || ![input.stageIds.sent, input.stageIds.overdue].includes(card.stageId)) reasons.push("protected_or_unverified_card_stage");
  if (!cents(card.amountCents)) reasons.push("invalid_card_amount");
  const allIds = new Set<string>();
  for (const row of source.invoices) {
    if (!row || !id(row.id) || !id(row.jobberClientId) || allIds.has(row.id)) return held([...reasons, "source_id_invalid_or_duplicate"]);
    allIds.add(row.id);
  }
  const owner = source.invoices.filter(i => i.jobberClientId === b.jobberClientId);
  const invoice = owner.find(i => i.id === b.invoiceId);
  if (!invoice) return held([...reasons, "invoice_owner_mismatch_or_missing"]);
  for (const row of owner) {
    if (!cents(row.totalCents) || !cents(row.balanceCents) || row.balanceCents > row.totalCents) reasons.push("invalid_source_amount");
    if (!["paid", "past_due", "awaiting_payment"].includes(row.status)) reasons.push("source_status_unresolved");
    if (row.status === "paid" && row.balanceCents !== 0) reasons.push("contradictory_paid_balance");
    if (row.status !== "paid" && row.balanceCents === 0) reasons.push("unsettled_zero_balance");
  }
  const unpaid = owner.filter(i => i.status !== "paid" || i.balanceCents !== 0);
  if (b.method === "unique_unpaid_invoice") {
    if (unpaid.length !== 1 || unpaid[0].id !== invoice.id) reasons.push("multiple_or_missing_unpaid_cycles");
  } else if (b.method !== "explicit_invoice_reference") reasons.push("unsupported_binding_method");
  if (!["past_due", "awaiting_payment"].includes(invoice.status) || invoice.balanceCents <= 0) reasons.push("invoice_not_collectible");
  if (card.amountCents !== invoice.balanceCents) reasons.push("card_is_not_invoice_balance");
  const dueOn = invoiceCalendarDate(invoice.dueDate), sentOn = invoiceCalendarDate(invoice.issuedDate);
  const today = invoiceCalendarDate(input.now);
  if (!dueOn || !sentOn || !today || sentOn > dueOn || sentOn > today) reasons.push("invalid_source_clock");
  if (invoice.status === "past_due" && dueOn && today && dueOn >= today) reasons.push("contradictory_early_past_due");
  if (reasons.length || !dueOn) return held(reasons);
  // Stable cycle evidence excludes volatile observedAt and includes ALL owner
  // invoice state. A payment, due-date edit or added invoice invalidates a plan.
  const canonical = owner.slice().sort((a, z) => a.id.localeCompare(z.id)).map(i =>
    [i.id, i.jobberClientId, i.status, i.totalCents, i.balanceCents, i.issuedDate, i.dueDate, i.category]);
  return { ok: true, invoice, dueOn, reasons: [], fingerprint: fingerprint([BINDING_VERSION,
    b.locationId, b.contactId, b.opportunityId, b.pipelineId, b.jobberClientId, b.invoiceId, canonical]) };
}

export type DateField = { id: string; locationId: string; model: string; key: string; type: string;
  currentValueKnown: boolean; currentValue: unknown };
/** Produce an exact record/field repair intent. Never write a shared contact date,
 * silently overwrite an existing different date, or bind aggregate debt to one date.
 */
export function planOpportunityDueDate(input: BindingInput & { field: DateField }) {
  if (!input || !input.binding || !input.card || !input.source) return { state: "held" as const, reasons: ["invalid_input"], capabilities };
  const resolved = resolveInvoiceBinding(input), reasons = resolved.ok ? [] : [...resolved.reasons];
  const f = input?.field;
  if (!f || !id(f.id) || f.locationId !== input.binding?.locationId || f.model !== "opportunity"
      || f.key !== "opportunity.due_date" || f.type !== "DATE") reasons.push("opportunity_date_field_unverified");
  if (f?.currentValueKnown !== true) reasons.push("current_date_value_unknown");
  const blank = f?.currentValue === null || f?.currentValue === "";
  const current = typeof f?.currentValue === "string" ? invoiceCalendarDate(f.currentValue) : null;
  if (!blank && !current) reasons.push("current_date_value_invalid");
  if (resolved.ok && current && current !== resolved.dueOn) reasons.push("existing_due_date_conflict");
  if (!resolved.ok || reasons.length) return { state: "held" as const, reasons: [...new Set(reasons)], capabilities };
  return { state: current === resolved.dueOn ? "already_aligned" as const : "repair_candidate" as const,
    reasons: [], capabilities, intent: { version: BINDING_VERSION, locationId: input.binding.locationId,
      contactId: input.binding.contactId, opportunityId: input.binding.opportunityId,
      jobberClientId: input.binding.jobberClientId, invoiceId: resolved.invoice.id,
      fieldId: f.id, fieldKey: f.key, expectedValue: f.currentValue, targetValue: resolved.dueOn,
      expectedStageId: input.card.stageId, expectedStatus: input.card.status,
      expectedAmountCents: input.card.amountCents, sourceFingerprint: resolved.fingerprint } };
}

export type RetainedExecution = { executionId: string; workflowId: string; workflowState: string;
  locationId: string; contactId: string; triggerOpportunityId: string | null;
  enrolledInvoiceId: string | null; enrolledDueOn: string | null; enrolledCategory: string | null;
  nextScheduledAt: string | null; dayPastDue: number; audience: "homeowner" | "internal";
  historyInvoiceAttributed: boolean; priorAttempt: "none" | "delivered" | "accepted" | "unknown";
  currentStageGuardVerified: boolean; exactOpportunityContextVerified: boolean;
  channel: "sms" | "email"; recipientVerified: boolean; channelAllowed: boolean | null;
  messageFactsVerified: boolean; amountSource: "fresh_invoice" | "contact_field" | "unknown";
  dateFieldReadback: string | null; currentWorkflowVersionVerified: boolean };
export const reminderEventKey = (locationId: string, invoiceId: string, day: number, audience: string) =>
  id(locationId) && id(invoiceId) && Number.isSafeInteger(day) && day > 0 && ["homeowner", "internal"].includes(audience)
    ? JSON.stringify([locationId, invoiceId, day, audience]) : null;
/** Old waits are evaluated independently of current contact/card uniqueness.
 * Exact triggering opportunity + enrolled invoice cycle evidence is mandatory.
 * Elapsed waits are always held: no implicit catch-up or batch resume.
 */
export function reconcileRetainedReminder(input: BindingInput & { execution: RetainedExecution;
  pendingMilestoneCount: number | null; executionSnapshotComplete: boolean; homeownerEmailFallbackApproved: boolean }) {
  if (!input || !input.binding || !input.card || !input.source) return { state: "held" as const, reasons: ["invalid_input"], capabilities };
  const resolved = resolveInvoiceBinding(input), reasons = resolved.ok ? [] : [...resolved.reasons];
  const e = input?.execution;
  if (!e || !id(e.executionId) || !id(e.workflowId)) return { state: "held" as const, reasons: ["execution_missing"], capabilities };
  if (e.workflowState !== "draft") reasons.push("workflow_not_paused");
  if (input.card.stageId !== input.stageIds?.overdue) reasons.push("card_not_currently_overdue");
  if (e.locationId !== input.binding.locationId || e.contactId !== input.binding.contactId
      || e.triggerOpportunityId !== input.binding.opportunityId || e.exactOpportunityContextVerified !== true) reasons.push("execution_opportunity_binding_unproven");
  if (e.enrolledInvoiceId !== input.binding.invoiceId || !e.enrolledInvoiceId) reasons.push("execution_invoice_cycle_unproven");
  if (resolved.ok && (e.enrolledDueOn !== resolved.dueOn || e.enrolledCategory !== resolved.invoice.category)) reasons.push("enrolled_cycle_date_or_service_changed");
  if (e.historyInvoiceAttributed !== true) reasons.push("message_history_not_invoice_attributed");
  if (e.priorAttempt !== "none") reasons.push(e.priorAttempt === "unknown" ? "prior_attempt_uncertain" : "milestone_already_attempted");
  if (e.currentStageGuardVerified !== true) reasons.push("fresh_guard_before_next_action_unverified");
  if (e.currentWorkflowVersionVerified !== true) reasons.push("queued_workflow_version_unverified");
  if (e.recipientVerified !== true || e.channelAllowed !== true) reasons.push("recipient_or_channel_unverified");
  if (e.audience === "homeowner" && e.channel !== "sms" && input.homeownerEmailFallbackApproved !== true) reasons.push("homeowner_email_fallback_unapproved");
  if (input.executionSnapshotComplete !== true || input.pendingMilestoneCount !== 1) reasons.push("pending_milestone_not_unique_or_unknown");
  if (e.messageFactsVerified !== true) reasons.push("message_claims_unverified");
  if (e.amountSource !== "fresh_invoice") reasons.push("message_amount_not_invoice_bound");
  if (resolved.ok && e.dateFieldReadback !== resolved.dueOn) reasons.push("date_field_not_verified");
  const next = instant(e.nextScheduledAt), now = instant(input.now);
  if (next === null || now === null) reasons.push("next_action_time_unknown");
  else if (next <= now) reasons.push("elapsed_wait_requires_explicit_backlog_decision");
  const milestones = resolved.ok && resolved.invoice.category
    ? invoiceReminderMilestones(resolved.invoice.category, resolved.invoice.issuedDate, resolved.invoice.dueDate, new Date(input.now)) : null;
  const milestone = milestones?.find(m => m.dayPastDue === e.dayPastDue && m.audience === e.audience);
  if (!milestone) reasons.push("service_milestone_unverified");
  else if (invoiceCalendarDate(e.nextScheduledAt) !== milestone.scheduledOn) reasons.push("relative_wait_misses_source_milestone");
  return { state: reasons.length ? "held" as const : "future_candidate_for_review" as const,
    reasons: [...new Set(reasons)], capabilities, executionId: e.executionId,
    eventKey: reminderEventKey(input.binding.locationId, input.binding.invoiceId, e.dayPastDue, e.audience),
    sourceFingerprint: resolved.ok ? resolved.fingerprint : null,
    expectedMilestoneOn: milestone?.scheduledOn ?? null };
}

/** Call with the COMPLETE retained reminder execution snapshot, not only a
 * proposed pilot cohort. Channel is deliberately excluded from the event key.
 */
export function reconcileRetainedReminderBatch(inputs: Array<BindingInput & { execution: RetainedExecution;
  homeownerEmailFallbackApproved: boolean }>, complete: boolean) {
  if (!Array.isArray(inputs)) return [{ state: "held" as const, reasons: ["execution_snapshot_invalid"], capabilities }];
  const counts = new Map<string, number>(), executions = new Map<string, number>();
  let allRowsResolvable = true;
  for (const input of inputs) {
    if (!input?.binding || !input.execution) { allRowsResolvable = false; continue; }
    const e = input.execution;
    const key = reminderEventKey(input.binding.locationId, input.binding.invoiceId, e.dayPastDue, e.audience);
    if (!key || !id(e.executionId) || e.enrolledInvoiceId !== input.binding.invoiceId
        || e.triggerOpportunityId !== input.binding.opportunityId || e.exactOpportunityContextVerified !== true)
      allRowsResolvable = false;
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    if (id(e.executionId)) executions.set(e.executionId, (executions.get(e.executionId) ?? 0) + 1);
  }
  return inputs.map(input => {
    const e = input?.execution;
    const key = input?.binding && e ? reminderEventKey(input.binding.locationId, input.binding.invoiceId, e.dayPastDue, e.audience) : null;
    return reconcileRetainedReminder({ ...input, executionSnapshotComplete: complete === true && allRowsResolvable,
      pendingMilestoneCount: key && e && executions.get(e.executionId) === 1 ? counts.get(key) ?? null : null });
  });
}

/** Paid closure does not inherit safety from a stage label or a zero card value.
 * Its modern update must have exact opportunity context and a last-moment fresh
 * paid/zero-balance guard. Legacy upsert explicitly does not target the trigger.
 */
export function reconcilePaidClosure(input: {
  now: string; source: Snapshot; jobberClientId: string; locationId: string; contactId: string;
  invoicePipelineId: string; paidStageId: string;
  identity: { verified: boolean; uniqueInvoiceCardVerified: boolean; evidenceRef: string;
    jobberClientId: string; locationId: string; contactId: string; opportunityId: string; pipelineId: string };
  card: Card; execution: { executionId: string; workflowState: string; triggerOpportunityId: string | null;
    exactOpportunityContextVerified: boolean; enrolledSourceFingerprint: string | null;
    paidStageEnteredAt: string | null; enrolledAt: string | null; waitStartedAt: string | null;
    nextScheduledAt: string | null; action: "update_opportunity" | "legacy_create_update";
    freshPaidGuardVerified: boolean; currentWorkflowVersionVerified: boolean };
}) {
  if (!input || !input.source || !input.card || !input.execution) return { state: "held" as const, reasons: ["invalid_input"], capabilities };
  const reasons: string[] = [], { source, card, execution: e } = input;
  if (source.complete !== true || !Array.isArray(source.invoices) || !isFresh(source.observedAt, input.now)
      || !isFresh(card?.observedAt, input.now)) return { state: "held" as const, reasons: ["source_or_card_incomplete_or_stale"], capabilities };
  if (source.invoices.some(i => !i || !id(i.id) || !id(i.jobberClientId))) return { state: "held" as const, reasons: ["invalid_source_membership"], capabilities };
  const owner = source.invoices.filter(i => i.jobberClientId === input.jobberClientId);
  const identity = input.identity;
  if (!identity || identity.verified !== true || identity.uniqueInvoiceCardVerified !== true || !id(identity.evidenceRef)
      || identity.jobberClientId !== input.jobberClientId || identity.locationId !== input.locationId
      || identity.contactId !== input.contactId || identity.opportunityId !== card.id || identity.pipelineId !== input.invoicePipelineId) reasons.push("paid_source_card_identity_unproven");
  if (![input.jobberClientId, input.locationId, input.contactId, input.invoicePipelineId, input.paidStageId].every(id)) reasons.push("scope_unverified");
  if (!owner.length || new Set(source.invoices.map(i => i.id)).size !== source.invoices.length
      || owner.some(i => !id(i.id) || !cents(i.totalCents) || !cents(i.balanceCents) || i.balanceCents > i.totalCents)) reasons.push("invalid_source_membership");
  if (owner.some(i => i.status !== "paid" || i.balanceCents !== 0)) reasons.push("source_has_unpaid_or_unresolved_invoice");
  const sourceFingerprint = fingerprint(owner.slice().sort((a,z) => a.id.localeCompare(z.id)));
  if (!id(e?.executionId) || e.workflowState !== "draft") reasons.push("execution_missing_or_not_paused");
  if (card.locationId !== input.locationId || card.contactId !== input.contactId || !id(card.id)
      || e.triggerOpportunityId !== card.id || e.exactOpportunityContextVerified !== true) reasons.push("execution_opportunity_binding_unproven");
  if (card.status !== "open" || card.amountCents !== 0) reasons.push("card_not_open_zero_balance");
  if (card.pipelineId !== input.invoicePipelineId || card.stageId !== input.paidStageId) reasons.push("card_not_in_verified_paid_stage");
  if (e.enrolledSourceFingerprint !== sourceFingerprint) reasons.push("paid_cycle_changed_or_unproven");
  if (e.action !== "update_opportunity") reasons.push("legacy_action_does_not_target_trigger");
  if (e.freshPaidGuardVerified !== true || e.currentWorkflowVersionVerified !== true) reasons.push("fresh_paid_guard_or_version_unverified");
  const at = instant(e.nextScheduledAt), now = instant(input.now);
  if (at === null || now === null || at <= now) reasons.push("elapsed_or_unknown_closure_wait");
  const entered = instant(e.paidStageEnteredAt), enrolled = instant(e.enrolledAt), waited = instant(e.waitStartedAt);
  if (entered === null || enrolled === null || waited === null || at === null || now === null
      || entered > enrolled || enrolled > waited || waited > now || at !== waited + 7 * 86_400_000)
    reasons.push("seven_day_paid_wait_anchor_unproven");
  return { state: reasons.length ? "held" as const : "future_candidate_for_review" as const,
    reasons: [...new Set(reasons)], sourceFingerprint, capabilities };
}
