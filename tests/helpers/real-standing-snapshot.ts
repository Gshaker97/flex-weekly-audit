/** Synthetic transport only; uses actual branded coverage and readiness readers. */
import { readReviewedIdentityCoverage, standingOmissionScopeHash } from "../../lib/ghl-identity-coverage";
import { readVerifiedDateRepairSnapshot, readVerifiedCycleResetSnapshot, type DateReadinessScope } from "../../lib/ghl-date-readiness";
import type { DateRepairSnapshot } from "../../lib/ghl-opportunity-date-repair";
export function realStandingSnapshot(scope: DateReadinessScope, snapshot: DateRepairSnapshot, clock: () => Date, reset = false) {
  const missing = [{jobberClientId:"missing-a",email:null,phone:null},{jobberClientId:"missing-b",email:null,phone:null}] as const;
  const customers = [{jobberClientId:scope.jobberClientId,email:"qa@example.test",phone:null},...missing];
  const identities = [{id:scope.jobberClientId,emails:[{address:"qa@example.test",primary:true}],phones:[]}];
  const policy:any = {kind:"explicit_standing",approvalId:"synthetic-approval",approvalRef:"synthetic-explicit-approval",
    approvedAt:clock().toISOString(),validity:"until_revoked",accountId:"account",quarantine:missing};
  policy.scopeSha256=standingOmissionScopeHash(policy);
  const query:any=async(s:string)=>s.includes("VerifyExplicitIdentityCoverage")
    ?{account:{id:"account"},clients:{nodes:s.includes("isArchived: false")?identities:[],pageInfo:{hasNextPage:false}}}
    :s.includes("VerifyQuarantinedIdentity")?{account:{id:"account"},client:null}
    :{account:{id:"account"},client:identities[0],invoice:{id:scope.invoiceId,client:{id:scope.jobberClientId}}};
  let authorized=true, reads=0;
  const read=async()=>{
    reads++;
    const deps:any={
      customers:async()=>structuredClone(customers),identities:async()=>structuredClone(identities),
      contacts:async()=>[{id:scope.contactId,email:"qa@example.test"}],
      coverage:(p:any,c:any,s:any,counts:any)=>readReviewedIdentityCoverage(p,c,s,counts,query),
      quarantineCounts:async()=>missing.map(c=>({jobberClientId:c.jobberClientId,jobs:0,invoices:0})),
      refs:async()=>({pipelineId:snapshot.card.pipelineId,stageIdByName:{"invoice sent":"sent","invoice overdue":"overdue"}}),
      cards:async()=>[structuredClone(snapshot.currentCard)],card:async()=>structuredClone(snapshot.currentCard),
      fields:async()=>({customFields:[{id:snapshot.field.id,fieldKey:"opportunity.due_date",dataType:"DATE",model:"opportunity",locationId:scope.locationId}]}),
      ownerInvoices:async()=>snapshot.source.invoices.map(i=>({id:i.id,invoiceStatus:i.status,amounts:{total:i.totalCents/100,invoiceBalance:i.balanceCents/100},issuedDate:i.issuedDate,dueDate:i.dueDate})),
      storedInvoices:async()=>snapshot.source.invoices.map(i=>({jobberInvoiceId:i.id})),
    };
    return (reset?readVerifiedCycleResetSnapshot:readVerifiedDateRepairSnapshot)(scope,deps,clock,policy,()=>authorized);
  };
  return {read,revoke:()=>{authorized=false;},reads:()=>reads,policy};
}
