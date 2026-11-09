/** Single reviewed invoice-cycle exit. Readiness never enrolls or sends reminders. */
import { validateReviewedWorkflowInventory, verifyPaidCycleWorkflowInventory, paidCycleHoldDetail, type ReviewedWorkflowInventory } from "./ghl-paid-cycle-workflows";
import { createHash } from "node:crypto";
import { prisma } from "./prisma";
import { jobberGraphQL } from "./jobber";
import { readOwnerInvoiceEvidence } from "./ghl-date-readiness";
import { readReviewedIdentityCoverage, coveragePermitsExactInvoice, type ReviewedOmissionPolicy } from "./ghl-identity-coverage";
import { verifyFreshGhlIdentity } from "./ghl-write-identity";
import { canonicalPhone } from "./ghl-phone-match";
import { phoneSourcePlan, moneyCents, type PhoneInvoiceEvidence } from "./ghl-phone-state";
import { approvedGhlCards, buildGhlWriteIntent } from "./ghl-write-intent";
import { listContactsForPhoneMatching, listPipelineOpportunities, getInvoicePipelineRefs, readOpportunity, moveOpportunityToStage, readWorkflowStates, type GhlOpportunity } from "./ghl";
import { cardNameHash, type SyncEntrypoint, type SyncRunWriter } from "./sync-writer-control";

