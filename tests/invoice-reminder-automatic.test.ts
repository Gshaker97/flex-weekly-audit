import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ORIGINAL_DAY10_SMS_BODY } from "../lib/notification-copy-policy";
import { customerSendWindowOpensAt, customerSendWindowState, evaluateAutomaticReminders, PAULA_DAY10_ALLOWLIST,
  phoenixClock, singleSenderConfirmed, type ReminderSourceInvoice } from "../lib/invoice-reminder-automatic";
import { inspectAutomaticReminderConfig } from "../lib/invoice-reminder-automatic-config";
import { readJobberInvoicesById, runAutomaticReminderPass, type AutomaticReminderDependencies } from "../lib/invoice-reminder-automatic-cron";
import { bootstrapDay10PilotRuntime } from "../lib/notification-day10-runtime";

const CONTACT = PAULA_DAY10_ALLOWLIST.contactId;
const FORBIDDEN = PAULA_DAY10_ALLOWLIST.forbiddenOpportunityId;
const paula = (patches: Partial<ReminderSourceInvoice> = {}): ReminderSourceInvoice => ({
  jobberInvoiceId: "jobber-7171", invoiceNumber: "7171", invoiceStatus: "past_due", balanceMinor: 13700,
  issuedDate: "2026-10-27", dueDate: "2026-11-03", jobberClientId: "jobber-paula", ...patches,
});
const ready = {
  mode: "paula-day10-attempt" as const,
  singleSenderConfirmed: true,
  token: { updatedAt: "2026-11-13T16:01:00.000Z", expiresAt: "2026-11-13T17:01:00.000Z" },
  config: { contactId: CONTACT, invoiceId: "jobber-7171", clientId: "jobber-paula", scheduledOn: "2026-11-13" },
  configBlockers: [] as string[],
};
const at = (iso: string, invoices: ReminderSourceInvoice[], patches: Partial<Parameters<typeof evaluateAutomaticReminders>[0]> = {}) =>
  evaluateAutomaticReminders({ now: new Date(iso), invoices, ...ready, ...patches });

test("official clock: due date is day zero, the next Phoenix date is overdue, and that day is not a text", () => {
  const onDue = at("2026-11-03T16:30:00.000Z", [paula({ invoiceStatus: "awaiting_payment" })]);
  assert.equal(onDue.paula?.daysPastDue, 0);
  assert.equal(onDue.paula?.action, "reconcile");
  assert.ok(onDue.paula?.reasons.includes("due_date_is_not_a_customer_text_day"));
  const earlyLabel = at("2026-11-03T16:30:00.000Z", [paula()]);
  assert.equal(earlyLabel.paula?.action, "hold");
  assert.ok(earlyLabel.paula?.reasons.includes("early_past_due_label"));
  assert.equal(earlyLabel.sends.length, 0);
  assert.equal(onDue.sends.length, 0);
  const overdue = at("2026-11-04T16:30:00.000Z", [paula()]);
  assert.equal(overdue.paula?.daysPastDue, 1);
  assert.ok(overdue.paula?.reasons.includes("overdue_day_is_not_a_customer_text_day"));
  assert.equal(overdue.sends.length, 0);
  assert.equal(phoenixClock(new Date("2026-11-13T16:05:00.000Z"))?.seconds, 9 * 3600 + 5 * 60);
  assert.equal(phoenixClock(new Date("2026-11-13T16:14:59.000Z"))?.seconds, 9 * 3600 + 14 * 60 + 59);
});

test("lateness follows due date for net-7 and net-15, not the issue date", () => {
  const net7 = at("2026-11-06T16:30:00.000Z", [paula()]);
  assert.equal(net7.paula?.daysPastDue, 3);
  assert.equal(net7.sends.length, 0);
  const net15 = paula({ invoiceNumber: "8000", jobberInvoiceId: "jobber-8000", issuedDate: "2026-11-01", dueDate: "2026-11-16" });
  const onDue = at("2026-11-16T16:30:00.000Z", [net15]);
  assert.equal(onDue.invoices[0].daysPastDue, 0);
  assert.equal(onDue.sends.length, 0);
  const next = at("2026-11-17T16:30:00.000Z", [net15]);
  assert.equal(next.invoices[0].daysPastDue, 1);
  assert.ok(next.invoices[0].reasons.includes("overdue_day_is_not_a_customer_text_day"));
  assert.equal(next.sends.length, 0);
});

