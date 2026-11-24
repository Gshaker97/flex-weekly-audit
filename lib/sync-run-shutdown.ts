/**
 * Closing a sync run when the PROCESS is killed, not when the sync ends.
 *
 * Why this exists. The cron service is a plain process: Railway sends it
 * SIGTERM when the service is redeployed or stopped. If that lands mid-run,
 * the process dies without ever calling `finish`, and the `syncRun` row stays
 * `running` forever. `admitSyncRun` then refuses every later run — by design,
 * it has "no age-based expiry or automatic recovery" — so one redeploy at the
 * wrong second silently stops the hourly sync until a human edits the row.
 * That has now happened twice (2026-11-20 and 2026-11-24), and the second time
 * it also stopped the Jobber token being refreshed, because the cron owns that
 * refresh.
 *
 * What this does NOT do. It adds no stale-run reaper and no age-based expiry.
 * Nothing here ever recovers a run it did not personally watch die. A process
 * that is SIGKILLed, loses power, or is OOM-killed still leaves a `running`
 * row for a human, exactly as before. This only lets a process that is being
 * asked politely to stop say so before it goes.
 *
 * Safety. The close goes through `SyncRunWriter.finish("failed")`, which
 * refuses when the run is already blocked or when ANY write intent is still
 * pending, and falls back to marking the run `blocked`. So a signal arriving
 * in the middle of an uncertain GoHighLevel write still leaves the
 * non-expiring barrier up for operator review. The only run this closes
 * automatically is one with nothing in doubt.
 */

/** A run that is in flight and can be given up. `abandon` must reject rather than lie. */
export type AbandonableRun = {
  runId: string;
  /** Marks the run failed. Rejects if the run is blocked or holds a pending write. */
  abandon: (reason: string) => Promise<void>;
};

export type ShutdownOutcome =
  /** No run was in flight; nothing to close. */
  | "no_run"
  /** The run was marked failed. Admission is free for the next tick. */
  | "closed"
  /** The run could not be closed safely; it is left for operator review. */
  | "left_for_review";

/** The sentence written onto the row, so the reason survives in the audit trail. */
export function shutdownReason(signal: string, at: Date): string {
  return `Container received ${signal} at ${at.toISOString()} while a sync was in flight `
    + `(cron service stopped or redeployed mid-run). The run recorded no completion of its own. `
    + `Closed as failed on shutdown because no write intent was pending, so sync admission is not blocked.`;
}

/**
 * Close the in-flight run because this process is shutting down.
 * Never throws: a failure to close is reported, not propagated, because the
 * caller is already on its way out and the un-closed row is itself the barrier.
 */
export async function closeRunForShutdown(
  active: AbandonableRun | null | undefined,
  signal: string,
  now: () => Date = () => new Date(),
): Promise<ShutdownOutcome> {
  if (!active) return "no_run";
  try {
    await active.abandon(shutdownReason(signal, now()));
    return "closed";
  } catch {
    // finish() already escalated this run to `blocked` on its way out.
    return "left_for_review";
  }
}
