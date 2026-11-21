import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PROPOSAL, eventKey, immutableEvent, planNotification, planBatch } from "../lib/notification-gate.ts";
import { addInvoiceCalendarDays, invoiceReminderClock, invoiceCalendarDate } from "../lib/invoice-reminder-clock.ts";

const NOW = new Date("2026-11-09T16:00:00.000Z"); // 09:00 Phoenix.
const required = { 10: [], 15: ["three_percent_fee_applied"], 20: ["recurring_late_fee_policy"],
  21: [], 25: ["recurring_late_fee_policy"], 30: ["service_suspended", "collections_after_day_35_policy"] };
function fixture({ day = 10, category = null, channel = "sms", now = NOW } = {}) {
  const audience = day === 21 ? "internal" : "homeowner";
  const event = { accountId: "synthetic-account", invoiceId: "synthetic-invoice", dayPastDue: day, audience,
    sourceRevision: "source-v1", ownerRevision: "owner-v1", ownerId: "synthetic-owner",
    homeownerContactId: "homeowner-contact", issuedDate: "2026-09-01",
    dueDate: addInvoiceCalendarDays("2026-11-09", -day), balanceMinor: 12000, currency: "USD", category,
    recipientId: audience === "internal" ? "approved-internal-user" : "synthetic-owner",
    contactId: audience === "internal" ? "internal-contact" : "homeowner-contact",
    channel, destination: channel === "sms" ? "+12025550123" : "synthetic@example.invalid",
    templateId: `synthetic-${audience}-${day}`, templateVersion: "v1", bodyDigest: "synthetic-body-digest",
    claimedFacts: [...(required[day] ?? [])] };
  function evidence(offset) {
    const proof = { observedAt: new Date(now.getTime() - offset).toISOString(),
      expiresAt: new Date(now.getTime() + 30000).toISOString(), sourceRef: "synthetic:test-only" };
    return {
      source: { ...proof, accountId: event.accountId, invoiceId: event.invoiceId, revision: event.sourceRevision,
        available: true, complete: true, status: "open", balanceMinor: event.balanceMinor, currency: event.currency,
        ownerId: event.ownerId, issuedDate: event.issuedDate, dueDate: event.dueDate, category, categoryVerified: category !== null },
      owner: { ...proof, accountId: event.accountId, invoiceId: event.invoiceId, revision: event.ownerRevision,
        ownerId: event.ownerId, homeownerContactId: event.homeownerContactId, exactSourceIdentity: true, complete: true },
      recipient: { ...proof, accountId: event.accountId, recipientId: event.recipientId, contactId: event.contactId,
        audience, channel, destination: event.destination, exactSourceIdentity: true, destinationVerified: true,
        internalRecipientApproved: audience === "internal" },
      dnd: { ...proof, accountId: event.accountId, contactId: event.contactId, channel, destination: event.destination, state: "allowed" },
      template: { ...proof, approved: true, accountId: event.accountId, id: event.templateId, version: event.templateVersion,
        bodyDigest: event.bodyDigest, audience, dayPastDue: day, channel, claimedFacts: [...event.claimedFacts] },
      channelAuthorization: { ...proof, approved: true, eventKey: eventKey(event), recipientId: event.recipientId,
        channel, destination: event.destination },
      facts: event.claimedFacts.map(fact => ({ ...proof, fact, accountId: event.accountId, invoiceId: event.invoiceId,
        sourceRevision: event.sourceRevision, value: true })),
      attempts: { ...proof, accountId: event.accountId, historyComplete: true, records: [] },
    };
  }
  return { event, preflight: evidence(20000), final: evidence(1000) };
}
const plan = (request, now = NOW) => planNotification(request, now);
function held(request, reason, now = NOW) {
  const result = plan(request, now);
  assert.equal(result.designStatus, "hold"); assert.equal(result.sendCapability, false);
  assert.ok(result.reasons.includes(reason), JSON.stringify(result.reasons));
}

