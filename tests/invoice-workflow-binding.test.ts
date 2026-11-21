import test from "node:test";
import assert from "node:assert/strict";
import { capabilities, resolveInvoiceBinding, planOpportunityDueDate, reconcileRetainedReminder, reconcileRetainedReminderBatch, reconcilePaidClosure,
  type BindingInput, type DateField, type RetainedExecution } from "../lib/invoice-workflow-binding";
function fixture(): BindingInput & { field: DateField; execution: RetainedExecution;
  pendingMilestoneCount: number|null; executionSnapshotComplete: boolean; homeownerEmailFallbackApproved: boolean } {
  const now = "2026-11-09T17:20:00.000Z";
  return { now, pendingMilestoneCount:1,executionSnapshotComplete:true,homeownerEmailFallbackApproved:false,
    stageIds: { sent: "sent", overdue: "overdue" }, source: { complete: true, observedAt: now, invoices: [{ id: "invoice-1", jobberClientId: "owner-1",
    status: "past_due", totalCents: 9800, balanceCents: 9800, issuedDate: "2026-10-26T23:03:18Z",
    dueDate: "2026-11-02T07:00:00Z", category: "maintenance" }] },
    card: { id: "opp-1", locationId: "location-1", contactId: "contact-1", pipelineId: "pipeline-1",
      stageId: "overdue", status: "open", amountCents: 9800, observedAt: now },
    binding: { locationId: "location-1", contactId: "contact-1", opportunityId: "opp-1", pipelineId: "pipeline-1",
      jobberClientId: "owner-1", invoiceId: "invoice-1", method: "unique_unpaid_invoice", evidenceRef: "synthetic-fixture",
      identityVerified: true, uniqueInvoiceCardVerified: true },
    field: { id: "due-field-1", locationId: "location-1", model: "opportunity", key: "opportunity.due_date", type: "DATE",
      currentValueKnown: true, currentValue: "" },
    execution: { executionId: "execution-1", workflowId: "workflow-1", workflowState: "draft", locationId: "location-1",
      contactId: "contact-1", triggerOpportunityId: "opp-1", enrolledInvoiceId: "invoice-1", enrolledDueOn: "2026-11-02",
      enrolledCategory: "maintenance", nextScheduledAt: "2026-11-12T17:00:00Z", dayPastDue: 10, audience: "homeowner",
      historyInvoiceAttributed: true, priorAttempt: "none", currentStageGuardVerified: true, exactOpportunityContextVerified: true,
      channel: "sms", recipientVerified: true, channelAllowed: true, messageFactsVerified: true, amountSource: "fresh_invoice",
      dateFieldReadback: "2026-11-02", currentWorkflowVersionVerified: true } };
}
test("all exported operational capabilities permanently disabled", () => {
  assert.deepEqual(capabilities, { write: false, send: false, resume: false, retire: false, enroll: false });
  assert.ok(Object.isFrozen(capabilities));
});
test("blank opportunity date gets exact source Arizona calendar date and stable IDs", () => {
  const f = fixture(), copy = structuredClone(f), p = planOpportunityDueDate(f);
  assert.equal(p.state, "repair_candidate"); assert.equal(p.intent?.targetValue, "2026-11-02");
  assert.equal(p.intent?.opportunityId, "opp-1"); assert.equal(p.intent?.invoiceId, "invoice-1");
  assert.equal(p.intent?.fieldId, "due-field-1"); assert.equal(p.intent?.expectedValue, ""); assert.deepEqual(f, copy);
});
test("already aligned date is idempotent", () => { const f=fixture(); f.field.currentValue="2026-11-02";
  assert.equal(planOpportunityDueDate(f).state, "already_aligned"); });
test("UTC boundary converts to previous Arizona date rather than UTC substring", () => { const f=fixture();
  f.source.invoices[0].dueDate="2026-11-03T06:59:59Z";
  assert.equal(planOpportunityDueDate(f).intent?.targetValue, "2026-11-02"); });
