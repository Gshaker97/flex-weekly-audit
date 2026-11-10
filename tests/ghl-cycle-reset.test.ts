import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resetJournalOwnedInvoiceCycle, type NativeCleanupProof } from "../lib/ghl-cycle-reset";
import { syncRecurringDueDateBeforeStage, DUE_DATE_LOCATION as LOC, DUE_DATE_FIELD as FIELD, type RecurringEffectsPolicy } from "../lib/ghl-recurring-due-date";
import { SyncRunWriter, admitSyncRun, cardNameHash, publicSyncRun, type GhlWriteIntent } from "../lib/sync-writer-control";
import { workflowInventoryHash } from "../lib/ghl-paid-cycle-workflows";
import type { DateRepairSnapshot } from "../lib/ghl-opportunity-date-repair";
import { writerFixture } from "./helpers/sync-writer-fixture";
globalThis.fetch=async()=>{throw new Error("NETWORK FORBIDDEN");};
const NOW="2030-06-11T18:00:00Z", OLD="2030-05-01", DUE="2030-06-10";
const sha=(v:string)=>createHash("sha256").update(v).digest("hex");
async function harness(clear=false,withWitness=true,withReadback=true){
 const f=writerFixture(),calls:string[]=[];
 const old={id:"old",jobberClientId:"owner",invoiceStatus:"past_due",totalCents:10000,balanceCents:10000,issuedDate:"2030-04-01",dueDate:OLD,createdAt:null};
 const cycle={version:1 as const,locationId:LOC,workflowId:"fixed",invoiceId:"old",dueOn:OLD,phase:"enroll" as const};
 const base:GhlWriteIntent={approvalId:"test",pipelineId:"pipeline",contactId:"contact",opportunityId:"card",jobberClientId:"owner",cycle,
  expected:{stageId:"sent",status:"open",amountCents:10000,nameHash:cardNameHash("Synthetic")},target:{stageId:"overdue",amountCents:10000,nameHash:cardNameHash("Synthetic"),updateName:false},
  source:{observedAt:NOW,storedInvoiceIds:["old"],invoices:[old]}};
 const enrollmentId=await f.writer.prepare(base);await f.writer.confirm(enrollmentId);
 const paid:GhlWriteIntent={...base,cycle:{...cycle,phase:"paid"},expected:{...base.expected,stageId:"overdue"},target:{...base.target,stageId:"paid",amountCents:0},source:{...base.source,invoices:[{...old,invoiceStatus:"paid",balanceCents:0}]}};
 if(withWitness)paid.cycle!.paidDateWitness={version:1,fieldId:FIELD,ownedValue:OLD,observedAt:NOW,priorOwnershipJournalId:enrollmentId,otherFieldsSha256:sha("[]")};
 const paidId=await f.writer.prepare(paid);await f.writer.confirm(paidId,withWitness && withReadback?{fieldId:FIELD,value:OLD,observedAt:NOW,otherFieldsSha256:sha("[]")}:undefined);await f.writer.finish("complete");
 f.rows.push({id:"next-run",status:"running",errorMessage:null,startedAt:new Date(),completedAt:null});const writer=new SyncRunWriter("next-run",f.db);
 const scope={locationId:LOC,opportunityId:"card",contactId:"contact",jobberClientId:"owner",invoiceId:"new"};
 const s:DateRepairSnapshot={now:NOW,binding:{...scope,pipelineId:"pipeline",method:"unique_unpaid_invoice",evidenceRef:"synthetic-exact-source",identityVerified:true,uniqueInvoiceCardVerified:true},
  source:{observedAt:NOW,complete:true,invoices:[{id:"old",jobberClientId:"owner",status:"paid",totalCents:10000,balanceCents:0,issuedDate:old.issuedDate,dueDate:OLD,category:null},
   {id:"new",jobberClientId:"owner",status:"past_due",totalCents:9800,balanceCents:9800,issuedDate:"2030-06-01",dueDate:DUE,category:null}]},
  card:{id:"card",locationId:LOC,contactId:"contact",pipelineId:"pipeline",stageId:"paid",status:"open",amountCents:0,observedAt:NOW},stageIds:{sent:"sent",overdue:"overdue"},
  field:{id:FIELD,locationId:LOC,model:"opportunity",key:"opportunity.due_date",type:"DATE",currentValueKnown:true,currentValue:clear?null:OLD},
  currentCard:{id:"card",locationId:LOC,contactId:"contact",pipelineId:"pipeline",pipelineStageId:"paid",status:"open",monetaryValue:0,name:"Synthetic",customFields:clear?[]:[{id:FIELD,fieldValue:OLD}]}};
 const entries=[{id:"fixed",locationId:LOC,status:"published",version:2,updatedAt:NOW},{id:"closure",locationId:LOC,status:"draft",version:1,updatedAt:NOW},{id:"cleanup",locationId:LOC,status:"published",version:1,updatedAt:NOW}];
 const policy:RecurringEffectsPolicy={version:1,approvalId:"test",expiresAt:"2031-01-01T00:00:00Z",locationId:LOC,pipelineId:"pipeline",sentStageId:"sent",overdueStageId:"overdue",reminderId:"fixed",closureId:"closure",executionClearance:[],
  inventory:{entries,sha256:workflowInventoryHash(entries,LOC)},definitionReviewRef:"synthetic",listenerInventoryReviewRef:"synthetic",dateOnlyTriggerQaRef:"synthetic",nativeReset:{cleanupWorkflowId:"cleanup",contractSha256:"a".repeat(64),evidenceRef:"synthetic-contract"},
  contract:{exactOpportunityStageTriggerOnly:true,sourceDueDateAnchoredWaits:true,freshPaymentAndChannelGuards:true,noCatchupOrRetainedExecutionReplay:true,unrelatedDateListenersAbsent:true,dateOnlyUpdateCannotEnrollOrSend:true}};
 const env:Record<string,string|undefined>={GHL_CYCLE_OWNERSHIP_ENABLED:"true",GHL_RECURRING_DUE_DATE_ENABLED:"true",GHL_INVOICE_WRITE_MODE:"sync",SYNC_ADMISSION_MODE:"cron_only",GHL_LOCATION_ID:LOC,GHL_WRITE_APPROVAL_ID:"test",GHL_APPROVED_OPPORTUNITY_IDS:'["card"]'};
 const pin=()=>{env.GHL_RECURRING_DUE_DATE_POLICY=JSON.stringify(policy);env.GHL_RECURRING_DUE_DATE_POLICY_SHA256=sha(env.GHL_RECURRING_DUE_DATE_POLICY);};pin();
 const proof:NativeCleanupProof={locationId:LOC,workflowId:"fixed",opportunityId:"card",contactId:"contact",jobberClientId:"owner",invoiceId:"old",oldEnrollmentJournalId:enrollmentId,oldPaidJournalId:paidId,
  contractSha256:policy.nativeReset!.contractSha256,observedAt:NOW,evidenceRef:"synthetic-actual-cycle-proof",kind:clear?"ordered_native_clear":"verified_terminal_execution",noRelevantActiveExecution:true};
 const input={scope,expectedCard:structuredClone(s.currentCard),writer,mode:"sync",phoneOwner:false,name:"Next invoice",env,now:()=>new Date(NOW),deps:{
  readFresh:async()=>{calls.push("source");return structuredClone(s);},readCard:async()=>{calls.push("readback");return structuredClone(s.currentCard);},
  workflows:async()=>{calls.push("effects");return {workflows:structuredClone(entries)};},nativeCleanup:async()=>{calls.push("cleanup-proof");return structuredClone(proof) as NativeCleanupProof|null;},
  updateDate:async(_id:string,field:string,date:string)=>{calls.push("date-PUT");assert.equal(field,FIELD);assert.equal(date,DUE);s.currentCard.customFields=[{id:field,fieldValue:date}];s.field.currentValue=date;},
  moveStage:async(_id:string,stage:string,amount?:number,name?:string)=>{calls.push("stage-PUT");s.currentCard.pipelineStageId=stage;s.currentCard.monetaryValue=amount;if(name!==undefined)s.currentCard.name=name;s.card.stageId=stage;s.card.amountCents=Math.round(amount!*100);},
 }};return {f,input,s,calls,policy,pin,proof,base,entries};
}
test("retained journal owns old paid cycle across runs; exact old date replaced before next Sent reset",async()=>{
 const h=await harness();assert.equal((await resetJournalOwnedInvoiceCycle(h.input)).state,"applied");assert.equal(h.s.currentCard.pipelineStageId,"sent");assert.equal(h.s.currentCard.monetaryValue,98);
 const j=await h.input.writer.readCycleHistory();assert.deepEqual(j.map(w=>[w.intent.cycle?.phase,w.state]),[["enroll","confirmed"],["paid","confirmed"],["reset_date","confirmed"],["reset_stage","confirmed"]]);
 assert.equal(j[2].intent.dateField!.expectedValue,OLD);assert.equal(j[2].intent.dateField!.targetValue,DUE);assert.ok(h.calls.indexOf("date-PUT")<h.calls.indexOf("stage-PUT"));
});
test("verified ordered native clear supports blank-only reset without inferring blank means canceled",async()=>{const h=await harness(true);assert.equal((await resetJournalOwnedInvoiceCycle(h.input)).state,"applied");assert.equal((await h.input.writer.readCycleHistory())[2].intent.dateField!.expectedValue,null);});
test("next invoice enrolls automatically from confirmed owned reset without a per-invoice clearance entry",async()=>{
 const h=await harness();await resetJournalOwnedInvoiceCycle(h.input);const r=await syncRecurringDueDateBeforeStage({...h.input,expectedCard:structuredClone(h.s.currentCard),target:{stageId:"overdue",monetaryValue:98,name:"Next invoice"}});
 assert.equal(r.state,"applied");assert.equal((await h.input.writer.readCycleHistory()).at(-1)!.intent.cycle!.invoiceId,"new");
 h.s.card.stageId="sent";h.s.currentCard.pipelineStageId="sent";const before=h.calls.length;
 const again=await syncRecurringDueDateBeforeStage({...h.input,expectedCard:structuredClone(h.s.currentCard),target:{stageId:"overdue",monetaryValue:98,name:"Next invoice"}});
 assert.equal(again.state,"held");assert.equal(h.calls.length,before,"journal claim prevents replay even after outside stage reset");
});
for(const kind of ["disabled","review","no-cohort","phone","missing-contract","missing-proof","active-execution","wrong-old-invoice","wrong-old-paid-id","stale-proof","future-proof","wrong-contract","unowned-date","blank-with-terminal-only","old-not-paid","negative","two-unpaid","unknown-status","wrong-identity","duplicate-card","incomplete-source","wrong-stage","wrong-amount","closed","wrong-field"]){test(`reset holds ${kind}`,async()=>{
 const h=await harness();if(kind==="disabled")delete h.input.env.GHL_CYCLE_OWNERSHIP_ENABLED;if(kind==="review")h.input.mode="review";if(kind==="no-cohort")h.input.env.GHL_APPROVED_OPPORTUNITY_IDS="[]";if(kind==="phone")h.input.phoneOwner=true;
 if(kind==="missing-contract"){delete h.policy.nativeReset;h.pin();}if(kind==="missing-proof")h.input.deps.nativeCleanup=async()=>null;if(kind==="active-execution")h.proof.noRelevantActiveExecution=false as any;if(kind==="wrong-old-invoice")h.proof.invoiceId="other";if(kind==="wrong-old-paid-id")h.proof.oldPaidJournalId="other";if(kind==="stale-proof")h.proof.observedAt="2030-06-11T17:58:00Z";if(kind==="future-proof")h.proof.observedAt="2030-06-11T19:00:00Z";if(kind==="wrong-contract")h.proof.contractSha256="b".repeat(64);
 if(kind==="unowned-date"){h.s.field.currentValue="2030-05-02";h.s.currentCard.customFields![0].fieldValue="2030-05-02";h.input.expectedCard=structuredClone(h.s.currentCard);}if(kind==="blank-with-terminal-only"){h.s.field.currentValue=null;h.s.currentCard.customFields=[];h.input.expectedCard=structuredClone(h.s.currentCard);}
 if(kind==="old-not-paid"){h.s.source.invoices[0].status="past_due";h.s.source.invoices[0].balanceCents=1;}if(kind==="negative")h.s.source.invoices[1].balanceCents=-1;if(kind==="two-unpaid")h.s.source.invoices.push({...h.s.source.invoices[1],id:"third"});if(kind==="unknown-status")h.s.source.invoices[1].status="unknown";if(kind==="wrong-identity")h.s.binding.identityVerified=false;if(kind==="duplicate-card")h.s.binding.uniqueInvoiceCardVerified=false;if(kind==="incomplete-source")h.s.source.complete=false;if(kind==="wrong-stage")h.s.card.stageId="overdue";if(kind==="wrong-amount")h.s.card.amountCents=1;if(kind==="closed")h.s.card.status="won";if(kind==="wrong-field")h.s.field.id="other";
 assert.equal((await resetJournalOwnedInvoiceCycle(h.input)).state,"held");assert.ok(!h.calls.some(c=>c.includes("PUT")));assert.equal(h.f.rows[1].errorMessage,null);
});}
for(const step of ["date","stage"]){test(`${step} timeout fences restart and never retries`,async()=>{const h=await harness();if(step==="date")h.input.deps.updateDate=async()=>{h.calls.push("date-PUT");throw new Error("unknown");};else h.input.deps.moveStage=async()=>{h.calls.push("stage-PUT");throw new Error("unknown");};await assert.rejects(resetJournalOwnedInvoiceCycle(h.input));assert.equal(h.calls.filter(c=>c===`${step}-PUT`).length,1);assert.equal(h.f.rows[1].status,"blocked");await assert.rejects(admitSyncRun({entrypoint:"standalone_cron"},h.f.db));await assert.rejects(new SyncRunWriter("next-run",h.f.db).prepare(h.base));});}
test("payment/source change after date readback blocks Sent reset",async()=>{const h=await harness();const read=h.input.deps.readCard;h.input.deps.readCard=async()=>{const c=await read();h.s.source.invoices[1].status="paid";h.s.source.invoices[1].balanceCents=0;return c;};await assert.rejects(resetJournalOwnedInvoiceCycle(h.input));assert.ok(!h.calls.includes("stage-PUT"));assert.equal(h.f.rows[1].status,"blocked");});
test("ordered-clear receipt is captured once and not re-inferred from blank after own date PUT",async()=>{const h=await harness(true);const read=h.input.deps.readCard;h.input.deps.readCard=async()=>{const c=await read();h.input.deps.nativeCleanup=async()=>{throw new Error("Cannot observe blank after our own date write");};return c;};assert.equal((await resetJournalOwnedInvoiceCycle(h.input)).state,"applied");});
test("captured cleanup acknowledgment expires without timestamp renewal after date write",async()=>{const h=await harness(true);let at=NOW;h.input.now=()=>new Date(at);const read=h.input.deps.readCard;h.input.deps.readCard=async()=>{const c=await read();at="2030-06-11T18:01:01Z";return c;};await assert.rejects(resetJournalOwnedInvoiceCycle(h.input));assert.ok(!h.calls.includes("stage-PUT"));});
test("same stable invoice cannot claim enrollment again with changed balance/date or another card",async()=>{for(const kind of ["balance","date","card"]){const h=await harness();const i=structuredClone(h.base);if(kind==="balance"){i.source.invoices[0].balanceCents=9000;i.target.amountCents=9000;}if(kind==="date"){i.source.invoices[0].dueDate="2030-05-02";i.cycle!.dueOn="2030-05-02";}if(kind==="card")i.opportunityId="other";await assert.rejects(h.input.writer.prepare(i));}});
test("missing owned enrollment/paid journals cannot be replaced by a native proof",async()=>{const h=await harness();h.f.rows[0].errorMessage=null;assert.equal((await resetJournalOwnedInvoiceCycle(h.input)).state,"held");assert.ok(!h.calls.some(c=>c.includes("PUT")));});
test("corrupt retained journal never creates a fresh empty ownership history",async()=>{const h=await harness();h.f.rows[0].errorMessage="FLEX_GHL_WRITE_JOURNAL_V1:{}";await assert.rejects(h.input.writer.readCycleHistory());assert.equal((await resetJournalOwnedInvoiceCycle(h.input)).state,"held");assert.ok(!h.calls.some(c=>c.includes("PUT")));});
test("unknown prior-date overwrite remains rejected by the writer without owned predecessor claims",async()=>{const h=await harness();await resetJournalOwnedInvoiceCycle(h.input);const i=structuredClone((await h.input.writer.readCycleHistory())[2].intent);delete i.cycle;const f=writerFixture();await assert.rejects(f.writer.prepare(i));});

