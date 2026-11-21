/** Cancel only an owned paid invoice's old workflow. Never mark aggregate debt Paid. */
import {readConfiguredStandingIdentityPolicy} from "./ghl-standing-identity";
import {readVerifiedCycleResetSnapshot,cloneVerifiedSnapshot,assertSnapshotIdentityCoverage,type DateReadinessScope} from "./ghl-date-readiness";
import {readWorkflowStates,removeContactFromWorkflowOnce,type GhlOpportunity} from "./ghl";
import {readRecurringEffectsPolicy,DUE_DATE_LOCATION,DUE_DATE_FIELD} from "./ghl-recurring-due-date";
import {verifyPaidCycleWorkflowInventory} from "./ghl-paid-cycle-workflows";
import {acknowledgeOwnedWorkflowRemoval,assertRemovalSnapshotFreshness} from "./ghl-direct-removal";
import {approvedGhlCards} from "./ghl-write-intent";
import {latestCycleOwner,cardNameHash,type GhlWriteIntent,type SyncRunWriter} from "./sync-writer-control";
const defaults={
 readFresh:(scope:DateReadinessScope)=>{
  const p=readConfiguredStandingIdentityPolicy(),pin=JSON.stringify(p);
  return readVerifiedCycleResetSnapshot(scope,undefined,undefined,p,()=>JSON.stringify(readConfiguredStandingIdentityPolicy())===pin);
 },workflows:readWorkflowStates,remove:removeContactFromWorkflowOnce,
};
const card=(c:GhlOpportunity)=>JSON.stringify([c.id,c.locationId,c.pipelineId,c.contactId,c.pipelineStageId,c.status,c.monetaryValue,c.name,
 (c.customFields??[]).slice().sort((a,b)=>a.id.localeCompare(b.id))]);
