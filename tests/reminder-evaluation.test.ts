import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  evaluateReminders, summarizeReminderEvaluation, withinArizonaWindow, phoenixParts,
  type ReminderCandidate, type ReminderEvaluationReaders, type SourceInvoice,
} from "../lib/reminder-evaluation";
import { resolveServiceType, serviceTypeIsConfirmed } from "../lib/reminder-service-type";

// Phoenix is UTC-7 all year. 09:05 Phoenix is 16:05 UTC.
const IN_WINDOW = new Date("2026-11-13T16:05:00Z");
const OUT_OF_WINDOW = new Date("2026-11-13T16:30:00Z");
const TWO_EXCLUSIONS = ["synthetic-client-excluded-a", "synthetic-client-excluded-b"];

// All identities, amounts and labels below are synthetic.
function candidate(patch: Partial<ReminderCandidate> = {}): ReminderCandidate {
  return {
    jobberInvoiceId: "synthetic-invoice", invoiceNumber: "9001", clientName: "Synthetic Client",
    jobberClientId: "synthetic-client", email: "synthetic@example.test", phone: "4805550100", ...patch,
  };
}
function sourceInvoice(patch: Partial<SourceInvoice> = {}): SourceInvoice {
  return {
    invoiceStatus: "past_due", totalCents: 13700, balanceCents: 13700,
    issuedDate: "2026-10-27T16:04:57Z", dueDate: "2026-11-03T07:00:00Z",
    clientId: "synthetic-client",
    clientTags: ["Irrigation Promotion"], lineItemNames: ["Irrigation Diagnostic Promotion"], ...patch,
  };
}
function readers(patch: Partial<ReminderEvaluationReaders> = {}): ReminderEvaluationReaders {
  return {
    readInvoice: async () => sourceInvoice(),
    matchContacts: async () => [{ id: "synthetic-contact", tags: ["irrigation"], dnd: false, phone: "+14805550100", email: "synthetic@example.test" }],
    cardsForContact: async () => [{ id: "synthetic-card", stage: "invoice overdue", status: "open" }],
    ...patch,
  };
}
const run = (opts: Partial<Parameters<typeof evaluateReminders>[0]> = {}) => evaluateReminders({
  candidates: [candidate()], readers: readers(), now: IN_WINDOW, verifiedExclusions: TWO_EXCLUSIONS, ...opts,
});

// --- The 09:00 America/Phoenix window, and no catch-up ---

test("the window is 09:00 to 09:15 America/Phoenix inclusive of neither end minute 15", () => {
  const at = (iso: string) => withinArizonaWindow(new Date(iso));
  assert.equal(at("2026-11-13T15:59:59Z"), false, "08:59:59 Phoenix");
  assert.equal(at("2026-11-13T16:00:00Z"), true, "09:00 Phoenix");
  assert.equal(at("2026-11-13T16:14:59Z"), true, "09:14:59 Phoenix");
  assert.equal(at("2026-11-13T16:15:00Z"), false, "09:15 Phoenix");
  assert.equal(at("2026-11-13T16:30:00Z"), false, "09:30 Phoenix");
});

test("Phoenix does not shift for daylight saving, so the window holds all year", () => {
  // 16:00Z is 09:00 in Phoenix in both January and July.
  for (const iso of ["2026-01-15T16:00:00Z", "2026-07-15T16:00:00Z"]) {
    assert.equal(withinArizonaWindow(new Date(iso)), true, iso);
    assert.equal(phoenixParts(new Date(iso))?.hour, 9);
  }
});

test("an invalid clock is never inside the window", () => {
  assert.equal(withinArizonaWindow(new Date("not a date")), false);
  assert.equal(phoenixParts(new Date("not a date")), null);
});

test("outside the window nothing is evaluated and no catch-up is attempted", async () => {
  const plan = await run({ now: OUT_OF_WINDOW, readers: readers({
    readInvoice: async () => { throw new Error("must not read outside the window"); } }) });
  assert.equal(plan.state, "outside_window");
  assert.deepEqual(plan.rows, []);
  assert.ok(plan.notes.includes("outside_arizona_window_no_catch_up"));
  assert.equal(plan.sendsAttempted, 0);
});

