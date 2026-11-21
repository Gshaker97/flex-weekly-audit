import test from "node:test";
import assert from "node:assert/strict";
import { planLadderStep, planLadderDay, type LadderStepInput } from "../lib/notification-ladder-plan";
import { ORIGINAL_DAY10_SMS_BODY } from "../lib/notification-copy-policy";
import { PROPOSED_DAY15_SMS_FEE_WARNING_BODY } from "../lib/notification-day15-pilot";
import {
  DAY20_SMS_BODY, DAY25_SMS_BODY, DAY30_SMS_BODY_SUSPENDED, DAY30_SMS_BODY_UNVERIFIED,
  type SuspensionEvidence,
} from "../lib/notification-ladder-copy";

/**
 * The one worker's judgement, for every rung of the ladder.
 *
 * The property that matters most is negative: for any input that is unknown,
 * unreadable, unowned, out of range or merely unconvincing, the answer is a
 * hold with a reason - never a send. Most of these tests are that property,
 * because a reminder that goes out wrongly is a false statement about a
 * customer's account, and one that silently does not go out is what the audit
 * exists to catch.
 */

const TODAY = "2026-11-19";
const CLIENT = "jobber-client-1";
const ANGIE = { userId: "angie-user-id", displayName: "Angie Wiggins", approvalRef: "owner-2026-11-19" };

const POLICY_TERMS = {
  source: "company-late-fee-policy" as const,
  policyRef: "late-fee-and-cancellation-policies",
  effectiveFrom: "2026-01-01",
  termsExcerpt: "A late fee of 3% may apply to invoices not paid within 15 days of the due date.",
  statesLateFee: true as const,
  observedAt: "2026-11-18T16:00:00.000Z",
  evidenceRef: "policy-2026-11-18",
};
const SUSPENDED: SuspensionEvidence = {
  source: "operator-recorded-suspension", jobberClientId: CLIENT,
  suspendedOn: "2026-11-15", observedAt: "2026-11-18T16:00:00.000Z", evidenceRef: "susp-1",
};

const step = (over: Partial<LadderStepInput> = {}): LadderStepInput => ({
  dayPastDue: 20, category: "maintenance", scheduledOn: TODAY, today: TODAY,
  invoiceId: "inv-1", invoiceNumber: "7226", balanceMinor: 16_000, currency: "USD",
  invoiceIssuedOn: "2026-10-01", jobberClientId: CLIENT,
  homeownerContactId: "contact-1", assignee: ANGIE,
  holds: [], alreadySent: false, termsEvidence: null, suspensionEvidence: null, ...over,
});

const reasons = (over: Partial<LadderStepInput>) => {
  const action = planLadderStep(step(over));
  assert.equal(action.kind, "hold", `expected a hold, got ${action.kind}`);
  return action.kind === "hold" ? action.reasons : [];
};

// ------------------------------------------------------- every rung's words

test("each homeowner rung sends its own pinned text", () => {
  for (const [day, body] of [[10, ORIGINAL_DAY10_SMS_BODY], [20, DAY20_SMS_BODY], [25, DAY25_SMS_BODY]] as const) {
    const action = planLadderStep(step({ dayPastDue: day }));
    assert.equal(action.kind, "send_sms", `day ${day}`);
    if (action.kind !== "send_sms") return;
    assert.equal(action.body, body, `day ${day}`);
    assert.equal(action.contactId, "contact-1");
    assert.equal(action.dayPastDue, day);
  }
});

test("day 15 sends the fee WARNING, and only with evidence behind it", () => {
  // Without evidence the rung is silent, even though the words are pinned.
  assert.deepEqual([...reasons({ dayPastDue: 15, termsEvidence: null })],
    ["invoice_terms_or_written_policy_must_support_the_fee_warning"]);

  const action = planLadderStep(step({ dayPastDue: 15, termsEvidence: POLICY_TERMS }));
  assert.equal(action.kind, "send_sms");
  if (action.kind !== "send_sms") return;
  assert.equal(action.body, PROPOSED_DAY15_SMS_FEE_WARNING_BODY);
  assert.match(action.body, /may apply/);
  assert.ok(!/has been applied/.test(action.body), "never assert the fee");
});

