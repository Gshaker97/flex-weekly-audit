// Standalone entrypoint for the daily audit Railway Cron service.
//
// Invoke with: npm run audit:daily   (tsx scripts/daily-audit.ts)
// Suggested schedule: 30 13 * * *  (6:30 AM Arizona). Half past the hour keeps
// it clear of the hourly sync, so the two never refresh the Jobber token at
// the same moment.
//
// Read-only against Jobber and GoHighLevel. Writes one DailyAuditReport row,
// shown at /daily-audit.

import { runDailyAudit } from "../lib/daily-audit/run";
import { prisma } from "../lib/prisma";

async function main() {
  const run = await runDailyAudit({ triggeredBy: "cron" });
  console.log(
    `[daily-audit] report ${run.id} for ${run.runDate}: ${run.failCount} failing, ${run.warnCount} warnings`
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err: any) => {
    console.error("[daily-audit] failed:", err?.stack ?? err?.message ?? err);
    await prisma.$disconnect();
    process.exit(1);
  });
