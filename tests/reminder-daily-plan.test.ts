import test from "node:test";
import assert from "node:assert/strict";
import { planDailyReminders, DAILY_CHANNELS, MAX_PER_CUSTOMER_PER_CHANNEL_PER_DAY,
  type DailyPlanCandidate } from "../lib/reminder-daily-plan";
import type { ReminderEvaluationRow, SendChannel } from "../lib/reminder-evaluation";

type ChannelSpec = { channel: SendChannel; decision: "eligible" | "suppressed" };

const row = (patch: Partial<ReminderEvaluationRow> & { jobberInvoiceId: string },
  channels: ChannelSpec[] = [{ channel: "sms", decision: "eligible" }]): ReminderEvaluationRow => ({
  jobberInvoiceId: patch.jobberInvoiceId,
  invoiceNumber: patch.invoiceNumber ?? null,
  clientName: patch.clientName ?? null,
  unpaidInvoicesForOwner: patch.unpaidInvoicesForOwner ?? null,
  pastDueCatchUp: patch.pastDueCatchUp ?? false,
  decision: patch.decision ?? "eligible",
  holds: patch.holds ?? [],
  category: patch.category ?? "maintenance",
  categorySource: patch.categorySource ?? "test",
  categoryEvidence: patch.categoryEvidence ?? null,
  daysPastDue: patch.daysPastDue ?? 10,
  balanceCents: patch.balanceCents ?? 10_000,
  totalCents: patch.totalCents ?? 10_000,
  sourceIssuedDate: patch.sourceIssuedDate ?? "2026-10-01",
  reworkVerdict: patch.reworkVerdict ?? null,
  reworkReason: patch.reworkReason ?? null,
  milestoneDay: patch.milestoneDay ?? 10,
  audience: patch.audience ?? "homeowner",
  channels: channels.map(entry => ({ ...entry, reason: null })),
});

const candidate = (jobberInvoiceId: string, jobberClientId: string | null, clientName: string | null): DailyPlanCandidate =>
  ({ jobberInvoiceId, jobberClientId, clientName });

const both: ChannelSpec[] = [{ channel: "sms", decision: "eligible" }, { channel: "email", decision: "eligible" }];

test("one customer with three unpaid invoices gets one text and one email, not three of each", () => {
  const rows = [
    row({ jobberInvoiceId: "a", invoiceNumber: "100", milestoneDay: 10, daysPastDue: 10 }, both),
    row({ jobberInvoiceId: "b", invoiceNumber: "101", milestoneDay: 15, daysPastDue: 15 }, both),
    row({ jobberInvoiceId: "c", invoiceNumber: "102", milestoneDay: 10, daysPastDue: 10 }, both),
  ];
  const plan = planDailyReminders({
    rows,
    candidates: rows.map(entry => candidate(entry.jobberInvoiceId, "client-1", "Dana Reyes")),
    phoenixDate: "2026-11-23",
  });
  assert.equal(plan.customers.length, 1);
  const only = plan.customers[0];
  assert.equal(only.picks.length, 2);
  assert.equal(only.picks.filter(pick => pick.channel === "sms").length, 1);
  assert.equal(only.picks.filter(pick => pick.channel === "email").length, 1);
  // The furthest milestone wins: day 15, invoice 101, on both channels.
  assert.deepEqual(only.picks.map(pick => pick.invoiceNumber), ["101", "101"]);
  assert.equal(only.drops.length, 4);
  assert.ok(only.drops.every(drop => drop.reason.startsWith("capped_one_")));
  assert.equal(plan.smsPicked, 1);
  assert.equal(plan.emailPicked, 1);
  assert.equal(plan.droppedToCap, 4);
  assert.equal(plan.customersWithASend, 1);
});

test("the cap never invents a send: every pick is an eligible row on an eligible channel", () => {
  const rows = [
    row({ jobberInvoiceId: "held", invoiceNumber: "200", decision: "held", holds: ["something"] }, both),
    row({ jobberInvoiceId: "notdue", invoiceNumber: "201", decision: "not_due" }, both),
    row({ jobberInvoiceId: "paid", invoiceNumber: "202", decision: "no_longer_owes" }, both),
    row({ jobberInvoiceId: "passed", invoiceNumber: "203", decision: "window_passed" }, both),
    row({ jobberInvoiceId: "suppressed", invoiceNumber: "204" },
      [{ channel: "sms", decision: "suppressed" }, { channel: "email", decision: "suppressed" }]),
    row({ jobberInvoiceId: "nochannels", invoiceNumber: "205" }, []),
    row({ jobberInvoiceId: "ok", invoiceNumber: "206" }, [{ channel: "sms", decision: "eligible" },
      { channel: "email", decision: "suppressed" }]),
  ];
  const plan = planDailyReminders({
    rows,
    candidates: rows.map((entry, index) => candidate(entry.jobberInvoiceId, `client-${index}`, `Customer ${index}`)),
    phoenixDate: "2026-11-23",
  });
  const picked = plan.customers.flatMap(entry => entry.picks);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].jobberInvoiceId, "ok");
  assert.equal(picked[0].channel, "sms");
  assert.equal(plan.emailPicked, 0);
  // Nothing the evaluation refused can appear as a pick.
  for (const pick of picked) {
    const source = rows.find(entry => entry.jobberInvoiceId === pick.jobberInvoiceId)!;
    assert.equal(source.decision, "eligible");
    assert.ok(source.channels.some(entry => entry.channel === pick.channel && entry.decision === "eligible"));
  }
});