test("copied clock retains exact supplied provenance SHA256", () => {
  assert.equal(createHash("sha256").update(readFileSync(new URL("../lib/invoice-reminder-clock.ts", import.meta.url))).digest("hex"),
    "24de51250a21d208e3a51cdbccc25939412afbaa16aea7fe4ce215f2c15585e7");
});
test("valid phone-only Day10 can plan with unresolved category; capability stays false", () => {
  const result = plan(fixture()); assert.equal(result.designStatus, "eligible_in_proposal");
  assert.equal(result.sendCapability, false); assert.equal(result.timingApproved, false);
  assert.equal(PROPOSAL.toleranceMinutes, 15); assert.equal(PROPOSAL.timingApproved, false);
});
test("pure, deterministic and deeply frozen output; immutable event does not alias facts", () => {
  const input = fixture(), before = JSON.stringify(input), event = immutableEvent(input.event);
  input.event.claimedFacts.push("service_suspended"); assert.deepEqual(event.claimedFacts, []);
  assert.ok(Object.isFrozen(event)); assert.ok(Object.isFrozen(event.claimedFacts));
  const freshInput = JSON.parse(before), result = plan(freshInput);
  assert.deepEqual(result, plan(freshInput)); assert.equal(JSON.stringify(freshInput), before);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.reasons));
});
for (const day of [10, 15, 21]) for (const category of [null, "maintenance", "irrigation"])
  test(`common day ${day} works for category ${category} with its own facts and audience`, () => {
    assert.equal(plan(fixture({ day, category })).designStatus, "eligible_in_proposal");
  });
for (const day of [20, 25, 30]) {
  test(`maintenance-only day ${day} needs category verification`, () => {
    assert.equal(plan(fixture({ day, category: "maintenance" })).designStatus, "eligible_in_proposal");
    held(fixture({ day }), "verified_maintenance_category_required");
    held(fixture({ day, category: "irrigation" }), "verified_maintenance_category_required");
    const request = fixture({ day, category: "maintenance" }); request.final.source.categoryVerified = false;
    held(request, "final:verified_maintenance_category_required");
  });
}
test("Day21 uses approved internal recipient; homeowner and arbitrary internal recipient fail", () => {
  const request = fixture({ day: 21 }); request.final.recipient.internalRecipientApproved = false;
  held(request, "final:recipient_not_exact_verified_approved");
  const homeowner = fixture({ day: 21 }); homeowner.event.audience = "homeowner";
  held(homeowner, "unsupported_milestone_or_audience");
});
test("full or partial payment between snapshots stops event, independent of any GHL stage", () => {
  for (const remaining of [0, 10000]) {
    const request = fixture(); request.final.source.balanceMinor = remaining; request.final.source.revision = "paid-new-revision";
    held(request, "final:source_event_drift");
    if (remaining === 0) held(request, "final:not_open_positive_balance");
  }
});
for (const field of ["available", "complete"])
  test(`source ${field} false stops event without waiting for Paid stage`, () => {
    const request = fixture(); request.final.source[field] = false;
    held(request, "final:source_unavailable_or_incomplete");
  });
for (const status of ["paid", "void", "unknown"])
  test(`source status ${status} blocks even with positive amount`, () => {
    const request = fixture(); request.final.source.status = status; held(request, "final:not_open_positive_balance");
  });
for (const [field, value] of [["dueDate", "2026-10-29"], ["issuedDate", "2026-09-02"], ["ownerId", "other-owner"],
  ["revision", "source-v2"], ["invoiceId", "different-invoice"], ["accountId", "different-account"]])
  test(`final changed source ${field} holds pinned event`, () => {
    const request = fixture(); request.final.source[field] = value; held(request, "final:source_event_drift");
  });
for (const [field, value] of [["ownerId", "other-owner"], ["homeownerContactId", "other-contact"], ["revision", "owner-v2"],
  ["exactSourceIdentity", false], ["complete", false]])
  test(`final owner ${field} must remain exact`, () => {
    const request = fixture(); request.final.owner[field] = value; held(request, "final:owner_identity_not_exact_or_changed");
  });
for (const state of ["blocked", "unknown"])
  test(`DND ${state} blocks even when first snapshot allowed`, () => {
    const request = fixture(); request.final.dnd.state = state; held(request, "final:current_dnd_not_allowed");
  });
for (const field of ["source", "owner", "recipient", "dnd", "template", "channelAuthorization", "attempts"]) {
  test(`${field} expiry, stale/future proof and unchanged preflight cannot qualify`, () => {
    const expired = fixture(); expired.final[field].expiresAt = NOW.toISOString(); held(expired, `final:${field}_proof_not_fresh`);
    const stale = fixture(); stale.final[field].observedAt = new Date(NOW.getTime() - (field === "owner" ? 300000 : 60000)).toISOString(); held(stale, `final:${field}_proof_not_fresh`);
    const future = fixture(); future.final[field].observedAt = new Date(NOW.getTime() + 1).toISOString(); held(future, `final:${field}_proof_not_fresh`);
    const reused = fixture(); reused.final[field].observedAt = reused.preflight[field].observedAt;
    if (field === "owner") { reused.final.owner = structuredClone(reused.preflight.owner); assert.equal(plan(reused).designStatus, "eligible_in_proposal"); }
    else held(reused, `final:${field}_not_newer_than_preflight`);
  });
}
for (const [time, allowed] of [["15:59:59.999", false], ["16:00:00.000", true], ["16:14:59.999", true],
  ["16:15:00.000", false], ["23:00:00.000", false]])
  test(`proposed Arizona window boundary ${time} UTC, no catch-up`, () => {
    const now = new Date(`2026-11-09T${time}Z`), request = fixture({ now });
    if (allowed) assert.equal(plan(request, now).designStatus, "eligible_in_proposal");
    else held(request, "outside_proposed_window_no_catch_up", now);
  });
