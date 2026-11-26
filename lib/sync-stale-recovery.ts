/**
 * A DEAD SYNC MUST NOT BLOCK THE NEXT ONE.
 *
 * `admitSyncRun` refuses to start a sync while any `SyncRun` row is `running`
 * or `blocked`, and its comment used to end "No age-based expiry or automatic
 * recovery." That is a deliberate safety choice - a half-finished GHL write
 * needs a person to look at it - but it also means a run that loses its
 * container leaves a row nothing will ever tidy, and the hourly sync is
 * refused for good.
 *
 * It happened on 2026-11-25: a cron run started 20:02:29, the cron service was
 * redeployed at 20:05:24, and the next five hourly runs were all refused. The
 * row had to be cleared by hand before syncing resumed.
 *
 * This file holds the decision to clear one, and nothing else. It is pure so
 * every branch can be tested, and it is deliberately narrow: it answers "may
 * this ONE row be abandoned automatically", never "is the system healthy".
 *
 * THE RULES, and why each one is here.
 *
 *   1. ONLY `running`. A `blocked` row is not a casualty, it is an operator
 *      hold that the writer set on purpose when it could not finish safely.
 *      Clearing one would throw away the very signal it exists to raise.
 *
 *   2. NEVER WITH A PENDING WRITE. A `pending` journal entry means a GHL write
 *      was prepared and its outcome is unknown - precisely the case where
 *      starting another run risks a second card. This check is absolute: no
 *      age, no quiet period and no counter can override it.
 *
 *   3. OLD ENOUGH. A healthy run finishes in about eleven minutes, so the
 *      default threshold is deliberately several times that.
 *
 *   4. QUIET FOR THAT LONG TOO. Age alone is not death - a run can be slow.
 *      The sync stamps `lastSyncedAt` on every invoice it upserts, so the
 *      newest of those is a real progress signal from the process itself. If
 *      anything was written recently, something is alive and this leaves it be.
 *      If that signal cannot be READ, recovery refuses: not knowing whether
 *      something is running is not evidence that nothing is.
 *
 *   5. NO UNRECORDED GHL WORK. A run with no journal that nonetheless reports
 *      opportunities synced has written something it left no evidence of. That
 *      is an anomaly, not a routine stall, and it refuses loudly rather than
 *      tidying the only trace of it away.
 *
 * WHAT IT NEVER DOES. It does not touch `errorMessage` when a journal is
 * present. The journal IS the write evidence - `cycleHistory()` reads it back
 * out of this column - so a settled journal is preserved exactly as it is and
 * the explanation goes to the log instead. Only a row with no journal at all
 * gets a note written into it, because there is nothing there to lose.
 */

/** A healthy run takes ~11 minutes. Four times that, rounded. */
export const STALE_RUN_MIN_AGE_MS = 45 * 60_000;

/** The facts a caller must gather. Every one of them is read, none inferred. */
export type StaleRunFacts = Readonly<{
  /** The row's status. Only "running" can ever be recovered. */
  status: string;
  startedAt: Date;
  /** `ghlOpportunitiesSynced` from the row. */
  opportunitiesSynced: number | null;
  /**
   * Whether the row carries a write journal at all, and how many of its writes
   * are still `pending`. A journal that exists but is fully settled is safe to
   * leave behind; a pending write is never safe.
   */
  journal: Readonly<{ present: boolean; pendingWrites: number }>;
  /**
   * The newest `lastSyncedAt` the sync has stamped on any invoice row, or null
   * if there is none. This is the progress signal; null counts as "no progress",
   * which is the honest reading of an empty table.
   */
  lastRowProgressAt: Date | null;
  /**
   * True when the progress signal could not be read at all. Fail-closed: an
   * unreadable signal is NOT evidence that nothing is running, so recovery
   * refuses. This is distinct from `lastRowProgressAt: null`, which is a
   * successful read of "nothing has been written".
   */
  progressUnknown?: boolean;
  now: Date;
  /** Defaults to STALE_RUN_MIN_AGE_MS. */
  minAgeMs?: number;
}>;

export type StaleRunVerdict =
  | Readonly<{ recover: true; note: string; preserveJournal: boolean }>
  | Readonly<{ recover: false; reason: string; detail: string }>;

const minutes = (ms: number) => Math.round(ms / 60000);

/**
 * May this row be marked abandoned automatically?
 *
 * The order matters: the two checks that protect a write come FIRST, so no
 * amount of age or quiet can reach past them.
 */
export function staleRunVerdict(facts: StaleRunFacts): StaleRunVerdict {
  const threshold = facts.minAgeMs ?? STALE_RUN_MIN_AGE_MS;

  if (facts.status !== "running") {
    return Object.freeze({
      recover: false,
      reason: "a_blocked_run_is_an_operator_hold_not_a_casualty",
      detail: `status is "${facts.status}", and only "running" is ever recovered automatically`,
    });
  }

  // ABSOLUTE. Checked before anything else so nothing can override it.
  if (facts.journal.pendingWrites > 0) {
    return Object.freeze({
      recover: false,
      reason: "a_pending_write_journal_entry_is_never_cleared_automatically",
      detail: `${facts.journal.pendingWrites} GHL write(s) were prepared and their outcome is unknown;`
        + " starting another run could write a second card. A person must look at this",
    });
  }

  // A run with no evidence that nonetheless says it wrote to GHL.
  if (!facts.journal.present && (facts.opportunitiesSynced ?? 0) !== 0) {
    return Object.freeze({
      recover: false,
      reason: "opportunities_were_synced_with_no_write_journal_to_show_for_it",
      detail: `the row reports ${facts.opportunitiesSynced} opportunities synced but carries no journal,`
        + " so GHL work happened that left no evidence. That is an anomaly, not a stall",
    });
  }

  const ageMs = facts.now.getTime() - facts.startedAt.getTime();
  if (!(ageMs >= threshold)) {
    return Object.freeze({
      recover: false,
      reason: "not_old_enough_to_be_presumed_dead",
      detail: `started ${minutes(ageMs)} minute(s) ago; ${minutes(threshold)} is the threshold`,
    });
  }

  if (facts.progressUnknown) {
    return Object.freeze({
      recover: false,
      reason: "the_progress_signal_could_not_be_read",
      detail: "not being able to tell whether anything is still writing rows is not evidence"
        + " that nothing is; this refuses rather than guess",
    });
  }

  if (facts.lastRowProgressAt && facts.now.getTime() - facts.lastRowProgressAt.getTime() < threshold) {
    return Object.freeze({
      recover: false,
      reason: "something_is_still_writing_rows",
      detail: `an invoice row was synced ${minutes(facts.now.getTime() - facts.lastRowProgressAt.getTime())}`
        + ` minute(s) ago, inside the ${minutes(threshold)} minute quiet period`,
    });
  }

  return Object.freeze({
    recover: true,
    // Preserve a settled journal; only an empty errorMessage may be written to.
    preserveJournal: facts.journal.present,
    note: `Presumed dead and abandoned automatically: started ${minutes(ageMs)} minute(s) ago,`
      + ` no invoice row written for ${facts.lastRowProgressAt ? minutes(facts.now.getTime() - facts.lastRowProgressAt.getTime()) + " minute(s)" : "the whole run"},`
      + ` no pending GHL write, ${facts.opportunitiesSynced ?? 0} opportunities synced.`
      + " Most often its container was replaced mid-run by a deploy.",
  });
}
