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
const NOW = "2026-11-10T18:00:00Z";
const sha = (v:string) => createHash("sha256").update(v).digest("hex");
function harness(aligned = false) {
  const f = writerFixture(), calls:string[] = [];
  const snapshot:DateRepairSnapshot = {
    now:NOW, source:{observedAt:NOW,complete:true,invoices:[{id:"invoice",jobberClientId:"owner",status:"past_due",totalCents:9800,balanceCents:9800,
      issuedDate:"2026-10-26T23:03:18Z",dueDate:"2026-11-10T06:59:59Z",category:null}]},
    card:{id:"opp",locationId:LOC,contactId:"contact",pipelineId:"pipeline",stageId:"sent",status:"open",amountCents:9800,observedAt:NOW},
    binding:{locationId:LOC,contactId:"contact",opportunityId:"opp",pipelineId:"pipeline",jobberClientId:"owner",invoiceId:"invoice",method:"unique_unpaid_invoice",
      evidenceRef:"synthetic-complete-identity",identityVerified:true,uniqueInvoiceCardVerified:true},
    stageIds:{sent:"sent",overdue:"overdue"},field:{id:FIELD,locationId:LOC,model:"opportunity",key:"opportunity.due_date",type:"DATE",currentValueKnown:true,currentValue:aligned?"2026-11-09":null},
    currentCard:{id:"opp",locationId:LOC,contactId:"contact",pipelineId:"pipeline",pipelineStageId:"sent",status:"open",monetaryValue:98,name:"Synthetic",customFields:[{id:"untouched",fieldValue:"keep"},...(aligned?[{id:FIELD,fieldValue:"2026-11-09"}]:[])]},
  };
  const inventory = [ {id:"reminder",locationId:LOC,status:"published",version:4,updatedAt:NOW}, {id:"closure",locationId:LOC,status:"draft",version:2,updatedAt:NOW}, {id:"unrelated",locationId:LOC,status:"published",version:1,updatedAt:NOW} ];
  const policy:RecurringEffectsPolicy = {version:1,approvalId:"synthetic-recurring",expiresAt:"2026-11-11T18:00:00Z",locationId:LOC,pipelineId:"pipeline",sentStageId:"sent",overdueStageId:"overdue",reminderId:"reminder",closureId:"closure",executionClearance:[{opportunityId:"opp",invoiceId:"invoice",jobberClientId:"owner",contactId:"contact",sourceFingerprint:planOpportunityDueDate(snapshot).intent!.sourceFingerprint,reviewedAt:NOW,expiresAt:"2026-11-10T18:15:00Z",reviewRef:"synthetic-no-prior-or-old-executions",noPriorCurrentCycleEnrollment:true,noActiveOldCycle:true}],inventory:{entries:inventory,sha256:workflowInventoryHash(inventory,LOC)},definitionReviewRef:"synthetic-reviewed-definition",listenerInventoryReviewRef:"synthetic-full-listener-review",dateOnlyTriggerQaRef:"synthetic-one-time-no-enrollment-QA",contract:{exactOpportunityStageTriggerOnly:true,sourceDueDateAnchoredWaits:true,freshPaymentAndChannelGuards:true,noCatchupOrRetainedExecutionReplay:true,unrelatedDateListenersAbsent:true,dateOnlyUpdateCannotEnrollOrSend:true}};
  const env:Record<string,string|undefined> = {GHL_RECURRING_DUE_DATE_ENABLED:"true",GHL_LOCATION_ID:LOC,GHL_INVOICE_WRITE_MODE:"sync",SYNC_ADMISSION_MODE:"cron_only",GHL_WRITE_APPROVAL_ID:policy.approvalId,GHL_APPROVED_OPPORTUNITY_IDS:'["opp"]'};
  const pin = () => { env.GHL_RECURRING_DUE_DATE_POLICY=JSON.stringify(policy);env.GHL_RECURRING_DUE_DATE_POLICY_SHA256=sha(env.GHL_RECURRING_DUE_DATE_POLICY); }; pin();
  const input = {scope:{locationId:LOC,opportunityId:"opp",contactId:"contact",jobberClientId:"owner",invoiceId:"invoice"},expectedCard:structuredClone(snapshot.currentCard),target:{stageId:"overdue",monetaryValue:98,name:"Synthetic — 1 overdue invoice"},mode:"sync",phoneOwner:false,writer:f.writer,env,now:()=>new Date(NOW),deps:{
    readFresh:async()=>{calls.push("fresh");return structuredClone(snapshot);},
    workflows:async()=>{calls.push("effects");return {workflows:structuredClone(inventory)};},
    updateDate:async(id:string,field:string,date:string)=>{calls.push("date-PUT");assert.deepEqual([id,field,date],["opp",FIELD,"2026-11-09"]);assert.match(f.rows[0].errorMessage,/"state":"pending"/);snapshot.currentCard.customFields!.push({id:FIELD,fieldValue:date});snapshot.field.currentValue=date;},
    readCard:async()=>{calls.push("readback");return structuredClone(snapshot.currentCard);},
    moveStage:async(id:string,stage:string,amount?:number,name?:string)=>{calls.push("stage-PUT");assert.equal(id,"opp");assert.equal(snapshot.field.currentValue,"2026-11-09");snapshot.card.stageId=stage;snapshot.currentCard.pipelineStageId=stage;snapshot.currentCard.monetaryValue=amount;snapshot.currentCard.name=name;},
  }};
  return {input,f,calls,snapshot,policy,inventory,pin};
}
const journal=(h:ReturnType<typeof harness>)=>JSON.parse(h.f.rows[0].errorMessage.slice("FLEX_GHL_WRITE_JOURNAL_V1:".length));
test("date-only PUT is durably confirmed before fresh stage plan, stage PUT and readback",async()=>{
 const h=harness();assert.equal((await syncRecurringDueDateBeforeStage(h.input)).state,"applied");
 assert.deepEqual(h.calls,["effects","fresh","fresh","effects","date-PUT","readback","fresh","effects","fresh","effects","stage-PUT","readback"]);
 const j=journal(h);assert.equal(j.writes.length,2);assert.ok(j.writes.every((w:any)=>w.state==="confirmed"));
 assert.equal(j.writes[0].intent.dateField.targetValue,"2026-11-09");assert.equal(j.writes[0].intent.target.stageId,"sent");
 assert.equal(j.writes[1].intent.target.stageId,"overdue");assert.equal(j.writes[1].intent.source.invoices[0].issuedDate,"2026-10-26T23:03:18Z");await h.f.writer.finish("complete");
});
test("already aligned date makes no date PUT but freshly verifies before stage",async()=>{const h=harness(true);assert.equal((await syncRecurringDueDateBeforeStage(h.input)).state,"applied");assert.ok(!h.calls.includes("date-PUT"));assert.equal(journal(h).writes.length,1);});
for(const [name,change] of [
 ["disabled",(h:ReturnType<typeof harness>)=>{delete h.input.env.GHL_RECURRING_DUE_DATE_ENABLED;}],
 ["review",(h:ReturnType<typeof harness>)=>{h.input.mode="review";}],
 ["paid_only",(h:ReturnType<typeof harness>)=>{h.input.env.GHL_INVOICE_WRITE_MODE="paid_only";}],
 ["phone gate",(h:ReturnType<typeof harness>)=>{h.input.phoneOwner=true;}],
 ["no cohort",(h:ReturnType<typeof harness>)=>{h.input.env.GHL_APPROVED_OPPORTUNITY_IDS="[]";}],
 ["no approval",(h:ReturnType<typeof harness>)=>{delete h.input.env.GHL_WRITE_APPROVAL_ID;}],
 ["no policy",(h:ReturnType<typeof harness>)=>{delete h.input.env.GHL_RECURRING_DUE_DATE_POLICY;}],
 ["unverified one-time QA",(h:ReturnType<typeof harness>)=>{h.policy.dateOnlyTriggerQaRef="";h.pin();}],
 ["unreviewed trigger semantics",(h:ReturnType<typeof harness>)=>{h.policy.contract.dateOnlyUpdateCannotEnrollOrSend=false as any;h.pin();}],
 ["expired policy",(h:ReturnType<typeof harness>)=>{h.policy.expiresAt=NOW;h.pin();}],
 ["changed policy hash",(h:ReturnType<typeof harness>)=>{h.input.env.GHL_RECURRING_DUE_DATE_POLICY+=" ";}],
 ["wrong location",(h:ReturnType<typeof harness>)=>{h.input.scope.locationId="other";}],
 ["not cron only",(h:ReturnType<typeof harness>)=>{h.input.env.SYNC_ADMISSION_MODE="mixed";}],
] as const)test(`${name} holds with no IO`,async()=>{const h=harness();change(h);assert.equal((await syncRecurringDueDateBeforeStage(h.input)).state,"held");assert.deepEqual(h.calls,[]);assert.equal(h.f.rows[0].errorMessage,null);});
for(const kind of ["added","removed","version","timestamp","closure-published","reminder-draft","truncated","wrong-location","duplicate"]){test(`full workflow inventory holds ${kind}`,async()=>{const h=harness();h.input.deps.workflows=async()=>{const rows=structuredClone(h.inventory);if(kind==="added")rows.push({...rows[0],id:"new"});if(kind==="removed")rows.pop();if(kind==="version")rows[2].version++;if(kind==="timestamp")rows[0].updatedAt="2026-11-10T18:01:00Z";if(kind==="closure-published")rows[1].status="published";if(kind==="reminder-draft")rows[0].status="draft";if(kind==="wrong-location")rows[0].locationId="other";if(kind==="duplicate")rows.push(rows[0]);return {workflows:rows,...(kind==="truncated"?{hasMore:true}:{})};};assert.equal((await syncRecurringDueDateBeforeStage(h.input)).state,"held");assert.ok(!h.calls.some(v=>v.includes("PUT")));});}
for(const kind of ["prior-date","multi-invoice","negative","paid-positive","unknown-status","zero-unpaid","amount","wrong-owner","identity","duplicate-card","incomplete","stale","closed-won","closed-lost","overdue","paid-stage","special-stage","late-cycle","due-today","wrong-field","card-mismatch"]){test(`source/card hold: ${kind}`,async()=>{const h=harness();const s=h.snapshot;if(kind==="prior-date"){s.field.currentValue="2026-11-08";s.currentCard.customFields!.push({id:FIELD,fieldValue:"2026-11-08"});}if(kind==="multi-invoice")s.source.invoices.push({...s.source.invoices[0],id:"second"});if(kind==="negative")s.source.invoices[0].balanceCents=-1;if(kind==="paid-positive")s.source.invoices[0].status="paid";if(kind==="unknown-status")s.source.invoices[0].status="void";if(kind==="zero-unpaid")s.source.invoices[0].balanceCents=0;if(kind==="amount")s.card.amountCents++;if(kind==="wrong-owner")s.source.invoices[0].jobberClientId="other";if(kind==="identity")s.binding.identityVerified=false;if(kind==="duplicate-card")s.binding.uniqueInvoiceCardVerified=false;if(kind==="incomplete")s.source.complete=false;if(kind==="stale")s.source.observedAt="2026-11-10T17:00:00Z";if(kind.startsWith("closed")){s.card.status=kind==="closed-won"?"won":"lost";s.currentCard.status=s.card.status;}if(["overdue","paid-stage","special-stage"].includes(kind)){s.card.stageId=kind;s.currentCard.pipelineStageId=kind;}if(kind==="late-cycle")s.source.invoices[0].dueDate="2026-10-31";if(kind==="due-today")s.source.invoices[0].dueDate="2026-11-10";if(kind==="wrong-field")s.field.id="other";if(kind==="card-mismatch")s.currentCard.contactId="other";assert.equal((await syncRecurringDueDateBeforeStage(h.input)).state,"held");assert.ok(!h.calls.some(v=>v.includes("PUT")));assert.equal(h.f.rows[0].errorMessage,null);});}
for(const kind of ["payment","due-change","new-invoice","identity-change","card-change","workflow-change"]){test(`after date readback ${kind} prevents stage`,async()=>{const h=harness();const read=h.input.deps.readCard;h.input.deps.readCard=async()=>{const c=await read();if(kind==="payment"){h.snapshot.source.invoices[0].status="paid";h.snapshot.source.invoices[0].balanceCents=0;}if(kind==="due-change")h.snapshot.source.invoices[0].dueDate="2026-11-08";if(kind==="new-invoice")h.snapshot.source.invoices.push({...h.snapshot.source.invoices[0],id:"new"});if(kind==="identity-change")h.snapshot.binding.identityVerified=false;if(kind==="card-change")h.snapshot.currentCard.name="changed";if(kind==="workflow-change")h.inventory[0].version++;return c;};await assert.rejects(syncRecurringDueDateBeforeStage(h.input));assert.equal(h.calls.filter(v=>v==="date-PUT").length,1);assert.ok(!h.calls.includes("stage-PUT"));assert.equal(h.f.rows[0].status,"blocked");});}
for(const step of ["date","stage"]){test(`${step} timeout leaves pending journal, no retry, restart cannot proceed`,async()=>{const h=harness();if(step==="date")h.input.deps.updateDate=async()=>{h.calls.push("date-PUT");throw new Error("unknown timeout");};else h.input.deps.moveStage=async()=>{h.calls.push("stage-PUT");throw new Error("unknown timeout");};await assert.rejects(syncRecurringDueDateBeforeStage(h.input));assert.equal(h.calls.filter(v=>v===`${step}-PUT`).length,1);assert.equal(journal(h).writes.at(-1).state,"pending");const saved=h.f.rows[0].errorMessage;await assert.rejects(new SyncRunWriter("test-run",h.f.db).prepare(journal(h).writes.at(-1).intent));await assert.rejects(admitSyncRun({entrypoint:"standalone_cron"},h.f.db));assert.equal(h.f.rows[0].errorMessage,saved);});}
test("lost durable claim acknowledgment never reaches provider",async()=>{const h=harness();h.f.loseNextCommit();await assert.rejects(syncRecurringDueDateBeforeStage(h.input));assert.ok(!h.calls.some(v=>v.includes("PUT")));assert.equal(h.f.rows[0].status,"blocked");});
test("stage claim followed by changed source does not reach provider",async()=>{const h=harness();let reads=0;const read=h.input.deps.readFresh;h.input.deps.readFresh=async()=>{if(++reads===4)h.snapshot.source.invoices[0].balanceCents=9700;return read();};await assert.rejects(syncRecurringDueDateBeforeStage(h.input));assert.ok(!h.calls.includes("stage-PUT"));assert.equal(journal(h).writes.at(-1).state,"pending");});
for(const kind of ["date","other-field","name","stage"]){test(`date readback rejects ${kind} drift`,async()=>{const h=harness();const read=h.input.deps.readCard;h.input.deps.readCard=async()=>{const c=await read();if(kind==="date")c.customFields!.find(v=>v.id===FIELD)!.fieldValue="wrong";if(kind==="other-field")c.customFields![0].fieldValue="changed";if(kind==="name")c.name="changed";if(kind==="stage")c.pipelineStageId="overdue";return c;};await assert.rejects(syncRecurringDueDateBeforeStage(h.input));assert.ok(!h.calls.includes("stage-PUT"));assert.equal(journal(h).writes[0].state,"pending");});}
test("policy validator rejects bare reviewed booleans without pinned full inventory",()=>{const h=harness();assert.ok(readRecurringEffectsPolicy(h.input.env,new Date(NOW)));delete (h.policy as any).inventory;h.pin();assert.equal(readRecurringEffectsPolicy(h.input.env,new Date(NOW)),null);});

