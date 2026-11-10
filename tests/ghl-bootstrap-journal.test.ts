import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {writerFixture} from "./helpers/sync-writer-fixture";
import {SyncRunWriter,cardNameHash,type GhlWriteIntent} from "../lib/sync-writer-control";
import {bootstrapCycleKey,type BootstrapClaim} from "../lib/ghl-existing-overdue-bootstrap";
const sha=(v:unknown)=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
function fixture(){
 const f=writerFixture();
 const scope={locationId:"loc",pipelineId:"pipeline",contactId:"contact",opportunityId:"card",jobberClientId:"owner",invoiceId:"invoice",workflowId:"fixed"};
 const claim:BootstrapClaim={version:1,scope,sentStageId:"sent",overdueStageId:"overdue",cycleKey:bootstrapCycleKey(scope),
  sourceFingerprint:"a".repeat(64),dueOn:"2030-01-01",category:"maintenance",categoryReviewRef:"review",policySha256:"b".repeat(64),
  approvalId:"approval",reviewRef:"review",enrollmentHistory:{kind:"no_prior"},expiresAt:"2031-01-01T00:00:00Z",clearanceMode:"historical_review_v1"};
 const state={stageId:"overdue",status:"open" as const,amountCents:10000,nameHash:cardNameHash("Invoice")};
 const intent:GhlWriteIntent={approvalId:"approval",pipelineId:"pipeline",contactId:"contact",opportunityId:"card",jobberClientId:"owner",
  expected:state,target:{...state,updateName:false},source:{observedAt:"2030-01-15T18:00:00Z",storedInvoiceIds:["invoice"],
   invoices:[{id:"invoice",jobberClientId:"owner",invoiceStatus:"past_due",totalCents:10000,balanceCents:10000,issuedDate:"2029-12-01",dueDate:"2030-01-01",createdAt:null}]},
  bootstrap:{claim,claimSha256:sha(claim),phase:"claim"}};
 return {f,claim,intent};
}
test("bootstrap claim and each exact phase persist; enrollment becomes normal owned cycle",async()=>{
 const {f,claim,intent}=fixture(),claimId=await f.writer.prepare(intent);await f.writer.confirm(claimId);
 const step=(phase:"bootstrap_stage"|"source_date"|"enroll_stage"):GhlWriteIntent=>{
  const s:GhlWriteIntent=structuredClone(intent);s.bootstrap={...s.bootstrap!,phase,claimId};
  s.expected.stageId=phase==="bootstrap_stage"?"overdue":"sent";s.target.stageId=phase==="enroll_stage"?"overdue":"sent";
  if(phase==="source_date")s.dateField={locationId:"loc",fieldId:"date",key:"opportunity.due_date",invoiceId:"invoice",expectedValue:null,targetValue:claim.dueOn,sourceFingerprint:claim.sourceFingerprint};
  if(phase==="enroll_stage")s.cycle={version:1,locationId:"loc",workflowId:"fixed",invoiceId:"invoice",dueOn:claim.dueOn,phase:"enroll"};
  return s;
 };
 for(const phase of ["bootstrap_stage","source_date","enroll_stage"] as const){const id=await f.writer.prepare(step(phase));await f.writer.confirm(id);}
 await f.writer.finish("complete");
 assert.deepEqual((await f.writer.readCycleHistory()).map(w=>w.intent.bootstrap?.phase),["claim","bootstrap_stage","source_date","enroll_stage"]);
 f.rows.push({id:"next",status:"running",errorMessage:null});const next=new SyncRunWriter("next",f.db);
 const mutated=structuredClone(intent);mutated.bootstrap!.claim.dueOn="2030-01-02";mutated.source.invoices[0].dueDate="2030-01-02";mutated.bootstrap!.claimSha256=sha(mutated.bootstrap!.claim);
 await assert.rejects(next.prepare(mutated));assert.equal(f.rows[1].status,"blocked");
});
test("ordinary enrollment cannot evade a prior bootstrap claim",async()=>{
 const {f,intent,claim}=fixture(),id=await f.writer.prepare(intent);await f.writer.confirm(id);
 const enroll=structuredClone(intent);delete enroll.bootstrap;enroll.expected.stageId="sent";enroll.target.stageId="overdue";
 enroll.cycle={version:1,locationId:"loc",workflowId:"fixed",invoiceId:"invoice",dueOn:claim.dueOn,phase:"enroll"};
 await assert.rejects(f.writer.prepare(enroll));
});
for(const kind of ["wrong-claim","wrong-scope","wrong-digest","wrong-stage","skip-first-phase","wrong-cycle","expired"]){
 test(`bootstrap journal holds ${kind}`,async()=>{
  const {f,intent}=fixture(),id=await f.writer.prepare(intent);await f.writer.confirm(id);
  const s=structuredClone(intent);s.bootstrap={...s.bootstrap!,phase:"bootstrap_stage",claimId:id};s.target.stageId="sent";
  if(kind==="wrong-claim")s.bootstrap.claimId="other";
  if(kind==="wrong-scope")s.contactId="other";
  if(kind==="wrong-digest")s.bootstrap.claimSha256="c".repeat(64);
  if(kind==="wrong-stage")s.target.stageId="late-fee";
  if(kind==="skip-first-phase"){s.bootstrap.phase="enroll_stage";s.expected.stageId="sent";s.target.stageId="overdue";s.cycle={version:1,locationId:"loc",workflowId:"fixed",invoiceId:"invoice",dueOn:"2030-01-01",phase:"enroll"};}
  if(kind==="wrong-cycle")s.bootstrap.claim.scope.invoiceId="other";
  if(kind==="expired"){s.bootstrap.claim.expiresAt="2020-01-01T00:00:00Z";s.bootstrap.claimSha256=sha(s.bootstrap.claim);}
  await assert.rejects(f.writer.prepare(s));assert.equal(f.rows[0].status,"blocked");
 });
}
