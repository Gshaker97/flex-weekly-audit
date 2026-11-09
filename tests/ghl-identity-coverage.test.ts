import test from "node:test";
import assert from "node:assert/strict";
import { readReviewedIdentityCoverage, coveragePermitsOmissions, coveragePermitsExactInvoice, type ReviewedOmissionPolicy } from "../lib/ghl-identity-coverage";
import { verifyFreshGhlIdentity } from "../lib/ghl-write-identity";
function fixture() {
  const owner={jobberClientId:"owner",email:"owner@example.test",phone:"+16025550100"};
  const missing=[{jobberClientId:"missing-a",email:"a@example.test",phone:null},{jobberClientId:"missing-b",email:"b@example.test",phone:null}];
  const customers=[owner,...missing];
  const fresh={id:owner.jobberClientId,emails:[{address:owner.email,primary:true}],phones:[{number:owner.phone,primary:true}]};
  const contact={id:"contact",email:owner.email,phone:owner.phone};
  const policy:ReviewedOmissionPolicy={accountId:"account",reviewRef:"synthetic-review",reviewedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),quarantine:[missing[0],missing[1]]};
  const scope={jobberClientId:"owner",invoiceId:"invoice"};
  const calls:any[]=[];
  const query:any=async (q:string,v:any)=>{
    calls.push([q,v]);
    if(q.includes("VerifyExplicitIdentityCoverage")) return {account:{id:"account"},clients:{nodes:q.includes("isArchived: false")?[fresh]:[],pageInfo:{hasNextPage:false,endCursor:null}}};
    if(q.includes("VerifyQuarantinedIdentity")) return {account:{id:"account"},client:null};
    return {account:{id:"account"},client:fresh,invoice:{id:"invoice",client:{id:"owner"}}};
  };
  const counts=async()=>missing.map(c=>({jobberClientId:c.jobberClientId,jobs:0,invoices:0}));
  return {owner,missing,customers,fresh,contact,policy,scope,query,counts,calls};
}
test("only fresh explicit-account union plus exact owner/invoice and zero-link evidence permits reviewed omissions",async()=>{
  const f=fixture(); const r=await readReviewedIdentityCoverage(f.policy,f.customers,f.scope,f.counts,f.query);
  assert.equal(coveragePermitsExactInvoice(r.evidence,f.customers,r.identities,f.scope),true);
  assert.equal(coveragePermitsExactInvoice(r.evidence,f.customers,r.identities,{...f.scope,invoiceId:"other-invoice"}),false);
  assert.equal(f.calls.length,5);
  assert.match(f.calls[0][0],/isArchived: false/); assert.match(f.calls[1][0],/isArchived: true/);
  assert.ok(f.calls.every(([q])=>q.includes("account { id }")));
  assert.equal(coveragePermitsOmissions(r.evidence,f.customers,r.identities,"owner"),true);
  assert.match(verifyFreshGhlIdentity(f.owner,f.customers,[f.contact],"contact",r.identities)!,/omits/);
  assert.equal(verifyFreshGhlIdentity(f.owner,f.customers,[f.contact],"contact",r.identities,r.evidence),null);
  assert.equal(coveragePermitsOmissions({} as any,f.customers,r.identities,"owner"),false);
  assert.equal(coveragePermitsOmissions(structuredClone(r.evidence),f.customers,r.identities,"owner"),false);
  assert.equal(coveragePermitsOmissions(r.evidence,f.customers,r.identities,"other"),false);
  assert.equal(coveragePermitsOmissions(r.evidence,[...f.customers,{jobberClientId:"new"}],r.identities,"owner"),false);
  assert.equal(coveragePermitsOmissions(r.evidence,f.customers,[{...f.fresh,phones:[]}],"owner"),false);
});
for(const kind of ["account","partial","duplicate","cross-scope duplicate","missing cursor","bad identity","new omission","quarantine reappears","exact owner drift","wrong invoice owner","wrong invoice","permission","changed cached witness","linked job","linked invoice","missing counts","expired policy","extra quarantine","selected quarantined"]) test(`coverage rejects ${kind}`,async()=>{
  const f=fixture();
  if(kind==="new omission")f.customers.push({jobberClientId:"new",email:null,phone:null} as any);
  if(kind==="changed cached witness")f.policy.quarantine=[{...f.missing[0],email:"changed@example.test"},f.missing[1]];
  if(kind==="expired policy")f.policy.expiresAt=new Date(Date.now()-1).toISOString();
  if(kind==="extra quarantine")(f.policy.quarantine as any).push({jobberClientId:"extra"});
  if(kind==="selected quarantined")f.scope.jobberClientId="missing-a";
  const q:any=async(s:string,v:any)=>{
    if(kind==="permission")throw new Error("permission denied");
    const d=structuredClone(await f.query(s,v));
    if(kind==="account")d.account.id="wrong";
    if(d.clients){
      if(kind==="partial")delete d.clients.pageInfo.hasNextPage;
      if(kind==="duplicate" && d.clients.nodes.length)d.clients.nodes.push(f.fresh);
      if(kind==="cross-scope duplicate")d.clients.nodes=[f.fresh];
      if(kind==="missing cursor")d.clients.pageInfo={hasNextPage:true,endCursor:null};
      if(kind==="bad identity" && d.clients.nodes.length)d.clients.nodes[0].phones=null;
    }
    if(s.includes("VerifyQuarantinedIdentity") && kind==="quarantine reappears")d.client={id:v.id};
    if(s.includes("VerifyExactCoverageOwnerInvoice")){
      if(kind==="exact owner drift")d.client.phones=[];
      if(kind==="wrong invoice owner")d.invoice.client.id="other";
      if(kind==="wrong invoice")d.invoice.id="other";
    }
    return d;
  };
  const counts=async()=>{const x=await f.counts();if(kind==="linked job")x[0].jobs=1;if(kind==="linked invoice")x[0].invoices=1;if(kind==="missing counts")x.pop();return x;};
  await assert.rejects(readReviewedIdentityCoverage(f.policy,f.customers,f.scope,counts,q));
});
test("quarantined cached identifiers remain collision witnesses even with genuine coverage evidence",async()=>{
  const f=fixture();f.missing[0].email=f.owner.email;
  const r=await readReviewedIdentityCoverage(f.policy,f.customers,f.scope,f.counts,f.query);
  assert.match(verifyFreshGhlIdentity(f.owner,f.customers,[f.contact],"contact",r.identities,r.evidence)!,/another Jobber customer/);
});
test("coverage expires and fails if a read takes five minutes",async()=>{
  const real=Date.now;let clock=real();Date.now=()=>clock;
  try{
    const f=fixture();f.policy.expiresAt=new Date(clock+600000).toISOString();
    const r=await readReviewedIdentityCoverage(f.policy,f.customers,f.scope,f.counts,f.query);
    clock+=300000;assert.equal(coveragePermitsOmissions(r.evidence,f.customers,r.identities,"owner"),false);
    const g=fixture();g.policy.expiresAt=new Date(clock+600000).toISOString();
    await assert.rejects(readReviewedIdentityCoverage(g.policy,g.customers,g.scope,async()=>{clock+=300000;return g.counts();},g.query),/expired/);
  }finally{Date.now=real;}
});
test("explicit scopes paginate independently; repeated cursors and account drift on later pages fail",async()=>{
  for(const kind of ["ok","cursor","account"]){
    const f=fixture();let pages=0;
    const q:any=async(s:string,v:any)=>{
      if(s.includes("isArchived: false")){
        pages++;
        if(pages===1)return {account:{id:"account"},clients:{nodes:[f.fresh],pageInfo:{hasNextPage:true,endCursor:"next"}}};
        assert.equal(v.after,"next");
        return {account:{id:kind==="account"?"wrong":"account"},clients:{nodes:kind==="cursor"?[{id:"another",emails:[],phones:[]}]:[],pageInfo:{hasNextPage:kind==="cursor",endCursor:"next"}}};
      }
      if(s.includes("isArchived: true"))assert.equal(v.after,null);
      return f.query(s,v);
    };
    if(kind==="ok")await readReviewedIdentityCoverage(f.policy,f.customers,f.scope,f.counts,q);
    else await assert.rejects(readReviewedIdentityCoverage(f.policy,f.customers,f.scope,f.counts,q));
  }
});
