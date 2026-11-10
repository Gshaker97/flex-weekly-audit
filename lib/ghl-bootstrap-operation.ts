/** Disabled exact-cohort bridge to real readiness, durable writer and GHL transport.
 * Journal history is not provider execution history: reviewed exclusive automated
 * writer inventory is required; manual/external enrollment remains residual risk.
 */
import { createHash } from 'node:crypto';
import { bootstrapExistingOverdue, type BootstrapAdapter, type BootstrapClaim, type BootstrapPlanInput } from './ghl-existing-overdue-bootstrap';
import { readConfiguredStandingIdentityPolicy } from './ghl-standing-identity';
import { assertSnapshotWriteFreshness, assertSnapshotIdentityCoverage, readVerifiedCycleResetSnapshot, type DateReadinessScope } from './ghl-date-readiness';
import { cardScopeMatches, dateJournalIntent, type DateRepairSnapshot } from './ghl-opportunity-date-repair';
import { readOpportunity, readWorkflowStates, moveOpportunityToStage, setOpportunityDueDate, type GhlOpportunity } from './ghl';
import { readRecurringEffectsPolicy, DUE_DATE_FIELD, DUE_DATE_LOCATION } from './ghl-recurring-due-date';
import { verifyPaidCycleWorkflowInventory } from './ghl-paid-cycle-workflows';
import { approvedGhlCards } from './ghl-write-intent';
import { moneyCents } from './ghl-phone-state';
import { cardNameHash, type GhlWriteIntent, type SyncRunWriter } from './sync-writer-control';
const defaults = {
  readFresh: (scope:DateReadinessScope) => {
    const policy=readConfiguredStandingIdentityPolicy(), pin=JSON.stringify(policy);
    return readVerifiedCycleResetSnapshot(scope,undefined,undefined,policy,()=>JSON.stringify(readConfiguredStandingIdentityPolicy())===pin);
  }, workflows:readWorkflowStates, readCard:readOpportunity, moveStage:moveOpportunityToStage, updateDate:setOpportunityDueDate,
};
type Writer=Pick<SyncRunWriter,'prepare'|'assertPending'|'confirm'|'readCycleHistory'|'block'>;
const sha=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
// Compare all supported opportunity business fields, not provider updatedAt or
// other transport-only metadata that necessarily changes after a write.
const card=(c:GhlOpportunity)=>({id:c.id,name:c.name,pipelineId:c.pipelineId,pipelineStageId:c.pipelineStageId,
  contactId:c.contactId,status:c.status,monetaryValue:c.monetaryValue,locationId:c.locationId,
  customFields:(c.customFields??[]).slice().sort((a,b)=>a.id.localeCompare(b.id))});