test("version-1 legacy journal without cycle metadata still parses unchanged and stays private",async()=>{
 const h=await harness(), f=writerFixture();const legacy=structuredClone(h.base);delete legacy.cycle;
 const id=await f.writer.prepare(legacy);await f.writer.confirm(id);const bytes=f.rows[0].errorMessage;
 const history=await f.writer.readCycleHistory();assert.equal(history.length,1);assert.deepEqual(history[0].intent,legacy);assert.equal(history[0].intent.cycle,undefined);
 assert.equal(f.rows[0].errorMessage,bytes);const exposed=publicSyncRun(f.rows[0]);assert.ok(!exposed.errorMessage!.includes('"invoiceId"'));assert.ok(!exposed.errorMessage!.includes('"owner"'));assert.ok(!exposed.errorMessage!.includes('FLEX_GHL_WRITE_JOURNAL_V1:'));
});
test("owned new invoice cannot reenroll after source balance/date changes: no transport or source IO",async()=>{
 const h=await harness();await resetJournalOwnedInvoiceCycle(h.input);await syncRecurringDueDateBeforeStage({...h.input,expectedCard:structuredClone(h.s.currentCard),target:{stageId:"overdue",monetaryValue:98}});
 h.s.card.stageId="sent";h.s.currentCard.pipelineStageId="sent";h.s.source.invoices[1].balanceCents=9700;h.s.source.invoices[1].dueDate="2030-06-09";
 const before=h.calls.length;const result=await syncRecurringDueDateBeforeStage({...h.input,expectedCard:structuredClone(h.s.currentCard),target:{stageId:"overdue",monetaryValue:97}});
 assert.equal(result.state,"held");assert.equal(h.calls.length,before);
});

