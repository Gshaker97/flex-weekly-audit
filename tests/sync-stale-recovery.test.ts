import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { staleRunVerdict, STALE_RUN_MIN_AGE_MS, type StaleRunFacts } from "../lib/sync-stale-recovery";
import { staleRunThresholdMs } from "../lib/sync-writer-control";

const NOW = new Date("2026-11-26T03:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);

/** Tonight's real case: dead 45+ minutes, nothing written, no journal. */
const dead = (over: Partial<StaleRunFacts> = {}): StaleRunFacts => ({
  status: "running",
  startedAt: ago(380),
  opportunitiesSynced: 0,
  journal: { present: false, pendingWrites: 0 },
  lastRowProgressAt: ago(378),
  now: NOW,
  ...over,
});

test("the run that cost five hourly syncs is recovered", () => {
  const v = staleRunVerdict(dead());
  assert.equal(v.recover, true);
  if (v.recover) {
    assert.equal(v.preserveJournal, false);
    assert.match(v.note, /abandoned automatically/);
    assert.match(v.note, /container was replaced/);
  }
});

// ---- THE TWO CHECKS THAT PROTECT A WRITE. -------------------------------

test("a pending write is NEVER cleared, however old or quiet the run is", () => {
  // The absolute rule. Nothing may override it, so it is tried against every
  // combination that would otherwise sail through.
  for (const over of [
    {},
    { startedAt: ago(10_000), lastRowProgressAt: ago(10_000) },
    { opportunitiesSynced: 0 },
    { lastRowProgressAt: null },
  ]) {
    const v = staleRunVerdict(dead({ ...over, journal: { present: true, pendingWrites: 1 } }));
    assert.equal(v.recover, false, JSON.stringify(over));
    if (!v.recover) {
      assert.equal(v.reason, "a_pending_write_journal_entry_is_never_cleared_automatically");
      assert.match(v.detail, /second card/);
    }
  }
});

test("a blocked run is an operator hold and is left alone", () => {
  // The writer sets `blocked` on purpose. Clearing it would discard the signal.
  for (const status of ["blocked", "complete", "failed", "abandoned", ""]) {
    const v = staleRunVerdict(dead({ status }));
    assert.equal(v.recover, false, status);
    if (!v.recover) assert.equal(v.reason, "a_blocked_run_is_an_operator_hold_not_a_casualty");
  }
});

test("the pending-write check is tried before the status check cannot matter", () => {
  // A blocked run with a pending write must still refuse — either reason is
  // correct, but it must never recover.
  const v = staleRunVerdict(dead({ status: "blocked", journal: { present: true, pendingWrites: 2 } }));
  assert.equal(v.recover, false);
});

// ---- UNRECORDED GHL WORK. -----------------------------------------------

test("a run that synced opportunities with no journal to show for it refuses", () => {
  const v = staleRunVerdict(dead({ opportunitiesSynced: 3, journal: { present: false, pendingWrites: 0 } }));
  assert.equal(v.recover, false);
  if (!v.recover) {
    assert.equal(v.reason, "opportunities_were_synced_with_no_write_journal_to_show_for_it");
    assert.match(v.detail, /left no evidence/);
  }
});

test("a settled journal is recovered, and the journal is preserved", () => {
  // Writes that all finished are evidence, not danger. The row may be cleared
  // but the column holding that evidence must not be written over.
  const v = staleRunVerdict(dead({
    opportunitiesSynced: 7,
    journal: { present: true, pendingWrites: 0 },
  }));
  assert.equal(v.recover, true);
  if (v.recover) assert.equal(v.preserveJournal, true, "a settled journal must be preserved");
});

// ---- AGE. ----------------------------------------------------------------

test("a young run is never presumed dead", () => {
  for (const min of [0, 1, 11, 44]) {
    const v = staleRunVerdict(dead({ startedAt: ago(min), lastRowProgressAt: ago(min) }));
    assert.equal(v.recover, false, `${min} minutes`);
    if (!v.recover) assert.equal(v.reason, "not_old_enough_to_be_presumed_dead");
  }
});

test("the threshold boundary is inclusive and stated in the refusal", () => {
  const atThreshold = STALE_RUN_MIN_AGE_MS / 60_000;
  assert.equal(staleRunVerdict(dead({ startedAt: ago(atThreshold), lastRowProgressAt: ago(atThreshold) })).recover, true);
  const v = staleRunVerdict(dead({ startedAt: ago(atThreshold - 1), lastRowProgressAt: ago(atThreshold - 1) }));
  assert.equal(v.recover, false);
  if (!v.recover) assert.match(v.detail, /44 minute\(s\) ago; 45 is the threshold/);
});

test("a custom threshold is honoured, in both directions", () => {
  assert.equal(staleRunVerdict(dead({ startedAt: ago(20), lastRowProgressAt: ago(20), minAgeMs: 15 * 60_000 })).recover, true);
  assert.equal(staleRunVerdict(dead({ startedAt: ago(100), lastRowProgressAt: ago(100), minAgeMs: 200 * 60_000 })).recover, false);
});

// ---- PROGRESS. -----------------------------------------------------------

test("a run still writing rows is alive, however old it is", () => {
  // The whole point of the second check: age alone is not death.
  const v = staleRunVerdict(dead({ startedAt: ago(600), lastRowProgressAt: ago(2) }));
  assert.equal(v.recover, false);
  if (!v.recover) {
    assert.equal(v.reason, "something_is_still_writing_rows");
    assert.match(v.detail, /2 minute\(s\) ago/);
  }
});

test("progress just inside the quiet period still protects the run", () => {
  assert.equal(staleRunVerdict(dead({ startedAt: ago(600), lastRowProgressAt: ago(44) })).recover, false);
  assert.equal(staleRunVerdict(dead({ startedAt: ago(600), lastRowProgressAt: ago(45) })).recover, true);
});

test("no progress at all counts as no progress, not as unknown", () => {
  // An empty invoice table must not wedge recovery shut.
  const v = staleRunVerdict(dead({ lastRowProgressAt: null }));
  assert.equal(v.recover, true);
  if (v.recover) assert.match(v.note, /the whole run/);
});

test("progress in the future does not recover a run", () => {
  // A clock skew must not read as a long quiet period.
  const v = staleRunVerdict(dead({ lastRowProgressAt: new Date(NOW.getTime() + 60_000) }));
  assert.equal(v.recover, false);
  if (!v.recover) assert.equal(v.reason, "something_is_still_writing_rows");
});

test("every refusal carries a reason and a detail worth logging", () => {
  const cases: Partial<StaleRunFacts>[] = [
    { status: "blocked" },
    { journal: { present: true, pendingWrites: 1 } },
    { opportunitiesSynced: 2 },
    { startedAt: ago(1), lastRowProgressAt: ago(1) },
    { lastRowProgressAt: ago(1) },
  ];
  for (const over of cases) {
    const v = staleRunVerdict(dead(over));
    assert.equal(v.recover, false, JSON.stringify(over));
    if (!v.recover) {
      assert.match(v.reason, /^[a-z_]+$/, "reason is a stable slug");
      assert.ok(v.detail.length > 20, "detail says something useful");
    }
  }
});

test("a verdict is frozen, so a caller cannot edit the decision", () => {
  const v = staleRunVerdict(dead());
  assert.equal(Object.isFrozen(v), true);
});

// ---- THE THRESHOLD, AND THE WIRING IN THE ADMISSION GATE. ---------------

test("the threshold is read from the environment, and a bad value never disables the guard", () => {
  assert.equal(staleRunThresholdMs({} as any), STALE_RUN_MIN_AGE_MS);
  assert.equal(staleRunThresholdMs({ SYNC_STALE_RUN_MINUTES: "90" } as any), 90 * 60_000);
  // A value that would weaken or disable the guard falls back to the default.
  for (const bad of ["0", "-5", "", "   ", "abc", "NaN", "Infinity"]) {
    assert.equal(staleRunThresholdMs({ SYNC_STALE_RUN_MINUTES: bad } as any),
      STALE_RUN_MIN_AGE_MS, JSON.stringify(bad));
  }
});

test("the admission gate refuses loudly and recovers only through this decision", () => {
  // The gate's behaviour is exercised end-to-end by the existing fake-database
  // tests (a pending journal and a blocked row both still reject). These guard
  // the parts of the wiring those tests cannot see: that the refusal is logged
  // rather than silent, that the decision comes from here, and that a settled
  // journal is never written over.
  const src = readFileSync(new URL("../lib/sync-writer-control.ts", import.meta.url), "utf8");
  assert.match(src, /staleRunVerdict\(\{/, "the gate must use this module's decision");
  assert.match(src, /console\.error\(`\[sync\] REFUSING TO START/, "a refusal must be loud");
  assert.match(src, /verdict\.reason/, "and must say which check failed");
  assert.match(src, /console\.warn\(`\[sync\] abandoned a dead run/, "a recovery must be loud too");
  // The write is conditional on the status, so two processes cannot both clear it.
  assert.match(src, /where: \{ id: blocker\.id, status: "running" \}/);
  // A settled journal keeps its column; only a journal-free row gets a note.
  assert.match(src, /verdict\.preserveJournal\s*\n?\s*\?\s*\{ status: "abandoned", completedAt: new Date\(\) \}/);
  // An unreadable journal must count as a pending write, never as none.
  assert.match(src, /pendingWrites: journalUnreadable\s*\n?\s*\? 1/);
  assert.match(src, /not evidence that nothing is in flight/);
});

test("the old promise of no automatic recovery is gone from the gate's comment", () => {
  // It said "No age-based expiry or automatic recovery." Leaving that in place
  // next to code that does exactly that is how the next person gets misled.
  const src = readFileSync(new URL("../lib/sync-writer-control.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /No age-based expiry or automatic recovery/);
});