const dateHolds: [string, (f: ReturnType<typeof fixture>) => void, string][] = [
  ["no shared contact field", f=>{f.field.model="contact";f.field.key="contact.due_date"}, "opportunity_date_field_unverified"],
  ["no unknown field ID", f=>{f.field.id=""}, "opportunity_date_field_unverified"],
  ["no cross-location field", f=>{f.field.locationId="other"}, "opportunity_date_field_unverified"],
  ["no guessed date type", f=>{f.field.type="TEXT"}, "opportunity_date_field_unverified"],
  ["no absent API field assumption", f=>{f.field.currentValueKnown=false}, "current_date_value_unknown"],
  ["no undefined equals blank", f=>{f.field.currentValue=undefined}, "current_date_value_invalid"],
  ["no overwrite of different date", f=>{f.field.currentValue="2026-11-01"}, "existing_due_date_conflict"],
  ["no overwrite of invalid date", f=>{f.field.currentValue="11/2"}, "current_date_value_invalid"],
  ["no stale source", f=>{f.source.observedAt="2026-11-09T16:00:00Z"}, "source_or_card_stale"],
  ["no future observation", f=>{f.card.observedAt="2026-11-10T17:20:00Z"}, "source_or_card_stale"],
  ["no incomplete source", f=>{f.source.complete=false}, "source_snapshot_incomplete"],
  ["no fuzzy identity", f=>{f.binding.identityVerified=false}, "identity_or_invoice_card_unproven"],
  ["no hidden duplicate card", f=>{f.binding.uniqueInvoiceCardVerified=false}, "identity_or_invoice_card_unproven"],
  ["no cross-card write", f=>{f.card.id="opp-2"}, "card_scope_mismatch"],
  ["no cross-contact write", f=>{f.card.contactId="contact-2"}, "card_scope_mismatch"],
  ["no cross-pipeline write", f=>{f.card.pipelineId="pipeline-2"}, "card_scope_mismatch"],
  ["no reopen won card", f=>{f.card.status="won"}, "protected_card_status"],
  ["no changing Late Fee card date", f=>{f.card.stageId="late-fee"}, "protected_or_unverified_card_stage"],
  ["no aggregate amount as invoice balance", f=>{f.card.amountCents=20000}, "card_is_not_invoice_balance"],
  ["no wrong invoice owner", f=>{f.source.invoices[0].jobberClientId="other"}, "invoice_owner_mismatch_or_missing"],
  ["no duplicate invoice IDs", f=>{f.source.invoices.push({...f.source.invoices[0]})}, "source_id_invalid_or_duplicate"],
  ["no second unpaid cycle inference", f=>{f.source.invoices.push({...f.source.invoices[0],id:"invoice-2"})}, "multiple_or_missing_unpaid_cycles"],
  ["no legacy unresolved debt", f=>{f.source.invoices.push({...f.source.invoices[0],id:"legacy",status:"bad_debt"})}, "source_status_unresolved"],
  ["no paid positive balance", f=>{f.source.invoices[0].status="paid"}, "contradictory_paid_balance"],
  ["no paid reminder", f=>{f.source.invoices[0].status="paid";f.source.invoices[0].balanceCents=0}, "invoice_not_collectible"],
  ["no zero unsettled balance", f=>{f.source.invoices[0].balanceCents=0}, "unsettled_zero_balance"],
  ["no impossible source amount", f=>{f.source.invoices[0].balanceCents=9900}, "invalid_source_amount"],
  ["no missing due date", f=>{f.source.invoices[0].dueDate=null}, "invalid_source_clock"],
  ["no invalid leap day", f=>{f.source.invoices[0].dueDate="2026-02-29"}, "invalid_source_clock"],
  ["no offsetless timestamp", f=>{f.source.invoices[0].dueDate="2026-11-02T00:00:00"}, "invalid_source_clock"],
  ["no early past due", f=>{f.source.invoices[0].dueDate="2026-11-10"}, "contradictory_early_past_due"],
];
for (const [name, edit, reason] of dateHolds) test(name, () => { const f=fixture();edit(f);const p=planOpportunityDueDate(f);
  assert.equal(p.state,"held");assert.ok(p.reasons.includes(reason),JSON.stringify(p));assert.equal(p.intent,undefined); });
test("settled history does not hide the unique unpaid invoice", () => { const f=fixture();f.source.invoices.push({
  ...f.source.invoices[0],id:"old-paid",status:"paid",balanceCents:0});assert.equal(planOpportunityDueDate(f).state,"repair_candidate"); });
