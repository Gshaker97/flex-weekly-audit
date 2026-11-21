import { syncExistingOverdueBootstrap } from '../lib/ghl-bootstrap-operation';
import { bootstrapCycleKey } from '../lib/ghl-existing-overdue-bootstrap';
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { syncRecurringDueDateBeforeStage, readRecurringEffectsPolicy, DUE_DATE_LOCATION as LOC, DUE_DATE_FIELD as FIELD, type RecurringEffectsPolicy } from "../lib/ghl-recurring-due-date";
import { planOpportunityDueDate } from "../lib/invoice-workflow-binding";
import type { DateRepairSnapshot } from "../lib/ghl-opportunity-date-repair";
import { workflowInventoryHash } from "../lib/ghl-paid-cycle-workflows";
import { SyncRunWriter, admitSyncRun } from "../lib/sync-writer-control";
import { writerFixture } from "./helpers/sync-writer-fixture";

// Every provider and DB operation below is synthetic. Fail any accidental HTTP.
globalThis.fetch = async () => { throw new Error("NETWORK FORBIDDEN in synthetic suite"); };
const NOW = new Date().toISOString();
const sha = (v:string) => createHash("sha256").update(v).digest("hex");
function harness(aligned = false) {
  const f = writerFixture(), calls:string[] = [];
  const snapshot:DateRepairSnapshot = {
    now:NOW, source:{observedAt:NOW,complete:true,invoices:[{id:"invoice",jobberClientId:"owner",status:"past_due",totalCents:9800,balanceCents:9800,
      issuedDate:"2026-10-01",dueDate:"2026-10-25",category:null}]},
    card:{id:"opp",locationId:LOC,contactId:"contact",pipelineId:"pipeline",stageId:"overdue",status:"open",amountCents:9800,observedAt:NOW},
    binding:{locationId:LOC,contactId:"contact",opportunityId:"opp",pipelineId:"pipeline",jobberClientId:"owner",invoiceId:"invoice",method:"unique_unpaid_invoice",
      evidenceRef:"synthetic-complete-identity",identityVerified:true,uniqueInvoiceCardVerified:true},
    stageIds:{sent:"sent",overdue:"overdue"},field:{id:FIELD,locationId:LOC,model:"opportunity",key:"opportunity.due_date",type:"DATE",currentValueKnown:true,currentValue:aligned?"2026-10-25":null},
    currentCard:{id:"opp",locationId:LOC,contactId:"contact",pipelineId:"pipeline",pipelineStageId:"overdue",status:"open",monetaryValue:98,name:"Synthetic",customFields:[{id:"untouched",fieldValue:"keep"},...(aligned?[{id:FIELD,fieldValue:"2026-10-25"}]:[])]},
  };
  const inventory = [ {id:"reminder",locationId:LOC,status:"published",version:4,updatedAt:NOW}, {id:"closure",locationId:LOC,status:"draft",version:2,updatedAt:NOW}, {id:"unrelated",locationId:LOC,status:"published",version:1,updatedAt:NOW} ];
  const policy:RecurringEffectsPolicy = {version:1,approvalId:"synthetic-recurring",expiresAt:"2026-11-11T18:00:00Z",locationId:LOC,pipelineId:"pipeline",sentStageId:"sent",overdueStageId:"overdue",reminderId:"reminder",closureId:"closure",executionClearance:[{opportunityId:"opp",invoiceId:"invoice",jobberClientId:"owner",contactId:"contact",sourceFingerprint:planOpportunityDueDate(snapshot).intent!.sourceFingerprint,reviewedAt:NOW,expiresAt:new Date(Date.parse(NOW)+900000).toISOString(),reviewRef:"synthetic-no-prior-or-old-executions",noPriorCurrentCycleEnrollment:true,noActiveOldCycle:true}],inventory:{entries:inventory,sha256:workflowInventoryHash(inventory,LOC)},definitionReviewRef:"synthetic-reviewed-definition",listenerInventoryReviewRef:"synthetic-full-listener-review",dateOnlyTriggerQaRef:"synthetic-one-time-no-enrollment-QA",contract:{exactOpportunityStageTriggerOnly:true,sourceDueDateAnchoredWaits:true,freshPaymentAndChannelGuards:true,noCatchupOrRetainedExecutionReplay:true,unrelatedDateListenersAbsent:true,dateOnlyUpdateCannotEnrollOrSend:true}};
  const env:Record<string,string|undefined> = {GHL_EXISTING_OVERDUE_BOOTSTRAP_ENABLED:"true",GHL_CYCLE_OWNERSHIP_ENABLED:"true",GHL_RECURRING_DUE_DATE_ENABLED:"true",GHL_LOCATION_ID:LOC,GHL_INVOICE_WRITE_MODE:"sync",SYNC_ADMISSION_MODE:"cron_only",GHL_WRITE_APPROVAL_ID:policy.approvalId,GHL_APPROVED_OPPORTUNITY_IDS:'["opp"]'};
  const scope={locationId:LOC,pipelineId:'pipeline',opportunityId:'opp',contactId:'contact',jobberClientId:'owner',invoiceId:'invoice',workflowId:'reminder'};
  policy.existingOverdueBootstrap={reviewRef:'review',nativeSkipRouteQaRef:'qa',sentTransitionReviewRef:'sent-reviewed',futureFactGuardReviewRef:'facts',exclusiveCycleWriterReviewRef:'exclusive-writer',cohort:[{...scope,sourceFingerprint:planOpportunityDueDate(snapshot).intent!.sourceFingerprint,cycleKey:bootstrapCycleKey(scope),dueOn:'2026-10-25',category:'maintenance',categoryReviewRef:'reviewed-native-tag',reviewedAt:NOW,expiresAt:new Date(Date.parse(NOW)+900000).toISOString(),noPriorCurrentCycleEnrollment:true,noActiveOldCycle:true,reviewRef:'cohort'}]};
  const pin = () => { env.GHL_RECURRING_DUE_DATE_POLICY=JSON.stringify(policy);env.GHL_RECURRING_DUE_DATE_POLICY_SHA256=sha(env.GHL_RECURRING_DUE_DATE_POLICY); }; pin();
  const input = {scope:{locationId:LOC,opportunityId:"opp",contactId:"contact",jobberClientId:"owner",invoiceId:"invoice"},expectedCard:structuredClone(snapshot.currentCard),target:{stageId:"overdue",monetaryValue:98,name:"Synthetic — 1 overdue invoice"},mode:"sync",phoneOwner:false,writer:f.writer,env,now:()=>new Date(NOW),deps:{
    readFresh:async()=>{calls.push("fresh");return structuredClone(snapshot);},
    workflows:async()=>{calls.push("effects");return {workflows:structuredClone(inventory)};},
    updateDate:async(id:string,field:string,date:string)=>{calls.push("date-PUT");assert.deepEqual([id,field,date],["opp",FIELD,"2026-10-25"]);assert.match(f.rows[0].errorMessage,/"state":"pending"/);snapshot.currentCard.customFields!.push({id:FIELD,fieldValue:date});snapshot.field.currentValue=date;},
    readCard:async()=>{calls.push("readback");return structuredClone(snapshot.currentCard);},
    moveStage:async(id:string,stage:string,amount?:number,name?:string)=>{calls.push("stage-PUT");assert.equal(id,"opp");snapshot.card.stageId=stage;snapshot.currentCard.pipelineStageId=stage;snapshot.currentCard.monetaryValue=amount;if(name!==undefined)snapshot.currentCard.name=name;},
  }};
  return {input,f,calls,snapshot,policy,inventory,pin};
}
const journal=(h:ReturnType<typeof harness>)=>JSON.parse(h.f.rows[0].errorMessage.slice("FLEX_GHL_WRITE_JOURNAL_V1:".length));

