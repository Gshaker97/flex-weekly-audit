/** Journal-owned next-invoice reset. No schema, message engine or removal API.
 * Native cleanup semantics are NOT inferred from Paid/zero or a blank date.
 * The default adapter deliberately withholds proof until verified provider QA.
 */
import { acknowledgeOwnedWorkflowRemoval, removalIntent } from "./ghl-direct-removal";
import { removeContactFromWorkflowOnce } from "./ghl";
import { readConfiguredStandingIdentityPolicy } from "./ghl-standing-identity";
import { readOpportunity, setOpportunityDueDate, moveOpportunityToStage, readWorkflowStates, type GhlOpportunity } from "./ghl";
import { assertSnapshotWriteFreshness, assertSnapshotIdentityCoverage, cloneVerifiedSnapshot, readVerifiedCycleResetSnapshot, type DateReadinessScope } from "./ghl-date-readiness";
import { cardScopeMatches, type DateRepairSnapshot } from "./ghl-opportunity-date-repair";
import { resolveInvoiceBinding } from "./invoice-workflow-binding";
import { SyncWriterBlockedError, latestCycleOwner, cardNameHash, type CycleJournalEntry, type GhlWriteIntent, type SyncRunWriter } from "./sync-writer-control";
import { approvedGhlCards } from "./ghl-write-intent";
import { verifyPaidCycleWorkflowInventory } from "./ghl-paid-cycle-workflows";
import { readRecurringEffectsPolicy, DUE_DATE_FIELD, DUE_DATE_LOCATION } from "./ghl-recurring-due-date";

type CleanupProofBase = {
  locationId: string; workflowId: string; opportunityId: string; contactId: string;
  jobberClientId: string; invoiceId: string; oldEnrollmentJournalId: string; oldPaidJournalId: string;
  contractSha256: string; observedAt: string; evidenceRef: string;
};
export type NativeCleanupProof = CleanupProofBase & {
  kind: "ordered_native_clear" | "verified_terminal_execution"; noRelevantActiveExecution: true;
};
export type RemovalAcknowledgedProof = CleanupProofBase & {
  kind: "removal_acknowledged"; removalJournalId: string;
};
export type CleanupProofRequest = { scope: DateReadinessScope; oldEnrollment: CycleJournalEntry; oldPaid: CycleJournalEntry };
const defaults = {
  readFresh: (scope: DateReadinessScope) => {
    const policy = readConfiguredStandingIdentityPolicy(), pin = JSON.stringify(policy);
    return readVerifiedCycleResetSnapshot(scope, undefined, undefined, policy,
      () => JSON.stringify(readConfiguredStandingIdentityPolicy()) === pin);
  }, readCard: readOpportunity,
  updateDate: setOpportunityDueDate, moveStage: moveOpportunityToStage, workflows: readWorkflowStates,
  // No supported native DATE-clear/completion barrier is established. Neither
  // adjacent nodes nor a static QA assertion prove removal. Missing proof holds.
  nativeCleanup: async (_request: CleanupProofRequest): Promise<NativeCleanupProof | null> => null,
};
type Writer = Pick<SyncRunWriter,"prepare"|"assertPending"|"confirm"|"block"|"readCycleHistory">;
const canonicalCard = (c:GhlOpportunity) => JSON.stringify([c.id,c.locationId,c.pipelineId,c.contactId,c.pipelineStageId,c.status,c.monetaryValue,c.name,
  (c.customFields??[]).slice().sort((a,b)=>a.id.localeCompare(b.id))]);
const sourceIntent = (s:DateRepairSnapshot):GhlWriteIntent["source"] => ({ observedAt:s.source.observedAt,
  storedInvoiceIds:s.source.invoices.map(i=>i.id).sort(), invoices:s.source.invoices.map(i=>({id:i.id,jobberClientId:i.jobberClientId,invoiceStatus:i.status,
    totalCents:i.totalCents,balanceCents:i.balanceCents,issuedDate:i.issuedDate,dueDate:i.dueDate,createdAt:null})).sort((a,b)=>a.id.localeCompare(b.id)) });
