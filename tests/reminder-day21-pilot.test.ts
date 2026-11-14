import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  attemptDay21PilotEmail, assertFakeProvider, invoiceIsProvenNew,
  PILOT_TOTAL_SEND_CAP, PILOT_MILESTONE_DAY, PILOT_AUDIENCE, PILOT_CHANNEL,
  type CutoverProof, type FakeEmailProvider, type InvoiceNoveltyInput, type PilotAllowance,
} from "../lib/reminder-day21-pilot";
import { invoiceReminderMilestones } from "../lib/invoice-reminder-clock";
import { createNotificationLedger, type NotificationLedgerDatabase,
  type NotificationLedgerTransaction } from "../lib/notification-ledger";
import type { Event } from "../lib/notification-gate";

const APPROVED = "angie@example.invalid";
/** 2026-12-14 09:05 America/Phoenix. Day 21 for a 2026-11-23 due date. */
const NOW = new Date("2026-12-14T16:05:00Z");
const BODY = "Hello Angie,\n\nSynthetic pilot body.\n";
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function event(patch: Partial<Event> = {}): Event {
  return { accountId: "pilot-account", invoiceId: "synthetic-encoded-invoice-id",
    dayPastDue: 21, audience: "internal", sourceRevision: "s1", ownerRevision: "o1",
    ownerId: "owner", homeownerContactId: "homeowner-contact",
    // Issue date 70 days before the due date on purpose: the milestone must
    // come from the DUE date, so these two differing cannot move day 21.
    issuedDate: "2026-09-14", dueDate: "2026-11-23", balanceMinor: 13700, currency: "USD",
    category: "irrigation", recipientId: "angie", contactId: "angie",
    channel: "email", destination: APPROVED, templateId: "day21-internal-email",
    templateVersion: "1", bodyDigest: digest(BODY), claimedFacts: [], ...patch };
}
const novelty = (patch: Partial<InvoiceNoveltyInput> = {}): InvoiceNoveltyInput => ({
  jobberInvoiceId: "synthetic-encoded-invoice-id",
  createdAt: "2026-11-16T18:04:12Z", issuedDate: "2026-11-16T18:04:25Z", ...patch });
const cutover = (patch: Partial<CutoverProof> = {}): CutoverProof => ({
  cutoverAt: "2026-11-15T17:00:00Z", inventory: new Set(["an-old-invoice-id"]),
  inventoryComplete: true, inventoryCount: 1, ...patch });

/** Not a database. Models the two unique keys so blocks can be unit tested.
 *  Statements are routed by their /* notification-ledger:<op> *\/ tag, never by
 *  a substring: every statement contains the word "reserved". */
class MemoryDb implements NotificationLedgerDatabase {
  rows: Record<string, string>[] = [];
  async transaction<T>(work: (tx: NotificationLedgerTransaction) => Promise<T>): Promise<T> {
    return work({ query: async <R extends Record<string, unknown>>(sql: string, values: readonly unknown[]) => {
      const operation = /notification-ledger:(reserve|assert|pending|outcome)/.exec(sql)?.[1];
      assert.ok(operation, "unrecognised statement");
      if (operation === "reserve") {
        const [id, token, eventKey, , , , , contactId, scheduledOn] = values as string[];
        if (this.rows.some(row => row.eventKey === eventKey ||
          (row.contactId === contactId && row.scheduledOn === scheduledOn))) return [] as unknown as R[];
        this.rows.push({ id, token, eventKey, contactId, scheduledOn, state: "reserved" });
        return [{ id }] as unknown as R[];
      }
      const [id, token] = values as string[];
      const row = this.rows.find(entry => entry.id === id && entry.token === token);
      if (!row) return [] as unknown as R[];
      if (operation === "assert") return (row.state === "reserved" ? [{ id }] : []) as unknown as R[];
      if (operation === "pending") {
        if (row.state !== "reserved") return [] as unknown as R[];
        row.state = "pending"; return [{ id }] as unknown as R[];
      }
      if (row.state !== "pending") return [] as unknown as R[];
      row.state = values[5] as string; return [{ id }] as unknown as R[];
    } });
  }
}