const same=(a:GhlOpportunity,b:GhlOpportunity)=>JSON.stringify(card(a))===JSON.stringify(card(b));
const ref=(v:unknown)=>typeof v==='string' && v.trim().length>0 && v.length<=512;
export async function syncExistingOverdueBootstrap(input:{scope:DateReadinessScope;expectedCard:GhlOpportunity;
  target:{stageId:string;monetaryValue:number;name?:string};mode:string;phoneOwner:boolean;writer:Writer;
  env?:Record<string,string|undefined>;now?:()=>Date;deps?:typeof defaults}) {
 const env={...(input.env??process.env)}, now=input.now??(()=>new Date()), deps=input.deps??defaults;
 const held=(reason:string)=>({state:'held' as const,reason});
 if(env.GHL_EXISTING_OVERDUE_BOOTSTRAP_ENABLED!=='true')return held('existing_overdue_bootstrap_disabled');
 if(env.GHL_CYCLE_OWNERSHIP_ENABLED!=='true'||env.GHL_RECURRING_DUE_DATE_ENABLED!=='true'||input.mode!=='sync'
   ||env.GHL_INVOICE_WRITE_MODE!=='sync'||env.SYNC_ADMISSION_MODE!=='cron_only'||input.phoneOwner&&env.GHL_PHONE_WRITES_ENABLED!=='true'
   ||input.scope.locationId!==DUE_DATE_LOCATION||env.GHL_LOCATION_ID!==DUE_DATE_LOCATION
   ||!approvedGhlCards(env).has(input.scope.opportunityId))return held('existing_write_gates_not_satisfied');
 const policy=readRecurringEffectsPolicy(env,now(),true), review=policy?.existingOverdueBootstrap;
 if(!policy||!review||![review.reviewRef,review.nativeSkipRouteQaRef,review.sentTransitionReviewRef,review.futureFactGuardReviewRef,review.exclusiveCycleWriterReviewRef].every(ref)
   ||input.expectedCard.pipelineId!==policy.pipelineId||input.expectedCard.pipelineStageId!==policy.overdueStageId
   ||input.target.stageId!==policy.overdueStageId||moneyCents(input.target.monetaryValue)!==moneyCents(input.expectedCard.monetaryValue))return held('bootstrap_operating_review_missing_or_target_changed');
 const assertPolicy=()=>{
   if(!readRecurringEffectsPolicy(env,now(),true))throw Error('Bootstrap policy expired');
   const current=input.env??process.env;
   for(const key of ['GHL_EXISTING_OVERDUE_BOOTSTRAP_ENABLED','GHL_CYCLE_OWNERSHIP_ENABLED','GHL_RECURRING_DUE_DATE_ENABLED',
     'GHL_RECURRING_DUE_DATE_POLICY','GHL_RECURRING_DUE_DATE_POLICY_SHA256','GHL_WRITE_APPROVAL_ID','GHL_APPROVED_OPPORTUNITY_IDS',
     'GHL_LOCATION_ID','GHL_INVOICE_WRITE_MODE','SYNC_ADMISSION_MODE','GHL_PHONE_WRITES_ENABLED'])
     if(current[key]!==env[key])throw Error('Bootstrap authorization changed');
 };
 let original:DateRepairSnapshot|undefined, expected=structuredClone(input.expectedCard), claim:BootstrapClaim|undefined;
 let digest='',admitted=false;
 const intents=new Map<string,GhlWriteIntent>();
 const base=(s:DateRepairSnapshot):GhlWriteIntent=>{
   const before={stageId:s.card.stageId,status:'open' as const,amountCents:s.card.amountCents,nameHash:cardNameHash(s.currentCard.name)};
   const owner=s.source.invoices.filter(i=>i.jobberClientId===input.scope.jobberClientId);
   return {approvalId:policy.approvalId,pipelineId:policy.pipelineId,contactId:input.scope.contactId,opportunityId:input.scope.opportunityId,
     jobberClientId:input.scope.jobberClientId,expected:before,target:{...before,updateName:false},
     source:{observedAt:s.source.observedAt,storedInvoiceIds:owner.map(i=>i.id).sort(),invoices:owner.map(i=>({id:i.id,jobberClientId:i.jobberClientId,
       invoiceStatus:i.status,totalCents:i.totalCents,balanceCents:i.balanceCents,issuedDate:i.issuedDate,dueDate:i.dueDate,createdAt:null})).sort((a,b)=>a.id.localeCompare(b.id))}};
 };
 const adapter:BootstrapAdapter={
  readFresh:async ownClaimId=>{
   assertPolicy();
   // Retain branded ORIGINAL. Never replace this reference with helper clones.
   const s=await deps.readFresh(input.scope);s.now=now().toISOString();
   if(!cardScopeMatches(s)||s.binding.method!=='unique_unpaid_invoice'||s.field.id!==DUE_DATE_FIELD
     ||s.binding.locationId!==input.scope.locationId||s.binding.contactId!==input.scope.contactId
     ||s.binding.opportunityId!==input.scope.opportunityId||s.binding.jobberClientId!==input.scope.jobberClientId
     ||s.binding.invoiceId!==input.scope.invoiceId||s.binding.pipelineId!==policy.pipelineId
     ||s.stageIds.sent!==policy.sentStageId||s.stageIds.overdue!==policy.overdueStageId||!same(s.currentCard,expected))throw Error('Bootstrap fresh exact source/card scope changed');
   await verifyPaidCycleWorkflowInventory(policy.inventory,policy.locationId,deps.workflows);
   const history=await input.writer.readCycleHistory();
   assertPolicy();assertSnapshotIdentityCoverage(s);
   const observedAt=now().toISOString();s.now=observedAt;original=s;
   const entries:BootstrapPlanInput['history']['entries']=history.filter(w=>!ownClaimId||(w.id!==ownClaimId&&w.intent.bootstrap?.claimId!==ownClaimId)).map(w=>{
    const b=w.intent.bootstrap,c=w.intent.cycle;
    return {scope:b?.claim.scope??{locationId:c?.locationId??policy.locationId,workflowId:c?.workflowId??policy.reminderId,
      pipelineId:w.intent.pipelineId,contactId:w.intent.contactId,opportunityId:w.intent.opportunityId,jobberClientId:w.intent.jobberClientId,
      invoiceId:c?.invoiceId??w.intent.dateField?.invoiceId??'unattributed'},phase:b?'bootstrap':c?.phase==='enroll'?'enroll':'other',state:w.state};
   });
   const stable=card(s.currentCard);const {pipelineStageId:ignored,...rest}=stable;
   const unchangedCardFieldsSha256=sha({...rest,customFields:stable.customFields.filter(f=>f.id!==DUE_DATE_FIELD)});
   return {snapshot:{...s,unchangedCardFieldsSha256},cohort:review.cohort,history:{complete:true,observedAt,entries},
    effects:{approvalId:policy.approvalId,policySha256:env.GHL_RECURRING_DUE_DATE_POLICY_SHA256!,workflowId:policy.reminderId,
     reviewRef:review.reviewRef,nativeSkipRouteQaRef:review.nativeSkipRouteQaRef,observedAt,expiresAt:policy.expiresAt,
     reminderPublished:true,closureDraft:true,completeInventoryMatches:true,exactOpportunityTrigger:true,sentTransitionCannotSendOrEnroll:true,
     dateOnlyCannotSendOrEnroll:true,sourceDateAnchoredWaits:true,pastAndDueNowMilestonesSkipped:true,futurePaymentChannelAndFactGuards:true}};
  },
  claimOnce:async(c,d)=>{
   assertPolicy();assertSnapshotWriteFreshness(original!,now());claim=structuredClone(c);digest=d;
   const intent={...base(original!),bootstrap:{claim,claimSha256:d,phase:'claim' as const}};
   admitted=true;const id=await input.writer.prepare(intent);await input.writer.assertPending(id);
   assertPolicy();assertSnapshotWriteFreshness(original!,now());await input.writer.confirm(id);return id;
  },
  assertClaim:async(id,d)=>{
   assertPolicy();const h=await input.writer.readCycleHistory();const found=h.find(w=>w.id===id&&w.state==='confirmed'&&w.intent.bootstrap?.phase==='claim');
   if(!found||found.intent.bootstrap!.claimSha256!==d||d!==digest||sha(found.intent.bootstrap!.claim)!==d)throw Error('Bootstrap durable claim changed');
  },
  prepare:async(claimId,phase)=>{
   assertPolicy();assertSnapshotWriteFreshness(original!,now());
   let intent=base(original!);
   if(phase==='source_date'){
     const date=dateJournalIntent(original!,policy.approvalId);if(!date)throw Error('Bootstrap date journal unavailable');intent={...date,source:intent.source};
   }else intent.target.stageId=phase==='bootstrap_stage'?policy.sentStageId:policy.overdueStageId;
   intent.bootstrap={claim:claim!,claimSha256:digest,phase,claimId};
   if(phase==='enroll_stage')intent.cycle={version:1,locationId:policy.locationId,workflowId:policy.reminderId,invoiceId:input.scope.invoiceId,dueOn:claim!.dueOn,phase:'enroll'};
   const id=await input.writer.prepare(intent);intents.set(id,intent);return id;
  },
  assertPending:id=>input.writer.assertPending(id),
  write:async(id,scope,step)=>{
   const intent=intents.get(id);if(!intent||scope.opportunityId!==input.scope.opportunityId)throw Error('Bootstrap exact intent missing');
   assertPolicy();assertSnapshotWriteFreshness(original!,now());
   // No awaits between final original coverage check and provider invocation.
   if(step.kind==='source_date')await deps.updateDate(input.scope.opportunityId,DUE_DATE_FIELD,claim!.dueOn);
   else await deps.moveStage(input.scope.opportunityId,intent.target.stageId,original!.card.amountCents/100);
   const next=structuredClone(expected);
   if(step.kind==='source_date')next.customFields=[...(next.customFields??[]).filter(f=>f.id!==DUE_DATE_FIELD),{id:DUE_DATE_FIELD,fieldValue:claim!.dueOn}];
   else next.pipelineStageId=intent.target.stageId;
   const after=await deps.readCard(input.scope.opportunityId);
   if(!same(after,next))throw Error('Bootstrap exact write readback mismatch');expected=after;
  },
  confirm:async id=>{assertPolicy();assertSnapshotWriteFreshness(original!,now());await input.writer.confirm(id);},
  block:async()=>{if(admitted)await input.writer.block();},
 };
 try{return await bootstrapExistingOverdue({enabled:true,adapter});}
 catch(error){if(!admitted)return held(error instanceof Error?error.message:'Bootstrap fresh evidence unavailable');throw error;}
}
