// Read-only GHL plan. This script never invokes the full dashboard sync and
// always supplies review mode, regardless of write-mode environment variables.
// Run: npx tsx scripts/review-ghl-invoices.ts /private/path/ghl-plan.json
// Runtime auth token refresh may update the existing Jobber auth record.
import { writeFile } from "node:fs/promises";
import { prisma } from "../lib/prisma";
import { syncGhlInvoicePipeline, GhlInvoiceReview } from "../lib/sync";

async function main() {
  const output = process.argv[2];
  if (!output) throw new Error("Provide a private output JSON path");
  const entries: GhlInvoiceReview[] = [];
  await syncGhlInvoicePipeline({ mode: "review", report: entry => entries.push(entry) });
  await writeFile(output, JSON.stringify({ generatedAt: new Date().toISOString(), mode: "review", entries }, null, 2) + "\n", { mode: 0o600 });
  console.log(`Saved ${entries.length} review entries. No GHL mutations performed. Existing queued reminders are unchanged.`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