test("no older-milestone replay or future sends", () => {
  for (const [date, reason] of [["2026-11-10", "past_milestone_no_replay"], ["2026-11-08", "future_milestone"]]) {
    const now = new Date(`${date}T16:00:00Z`); held(fixture({ now }), reason, now);
  }
});
test("exact Arizona date boundaries and UTC crossover retain source dates", () => {
  assert.equal(invoiceCalendarDate("2026-11-09T06:59:59Z"), "2026-11-08");
  assert.equal(invoiceCalendarDate("2026-11-09T07:00:00Z"), "2026-11-09");
  assert.equal(invoiceCalendarDate("2026-11-09"), "2026-11-09");
  assert.equal(invoiceCalendarDate("2026-11-09T00:00:00Z"), "2026-11-08");
  assert.equal(invoiceCalendarDate("2026-02-30"), null);
  assert.equal(invoiceCalendarDate("2026-11-09T09:00:00"), null);
  for (const [stamp, expected] of [["2026-11-09T06:59:59.999Z", 9], ["2026-11-09T07:00:00Z", 10],
    ["2026-11-10T06:59:59.999Z", 10], ["2026-11-10T07:00:00Z", 11]])
    assert.equal(invoiceReminderClock("2026-09-01", "2026-10-30", new Date(stamp)).daysPastDue, expected);
  assert.equal(invoiceReminderClock("2026-01-01", "2026-03-07", new Date("2026-03-08T07:00:00Z")).daysPastDue, 1);
  assert.equal(invoiceReminderClock("2026-01-01", "2026-11-01", new Date("2026-11-02T07:00:00Z")).daysPastDue, 1);
});
for (const day of [15, 20, 25, 30])
  test(`Day${day} requires every claimed fact true, current, unique and invoice-bound`, () => {
    for (const mutation of ["false", "expired", "wrong-invoice", "wrong-revision", "missing", "duplicate"]) {
      const request = fixture({ day, category: "maintenance" }), fact = request.event.claimedFacts[0];
      if (mutation === "false") request.final.facts[0].value = false;
      if (mutation === "expired") request.final.facts[0].expiresAt = NOW.toISOString();
      if (mutation === "wrong-invoice") request.final.facts[0].invoiceId = "other";
      if (mutation === "wrong-revision") request.final.facts[0].sourceRevision = "other";
      if (mutation === "missing") request.final.facts.shift();
      if (mutation === "duplicate") request.final.facts.push({ ...request.final.facts[0] });
      held(request, `final:fact_not_proven:${fact}`);
    }
  });
test("template cannot omit required claim, add unproven claim, or change approval/version/body", () => {
  const missing = fixture({ day: 15 }); missing.event.claimedFacts = []; held(missing, "required_template_fact_missing");
  const extra = fixture(); extra.event.claimedFacts = ["service_suspended"];
  held(extra, "final:fact_not_proven:service_suspended");
  for (const [field, value] of [["approved", false], ["version", "v2"], ["bodyDigest", "different"], ["audience", "internal"]]) {
    const request = fixture(); request.final.template[field] = value; held(request, "final:template_not_exact_approved");
  }
});
test("email-only homeowner fallback is held without exact explicit channel authorization", () => {
  const email = fixture({ channel: "email" }); email.final.channelAuthorization.approved = false;
  held(email, "final:channel_not_explicitly_authorized");
  email.final.channelAuthorization.approved = true;
  assert.equal(plan(email).designStatus, "eligible_in_proposal");
  email.final.channelAuthorization.channel = "sms"; held(email, "final:channel_not_explicitly_authorized");
});
test("no phone digit guessing, destination swapping or partial identity matching", () => {
  const phone = fixture(); phone.event.destination = "2025550123"; held(phone, "invalid_exact_phone");
  const swap = fixture(); swap.final.recipient.destination = "+12025550124"; held(swap, "final:recipient_not_exact_verified_approved");
  const fuzzy = fixture(); fuzzy.final.recipient.exactSourceIdentity = false; held(fuzzy, "final:recipient_not_exact_verified_approved");
});
test("malformed +1 NANP area/exchange/length rejected without normalizing digits", () => {
  for (const destination of ["+11225550123", "+10225550123", "+12021550123", "+12020550123", "+1202555012", "+120255501234"]) {
    const request = fixture(); request.event.destination = destination; held(request, "invalid_exact_phone");
  }
});
test("malformed proof date is not normalized, and fact proof must be rechecked", () => {
  const malformed = fixture(); malformed.final.source.observedAt = "2026-02-30T16:00:00Z";
  held(malformed, "final:source_proof_not_fresh");
  const reused = fixture({ day: 15 }); reused.final.facts[0].observedAt = reused.preflight.facts[0].observedAt;
  held(reused, "final:fact_not_rechecked:three_percent_fee_applied");
});
for (const state of ["reserved", "pending", "accepted", "delivered", "rejected", "unknown"])
  test(`prior attempt ${state} blocks transport retry and is not equated to delivery`, () => {
    const request = fixture(); request.final.attempts.records = [{ eventKey: eventKey(request.event), state }];
    held(request, `final:prior_attempt:${state}`); assert.deepEqual(plan(request).priorAttemptStates, [state]);
  });