test("the window is 09:00:00 through 09:14:59 Phoenix, and 09:15:00 is missed, not replayed", () => {
  // 09:00 itself is now inside the window; it used to be five minutes early.
  for (const iso of ["2026-11-13T16:00:00.000Z", "2026-11-13T16:05:00.000Z", "2026-11-13T16:14:59.000Z"]) {
    const result = at(iso, [paula()]);
    assert.equal(result.paula?.action, "eligible_send", iso);
    assert.equal(result.sends.length, 1);
    assert.equal(result.sends[0].invoiceNumber, "7171");
  }
  const missed = at("2026-11-13T16:15:00.000Z", [paula()]);
  assert.equal(missed.paula?.action, "reconcile");
  assert.ok(missed.paula?.reasons.includes("missed_window_no_catch_up"));
  assert.equal(missed.sends.length, 0);
  const beforeNine = at("2026-11-13T15:59:59.000Z", [paula()]);
  assert.equal(beforeNine.paula?.action, "reconcile");
  assert.ok(beforeNine.paula?.reasons.includes("waiting_for_window"));
  assert.equal(beforeNine.sends.length, 0);
  assert.equal(customerSendWindowState(9 * 3600 - 1), "before");
  assert.equal(customerSendWindowState(9 * 3600), "open");
  assert.equal(customerSendWindowState(9 * 3600 + 15 * 60 - 1), "open");
  assert.equal(customerSendWindowState(9 * 3600 + 15 * 60), "after");
  assert.equal(customerSendWindowOpensAt("2026-11-13"), "2026-11-13T16:00:00.000Z");
  assert.equal(customerSendWindowOpensAt("not-a-date"), null);
});

test("the daily schedule is 16:00 UTC all year, because Arizona never moves its clocks", () => {
  // The Railway cron for the 09:00 reminder run is "0 16 * * *". That is only
  // correct because Phoenix is UTC-7 in January and in July alike. If anyone
  // ever "fixes" this for daylight saving, this test fails first.
  for (const date of ["2027-01-15", "2027-03-15", "2027-07-15", "2027-11-15"]) {
    assert.equal(customerSendWindowOpensAt(date), `${date}T16:00:00.000Z`, date);
    const phoenix = new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/Phoenix", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).format(new Date(`${date}T16:00:00.000Z`));
    assert.equal(phoenix, "09:00", date);
  }
});

test("the window is DAILY: the same invoice qualifies on its own day 10, whatever the date", () => {
  // The old gate was pinned to 2026-11-13 and could never open again. Each of
  // these is a different invoice with a different due date, and each is
  // eligible on its own day 10 - months apart, including across a year end.
  for (const [issued, dueDate, dayTen] of [
    ["2026-10-27", "2026-11-03", "2026-11-13"],
    ["2026-12-13", "2026-12-20", "2026-12-30"],
    ["2026-12-21", "2026-12-28", "2027-01-07"],
    ["2027-05-25", "2027-06-01", "2027-06-11"]] as const) {
    const invoice = paula({ issuedDate: issued, dueDate });
    const result = evaluateAutomaticReminders({
      now: new Date(`${dayTen}T16:05:00.000Z`), invoices: [invoice], ...ready,
      // The token must itself be refreshed after 09:00 on the day in question,
      // so it moves with the date exactly as the real one would.
      token: { updatedAt: `${dayTen}T16:01:00.000Z`, expiresAt: `${dayTen}T17:01:00.000Z` },
      config: { ...ready.config, scheduledOn: dayTen },
    });
    assert.equal(result.paula?.daysPastDue, 10, dayTen);
    assert.equal(result.paula?.action, "eligible_send", dayTen);
    assert.equal(result.sends.length, 1, dayTen);
  }
  // And the frozen date is gone: the allowlist carries identity only.
  assert.equal("scheduledOn" in PAULA_DAY10_ALLOWLIST, false);
  assert.equal("waitUntil" in PAULA_DAY10_ALLOWLIST, false);
});