export async function cancelPaidOwnedInvoiceCycle(input:{
 scope:Omit<DateReadinessScope,"invoiceId">;expectedCard:GhlOpportunity;mode:string;phoneOwner:boolean;
 writer:Pick<SyncRunWriter,"readCycleHistory"|"prepare"|"assertPending"|"confirm"|"block">;
 env?:Record<string,string|undefined>;now?:()=>Date;deps?:typeof defaults;
}){
 const currentEnv=()=>input.env??process.env,env={...currentEnv()},now=input.now??(()=>new Date()),deps=input.deps??defaults;
 const hold=(reason:string)=>({state:"held" as const,reason});
 if(env.GHL_DIRECT_WORKFLOW_REMOVAL_ENABLED!=="true" || env.GHL_CYCLE_OWNERSHIP_ENABLED!=="true"
  || env.GHL_RECURRING_DUE_DATE_ENABLED!=="true")return {state:"not_applicable" as const};
 if(input.mode!=="sync" || env.GHL_INVOICE_WRITE_MODE!=="sync" || env.SYNC_ADMISSION_MODE!=="cron_only"
  || input.phoneOwner && env.GHL_PHONE_WRITES_ENABLED!=="true" || input.scope.locationId!==DUE_DATE_LOCATION
  || env.GHL_LOCATION_ID!==DUE_DATE_LOCATION || !approvedGhlCards(env).has(input.scope.opportunityId))return hold("Cancellation write gates missing");
 const history=await input.writer.readCycleHistory();
 const owner=latestCycleOwner(history,{...input.scope,pipelineId:input.expectedCard.pipelineId!});
 if(!owner || owner.intent.cycle!.phase!=="enroll")return {state:"not_applicable" as const};
 const policy=readRecurringEffectsPolicy(env,now(),true),contract=policy?.directRemoval;
 if(!policy || !contract || contract.apiVersion!=="v3" || !/^[a-f0-9]{64}$/.test(contract.contractSha256)
  || ![contract.evidenceRef,contract.singleCycleWriterReviewRef,contract.residualDispatchAndExternalEnrollmentRiskAcceptanceRef]
    .every(v=>typeof v==="string" && v.trim().length>0 && v.length<=512)
  || policy.reminderId!==owner.intent.cycle!.workflowId || policy.pipelineId!==input.expectedCard.pipelineId)
  return hold("Reviewed direct cancellation contract missing");
 const assertCurrent=()=>{
  if(!readRecurringEffectsPolicy(env,now(),true))throw new Error("Cancellation policy expired");
  for(const k of ["GHL_DIRECT_WORKFLOW_REMOVAL_ENABLED","GHL_CYCLE_OWNERSHIP_ENABLED","GHL_RECURRING_DUE_DATE_ENABLED",
   "GHL_RECURRING_DUE_DATE_POLICY","GHL_RECURRING_DUE_DATE_POLICY_SHA256","GHL_WRITE_APPROVAL_ID","GHL_LOCATION_ID",
   "GHL_APPROVED_OPPORTUNITY_IDS","GHL_INVOICE_WRITE_MODE","SYNC_ADMISSION_MODE","GHL_PHONE_WRITES_ENABLED"])
   if(currentEnv()[k]!==env[k])throw new Error("Cancellation authorization changed");
 };
 const scope={...input.scope,invoiceId:owner.intent.cycle!.invoiceId};
 const first=cloneVerifiedSnapshot(await deps.readFresh(scope));
 const paid=first.source.invoices.find(i=>i.id===scope.invoiceId);
 if(!paid || paid.status!=="paid" || paid.balanceCents!==0)return {state:"not_applicable" as const};
 const unpaid=first.source.invoices.filter(i=>i.status!=="paid" || i.balanceCents!==0);
 if(!unpaid.length)return {state:"not_applicable" as const};
 if(unpaid.some(i=>i.id===scope.invoiceId))return hold("Owned invoice settlement is contradictory");
 const validate=(s:typeof first)=>{
  if(!s.source.complete || !s.binding.identityVerified || !s.binding.uniqueInvoiceCardVerified
   || s.binding.locationId!==scope.locationId || s.binding.contactId!==scope.contactId || s.binding.opportunityId!==scope.opportunityId
   || s.binding.jobberClientId!==scope.jobberClientId || s.binding.invoiceId!==scope.invoiceId
   || s.binding.pipelineId!==policy.pipelineId || card(s.currentCard)!==card(input.expectedCard)
   || s.currentCard.status!=="open" || ![policy.sentStageId,policy.overdueStageId].includes(s.currentCard.pipelineStageId!)
   || s.field.id!==DUE_DATE_FIELD || s.field.key!=="opportunity.due_date" || s.field.type!=="DATE"
   || s.field.model!=="opportunity" || s.field.currentValueKnown!==true || s.field.currentValue!==owner.intent.cycle!.dueOn
   || JSON.stringify(s.source.invoices)!==JSON.stringify(first.source.invoices))throw new Error("Owned cancellation source/card/date changed");
  assertSnapshotIdentityCoverage(s);assertRemovalSnapshotFreshness(s,now());assertCurrent();
 };
 validate(first);
 const expected={stageId:first.card.stageId,status:"open" as const,amountCents:first.card.amountCents,nameHash:cardNameHash(first.currentCard.name)};
 const intent:GhlWriteIntent={approvalId:env.GHL_WRITE_APPROVAL_ID,pipelineId:policy.pipelineId,contactId:scope.contactId,
  opportunityId:scope.opportunityId,jobberClientId:scope.jobberClientId,expected,target:{...expected,updateName:false},
  source:{observedAt:first.source.observedAt,storedInvoiceIds:first.source.invoices.map(i=>i.id).sort(),
   invoices:first.source.invoices.map(i=>({id:i.id,jobberClientId:i.jobberClientId,invoiceStatus:i.status,totalCents:i.totalCents,
    balanceCents:i.balanceCents,issuedDate:i.issuedDate,dueDate:i.dueDate,createdAt:null})).sort((a,b)=>a.id.localeCompare(b.id))},
  workflowRemoval:{version:1,apiVersion:"v3",locationId:scope.locationId,workflowId:policy.reminderId,invoiceId:scope.invoiceId,
   oldOwnershipJournalId:owner.id,contractSha256:contract.contractSha256,purpose:"paid_cycle_cancellation",
   ownedDateWitness:{fieldId:DUE_DATE_FIELD,value:owner.intent.cycle!.dueOn,observedAt:first.card.observedAt}}};
 const reused=history.some(w=>w.intent.workflowRemoval?.oldOwnershipJournalId===owner.id);
 await acknowledgeOwnedWorkflowRemoval({writer:input.writer,intent,remove:deps.remove,now,assertCurrent,recheck:async()=>{
  const s=cloneVerifiedSnapshot(await deps.readFresh(scope));validate(s);
  await verifyPaidCycleWorkflowInventory(policy.inventory,scope.locationId,deps.workflows);
  validate(s);return s;
 }});
 return {state:"cancelled" as const,reused,invoiceId:scope.invoiceId};
}