let calls: { to: string; subject: string }[] = [];
const fake = (): FakeEmailProvider => ({ fake: true, name: "fake-email-provider",
  async send(input) { calls.push({ to: input.to, subject: input.subject });
    return { state: "accepted", providerMessageId: "fake-provider-id" }; } });

/** Wins the allowance unless told otherwise. */
const allowance = (over: Partial<PilotAllowance> = {}, used = 0): PilotAllowance => ({
  async countPilotReservations() { return used; },
  async arbitrate() { return "won"; },
  ...over });

const attempt = (over: Partial<Parameters<typeof attemptDay21PilotEmail>[0]> = {}, used = 0) => {
  const db = new MemoryDb();
  return attemptDay21PilotEmail({
    event: event(), body: BODY, subject: "Day 21 past due: Invoice #SYNTH-0001",
    scheduledOn: "2026-12-14", approvedInternalDestination: APPROVED,
    customerDestinations: ["customer@example.invalid", "+16025550199"],
    novelty: novelty(), cutover: cutover(), now: NOW,
    ledger: createNotificationLedger(db),
    allowance: allowance({}, used),
    provider: fake(), ...over });
};
const blockOf = (result: Awaited<ReturnType<typeof attempt>>) =>
  result.state === "blocked" ? result.block : result.state;

test("the pilot is day 21, internal, email, capped at one for the whole pilot", () => {
  assert.equal(PILOT_MILESTONE_DAY, 21);
  assert.equal(PILOT_AUDIENCE, "internal");
  assert.equal(PILOT_CHANNEL, "email");
  assert.equal(PILOT_TOTAL_SEND_CAP, 1);
});

test("the module imports no transport and no live sender", () => {
  const source = readFileSync(new URL("../lib/reminder-day21-pilot.ts", import.meta.url), "utf8");
  for (const forbidden of ["fetch(", "axios", "http.request", "./ghl", "notification-ghl-transport",
    "conversations/messages", "leadconnector", "mailgun", "prisma"])
    assert.equal(source.includes(forbidden), false, forbidden);
});

test("SMS, a customer audience and any other milestone are hard-blocked", async () => {
  calls = [];
  assert.equal(blockOf(await attempt({ event: event({ channel: "sms" }) })), "channel_not_email");
  assert.equal(blockOf(await attempt({ event: event({ audience: "homeowner" }) })), "audience_not_internal");
  for (const day of [10, 15, 20, 25, 30])
    assert.equal(blockOf(await attempt({ event: event({ dayPastDue: day }) })), "milestone_not_day_21");
  assert.equal(calls.length, 0, "no provider call on a blocked attempt");
});

test("only the one approved internal destination is accepted", async () => {
  calls = [];
  for (const destination of ["someone.else@example.invalid", "customer@example.invalid", "", " "])
    assert.equal(blockOf(await attempt({ event: event({ destination }) })),
      "destination_not_the_approved_internal_address", destination);
  // Even naming a customer address as the approved one is refused.
  assert.equal(blockOf(await attempt({
    approvedInternalDestination: "customer@example.invalid",
    event: event({ destination: "customer@example.invalid" }) })),
    "destination_is_a_customer_destination");
  assert.equal(calls.length, 0);
});

test("a provider that is not explicitly fake is refused, and nothing is reserved", async () => {
  const db = new MemoryDb();
  for (const provider of [null, undefined, {}, { send: async () => ({ state: "accepted" }) },
    { fake: false, name: "fake", send: async () => ({ state: "accepted" }) },
    { fake: true, name: "mailgun", send: async () => ({ state: "accepted" }) }])
    assert.equal(blockOf(await attempt({ provider, ledger: createNotificationLedger(db) })), "provider_not_fake");
  assert.equal(db.rows.length, 0);
  assert.throws(() => assertFakeProvider({ name: "mailgun" }), /provider_not_fake/);
});