test("a config reviewed for another day cannot send today", () => {
  const stale = at("2026-11-13T16:05:00.000Z", [paula()], {
    config: { ...ready.config, scheduledOn: "2026-11-12" },
  });
  assert.equal(stale.sends.length, 0);
  assert.equal(stale.paula?.action, "hold");
  assert.ok(stale.paula?.reasons.includes("allowlist_schedule_mismatch"));
});

test("no send outside the 09:00-09:15 Phoenix window, and later Paula milestones stay gated off", () => {
  for (const iso of ["2026-11-13T15:30:00.000Z", "2026-11-13T18:00:00.000Z", "2026-11-14T16:10:00.000Z"]) {
    assert.equal(at(iso, [paula()]).sends.length, 0, iso);
  }
  const day15 = at("2026-11-18T16:10:00.000Z", [paula()]);
  assert.equal(day15.sends.length, 0);
  assert.ok(day15.paula?.reasons.includes("elapsed_no_replay"));
  assert.ok(day15.paula?.reasons.includes("milestone_gate_off"));
  assert.notEqual(day15.paula?.action, "eligible_send");
  const day21 = at("2026-11-24T16:10:00.000Z", [paula()]);
  assert.equal(day21.sends.length, 0);
  assert.ok(day21.paula?.reasons.includes("internal_prompt_gate_off"));
  assert.ok(day21.paula?.reasons.includes("milestone_gate_off"));
});

test("elapsed milestones and a mixed catch-up batch never become sends", () => {
  const old = paula({ invoiceNumber: "6972", jobberInvoiceId: "jobber-6972", dueDate: "2026-09-28", issuedDate: "2026-09-21" });
  const day27 = paula({ invoiceNumber: "7111", jobberInvoiceId: "jobber-7111", dueDate: "2026-10-16", issuedDate: "2026-10-09" });
  const otherDay10 = paula({ invoiceNumber: "7161", jobberInvoiceId: "jobber-7161", jobberClientId: "jobber-other" });
  const result = at("2026-11-13T16:10:00.000Z", [old, day27, otherDay10, paula({ invoiceStatus: "paid", balanceMinor: 0 })]);
  assert.equal(result.sends.length, 0);
  assert.ok(result.invoices.find(item => item.invoiceNumber === "6972")?.reasons.includes("elapsed_no_replay"));
  assert.ok(result.invoices.find(item => item.invoiceNumber === "7111")?.reasons.includes("elapsed_no_replay"));
  assert.equal(result.invoices.find(item => item.invoiceNumber === "7161")?.action, "hold");
  assert.ok(result.invoices.find(item => item.invoiceNumber === "7161")?.reasons.includes("not_on_allowlist"));
  assert.equal(result.invoices.find(item => item.invoiceNumber === "7171")?.action, "suppress");
  assert.equal(result.paula?.action, "suppress");
});

test("paid, zero-balance, and contradictory paid invoices are suppressed", () => {
  const now = "2026-11-13T16:10:00.000Z";
  const paid = at(now, [paula({ invoiceStatus: "paid", balanceMinor: 0 })]);
  assert.equal(paid.invoices[0].action, "suppress");
  assert.ok(paid.invoices[0].reasons.includes("paid_zero_balance_no_reminder"));
  const zero = at(now, [paula({ balanceMinor: 0 })]);
  assert.ok(zero.invoices[0].reasons.includes("source_not_open_positive_balance"));
  const conflict = at(now, [paula({ invoiceStatus: "paid", balanceMinor: 13700 })]);
  assert.ok(conflict.invoices[0].reasons.includes("contradictory_paid_positive_balance"));
  assert.equal(paid.sends.length + zero.sends.length + conflict.sends.length, 0);
});

