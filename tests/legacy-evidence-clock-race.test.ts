import test from "node:test";
import assert from "node:assert/strict";
import { legacySendingFromEnv } from "../lib/ghl-invoice-card-writer";
import { legacySendingIsOff, planInvoiceCards, STAGE_OVERDUE, STAGE_SENT } from "../lib/ghl-invoice-card-plan";

const WORKFLOW = "legacy-workflow";
const ENV = {
  GHL_LEGACY_INVOICE_WORKFLOW_ID: WORKFLOW,
  GHL_LEGACY_SENDING_DISABLED: "2026-11-23|owner switched every GHL automation off",
};

/**
 * THE BUG THIS FILE EXISTS FOR.
 *
 * `lib/sync.ts` captures `now` once (line ~740), does a sync's worth of async
 * work - Jobber pages, GHL reads - and only then builds the evidence from the
 * environment (line ~857), which stamps `observedAt` with the clock AT THAT
 * MOMENT. The planner is then handed the ORIGINAL `now`.
 *
 * So `observedAt` is later than `now` by however long the sync took: seconds,
 * sometimes minutes. `legacySendingIsOff` rejects evidence observed after
 * `now` - "a check from the future is a clock problem, not evidence" - and the
 * Overdue move is withheld with no error and no reason anyone would see.
 *
 * That is not a rare flake. With both variables correctly set it withholds
 * EVERY overdue move, every run.
 */

test("ONE THREADED CLOCK SURVIVES A RUN OF ANY LENGTH", () => {
  // The fix, stated as the caller's contract: thread the run's own `now` into
  // both halves and the evidence holds no matter how long the run has taken.
  // `now` here is deliberately in the past, standing for a sync that started
  // ten minutes ago and is only now reaching the card planner.
  const now = new Date("2026-11-24T06:00:00.000Z");
  const evidence = legacySendingFromEnv(ENV, now);
  assert.ok(evidence, "the env is well formed, so evidence is produced");
  assert.equal(legacySendingIsOff(evidence, WORKFLOW, now), true,
    "the operator's confirmation does not expire because the sync took a while");
});

test("a caller that stamps and checks from DIFFERENT clocks is still refused", () => {
  // The guard itself is unchanged and still rejects an observation from the
  // future. This test exists to pin WHY the caller must thread one clock: get
  // it wrong and the refusal is silent, which is the bug that was shipped.
  const planningClock = new Date("2026-11-24T06:00:00.000Z");
  const envReadClock = new Date("2026-11-24T06:01:00.000Z");
  const evidence = legacySendingFromEnv(ENV, envReadClock);
  assert.equal(legacySendingIsOff(evidence, WORKFLOW, planningClock), false);
});

test("A WHOLE SYNC'S WORTH OF DELAY STILL LETS THE CARD MOVE", () => {
  // The end-to-end shape of the bug, through the real planner.
  // Exactly `lib/sync.ts`'s shape after the fix: one `now`, captured at the
  // start of the run, threaded into the env read AND the planner.
  const now = new Date("2026-11-24T06:00:00.000Z");
  const evidence = legacySendingFromEnv(ENV, now);
  const plan = planInvoiceCards({
    contactId: "contact-1",
    label: "Elizabeth Brungs",
    invoices: [{ invoiceId: "inv-1", invoiceNumber: "7286", status: "past_due",
      totalDollars: 137, balanceDollars: 137 }],
    cards: [{ id: "card-1", name: "Invoice #7286 — Elizabeth Brungs",
      stageName: STAGE_SENT, status: "open", monetaryValue: 137 }],
    clocks: { "inv-1": { daysPastDue: 5, isOverdue: true, sentOn: "2026-11-14" } },
    windowStart: "2026-07-24",
    legacyWorkflowId: WORKFLOW,
    legacySending: evidence,
    now,
  } as never);
  const adopt = plan.actions.find(a => a.state === "adopt");
  assert.ok(adopt, JSON.stringify(plan.actions));
  if (adopt?.state !== "adopt") return;
  assert.equal(adopt.stage, STAGE_OVERDUE,
    "the card must reach Overdue; withholding it here is the silent failure");
  assert.ok(!adopt.reasons.includes("overdue_move_withheld_until_legacy_workflow_sending_is_off"),
    adopt.reasons.join(","));
});

test("genuinely bad evidence is still refused", () => {
  const now = new Date("2026-11-24T06:00:00.000Z");
  // A disabledOn in the future is a mistake, not a fact, and stays rejected.
  assert.equal(legacySendingFromEnv({
    ...ENV, GHL_LEGACY_SENDING_DISABLED: "2099-01-01|typo",
  }, now), null);
  // A missing reason is not evidence.
  assert.equal(legacySendingFromEnv({ ...ENV, GHL_LEGACY_SENDING_DISABLED: "2026-11-23|" }, now), null);
  assert.equal(legacySendingFromEnv({ ...ENV, GHL_LEGACY_SENDING_DISABLED: "2026-11-23" }, now), null);
  // A malformed day is not evidence.
  assert.equal(legacySendingFromEnv({ ...ENV, GHL_LEGACY_SENDING_DISABLED: "23-11-2026|x" }, now), null);
  assert.equal(legacySendingFromEnv({ ...ENV, GHL_LEGACY_SENDING_DISABLED: "2026-02-30|x" }, now), null);
  // No workflow id is not evidence.
  assert.equal(legacySendingFromEnv({ GHL_LEGACY_SENDING_DISABLED: "2026-11-23|x" }, now), null);
  // And the wrong workflow never passes the gate.
  const evidence = legacySendingFromEnv(ENV, now);
  assert.equal(legacySendingIsOff(evidence, "some-other-workflow", now), false);
  assert.equal(legacySendingIsOff(evidence, "", now), false);
  assert.equal(legacySendingIsOff(null, WORKFLOW, now), false);
});

test("the recorded observation is the run's own clock reading", () => {
  const now = new Date("2026-11-24T06:00:00.000Z");
  const evidence = legacySendingFromEnv(ENV, now);
  assert.equal(evidence?.observedAt, now.toISOString(),
    "one clock reading, used for both stamping and checking, so the two cannot disagree");
  assert.equal(evidence?.disabledOn, "2026-11-23", "the operator's own date is untouched");
});

test("omitting now still works, for callers that do not thread a clock", () => {
  const evidence = legacySendingFromEnv(ENV);
  assert.ok(evidence);
  assert.equal(legacySendingIsOff(evidence, WORKFLOW), true);
});