test("the cap is one for the whole pilot, and an unreadable count counts as used", async () => {
  calls = [];
  assert.equal(blockOf(await attempt({}, PILOT_TOTAL_SEND_CAP)), "pilot_cap_already_used");
  assert.equal(blockOf(await attempt({}, 7)), "pilot_cap_already_used");
  assert.equal(blockOf(await attempt({
    allowance: allowance({ async countPilotReservations() { return null; } }) })), "pilot_cap_already_used");
  assert.equal(calls.length, 0);
});

test("a clean attempt reserves first, then calls the fake provider exactly once", async () => {
  calls = [];
  const db = new MemoryDb();
  const result = await attempt({ ledger: createNotificationLedger(db) });
  assert.equal(result.state, "sent_to_fake_provider", JSON.stringify(result));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { to: APPROVED, subject: "Day 21 past due: Invoice #SYNTH-0001" });
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].state, "accepted");
});

test("a provider that throws is uncertain, never retried, and leaves the row pending", async () => {
  const db = new MemoryDb();
  const result = await attempt({ ledger: createNotificationLedger(db),
    provider: { fake: true, name: "fake-email-provider",
      async send() { throw new Error("synthetic timeout after acceptance"); } } });
  assert.equal(result.state, "uncertain");
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].state, "unknown");
});

// --- what proves an invoice is genuinely new ---

test("issuedDate alone never proves novelty, because it is operator-settable", () => {
  // Measured over 800 live invoices: always a real time, never midnight, but it
  // drifted from createdAt by -2 minutes on one and +3 days on another.
  const late = invoiceIsProvenNew(
    novelty({ createdAt: "2026-11-14T10:00:00Z", issuedDate: "2026-11-20T10:00:00Z" }), cutover());
  assert.equal(late.proven, false);
  assert.match(late.proven === false ? late.reason : "", /created_at_not_after_cutover/);
});

test("novelty needs createdAt after the cutover AND absence from a complete inventory", () => {
  const ok = invoiceIsProvenNew(novelty(), cutover());
  assert.equal(ok.proven, true);
  if (ok.proven) assert.equal(ok.evidence.length, 3);

  for (const [label, verdict] of [
    ["created at the cutover instant", invoiceIsProvenNew(novelty({ createdAt: "2026-11-15T17:00:00Z" }), cutover())],
    ["created inside clock skew", invoiceIsProvenNew(novelty({ createdAt: "2026-11-15T17:00:30Z" }), cutover())],
    ["created before the cutover", invoiceIsProvenNew(novelty({ createdAt: "2026-11-01T00:00:00Z" }), cutover())],
    ["in the inventory", invoiceIsProvenNew(novelty({ jobberInvoiceId: "an-old-invoice-id" }),
      cutover({ inventory: new Set(["an-old-invoice-id"]) }))],
    ["inventory incomplete", invoiceIsProvenNew(novelty(), cutover({ inventoryComplete: false }))],
    ["createdAt missing", invoiceIsProvenNew(novelty({ createdAt: null }), cutover())],
    ["createdAt date-only", invoiceIsProvenNew(novelty({ createdAt: "2026-11-16" }), cutover())],
    ["cutover unusable", invoiceIsProvenNew(novelty(), cutover({ cutoverAt: "whenever" }))],
    ["issue date back-dated", invoiceIsProvenNew(novelty({ issuedDate: "2026-11-16T17:00:00Z" }), cutover())],
    ["issuedDate missing", invoiceIsProvenNew(novelty({ issuedDate: null }), cutover())],
  ] as const) assert.equal(verdict.proven, false, label);
});

