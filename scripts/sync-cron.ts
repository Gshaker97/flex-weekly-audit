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

import { runConfiguredAutomaticReminders } from "../lib/invoice-reminder-automatic-cron";
import { runFullSync } from "../lib/sync";
import { prisma } from "../lib/prisma";
import { closeRunForShutdown, type AbandonableRun } from "../lib/sync-run-shutdown";

// The run currently in flight, so a shutdown signal can give it up instead of
// leaving the row `running` forever and refusing every later sync.
let active: AbandonableRun | null = null;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;          // SIGTERM then SIGINT must not double-close
  shuttingDown = true;
  console.log(`[cron] ${signal} received; closing the run before exit`);
  const outcome = await closeRunForShutdown(active, signal);
  console.log(
    outcome === "no_run" ? "[cron] no run was in flight"
      : outcome === "closed" ? `[cron] run ${active?.runId} marked failed; sync admission is free`
      : `[cron] run ${active?.runId} could not be closed safely and is left for operator review`
  );
  try { await prisma.$disconnect(); } catch { /* exiting anyway */ }
  process.exit(1);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => { void shutdown(signal); });
}

async function main() {
  const startedAt = Date.now();
  console.log(`[cron] sync starting at ${new Date(startedAt).toISOString()}`);

  const run = await runFullSync({
    triggeredBy: "cron",
    entrypoint: "standalone_cron",
    onAdmitted: handle => { active = handle; },
  });

  // Finished on its own terms; there is nothing left for the signal handler.
  active = null;

  console.log(
    `[cron] sync finished: status=${run.status} id=${run.id} ` +
      `(${Date.now() - startedAt}ms)`
  );
  if (run.status === "complete") {
    await runConfiguredAutomaticReminders({ entrypoint: "standalone_cron" });
  }
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
