import test from "node:test";
import assert from "node:assert/strict";
import { readPrePaidDateWitness, readPaidDateReadback } from "../lib/ghl-paid-date-witness";
import { DUE_DATE_FIELD as FIELD,DUE_DATE_LOCATION as LOC } from "../lib/ghl-recurring-due-date";
import { cardNameHash,type GhlWriteIntent } from "../lib/sync-writer-control";
import { writerFixture } from "./helpers/sync-writer-fixture";
const NOW="2030-05-02T18:00:00Z",DUE="2030-05-01";
globalThis.fetch=async()=>{throw new Error("NETWORK FORBIDDEN");};
async function fixture(){
 const f=writerFixture();const intent:GhlWriteIntent={approvalId:"synthetic",pipelineId:"pipeline",contactId:"contact",opportunityId:"card",jobberClientId:"owner",
  cycle:{version:1,locationId:LOC,workflowId:"fixed",invoiceId:"invoice",dueOn:DUE,phase:"enroll"},
  expected:{stageId:"sent",status:"open",amountCents:10000,nameHash:cardNameHash("Synthetic")},target:{stageId:"overdue",amountCents:10000,nameHash:cardNameHash("Synthetic"),updateName:false},
  source:{observedAt:NOW,storedInvoiceIds:["invoice"],invoices:[{id:"invoice",jobberClientId:"owner",invoiceStatus:"past_due",totalCents:10000,balanceCents:10000,issuedDate:"2030-04-01",dueDate:DUE,createdAt:null}]}};
 const id=await f.writer.prepare(intent);await f.writer.confirm(id);const owner=(await f.writer.readCycleHistory())[0];
 const current={id:"card",locationId:LOC,pipelineId:"pipeline",contactId:"contact",pipelineStageId:"overdue",status:"open",monetaryValue:100,name:"Synthetic",customFields:[{id:FIELD,fieldValue:DUE},{id:"other",fieldValue:"keep"}]};
 const metadata={customFields:[{id:FIELD,locationId:LOC,fieldKey:"opportunity.due_date",model:"opportunity",dataType:"DATE"}]};
 const fields=async()=>structuredClone(metadata),now=()=>new Date(NOW);
 const paid:GhlWriteIntent={...intent,cycle:{...intent.cycle!,phase:"paid"},expected:{...intent.expected,stageId:"overdue"},target:{...intent.target,stageId:"paid",amountCents:0},source:{...intent.source,invoices:intent.source.invoices.map(i=>({...i,invoiceStatus:"paid",balanceCents:0}))}};
 return {f,owner,current,metadata,fields,now,paid};
}
test("exact nonblank owned-date witness and eligible readback survive in immutable private journal",async()=>{
 const h=await fixture();const w=await readPrePaidDateWitness({current:h.current,owner:h.owner,observedAt:NOW},h.fields,h.now);assert.ok(w);h.paid.cycle!.paidDateWitness=w;
 const id=await h.f.writer.prepare(h.paid);const accepted={...h.current,pipelineStageId:"paid",monetaryValue:0};
 const receipt=await readPaidDateReadback(h.paid,accepted,h.fields,h.now);assert.ok(receipt);await h.f.writer.confirm(id,receipt);
 const saved=(await h.f.writer.readCycleHistory()).at(-1)!;assert.equal(saved.intent.cycle!.paidDateWitness!.ownedValue,DUE);assert.equal(saved.paidDateReadback!.value,DUE);
});
for(const kind of ["blank","conflict","stale","future","wrong-card","wrong-location","wrong-field-type","malformed-fields","unavailable"]){test(`pre-Paid ${kind} withholds reuse evidence without throwing`,async()=>{
 const h=await fixture();let at=NOW;if(kind==="blank")h.current.customFields=[];if(kind==="conflict")h.current.customFields[0].fieldValue="2030-04-30";if(kind==="stale")at="2030-05-02T17:58:00Z";if(kind==="future")at="2030-05-02T19:00:00Z";if(kind==="wrong-card")h.current.id="other";if(kind==="wrong-location")h.current.locationId="other";if(kind==="wrong-field-type")h.metadata.customFields[0].dataType="TEXT";if(kind==="malformed-fields")h.current.customFields=null as any;if(kind==="unavailable")h.fields=async()=>{throw new Error("unavailable");};
 assert.equal(await readPrePaidDateWitness({current:h.current,owner:h.owner,observedAt:at},h.fields,h.now),undefined);
 const id=await h.f.writer.prepare(h.paid);await h.f.writer.confirm(id);assert.equal(h.f.rows[0].status,"running");
});}
for(const kind of ["blank","unchanged","different-date","other-field","wrong-card","wrong-location","wrong-stage","wrong-name","wrong-money","metadata-error"]){test(`Paid readback ${kind} records only eligible optional evidence`,async()=>{
 const h=await fixture();h.paid.cycle!.paidDateWitness=await readPrePaidDateWitness({current:h.current,owner:h.owner,observedAt:NOW},h.fields,h.now);
 const c={...structuredClone(h.current),pipelineStageId:"paid",monetaryValue:0};if(kind==="blank")c.customFields=c.customFields.filter(f=>f.id!==FIELD);if(kind==="different-date")c.customFields[0].fieldValue="2030-05-03";if(kind==="other-field")c.customFields[1].fieldValue="changed";if(kind==="wrong-card")c.id="other";if(kind==="wrong-location")c.locationId="other";if(kind==="wrong-stage")c.pipelineStageId="overdue";if(kind==="wrong-name")c.name="other";if(kind==="wrong-money")c.monetaryValue=10;if(kind==="metadata-error")h.fields=async()=>{throw new Error("missing");};
 const r=await readPaidDateReadback(h.paid,c,h.fields,h.now);assert.equal(!!r,["blank","unchanged"].includes(kind));
});}
test("missing witness skips optional readback IO and never pretends a pre-existing blank acknowledges cleanup",async()=>{
 const h=await fixture();let calls=0;assert.equal(await readPaidDateReadback(h.paid,{...h.current,customFields:[],pipelineStageId:"paid",monetaryValue:0},async()=>{calls++;return h.metadata;},h.now),undefined);assert.equal(calls,0);
});