test('real writer adapter confirms claim then stage/date/stage without changing name',async()=>{const h=harness();assert.equal((await syncExistingOverdueBootstrap(h.input)).state,'applied');assert.deepEqual(h.calls.filter(x=>x.includes('PUT')),['stage-PUT','date-PUT','stage-PUT']);assert.equal(h.snapshot.currentCard.name,'Synthetic');const j=journal(h);assert.deepEqual(j.writes.map((w:any)=>w.intent.bootstrap.phase),['claim','bootstrap_stage','source_date','enroll_stage']);assert.ok(j.writes.every((w:any)=>w.state==='confirmed'));assert.equal(j.writes.at(-1).intent.cycle.phase,'enroll');});
test('aligned date omits source date write',async()=>{const h=harness(true);assert.equal((await syncExistingOverdueBootstrap(h.input)).state,'applied');assert.deepEqual(h.calls.filter(x=>x.includes('PUT')),['stage-PUT','stage-PUT']);});
for(const kind of ['disabled','ownership','review','exclusive','native-skip','inventory','card','source','expired','target-amount'])test(`admission hold ${kind}`,async()=>{const h=harness();if(kind==='disabled')h.input.env.GHL_EXISTING_OVERDUE_BOOTSTRAP_ENABLED='false';if(kind==='ownership')h.input.env.GHL_CYCLE_OWNERSHIP_ENABLED='false';if(kind==='review')delete h.policy.existingOverdueBootstrap;if(kind==='exclusive')h.policy.existingOverdueBootstrap!.exclusiveCycleWriterReviewRef='';if(kind==='native-skip')h.policy.existingOverdueBootstrap!.nativeSkipRouteQaRef='';if(kind==='inventory')h.inventory[0].version++;if(kind==='card')h.snapshot.currentCard.name='Changed';if(kind==='source')h.snapshot.source.invoices[0].balanceCents=0;if(kind==='expired')h.policy.existingOverdueBootstrap!.cohort[0].expiresAt=NOW;if(kind==='target-amount')h.input.target.monetaryValue++;h.pin();assert.equal((await syncExistingOverdueBootstrap(h.input)).state,'held');assert.ok(!h.calls.some(x=>x.includes('PUT')));assert.equal(h.f.rows[0].errorMessage,null);});
for(const phase of ['first-stage','date','last-stage'])test(`unknown ${phase} blocks and retains pending`,async()=>{const h=harness();const stage=h.input.deps.moveStage;let count=0;h.input.deps.moveStage=async(...args)=>{count++;if(phase==='first-stage'&&count===1||phase==='last-stage'&&count===2)throw Error('unknown');return stage(...args);};if(phase==='date')h.input.deps.updateDate=async()=>{throw Error('unknown');};await assert.rejects(syncExistingOverdueBootstrap(h.input));assert.equal(h.f.rows[0].status,'blocked');assert.equal(journal(h).writes.at(-1).state,'pending');});
test('changed authorization after final pending barrier blocks provider',async()=>{const h=harness();const pending=h.input.writer.assertPending.bind(h.input.writer);let n=0;h.input.writer.assertPending=async id=>{await pending(id);if(++n===2)h.input.env.GHL_EXISTING_OVERDUE_BOOTSTRAP_ENABLED='false';};await assert.rejects(syncExistingOverdueBootstrap(h.input));assert.ok(!h.calls.some(x=>x.includes('PUT')));});
test('lost claim commit acknowledgement blocks before provider',async()=>{const h=harness();h.f.loseNextCommit();await assert.rejects(syncExistingOverdueBootstrap(h.input));assert.ok(!h.calls.some(x=>x.includes('PUT')));assert.equal(h.f.rows[0].status,'blocked');});
test('exact readback drift blocks without next step',async()=>{const h=harness();const read=h.input.deps.readCard;h.input.deps.readCard=async()=>({...await read(),name:'drift'});await assert.rejects(syncExistingOverdueBootstrap(h.input));assert.deepEqual(h.calls.filter(x=>x.includes('PUT')),['stage-PUT']);assert.equal(journal(h).writes.at(-1).state,'pending');});
test('second invocation never reenrolls',async()=>{const h=harness();assert.equal((await syncExistingOverdueBootstrap(h.input)).state,'applied');h.input.expectedCard=structuredClone(h.snapshot.currentCard);assert.equal((await syncExistingOverdueBootstrap(h.input)).state,'held');assert.equal(h.calls.filter(x=>x.includes('PUT')).length,3);});
for(const [boundary,barrier] of [['claim',1],['first-stage',2],['date',3],['last-stage',4],['revoked',2]] as const)test(`real branded identity expires/revokes at ${boundary} final barrier`,async()=>{
 const {realStandingSnapshot}=await import('./helpers/real-standing-snapshot');const h=harness();const oldNow=Date.now,oldLocation=process.env.GHL_LOCATION_ID;let at=Date.parse(NOW);Date.now=()=>at;process.env.GHL_LOCATION_ID=LOC;h.input.now=()=>new Date(at);
 try{const real=realStandingSnapshot(h.input.scope,h.snapshot,h.input.now,true);h.input.deps.readFresh=real.read;const pending=h.f.writer.assertPending.bind(h.f.writer);let n=0;h.f.writer.assertPending=async id=>{await pending(id);if(++n===barrier){if(boundary==='revoked')real.revoke();else at+=300001;}};await assert.rejects(syncExistingOverdueBootstrap(h.input),/identity (coverage|authorization)/);assert.equal(h.f.rows[0].status,'blocked');assert.equal(journal(h).writes.at(-1).state,'pending');assert.equal(h.calls.filter(x=>x.includes('PUT')).length,Math.max(0,barrier-2));}
 finally{Date.now=oldNow;if(oldLocation===undefined)delete process.env.GHL_LOCATION_ID;else process.env.GHL_LOCATION_ID=oldLocation;}
});
test('real branded fresh reset reader supports full bootstrap',async()=>{
 const {realStandingSnapshot}=await import('./helpers/real-standing-snapshot');const h=harness();const oldLocation=process.env.GHL_LOCATION_ID;process.env.GHL_LOCATION_ID=LOC;
 try{const real=realStandingSnapshot(h.input.scope,h.snapshot,h.input.now,true);h.input.deps.readFresh=real.read;assert.equal((await syncExistingOverdueBootstrap(h.input)).state,'applied');assert.equal(h.calls.filter(x=>x.includes('PUT')).length,3);}finally{if(oldLocation===undefined)delete process.env.GHL_LOCATION_ID;else process.env.GHL_LOCATION_ID=oldLocation;}
});

