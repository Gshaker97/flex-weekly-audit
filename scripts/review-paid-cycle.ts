// Private read-only report. No writer admission, PUT, enrollment or messages.
// node --import tsx scripts/review-paid-cycle.ts private-request.json expected-sha256 private-report.json
import { paidCycleHoldDetail } from "../lib/ghl-paid-cycle-workflows";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { readPaidCycleReadiness, type PaidCycleRequest } from "../lib/ghl-paid-cycle";
import { prisma } from "../lib/prisma";
async function main() {
  const [input,expected,output]=process.argv.slice(2);
  if(!input || !output || input===output || !/^[a-f0-9]{64}$/.test(expected??"")) throw new Error("Private request, expected SHA and distinct output required");
  const raw=await readFile(input,"utf8");
  if(Buffer.byteLength(raw,"utf8")>16384 || createHash("sha256").update(raw).digest("hex")!==expected) throw new Error("Reviewed request differs");
  let result:unknown;
  try {
    const snapshot=await readPaidCycleReadiness(JSON.parse(raw) as PaidCycleRequest);
    result={state:snapshot.state,observedAt:snapshot.observedAt,writeGates:snapshot.writeGates,phoneOnly:snapshot.phoneOnly,
      sourceSettlementVerified:snapshot.state!=="currently_unpaid",
      meaning:snapshot.state==="currently_unpaid"?"Currently unpaid; source checks support the future exit path under current policy, subject to the reported write gates and separate authorization. This is not source settlement or a cash-receipt claim.":snapshot.state==="already_paid_zero"?"Fresh source status is paid with zero balance; card is already Paid with zero value.":"Fresh source status is paid with zero balance; exact Paid/zero exit is a source candidate, subject to the reported write gates and separate authorization; it is not authorized or applied.",
      notificationActivationReady:false};
  } catch(error) {
    result={state:"held",...paidCycleHoldDetail(error),notificationActivationReady:false};
  }
  await writeFile(output,JSON.stringify({generatedAt:new Date().toISOString(),mode:"read_only",result},null,2)+"\n",{mode:0o600,flag:"wx"});
  console.log("Saved private paid-cycle readiness report. No mutation attempted.");
}
main().catch(()=>{console.error("Paid-cycle report failed; no mutation attempted.");process.exitCode=1;}).finally(()=>prisma.$disconnect());
