/**
 * IS A SYNC RUNNING RIGHT NOW? Run this before redeploying the cron service.
 *
 * Redeploying mid-run is what caused the 2026-11-25 outage: the container was
 * replaced three minutes into a run, the row stayed on `running`, and the next
 * five hourly syncs were refused. `scripts/sync-cron.ts` now closes its own run
 * on SIGTERM and `admitSyncRun` recovers a demonstrably dead row, so that
 * particular failure is handled twice over - but not redeploying into a live
 * run is still better than recovering from having done it.
 *
 * READ ONLY. It changes nothing and sends nothing; it reports and sets an exit
 * code so it can be used as a pre-deploy gate:
 *
 *     npm run sync:in-flight            # tells you, exit 1 if busy
 *     npm run sync:in-flight -- --wait  # waits for the run to finish instead
 *
 * Exit codes: 0 nothing in the way; 1 a run is in flight (or still in flight
 * when --wait gave up); 2 a `blocked` row needs a person, which waiting will
 * never resolve.
 *
 * A healthy run takes about eleven minutes, so --wait polls every 15 seconds
 * and gives up after 20 minutes rather than holding a deploy open forever.
 */
import { prisma } from "../lib/prisma";

const WAIT = process.argv.includes("--wait");
const POLL_MS = 15_000;
const GIVE_UP_MS = 20 * 60_000;

async function look() {
  return prisma.syncRun.findFirst({
    where: { status: { in: ["running", "blocked"] } },
    orderBy: { startedAt: "desc" },
    select: { id: true, status: true, startedAt: true, ghlOpportunitiesSynced: true },
  });
}

async function main(): Promise<number> {
  const startedWaiting = Date.now();
  for (;;) {
    const row = await look();
    if (!row) {
      console.log("[sync:in-flight] nothing in the way — safe to deploy");
      return 0;
    }
    const ageMin = Math.round((Date.now() - row.startedAt.getTime()) / 60000);

    if (row.status === "blocked") {
      // Waiting cannot fix this one; only a person can.
      console.error(`[sync:in-flight] a BLOCKED run needs operator review:`
        + ` id ${row.id}, started ${row.startedAt.toISOString()} (${ageMin} min ago).`
        + " Deploying will not clear it and neither will waiting.");
      return 2;
    }

    if (!WAIT) {
      console.error(`[sync:in-flight] A SYNC IS RUNNING: id ${row.id},`
        + ` started ${row.startedAt.toISOString()} (${ageMin} min ago),`
        + ` ${row.ghlOpportunitiesSynced ?? 0} opportunities synced so far.`
        + " Redeploying now will kill it. Wait, or re-run with --wait.");
      return 1;
    }

    if (Date.now() - startedWaiting >= GIVE_UP_MS) {
      console.error(`[sync:in-flight] still running after ${Math.round(GIVE_UP_MS / 60000)}`
        + ` minutes (id ${row.id}, ${ageMin} min old). Not waiting any longer.`);
      return 1;
    }

    console.log(`[sync:in-flight] run ${row.id} is ${ageMin} min in; waiting…`);
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

main()
  .then(async code => { await prisma.$disconnect(); process.exit(code); })
  .catch(async (e: any) => {
    console.error("[sync:in-flight] failed:", e?.message ?? e);
    await prisma.$disconnect();
    process.exit(1);
  });