export async function resetJournalOwnedInvoiceCycle(input:{ scope:DateReadinessScope; expectedCard:GhlOpportunity; name?:string;
  writer:Writer; mode:string; phoneOwner:boolean; env?:Record<string,string|undefined>; now?:()=>Date; deps?:typeof defaults & { removeWorkflow?: typeof removeContactFromWorkflowOnce } }) {
  const env={...(input.env??process.env)}, now=input.now??(()=>new Date()), deps=input.deps??defaults;
  const hold=(reason:string)=>({state:"held" as const,reason});
  if(env.GHL_CYCLE_OWNERSHIP_ENABLED!=="true")return hold("cycle_ownership_disabled");
  if(env.GHL_RECURRING_DUE_DATE_ENABLED!=="true" || env.GHL_INVOICE_WRITE_MODE!=="sync" || input.mode!=="sync"
    || env.SYNC_ADMISSION_MODE!=="cron_only" || input.phoneOwner && env.GHL_PHONE_WRITES_ENABLED!=="true"
    || env.GHL_LOCATION_ID!==DUE_DATE_LOCATION || input.scope.locationId!==DUE_DATE_LOCATION
    || !approvedGhlCards(env).has(input.scope.opportunityId))return hold("existing_write_gates_not_satisfied");
  const policy=readRecurringEffectsPolicy(env,now(),true);
  const direct = env.GHL_DIRECT_WORKFLOW_REMOVAL_ENABLED === "true";
  const contract = direct ? policy?.directRemoval : policy?.nativeReset;
  if (!policy || !contract || !/^[a-f0-9]{64}$/.test(contract.contractSha256) || !contract.evidenceRef
      || (direct ? policy.directRemoval?.apiVersion !== "v3"
          || ![policy.directRemoval.residualDispatchAndExternalEnrollmentRiskAcceptanceRef,
            policy.directRemoval.singleCycleWriterReviewRef].every(v=>typeof v==="string" && v.trim().length>0 && v.length<=512)
        : policy.inventory.entries.find(w=>w.id===policy.nativeReset!.cleanupWorkflowId)?.status !== "published"))
    return hold(direct ? "direct_removal_operating_contract_missing" : "native_cleanup_contract_not_verified");
  const assertPolicy = () => {
    if (!readRecurringEffectsPolicy(env,now(),true)) throw new Error("Cycle policy expired");
    if (direct) {
      const current=input.env??process.env;
      for (const key of ["GHL_DIRECT_WORKFLOW_REMOVAL_ENABLED","GHL_CYCLE_OWNERSHIP_ENABLED","GHL_RECURRING_DUE_DATE_ENABLED",
        "GHL_RECURRING_DUE_DATE_POLICY","GHL_RECURRING_DUE_DATE_POLICY_SHA256","GHL_WRITE_APPROVAL_ID",
        "GHL_APPROVED_OPPORTUNITY_IDS","GHL_LOCATION_ID","GHL_INVOICE_WRITE_MODE","SYNC_ADMISSION_MODE","GHL_PHONE_WRITES_ENABLED"])
        if (current[key]!==env[key]) throw new Error("Direct removal authorization changed");
    }
  };
  let admitted=false;
  try {
    const history=await input.writer.readCycleHistory();
    const own=history.filter(w=>w.state==="confirmed" && w.intent.opportunityId===input.scope.opportunityId && w.intent.contactId===input.scope.contactId
      && w.intent.jobberClientId===input.scope.jobberClientId && w.intent.cycle?.locationId===input.scope.locationId && w.intent.cycle.workflowId===policy.reminderId);
    // Legacy property names below refer to a cycle ownership journal, which can
    // be reset_stage for an invoice paid before it ever enrolled in Fixed.
    const oldEnrollment=latestCycleOwner(own,{...input.scope,pipelineId:policy.pipelineId,workflowId:policy.reminderId});
    const oldPaid=oldEnrollment && own.find(w=>w.intent.cycle?.phase==="paid" && w.intent.cycle.invoiceId===oldEnrollment.intent.cycle!.invoiceId);
    if(!oldEnrollment || !oldPaid || oldEnrollment.intent.cycle!.invoiceId===input.scope.invoiceId
      || oldPaid.intent.source.invoices.some(i=>i.id===input.scope.invoiceId))return hold("confirmed_paid_predecessor_or_distinct_later_invoice_missing");
    const witness=oldPaid.intent.cycle?.paidDateWitness;
    if(!witness || !oldPaid.paidDateReadback || witness.priorOwnershipJournalId!==oldEnrollment.id
      || witness.fieldId!==DUE_DATE_FIELD || witness.ownedValue!==oldEnrollment.intent.cycle!.dueOn)
      return hold("paid_owned_date_provenance_or_readback_missing");
    const request={scope:input.scope,oldEnrollment,oldPaid};
    let removalReceipt: CycleJournalEntry | undefined;
    const proof=async(captured?:NativeCleanupProof | RemovalAcknowledgedProof)=>{

      if(!readRecurringEffectsPolicy(env,now(),true))throw new Error("Cycle policy expired");
      await verifyPaidCycleWorkflowInventory(policy.inventory,policy.locationId,deps.workflows);
      if (!readRecurringEffectsPolicy(env,now(),true)) throw new Error("Cycle policy expired");
      const p: NativeCleanupProof | RemovalAcknowledgedProof | null = direct
        ? removalReceipt?.removalAcknowledgment ? {
          ...input.scope, workflowId:policy.reminderId, invoiceId:oldEnrollment.intent.cycle!.invoiceId,
          oldEnrollmentJournalId:oldEnrollment.id,oldPaidJournalId:oldPaid.id,
          contractSha256:contract.contractSha256,observedAt:removalReceipt.removalAcknowledgment.observedAt,
          evidenceRef:contract.evidenceRef,kind:"removal_acknowledged",removalJournalId:removalReceipt.id,
        } : null
        : captured ? structuredClone(captured) : await deps.nativeCleanup(request);
      const age=p?now().getTime()-Date.parse(p.observedAt):NaN;
      if(!p || p.locationId!==input.scope.locationId || p.workflowId!==policy.reminderId || p.opportunityId!==input.scope.opportunityId
        || p.contactId!==input.scope.contactId || p.jobberClientId!==input.scope.jobberClientId || p.invoiceId!==oldEnrollment.intent.cycle!.invoiceId
        || p.oldEnrollmentJournalId!==oldEnrollment.id || p.oldPaidJournalId!==oldPaid.id || p.contractSha256!==contract.contractSha256
        || (p.kind==="removal_acknowledged" ? !direct || p.removalJournalId!==removalReceipt?.id
          : p.noRelevantActiveExecution!==true || !["ordered_native_clear","verified_terminal_execution"].includes(p.kind))
        || !p.evidenceRef || !Number.isFinite(age) || age<0 || (p.kind!=="removal_acknowledged" && age>60_000)
        || Date.parse(p.observedAt)<Date.parse(p.kind==="removal_acknowledged"
          && removalReceipt?.intent.workflowRemoval?.purpose==="paid_cycle_cancellation" ? oldEnrollment.confirmedAt! : oldPaid.confirmedAt!))throw new Error("Exact native cycle cleanup acknowledgment unavailable");
      return structuredClone(p);
    };
    let expected=structuredClone(input.expectedCard);
    const fresh=async()=>{
      const s=cloneVerifiedSnapshot(await deps.readFresh(input.scope));s.now=now().toISOString();
      const invoice=s.source.invoices.find(i=>i.id===input.scope.invoiceId),old=s.source.invoices.find(i=>i.id===oldEnrollment.intent.cycle!.invoiceId);
      if(!invoice || !old || old.status!=="paid" || old.balanceCents!==0
        || !cardScopeMatches(s) || s.binding.method!=="unique_unpaid_invoice" || s.binding.invoiceId!==input.scope.invoiceId
        || s.binding.jobberClientId!==input.scope.jobberClientId || s.binding.locationId!==input.scope.locationId
        || s.binding.contactId!==input.scope.contactId || s.binding.opportunityId!==input.scope.opportunityId
        || s.binding.pipelineId!==policy.pipelineId || s.card.stageId!==oldPaid.intent.target.stageId || s.card.status!=="open" || s.card.amountCents!==0
        || s.field.id!==DUE_DATE_FIELD || s.field.key!=="opportunity.due_date" || s.field.model!=="opportunity" || s.field.type!=="DATE"
        || s.field.currentValueKnown!==true || canonicalCard(s.currentCard)!==canonicalCard(expected))throw new Error("Owned paid card or fresh source changed");
      // Validate the proposed next invoice with the existing complete-source and
      // exact-identity binding rules; current Paid/zero is separately proven above.
      const resolved=resolveInvoiceBinding({...s,card:{...s.card,stageId:s.stageIds.sent,amountCents:invoice.balanceCents}});
      if(!resolved.ok || s.stageIds.sent!==policy.sentStageId || s.stageIds.overdue!==policy.overdueStageId)throw new Error("Next invoice binding held");
      assertSnapshotIdentityCoverage(s);
      return {s,resolved};
    };
    let first: Awaited<ReturnType<typeof fresh>>;
    let initialProof: NativeCleanupProof | RemovalAcknowledgedProof;
    const oldDue=oldEnrollment.intent.cycle!.dueOn;
    if (direct) {
      first=await fresh();
      if (first.s.field.currentValue!==oldDue) return hold("date_not_proven_owned");
      const originalFingerprint=first.resolved.fingerprint;
      const originalSource=JSON.stringify(first.s.source.invoices);
      removalReceipt=await acknowledgeOwnedWorkflowRemoval({
        writer:input.writer,intent:removalIntent(first.s,oldEnrollment,oldPaid,env.GHL_WRITE_APPROVAL_ID!,contract.contractSha256),
        now,assertCurrent:assertPolicy,remove:input.deps?.removeWorkflow,
        recheck:async()=>{
          const f=await fresh();
          if (f.resolved.fingerprint!==originalFingerprint || JSON.stringify(f.s.source.invoices)!==originalSource
              || f.s.field.currentValue!==oldDue) throw new Error("Source or owned date changed before removal");
          await verifyPaidCycleWorkflowInventory(policy.inventory,policy.locationId,deps.workflows);
          if (!readRecurringEffectsPolicy(env,now(),true)) throw new Error("Cycle policy expired");
          assertSnapshotIdentityCoverage(f.s);return f.s;
        },
      });
      initialProof=await proof();first=await fresh();
    } else { initialProof=await proof();first=await fresh(); }
    const blank=first.s.field.currentValue===null || first.s.field.currentValue==="";
    if(initialProof.kind==="ordered_native_clear" ? !blank : first.s.field.currentValue!==oldDue)return hold("date_not_proven_owned_or_native_cleared");
    const fingerprint=first.resolved.fingerprint;
    let dateConfirmed=false;
    const recheck=async()=>{const f=await fresh();if(f.resolved.fingerprint!==fingerprint)throw new Error("Source changed during cycle reset");
      const p=await proof(dateConfirmed ? initialProof : undefined);if(p.kind!==initialProof.kind)throw new Error("Native cleanup proof changed");assertSnapshotIdentityCoverage(f.s);return { ...f,p };};
    const before={stageId:first.s.card.stageId,status:"open" as const,amountCents:0,nameHash:cardNameHash(expected.name)};
    const cycle={version:1 as const,locationId:input.scope.locationId,workflowId:policy.reminderId,invoiceId:input.scope.invoiceId,dueOn:first.resolved.dueOn,
      predecessorInvoiceId:oldEnrollment.intent.cycle!.invoiceId,cleanup:{contractSha256:initialProof.contractSha256,observedAt:initialProof.observedAt,
        evidenceRef:initialProof.evidenceRef,oldEnrollmentJournalId:oldEnrollment.id,oldPaidJournalId:oldPaid.id,orderedClearAcknowledged:initialProof.kind==="ordered_native_clear",
        ...(initialProof.kind==="removal_acknowledged"?{removalJournalId:initialProof.removalJournalId}:{})}};
    const dateIntent:GhlWriteIntent={approvalId:env.GHL_WRITE_APPROVAL_ID,pipelineId:policy.pipelineId,contactId:input.scope.contactId,
      opportunityId:input.scope.opportunityId,jobberClientId:input.scope.jobberClientId,expected:before,target:{...before,updateName:false},source:sourceIntent(first.s),
      cycle:{...cycle,phase:"reset_date"},dateField:{locationId:input.scope.locationId,fieldId:DUE_DATE_FIELD,key:"opportunity.due_date",invoiceId:input.scope.invoiceId,
        expectedValue:first.s.field.currentValue as string|null,targetValue:first.resolved.dueOn,sourceFingerprint:fingerprint}};
    assertSnapshotIdentityCoverage(first.s);
    admitted=true;const dateId=await input.writer.prepare(dateIntent);await input.writer.assertPending(dateId);const finalDate=await recheck();await input.writer.assertPending(dateId);
    assertSnapshotWriteFreshness(finalDate.s,now());assertPolicy();
    await deps.updateDate(input.scope.opportunityId,DUE_DATE_FIELD,first.resolved.dueOn);
    const afterDate=await deps.readCard(input.scope.opportunityId);
    expected={...expected,customFields:[...(expected.customFields??[]).filter(v=>v.id!==DUE_DATE_FIELD),{id:DUE_DATE_FIELD,fieldValue:first.resolved.dueOn}]};
    if(canonicalCard(afterDate)!==canonicalCard(expected))throw new Error("Cycle date-only readback unconfirmed");
    await input.writer.confirm(dateId);
    // Our own date PUT consumes a blank-field acknowledgment. Keep that exact
    // immutable observation (never refresh its timestamp), rechecking its age,
    // source/card and pinned workflows rather than asking for blank again.
    dateConfirmed=true;
    const next=await recheck();
    const stageIntent:GhlWriteIntent={...dateIntent,dateField:undefined,cycle:{...cycle,phase:"reset_stage"},source:sourceIntent(next.s),
      target:{stageId:policy.sentStageId,amountCents:first.resolved.invoice.balanceCents,nameHash:cardNameHash(input.name??expected.name),updateName:input.name!==undefined}};
    assertSnapshotIdentityCoverage(next.s);
    const stageId=await input.writer.prepare(stageIntent);await input.writer.assertPending(stageId);const finalStage=await recheck();await input.writer.assertPending(stageId);
    assertSnapshotWriteFreshness(finalStage.s,now());assertPolicy();
    await deps.moveStage(input.scope.opportunityId,policy.sentStageId,first.resolved.invoice.balanceCents/100,input.name);
    const afterStage=await deps.readCard(input.scope.opportunityId);
    if(canonicalCard(afterStage)!==canonicalCard({...expected,pipelineStageId:policy.sentStageId,monetaryValue:first.resolved.invoice.balanceCents/100,name:input.name??expected.name}))throw new Error("Cycle Sent reset readback unconfirmed");
    await input.writer.confirm(stageId);return {state:"applied" as const,invoiceId:input.scope.invoiceId,dueOn:first.resolved.dueOn};
  } catch(error) {if(!admitted && !(direct && error instanceof SyncWriterBlockedError))return hold(error instanceof Error?error.message:"Cycle proof unavailable");await input.writer.block();throw error;}
}