test("an invoice that is not proven new is blocked before the provider is reached", async () => {
  calls = [];
  const db = new MemoryDb();
  const result = await attempt({ ledger: createNotificationLedger(db),
    novelty: novelty({ createdAt: "2026-11-01T00:00:00Z" }) });
  assert.equal(blockOf(result), "invoice_not_proven_new");
  assert.equal(calls.length, 0);
  assert.equal(db.rows.length, 0);
});

test("two invoices for the same milestone: the second is refused by the ledger", async () => {
  calls = [];
  const db = new MemoryDb(), ledger = createNotificationLedger(db);
  assert.equal((await attempt({ ledger })).state, "sent_to_fake_provider");
  // A fresh ledger instance over the same rows, so this is the key refusing it.
  const again = await attempt({ ledger: createNotificationLedger(db) });
  assert.equal(blockOf(again), "ledger_refused");
  assert.equal(calls.length, 1);
  assert.equal(db.rows.length, 1);
});

// --- the milestone comes from the DUE date, in Phoenix ----------------------

test("day 21 is the due date plus 21 Phoenix days, and the issue date cannot move it", () => {
  const due = "2026-11-23T07:00:00Z";
  // The issue date moves by 70 days; day 21 does not move at all.
  for (const issued of ["2026-09-14T22:15:00Z", "2026-10-30T12:00:00Z", "2026-11-23T00:00:00Z"]) {
    const steps = invoiceReminderMilestones("irrigation", issued, due, NOW);
    assert.equal(steps?.find(step => step.dayPastDue === 21)?.scheduledOn, "2026-12-14", issued);
  }
  // And a different due date moves it, which is the point.
  assert.equal(invoiceReminderMilestones("irrigation", "2026-09-14T22:15:00Z", "2026-11-30T07:00:00Z", NOW)
    ?.find(step => step.dayPastDue === 21)?.scheduledOn, "2026-12-21");
});

test("the pilot refuses to send unless the clock says day 21 is today in Phoenix", async () => {
  calls = [];
  // Due date changed, so the clock's day 21 is 2026-12-21, not the 12-14 the
  // caller asked for. The caller does not get to assert the milestone.
  const wrongDue = await attempt({ event: event({ dueDate: "2026-11-30" }) });
  assert.equal(blockOf(wrongDue), "day_21_not_due_by_the_jobber_due_date");
  if (wrongDue.state === "blocked") assert.match(wrongDue.detail, /day 21 falls on 2026-12-21/);

  // A Phoenix day early: 10:00 Phoenix on 2026-12-13. The clock is a calendar,
  // so "early" means the previous Phoenix DATE, not an earlier hour.
  const early = await attempt({ now: new Date("2026-12-13T17:00:00Z") });
  assert.equal(blockOf(early), "day_21_not_due_by_the_jobber_due_date");
  if (early.state === "blocked") assert.match(early.detail, /day 21 is future/);

  // A day late: 12-15 Phoenix. Skipped, not replayed.
  assert.equal(blockOf(await attempt({ now: new Date("2026-12-15T17:00:00Z") })),
    "day_21_not_due_by_the_jobber_due_date");
  assert.equal(calls.length, 0);
});

test("createdAt and the inventory decide novelty only, never the milestone", async () => {
  // createdAt is days away from the due date; day 21 is unaffected.
  const result = await attempt({ novelty: novelty({ createdAt: "2026-11-16T18:04:12Z" }) });
  assert.equal(result.state, "sent_to_fake_provider", JSON.stringify(result));
  const steps = invoiceReminderMilestones("irrigation", "2026-09-14", "2026-11-23", NOW);
  assert.equal(steps?.find(step => step.dayPastDue === 21)?.scheduledOn, "2026-12-14");
});

// --- the pilot's single allowance across DIFFERENT invoices ----------------

