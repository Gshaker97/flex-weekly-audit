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
//
// TWO THINGS HAPPEN HERE BEFORE THE SYNC, and both exist because a sync that
// cannot start must not take anything else down with it:
//
//   1. THE JOBBER LOGIN IS KEPT ALIVE FIRST. `getValidAccessToken()` refreshes
//      the token when it is within five minutes of expiring, but it only runs
//      when something actually calls Jobber - and the admission gate throws
//      BEFORE the sync's first Jobber call. So while a stuck run was blocking
//      the hour, nothing refreshed the login at all. On 2026-11-25 the access
//      token sat expired for four and a half hours for exactly that reason.
//      Refreshing here, ahead of admission, means a refused sync still keeps
//      the login current. It does not change who owns the token lifecycle
//      during a sync: the first ordinary Jobber call still does.
//
//   2. A SHUTDOWN HANDLER IS ARMED. Railway sends SIGTERM before replacing a
//      container. Without this the process died mid-run and left its SyncRun
//      row on `running`, which refuses every later sync; that cost five
//      consecutive hourly runs on 2026-11-25. The handler marks the run
//      abandoned - or `blocked`, if a GHL write was still pending, because an
//      unknown write outcome must stop the next run rather than invite a
//      duplicate card.

import { runConfiguredAutomaticReminders } from "../lib/invoice-reminder-automatic-cron";
import { runFullSync } from "../lib/sync";
import { prisma } from "../lib/prisma";
import { getValidAccessToken } from "../lib/jobber";
import { closeRunOnShutdown } from "../lib/sync-shutdown";

/**
 * Refresh the Jobber login before admission, so a refused sync cannot let it
 * lapse. Failure is logged and does not stop the attempt: if the token is
 * genuinely dead the sync will say so far more clearly than this can.
 */
async function keepJobberLoginAlive(): Promise<void> {
  try {
    await getValidAccessToken();
    console.log("[cron] Jobber login checked before admission");
  } catch (e: any) {
    console.error("[cron] could not refresh the Jobber login (continuing):", e?.message ?? e);
  }
}

/** The run this process owns, once admitted. Read by the signal handlers. */
let activeRunId: string | null = null;
let shuttingDown = false;

function armShutdownHandlers(): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      // One shutdown only. A second signal must not race the first's write.
      if (shuttingDown) return;
      shuttingDown = true;
      const runId = activeRunId;
      console.warn(`[cron] ${signal} received${runId ? `; closing run ${runId}` : " before any run started"}`);
      void (async () => {
        if (runId) await closeRunOnShutdown(runId, signal);
        try { await prisma.$disconnect(); } catch {}
        // 143/130 are the conventional exit codes for these signals.
        process.exit(signal === "SIGTERM" ? 143 : 130);
      })();
    });
  }
}

async function main() {
  const startedAt = Date.now();
  console.log(`[cron] sync starting at ${new Date(startedAt).toISOString()}`);

  armShutdownHandlers();
  await keepJobberLoginAlive();

  const run = await runFullSync({
    triggeredBy: "cron",
    entrypoint: "standalone_cron",
    onAdmitted: (runId) => { activeRunId = runId; },
  });

  // Finished under its own power: the handlers have nothing left to close.
  activeRunId = null;

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
