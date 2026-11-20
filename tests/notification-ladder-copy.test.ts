import test from "node:test";
import assert from "node:assert/strict";
import {
  DAY20_SMS_BODY, DAY25_SMS_BODY, DAY30_SMS_BODY_SUSPENDED, DAY30_SMS_BODY_UNVERIFIED,
  LADDER_SMS_BODIES, LADDER_OFFICE_PHONE,
  ladderWarningCopyIsValid, day30CopyIsValid, day30Copy, ladderCopyClaims,
  bodyAssertsASuspension, bodyAssertsCollectionsAlreadyHappened,
  suspensionIsProven, type SuspensionEvidence,
} from "../lib/notification-ladder-copy";

/**
 * The rest of the ladder: days 20, 25 and 30.
 *
 * The written policy's wording assumes the earlier steps happened — that fees
 * accrued, that services were suspended. Measured 2026-11-18, only 2 of 27
 * invoices past day 15 carried any late fee. So each assertion here is either
 * softened to the conditional, or it keeps its claim AND needs evidence.
 *
 * These tests exist to stop that sliding back. The difference between "services
 * may be suspended" and "your services have been suspended" is the difference
 * between a warning and a false statement about someone's account.
 */

const CLIENT = "jobber-client-1";
const GOOD_SUSPENSION: SuspensionEvidence = {
  source: "operator-recorded-suspension", jobberClientId: CLIENT,
  suspendedOn: "2026-11-15", observedAt: "2026-11-18T16:00:00.000Z", evidenceRef: "susp-1",
};

// ----------------------------------------------------------- days 20 and 25

test("the day 20 and 25 texts are valid warnings", () => {
  assert.equal(ladderWarningCopyIsValid(DAY20_SMS_BODY), true);
  assert.equal(ladderWarningCopyIsValid(DAY25_SMS_BODY), true);
});

test("they say what the policy says, with the fee as a possibility", () => {
  for (const [day, body] of [[20, DAY20_SMS_BODY], [25, DAY25_SMS_BODY]] as const) {
    assert.match(body, new RegExp(`invoice is ${day} days past due`), `day ${day}`);
    assert.match(body, /late fees may be\s+added every 15 days/);
    assert.match(body, /services may be temporarily suspended/);
    assert.ok(body.includes(LADDER_OFFICE_PHONE));
    // The policy's own phrasing, which measurement ruled out.
    assert.ok(!/will continue to incur/i.test(body), `day ${day} must not assert accruing fees`);
    assert.ok(!/have been (temporarily )?suspended/i.test(body), `day ${day} must not assert a suspension`);
  }
});

test("days 20 and 25 differ only in the day number", () => {
  assert.equal(DAY20_SMS_BODY.replace("20 days", "N days"), DAY25_SMS_BODY.replace("25 days", "N days"));
});

test("the pinned bodies are the ones the ladder hands out", () => {
  assert.equal(LADDER_SMS_BODIES[20], DAY20_SMS_BODY);
  assert.equal(LADDER_SMS_BODIES[25], DAY25_SMS_BODY);
});

test("the policy's own day 20 wording is REJECTED", () => {
  // "will continue to incur late fees" says fees already started. For 25 of 27
  // measured invoices, none had.
  const asWritten = "This is a reminder that your invoice is 20 days past due. This invoice will " +
    "continue to incur late fees every 15 days and may result in the temporary suspension of " +
    "services until payment is received. If you have any questions or concerns please reach out " +
    "to our office at 602-329-7865.";
  // It is still conditional about suspension, so what must reject it is the fee
  // claim — pinned here so a future edit cannot pass it off as a warning.
  assert.equal(/\bwill continue to incur\b/i.test(asWritten), true, "this is the phrase at issue");
  assert.ok(!DAY20_SMS_BODY.includes("will continue to incur"));
});

test("a warning may not assert a suspension or a completed referral", () => {
  assert.equal(ladderWarningCopyIsValid(
    "Your invoice is 20 days past due. Late fees may be added. Your services have been suspended."), false);
  assert.equal(ladderWarningCopyIsValid(
    "Your invoice is 20 days past due. Late fees may be added. This has been sent to collections."), false);
});

test("a warning must still mention a fee conditionally", () => {
  assert.equal(ladderWarningCopyIsValid("Your invoice is 20 days past due. Please pay it."), false,
    "no fee mention at all belongs under the no-fee-claim policy");
  assert.equal(ladderWarningCopyIsValid(
    "Your invoice is 20 days past due. A late fee of 3% has been applied."), false, "asserts");
});

test("unusable copy is never valid", () => {
  for (const bad of ["", "   ", null, undefined, 42, {}, "Late fees may be added.\0",
    "Late fees may be added {{balance}}"]) {
    assert.equal(ladderWarningCopyIsValid(bad as unknown), false, JSON.stringify(bad));
  }
});

test("the ladder texts carry no placeholder, like the policy's own", () => {
  for (const body of [DAY20_SMS_BODY, DAY25_SMS_BODY, DAY30_SMS_BODY_SUSPENDED, DAY30_SMS_BODY_UNVERIFIED]) {
    assert.ok(!/[{}]/.test(body), body.slice(0, 40));
  }
});

// ------------------------------------------------- telling a warning from a claim