test("paid predecessor source due-date edit does not erase exact ownership of its original card date",async()=>{
 const h=await harness();h.s.source.invoices[0].dueDate="2030-05-02";
 assert.equal((await resetJournalOwnedInvoiceCycle(h.input)).state,"applied");
 const date=(await h.input.writer.readCycleHistory()).find(w=>w.intent.cycle?.phase==="reset_date")!;
 assert.equal(date.intent.dateField!.expectedValue,OLD);assert.equal(date.intent.source.invoices.find(i=>i.id==="old")!.dueDate,"2030-05-02");
});
test("successor paid before enrollment retains B ownership for a separately proven C reset",async()=>{
 const h=await harness();await resetJournalOwnedInvoiceCycle(h.input);const b=(await h.input.writer.readCycleHistory()).at(-1)!;
 assert.equal(b.intent.cycle!.phase,"reset_stage");
 const paidB:GhlWriteIntent={...b.intent,cycle:{...b.intent.cycle!,phase:"paid"},
  expected:{stageId:"sent",status:"open",amountCents:9800,nameHash:cardNameHash(h.s.currentCard.name)},
  target:{stageId:"paid",amountCents:0,nameHash:cardNameHash(h.s.currentCard.name),updateName:false},
  source:{...b.intent.source,invoices:b.intent.source.invoices.map(i=>i.id==="new"?{...i,invoiceStatus:"paid",balanceCents:0}:i)}};
 paidB.cycle!.paidDateWitness={version:1,fieldId:FIELD,ownedValue:DUE,observedAt:NOW,priorOwnershipJournalId:b.id,otherFieldsSha256:sha("[]")};
 const paidId=await h.input.writer.prepare(paidB);await h.input.writer.confirm(paidId,{fieldId:FIELD,value:DUE,observedAt:NOW,otherFieldsSha256:sha("[]")});
 h.s.source.invoices[1].status="paid";h.s.source.invoices[1].balanceCents=0;
 h.s.source.invoices.push({id:"third",jobberClientId:"owner",status:"awaiting_payment",totalCents:7500,balanceCents:7500,issuedDate:"2030-06-11",dueDate:"2030-06-20",category:null});
 h.s.card.stageId="paid";h.s.card.amountCents=0;h.s.currentCard.pipelineStageId="paid";h.s.currentCard.monetaryValue=0;
 h.input.scope.invoiceId="third";h.s.binding.invoiceId="third";h.input.expectedCard=structuredClone(h.s.currentCard);
 h.proof.invoiceId="new";h.proof.oldEnrollmentJournalId=b.id;h.proof.oldPaidJournalId=paidId;
 h.input.deps.updateDate=async(_id,field,date)=>{assert.equal(date,"2030-06-20");h.s.currentCard.customFields=[{id:field,fieldValue:date}];h.s.field.currentValue=date;};
 assert.equal((await resetJournalOwnedInvoiceCycle(h.input)).state,"applied");
 const history=await h.input.writer.readCycleHistory();assert.ok(!history.some(w=>w.intent.cycle?.phase==="enroll" && w.intent.cycle.invoiceId==="new"));
 assert.equal(history.at(-1)!.intent.cycle!.invoiceId,"third");assert.equal(history.at(-1)!.intent.cycle!.predecessorInvoiceId,"new");
});