test("an invoice issued before the policy took effect gets no fee warning", () => {
  assert.deepEqual([...reasons({ dayPastDue: 15, termsEvidence: POLICY_TERMS, invoiceIssuedOn: "2025-12-31" })],
    ["invoice_terms_or_written_policy_must_support_the_fee_warning"]);
  assert.deepEqual([...reasons({ dayPastDue: 15, termsEvidence: POLICY_TERMS, invoiceIssuedOn: null })],
    ["invoice_terms_or_written_policy_must_support_the_fee_warning"]);
});

test("day 30 tells the truth about suspension either way", () => {
  // Nothing records suspensions, so this is the path every real invoice takes.
  const unproven = planLadderStep(step({ dayPastDue: 30 }));
  assert.equal(unproven.kind, "send_sms");
  if (unproven.kind === "send_sms") {
    assert.equal(unproven.body, DAY30_SMS_BODY_UNVERIFIED);
    assert.ok(!/have been temporarily suspended/.test(unproven.body));
  }
  const proven = planLadderStep(step({ dayPastDue: 30, suspensionEvidence: SUSPENDED }));
  assert.equal(proven.kind, "send_sms");
  if (proven.kind === "send_sms") assert.equal(proven.body, DAY30_SMS_BODY_SUSPENDED);
});

test("suspension evidence for a DIFFERENT client does not change day 30's words", () => {
  const action = planLadderStep(step({
    dayPastDue: 30, suspensionEvidence: { ...SUSPENDED, jobberClientId: "someone-else" } }));
  assert.equal(action.kind, "send_sms");
  if (action.kind === "send_sms") assert.equal(action.body, DAY30_SMS_BODY_UNVERIFIED);
});

// --------------------------------------------------------- the internal rungs

test("day 21 and day 35 produce Angie's tasks, not texts", () => {
  for (const [day, kind] of [[21, "day21-call"], [35, "day35-collections"]] as const) {
    const action = planLadderStep(step({ dayPastDue: day }));
    assert.equal(action.kind, "create_task", `day ${day}`);
    if (action.kind !== "create_task") return;
    assert.equal(action.taskKind, kind);
    assert.equal(action.request.assignee.userId, ANGIE.userId);
    assert.equal(action.request.dueOn, TODAY);
    assert.equal(action.request.invoiceNumber, "7226");
  }
});

test("an internal rung with nobody to own it is held", () => {
  assert.deepEqual([...reasons({ dayPastDue: 21, assignee: null })], ["no_assignee"]);
  assert.ok(reasons({ dayPastDue: 21, assignee: { ...ANGIE, approvalRef: "" } })
    .includes("assignee_not_approved"));
});

test("a task with no contact to hang off is held, not created loose", () => {
  assert.ok(reasons({ dayPastDue: 21, homeownerContactId: null }).includes("contact_id_unusable"));
});

// -------------------------------------------------- the ladder's own shape

test("irrigation stops at 21: no day 25 or 30 text for an irrigation invoice", () => {
  for (const day of [20, 25, 30, 35]) {
    assert.deepEqual([...reasons({ category: "irrigation", dayPastDue: day })],
      ["day_is_not_a_rung_of_this_ladder"], `irrigation day ${day}`);
  }
  // The rungs it does have still work.
  assert.equal(planLadderStep(step({ category: "irrigation", dayPastDue: 10 })).kind, "send_sms");
  assert.equal(planLadderStep(step({ category: "irrigation", dayPastDue: 21 })).kind, "create_task");
});

test("a day that is not on any ladder is held", () => {
  for (const day of [1, 9, 14, 22, 36, 100, -5, 1.5]) {
    assert.ok(reasons({ dayPastDue: day }).includes("day_is_not_a_rung_of_this_ladder"), `day ${day}`);
  }
});

// ------------------------------------------------------------- dates

test("a rung that is not today is not acted on, and is not an error", () => {
  const future = planLadderStep(step({ scheduledOn: "2026-11-25" }));
  assert.deepEqual(future, { kind: "not_due", dayPastDue: 20, reason: "future" });
  // A missed day is never replayed: catching up is a person's decision.
  const past = planLadderStep(step({ scheduledOn: "2026-11-01" }));
  assert.deepEqual(past, { kind: "not_due", dayPastDue: 20, reason: "already_past" });
});