test("explicit invoice reference can distinguish multiple cycles, not by name", () => { const f=fixture();
  f.binding.method="explicit_invoice_reference";f.source.invoices.push({...f.source.invoices[0],id:"invoice-2"});
  assert.equal(planOpportunityDueDate(f).state,"repair_candidate"); });
test("fingerprint ignores observation time but invalidates due/payment/membership changes", () => { const f=fixture();
  const initial=resolveInvoiceBinding(f);assert.ok(initial.ok);
  f.source.observedAt="2026-11-09T17:19:00Z";const same=resolveInvoiceBinding(f);assert.ok(same.ok);assert.equal(same.fingerprint,initial.fingerprint);
  f.source.invoices.push({...f.source.invoices[0],id:"old-paid",status:"paid",balanceCents:0});
  const changed=resolveInvoiceBinding(f);assert.ok(changed.ok);assert.notEqual(changed.fingerprint,initial.fingerprint);
});
test("fully proven future reminder is only a review candidate, not a resume", () => {
  const p=reconcileRetainedReminder(fixture());assert.equal(p.state,"future_candidate_for_review");assert.equal(p.capabilities.resume,false);
  assert.equal(p.expectedMilestoneOn,"2026-11-12"); });
const waitHolds: [string,(f:ReturnType<typeof fixture>)=>void,string][] = [
  ["current unique card cannot prove historical trigger", f=>{f.execution.triggerOpportunityId=null},"execution_opportunity_binding_unproven"],
  ["opportunity alone cannot prove old invoice cycle", f=>{f.execution.enrolledInvoiceId=null},"execution_invoice_cycle_unproven"],
  ["new invoice cannot inherit prior wait", f=>{f.execution.enrolledInvoiceId="old-invoice"},"execution_invoice_cycle_unproven"],
  ["changed due date cannot inherit prior wait", f=>{f.execution.enrolledDueOn="2026-11-01"},"enrolled_cycle_date_or_service_changed"],
  ["changed service cannot inherit prior wait", f=>{f.execution.enrolledCategory="irrigation"},"enrolled_cycle_date_or_service_changed"],
  ["contact delivery is not invoice delivery", f=>{f.execution.historyInvoiceAttributed=false},"message_history_not_invoice_attributed"],
  ["accepted message prevents replay", f=>{f.execution.priorAttempt="accepted"},"milestone_already_attempted"],
  ["unknown send outcome prevents replay", f=>{f.execution.priorAttempt="unknown"},"prior_attempt_uncertain"],
  ["current-stage guard required", f=>{f.execution.currentStageGuardVerified=false},"fresh_guard_before_next_action_unverified"],
  ["old version not assumed patched", f=>{f.execution.currentWorkflowVersionVerified=false},"queued_workflow_version_unverified"],
  ["unknown DND is not opt in", f=>{f.execution.channelAllowed=null},"recipient_or_channel_unverified"],
  ["email fallback requires approved policy", f=>{f.execution.channel="email"},"homeowner_email_fallback_unapproved"],
  ["duplicate executions cannot both continue", f=>{f.pendingMilestoneCount=2},"pending_milestone_not_unique_or_unknown"],
  ["partial queue cannot prove no duplicates", f=>{f.executionSnapshotComplete=false},"pending_milestone_not_unique_or_unknown"],
  ["unproven fee claim held", f=>{f.execution.messageFactsVerified=false},"message_claims_unverified"],
  ["contact invoice_total cannot supply invoice amount", f=>{f.execution.amountSource="contact_field"},"message_amount_not_invoice_bound"],
  ["blank date cannot run", f=>{f.execution.dateFieldReadback=null},"date_field_not_verified"],
  ["elapsed wait never catch-up", f=>{f.execution.nextScheduledAt=f.now},"elapsed_wait_requires_explicit_backlog_decision"],
  ["relative stage clock cannot replace due milestone", f=>{f.execution.nextScheduledAt="2026-11-13T17:00:00Z"},"relative_wait_misses_source_milestone"],
  ["irrigation has no day20 text", f=>{f.source.invoices[0].category="irrigation";f.execution.enrolledCategory="irrigation";f.execution.dayPastDue=20},"service_milestone_unverified"],
  ["never plan while published", f=>{f.execution.workflowState="published"},"workflow_not_paused"],
  ["Sent card cannot pass an Overdue reminder guard", f=>{f.card.stageId="sent"},"card_not_currently_overdue"],
];
for(const[name,edit,reason]of waitHolds)test(name,()=>{const f=fixture();edit(f);const p=reconcileRetainedReminder(f);
  assert.equal(p.state,"held");assert.ok(p.reasons.includes(reason),JSON.stringify(p));assert.equal(p.capabilities.resume,false);});