test("an empty history and attempt mode do not confirm that GoHighLevel workflows are idle", () => {
  const now = "2026-11-13T16:10:00.000Z";
  const unconfirmed = at(now, [paula()], { singleSenderConfirmed: false, priorAttemptInvoiceIds: [] });
  assert.equal(unconfirmed.sends.length, 0);
  assert.equal(unconfirmed.paula?.action, "hold");
  assert.ok(unconfirmed.paula?.reasons.includes("duplicate_sender_unconfirmed"));
  const early = at("2026-11-13T16:04:00.000Z", [paula()], { singleSenderConfirmed: false });
  assert.equal(early.paula?.action, "hold");
  assert.equal(early.sends.length, 0);
  assert.equal(singleSenderConfirmed(undefined, undefined), false);
  assert.equal(singleSenderConfirmed("true", "synthetic-review"), false);
  assert.equal(singleSenderConfirmed("yes", "synthetic-review"), false);
  assert.equal(singleSenderConfirmed("1", "synthetic-review"), false);
  assert.equal(singleSenderConfirmed("app-only-ghl-workflows-confirmed-idle", " "), false);
  assert.equal(singleSenderConfirmed("app-only-ghl-workflows-confirmed-idle", "synthetic-ui-review"), true);
});

test("deploying without attempt mode, or with another customer, cannot send", () => {
  const now = "2026-11-13T16:10:00.000Z";
  const off = at(now, [paula()], { mode: "evaluate" });
  assert.equal(off.sends.length, 0);
  assert.ok(off.paula?.reasons.includes("send_mode_off"));
  const other = paula({ invoiceNumber: "7295", jobberInvoiceId: "jobber-7295", jobberClientId: "jobber-other" });
  const isolated = at(now, [other, paula()]);
  assert.deepEqual(isolated.sends.map(item => item.invoiceNumber), ["7171"]);
  assert.ok(isolated.invoices.find(item => item.invoiceNumber === "7295")?.reasons.includes("not_on_allowlist"));
  assert.ok(isolated.invoices.find(item => item.invoiceNumber === "7295")?.reasons.includes("category_unproven"));
});

test("missing config, stale token, duplicate history, and the forbidden card block Paula", () => {
  const now = "2026-11-13T16:10:00.000Z";
  const missing = at(now, [paula()], { configBlockers: ["sender_number_unconfigured", "native_footer_unconfigured", "jobber_account_id_unconfigured", "quarantine_identities_unconfigured"] });
  assert.equal(missing.sends.length, 0);
  assert.ok(missing.paula?.reasons.includes("sender_number_unconfigured"));
  const stale = at(now, [paula()], { token: { updatedAt: "2026-11-13T15:01:00.000Z", expiresAt: "2026-11-13T16:01:00.000Z" } });
  assert.ok(stale.paula?.reasons.includes("token_not_refreshed_after_0900"));
  const short = at("2026-11-13T16:10:00.000Z", [paula()], { token: { updatedAt: "2026-11-13T16:01:00.000Z", expiresAt: "2026-11-13T16:20:00.000Z" } });
  assert.ok(short.paula?.reasons.includes("token_coverage_below_900s"));
  const duplicate = at(now, [paula()], { priorAttemptInvoiceIds: ["jobber-7171"] });
  assert.ok(duplicate.paula?.reasons.includes("duplicate_no_second_send"));
  const forbidden = at(now, [paula()], { configBlockers: ["forbidden_opportunity_present"] });
  assert.notEqual(forbidden.paula?.action, "eligible_send");
  assert.equal(at(now, [paula(), paula({ jobberInvoiceId: "jobber-7171-b" })]).sends.length, 0);
});