test("unreadable dates are held", () => {
  assert.deepEqual([...reasons({ scheduledOn: "19/11/2026" })], ["ladder_dates_unreadable"]);
  assert.deepEqual([...reasons({ today: "" })], ["ladder_dates_unreadable"]);
});

// ------------------------------------------- silence is the default

test("upstream holds are passed through and never cleared", () => {
  const out = reasons({ holds: ["contact_opted_out", "ambiguous_destination_contacts"] });
  assert.ok(out.includes("contact_opted_out"));
  assert.ok(out.includes("ambiguous_destination_contacts"));
});

test("an unknown send history is a hold, not an assumption that nothing went out", () => {
  assert.deepEqual([...reasons({ alreadySent: null })], ["send_history_unknown"]);
  assert.deepEqual([...reasons({ alreadySent: undefined as never })], ["send_history_unknown"]);
  assert.deepEqual([...reasons({ alreadySent: true })], ["already_sent_on_this_channel"]);
});

test("nothing owed means nothing is sent", () => {
  for (const balance of [0, -1, -16_000, 1.5, Number.NaN]) {
    assert.ok(reasons({ balanceMinor: balance as number }).includes("balance_not_positive"), String(balance));
  }
});

test("a missing destination, invoice or currency is a hold", () => {
  assert.deepEqual([...reasons({ homeownerContactId: null })], ["no_usable_homeowner_contact"]);
  assert.deepEqual([...reasons({ homeownerContactId: "a/b" })], ["no_usable_homeowner_contact"]);
  assert.ok(reasons({ invoiceId: "" }).includes("invoice_id_missing"));
  assert.ok(reasons({ invoiceNumber: "  " }).includes("invoice_number_missing"));
  assert.ok(reasons({ currency: "dollars" }).includes("currency_unusable"));
});

test("a wholly malformed step is held rather than thrown", () => {
  for (const bad of [null, undefined, 42, "step"]) {
    const action = planLadderStep(bad as never);
    assert.equal(action.kind, "hold");
  }
});

test("every reason is reported at once, deduplicated and sorted", () => {
  const out = reasons({ invoiceId: "", currency: "x", balanceMinor: 0, alreadySent: null,
    holds: ["dup", "dup"] });
  assert.ok(out.length >= 4);
  assert.deepEqual([...out], [...out].sort());
  assert.equal(new Set(out).size, out.length);
});

// ----------------------------------------------------- a whole morning

test("a day's plan accounts for every step handed to it", () => {
  const plan = planLadderDay([
    step({ dayPastDue: 10 }),
    step({ dayPastDue: 15, termsEvidence: POLICY_TERMS }),
    step({ dayPastDue: 20 }),
    step({ dayPastDue: 21 }),
    step({ dayPastDue: 25, holds: ["contact_opted_out"] }),
    step({ dayPastDue: 30, scheduledOn: "2026-12-01" }),
  ], TODAY);
  assert.equal(plan.actions.length, 6);
  assert.deepEqual(plan.summary, { sends: 3, tasks: 1, holds: 1, notDue: 1 });
  // The counts must sum: a step cannot fall out of the plan unnoticed.
  const { sends, tasks, holds, notDue } = plan.summary;
  assert.equal(sends + tasks + holds + notDue, plan.actions.length);
  assert.deepEqual([...plan.holdReasons], ["contact_opted_out"]);
});

test("the plan imposes its own run date on every step", () => {
  // A step carrying yesterday's date cannot make itself due by saying so.
  const plan = planLadderDay([step({ today: "2026-01-01" })], TODAY);
  assert.equal(plan.today, TODAY);
  assert.equal(plan.actions[0].kind, "send_sms");
});

test("an empty or unusable list plans nothing rather than failing", () => {
  for (const bad of [[], null, undefined, "steps"]) {
    const plan = planLadderDay(bad as never, TODAY);
    assert.equal(plan.actions.length, 0);
    assert.deepEqual(plan.summary, { sends: 0, tasks: 0, holds: 0, notDue: 0 });
  }
});
