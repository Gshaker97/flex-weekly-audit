/** Opt-in, read-only coverage evidence. No policy IDs, activation or writes live here. */
import { jobberGraphQL } from "./jobber";
import type { FreshJobberIdentity } from "./ghl-write-identity";
type Customer = { jobberClientId: string; email?: string | null; phone?: string | null };
type Query = typeof jobberGraphQL;
export type ReviewedOmissionPolicy = {
  accountId: string; reviewRef: string; reviewedAt: string; expiresAt: string;
  quarantine: readonly [Customer, Customer];
};
export type ExactIdentityScope = { jobberClientId: string; invoiceId: string };
export type CachedLinkCounts = { jobberClientId: string; jobs: number; invoices: number };
declare const coverageBrand: unique symbol;
export type IdentityCoverageEvidence = { readonly [coverageBrand]: true };
const issued = new WeakMap<object, { customers: string; source: string; ownerId: string; invoiceId: string; expires: number }>();
const id = (x: unknown): x is string => typeof x === "string" && !!x && x.trim() === x && x.length <= 256;
const customerKey = (rows: Customer[]) => JSON.stringify(rows.map(c => [c.jobberClientId, c.email ?? null, c.phone ?? null]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));
function identityKey(row: FreshJobberIdentity): string {
  return JSON.stringify([row.id, row.emails.map(e=>[e.address,e.primary]).sort(), row.phones.map(p=>[p.number,p.primary]).sort()]);
}
const sourceKey = (rows: FreshJobberIdentity[]) => JSON.stringify(rows.map(identityKey).sort());
function validate(row: any): asserts row is FreshJobberIdentity {
  if (!id(row?.id) || !Array.isArray(row.emails) || !Array.isArray(row.phones)
    || row.emails.some((e:any)=>typeof e?.address!=="string" || typeof e.primary!=="boolean")
    || row.phones.some((p:any)=>typeof p?.number!=="string" || typeof p.primary!=="boolean")
    || row.emails.filter((e:any)=>e.primary).length>1 || row.phones.filter((p:any)=>p.primary).length>1)
    throw new Error("Unverified coverage identity fields");
}
export function coveragePermitsOmissions(evidence: IdentityCoverageEvidence | undefined, customers: Customer[], source: FreshJobberIdentity[], ownerId: string): boolean {
  const proof = evidence && issued.get(evidence);
  return !!proof && Date.now() < proof.expires && proof.ownerId === ownerId
    && proof.customers === customerKey(customers) && proof.source === sourceKey(source);
}
/** Transaction-specific completion check; generic identity checks remain owner-scoped. */
export function coveragePermitsExactInvoice(evidence: IdentityCoverageEvidence | undefined, customers: Customer[], source: FreshJobberIdentity[], scope: ExactIdentityScope): boolean {
  return coveragePermitsOmissions(evidence, customers, source, scope.jobberClientId)
    && issued.get(evidence!)?.invoiceId === scope.invoiceId;
}
/** Fetches both explicit scopes; mints non-serializable evidence only after exact reads and fresh local link counts. */
export async function readReviewedIdentityCoverage(policy: ReviewedOmissionPolicy, customers: Customer[], scope: ExactIdentityScope,
  counts: () => Promise<CachedLinkCounts[]>, query: Query = jobberGraphQL): Promise<{ identities: FreshJobberIdentity[]; evidence: IdentityCoverageEvidence }> {
  policy = structuredClone(policy);
  scope = { ...scope };
  const started = Date.now(), reviewed = Date.parse(policy?.reviewedAt), expires = Date.parse(policy?.expiresAt);
  if (!id(policy?.accountId) || !id(policy?.reviewRef) || !Number.isFinite(reviewed) || !Number.isFinite(expires)
    || reviewed > started || expires <= started || expires - reviewed > 86400000
    || !Array.isArray(policy.quarantine) || policy.quarantine.length !== 2
    || new Set(policy.quarantine.map(c=>c.jobberClientId)).size !== 2
    || policy.quarantine.some(c=>!id(c.jobberClientId)) || !id(scope.jobberClientId) || !id(scope.invoiceId)
    || customers.some(c=>!id(c.jobberClientId)) || new Set(customers.map(c=>c.jobberClientId)).size !== customers.length)
    throw new Error("Invalid or expired reviewed omission policy");
  const cachedKey = customerKey(customers);
  const account = (data:any) => { if (data?.account?.id !== policy.accountId) throw new Error("Identity coverage account changed or unavailable"); };
  const identities: FreshJobberIdentity[] = [], ids = new Set<string>();
  for (const archived of [false, true]) {
    const cursors = new Set<string>(); let after: string | null = null, complete = false;
    for (let page=0;page<1000;page++) {
      const data:any = await query(`query VerifyExplicitIdentityCoverage($after: String) { account { id } clients(first: 25, after: $after, filter: { isArchived: ${archived} }) { pageInfo { hasNextPage endCursor } nodes { id emails { address primary } phones { number primary } } } }`, {after});
      account(data); const c=data?.clients;
      if (!Array.isArray(c?.nodes) || c.nodes.length>25 || typeof c.pageInfo?.hasNextPage!=="boolean") throw new Error("Incomplete explicit identity coverage");
      for (const row of c.nodes) { validate(row); if(ids.has(row.id)) throw new Error("Duplicate or conflicting coverage identity"); ids.add(row.id); identities.push(row); }
      if (!c.pageInfo.hasNextPage) { complete=true; break; }
      const next=c.pageInfo.endCursor;
      if(!id(next) || cursors.has(next) || !c.nodes.length) throw new Error("Truncated explicit identity coverage");
      cursors.add(next); after=next;
    }
    if(!complete) throw new Error("Explicit identity coverage exceeded limit");
  }
  const omitted = customers.filter(c=>!ids.has(c.jobberClientId));
  if (customerKey(omitted)!==customerKey([...policy.quarantine]) || policy.quarantine.some(c=>c.jobberClientId===scope.jobberClientId))
    throw new Error("Omissions differ from exact reviewed quarantine");
  for (const missing of omitted) {
    const data:any=await query(`query VerifyQuarantinedIdentity($id: EncodedId!) { account { id } client(id: $id) { id } }`, {id:missing.jobberClientId});
    account(data); if(data.client!==null) throw new Error("Quarantined identity is no longer exact-null");
  }
  const exact:any=await query(`query VerifyExactCoverageOwnerInvoice($ownerId: EncodedId!, $invoiceId: EncodedId!) { account { id } client(id: $ownerId) { id emails { address primary } phones { number primary } } invoice(id: $invoiceId) { id client { id } } }`, {ownerId:scope.jobberClientId,invoiceId:scope.invoiceId});
  account(exact); validate(exact.client);
  const selected=identities.find(c=>c.id===scope.jobberClientId);
  if (!selected || exact.client.id!==scope.jobberClientId || identityKey(exact.client)!==identityKey(selected)
    || exact.invoice?.id!==scope.invoiceId || exact.invoice?.client?.id!==scope.jobberClientId) throw new Error("Exact source owner/invoice identity disagrees");
  const links=await counts();
  if (links.length!==2 || new Set(links.map(c=>c.jobberClientId)).size!==2
    || links.some(c=>!omitted.some(o=>o.jobberClientId===c.jobberClientId) || c.jobs!==0 || c.invoices!==0)) throw new Error("Quarantined owner has linked or unverified records");
  if(customerKey(customers)!==cachedKey || Date.now()>=expires || Date.now()-started>=300000) throw new Error("Coverage evidence changed or expired during read");
  const evidence=Object.freeze({}) as IdentityCoverageEvidence;
  issued.set(evidence,{customers:cachedKey,source:sourceKey(identities),ownerId:scope.jobberClientId,invoiceId:scope.invoiceId,expires:Math.min(expires,started+300000)});
  return {identities,evidence};
}
