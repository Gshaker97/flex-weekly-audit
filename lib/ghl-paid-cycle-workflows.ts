import { createHash } from "node:crypto";
import { readWorkflowStates } from "./ghl";
export type ReviewedWorkflowState = { id:string; locationId:string; status:string; version:number; updatedAt:string };
export type ReviewedWorkflowInventory = { entries:ReviewedWorkflowState[]; sha256:string };
export class PaidCycleWorkflowHold extends Error {
  constructor(public readonly code:string, message:string) { super(message); }
}
const fail=(code:string,message:string):never=>{throw new PaidCycleWorkflowHold(code,message);};
const id=(v:unknown):v is string=>typeof v==="string" && !!v && v.trim()===v && v.length<=256;
function normalized(rows:unknown,locationId:string,reviewed=false):ReviewedWorkflowState[] {
  if(!Array.isArray(rows) || rows.length<2 || !id(locationId)) return fail("workflow_inventory_invalid","Workflow inventory is malformed; obtain a complete fresh inventory for review.");
  const seen=new Set<string>();
  return rows.map((r:any)=>{
    if(!id(r?.id) || seen.has(r.id) || r.locationId!==locationId || !["draft","published"].includes(r.status)
      || !Number.isSafeInteger(r.version) || r.version<1 || typeof r.updatedAt!=="string" || !Number.isFinite(Date.parse(r.updatedAt))
      || (reviewed && (Object.keys(r).length!==5 || Object.keys(r).some(k=>!["id","locationId","status","version","updatedAt"].includes(k)))))
      return fail("workflow_inventory_invalid","Workflow inventory fields, location or unique IDs are unverified; review a complete fresh inventory.");
    seen.add(r.id);
    return {id:r.id,locationId:r.locationId,status:r.status,version:r.version,updatedAt:r.updatedAt};
  }).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
}
export const workflowInventoryHash=(entries:ReviewedWorkflowState[],locationId:string)=>createHash("sha256").update(JSON.stringify(normalized(entries,locationId,true))).digest("hex");
export function validateReviewedWorkflowInventory(contract:ReviewedWorkflowInventory,locationId:string):void {
  if(!contract || !/^[a-f0-9]{64}$/.test(contract.sha256) || workflowInventoryHash(contract.entries,locationId)!==contract.sha256)
    fail("workflow_review_missing_or_changed","Reviewed workflow inventory hash is missing or changed; re-review and pin the whole request.");
}
function assertComplete(raw:any,count:number):void {
  // This endpoint returns its complete workflow array, not an expected-ID subset.
  // Explicit pagination/truncation signals must never be ignored.
  for(const holder of [raw,raw?.meta,raw?.pagination,raw?.pageInfo]) {
    if(!holder || typeof holder!=="object")continue;
    if(["hasNextPage","hasMore","has_more","truncated","isTruncated","complete"].some(k=>Object.hasOwn(holder,k) && typeof holder[k]!=="boolean")
      || holder.page!=null && (!Number.isSafeInteger(holder.page) || holder.page>1)
      || holder.currentPage!=null && (!Number.isSafeInteger(holder.currentPage) || holder.currentPage>1)
      || holder.hasNextPage===true || holder.hasMore===true || holder.has_more===true || holder.truncated===true
      || holder.isTruncated===true || holder.complete===false || holder.nextPage!=null && holder.nextPage!==false
      || holder.nextPageUrl!=null || holder.nextCursor!=null || holder.next!=null
      || holder.totalPages!=null && (!Number.isSafeInteger(holder.totalPages) || holder.totalPages>1)
      || holder.total!=null && holder.total!==count || holder.totalCount!=null && holder.totalCount!==count)
      fail("workflow_inventory_incomplete","Workflow response indicates incomplete coverage; complete the inventory before review or execution.");
  }
}
export async function verifyPaidCycleWorkflowInventory(contract:ReviewedWorkflowInventory,locationId:string,read:()=>Promise<unknown>=readWorkflowStates):Promise<string> {
  validateReviewedWorkflowInventory(contract,locationId);
  let raw:any;
  try{raw=await read();}catch{return fail("workflow_inventory_read_failed","Workflow inventory could not be read; keep the exit held and retry a fresh read-only review.");}
  const entries=normalized(raw?.workflows,locationId);
  assertComplete(raw,entries.length);
  if(workflowInventoryHash(entries,locationId)!==contract.sha256)
    return fail("workflow_inventory_changed","Workflow inventory changed since review; inspect added, removed or changed workflows and obtain a new pinned approval.");
  return contract.sha256;
}
/** Safe for private reports and operation status: never forward provider payloads. */
export function paidCycleHoldDetail(error:unknown):{code:string;reason:string} {
  if(error instanceof PaidCycleWorkflowHold)return {code:error.code,reason:error.message};
  const message=error instanceof Error?error.message:"";
  const known:Record<string,[string,string]>={
    "Invalid or expired exact paid-cycle request":["paid_cycle_request_invalid_or_expired","The exact request is invalid or expired; review its scope and current policy before retrying."],
    "Invalid or expired reviewed omission policy":["identity_policy_invalid_or_expired","The reviewed identity policy is invalid or expired; obtain a fresh review without extending it automatically."],
    "Paid-cycle request requires its exact single-card cohort":["paid_cycle_cohort_mismatch","The exact approved single-card cohort does not match this request."],
    "Paid-cycle mutation configuration is not enabled safely":["mutation_gates_closed","The paid-cycle enablement, cron-only or generic-write hold gates are closed; no mutation is authorized."],
    "Paid-cycle mutation approval does not match":["mutation_approval_mismatch","The configured approval ID does not match this exact request; no mutation is authorized."],
    "Phone-only paid-cycle writes not enabled":["phone_gate_closed","The phone-only path is not enabled for this scope."],
    "Original paid-cycle invoice set changed or incomplete":["invoice_cycle_changed_or_incomplete","The original invoice set changed or is incomplete; do not reuse approval for another cycle."],
    "Original paid-cycle invoice fields changed":["invoice_fields_changed","Original invoice fields changed; review a new exact request."],
    "Paid-cycle source payment status or amounts unverified":["source_settlement_unverified","Source status and balance do not establish a valid settled or unpaid state."],
    "Paid-cycle card association is no longer unique":["card_association_ambiguous","The contact no longer has one unique invoice card; resolve the association before retrying."],
    "Paid-cycle card changed outside approved state":["card_state_changed","The card differs from the approved state; inspect it before any write."],
  };
  const groups:Array<{messages:string[];code:string;reason:string}>=[
    {messages:["Fresh Jobber identity snapshot omits a cached owner","Omissions differ from exact reviewed quarantine","Quarantined identity is no longer exact-null"],code:"identity_quarantine_changed",reason:"Source omissions no longer match the reviewed two-owner quarantine; obtain a new complete read-only review."},
    {messages:["Identity coverage account changed or unavailable","Paid-cycle source account changed or unavailable"],code:"source_account_unverified",reason:"The expected source account could not be verified consistently; check account access before retrying."},
    {messages:["Exact source owner/invoice identity disagrees"],code:"source_owner_invoice_mismatch",reason:"The exact source invoice and owner do not agree with the reviewed scope; inspect their association."},
    {messages:["Quarantined owner has linked or unverified records"],code:"quarantine_link_evidence_changed",reason:"A quarantined owner has linked or unverified records; reassess the quarantine before any exit."},
    {messages:["Incomplete explicit identity coverage","Truncated explicit identity coverage","Explicit identity coverage exceeded limit","Unverified coverage identity fields","Duplicate or conflicting coverage identity"],code:"identity_coverage_incomplete",reason:"The complete source identity population could not be verified; resolve missing, malformed or duplicate evidence."},
    {messages:["Coverage evidence changed or expired during read","Paid-cycle identity coverage expired or changed","Paid-cycle snapshot scope or freshness differs","Paid-cycle evidence expired before provider attempt"],code:"identity_evidence_stale_or_changed",reason:"Fresh identity evidence expired or changed; perform a new read-only readiness check within the reviewed policy."},
    {messages:["Paid-cycle selected contact differs from primary source identity","Selected GHL identity is missing","Fresh owner/contact identity unavailable","Paid-cycle cached owner missing or duplicated"],code:"selected_identity_unverified",reason:"The selected source owner and GHL contact cannot be verified uniquely; inspect the exact records."},
    {messages:["Contact phone disagrees with Jobber customer","Email/phone or secondary contact ownership conflict","Secondary contact email ownership conflict","Selected contact identifiers overlap another GHL contact","Selected contact identifier belongs to another Jobber customer","Phone shared by Jobber customers","Fresh primary/secondary Jobber ownership conflict","Fresh Jobber secondary identity selects another GHL contact"],code:"identity_ownership_conflict",reason:"Contact identifiers conflict with another owner or contact; resolve the collision before an exit."},
    {messages:["GHL primary or secondary identity field shape is unverified","Relevant primary/secondary phone format is unverified","Fresh/cached primary phone cannot establish unchanged identity","Jobber primary identity changed since cache","Fresh/selected secondary phone format is unverified"],code:"identity_fields_unverified",reason:"Current identity fields are malformed or changed from the cache; inspect and verify them before retrying."},
    {messages:["Paid-cycle pipeline or stages changed","Unpaid source conflicts with Paid card"],code:"source_card_state_conflict",reason:"The current source/card stage relationship differs from the reviewed cycle; inspect it before any write."},
  ];
  const group=groups.find(g=>g.messages.includes(message));
  if(group)return {code:group.code,reason:group.reason};
  const detail=known[message];
  return detail?{code:detail[0],reason:detail[1]}:{code:"paid_cycle_evidence_unavailable",reason:"Fresh source, identity or card evidence is unavailable or conflicts; keep the exit held and inspect private read-only diagnostics."};
}