test("the cap holds for every customer in a mixed batch, however many invoices each has", () => {
  const rows: ReminderEvaluationRow[] = [];
  const candidates: DailyPlanCandidate[] = [];
  for (let customer = 0; customer < 25; customer += 1) {
    for (let invoice = 0; invoice <= customer % 5; invoice += 1) {
      const id = `c${customer}-i${invoice}`;
      rows.push(row({ jobberInvoiceId: id, invoiceNumber: `${1000 + customer * 10 + invoice}`,
        milestoneDay: 10 + invoice, daysPastDue: 10 + invoice }, both));
      candidates.push(candidate(id, `client-${customer}`, `Customer ${customer}`));
    }
  }
  const plan = planDailyReminders({ rows, candidates, phoenixDate: "2026-11-23" });
  assert.equal(plan.customers.length, 25);
  for (const entry of plan.customers) {
    for (const channel of DAILY_CHANNELS) {
      assert.ok(entry.picks.filter(pick => pick.channel === channel).length <= MAX_PER_CUSTOMER_PER_CHANNEL_PER_DAY,
        `${entry.customerKey} ${channel}`);
    }
  }
  assert.equal(plan.smsPicked, 25);
  assert.equal(plan.emailPicked, 25);
  assert.equal(plan.smsPicked + plan.emailPicked + plan.droppedToCap, rows.length * 2);
});

test("two invoices under one Jobber client are one customer, even with different names on them", () => {
  const rows = [
    row({ jobberInvoiceId: "a", invoiceNumber: "300", clientName: "Sam Ortiz" }),
    row({ jobberInvoiceId: "b", invoiceNumber: "301", clientName: "Sam Ortiz (Rental)" }),
  ];
  const plan = planDailyReminders({
    rows,
    candidates: [candidate("a", "client-9", "Sam Ortiz"), candidate("b", "client-9", "Sam Ortiz (Rental)")],
    phoenixDate: "2026-11-23",
  });
  assert.equal(plan.customers.length, 1);
  assert.equal(plan.smsPicked, 1);
  assert.equal(plan.droppedToCap, 1);
});

test("invoices with no client id and no name are never merged into one stranger", () => {
  const rows = [row({ jobberInvoiceId: "a", invoiceNumber: "400" }), row({ jobberInvoiceId: "b", invoiceNumber: "401" })];
  const plan = planDailyReminders({
    rows,
    candidates: [candidate("a", null, null), candidate("b", null, null)],
    phoenixDate: "2026-11-23",
  });
  assert.equal(plan.customers.length, 2);
  assert.equal(plan.smsPicked, 2);
  assert.equal(plan.droppedToCap, 0);
});

test("same milestone and same lateness: the lower invoice number wins, and the order is stable", () => {
  const rows = [
    row({ jobberInvoiceId: "later", invoiceNumber: "9002", milestoneDay: 10, daysPastDue: 10 }),
    row({ jobberInvoiceId: "older", invoiceNumber: "9001", milestoneDay: 10, daysPastDue: 10 }),
  ];
  const candidates = [candidate("later", "client-x", "Pat Lee"), candidate("older", "client-x", "Pat Lee")];
  const first = planDailyReminders({ rows, candidates, phoenixDate: "2026-11-23" });
  const reversed = planDailyReminders({ rows: [...rows].reverse(), candidates, phoenixDate: "2026-11-23" });
  assert.equal(first.customers[0].picks[0].invoiceNumber, "9001");
  assert.deepEqual(first.customers[0].picks, reversed.customers[0].picks);
});

test("an empty plan is empty, not a crash", () => {
  const plan = planDailyReminders({ rows: [], candidates: [], phoenixDate: null });
  assert.deepEqual(plan.customers, []);
  assert.equal(plan.customersWithASend, 0);
  assert.equal(plan.smsPicked + plan.emailPicked + plan.droppedToCap, 0);
  assert.equal(plan.phoenixDate, null);
});
