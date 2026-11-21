import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runConfiguredDateRepair } from "../lib/ghl-date-repair-operation";
import { writerFixture } from "./helpers/sync-writer-fixture";
function fixture(){const calls:string[]=[];const req={version:1,scope:{locationId:"loc",opportunityId:"opp",contactId:"contact",invoiceId:"inv",jobberClientId:"owner"},approval:{approvalId:"approved"},workflows:[{id:"w1"},{id:"w2"}]};const raw=JSON.stringify(req);const env:Record<string,string>={GHL_DUE_DATE_REPAIR_ENABLED:"true",SYNC_ADMISSION_MODE:"cron_only",GHL_INVOICE_WRITE_MODE:"review",GHL_PHONE_WRITES_ENABLED:"false",GHL_LOCATION_ID:"loc",GHL_DUE_DATE_REPAIR_REQUEST:raw,GHL_DUE_DATE_REPAIR_REQUEST_SHA256:createHash("sha256").update(raw).digest("hex")};const deps:any={repair:async(i:any)=>{calls.push("repair");await i.verifyEffects();await i.readFresh();return {state:"applied"};},read:async(s:any)=>{calls.push("read");assert.deepEqual(s,req.scope);return {};},effects:async(l:any,w:any)=>{calls.push("effects");assert.equal(l,"loc");assert.deepEqual(w,req.workflows);return true;}};return {env,deps,calls,writer:writerFixture().writer};}
test("ordinary cron never reads provider or attempts repair",async()=>{const h=fixture();delete h.env.GHL_DUE_DATE_REPAIR_ENABLED;assert.equal((await runConfiguredDateRepair({...h,entrypoint:"standalone_cron"})).state,"disabled");assert.deepEqual(h.calls,[]);});
for(const [key,value] of [["SYNC_ADMISSION_MODE","mixed"],["GHL_INVOICE_WRITE_MODE","all_verified"],["GHL_PHONE_WRITES_ENABLED","true"],["GHL_DUE_DATE_REPAIR_REQUEST_SHA256","wrong"],["GHL_LOCATION_ID","wrong"]])test(`operation holds ${key}`,async()=>{const h=fixture();h.env[key]=value;assert.equal((await runConfiguredDateRepair({...h,entrypoint:"standalone_cron"})).state,"held");assert.deepEqual(h.calls,[]);});
test("HTTP cannot borrow cron writer authority",async()=>{const h=fixture();assert.equal((await runConfiguredDateRepair({...h,entrypoint:"http"})).state,"held");assert.deepEqual(h.calls,[]);});
test("pinned exact request invokes only trusted live adapters",async()=>{const h=fixture();assert.equal((await runConfiguredDateRepair({...h,entrypoint:"standalone_cron"})).state,"applied");assert.deepEqual(h.calls,["repair","effects","read"]);});
test("unknown writer outcome is propagated, never turned into held success",async()=>{const h=fixture();h.deps.repair=async()=>{throw new Error("unknown provider outcome")};await assert.rejects(runConfiguredDateRepair({...h,entrypoint:"standalone_cron"}),/unknown provider/);});

test("optional coverage policy is passed only from entire SHA-pinned exact request",async()=>{
 const h=fixture();const request=JSON.parse(h.env.GHL_DUE_DATE_REPAIR_REQUEST);
 request.identityCoveragePolicy={accountId:"account",reviewRef:"review",reviewedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),quarantine:[{jobberClientId:"missing-a",email:null,phone:null},{jobberClientId:"missing-b",email:null,phone:null}]};
 h.env.GHL_DUE_DATE_REPAIR_REQUEST=JSON.stringify(request);
 assert.equal((await runConfiguredDateRepair({...h,entrypoint:"standalone_cron"})).state,"held");assert.deepEqual(h.calls,[]);
 h.env.GHL_DUE_DATE_REPAIR_REQUEST_SHA256=createHash("sha256").update(h.env.GHL_DUE_DATE_REPAIR_REQUEST).digest("hex");
 let reads=0;h.deps.read=async(scope:any,deps:any,now:any,policy:any)=>{reads++;assert.deepEqual(scope,request.scope);assert.equal(deps,undefined);assert.equal(now,undefined);assert.deepEqual(policy,request.identityCoveragePolicy);return {};};
 assert.equal((await runConfiguredDateRepair({...h,entrypoint:"standalone_cron"})).state,"applied");assert.equal(reads,1);
});
test("absent coverage policy remains absent at trusted reader",async()=>{
 const h=fixture();h.deps.read=async(_scope:any,_deps:any,_now:any,policy:any)=>{assert.equal(policy,undefined);return {};};
 await runConfiguredDateRepair({...h,entrypoint:"standalone_cron"});
});
test("private review passes optional policy without acquiring write capability",async()=>{
 const {readFile}=await import("node:fs/promises");const source=await readFile(new URL("../scripts/review-opportunity-date.ts",import.meta.url),"utf8");
 assert.match(source,/readVerifiedDateRepairSnapshot\(request.scope, undefined, undefined, request.identityCoveragePolicy\)/);
 assert.doesNotMatch(source,/runConfiguredDateRepair|repairOpportunityDueDate|acquireSyncRunWriter/);
});