test("preflight attempt cannot disappear in final; incomplete history fails closed", () => {
  const request = fixture(); request.preflight.attempts.records.push({ eventKey: eventKey(request.event), state: "unknown" });
  held(request, "preflight:prior_attempt:unknown");
  const incomplete = fixture(); incomplete.final.attempts.historyComplete = false;
  held(incomplete, "final:attempt_history_incomplete_or_wrong_account");
});
test("stable dedupe excludes changed channel, due date, owner, destination and template", () => {
  const request = fixture(), key = eventKey(request.event);
  for (const [field, value] of [["channel", "email"], ["destination", "different@example.invalid"], ["dueDate", "2026-10-29"],
    ["ownerId", "reassigned"], ["contactId", "reassigned"], ["templateId", "v2"], ["sourceRevision", "v2"]])
    assert.equal(eventKey({ ...request.event, [field]: value }), key);
  for (const [field, value] of [["accountId", "other"], ["invoiceId", "other"], ["dayPastDue", 15], ["audience", "internal"]])
    assert.notEqual(eventKey({ ...request.event, [field]: value }), key);
});
test("duplicates hold both without a silent winner, including channel variants", () => {
  for (const other of [fixture(), fixture({ channel: "email" })]) {
    const results = planBatch([fixture(), other], NOW);
    assert.equal(results.length, 2);
    for (const result of results) { assert.equal(result.designStatus, "hold"); assert.ok(result.reasons.includes("duplicate_event_in_batch")); }
  }
});
test("simultaneous distinct same-contact events hold all; independent contacts can plan", () => {
  const first = fixture(), second = fixture({ day: 15 });
  for (const result of planBatch([first, second], NOW)) {
    assert.equal(result.designStatus, "hold"); assert.ok(result.reasons.includes("simultaneous_contact_event_conflict"));
  }
  const internal = fixture({ day: 21 });
  assert.ok(planBatch([first, internal], NOW).every(result => result.designStatus === "eligible_in_proposal"));
});
test("invalid date and invalid now hold rather than use host clock", () => {
  const invalid = fixture(); invalid.event.dueDate = "not-a-date"; held(invalid, "invalid_invoice_dates");
  held(fixture(), "invalid_now", new Date(NaN));
});

// Identity population reads retain their real start time; immediate source checks do not.
test("unchanged identity capability may span two source reads without refreshing its timestamp", () => {
  const request = fixture();
  request.preflight.owner.observedAt = new Date(NOW.getTime() - 120000).toISOString();
  request.preflight.owner.expiresAt = new Date(NOW.getTime() + 180000).toISOString();
  request.final.owner = structuredClone(request.preflight.owner);
  assert.equal(plan(request).designStatus, "eligible_in_proposal");
  request.final.owner.expiresAt = new Date(NOW.getTime() + 240000).toISOString();
  held(request, "final:owner_not_newer_than_preflight");
});
test("carried identity expires at five minutes and cannot hide a changed exact source owner", () => {
  const request = fixture();
  request.preflight.owner.observedAt = new Date(NOW.getTime() - 300000).toISOString();
  request.final.owner = structuredClone(request.preflight.owner);
  held(request, "final:owner_proof_not_fresh");
  const changed = fixture(); changed.final.owner = structuredClone(changed.preflight.owner);
  changed.final.source.ownerId = "different-owner";
  held(changed, "final:source_event_drift");
});
