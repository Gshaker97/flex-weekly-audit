import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  NATIVE_SMS_ATTESTATION_MAX_AGE_DAYS,
  NATIVE_SMS_GATE_TAG,
  nativeSmsOverlapHolds,
  nativeSmsTagHolds,
  type NativeSmsAttestation,
} from "../lib/reminder-native-sms-overlap";
import { evaluateReminders, type ReminderEvaluationReaders } from "../lib/reminder-evaluation";

const NOW = new Date("2026-11-25T16:05:00.000Z"); // 09:05 Phoenix, day 15 of inv-1
const GOOD: NativeSmsAttestation = {
  reviewedOn: "2026-11-24",
  publishedWorkflowCount: 16,
  activeEnrolments: 0,
  noOtherEnrolmentPath: true,
};
const has = (holds: readonly string[], prefix: string) => holds.some(h => h.startsWith(prefix));

// ---------------------------------------------------------------- tag half

test("the tag half clears a readable tag list without the gate tag", () => {
  assert.deepEqual(nativeSmsTagHolds(["irrigation", "maintenance", "day15-pilot"]), []);
});

test("the gate tag holds", () => {
  const holds = nativeSmsTagHolds(["irrigation", NATIVE_SMS_GATE_TAG]);
  assert.equal(holds.length, 1);
  assert.ok(holds[0].startsWith("native_sms_gate_tag_present"));
});

test("unreadable tags hold rather than read as absent", () => {
  assert.ok(has(nativeSmsTagHolds(null), "native_sms_contact_tags_unreadable"));
  assert.ok(has(nativeSmsTagHolds(undefined), "native_sms_contact_tags_unreadable"));
  assert.ok(has(nativeSmsTagHolds([1 as unknown as string]), "native_sms_contact_tags_unreadable"));
});

test("an empty tag list is readable and clear", () => {
  assert.deepEqual(nativeSmsTagHolds([]), []);
});

test("a near-match of the gate tag holds instead of being ruled out", () => {
  for (const tag of ["Flex-Native-Paula-Approved", " flex-native-paula-approved", "FLEX-NATIVE-PAULA-APPROVED"]) {
    assert.ok(has(nativeSmsTagHolds([tag]), "native_sms_gate_tag_ambiguous"), tag);
  }
});

test("a tag that merely contains the gate tag is not a near-match", () => {
  assert.deepEqual(nativeSmsTagHolds([`${NATIVE_SMS_GATE_TAG}-2025`]), []);
});

// --------------------------------------------------------- attestation half

test("a fresh, affirmative attestation plus clean tags clears", () => {
  assert.deepEqual(nativeSmsOverlapHolds({ contactTags: ["irrigation"], attestation: GOOD, now: NOW }), []);
});

test("no attestation holds, because enrolment cannot be read from the API", () => {
  const holds = nativeSmsOverlapHolds({ contactTags: ["irrigation"], attestation: null, now: NOW });
  assert.ok(has(holds, "native_sms_enrolment_unattested"));
});

test("an attestation that does not rule out another enrolment path holds", () => {
  const holds = nativeSmsOverlapHolds({
    contactTags: ["irrigation"], now: NOW,
    attestation: { ...GOOD, noOtherEnrolmentPath: false },
  });
  assert.ok(has(holds, "native_sms_enrolment_unattested"));
});

test("an attestation older than the maximum age holds", () => {
  const holds = nativeSmsOverlapHolds({
    contactTags: ["irrigation"], now: NOW,
    attestation: { ...GOOD, reviewedOn: "2026-11-01" },
  });
  assert.ok(has(holds, "native_sms_attestation_stale"));
});

test("the age boundary is measured in whole Phoenix days", () => {
  // Reviewed exactly MAX days before the Phoenix day the decision falls in.
  const reviewedOn = "2026-11-18"; // 7 days before 2026-11-25
  assert.equal(NATIVE_SMS_ATTESTATION_MAX_AGE_DAYS, 7);
  assert.deepEqual(
    nativeSmsOverlapHolds({ contactTags: [], now: NOW, attestation: { ...GOOD, reviewedOn } }), []);
  assert.ok(has(nativeSmsOverlapHolds({
    contactTags: [], now: NOW, attestation: { ...GOOD, reviewedOn: "2026-11-17" },
  }), "native_sms_attestation_stale"));
});

test("an unusable or future review date holds", () => {
  for (const reviewedOn of ["", "yesterday", "2026-13-01", "2026-12-25"]) {
    assert.ok(has(nativeSmsOverlapHolds({
      contactTags: [], now: NOW, attestation: { ...GOOD, reviewedOn },
    }), "native_sms_attestation_undated"), reviewedOn);
  }
});

test("an active enrolment holds, even with clean tags", () => {
  for (const activeEnrolments of [1, 453, -1, 0.5, Number.NaN]) {
    const holds = nativeSmsOverlapHolds({
      contactTags: [], now: NOW, attestation: { ...GOOD, activeEnrolments } });
    assert.ok(has(holds, "native_sms_active_enrolments"), String(activeEnrolments));
  }
  assert.deepEqual(nativeSmsOverlapHolds({
    contactTags: [], now: NOW, attestation: { ...GOOD, activeEnrolments: 0 } }), []);
});