test("two different invoices on the same day: the ledger key alone stops the second", async () => {
  calls = [];
  const db = new MemoryDb();
  // Both invoices reach day 21 today, so both target the same internal contact
  // on the same scheduled date. The (account, contact, scheduledOn) key refuses
  // the second before the allowance is even consulted.
  const results = await Promise.all([
    attempt({ ledger: createNotificationLedger(db), event: event({ invoiceId: "invoice-a" }),
      novelty: novelty({ jobberInvoiceId: "invoice-a" }) }),
    attempt({ ledger: createNotificationLedger(db), event: event({ invoiceId: "invoice-b" }),
      novelty: novelty({ jobberInvoiceId: "invoice-b" }) }),
  ]);
  assert.equal(results.filter(result => result.state === "sent_to_fake_provider").length, 1);
  assert.equal(calls.length, 1);
  const loser = results.find(result => result.state === "blocked");
  assert.equal(loser && loser.state === "blocked" ? loser.block : null, "ledger_refused");
  assert.equal(db.rows.length, 1);
});

test("two different invoices the ledger does admit: only one claims the allowance", async () => {
  calls = [];
  const db = new MemoryDb();
  // The internal contact id differs between the two runs - what would happen if
  // the recipient's contact were recreated - so neither unique key catches it
  // and BOTH reservations succeed. The allowance is the only thing left.
  const winner: { id: string | null } = { id: null };
  const arbitrating = (): PilotAllowance => ({
    async countPilotReservations() { return 0; },           // both start at zero
    async arbitrate(reservationId) {
      if (winner.id === null) winner.id = reservationId;      // first to ask wins
      return winner.id === reservationId ? "won" : "lost";
    },
  });
  const results = await Promise.all([
    attempt({ ledger: createNotificationLedger(db), allowance: arbitrating(),
      event: event({ invoiceId: "invoice-a", contactId: "angie-contact-1" }),
      novelty: novelty({ jobberInvoiceId: "invoice-a" }) }),
    attempt({ ledger: createNotificationLedger(db), allowance: arbitrating(),
      event: event({ invoiceId: "invoice-b", contactId: "angie-contact-2" }),
      novelty: novelty({ jobberInvoiceId: "invoice-b" }) }),
  ]);

  assert.equal(db.rows.length, 2, "both reservations were admitted by the keys");
  assert.equal(results.filter(result => result.state === "sent_to_fake_provider").length, 1,
    JSON.stringify(results));
  assert.equal(calls.length, 1, "exactly one fake provider call");
  const loser = results.find(result => result.state === "blocked");
  assert.equal(loser && loser.state === "blocked" ? loser.block : null,
    "pilot_allowance_lost_to_another_invoice");
  // The loser's row is left reserved: never pending, never sent.
  assert.equal(db.rows.filter(row => row.state === "pending").length, 0);
  assert.equal(db.rows.filter(row => row.state === "accepted").length, 1);
  assert.equal(db.rows.filter(row => row.state === "reserved").length, 1);
});

test("an allowance that cannot be arbitrated is treated as lost, with no send", async () => {
  calls = [];
  const db = new MemoryDb();
  const result = await attempt({ ledger: createNotificationLedger(db),
    allowance: allowance({ async arbitrate() { return "unknown"; } }) });
  assert.equal(blockOf(result), "pilot_allowance_lost_to_another_invoice");
  if (result.state === "blocked") assert.match(result.detail, /could not be arbitrated/);
  assert.equal(calls.length, 0);
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].state, "reserved", "reserved, never advanced");
});

test("the allowance is decided after reserving and before the provider is called", async () => {
  calls = [];
  const order: string[] = [];
  const db = new MemoryDb();
  await attempt({
    ledger: createNotificationLedger(db),
    allowance: { async countPilotReservations() { order.push("count"); return 0; },
      async arbitrate() { order.push("arbitrate"); return "won"; } },
    provider: { fake: true, name: "fake-email-provider",
      async send() { order.push("provider"); calls.push({ to: APPROVED, subject: "x" });
        return { state: "accepted", providerMessageId: "fake-provider-id" }; } },
  });
  assert.deepEqual(order, ["count", "arbitrate", "provider"]);
  assert.equal(calls.length, 1);
});