for(const kind of ["pre-witness","readback"] as const)test(`missing ${kind} preserves confirmed Paid but withholds cycle reuse even with synthetic cleanup assertion`,async()=>{
 const h=await harness(true,kind!=="pre-witness",kind!=="readback");
 const history=await h.input.writer.readCycleHistory();assert.equal(history.find(w=>w.intent.cycle?.phase==="paid")!.state,"confirmed");
 const result=await resetJournalOwnedInvoiceCycle(h.input);assert.equal(result.state,"held");assert.ok(!h.calls.some(c=>c.includes("PUT")));assert.equal(h.f.rows[1].status,"running");
});

for(const boundary of ["date-effects","date-final-claim","stage-final-claim","revoked-before-admission"]){
 test(`reset retains real standing proof at ${boundary}`,async()=>{
  const {realStandingSnapshot}=await import("./helpers/real-standing-snapshot");
  const h=await harness(),originalNow=Date.now,oldLocation=process.env.GHL_LOCATION_ID;
  let at=Date.parse(NOW);Date.now=()=>at;process.env.GHL_LOCATION_ID=LOC;h.input.now=()=>new Date(at);
  try{
   const real=realStandingSnapshot(h.input.scope,h.s,h.input.now,true);h.input.deps.readFresh=async()=>{
    const s=await real.read();if(boundary==="revoked-before-admission")real.revoke();return s;
   };
   const effects=h.input.deps.workflows;let n=0;
   h.input.deps.workflows=async()=>{const r=await effects();if(++n===2 && boundary==="date-effects")at+=300001;return r;};
   h.input.deps.nativeCleanup=async()=>({...h.proof,observedAt:new Date(at).toISOString()});
   const pending=h.input.writer.assertPending.bind(h.input.writer);let claims=0;
   h.input.writer.assertPending=async(id)=>{await pending(id);claims++;
    if((boundary==="date-final-claim" && claims===2)||(boundary==="stage-final-claim" && claims===4))at+=300001;
   };
   if(boundary==="revoked-before-admission"){
    assert.equal((await resetJournalOwnedInvoiceCycle(h.input)).state,"held");assert.equal(h.f.rows[1].errorMessage,null);
   }else{
    await assert.rejects(resetJournalOwnedInvoiceCycle(h.input),/identity coverage/);
    assert.equal(h.f.rows[1].status,"blocked");assert.equal((await h.input.writer.readCycleHistory()).at(-1)!.state,"pending");
   }
   assert.ok(!h.calls.includes("stage-PUT"));
   assert.equal(h.calls.filter(c=>c==="date-PUT").length,boundary==="stage-final-claim"?1:0);
  }finally{Date.now=originalNow;if(oldLocation===undefined)delete process.env.GHL_LOCATION_ID;else process.env.GHL_LOCATION_ID=oldLocation;}
 });
}
test("unexpired real standing snapshot permits owned reset",async()=>{
 const {realStandingSnapshot}=await import("./helpers/real-standing-snapshot");const h=await harness();
 const originalNow=Date.now,oldLocation=process.env.GHL_LOCATION_ID;Date.now=()=>Date.parse(NOW);process.env.GHL_LOCATION_ID=LOC;
 try{const real=realStandingSnapshot(h.input.scope,h.s,h.input.now,true);h.input.deps.readFresh=real.read;
  assert.equal((await resetJournalOwnedInvoiceCycle(h.input)).state,"applied");assert.equal(real.reads(),4);
 }finally{Date.now=originalNow;if(oldLocation===undefined)delete process.env.GHL_LOCATION_ID;else process.env.GHL_LOCATION_ID=oldLocation;}
});

