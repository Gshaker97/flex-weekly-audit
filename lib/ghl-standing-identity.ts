/** Deployment-bound standing scope. No default policy or automatic renewal.
 * A hash protects approved configuration integrity; it is not itself approval.
 */
import { createHash } from "node:crypto";
import { omissionAuthorizationExpiry, type StandingOmissionPolicy, readReviewedIdentityInventory } from "./ghl-identity-coverage";
import { prisma } from "./prisma";
import { jobberGraphQL } from "./jobber";
export function readConfiguredStandingIdentityPolicy(env:Record<string,string|undefined>=process.env):StandingOmissionPolicy|undefined {
  if(env.GHL_STANDING_IDENTITY_ENABLED!=="true")return undefined;
  const raw=env.GHL_STANDING_IDENTITY_POLICY;
  if(!raw || Buffer.byteLength(raw,"utf8")>16384 || createHash("sha256").update(raw).digest("hex")!==env.GHL_STANDING_IDENTITY_POLICY_SHA256)
    throw new Error("Exact approved standing identity policy missing or changed");
  const p:StandingOmissionPolicy=JSON.parse(raw);
  if(p.kind!=="explicit_standing" || !env.GHL_STANDING_IDENTITY_APPROVAL_ID || p.approvalId!==env.GHL_STANDING_IDENTITY_APPROVAL_ID)
    throw new Error("Explicit standing identity approval does not match");
  omissionAuthorizationExpiry(p);return structuredClone(p);
}
export function readStandingIdentityInventory(policy:StandingOmissionPolicy,customers:Array<{jobberClientId:string;email?:string|null;phone?:string|null}>) {
  return readReviewedIdentityInventory(policy,customers,async()=>
    (await prisma.customer.findMany({where:{jobberClientId:{in:policy.quarantine.map(c=>c.jobberClientId)}},
      select:{jobberClientId:true,_count:{select:{jobs:true,invoices:true}}}}))
      .map(c=>({jobberClientId:c.jobberClientId,jobs:c._count.jobs,invoices:c._count.invoices})),jobberGraphQL);
}