test("the cron pass sends only the single fresh Paula decision and never replays after the window", async () => {
  const invoices = [paula(), paula({ invoiceNumber: "7161", jobberInvoiceId: "jobber-7161", jobberClientId: "jobber-other" })];
  let now = Date.parse("2026-11-13T16:10:00.000Z");
  const sends: string[] = [];
  const deps = fakeDeps({
    now: () => new Date(now),
    mode: () => "paula-day10-attempt",
    singleSender: true,
    invoices,
    send: async () => { sends.push("paula"); return { state: "accepted", attempted: true }; },
  });
  const sent = await runAutomaticReminderPass(deps, { entrypoint: "standalone_cron" });
  assert.equal(sent.state, "sent");
  assert.equal(sent.sends, 1);
  assert.deepEqual(sends, ["paula"]);
  assert.equal(deps.loadConfigCalls, 1);
  // The pass used to sleep until 09:05 and re-read. With a daily 09:00 window
  // the run is scheduled for the window itself, so a pass before it simply
  // reports and ends - it never sleeps, and never sends on a later tick.
  const beforeDeps = fakeDeps({
    now: () => new Date("2026-11-13T15:59:00.000Z"),
    mode: () => "paula-day10-attempt",
    singleSender: true,
    invoices,
    sleep: async () => { throw new Error("the pass must not sleep"); },
    send: async () => { sends.push("before-window"); return { state: "accepted", attempted: true }; },
  });
  const before = await runAutomaticReminderPass(beforeDeps, { entrypoint: "standalone_cron" });
  assert.equal(before.state, "evaluated");
  assert.equal(before.sends, 0);
  assert.equal(beforeDeps.loadConfigCalls, 0, "the reviewed config is not even read outside the window");

  const afterDeps = fakeDeps({
    now: () => new Date("2026-11-13T16:15:00.000Z"),
    mode: () => "paula-day10-attempt",
    singleSender: true,
    invoices,
    sleep: async () => { throw new Error("the pass must not sleep"); },
    send: async () => { sends.push("after-window"); return { state: "accepted", attempted: true }; },
  });
  const after = await runAutomaticReminderPass(afterDeps, { entrypoint: "standalone_cron" });
  assert.equal(after.sends, 0);
  assert.ok(after.code === "missed_window_no_catch_up" || after.state === "evaluated");

  // A paid invoice inside the window is suppressed, not sent.
  const paidDeps = fakeDeps({
    now: () => new Date("2026-11-13T16:05:00.000Z"),
    mode: () => "paula-day10-attempt",
    singleSender: true,
    invoices: [paula({ invoiceStatus: "paid", balanceMinor: 0 })],
    send: async () => { sends.push("paid"); return { state: "accepted", attempted: true }; },
  });
  const paid = await runAutomaticReminderPass(paidDeps, { entrypoint: "standalone_cron" });
  assert.notEqual(paid.state, "sent");
  assert.equal(paid.sends, 0);

  assert.deepEqual(sends, ["paula"], "exactly one send across every pass above");
});

test("evaluate mode, a non-cron entrypoint, and an unknown transport do not send or retry", async () => {
  let sends = 0;
  const quiet = fakeDeps({
    now: () => new Date("2026-11-13T16:10:00.000Z"),
    mode: () => undefined,
    invoices: [paula()],
    send: async () => { sends += 1; return { state: "accepted", attempted: true }; },
  });
  const armedWithoutSender = fakeDeps({
    now: () => new Date("2026-11-13T16:10:00.000Z"),
    mode: () => "paula-day10-attempt",
    invoices: [paula()],
    send: async () => { sends += 1; return { state: "accepted", attempted: true }; },
  });
  const blocked = await runAutomaticReminderPass(armedWithoutSender, { entrypoint: "standalone_cron" });
  assert.equal(blocked.code, "duplicate_sender_unconfirmed");
  assert.equal(blocked.sends, 0);
  assert.equal(armedWithoutSender.loadConfigCalls, 0);
  const evaluated = await runAutomaticReminderPass(quiet, { entrypoint: "standalone_cron" });
  assert.equal(evaluated.sends, 0);
  assert.equal(evaluated.paulaDay10, "hold");
  assert.equal(quiet.loadConfigCalls, 0);
  const http = await runAutomaticReminderPass(quiet, { entrypoint: "http" });
  assert.equal(http.state, "disabled");
  assert.equal(sends, 0);
  const unknown = await runAutomaticReminderPass(fakeDeps({
    now: () => new Date("2026-11-13T16:10:00.000Z"),
    mode: () => "paula-day10-attempt",
    invoices: [paula()],
    singleSender: true,
    send: async () => { sends += 1; return { state: "unknown", attempted: true }; },
  }), { entrypoint: "standalone_cron" });
  assert.equal(unknown.state, "unknown");
  assert.equal(unknown.code, "send_outcome_unknown_no_retry");
  assert.equal(sends, 1);
});

