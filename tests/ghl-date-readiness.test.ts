import test from "node:test";
import assert from "node:assert/strict";
import { readOwnerInvoiceEvidence, readVerifiedDateRepairSnapshot, workflowsMatchPaused } from "../lib/ghl-date-readiness";
const NOW="2026-11-09T18:00:00Z";
const row={id:"invoice-1",client:{id:"owner-1"},invoiceStatus:"past_due",amounts:{total:137,invoiceBalance:137},issuedDate:"2026-10-27T07:00:00Z",dueDate:"2026-11-03T07:00:00Z",createdAt:"2026-10-25T07:00:00Z"};
const connection=(nodes:any[],more=false,cursor:string|null=null)=>({client:{id:"owner-1",invoices:{nodes,pageInfo:{hasNextPage:more,endCursor:cursor}}}});
test("owner reader pins exact owner and completes all cursor pages",async()=>{let n=0;const q=async(query:string,v:any)=>{assert.match(query,/client\(id: \$id\)/);assert.equal(v.id,"owner-1");assert.equal(v.after,n?"cursor-1":null);return n++?connection([{...row,id:"invoice-2"}]):connection([row],true,"cursor-1");};assert.equal((await readOwnerInvoiceEvidence("owner-1",q as any)).length,2);assert.equal(n,2);});
for(const [name,value] of [
 ["missing owner",{client:null}], ["other owner",{client:{id:"wrong",invoices:{nodes:[],pageInfo:{hasNextPage:false}}}}],
 ["wrong invoice owner",connection([{...row,client:{id:"other"}}])], ["duplicate invoices",connection([row,row])],
 ["missing cursor",connection([row],true)], ["empty continued page",connection([],true,"cursor")],
 ["missing terminal proof",{client:{id:"owner-1",invoices:{nodes:[row],pageInfo:{}}}}]
] as const)test(`owner reader rejects ${name}`,async()=>{await assert.rejects(readOwnerInvoiceEvidence("owner-1",(async()=>value) as any));});
test("owner reader rejects repeated cursor and never returns partial evidence",async()=>{let n=0;await assert.rejects(readOwnerInvoiceEvidence("owner-1",(async()=>connection([{...row,id:`invoice-${n++}`}],true,"same")) as any),/Truncated/);assert.equal(n,2);});
const expected=[{id:"workflow-1",version:7,updatedAt:NOW},{id:"workflow-2",version:4,updatedAt:NOW}];
const workflowRows=()=>({workflows:expected.map(e=>({...e,locationId:"loc-1",status:"draft"}))});
test("workflow read must match exact reviewed Draft versions",()=>{assert.equal(workflowsMatchPaused(workflowRows(),"loc-1",expected),true);});
for(const kind of ["published","changed_version","changed_time","wrong_location","missing","duplicate","invalid"])test(`workflow check holds ${kind}`,()=>{const r:any=workflowRows();if(kind==="published")r.workflows[0].status="published";if(kind==="changed_version")r.workflows[0].version++;if(kind==="changed_time")r.workflows[0].updatedAt="2026-11-09T18:01:00Z";if(kind==="wrong_location")r.workflows[0].locationId="other";if(kind==="missing")r.workflows.pop();if(kind==="duplicate")r.workflows.push(r.workflows[0]);if(kind==="invalid")r.workflows=null;assert.equal(workflowsMatchPaused(r,"loc-1",expected),false);});
function fixture(){
 process.env.GHL_LOCATION_ID="loc-1";
 const scope={locationId:"loc-1",opportunityId:"opp-1",contactId:"contact-1",jobberClientId:"owner-1",invoiceId:"invoice-1"};
 const data:any={customers:[{jobberClientId:"owner-1",email:"qa@example.test",phone:"+16025550101"}],identities:[{id:"owner-1",emails:[{address:"qa@example.test",primary:true}],phones:[{number:"+16025550101",primary:true}]}],contacts:[{id:"contact-1",email:"qa@example.test",phone:"+16025550101"}],invoices:[row],stored:[{jobberInvoiceId:"invoice-1"}],card:{id:"opp-1",locationId:"loc-1",contactId:"contact-1",pipelineId:"pipe-1",pipelineStageId:"overdue",status:"open",monetaryValue:137,customFields:[{id:"date-1",fieldValue:""}]},fields:{customFields:[{id:"date-1",fieldKey:"opportunity.due_date",dataType:"DATE",model:"opportunity",locationId:"loc-1"}]}};
 const deps:any={customers:async()=>data.customers,identities:async()=>data.identities,contacts:async()=>data.contacts,ownerInvoices:async()=>data.invoices,storedInvoices:async()=>data.stored,card:async()=>data.card,fields:async()=>data.fields,refs:async()=>({pipelineId:"pipe-1",stageIdByName:{"invoice sent":"sent","invoice overdue":"overdue"}}),cards:async()=>data.cards??[data.card]};
 return {scope,data,deps};
}
test("trusted reader derives identity and one-invoice binding from fresh complete reads",async()=>{const f=fixture();const s=await readVerifiedDateRepairSnapshot(f.scope,f.deps,()=>new Date(NOW));assert.equal(s.binding.identityVerified,true);assert.equal(s.source.invoices.length,1);assert.equal(s.source.invoices[0].category,null);assert.equal(s.binding.method,"unique_unpaid_invoice");assert.match(s.binding.evidenceRef,/fresh-complete-identity:/);});
for(const [name,change] of [
 ["unrelated selected contact",(d:any)=>{d.contacts[0].email="other@example.test";d.contacts[0].phone="+16025550102"}],
 ["omitted source owner",(d:any)=>{d.customers.push({jobberClientId:"missing"})}],
 ["duplicate contact",(d:any)=>{d.contacts.push({...d.contacts[0],id:"contact-2"})}],
 ["unresolved competing phone",(d:any)=>{d.contacts.push({id:"contact-2",phone:"invalid"})}],
 ["secondary ownership overlap",(d:any)=>{d.contacts.push({id:"contact-2",additionalEmails:[{email:"qa@example.test"}]})}],
 ["closed duplicate card",(d:any)=>{d.cards=[d.card,{...d.card,id:"opp-2",status:"won"}]}],
 ["missing source invoice",(d:any)=>{d.stored.push({jobberInvoiceId:"missing"})}],
 ["malformed field response",(d:any)=>{d.card.customFields=null}],
 ["second open cycle",(d:any)=>{d.invoices.push({...row,id:"invoice-2"})}],
 ["paid positive conflict",(d:any)=>{d.invoices[0]={...row,invoiceStatus:"paid"}}],
 ["changed contact on exact card",(d:any)=>{d.card.contactId="other"}],
 ["wrong date value",(d:any)=>{d.card.customFields[0].fieldValue="2026-11-04"}],
] as const)test(`trusted reader retains hold: ${name}`,async()=>{const f=fixture();change(f.data);await assert.rejects(readVerifiedDateRepairSnapshot(f.scope,f.deps,()=>new Date(NOW)));});
test("source read freshness starts before all API reads, not after",async()=>{const f=fixture();let n=0;await assert.rejects(readVerifiedDateRepairSnapshot(f.scope,f.deps,()=>new Date(n++?"2026-11-09T18:16:00Z":NOW)),/stale/);});
test("trusted full GET reader recognizes observed omitted blank date representation",async()=>{const f=fixture();delete f.data.card.customFields;const s=await readVerifiedDateRepairSnapshot(f.scope,f.deps,()=>new Date(NOW));assert.equal(s.field.currentValueKnown,true);assert.equal(s.field.currentValue,null);});
