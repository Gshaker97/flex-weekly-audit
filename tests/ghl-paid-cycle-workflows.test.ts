import test from "node:test";
import assert from "node:assert/strict";
import { workflowInventoryHash, verifyPaidCycleWorkflowInventory, paidCycleHoldDetail } from "../lib/ghl-paid-cycle-workflows";
const entries=()=>[{id:"b",locationId:"loc",status:"published",version:2,updatedAt:"2026-11-09T00:00:00Z"},{id:"a",locationId:"loc",status:"draft",version:1,updatedAt:"2026-11-08T00:00:00Z"}];
const contract=()=>({entries:entries(),sha256:workflowInventoryHash(entries(),"loc")});
test("whole sorted workflow inventory hash ignores API names and order but pins reviewed status",async()=>{
 const expected=contract();
 const result=await verifyPaidCycleWorkflowInventory(expected,"loc",async()=>({workflows:entries().reverse().map(w=>({...w,name:"not evidence"}))}));
 assert.equal(result,expected.sha256);assert.equal(workflowInventoryHash(entries().reverse(),"loc"),expected.sha256);
});
for(const kind of ["added","removed","status","version","updatedAt","location","duplicate","missing id","missing status","missing version","missing updatedAt","nonarray","next page","truncated","total mismatch","malformed pagination","continuation cursor","second page"])
 test(`workflow inventory holds ${kind}`,async()=>{
  const raw:any={workflows:entries()};
  if(kind==="added")raw.workflows.push({...raw.workflows[0],id:"c"});
  if(kind==="removed")raw.workflows.pop();
  if(kind==="status")raw.workflows[0].status="draft";
  if(kind==="version")raw.workflows[0].version++;
  if(kind==="updatedAt")raw.workflows[0].updatedAt="2026-11-09T01:00:00Z";
  if(kind==="location")raw.workflows[0].locationId="elsewhere";
  if(kind==="duplicate")raw.workflows.push(raw.workflows[0]);
  if(kind.startsWith("missing "))delete raw.workflows[0][kind.slice(8)];
  if(kind==="nonarray")raw.workflows={};
  if(kind==="next page")raw.pageInfo={hasNextPage:true};
  if(kind==="truncated")raw.truncated=true;
  if(kind==="total mismatch")raw.meta={total:3};
  if(kind==="malformed pagination")raw.meta={hasMore:"false"};
  if(kind==="continuation cursor")raw.pagination={nextCursor:"next"};
  if(kind==="second page")raw.meta={page:2};
  await assert.rejects(verifyPaidCycleWorkflowInventory(contract(),"loc",async()=>raw));
 });
test("private report hold details never forward provider secrets or raw errors",async()=>{
 let caught:unknown;try{await verifyPaidCycleWorkflowInventory(contract(),"loc",async()=>{throw new Error("secret example provider body");});}catch(e){caught=e;}
 assert.equal(paidCycleHoldDetail(caught).code,"workflow_inventory_read_failed");
 assert.doesNotMatch(JSON.stringify(paidCycleHoldDetail(caught)),/secret example/);
 assert.doesNotMatch(JSON.stringify(paidCycleHoldDetail(new Error("unrecognized secret example"))),/secret example/);
});
test("review contract rejects a changed hash or names rather than silently changing approved evidence",async()=>{
 const bad:any=contract();bad.sha256="0".repeat(64);await assert.rejects(verifyPaidCycleWorkflowInventory(bad,"loc",async()=>({workflows:entries()})),/hash/);
 const named:any=contract();named.entries[0].name="unapproved field";await assert.rejects(verifyPaidCycleWorkflowInventory(named,"loc",async()=>({workflows:entries()})),/fields/);
});
for(const [message,code] of [
 ["Omissions differ from exact reviewed quarantine","identity_quarantine_changed"],
 ["Identity coverage account changed or unavailable","source_account_unverified"],
 ["Exact source owner/invoice identity disagrees","source_owner_invoice_mismatch"],
 ["Paid-cycle selected contact differs from primary source identity","selected_identity_unverified"],
 ["Selected contact identifiers overlap another GHL contact","identity_ownership_conflict"],
 ["Fresh Jobber identity snapshot omits a cached owner","identity_quarantine_changed"],
])test(`safe actionable code for ${code}`,()=>{assert.equal(paidCycleHoldDetail(new Error(message)).code,code);});
for(const rows of [[],entries().slice(0,1),entries().map(r=>({...r,status:"unknown"}))])test("empty, undersized or unknown-status inventory cannot be reviewed",()=>{assert.throws(()=>workflowInventoryHash(rows,"loc"));});