test("config inspection names missing operational values and does not return them", () => {
  const phone = "+12025550123";
  const sender = "+12025550999";
  const inspected = inspectAutomaticReminderConfig(undefined, undefined, undefined, "2026-11-13");
  assert.deepEqual(inspected.blockers, ["required_config_missing"]);
  const partial = JSON.stringify({ source: { scope: { contactId: "someone-else" } }, destination: phone, sender: { number: sender } });
  const gaps = inspectAutomaticReminderConfig(partial, createHash("sha256").update(partial).digest("hex"), "review", "2026-11-13");
  for (const name of ["sender_number_unconfigured", "native_footer_unconfigured", "jobber_account_id_unconfigured", "quarantine_identities_unconfigured", "allowlist_contact_mismatch", "unapproved_day10_body"]) {
    assert.equal(gaps.blockers.includes(name) || gaps.blockers.includes("required_config_missing"), true, name);
  }
  assert.equal(JSON.stringify(gaps).includes(phone), false);
  assert.equal(JSON.stringify(gaps).includes(sender), false);
  const complete = paulaConfig(phone, sender);
  const raw = JSON.stringify(complete);
  const readyConfig = inspectAutomaticReminderConfig(raw, createHash("sha256").update(raw).digest("hex"), "synthetic-operator-review", "2026-11-13");
  assert.equal(readyConfig.blockers.includes("unapproved_day10_body"), false);
  assert.equal(readyConfig.blockers.includes("allowlist_contact_mismatch"), false);
  assert.equal(readyConfig.binding.contactId, CONTACT);
  assert.equal(JSON.stringify(readyConfig).includes(phone), false);
  assert.equal(JSON.stringify(readyConfig).includes(sender), false);
  assert.equal(JSON.stringify(readyConfig).includes(FORBIDDEN), false);
  const poisoned = raw.replace("synthetic-operator-review", FORBIDDEN);
  const blocked = inspectAutomaticReminderConfig(poisoned, createHash("sha256").update(poisoned).digest("hex"), "synthetic-operator-review", "2026-11-13");
  assert.ok(blocked.blockers.includes("forbidden_opportunity_present"));
});

test("Jobber reread keeps source date strings and does not refresh or echo provider errors", async () => {
  let requested = "";
  const invoices = await readJobberInvoicesById("synthetic-token", ["jobber-7171"], (async (url, init) => {
    requested = String(init?.body);
    assert.equal(String(url), "https://api.getjobber.com/api/graphql");
    assert.equal(init?.method, "POST");
    return new Response(JSON.stringify({ data: { i0: { id: "jobber-7171", invoiceNumber: "7171", invoiceStatus: "past_due",
      amounts: { invoiceBalance: 137 }, issuedDate: "2026-10-27", dueDate: "2026-11-03", client: { id: "jobber-paula" } } } }), { status: 200 });
  }) as typeof fetch);
  assert.equal(invoices[0].issuedDate, "2026-10-27");
  assert.equal(invoices[0].dueDate, "2026-11-03");
  assert.equal(invoices[0].balanceMinor, 13700);
  assert.equal(requested.includes("companyName"), false);
  assert.equal(requested.includes("oauth"), false);
  await assert.rejects(() => readJobberInvoicesById("synthetic-token", ["jobber-7171"], (async () =>
    new Response("synthetic-token leaked", { status: 500 })) as typeof fetch), (error: Error) => {
    assert.equal(error.message, "jobber_reread_failed");
    assert.equal(error.message.includes("synthetic-token"), false);
    return true;
  });
});

test("cron runtime and sync wiring stay Paula-only and do not enable the cohort hook", async () => {
  await assert.rejects(() => bootstrapDay10PilotRuntime({
    accountId: "synthetic-account", locationId: "synthetic-location", action: "one-attempt",
    expiresAt: new Date(Date.now() + 60_000).toISOString(), service: "recurring-cron",
  }), /cron_runtime_requires_paula_day10_allowlist/);
  const cron = readFileSync("lib/invoice-reminder-automatic-cron.ts", "utf8");
  const sync = readFileSync("scripts/sync-cron.ts", "utf8");
  assert.match(sync, /runConfiguredAutomaticReminders\(\{ entrypoint: "standalone_cron" \}\)/);
  assert.match(sync, /run\.status === "complete"/);
  assert.match(cron, /rollout: "paula-day10-2026-11-13"/);
  assert.doesNotMatch(cron, /FLEXX_RECURRING_DAY10|getValidAccessToken|refreshAccessToken|GHL_INVOICE_WRITE_MODE\s*=/);
  assert.doesNotMatch(readFileSync("lib/invoice-reminder-automatic.ts", "utf8"), /\+1\d{10}|@[a-z]+\.[a-z]+/i);
});