function closureFixture() { const f=fixture();f.source.invoices[0].status="paid";f.source.invoices[0].balanceCents=0;f.card.amountCents=0;f.card.stageId="paid";
  return { now:f.now,source:f.source,jobberClientId:"owner-1",locationId:"location-1",contactId:"contact-1",card:f.card,
    invoicePipelineId:"pipeline-1",paidStageId:"paid",
    identity:{verified:true,uniqueInvoiceCardVerified:true,evidenceRef:"synthetic-proof",jobberClientId:"owner-1",
      locationId:"location-1",contactId:"contact-1",opportunityId:"opp-1",pipelineId:"pipeline-1"},
    execution:{executionId:"closure-1",workflowState:"draft",triggerOpportunityId:"opp-1",exactOpportunityContextVerified:true,
      paidStageEnteredAt:"2026-11-05T16:59:55Z",enrolledAt:"2026-11-05T16:59:58Z",waitStartedAt:"2026-11-05T17:00:00Z",
      enrolledSourceFingerprint:null as string|null,nextScheduledAt:"2026-11-12T17:00:00Z",action:"update_opportunity" as const,
      freshPaidGuardVerified:true,currentWorkflowVersionVerified:true} }; }
test("paid closure candidate requires exact cycle evidence",()=>{const f=closureFixture();const first=reconcilePaidClosure(f);
  assert.ok(first.reasons.includes("paid_cycle_changed_or_unproven"));f.execution.enrolledSourceFingerprint=first.sourceFingerprint!;
  assert.equal(reconcilePaidClosure(f).state,"future_candidate_for_review"); });
test("legacy Create/Update is never a safe exact-target closure",()=>{const f=closureFixture();
  const p=reconcilePaidClosure({...f,execution:{...f.execution,action:"legacy_create_update"}});
  assert.ok(p.reasons.includes("legacy_action_does_not_target_trigger")); });
test("new unpaid cycle blocks old paid closure",()=>{const f=closureFixture();
  f.source.invoices.push({...f.source.invoices[0],id:"new-cycle",status:"awaiting_payment",balanceCents:9800});
  assert.ok(reconcilePaidClosure(f).reasons.includes("source_has_unpaid_or_unresolved_invoice")); });
test("paid stage/card zero is not proof source balance zero",()=>{const f=closureFixture();f.source.invoices[0].balanceCents=9800;
  assert.ok(reconcilePaidClosure(f).reasons.includes("source_has_unpaid_or_unresolved_invoice")); });
test("elapsed closure wait never immediately closes on resume",()=>{const f=closureFixture();f.execution.nextScheduledAt=f.now;
  assert.ok(reconcilePaidClosure(f).reasons.includes("elapsed_or_unknown_closure_wait")); });
test("zero balance does not excuse a different current stage",()=>{const f=closureFixture();f.card.stageId="overdue";
  assert.ok(reconcilePaidClosure(f).reasons.includes("card_not_in_verified_paid_stage")); });
test("paid stage name alone cannot cross pipelines",()=>{const f=closureFixture();f.card.pipelineId="different-pipeline";
  assert.ok(reconcilePaidClosure(f).reasons.includes("card_not_in_verified_paid_stage")); });
test("another paid owner cannot authorize closure on this card",()=>{const f=closureFixture();f.identity.jobberClientId="other-owner";
  assert.ok(reconcilePaidClosure(f).reasons.includes("paid_source_card_identity_unproven")); });
test("Paid closure must prove seven days from the retained wait anchor",()=>{const f=closureFixture();f.execution.waitStartedAt=f.now;
  assert.ok(reconcilePaidClosure(f).reasons.includes("seven_day_paid_wait_anchor_unproven")); });