test("an unread active-enrolment count holds", () => {
  const holds = nativeSmsOverlapHolds({
    contactTags: [], now: NOW,
    attestation: { ...GOOD, activeEnrolments: undefined as unknown as number } });
  assert.ok(has(holds, "native_sms_active_enrolments"));
});

test("a changed published-workflow count invalidates the attestation", () => {
  const holds = nativeSmsOverlapHolds({
    contactTags: [], attestation: GOOD, now: NOW, observedPublishedWorkflowCount: 17,
  });
  assert.ok(has(holds, "native_sms_workflow_inventory_changed"));
  assert.deepEqual(nativeSmsOverlapHolds({
    contactTags: [], attestation: GOOD, now: NOW, observedPublishedWorkflowCount: 16,
  }), []);
});

test("an unread workflow count does not clear and does not invent a change", () => {
  assert.deepEqual(nativeSmsOverlapHolds({
    contactTags: [], attestation: GOOD, now: NOW, observedPublishedWorkflowCount: null,
  }), []);
});

test("the gate tag and a missing attestation both hold at once", () => {
  const holds = nativeSmsOverlapHolds({
    contactTags: [NATIVE_SMS_GATE_TAG], attestation: null, now: NOW,
  });
  assert.ok(has(holds, "native_sms_enrolment_unattested"));
  assert.ok(has(holds, "native_sms_gate_tag_present"));
});

// --------------------------------------------------- wired into the evaluator

const ISSUED = "2026-11-03";
const SOURCE = {
  invoiceStatus: "past_due", totalCents: 16000, balanceCents: 16000,
  issuedDate: ISSUED, dueDate: "2026-11-10",
  clientId: "cli-1", clientTags: ["Maintenance"], lineItemNames: ["Lawn service"],
};
const CANDIDATE = { jobberInvoiceId: "inv-1", invoiceNumber: "7226", clientName: "A",
  jobberClientId: "cli-1", email: "a@example.com", phone: "+16025550100" };
const LINKED = {
  invoiceId: "inv-1", invoiceNumber: "7226", invoiceStatus: "past_due",
  issuedDate: ISSUED, dueDate: "2026-11-10", totalCents: 16000, balanceCents: 16000,
  clientId: "cli-1", complete: true, reason: null,
  jobs: [{ jobId: "j1", jobNumber: 1, jobStatus: "complete", archived: false,
    title: "Monthly service", instructions: "Mow and edge the front lawn",
    jobNoteMessages: ["Mowed and edged, all good"], notesTotal: 1, notesRead: 1,
    foreignNotes: 0, notesComplete: true, notesReason: null }],
};

const evaluate = (tags: readonly string[], extra: Record<string, unknown>) =>
  evaluateReminders({
    candidates: [CANDIDATE],
    readers: {
      readInvoice: async () => SOURCE,
      matchContacts: async () => [{ id: "c1", tags, dnd: false,
        phone: "+16025550100", email: "a@example.com" }],
      cardsForContact: async () => [],
      linkedJobText: async () => LINKED,
      sendHistory: async () => ({ complete: true, sends: [] }),
    } as any,
    now: NOW, verifiedExclusions: ["cli-x", "cli-y"], ignoreWindow: true,
    milestoneChannels: () => ["email"],
    jobberOnlyDay15Email: true, feeClaimFreeDay15: true, channelBlindMilestones: [15],
    priorSendIgnoresPreIssueMessages: true,
    ...extra,
  });

test("omitting the option leaves every earlier caller's behaviour untouched", async () => {
  const plan = await evaluate([NATIVE_SMS_GATE_TAG], {});
  assert.deepEqual(plan.rows[0].holds, []);
  assert.equal(plan.rows[0].decision, "eligible");
});

test("with the option and a good attestation, a clean contact stays eligible", async () => {
  const plan = await evaluate(["irrigation"], { nativeSmsOverlapAttestation: GOOD });
  assert.deepEqual(plan.rows[0].holds, []);
  assert.equal(plan.rows[0].decision, "eligible");
});

test("with the option, the gate tag holds the row", async () => {
  const plan = await evaluate([NATIVE_SMS_GATE_TAG], { nativeSmsOverlapAttestation: GOOD });
  assert.ok(has(plan.rows[0].holds, "native_sms_gate_tag_present"), plan.rows[0].holds.join(" | "));
  assert.equal(plan.rows[0].decision, "held");
  assert.equal(plan.sendsAttempted, 0);
});

test("passing the option with a null attestation holds every row on purpose", async () => {
  const plan = await evaluate(["irrigation"], { nativeSmsOverlapAttestation: null });
  assert.ok(has(plan.rows[0].holds, "native_sms_enrolment_unattested"), plan.rows[0].holds.join(" | "));
  assert.equal(plan.rows[0].decision, "held");
});

test("a changed workflow inventory holds the row even with clean tags", async () => {
  const plan = await evaluate(["irrigation"], {
    nativeSmsOverlapAttestation: GOOD, nativeSmsObservedPublishedWorkflowCount: 17 });
  assert.ok(has(plan.rows[0].holds, "native_sms_workflow_inventory_changed"), plan.rows[0].holds.join(" | "));
});