for(const age of [2,9])test(`late sync due+${age} preserves date and future first milestone`,async()=>{
 const h=harness();const due=age===2?"2026-11-08":"2026-11-01";h.snapshot.source.invoices[0].dueDate=due;h.policy.executionClearance[0].sourceFingerprint=planOpportunityDueDate(h.snapshot).intent!.sourceFingerprint;h.pin();
 h.input.deps.updateDate=async(_id,field,date)=>{assert.equal(date,due);h.calls.push("date-PUT");h.snapshot.currentCard.customFields!.push({id:field,fieldValue:date});h.snapshot.field.currentValue=date;};
 h.input.deps.moveStage=async(_id,stage,amount,name)=>{h.calls.push("stage-PUT");h.snapshot.currentCard.pipelineStageId=stage;h.snapshot.currentCard.monetaryValue=amount;h.snapshot.currentCard.name=name;};
 assert.equal((await syncRecurringDueDateBeforeStage(h.input)).state,"applied");assert.equal(journal(h).writes[0].intent.dateField.targetValue,due);
});

for(const kind of ["missing","expired","renewed-too-long","prior-current","old-active","wrong-invoice","changed-fingerprint"]){test(`unknown or invalid execution clearance holds: ${kind}`,async()=>{
 const h=harness();const c=h.policy.executionClearance[0];if(kind==="missing")h.policy.executionClearance=[];if(kind==="expired")c.expiresAt=NOW;if(kind==="renewed-too-long")c.expiresAt="2026-11-10T19:00:00Z";if(kind==="prior-current")c.noPriorCurrentCycleEnrollment=false as any;if(kind==="old-active")c.noActiveOldCycle=false as any;if(kind==="wrong-invoice")c.invoiceId="other";if(kind==="changed-fingerprint")c.sourceFingerprint="a".repeat(64);h.pin();assert.equal((await syncRecurringDueDateBeforeStage(h.input)).state,"held");assert.ok(!h.calls.some(v=>v.includes("PUT")));
});}
test("execution clearance expiry between date and stage blocks without automatic renewal",async()=>{
 const h=harness();const read=h.input.deps.readCard;
 // Mutate the captured clock through a closure.
 let at=NOW;h.input.now=()=>new Date(at);h.input.deps.readCard=async()=>{const c=await read();at="2026-11-10T18:15:00Z";return c;};
 await assert.rejects(syncRecurringDueDateBeforeStage(h.input));assert.ok(!h.calls.includes("stage-PUT"));assert.equal(h.f.rows[0].status,"blocked");
});