test("a milestone whose day has passed is reported for a person, never replayed", async () => {
  // Due 2026-10-01: day 10 and day 15 are long past for an irrigation ladder.
  const plan = await run({ readers: readers({
    readInvoice: async () => sourceInvoice({ issuedDate: "2026-09-24T12:00:00Z", dueDate: "2026-10-01T07:00:00Z" }) }) });
  const row = plan.rows[0];
  assert.equal(row.decision, "not_due", "not eligible and not a hold");
  assert.ok(row.holds.some(hold => hold.includes("never replayed")), row.holds.join("; "));
  assert.equal(plan.rows.filter(r => r.decision === "eligible").length, 0);
});

// --- Service type: unknown or conflicting means hold, never maintenance ---

test("an absent GoHighLevel tag is silence, not an assertion of maintenance", () => {
  const resolution = resolveServiceType({
    jobberClientTags: ["Irrigation Promotion"],
    jobberLineItemNames: ["Irrigation Diagnostic Promotion"],
    ghlContactTags: [],
  });
  assert.equal(resolution.category, "irrigation", "Jobber decides");
  assert.equal(resolution.source, "jobber_only");
  assert.equal(serviceTypeIsConfirmed(resolution), false, "uncorroborated, so it still holds");
});

test("no Jobber signal resolves to unknown even when GoHighLevel claims irrigation", () => {
  const resolution = resolveServiceType({ jobberClientTags: [], jobberLineItemNames: [], ghlContactTags: ["irrigation"] });
  assert.equal(resolution.category, null);
  assert.equal(resolution.source, "unknown");
  assert.equal(serviceTypeIsConfirmed(resolution), false);
});

test("Jobber and GoHighLevel disagreeing is a conflict, not a tiebreak", () => {
  const resolution = resolveServiceType({
    jobberClientTags: ["Routine Maintenance"], jobberLineItemNames: ["Routine Maintenance"], ghlContactTags: ["irrigation"] });
  assert.equal(resolution.category, null);
  assert.equal(resolution.source, "conflict");
  assert.match(resolution.detail, /GoHighLevel contact is tagged irrigation/);
});

test("Jobber asserting both services at once is a conflict", () => {
  const resolution = resolveServiceType({
    jobberClientTags: ["Irrigation Promotion", "Routine Maintenance"], jobberLineItemNames: [], ghlContactTags: [] });
  assert.equal(resolution.source, "conflict");
  assert.equal(resolution.category, null);
});

test("an unreadable signal is not the same as an empty one", () => {
  assert.equal(resolveServiceType({ jobberClientTags: null, jobberLineItemNames: null, ghlContactTags: null }).source, "unknown");
});

test("agreement on irrigation is the only confirmed state", () => {
  const resolution = resolveServiceType({
    jobberClientTags: ["Irrigation Promotion"], jobberLineItemNames: ["Irrigation Diagnostic Promotion"], ghlContactTags: ["irrigation", "wbnk"] });
  assert.equal(resolution.category, "irrigation");
  assert.equal(resolution.source, "agreed");
  assert.equal(serviceTypeIsConfirmed(resolution), true);
});

test("evidence is labels only, carrying no contact details", () => {
  const resolution = resolveServiceType({
    jobberClientTags: ["Irrigation Promotion"], jobberLineItemNames: ["Irrigation Diagnostic Promotion"], ghlContactTags: ["irrigation"] });
  assert.deepEqual(resolution.evidence.jobber, ["Irrigation Promotion", "Irrigation Diagnostic Promotion"]);
  assert.deepEqual(resolution.evidence.ghl, ["irrigation"]);
});

test("an unresolved service type holds the invoice and chooses no ladder", async () => {
  const plan = await run({ readers: readers({
    readInvoice: async () => sourceInvoice({ clientTags: [], lineItemNames: ["Some Other Work"] }),
    matchContacts: async () => [{ id: "synthetic-contact", tags: [], dnd: false, phone: null, email: null }] }) });
  const row = plan.rows[0];
  assert.equal(row.decision, "held");
  assert.equal(row.category, null);
  assert.equal(row.milestoneDay, null, "no ladder was consulted");
  assert.ok(row.holds.some(hold => hold.startsWith("service_type_unknown")), row.holds.join("; "));
});

// --- Ambiguous destinations are held, never merged or guessed ---