export type PaidCycleRequest = {
  version: 1; approvalId: string; expiresAt: string;
  scope: { locationId: string; pipelineId: string; jobberClientId: string; contactId: string; opportunityId: string; invoiceId: string };
  originalInvoice: { totalCents: number; issuedDate: string; dueDate: string };
  originalCard: { stageId: string; amountCents: number; nameHash: string };
  identityCoveragePolicy: ReviewedOmissionPolicy;
  workflowInventory: ReviewedWorkflowInventory;
};
const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const safeId = (v: unknown): v is string => typeof v === "string" && !!v && v.trim() === v && v.length <= 256;
export function validatePaidCycleRequest(r: PaidCycleRequest, env: Record<string,string|undefined>, at = Date.now()): void {
  const expiry=Date.parse(r?.expiresAt), policyExpiry=Date.parse(r?.identityCoveragePolicy?.expiresAt);
  if (r?.version!==1 || !r.scope || Object.keys(r.scope).length!==6 || !Object.values(r.scope).every(safeId)
    || r.scope.locationId!==env.GHL_LOCATION_ID
    || typeof r.approvalId!=="string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(r.approvalId) || !Number.isFinite(expiry) || expiry<=at || expiry>policyExpiry
    || !Number.isFinite(policyExpiry) || !Number.isSafeInteger(r.originalInvoice?.totalCents) || r.originalInvoice.totalCents<=0
    || ![r.originalInvoice.issuedDate,r.originalInvoice.dueDate].every(d=>typeof d==="string" && Number.isFinite(Date.parse(d)))
    || !safeId(r.originalCard?.stageId) || !Number.isSafeInteger(r.originalCard.amountCents) || r.originalCard.amountCents<0
    || !/^[a-f0-9]{64}$/.test(r.originalCard.nameHash)) throw new Error("Invalid or expired exact paid-cycle request");
  validateReviewedWorkflowInventory(r.workflowInventory,r.scope.locationId);
}
export function paidCycleWriteGates(r:PaidCycleRequest,env:Record<string,string|undefined>,phoneOnly:boolean) {
  const cohort=approvedGhlCards(env);
  return { operationEnabled:env.GHL_PAID_CYCLE_ENABLED==="true", cronOnly:env.SYNC_ADMISSION_MODE==="cron_only",
    genericWritesHeld:env.GHL_INVOICE_WRITE_MODE==="review", approvalIdMatches:typeof r.approvalId==="string" && typeof env.GHL_WRITE_APPROVAL_ID==="string" && env.GHL_WRITE_APPROVAL_ID.length>0 && r.approvalId===env.GHL_WRITE_APPROVAL_ID,
    exactCardCohort:cohort.size===1 && cohort.has(r.scope.opportunityId), phoneGateOpen:!phoneOnly || env.GHL_PHONE_WRITES_ENABLED==="true" };
}
function validatePaidCycleMutation(r:PaidCycleRequest,env:Record<string,string|undefined>,phoneOnly=false):void {
  validatePaidCycleRequest(r,env);
  const gates=paidCycleWriteGates(r,env,phoneOnly);
  if(!gates.operationEnabled || !gates.cronOnly || !gates.genericWritesHeld) throw new Error("Paid-cycle mutation configuration is not enabled safely");
  if(!gates.approvalIdMatches) throw new Error("Paid-cycle mutation approval does not match");
  if(!gates.exactCardCohort) throw new Error("Paid-cycle request requires its exact single-card cohort");
  if(!gates.phoneGateOpen) throw new Error("Phone-only paid-cycle writes not enabled");
}
/** Same complete owner query, with account verification on every page. */
export async function readAccountOwnerInvoices(ownerId: string, accountId: string, query: typeof jobberGraphQL = jobberGraphQL): Promise<PhoneInvoiceEvidence[]> {
  return readOwnerInvoiceEvidence(ownerId, (async (statement:string,variables:any)=>{
    const data:any=await query(statement.replace("{", "{ account { id }"),variables);
    if(data?.account?.id!==accountId) throw new Error("Paid-cycle source account changed or unavailable");
    return data;
  }) as typeof jobberGraphQL);
}
const live = {
  customers: () => prisma.customer.findMany({ select: { jobberClientId:true,email:true,phone:true } }),
  stored: (ownerId:string) => prisma.invoiceRecord.findMany({where:{customer:{jobberClientId:ownerId}},select:{jobberInvoiceId:true}}),
  counts: async (ids:string[]) => (await prisma.customer.findMany({where:{jobberClientId:{in:ids}},select:{jobberClientId:true,_count:{select:{jobs:true,invoices:true}}}}))
    .map(c=>({jobberClientId:c.jobberClientId,jobs:c._count.jobs,invoices:c._count.invoices})),
  coverage: readReviewedIdentityCoverage, invoices: readAccountOwnerInvoices,
  workflows:readWorkflowStates,
  contacts: listContactsForPhoneMatching, cards:listPipelineOpportunities, refs:getInvoicePipelineRefs, card:readOpportunity,
};
export type PaidCycleSnapshot = {
  observedAt:string; requestSha256:string; workflowInventorySha256:string; phoneOnly:boolean; writeGates:ReturnType<typeof paidCycleWriteGates>; invoices:PhoneInvoiceEvidence[]; card:GhlOpportunity;
  paidStageId:string; state:"currently_unpaid"|"paid_exit_candidate"|"already_paid_zero";
};
/** Always runs identity/source guards, including for unpaid or already-paid cards. */
export async function readPaidCycleReadiness(request:PaidCycleRequest, env:Record<string,string|undefined> = process.env, deps=live):Promise<PaidCycleSnapshot> {
  const r=structuredClone(request), settings={...env}, begun=Date.now();
  validatePaidCycleRequest(r,settings,begun);
  const workflowInventorySha256=await verifyPaidCycleWorkflowInventory(r.workflowInventory,r.scope.locationId,deps.workflows);
  const s=r.scope, customers=await deps.customers(), owners=customers.filter(c=>c.jobberClientId===s.jobberClientId);
  if(owners.length!==1) throw new Error("Paid-cycle cached owner missing or duplicated");
  const owner=owners[0];
  const phoneOnly=!owner.email?.trim();
  const covered=await deps.coverage(r.identityCoveragePolicy,customers,s,()=>deps.counts(r.identityCoveragePolicy.quarantine.map(c=>c.jobberClientId)));
  const contacts=await deps.contacts(), selected=contacts.find(c=>c.id===s.contactId);
  const email=owner.email?.trim().toLowerCase(), phone=canonicalPhone(owner.phone);
  if(!selected || !((email && selected.email?.trim().toLowerCase()===email) || (phone && canonicalPhone(selected.phone)===phone))) throw new Error("Paid-cycle selected contact differs from primary source identity");
  const identityHold=verifyFreshGhlIdentity(owner,customers,contacts,s.contactId,covered.identities,covered.evidence);
  if(identityHold) throw new Error(identityHold);
  const refs=await deps.refs();
  const paidStageId=refs.stageIdByName["invoice paid"], sent=refs.stageIdByName["invoice sent"], overdue=refs.stageIdByName["invoice overdue"];
  if(refs.pipelineId!==s.pipelineId || !paidStageId || !sent || !overdue || ![paidStageId,sent,overdue].includes(r.originalCard.stageId)) throw new Error("Paid-cycle pipeline or stages changed");
  const cards=await deps.cards(s.pipelineId), matching=cards.filter(c=>c.contactId===s.contactId);
  if(matching.length!==1 || matching[0].id!==s.opportunityId) throw new Error("Paid-cycle card association is no longer unique");
  const invoices=await deps.invoices(s.jobberClientId,r.identityCoveragePolicy.accountId), stored=await deps.stored(s.jobberClientId);
  // This deliberately supports one original invoice, not later cycles or mixed historical sets.
  if(invoices.length!==1 || invoices[0].id!==s.invoiceId || invoices[0].client?.id!==s.jobberClientId
    || stored.length!==1 || stored[0].jobberInvoiceId!==s.invoiceId) throw new Error("Original paid-cycle invoice set changed or incomplete");
  const invoice=invoices[0];
  if(moneyCents(invoice.amounts?.total)!==r.originalInvoice.totalCents || invoice.issuedDate!==r.originalInvoice.issuedDate || invoice.dueDate!==r.originalInvoice.dueDate)
    throw new Error("Original paid-cycle invoice fields changed");
  const plan=phoneSourcePlan(s.jobberClientId,[s.invoiceId],invoices,new Date());
  if(!plan) throw new Error("Paid-cycle source payment status or amounts unverified");
  const card=await deps.card(s.opportunityId), amount=moneyCents(card.monetaryValue);
  if(card.id!==s.opportunityId || card.locationId!==s.locationId || card.pipelineId!==s.pipelineId || card.contactId!==s.contactId || card.status!=="open"
    || (card.customFields!==undefined && !Array.isArray(card.customFields))
    || cardNameHash(card.name)!==r.originalCard.nameHash || amount===null
    || ![r.originalCard.stageId,paidStageId].includes(card.pipelineStageId ?? "")
    || (card.pipelineStageId===paidStageId && amount===0 ? false : amount!==r.originalCard.amountCents)) throw new Error("Paid-cycle card changed outside approved state");
  if(plan.stage!=="Invoice Paid" && card.pipelineStageId===paidStageId) throw new Error("Unpaid source conflicts with Paid card");
  if(!coveragePermitsExactInvoice(covered.evidence,customers,covered.identities,s) || Date.now()-begun>=300000) throw new Error("Paid-cycle identity coverage expired or changed");
  validatePaidCycleRequest(r,settings);
  return {observedAt:new Date(begun).toISOString(),requestSha256:sha(r),workflowInventorySha256,phoneOnly,writeGates:paidCycleWriteGates(r,settings,phoneOnly),invoices,card,paidStageId,
    state:plan.stage!=="Invoice Paid"?"currently_unpaid":card.pipelineStageId===paidStageId && amount===0?"already_paid_zero":"paid_exit_candidate"};
}
const snapshotFingerprint = (s:PaidCycleSnapshot) => sha({request:s.requestSha256,workflowInventory:s.workflowInventorySha256,phoneOnly:s.phoneOnly,invoices:s.invoices,card:s.card,paidStageId:s.paidStageId,state:s.state});
const snapshotFresh = (s:PaidCycleSnapshot, at:number) => Number.isFinite(Date.parse(s.observedAt)) && at>=Date.parse(s.observedAt) && at-Date.parse(s.observedAt)<300000;
const transport = { update:moveOpportunityToStage, read:readOpportunity };
export async function reconcilePaidCycle(input:{request:PaidCycleRequest;env:Record<string,string|undefined>;writer:Pick<SyncRunWriter,"prepare"|"assertPending"|"confirm"|"block">;
  readFresh:()=>Promise<PaidCycleSnapshot>; readWorkflows?:()=>Promise<unknown>; transport?:typeof transport}) {
  const r=structuredClone(input.request), env={...input.env}; let started=false;
  try {
    validatePaidCycleRequest(r,env);
    const first=structuredClone(await input.readFresh());
    if(first.requestSha256!==sha(r) || first.workflowInventorySha256!==r.workflowInventory.sha256 || !snapshotFresh(first,Date.now())) throw new Error("Paid-cycle snapshot scope or freshness differs");
    validatePaidCycleMutation(r,env,first.phoneOnly);
    if(first.state==="currently_unpaid") return {state:"currently_unpaid" as const,reason:"Future exit path supported under current policy; source remains unpaid"};
    if(first.state==="already_paid_zero") return {state:"already_paid_zero" as const};
    const intent=buildGhlWriteIntent({current:first.card,to:{stageId:first.paidStageId,monetaryValue:0},jobberClientId:r.scope.jobberClientId,
      source:first.invoices,storedInvoiceIds:[r.scope.invoiceId],observedAt:first.observedAt});
    if(!intent) throw new Error("Paid-cycle durable intent unavailable");
    intent.approvalId=r.approvalId;
    started=true; const writeId=await input.writer.prepare(intent); await input.writer.assertPending(writeId);
    const fresh=structuredClone(await input.readFresh());
    if(fresh.state!=="paid_exit_candidate" || snapshotFingerprint(first)!==snapshotFingerprint(fresh) || !snapshotFresh(fresh,Date.now())) throw new Error("Paid-cycle source/card changed after admission");
    validatePaidCycleMutation(r,env,fresh.phoneOnly);
    await verifyPaidCycleWorkflowInventory(r.workflowInventory,r.scope.locationId,input.readWorkflows);
    await input.writer.assertPending(writeId);
    validatePaidCycleMutation(r,env,fresh.phoneOnly);
    if(!snapshotFresh(fresh,Date.now())) throw new Error("Paid-cycle evidence expired before provider attempt");
    const t=input.transport??transport;
    await t.update(r.scope.opportunityId,fresh.paidStageId,0);
    const after=await t.read(r.scope.opportunityId);
    if(after.id!==fresh.card.id || after.locationId!==fresh.card.locationId || after.pipelineId!==fresh.card.pipelineId || after.contactId!==fresh.card.contactId
      || after.status!==fresh.card.status || after.name!==fresh.card.name || after.pipelineStageId!==fresh.paidStageId || after.monetaryValue!==0
      || sha(after.customFields??[])!==sha(fresh.card.customFields??[])) throw new Error("Paid-cycle write readback not confirmed");
    await input.writer.confirm(writeId);
    return {state:"applied" as const,journalId:writeId};
  } catch(error) {
    if(!started) return {state:"held" as const,...paidCycleHoldDetail(error)};
    await input.writer.block(); throw error;
  }
}
const operationDeps={read:readPaidCycleReadiness,reconcile:reconcilePaidCycle};
export async function runConfiguredPaidCycle(input:{entrypoint:SyncEntrypoint;writer:SyncRunWriter;env?:Record<string,string|undefined>;deps?:typeof operationDeps}) {
  const env={...(input.env??process.env)},deps=input.deps??operationDeps;
  if(env.GHL_PAID_CYCLE_ENABLED!=="true") return {state:"disabled" as const};
  const held=(reason:string)=>({state:"held" as const,reason});
  // The separate operation never grants generic writes or borrows HTTP admission.
  if(input.entrypoint!=="standalone_cron" || env.SYNC_ADMISSION_MODE!=="cron_only" || env.GHL_INVOICE_WRITE_MODE!=="review") return held("Paid-cycle requires cron-only admission and generic writes held");
  const raw=env.GHL_PAID_CYCLE_REQUEST;
  if(!raw || Buffer.byteLength(raw,"utf8")>16384 || createHash("sha256").update(raw).digest("hex")!==env.GHL_PAID_CYCLE_REQUEST_SHA256) return held("Exact reviewed paid-cycle request missing or changed");
  let request:PaidCycleRequest;
  try {request=JSON.parse(raw);validatePaidCycleMutation(request,env);}catch{return held("Invalid or expired paid-cycle request");}
  return deps.reconcile({request,env,writer:input.writer,readFresh:()=>deps.read(request,env)});
}