for (const [label, at, due, status, expected] of [
 ["Day10 08:59:59 Arizona", "2026-11-10T15:59:59Z", "2026-10-31", "past_due", "applied"],
 ["Day10 09:00:00 Arizona", "2026-11-10T16:00:00Z", "2026-10-31", "past_due", "held"],
 ["due today", NOW, "2026-11-10", "awaiting_payment", "held"],
] as const) test(`freshly approved clock boundary: ${label} is ${expected}`, async () => {
 const h=harness(), c=h.policy.executionClearance[0];
 h.snapshot.source.invoices[0].dueDate=due;h.snapshot.source.invoices[0].status=status;
 h.snapshot.now=at;h.snapshot.source.observedAt=at;h.snapshot.card.observedAt=at;
 h.input.now=()=>new Date(at);c.reviewedAt=at;c.expiresAt=new Date(Date.parse(at)+15*60_000).toISOString();
 c.sourceFingerprint=planOpportunityDueDate(h.snapshot).intent!.sourceFingerprint;h.pin();
 h.input.deps.updateDate=async(_id,field,date)=>{assert.equal(date,due);h.calls.push("date-PUT");h.snapshot.currentCard.customFields!.push({id:field,fieldValue:date});h.snapshot.field.currentValue=date;};
 h.input.deps.moveStage=async(_id,stage,amount,name)=>{h.calls.push("stage-PUT");h.snapshot.currentCard.pipelineStageId=stage;h.snapshot.currentCard.monetaryValue=amount;h.snapshot.currentCard.name=name;};
 assert.equal((await syncRecurringDueDateBeforeStage(h.input)).state,expected);
 if(expected==="held")assert.ok(!h.calls.some(v=>v.includes("PUT")));
});