test("two exactly matching contacts hold the invoice and nothing is merged", async () => {
  const plan = await run({ readers: readers({ matchContacts: async () => [
    { id: "synthetic-contact-a", tags: ["irrigation"], dnd: false, phone: "+14805550100", email: "synthetic@example.test" },
    { id: "synthetic-contact-b", tags: [], dnd: false, phone: "+14805550100", email: "synthetic@example.test" },
  ] }) });
  const row = plan.rows[0];
  assert.equal(row.decision, "held");
  assert.ok(row.holds.some(hold => hold.includes("ambiguous_destination_contacts: 2 exact matches, not merged")), row.holds.join("; "));
  // With no single contact there is no tag to corroborate with, so the type is
  // Jobber-only and therefore unconfirmed: still held, and no ladder chosen.
  assert.equal(row.categorySource, "jobber_only");
  assert.equal(row.milestoneDay, null, "no ladder was consulted");
  assert.ok(row.holds.some(hold => hold.startsWith("service_type_jobber_only")), row.holds.join("; "));
});

for (const [name, cards] of Object.entries({
  "no card": [],
  "two cards": [{ id: "a", stage: "invoice overdue", status: "open" }, { id: "b", stage: "invoice overdue", status: "open" }],
  "wrong stage": [{ id: "a", stage: "invoice sent", status: "open" }],
  "won card": [{ id: "a", stage: "closed out", status: "won" }],
})) {
  test(`${name} holds the invoice`, async () => {
    const plan = await run({ readers: readers({ cardsForContact: async () => cards as never }) });
    assert.equal(plan.rows[0].decision, "held");
    assert.ok(plan.rows[0].holds.length > 0);
  });
}

test("an opted-out destination holds the invoice", async () => {
  const plan = await run({ readers: readers({ matchContacts: async () => [
    { id: "synthetic-contact", tags: ["irrigation"], dnd: true, phone: "+14805550100", email: "synthetic@example.test" }] }) });
  assert.ok(plan.rows[0].holds.includes("destination_contact_opted_out"));
  assert.equal(plan.rows[0].decision, "held");
});

test("several unpaid invoices for one owner hold every one of them", async () => {
  const plan = await run({ candidates: [
    candidate({ jobberInvoiceId: "synthetic-a", invoiceNumber: "9001" }),
    candidate({ jobberInvoiceId: "synthetic-b", invoiceNumber: "9002" }),
  ], readers: readers({ readInvoice: async (id) => sourceInvoice({ clientId: "synthetic-client" }) }) });
  assert.equal(plan.rows.length, 2);
  for (const row of plan.rows) {
    assert.equal(row.decision, "held");
    assert.ok(row.holds.some(hold => hold.startsWith("owner_has_multiple_unpaid_invoices: 2")), row.holds.join("; "));
  }
});

// --- "No longer owes money" is reported separately from "not eligible" ---

for (const patch of [
  { invoiceStatus: "paid", balanceCents: 0 },
  { invoiceStatus: "void", balanceCents: 0 },
  { invoiceStatus: "bad_debt", balanceCents: 0 },
  { invoiceStatus: "past_due", balanceCents: 0 },
]) {
  test(`${patch.invoiceStatus} with a ${patch.balanceCents} balance reports no_longer_owes, not held`, async () => {
    const plan = await run({ readers: readers({ readInvoice: async () => sourceInvoice(patch) }) });
    assert.equal(plan.rows[0].decision, "no_longer_owes");
    const summary = summarizeReminderEvaluation(plan);
    assert.equal(summary.noLongerOwes, 1);
    assert.equal(summary.held, 0, "a settled invoice is not a hold");
    assert.equal(summary.eligible, 0);
  });
}

test("an unreadable source invoice holds rather than falling back to the cache", async () => {
  const plan = await run({ readers: readers({ readInvoice: async () => null }) });
  assert.deepEqual(plan.rows[0].holds, ["source_invoice_unreadable"]);
  assert.equal(plan.rows[0].decision, "held");
});

test("a changed or unknown owner on the fresh read holds the invoice", async () => {
  const plan = await run({ readers: readers({ readInvoice: async () => sourceInvoice({ clientId: "someone-else" }) }) });
  assert.ok(plan.rows[0].holds.includes("source_owner_unknown_or_changed"));
});

// --- The two verified exclusions gate everything reported as sendable ---

