import { prisma } from "@/lib/prisma";

// Jobber's visit feed is authoritative about which visits still exist.
//
// Recurring schedules get edited constantly: a visit is moved, split or
// dropped, and Jobber replaces it with a new one. The sync upserts what the
// feed returns but never removed what vanished from it, so those replaced
// visits sat in the database forever, frozen at whatever status they had the
// last time they appeared — and a visit frozen as "upcoming" months ago reads
// as work that was never completed.
//
// A visit that a healthy full pull did not return no longer exists in Jobber,
// so it is excluded from the risk figures rather than counted as outstanding.

/**
 * Rows last synced before this instant were not returned by the most recent
 * healthy visit pull. Null means we have no trustworthy pull to compare
 * against, in which case nothing is excluded — a failed sync must never empty
 * the dashboard.
 */
export async function getVisitFreshnessCutoff(): Promise<Date | null> {
  const run = await prisma.syncRun.findFirst({
    where: { status: "complete", visitsFetched: { gt: 0 } },
    orderBy: { startedAt: "desc" },
  });
  return run?.startedAt ?? null;
}

/** Prisma filter fragment restricting to visits the latest pull still returned. */
export function stillInJobber(cutoff: Date | null) {
  return cutoff ? { lastSyncedAt: { gte: cutoff } } : {};
}