test("asserting a suspension is detected; warning about one is not", () => {
  assert.equal(bodyAssertsASuspension("Your services have been temporarily suspended."), true);
  assert.equal(bodyAssertsASuspension("Your services have been suspended."), true);
  assert.equal(bodyAssertsASuspension("Your service is now suspended."), true);
  // Warnings must pass through untouched.
  assert.equal(bodyAssertsASuspension("Services may be temporarily suspended until payment is received."), false);
  assert.equal(bodyAssertsASuspension("may result in the temporary suspension of services"), false);
  assert.equal(bodyAssertsASuspension("This could lead to services being suspended."), false);
});

test("asserting collections already happened is detected; warning is not", () => {
  assert.equal(bodyAssertsCollectionsAlreadyHappened("This invoice has been sent to collections."), true);
  assert.equal(bodyAssertsCollectionsAlreadyHappened("The invoice is now in collections."), true);
  assert.equal(bodyAssertsCollectionsAlreadyHappened(
    "the invoice will be sent to collections"), false, "a future statement is not a claim it happened");
  assert.equal(bodyAssertsCollectionsAlreadyHappened(
    "the invoice may be sent to collections"), false);
});

test("claims are read from the words, not taken on trust", () => {
  assert.deepEqual([...ladderCopyClaims(DAY20_SMS_BODY)], ["recurring_late_fee_policy"]);
  assert.deepEqual([...ladderCopyClaims(DAY30_SMS_BODY_SUSPENDED)],
    ["service_suspended", "collections_after_day_35_policy"]);
  assert.deepEqual([...ladderCopyClaims(DAY30_SMS_BODY_UNVERIFIED)],
    ["collections_after_day_35_policy"]);
});

// ------------------------------------------------------------------- day 30

test("day 30 has two bodies and evidence picks which one", () => {
  const proven = day30Copy(GOOD_SUSPENSION, CLIENT);
  assert.equal(proven.suspensionProven, true);
  assert.equal(proven.body, DAY30_SMS_BODY_SUSPENDED);

  const unproven = day30Copy(null, CLIENT);
  assert.equal(unproven.suspensionProven, false);
  assert.equal(unproven.body, DAY30_SMS_BODY_UNVERIFIED);
});

test("with no suspension on record the conditional body is the DEFAULT, not a fallback", () => {
  // Nothing in the system records suspensions today, so this is the path every
  // real invoice takes. It must be fully valid, not a degraded placeholder.
  const chosen = day30Copy(undefined, CLIENT);
  assert.equal(day30CopyIsValid(chosen.body, false), true);
  assert.ok(!bodyAssertsASuspension(chosen.body));
  assert.match(chosen.body, /final reminder/);
  assert.match(chosen.body, /may be sent to collections/);
});

test("the asserted day 30 body is refused without proof", () => {
  assert.equal(day30CopyIsValid(DAY30_SMS_BODY_SUSPENDED, false), false);
  assert.equal(day30CopyIsValid(DAY30_SMS_BODY_SUSPENDED, true), true);
});

test("with proof, the conditional body is refused: tell them the true thing", () => {
  // A hedge when the fact is known is its own kind of wrong — the customer
  // cannot tell whether their service is actually off.
  assert.equal(day30CopyIsValid(DAY30_SMS_BODY_UNVERIFIED, true), false);
});

test("day 30 may never claim the invoice already went to collections", () => {
  const tooFar = DAY30_SMS_BODY_SUSPENDED.replace(
    "will be sent to collections", "has been sent to collections");
  assert.equal(day30CopyIsValid(tooFar, true), false);
});

test("day 30 says collections follows at 35 days, matching the internal step", () => {
  for (const body of [DAY30_SMS_BODY_SUSPENDED, DAY30_SMS_BODY_UNVERIFIED]) {
    assert.match(body, /within 35 days of the invoice due date/);
  }
});

// -------------------------------------------------------- suspension evidence

test("suspension evidence must name THIS client", () => {
  assert.equal(suspensionIsProven(GOOD_SUSPENSION, CLIENT), true);
  assert.equal(suspensionIsProven(GOOD_SUSPENSION, "another-client"), false);
  assert.equal(suspensionIsProven({ ...GOOD_SUSPENSION, jobberClientId: "" }, ""), false);
});

test("an old invoice is not suspension evidence, and neither is a say-so", () => {
  assert.equal(suspensionIsProven(null, CLIENT), false);
  assert.equal(suspensionIsProven(undefined, CLIENT), false);
  assert.equal(suspensionIsProven({ ...GOOD_SUSPENSION, source: "it_is_day_30" } as never, CLIENT), false);
  assert.equal(suspensionIsProven({ ...GOOD_SUSPENSION, evidenceRef: "" }, CLIENT), false);
});

test("suspension evidence needs a usable date and may not be from the future", () => {
  assert.equal(suspensionIsProven({ ...GOOD_SUSPENSION, suspendedOn: "15/11/2026" }, CLIENT), false);
  assert.equal(suspensionIsProven({ ...GOOD_SUSPENSION, suspendedOn: "" }, CLIENT), false);
  assert.equal(suspensionIsProven({ ...GOOD_SUSPENSION, observedAt: "not a time" }, CLIENT), false);
  assert.equal(suspensionIsProven(
    { ...GOOD_SUSPENSION, observedAt: new Date(Date.now() + 86_400_000).toISOString() }, CLIENT), false);
});