test('elapsed time during workflow/history reads uses coherent completed observation clock',async()=>{const h=harness();let at=Date.parse(NOW);h.input.now=()=>new Date(at);const workflows=h.input.deps.workflows;h.input.deps.workflows=async()=>{const result=await workflows();at+=10;return result;};const history=h.input.writer.readCycleHistory.bind(h.input.writer);h.input.writer.readCycleHistory=async()=>{const result=await history();at+=10;return result;};assert.equal((await syncExistingOverdueBootstrap(h.input)).state,'applied');});
for(const barrier of [2,3,4])test(`strict source/card expiry after bootstrap pending barrier ${barrier} stops mutation`,async()=>{
 const h=harness(),r=h.policy.existingOverdueBootstrap!.cohort[0];r.clearanceMode="historical_review_v1";r.expiresAt=h.policy.expiresAt;h.pin();
 let at=Date.parse(NOW);h.input.now=()=>new Date(at);
 const pending=h.f.writer.assertPending.bind(h.f.writer);let n=0;
 h.f.writer.assertPending=async id=>{await pending(id);if(++n===barrier)at+=900001;};
 await assert.rejects(syncExistingOverdueBootstrap(h.input),/Source\/card evidence expired/);
 assert.equal(h.calls.filter(c=>c.includes("PUT")).length,barrier-2);assert.equal(h.f.rows[0].status,"blocked");
});
