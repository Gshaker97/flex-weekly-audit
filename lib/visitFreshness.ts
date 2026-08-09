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

/**
 * Jobber statuses that mean the visit isn't due yet.
 *
 * "Not marked as completed" is about work whose day has passed with nobody
 * closing it out. A visit Jobber still calls UPCOMING hasn't happened, and
 * TODAY's hasn't finished — neither is a failure to close anything out, so
 * counting them overstates the problem and pads it with future work.
 *
 * Anything else — LATE above all, plus a null status on an older row — still
 * falls through to the scheduled-date test, so nothing genuinely overdue is
 * dropped just because its status is unfamiliar.
 */
export const NOT_YET_DUE_STATUSES = ["UPCOMING", "TODAY"];

export function excludeNotYetDue() {
  return {
    // The null branch is load-bearing: in SQL, NOT (NULL = 'UPCOMING') is NULL
    // rather than true, so a bare NOT would quietly discard every visit whose
    // status hasn't been synced — the opposite of falling back to the date.
    OR: [
      { visitStatus: null },
      {
        NOT: {
          OR: NOT_YET_DUE_STATUSES.map((status) => ({
            visitStatus: { equals: status, mode: "insensitive" as const },
          })),
        },
      },
    ],
  };
}
