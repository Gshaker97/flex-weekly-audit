// Private read-only readiness report. No SyncRun admission or mutation methods.
// Usage: node --import tsx scripts/review-opportunity-date.ts private-request.json private-report.json
import type { ReviewedOmissionPolicy } from "../lib/ghl-identity-coverage";
import { readFile, writeFile } from "node:fs/promises";
import { prisma } from "../lib/prisma";
import { readVerifiedDateRepairSnapshot, verifyCurrentWorkflowPauses,
  type DateReadinessScope, type WorkflowPauseExpectation } from "../lib/ghl-date-readiness";
import { dateRepairIntentHash } from "../lib/ghl-opportunity-date-repair";
import { planOpportunityDueDate } from "../lib/invoice-workflow-binding";

async function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output || input === output) throw new Error("Provide different private request and output paths");
  const request = JSON.parse(await readFile(input, "utf8")) as { scope: DateReadinessScope; identityCoveragePolicy?: ReviewedOmissionPolicy; workflows: WorkflowPauseExpectation[] };
  let result: unknown;
  try {
    if (!Array.isArray(request.workflows) || request.workflows.length < 2
        || !await verifyCurrentWorkflowPauses(request.scope.locationId, request.workflows)) {
      throw new Error("Reviewed affected workflow versions are not currently Draft");
    }
    const snapshot = await readVerifiedDateRepairSnapshot(request.scope, undefined, undefined, request.identityCoveragePolicy);
    const plan = planOpportunityDueDate(snapshot);
    result = { state: plan.state, intent: plan.intent, intentSha256: dateRepairIntentHash(plan.intent),
      reasons: plan.reasons, observedAt: snapshot.source.observedAt, sourceInvoiceCount: snapshot.source.invoices.length };
  } catch (error) {
    // The report is private. Never serialize raw HTTP errors or payloads that
    // could contain contact records or credentials into a public status log.
    const message = error instanceof Error ? error.message : "Readiness check failed";
    result = { state: "held", reason: /^(GHL API|Jobber API)/.test(message) ? "Provider read failed; inspect private runtime diagnostics" : message.slice(0, 500) };
  }
  await writeFile(output, JSON.stringify({ generatedAt: new Date().toISOString(), mode: "read_only", result }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  console.log("Saved private opportunity-date readiness report. No GHL or invoice changes performed.");
}
main().catch(() => { console.error("Date readiness report failed; no mutation was attempted."); process.exitCode = 1; }).finally(() => prisma.$disconnect());