test("ownership flag records first reviewed invoice enrollment and prevents replay across a new run",async()=>{
 const h=harness();h.input.env.GHL_CYCLE_OWNERSHIP_ENABLED="true";
 assert.equal((await syncRecurringDueDateBeforeStage(h.input)).state,"applied");
 const saved=await h.f.writer.readCycleHistory();assert.equal(saved.at(-1)!.intent.cycle!.invoiceId,"invoice");assert.equal(saved.at(-1)!.intent.cycle!.phase,"enroll");
 await h.f.writer.finish("complete");h.f.rows.push({id:"later-run",status:"running",errorMessage:null,startedAt:new Date()});
 h.input.writer=new SyncRunWriter("later-run",h.f.db);h.snapshot.card.stageId="sent";h.snapshot.currentCard.pipelineStageId="sent";
 h.input.expectedCard=structuredClone(h.snapshot.currentCard);const before=h.calls.length;
 assert.equal((await syncRecurringDueDateBeforeStage(h.input)).state,"held");assert.equal(h.calls.length,before);
});

for(const boundary of ["before-admission","date-effects","stage-effects","date-final-claim","stage-final-claim","revoked-final-claim"]){
 test(`real branded standing proof is retained through cloning at ${boundary}`,async()=>{
  const {realStandingSnapshot}=await import("./helpers/real-standing-snapshot");
  const h=harness(boundary!=="date-effects" && boundary!=="date-final-claim");
  const originalNow=Date.now,oldLocation=process.env.GHL_LOCATION_ID;
  let at=Date.parse(NOW);Date.now=()=>at;process.env.GHL_LOCATION_ID=LOC;h.input.now=()=>new Date(at);
  try{
   const real=realStandingSnapshot(h.input.scope,h.snapshot,h.input.now);h.input.deps.readFresh=real.read;
   const policy=JSON.stringify(real.policy),effects=h.input.deps.workflows;let n=0;
   h.input.deps.workflows=async()=>{const r=await effects();n++;
    if((boundary==="before-admission" && n===2)||(boundary==="date-effects" && n===2)||(boundary==="stage-effects" && n===3))at+=300001;
    return r;
   };
   const pending=h.f.writer.assertPending.bind(h.f.writer);let claims=0;
   h.f.writer.assertPending=async(id)=>{await pending(id);if(++claims===2){
    if(boundary.endsWith("final-claim")){if(boundary==="revoked-final-claim")real.revoke();else at+=300001;}
   }};
   if(boundary==="before-admission"){
    assert.equal((await syncRecurringDueDateBeforeStage(h.input)).state,"held");
    assert.equal(h.f.rows[0].errorMessage,null);assert.equal(real.reads(),2);
   }else{
    await assert.rejects(syncRecurringDueDateBeforeStage(h.input),/identity (coverage|authorization)/);
    assert.equal(h.f.rows[0].status,"blocked");assert.equal(journal(h).writes.at(-1).state,"pending");
   }
   assert.ok(!h.calls.some(c=>c.includes("PUT")));assert.equal(JSON.stringify(real.policy),policy);
  }finally{Date.now=originalNow;if(oldLocation===undefined)delete process.env.GHL_LOCATION_ID;else process.env.GHL_LOCATION_ID=oldLocation;}
 });
}
test("unexpired real standing snapshot permits date then stage without proof renewal",async()=>{
 const {realStandingSnapshot}=await import("./helpers/real-standing-snapshot");const h=harness();
 const originalNow=Date.now,oldLocation=process.env.GHL_LOCATION_ID;Date.now=()=>Date.parse(NOW);process.env.GHL_LOCATION_ID=LOC;
 try{const real=realStandingSnapshot(h.input.scope,h.snapshot,h.input.now);h.input.deps.readFresh=real.read;
  assert.equal((await syncRecurringDueDateBeforeStage(h.input)).state,"applied");assert.equal(real.reads(),4);
 }finally{Date.now=originalNow;if(oldLocation===undefined)delete process.env.GHL_LOCATION_ID;else process.env.GHL_LOCATION_ID=oldLocation;}
});