function paulaConfig(phone: string, sender: string) {
  const now = Date.now();
  return {
    version: 1, kind: "day10-homeowner-sms-pilot", reviewRef: "synthetic-operator-review",
    reviewedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString(),
    source: {
      version: 1, reviewRef: "synthetic-source", expiresAt: new Date(now + 3_600_000).toISOString(),
      scope: { locationId: "synthetic-location", jobberClientId: "jobber-paula", contactId: CONTACT, invoiceId: "jobber-7171" },
      originalInvoice: { totalMinor: 13700, issuedDate: "2026-10-27", dueDate: "2026-11-03" },
      identityCoveragePolicy: {
        accountId: "synthetic-account", reviewRef: "synthetic-coverage",
        reviewedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString(),
        quarantine: [{ jobberClientId: "synthetic-hold-a", email: null, phone: null }, { jobberClientId: "synthetic-hold-b", email: null, phone: null }],
      },
    },
    destination: phone,
    scope: {
      scheduledOn: "2026-11-13", dayPastDue: 10, audience: "homeowner", channel: "sms", maximumAttempts: 1,
      history: "accessible-ghl-plus-local-ledger", timeZone: "America/Phoenix", window: "[09:00:00,09:15:00)",
      authorizationRef: "synthetic-finite-attempt", timingRef: "synthetic-timing", credentialBindingRef: "synthetic-scope-review",
    },
    currencyPolicy: null,
    sender: { number: sender, approvalRef: "synthetic-sender-approval", writeScopeEvidenceRef: "synthetic-write-scope" },
    template: { id: "day10", version: "original", body: ORIGINAL_DAY10_SMS_BODY, policy: "day10-open-balance-no-enforcement", approvalRef: "synthetic-copy" },
    nativeSms: { version: "2021-07-28", status: "pending", receiptSource: "app", semanticsRef: "synthetic-native",
      footer: { mode: "exact-native-suffix", suffix: "synthetic-footer-suffix", evidenceRef: "synthetic-footer" } },
  };
}

function fakeDeps(options: {
  now: () => Date;
  mode: () => string | undefined;
  invoices: ReminderSourceInvoice[];
  send: AutomaticReminderDependencies["sendPaulaDay10"];
  singleSender?: boolean;
  sleep?: (ms: number) => Promise<void>;
  onRead?: () => void;
  afterSleepInvoices?: ReminderSourceInvoice[];
}): AutomaticReminderDependencies & { loadConfigCalls: number } {
  let reads = 0;
  const deps = {
    loadConfigCalls: 0,
    now: options.now,
    mode: options.mode,
    singleSenderConfirmed: () => options.singleSender === true,
    readToken: async () => ({ accessToken: "synthetic-token", updatedAt: new Date("2026-11-13T16:01:00.000Z"), expiresAt: new Date("2026-11-13T17:01:00.000Z") }),
    loadOpenIds: async () => options.invoices.map(item => item.jobberInvoiceId),
    readInvoices: async (_token: string, ids: readonly string[]) => {
      reads += 1; options.onRead?.();
      const source = options.afterSleepInvoices && reads > 1 ? options.afterSleepInvoices : options.invoices;
      return source.filter(item => ids.includes(item.jobberInvoiceId));
    },
    priorAttempts: async () => [],
    loadConfig: () => {
      deps.loadConfigCalls += 1;
      const raw = JSON.stringify(paulaConfig("+12025550123", "+12025550999"));
      return { raw, sha256: createHash("sha256").update(raw).digest("hex"), reviewRef: "synthetic-operator-review" };
    },
    sleep: options.sleep ?? (async () => {}),
    sendPaulaDay10: options.send,
  };
  return deps;
}
