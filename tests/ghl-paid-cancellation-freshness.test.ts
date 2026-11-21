import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {cancelPaidOwnedInvoiceCycle} from "../lib/ghl-paid-cycle-cancellation";
import {DUE_DATE_LOCATION as LOC,DUE_DATE_FIELD as FIELD} from "../lib/ghl-recurring-due-date";
import {workflowInventoryHash} from "../lib/ghl-paid-cycle-workflows";
import {cardNameHash,type GhlWriteIntent} from "../lib/sync-writer-control";
import {writerFixture} from "./helpers/sync-writer-fixture";
import type {DateRepairSnapshot} from "../lib/ghl-opportunity-date-repair";
const NOW="2030-06-11T18:00:00Z";
async function fixture(){
 const f=writerFixture(),old={id:"old",jobberClientId:"owner",invoiceStatus:"past_due",totalCents:10000,balanceCents:10000,issuedDate:"2030-05-01",dueDate:"2030-06-01",createdAt:null};
 const state={stageId:"sent",status:"open" as const,amountCents:10000,nameHash:cardNameHash("Invoice")};
 const intent:GhlWriteIntent={pipelineId:"pipeline",contactId:"contact",opportunityId:"card",jobberClientId:"owner",expected:state,
  target:{...state,stageId:"overdue",updateName:false},source:{observedAt:NOW,storedInvoiceIds:["old"],invoices:[old]},
  cycle:{version:1,locationId:LOC,workflowId:"fixed",invoiceId:"old",dueOn:"2030-06-01",phase:"enroll"}};
 const id=await f.writer.prepare(intent);await f.writer.confirm(id);
 const scope={locationId:LOC,opportunityId:"card",contactId:"contact",jobberClientId:"owner"};
 const current={id:"card",locationId:LOC,pipelineId:"pipeline",contactId:"contact",pipelineStageId:"overdue",status:"open",monetaryValue:100,name:"Invoice",customFields:[{id:FIELD,fieldValue:"2030-06-01"}]};
 const s:DateRepairSnapshot={now:NOW,source:{observedAt:NOW,complete:true,invoices:[
  {id:"old",jobberClientId:"owner",status:"paid",totalCents:10000,balanceCents:0,issuedDate:"2030-05-01",dueDate:"2030-06-01",category:null},
  {id:"new",jobberClientId:"owner",status:"awaiting_payment",totalCents:10000,balanceCents:10000,issuedDate:"2030-06-01",dueDate:"2030-07-01",category:null}]},
  binding:{...scope,invoiceId:"old",pipelineId:"pipeline",method:"unique_unpaid_invoice",evidenceRef:"strict-complete",identityVerified:true,uniqueInvoiceCardVerified:true},
  card:{id:"card",locationId:LOC,pipelineId:"pipeline",contactId:"contact",stageId:"overdue",status:"open",amountCents:10000,observedAt:NOW},
  stageIds:{sent:"sent",overdue:"overdue"},field:{id:FIELD,locationId:LOC,model:"opportunity",key:"opportunity.due_date",type:"DATE",currentValueKnown:true,currentValue:"2030-06-01"},currentCard:current};
 const entries=[{id:"fixed",locationId:LOC,status:"published",version:1,updatedAt:NOW},{id:"closure",locationId:LOC,status:"draft",version:1,updatedAt:NOW}];
 const policy={version:1,approvalId:"approval",expiresAt:"2031-01-01T00:00:00Z",locationId:LOC,pipelineId:"pipeline",sentStageId:"sent",overdueStageId:"overdue",reminderId:"fixed",closureId:"closure",executionClearance:[],
  inventory:{entries,sha256:workflowInventoryHash(entries,LOC)},definitionReviewRef:"review",listenerInventoryReviewRef:"review",dateOnlyTriggerQaRef:"review",
  directRemoval:{apiVersion:"v3",contractSha256:"a".repeat(64),evidenceRef:"review",singleCycleWriterReviewRef:"review",residualDispatchAndExternalEnrollmentRiskAcceptanceRef:"review"},
  contract:{exactOpportunityStageTriggerOnly:true,sourceDueDateAnchoredWaits:true,freshPaymentAndChannelGuards:true,noCatchupOrRetainedExecutionReplay:true,unrelatedDateListenersAbsent:true,dateOnlyUpdateCannotEnrollOrSend:true}};
 const raw=JSON.stringify(policy),env={GHL_DIRECT_WORKFLOW_REMOVAL_ENABLED:"true",GHL_CYCLE_OWNERSHIP_ENABLED:"true",GHL_RECURRING_DUE_DATE_ENABLED:"true",GHL_INVOICE_WRITE_MODE:"sync",
  SYNC_ADMISSION_MODE:"cron_only",GHL_LOCATION_ID:LOC,GHL_APPROVED_OPPORTUNITY_IDS:'["card"]',GHL_WRITE_APPROVAL_ID:"approval",
  GHL_RECURRING_DUE_DATE_POLICY:raw,GHL_RECURRING_DUE_DATE_POLICY_SHA256:createHash("sha256").update(raw).digest("hex")};
 let at=Date.parse(NOW),deletes=0;
 const input={scope,expectedCard:current,mode:"sync",phoneOwner:false,writer:f.writer,env,now:()=>new Date(at),deps:{
  readFresh:async()=>structuredClone(s),workflows:async()=>({workflows:entries}),remove:async()=>{deletes++;return {httpStatus:200 as const,succeeded:true as const};}}};
 return {f,s,input,advance:()=>{at+=900001;},deletes:()=>deletes};
}
for(const kind of ["source-stale","card-stale","future","invalid","workflow-await","final-journal-await"]){
 test(`strict cancellation rejects ${kind} without DELETE`,async()=>{
  const h=await fixture();
  if(kind==="source-stale")h.s.source.observedAt="2030-06-11T17:44:59Z";
  if(kind==="card-stale")h.s.card.observedAt="2030-06-11T17:44:59Z";
  if(kind==="future")h.s.card.observedAt="2030-06-11T18:00:01Z";
  if(kind==="invalid")h.s.source.observedAt="invalid";
  if(kind==="workflow-await"){const read=h.input.deps.workflows;h.input.deps.workflows=async()=>{const r=await read();h.advance();return r;};}
  if(kind==="final-journal-await"){const check=h.f.writer.assertPending.bind(h.f.writer);let n=0;h.f.writer.assertPending=async id=>{await check(id);if(++n===2)h.advance();};}
  await assert.rejects(cancelPaidOwnedInvoiceCycle(h.input));assert.equal(h.deletes(),0);
  assert.equal(h.f.rows[0].status,kind==="final-journal-await"?"blocked":"running");
  if(kind==="final-journal-await")assert.equal((await h.f.writer.readCycleHistory()).at(-1)!.state,"pending");
 });
}
test("strict fresh cancellation still succeeds without any standing authorization",async()=>{
 const h=await fixture();assert.equal((await cancelPaidOwnedInvoiceCycle(h.input)).state,"cancelled");assert.equal(h.deletes(),1);
});