function nativeHourlyPolicy(h:ReturnType<typeof harness>){
 delete h.policy.contract.freshPaymentAndChannelGuards;
 h.policy.contract.paymentGuard={kind:"native_hourly_sync",intervalMinutes:60,cronExpression:"0 * * * *",
  scheduleReviewRef:"synthetic-hourly-deployment-schedule",sourceSyncBeforeGhlReviewRef:"synthetic-source-before-ghl",
  nativeStageAndPositiveValueGuardReviewRef:"synthetic-native-stage-value-guards",
  nativeChannelSuppressionReviewRef:"synthetic-native-channel-suppression",
  stalePaymentRiskAcceptanceRef:"synthetic-explicit-acceptance-of-payment-delay"};
 h.pin();
}
test("native hourly payment contract is an explicit alternative, not a real-time source claim",async()=>{
 const h=harness();nativeHourlyPolicy(h);
 assert.ok(readRecurringEffectsPolicy(h.input.env,new Date(NOW)));
 assert.equal((await syncRecurringDueDateBeforeStage(h.input)).state,"applied");
 assert.equal(h.policy.contract.freshPaymentAndChannelGuards,undefined);
});
for(const kind of ["mixed-claims","missing-acceptance","missing-stage-review","missing-channel-review","missing-schedule-review","wrong-cadence","nonhourly-cron"]){
 test(`native hourly payment policy rejects ${kind}`,()=>{
  const h=harness();nativeHourlyPolicy(h);const p=h.policy.contract.paymentGuard!;
  if(kind==="mixed-claims")h.policy.contract.freshPaymentAndChannelGuards=true;
  if(kind==="missing-acceptance")p.stalePaymentRiskAcceptanceRef="";
  if(kind==="missing-stage-review")p.nativeStageAndPositiveValueGuardReviewRef="";
  if(kind==="missing-channel-review")p.nativeChannelSuppressionReviewRef="";
  if(kind==="missing-schedule-review")p.scheduleReviewRef="";
  if(kind==="wrong-cadence")p.intervalMinutes=30 as any;
  if(kind==="nonhourly-cron")p.cronExpression="*/5 * * * *";
  h.pin();assert.equal(readRecurringEffectsPolicy(h.input.env,new Date(NOW)),null);
 });
}
for(const aligned of [false,true])test(`strict recurring ${aligned?"stage":"date"} expiry after final pending barrier stops mutation`,async()=>{
 const h=harness(aligned);let at=Date.parse(NOW);h.input.now=()=>new Date(at);
 const pending=h.f.writer.assertPending.bind(h.f.writer);let n=0;
 h.f.writer.assertPending=async id=>{await pending(id);if(++n===2)at+=900001;};
 await assert.rejects(syncRecurringDueDateBeforeStage(h.input),/Source\/card evidence expired/);
 assert.ok(!h.calls.some(c=>c.includes("PUT")));assert.equal(h.f.rows[0].status,"blocked");
});