for (const [name, exclusions] of Object.entries({
  "none": null, "empty": [], "one": ["only-one"],
  "three": ["a", "b", "c"], "two that are the same": ["same", "same"],
})) {
  test(`${name} exclusion ids leaves them unverified and nothing eligible`, async () => {
    const plan = await run({ verifiedExclusions: exclusions as never });
    assert.equal(plan.exclusionsVerified, false);
    assert.equal(summarizeReminderEvaluation(plan).eligible, 0);
    assert.ok(plan.rows[0].holds.includes("exclusions_unverified"), plan.rows[0].holds.join("; "));
    assert.ok(plan.notes.some(note => note.startsWith("exclusions_unverified")));
  });
}

test("exactly two distinct exclusion ids are required, and then day 10 can be eligible", async () => {
  const plan = await run();
  assert.equal(plan.exclusionsVerified, true);
  const row = plan.rows[0];
  assert.equal(row.decision, "eligible", row.holds.join("; "));
  assert.equal(row.milestoneDay, 10);
  assert.equal(row.audience, "homeowner");
  assert.equal(row.category, "irrigation");
  assert.equal(row.categorySource, "agreed");
  assert.deepEqual(row.holds, []);
  assert.equal(plan.sendsAttempted, 0, "eligible still means nothing was sent");
});

test("a milestone that asserts a fee or policy is held until that evidence exists", async () => {
  // Due 2026-10-29 makes today day 15, whose copy asserts the 3% fee.
  const plan = await run({ readers: readers({
    readInvoice: async () => sourceInvoice({ issuedDate: "2026-10-22T12:00:00Z", dueDate: "2026-10-29T07:00:00Z" }) }) });
  const row = plan.rows[0];
  assert.equal(row.milestoneDay, 15);
  assert.equal(row.decision, "held");
  assert.ok(row.holds.some(hold => hold.startsWith("milestone_requires_unverified_facts: three_percent_fee_applied")), row.holds.join("; "));
});

// --- There is no send path and no GoHighLevel write path to disable ---

test("the evaluation module imports no sender and no GHL write", () => {
  const module = readFileSync(new URL("../lib/reminder-evaluation.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const term of ["sendSms", "sendEmail", "notification-sender", "notification-dispatch", "leadconnectorhq", "fetch(", "ghlFetch"]) {
    assert.equal(module.includes(term), false, `${term} must not appear in the evaluator`);
  }
});

test("the runner script reports a send count that is structurally always zero", () => {
  const script = readFileSync(new URL("../scripts/reminder-evaluate-cron.ts", import.meta.url), "utf8");
  for (const term of ["notification-sender", "notification-dispatch", "sendSms", "sendEmail", "setOpportunityDueDate", "createContact", "syncGhlInvoicePipeline"]) {
    assert.equal(script.includes(term), false, `${term} must not be reachable from the runner`);
  }
  const plan = { mode: "evaluate" as const, state: "completed" as const, phoenixDate: "2026-11-13",
    exclusionsVerified: true, sendsAttempted: 0 as const, rows: [], notes: [] };
  assert.equal(summarizeReminderEvaluation(plan).sendsAttempted, 0);
});

test("the readers module issues no provider mutation", () => {
  const module = readFileSync(new URL("../lib/reminder-evaluation-readers.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.equal(module.includes("mutation"), false);
  for (const writer of ["createContact", "setOpportunityDueDate", "addTag", "updateOpportunity"]) {
    assert.equal(module.includes(writer), false, `${writer} must not be imported`);
  }
});

test("the store writes only the two evaluation tables", () => {
  const module = readFileSync(new URL("../lib/reminder-evaluation-store.ts", import.meta.url), "utf8");
  for (const table of ["invoiceRecord", "customer", "syncRun", "jobberAuth", "notificationEvent"]) {
    assert.equal(module.includes(table), false, `${table} must not be written by the evaluation store`);
  }
  assert.ok(module.includes("reminderEvaluationRun.create"));
});

test("every run is recorded, including one that evaluated nothing", async () => {
  const plan = await run({ now: OUT_OF_WINDOW });
  const summary = summarizeReminderEvaluation(plan);
  assert.equal(summary.state, "outside_window");
  assert.equal(summary.candidates, 0);
  assert.equal(summary.phoenixDate, "2026-11-13", "the date is still recorded so an absent row means it did not run");
});
