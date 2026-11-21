import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readPaidCycleReadiness, readAccountOwnerInvoices, paidCycleWriteGates, reconcilePaidCycle, runConfiguredPaidCycle, type PaidCycleRequest } from "../lib/ghl-paid-cycle";
import { workflowInventoryHash } from "../lib/ghl-paid-cycle-workflows";
import { readReviewedIdentityCoverage } from "../lib/ghl-identity-coverage";
import { cardNameHash } from "../lib/sync-writer-control";
import { writerFixture } from "./helpers/sync-writer-fixture";
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
function fixture(paid=false) {
 const owner={jobberClientId:"owner",email:"owner@example.test",phone:"+16025550100"};
 const omitted=[{jobberClientId:"missing-a",email:null,phone:null},{jobberClientId:"missing-b",email:null,phone:null}];
 const fresh=()=>({id:"owner",emails:owner.email?[{address:owner.email,primary:true}]:[],phones:[{number:owner.phone,primary:true}]});
 const data:any={customers:[owner,...omitted],contacts:[{id:"contact",email:owner.email,phone:owner.phone}],
  invoices:[{id:"invoice",client:{id:"owner"},invoiceStatus:paid?"paid":"past_due",amounts:{total:137,invoiceBalance:paid?0:137},issuedDate:"2026-10-27T07:00:00Z",dueDate:"2026-11-03T07:00:00Z",createdAt:null}],
  stored:[{jobberInvoiceId:"invoice"}],card:{id:"card",locationId:"location",pipelineId:"pipeline",contactId:"contact",pipelineStageId:"overdue",status:"open",monetaryValue:137,name:"Original card",customFields:[{id:"date",fieldValue:"2026-11-03"}]}};
 data.workflows=[{id:"workflow",locationId:"location",status:"draft",version:1,updatedAt:"2026-11-09T00:00:00Z"},{id:"workflow-2",locationId:"location",status:"draft",version:1,updatedAt:"2026-11-09T00:00:00Z"}];
 const request:PaidCycleRequest={version:1,approvalId:"synthetic-approval",expiresAt:new Date(Date.now()+60000).toISOString(),
  scope:{locationId:"location",pipelineId:"pipeline",contactId:"contact",opportunityId:"card",jobberClientId:"owner",invoiceId:"invoice"},
  originalInvoice:{totalCents:13700,issuedDate:data.invoices[0].issuedDate,dueDate:data.invoices[0].dueDate},
  originalCard:{stageId:"overdue",amountCents:13700,nameHash:cardNameHash(data.card.name)},
  workflowInventory:{entries:structuredClone(data.workflows),sha256:workflowInventoryHash(data.workflows,"location")},
  identityCoveragePolicy:{accountId:"account",reviewRef:"review",reviewedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+120000).toISOString(),quarantine:[omitted[0],omitted[1]]}};
 const env:any={GHL_LOCATION_ID:"location",GHL_WRITE_APPROVAL_ID:request.approvalId,GHL_APPROVED_OPPORTUNITY_IDS:'["card"]',GHL_PHONE_WRITES_ENABLED:"false",GHL_INVOICE_WRITE_MODE:"review",SYNC_ADMISSION_MODE:"cron_only",GHL_PAID_CYCLE_ENABLED:"true"};
 const query:any=async(q:string,v:any)=>{
  if(q.includes("VerifyExplicitIdentityCoverage"))return {account:{id:data.account??"account"},clients:{nodes:q.includes("isArchived: false")?[fresh()]:[],pageInfo:{hasNextPage:false,endCursor:null}}};
  if(q.includes("VerifyQuarantinedIdentity"))return {account:{id:"account"},client:null};
  return {account:{id:"account"},client:fresh(),invoice:{id:data.exactInvoice??"invoice",client:{id:data.exactOwner??"owner"}}};
 };
 const deps:any={workflows:async()=>({workflows:structuredClone(data.workflows)}),customers:async()=>data.customers,stored:async()=>data.stored,counts:async()=>omitted.map(c=>({jobberClientId:c.jobberClientId,jobs:0,invoices:0})),
  coverage:(p:any,c:any,s:any,n:any)=>readReviewedIdentityCoverage(p,c,s,n,query),invoices:async(ownerId:string,accountId:string)=>{assert.equal(ownerId,"owner");assert.equal(accountId,"account");return structuredClone(data.invoices);},
  contacts:async()=>data.contacts,cards:async()=>data.cards??[data.card],refs:async()=>({pipelineId:"pipeline",stageIdByName:{"invoice sent":"sent","invoice overdue":"overdue","invoice paid":"paid"}}),card:async()=>structuredClone(data.card)};
 let puts=0,reads=0;const transport:any={update:async(id:string,stage:string,amount:number,name:any)=>{puts++;assert.equal(id,"card");assert.equal(name,undefined);data.card.pipelineStageId=stage;data.card.monetaryValue=amount;},read:async()=>{reads++;return structuredClone(data.card);}};
 const writer=writerFixture();
 const read=()=>readPaidCycleReadiness(request,env,deps);
 const apply=()=>reconcilePaidCycle({request,env,writer:writer.writer,readFresh:read,readWorkflows:deps.workflows,transport});
 const pin=()=>{env.GHL_PAID_CYCLE_REQUEST=JSON.stringify(request);env.GHL_PAID_CYCLE_REQUEST_SHA256=hash(env.GHL_PAID_CYCLE_REQUEST);};pin();
 return {owner,data,request,env,deps,query,read,apply,writer,transport,pin,puts:()=>puts,reads:()=>reads};
}
test("unpaid readiness runs real coverage without claiming payment, then same cycle can exit when paid",async()=>{
 const f=fixture();assert.equal((await f.read()).state,"currently_unpaid");assert.equal((await f.apply()).state,"currently_unpaid");assert.equal(f.puts(),0);assert.equal(f.writer.rows[0].errorMessage,null);
 f.data.invoices[0].invoiceStatus="paid";f.data.invoices[0].amounts.invoiceBalance=0;
 assert.equal((await f.apply()).state,"applied");assert.equal(f.puts(),1);assert.equal(f.data.card.pipelineStageId,"paid");assert.equal(f.data.card.monetaryValue,0);
 assert.equal((await f.apply()).state,"already_paid_zero");assert.equal(f.puts(),1);
});
test("Paid stage with nonzero value must be cleared, never a false no-op",async()=>{
 const f=fixture(true);f.data.card.pipelineStageId="paid";
 assert.equal((await f.read()).state,"paid_exit_candidate");assert.equal((await f.apply()).state,"applied");assert.equal(f.puts(),1);
});
for(const kind of ["policy expiry","new unpaid invoice","new paid invoice","second card","closed second card","second contact","secondary email","secondary phone","missing cached source","wrong account","wrong exact owner","wrong exact invoice","wrong invoice owner","zero total","refunded","void","paid positive","unknown status","unpaid zero","changed total","changed due","changed owner","closed card","changed card name","wrong location"])test(`readiness holds ${kind}`,async()=>{
 const f=fixture(true),d=f.data;
 if(kind==="policy expiry")f.request.identityCoveragePolicy.expiresAt=new Date(Date.now()-1).toISOString();
 if(kind==="new unpaid invoice"||kind==="new paid invoice")d.invoices.push({...d.invoices[0],id:"new",invoiceStatus:kind==="new paid invoice"?"paid":"past_due"});
 if(kind==="second card"||kind==="closed second card")d.cards=[d.card,{...d.card,id:"other",status:kind==="closed second card"?"won":"open"}];
 if(kind==="second contact")d.contacts.push({...d.contacts[0],id:"other"});
 if(kind==="secondary email")d.contacts.push({id:"other",additionalEmails:[{email:f.owner.email}]});
 if(kind==="secondary phone")d.contacts.push({id:"other",additionalPhones:[{phone:f.owner.phone}]});
 if(kind==="missing cached source")d.stored.push({jobberInvoiceId:"missing"});
 if(kind==="wrong account")d.account="other";
 if(kind==="wrong exact owner")d.exactOwner="other";
 if(kind==="wrong exact invoice")d.exactInvoice="other";
 if(kind==="wrong invoice owner")d.invoices[0].client.id="other";
 if(kind==="zero total")d.invoices[0].amounts.total=0;
 if(kind==="refunded"||kind==="void"||kind==="unknown status")d.invoices[0].invoiceStatus=kind==="unknown status"?null:kind;
 if(kind==="paid positive")d.invoices[0].amounts.invoiceBalance=1;
 if(kind==="unpaid zero")d.invoices[0].invoiceStatus="past_due";
 if(kind==="changed total")d.invoices[0].amounts.total=138;
 if(kind==="changed due")d.invoices[0].dueDate="2026-11-04T07:00:00Z";
 if(kind==="changed owner")d.card.contactId="other";
 if(kind==="closed card")d.card.status="won";
 if(kind==="changed card name")d.card.name="New cycle";
 if(kind==="wrong location")d.card.locationId="other";
 await assert.rejects(f.read());assert.equal((await f.apply()).state,"held");assert.equal(f.puts(),0);
});
test("phone-only scope still needs the explicit phone gate",async()=>{
 const f=fixture();f.owner.email="";f.data.contacts[0].email=null;
 assert.equal((await f.read()).state,"currently_unpaid");assert.equal((await f.read()).writeGates.phoneGateOpen,false);assert.equal((await f.apply()).state,"held");assert.equal(f.puts(),0);f.env.GHL_PHONE_WRITES_ENABLED="true";assert.equal((await f.read()).writeGates.phoneGateOpen,true);
});
test("even unchanged Paid/zero readiness executes coverage and source guards",async()=>{
 const f=fixture(true);f.data.card.pipelineStageId="paid";f.data.card.monetaryValue=0;f.data.account="other";
 await assert.rejects(f.read(),/account/);assert.equal((await f.apply()).state,"held");
});
for(const kind of ["source","card","expiry","pending fencing"])test(`post-admission ${kind} change blocks durably before PUT`,async()=>{
 const f=fixture(true);let n=0;
 const read=async()=>{if(n++===1){if(kind==="source")f.data.invoices[0].amounts.invoiceBalance=10;if(kind==="card")f.data.card.monetaryValue=136;if(kind==="expiry")f.request.expiresAt=new Date(Date.now()-1).toISOString();}return f.read();};
 const writer=kind==="pending fencing"?{prepare:f.writer.writer.prepare.bind(f.writer.writer),assertPending:async()=>{throw new Error("fenced");},confirm:f.writer.writer.confirm.bind(f.writer.writer),block:f.writer.writer.block.bind(f.writer.writer)}:f.writer.writer;
 await assert.rejects(reconcilePaidCycle({request:f.request,env:f.env,writer,readFresh:read,readWorkflows:f.deps.workflows,transport:f.transport}));assert.equal(f.puts(),0);assert.equal(f.writer.rows[0].status,"blocked");
});
for(const kind of ["timeout","429","readback amount","readback name","readback contact","readback status","readback location","readback fields","readback pipeline"])test(`${kind} leaves durable block and no retry`,async()=>{
 const f=fixture(true);let attempts=0;
 const transport:any={update:async(...args:any[])=>{attempts++;if(kind==="timeout"||kind==="429")throw new Error(kind);return f.transport.update(...args);},read:async()=>{const c=await f.transport.read();if(kind==="readback amount")c.monetaryValue=1;if(kind==="readback name")c.name="changed";if(kind==="readback contact")c.contactId="other";if(kind==="readback status")c.status="won";if(kind==="readback location")c.locationId="other";if(kind==="readback fields")c.customFields=[];if(kind==="readback pipeline")c.pipelineId="other";return c;}};
 await assert.rejects(reconcilePaidCycle({request:f.request,env:f.env,writer:f.writer.writer,readFresh:f.read,readWorkflows:f.deps.workflows,transport}));assert.equal(attempts,1);assert.equal(f.writer.rows[0].status,"blocked");
 await assert.rejects(f.writer.writer.prepare({} as any));assert.equal(attempts,1);
});
test("account checked on every complete owner invoice page",async()=>{
 const f=fixture(true);let n=0;
 const q:any=async(s:string,v:any)=>{assert.match(s,/account \{ id \}/);assert.equal(v.id,"owner");return {account:{id:++n===1?"account":"wrong"},client:{id:"owner",invoices:{nodes:n===1?f.data.invoices:[],pageInfo:{hasNextPage:n===1,endCursor:n===1?"next":null}}}};};
 await assert.rejects(readAccountOwnerInvoices("owner","account",q),/account/);assert.equal(n,2);
});
test("disabled operation is exact no-op; enablement requires whole request pin and cron/review/cohort",async()=>{
 const f=fixture();let calls=0;const deps:any={read:async()=>{calls++;return f.read();},reconcile:async()=>{calls++;return {state:"test"};}};
 delete f.env.GHL_PAID_CYCLE_ENABLED;assert.equal((await runConfiguredPaidCycle({entrypoint:"standalone_cron",writer:f.writer.writer,env:f.env,deps})).state,"disabled");assert.equal(calls,0);
 f.env.GHL_PAID_CYCLE_ENABLED="true";
 for(const [k,v] of [["GHL_PAID_CYCLE_REQUEST_SHA256","wrong"],["GHL_INVOICE_WRITE_MODE","sync"],["SYNC_ADMISSION_MODE","mixed"],["GHL_APPROVED_OPPORTUNITY_IDS",'["card","other"]']]){const env={...f.env,[k]:v};assert.equal((await runConfiguredPaidCycle({entrypoint:"standalone_cron",writer:f.writer.writer,env,deps})).state,"held");}
 assert.equal((await runConfiguredPaidCycle({entrypoint:"http",writer:f.writer.writer,env:f.env,deps})).state,"held");assert.equal(calls,0);
 assert.equal((await runConfiguredPaidCycle({entrypoint:"standalone_cron",writer:f.writer.writer,env:f.env,deps})).state,"test");assert.equal(calls,1);
});
test("configured operation passes pinned request to actual readiness and durable reconciliation",async()=>{
 const f=fixture(true);const deps:any={read:()=>f.read(),reconcile:(input:any)=>reconcilePaidCycle({...input,readWorkflows:f.deps.workflows,transport:f.transport})};
 assert.equal((await runConfiguredPaidCycle({entrypoint:"standalone_cron",writer:f.writer.writer,env:f.env,deps})).state,"applied");assert.equal(f.puts(),1);
});
test("lost durable admission reply blocks without any provider attempt",async()=>{
 const f=fixture(true);f.writer.loseNextCommit();
 await assert.rejects(f.apply(),/blocked pending operator review/);assert.equal(f.puts(),0);assert.equal(f.writer.rows[0].status,"blocked");
});
test("post-admission fresh source read failure never falls through to transport",async()=>{
 const f=fixture(true);let reads=0;
 const read=async()=>{if(reads++)throw new Error("source unavailable");return f.read();};
 await assert.rejects(reconcilePaidCycle({request:f.request,env:f.env,writer:f.writer.writer,readFresh:read,readWorkflows:f.deps.workflows,transport:f.transport}),/unavailable/);
 assert.equal(f.puts(),0);assert.equal(f.writer.rows[0].status,"blocked");
});
for(const kind of ["changed","added","removed","truncated"])test(`workflow inventory ${kind} immediately before final fence blocks durably with no PUT`,async()=>{
 const f=fixture(true);let finalReads=0;
 const finalRead=async()=>{finalReads++;const rows=structuredClone(f.data.workflows);if(kind==="changed")rows[0].version++;if(kind==="added")rows.push({...rows[0],id:"new-workflow"});if(kind==="removed")rows.pop();return {workflows:rows,...(kind==="truncated"?{hasMore:true}:{})};};
 await assert.rejects(reconcilePaidCycle({request:f.request,env:f.env,writer:f.writer.writer,readFresh:f.read,readWorkflows:finalRead,transport:f.transport}));
 assert.equal(finalReads,1);assert.equal(f.puts(),0);assert.equal(f.writer.rows[0].status,"blocked");
});
test("explicit reviewed published state is checked, never published by paid-cycle operation",async()=>{
 const f=fixture(true);f.data.workflows[0].status="published";f.request.workflowInventory={entries:structuredClone(f.data.workflows),sha256:workflowInventoryHash(f.data.workflows,"location")};
 assert.equal((await f.apply()).state,"applied");assert.equal(f.puts(),1);
});
test("changed workflow during post-admission full readiness revalidation blocks before final read or PUT",async()=>{
 const f=fixture(true);let reads=0,finalReads=0;
 const read=async()=>{if(reads++)f.data.workflows[0].status="published";return f.read();};
 await assert.rejects(reconcilePaidCycle({request:f.request,env:f.env,writer:f.writer.writer,readFresh:read,readWorkflows:async()=>{finalReads++;return f.deps.workflows();},transport:f.transport}));
 assert.equal(f.puts(),0);assert.equal(finalReads,0);assert.equal(f.writer.rows[0].status,"blocked");
});
test("read-only readiness assesses real source with approval/cohort/enable gates closed but never permits mutation",async()=>{
 const f=fixture(true);delete f.env.GHL_WRITE_APPROVAL_ID;delete f.env.GHL_PAID_CYCLE_ENABLED;f.env.GHL_APPROVED_OPPORTUNITY_IDS="[]";
 const snapshot=await f.read();assert.equal(snapshot.state,"paid_exit_candidate");assert.equal(snapshot.writeGates.approvalIdMatches,false);assert.equal(snapshot.writeGates.exactCardCohort,false);assert.equal(snapshot.writeGates.operationEnabled,false);
 assert.equal((await f.apply()).state,"held");assert.equal(f.puts(),0);assert.equal(f.writer.rows[0].errorMessage,null);
});
test("snapshot gate flags cannot override actual closed phone setting before admission",async()=>{
 const f=fixture(true);f.owner.email="";f.data.contacts[0].email=null;
 const read=async()=>{const s=await f.read();s.writeGates.phoneGateOpen=true;return s;};
 assert.equal((await reconcilePaidCycle({request:f.request,env:f.env,writer:f.writer.writer,readFresh:read,readWorkflows:f.deps.workflows,transport:f.transport})).state,"held");assert.equal(f.puts(),0);assert.equal(f.writer.rows[0].errorMessage,null);
 f.env.GHL_PHONE_WRITES_ENABLED="true";assert.equal((await f.apply()).state,"applied");
});

for(const invalid of [undefined,null,123])test(`paid-cycle rejects non-string request approval ${String(invalid)} before admission`,async()=>{
 const f=fixture(true);(f.request as any).approvalId=invalid;(f.env as any).GHL_WRITE_APPROVAL_ID=invalid;f.pin();
 await assert.rejects(f.read(),/Invalid or expired/);assert.equal(paidCycleWriteGates(f.request,f.env,false).approvalIdMatches,false);
 assert.equal((await f.apply()).state,"held");assert.equal(f.puts(),0);assert.equal(f.writer.rows[0].errorMessage,null);
 assert.equal((await runConfiguredPaidCycle({entrypoint:"standalone_cron",writer:f.writer.writer,env:f.env})).state,"held");
});
test("absent actual approval never grants paid-cycle authority with a syntactically valid request",async()=>{
 const f=fixture(true);delete f.env.GHL_WRITE_APPROVAL_ID;
 const snapshot=await f.read();assert.equal(snapshot.writeGates.approvalIdMatches,false);
 assert.equal((await f.apply()).state,"held");assert.equal(f.puts(),0);assert.equal(f.writer.rows[0].errorMessage,null);
});
