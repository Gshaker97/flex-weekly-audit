import test from "node:test";
import assert from "node:assert/strict";
import { removeContactFromWorkflowOnce } from "../lib/ghl";
for (const kind of ["success","429","500","204","malformed","negative","timeout"]) {
 test(`workflow DELETE is one attempt with exact v3 contract: ${kind}`,async()=>{
  const original=globalThis.fetch,key=process.env.GHL_API_KEY;process.env.GHL_API_KEY="synthetic";
  let calls=0;
  globalThis.fetch=async(url,init)=>{
   calls++;assert.equal(url,"https://services.leadconnectorhq.com/contacts/contact/workflow/fixed");
   assert.equal(init?.redirect,"error");assert.equal(init?.method,"DELETE");assert.equal(init?.body,"{}");assert.equal((init?.headers as any).Version,"v3");
   if(kind==="timeout")throw new Error("unknown");
   const status=["429","500","204"].includes(kind)?Number(kind):200;
   return {status,json:async()=>kind==="malformed"?{}:{succeeded:kind!=="negative"}} as Response;
  };
  try{
   if(kind==="success")assert.deepEqual(await removeContactFromWorkflowOnce("contact","fixed"),{httpStatus:200,succeeded:true});
   else await assert.rejects(removeContactFromWorkflowOnce("contact","fixed"));
   assert.equal(calls,1);
  }finally{globalThis.fetch=original;if(key===undefined)delete process.env.GHL_API_KEY;else process.env.GHL_API_KEY=key;}
 });
}
test("invalid DELETE path cannot reach transport",async()=>{
 const original=globalThis.fetch;globalThis.fetch=async()=>{throw new Error("should not fetch");};
 try{await assert.rejects(removeContactFromWorkflowOnce("../other","fixed"),/Invalid exact/);}finally{globalThis.fetch=original;}
});
