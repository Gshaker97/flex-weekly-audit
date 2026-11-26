/**
 * A RUN THAT LOSES ITS CONTAINER TIDIES UP AFTER ITSELF.
 *
 * Railway sends SIGTERM before it replaces a container. Until now the sync
 * ignored it: the process died mid-run and left its `SyncRun` row on `running`
 * forever, which `admitSyncRun` treats as "busy" and refuses to start a new
 * sync behind. On 2026-11-25 a redeploy three minutes into a run cost five
 * consecutive hourly syncs.
 *
 * `sync-stale-recovery.ts` is the safety net for when this does not happen -
 * SIGKILL, a lost node, a power cut. This file is the fast path: the dying
 * process knows its own run id, so it can say so immediately instead of
 * leaving the next run to infer it forty-five minutes later.
 *
 * IT DOES NOT ALWAYS ABANDON. If the run has a GHL write still `pending`, its
 * outcome is genuinely unknown, and saying "abandoned" would invite the next
 * run to write a second card. In that one case the row is moved to `blocked`
 * instead - which still refuses the next sync, on purpose, until a person has
 * looked. Losing an hour of syncing is the right trade against a duplicate
 * card, and `blocked` is the signal this system already uses to ask for that.
 *
 * It is best-effort by design. A shutdown gives no time guarantees, so every
 * failure here is swallowed after logging: the stale-run recovery still cleans
 * up behind it, and an exception thrown in a signal handler would only replace
 * a tidy exit with a noisy one.
 */
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "./prisma";

const JOURNAL_PREFIX = "FLEX_GHL_WRITE_JOURNAL_V1:";

export type ShutdownOutcome =
  | "abandoned"
  | "blocked_pending_write"
  | "already_finished"
  | "not_found"
  | "failed";

/** True when the row's journal has a write whose outcome is unknown. */
function hasPendingWrite(errorMessage: string | null): boolean {
  if (typeof errorMessage !== "string" || !errorMessage.startsWith(JOURNAL_PREFIX)) return false;
  try {
    const parsed = JSON.parse(errorMessage.slice(JOURNAL_PREFIX.length));
    if (!Array.isArray(parsed?.writes)) return true; // unreadable: assume the worst
    return parsed.writes.some((w: any) => w?.state === "pending");
  } catch {
    return true; // unreadable: assume the worst
  }
}

/**
 * Mark the run this process owns as finished-by-shutdown.
 *
 * Only ever touches a row that is still `running`, and only the one id it is
 * given, so it cannot disturb a run belonging to another process.
 */
export async function closeRunOnShutdown(
  runId: string,
  signal: string,
  db: PrismaClient = defaultPrisma,
): Promise<ShutdownOutcome> {
  try {
    const row = await db.syncRun.findUnique({
      where: { id: runId },
      select: { status: true, errorMessage: true },
    });
    if (!row) return "not_found";
    if (row.status !== "running") return "already_finished";

    if (hasPendingWrite(row.errorMessage)) {
      // The journal stays exactly as it is - it is the write evidence, and the
      // operator who reviews this will need it.
      const held = await db.syncRun.updateMany({
        where: { id: runId, status: "running" },
        data: { status: "blocked", completedAt: new Date() },
      });
      if (held.count !== 1) return "already_finished";
      console.error(`[sync] ${signal} arrived with a GHL write still pending on run ${runId}.`
        + " Moved to BLOCKED, not abandoned: its outcome is unknown, so the next sync must"
        + " stay refused until someone has looked at the write journal.");
      return "blocked_pending_write";
    }

    const note = `Shut down by ${signal} before finishing, almost certainly a deploy replacing`
      + " the container. No GHL write was pending, so this run is abandoned rather than held,"
      + " and the next hourly sync may start normally.";
    const journalPresent = typeof row.errorMessage === "string"
      && row.errorMessage.startsWith(JOURNAL_PREFIX);
    const done = await db.syncRun.updateMany({
      where: { id: runId, status: "running" },
      // A settled journal is preserved; only an empty column is written to.
      data: journalPresent
        ? { status: "abandoned", completedAt: new Date() }
        : { status: "abandoned", completedAt: new Date(), errorMessage: note },
    });
    if (done.count !== 1) return "already_finished";
    console.warn(`[sync] ${signal}: run ${runId} marked abandoned so it cannot block the next sync.`
      + `${journalPresent ? " Its write journal was left untouched." : ""}`);
    return "abandoned";
  } catch (e: any) {
    // Never throw out of a signal handler.
    console.error(`[sync] could not close run ${runId} on ${signal}:`, e?.message ?? e);
    return "failed";
  }
}