async function directHarness() {
 const h=await harness();
 delete h.policy.nativeReset;
 h.policy.directRemoval={apiVersion:"v3",contractSha256:"b".repeat(64),evidenceRef:"synthetic-reviewed-acknowledgment-and-dispatch-risk",residualDispatchAndExternalEnrollmentRiskAcceptanceRef:"synthetic-acceptance",singleCycleWriterReviewRef:"synthetic-exclusive-writer"};
 h.input.env.GHL_DIRECT_WORKFLOW_REMOVAL_ENABLED="true";h.pin();
 const input={...h.input,deps:{...h.input.deps,removeWorkflow:async(contact:string,workflow:string)=>{
  h.calls.push("DELETE");assert.deepEqual([contact,workflow],["contact","fixed"]);
  const pending=(await h.input.writer.readCycleHistory()).at(-1)!;
  assert.equal(pending.state,"pending");assert.equal(pending.intent.workflowRemoval?.invoiceId,"old");
  return {httpStatus:200 as const,succeeded:true as const};
 }}};
 return {...h,input};
}
test("direct removal acknowledgment is durably separate from date/stage; no native workflow or quiescence claim",async()=>{
 const h=await directHarness();h.input.deps.nativeCleanup=async()=>{throw new Error("Native adapter must not run");};
 assert.equal((await resetJournalOwnedInvoiceCycle(h.input)).state,"applied");
 assert.ok(h.calls.indexOf("DELETE")<h.calls.indexOf("date-PUT"));
 const history=await h.input.writer.readCycleHistory(),r=history.find(w=>w.intent.workflowRemoval)!;
 assert.deepEqual(r.removalAcknowledgment,{version:1,httpStatus:200,succeeded:true,observedAt:new Date(NOW).toISOString()});
 assert.equal(r.intent.cycle,undefined);assert.equal((r.removalAcknowledgment as any).noRelevantActiveExecution,undefined);
 const date=history.find(w=>w.intent.cycle?.phase==="reset_date")!;
 assert.equal(date.intent.cycle!.cleanup!.removalJournalId,r.id);
 assert.equal(date.intent.cycle!.cleanup!.orderedClearAcknowledged,false);
});
for(const kind of ["disabled","missing-contract","wrong-version","unowned-date","missing-paid-witness","source-paid-conflict"]){
 test(`direct removal gate ${kind} causes no DELETE`,async()=>{
  const h=await directHarness();
  if(kind==="disabled")delete h.input.env.GHL_DIRECT_WORKFLOW_REMOVAL_ENABLED;
  if(kind==="missing-contract")delete h.policy.directRemoval;
  if(kind==="wrong-version")h.policy.directRemoval!.apiVersion="wrong" as any;
  if(kind==="unowned-date"){h.s.field.currentValue="2030-01-01";h.s.currentCard.customFields![0].fieldValue="2030-01-01";h.input.expectedCard=structuredClone(h.s.currentCard);}
  if(kind==="missing-paid-witness"){const row=h.f.rows[0],j=JSON.parse(row.errorMessage.split("FLEX_GHL_WRITE_JOURNAL_V1:")[1]);delete j.writes[1].intent.cycle.paidDateWitness;delete j.writes[1].paidDateReadback;j.writes[1].fingerprint=sha(JSON.stringify(j.writes[1].intent));row.errorMessage="FLEX_GHL_WRITE_JOURNAL_V1:"+JSON.stringify(j);}
  if(kind==="source-paid-conflict")h.s.source.invoices[0].balanceCents=1;
  h.pin();assert.equal((await resetJournalOwnedInvoiceCycle(h.input)).state,"held");assert.ok(!h.calls.includes("DELETE"));
 });
}
for(const kind of ["timeout","malformed","negative","lost-prepare-ack","lost-receipt-ack"]){
 test(`direct removal ${kind} fences with no automatic retry`,async()=>{
  const h=await directHarness(),remove=h.input.deps.removeWorkflow;
  if(kind==="lost-prepare-ack")h.f.loseNextCommit();
  h.input.deps.removeWorkflow=async(c,w)=>{
   const ack=await remove(c,w);
   if(kind==="timeout")throw new Error("Timeout unknown");
   if(kind==="malformed")return {} as any;
   if(kind==="negative")return {...ack,succeeded:false} as any;
   if(kind==="lost-receipt-ack")h.f.loseNextCommit();
   return ack;
  };
  await assert.rejects(resetJournalOwnedInvoiceCycle(h.input));
  assert.equal(h.f.rows[1].status,"blocked");assert.equal(h.calls.filter(c=>c==="DELETE").length,kind==="lost-prepare-ack"?0:1);
  assert.ok(!h.calls.includes("date-PUT"));
  const restart=new SyncRunWriter("next-run",h.f.db);
  await assert.rejects(resetJournalOwnedInvoiceCycle({...h.input,writer:restart}));
  assert.equal(h.calls.filter(c=>c==="DELETE").length,kind==="lost-prepare-ack"?0:1);
 });
}
test("acknowledged removal survives a completed held run; later process reuses receipt without DELETE",async()=>{
 const h=await directHarness(),read=h.input.deps.readFresh;let deleted=false;
 const remove=h.input.deps.removeWorkflow;
 h.input.deps.removeWorkflow=async(c,w)=>{const result=await remove(c,w);deleted=true;return result;};
 h.input.deps.readFresh=async()=>{if(deleted)throw new Error("Read unavailable after acknowledged removal");return read();};
 assert.equal((await resetJournalOwnedInvoiceCycle(h.input)).state,"held");
 const ack=(await h.input.writer.readCycleHistory()).find(w=>w.intent.workflowRemoval)!.removalAcknowledgment;
 await h.input.writer.finish("complete");
 h.f.rows.push({id:"third-run",status:"running",errorMessage:null,startedAt:new Date(),completedAt:null});
 const restarted=new SyncRunWriter("third-run",h.f.db);
 h.input.deps.readFresh=read;
 assert.equal((await resetJournalOwnedInvoiceCycle({...h.input,writer:restarted})).state,"applied");
 assert.equal(h.calls.filter(c=>c==="DELETE").length,1);
 assert.deepEqual((await restarted.readCycleHistory()).find(w=>w.intent.workflowRemoval)!.removalAcknowledgment,ack);
 // New ownership means this old removal can never be called again for that cycle.
 assert.equal((await resetJournalOwnedInvoiceCycle({...h.input,writer:restarted})).state,"held");
 assert.equal(h.calls.filter(c=>c==="DELETE").length,1);
});
test("source changes during removal stop date/stage while retaining acknowledged receipt",async()=>{
 const h=await directHarness(),remove=h.input.deps.removeWorkflow;
 h.input.deps.removeWorkflow=async(c,w)=>{const result=await remove(c,w);h.s.source.invoices[1].status="paid";h.s.source.invoices[1].balanceCents=0;return result;};
 assert.equal((await resetJournalOwnedInvoiceCycle(h.input)).state,"held");
 assert.ok(!h.calls.includes("date-PUT"));assert.equal((await h.input.writer.readCycleHistory()).at(-1)!.state,"confirmed");
});
test("final removal claim rechecks original branded coverage; expiry fences before DELETE",async()=>{
 const {realStandingSnapshot}=await import("./helpers/real-standing-snapshot"),h=await directHarness();
 const originalNow=Date.now,oldLocation=process.env.GHL_LOCATION_ID;let at=Date.parse(NOW);
 Date.now=()=>at;process.env.GHL_LOCATION_ID=LOC;h.input.now=()=>new Date(at);
 try{
  const real=realStandingSnapshot(h.input.scope,h.s,h.input.now,true);h.input.deps.readFresh=real.read;
  const pending=h.input.writer.assertPending.bind(h.input.writer);let claims=0;
  h.input.writer.assertPending=async(id)=>{await pending(id);if(++claims===2)at+=300001;};
  await assert.rejects(resetJournalOwnedInvoiceCycle(h.input));assert.ok(!h.calls.includes("DELETE"));assert.equal(h.f.rows[1].status,"blocked");
 }finally{Date.now=originalNow;if(oldLocation===undefined)delete process.env.GHL_LOCATION_ID;else process.env.GHL_LOCATION_ID=oldLocation;}
});
for(const barrier of [2,4])test(`strict reset expiry after final pending barrier ${barrier} stops mutation`,async()=>{
 const h=await harness();let at=Date.parse(NOW);h.input.now=()=>new Date(at);
 const pending=h.input.writer.assertPending.bind(h.input.writer);let n=0;
 h.input.writer.assertPending=async id=>{await pending(id);if(++n===barrier)at+=900001;};
 await assert.rejects(resetJournalOwnedInvoiceCycle(h.input),/Source\/card evidence expired/);
 assert.equal(h.calls.filter(c=>c==="date-PUT").length,barrier===4?1:0);assert.ok(!h.calls.includes("stage-PUT"));assert.equal(h.f.rows[1].status,"blocked");
});