test("unknown paid-stage entry cannot clear closure",()=>{const f=closureFixture();f.execution.paidStageEnteredAt=null as unknown as string;
  assert.ok(reconcilePaidClosure(f).reasons.includes("seven_day_paid_wait_anchor_unproven")); });
test("event key is channel independent",()=>{const f=fixture(),sms=reconcileRetainedReminder(f);f.execution.channel="email";f.homeownerEmailFallbackApproved=true;
  assert.equal(reconcileRetainedReminder(f).eventKey,sms.eventKey); });
test("missing nested inputs hold, not throw",()=>{
  for(const f of [undefined,{}, {source:{},card:{}}, {...fixture(),binding:null}]){
    assert.equal(planOpportunityDueDate(f as never).state,"held");assert.equal(reconcileRetainedReminder(f as never).state,"held");
  }
  for(const f of [undefined,{}, {source:{},card:{}}, {...closureFixture(),execution:null}])assert.equal(reconcilePaidClosure(f as never).state,"held");
});
test("string false cannot satisfy closure guards",()=>{const f=closureFixture();
  f.execution.freshPaidGuardVerified="false" as never;f.execution.currentWorkflowVersionVerified="false" as never;
  assert.ok(reconcilePaidClosure(f).reasons.includes("fresh_paid_guard_or_version_unverified")); });
test("string false cannot satisfy source completeness",()=>{const f=closureFixture();f.source.complete="false" as never;
  assert.ok(reconcilePaidClosure(f).reasons.includes("source_or_card_incomplete_or_stale")); });
test("malformed source rows hold",()=>{const f=closureFixture();f.source.invoices.push(null as never);
  assert.ok(reconcilePaidClosure(f).reasons.includes("invalid_source_membership")); });
test("batch detects SMS/email duplicates across different executions",()=>{const f=fixture(),second=structuredClone(f);
  second.execution.executionId="execution-2";second.execution.channel="email";second.homeownerEmailFallbackApproved=true;
  const rows=reconcileRetainedReminderBatch([f,second],true);assert.equal(rows.length,2);
  assert.ok(rows.every(r=>r.state==="held" && r.reasons.includes("pending_milestone_not_unique_or_unknown"))); });
test("batch does not merge distinct invoices or audiences",()=>{const f=fixture(),second=structuredClone(f);
  second.execution.executionId="execution-2";second.binding.invoiceId="invoice-2";second.source.invoices[0].id="invoice-2";second.execution.enrolledInvoiceId="invoice-2";
  assert.ok(reconcileRetainedReminderBatch([f,second],true).every(r=>r.state==="future_candidate_for_review")); });
test("partial retained snapshot never proves uniqueness",()=>{
  assert.ok(reconcileRetainedReminderBatch([fixture()],false)[0].reasons.includes("pending_milestone_not_unique_or_unknown")); });
test("an unresolved retained row makes apparent uniqueness unknown",()=>{
  const rows=reconcileRetainedReminderBatch([fixture(),{...fixture(),binding:null} as never],true);
  assert.ok(rows[0].reasons.includes("pending_milestone_not_unique_or_unknown"));assert.ok(rows.every(r=>r.state==="held")); });
test("an unbound original invoice in another row cannot prove no duplicate",()=>{const second=fixture();second.execution.executionId="execution-2";
  second.execution.enrolledInvoiceId=null;second.binding.invoiceId="different-candidate";
  assert.ok(reconcileRetainedReminderBatch([fixture(),second],true)[0].reasons.includes("pending_milestone_not_unique_or_unknown")); });
test("duplicate execution IDs are held even for distinct milestones",()=>{const f=fixture(),second=structuredClone(f);
  second.execution.dayPastDue=15;second.execution.nextScheduledAt="2026-11-17T17:00:00Z";
  assert.ok(reconcileRetainedReminderBatch([f,second],true).every(r=>r.reasons.includes("pending_milestone_not_unique_or_unknown"))); });
test("future paid closure still cannot write",()=>{const f=closureFixture();f.execution.enrolledSourceFingerprint=reconcilePaidClosure(f).sourceFingerprint!;
  const p=reconcilePaidClosure(f);assert.equal(p.state,"future_candidate_for_review");assert.ok(Object.values(p.capabilities).every(x=>x===false));});
