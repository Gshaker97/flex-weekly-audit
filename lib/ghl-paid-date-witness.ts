/** Optional reuse evidence. Failure here must never turn a verified Paid exit
 * into a permanent block. Neither a witness nor a later blank proves removal. */
import { createHash } from "node:crypto";
import { readOpportunityCustomFields, type GhlOpportunity } from "./ghl";
import { readDueDateField } from "./ghl-opportunity-date-repair";
import { DUE_DATE_FIELD, DUE_DATE_LOCATION } from "./ghl-recurring-due-date";
import { cardNameHash, type CycleJournalEntry, type GhlWriteIntent, type PaidDateWitness, type PaidDateReadback } from "./sync-writer-control";
const otherFieldsHash=(c:GhlOpportunity)=>createHash("sha256").update(JSON.stringify((c.customFields??[])
  .filter(f=>f.id!==DUE_DATE_FIELD).slice().sort((a,b)=>a.id.localeCompare(b.id)))).digest("hex");
export async function readPrePaidDateWitness(input:{current:GhlOpportunity;owner:CycleJournalEntry;observedAt:string},
  fields=readOpportunityCustomFields,now=()=>new Date()):Promise<PaidDateWitness|undefined>{
 try {
  const {current:c,owner:o}=input,cycle=o.intent.cycle,age=now().getTime()-Date.parse(input.observedAt);
  if(o.state!=="confirmed" || !cycle || !["enroll","reset_stage"].includes(cycle.phase) || cycle.locationId!==DUE_DATE_LOCATION
    || c.locationId!==cycle.locationId || c.id!==o.intent.opportunityId || c.contactId!==o.intent.contactId || c.pipelineId!==o.intent.pipelineId
    || c.status!=="open" || !Number.isFinite(age) || age<0 || age>60_000)return undefined;
  const f=readDueDateField(await fields(),c,cycle.locationId);
  if(!f || f.id!==DUE_DATE_FIELD || f.currentValue!==cycle.dueOn || now().getTime()-Date.parse(input.observedAt)>60_000)return undefined;
  return {version:1,fieldId:f.id,ownedValue:cycle.dueOn,observedAt:input.observedAt,priorOwnershipJournalId:o.id,otherFieldsSha256:otherFieldsHash(c)};
 }catch{return undefined;}
}
export async function readPaidDateReadback(intent:GhlWriteIntent,accepted:GhlOpportunity,
  fields=readOpportunityCustomFields,now=()=>new Date()):Promise<PaidDateReadback|undefined>{
 try {
  const c=intent.cycle,w=c?.paidDateWitness;if(c?.phase!=="paid" || !w)return undefined;
  if(accepted.id!==intent.opportunityId || accepted.locationId!==c.locationId || accepted.pipelineId!==intent.pipelineId
    || accepted.contactId!==intent.contactId || accepted.status!=="open" || accepted.pipelineStageId!==intent.target.stageId
    || accepted.monetaryValue!==0 || intent.target.amountCents!==0 || cardNameHash(accepted.name)!==intent.target.nameHash)return undefined;
  const f=readDueDateField(await fields(),accepted,c.locationId);
  if(!f || f.id!==w.fieldId || ![w.ownedValue,"",null].includes(f.currentValue as string|null)
    || otherFieldsHash(accepted)!==w.otherFieldsSha256)return undefined;
  return {fieldId:f.id,value:f.currentValue as string|null,observedAt:now().toISOString(),otherFieldsSha256:w.otherFieldsSha256};
 }catch{return undefined;}
}
