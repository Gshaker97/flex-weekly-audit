// Standalone sync entrypoint for the Railway Cron service.
//
// Why this exists: inside the Next.js web service the sync was kicked off as a
// detached, fire-and-forget promise, and its log output never reached Railway's
// Deploy Logs (background work that escapes the request lifecycle gets its
// stdout swallowed). Running the sync here, as a plain Node.js process that
// awaits runFullSync and then exits, means all logs go straight to the process
// stdout that Railway captures.
//
// Invoke with: npm run sync:cron   (tsx scripts/sync-cron.ts)

import { runFullSync } from "../lib/sync";
import { prisma } from "../lib/prisma";

async function main() {
  const startedAt = Date.now();
  console.log(`[cron] sync starting at ${new Date(startedAt).toISOString()}`);

  // Force a full pull (invoices are scoped to issued >= 2026-01-01 in runFullSync).
  const run = await runFullSync({ triggeredBy: "cron", full: true });

  console.log(
    `[cron] sync finished: status=${run.status} id=${run.id} ` +
      `(${Date.now() - startedAt}ms)`
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err: any) => {
    console.error("[cron] sync failed:", err?.stack ?? err?.message ?? err);
    await prisma.$disconnect();
    process.exit(1);
  });
