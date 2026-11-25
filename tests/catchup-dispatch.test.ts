import test from "node:test";
import assert from "node:assert/strict";
import { dispatchCatchupSend, SENDABLE_INVOICE_STATUSES, type CatchupDispatchIO } from "../lib/catchup-dispatch";
import { planCatchupRecipient, type CatchupRecipientInput } from "../lib/catchup-plan";
import { CATCHUP_PAY_LINK_HOST } from "../lib/catchup-copy";
import { parseGhlRecipient } from "../lib/notification-ghl-contract";

const ACCOUNT = "acct-1";
const LOCATION = "loc-1";
const CONTACT = "contact-abc123";
const PHONE = "+16025550100";
const EMAIL = "jessica@example.test";
const SENDER_SMS = "+16028548131";
const SENDER_EMAIL = "billing@example.test";
const SEND_ON = "2026-11-24";
const LINK = `https://${CATCHUP_PAY_LINK_HOST}/client_hubs/abc123/invoices/def456`;
const VER = "2021-07-28";
/** The acceptance the provider really returns for a text. */
const OK = { version: VER, statusCode: 201, body: { messageId: "m-1", conversationId: "c-1" } };

const invoice = (over: Record<string, unknown> = {}) => ({
  invoiceId: "inv-7272", invoiceNumber: "7272",
  balanceMinor: 9000, dueOn: "2026-11-17", payLink: LINK, ...over,
});
const recipient = (over: Partial<CatchupRecipientInput> = {}): CatchupRecipientInput => ({
  accountId: ACCOUNT, jobberClientId: "client-1", clientName: "Jessica Noonan",
  contactId: CONTACT, exactContactMatches: 1, phone: PHONE, email: EMAIL,
  smsOptedOut: false, emailOptedOut: false, invoices: [invoice()], ...over,
});
const planned = (over: Partial<CatchupRecipientInput> = {}) => {
  const action = planCatchupRecipient(recipient(over), SEND_ON);
  assert.equal(action.state, "send");
  if (action.state !== "send") throw new Error("unreachable");
  return action;
};

const senderReview = (channel: "sms" | "email") => ({
  accountId: ACCOUNT, locationId: LOCATION, channel,
  sender: channel === "sms" ? SENDER_SMS : SENDER_EMAIL,
  scope: "conversations/message.write" as const, approved: true as const, validated: true as const,
  evidenceRef: "sender-approved-ref",
});
const review = (channel: "sms" | "email") => ({
  mode: "reviewed-construction-only" as const, version: "2021-07-28" as const,
  evidenceRef: "construction-review-ref", accountId: ACCOUNT, locationId: LOCATION,
  channel, proposedStatus: "pending" as const,
});
/** A real consent read, produced by the contract rather than hand-made. */
const allowed = (channel: "sms" | "email") => parseGhlRecipient({
  version: "2021-07-28",
  body: { contact: { id: CONTACT, locationId: LOCATION, phone: PHONE, email: EMAIL, dndSettings: {} } },
  expected: { accountId: ACCOUNT, locationId: LOCATION, contactId: CONTACT, channel,
    destination: channel === "sms" ? PHONE : EMAIL },
});
const suffixPolicy = {
  mode: "reviewed-exact-native-sms-suffix" as const, version: "2021-07-28" as const,
  channel: "sms" as const, source: "app" as const, accountId: ACCOUNT, locationId: LOCATION,
  sender: SENDER_SMS, evidenceRef: "suffix-reviewed-ref", suffix: " Reply STOP to opt out.",
};

const context = (channel: "sms" | "email", over: Record<string, unknown> = {}) => ({
  accountId: ACCOUNT, locationId: LOCATION,
  senderReview: senderReview(channel), review: review(channel), recipient: allowed(channel),
  scheduledOn: SEND_ON,
  ...(channel === "sms" ? { smsReceiptSuffixPolicy: suffixPolicy } : {}),
  ...over,
});

function fakeLedger(opts: { refuseOn?: string; pendingFails?: boolean } = {}) {
  const reserved: { invoiceId: string; dayPastDue: number; channel: string; body: string;
    covers?: readonly string[]; coversBalanceMinor?: number }[] = [];
  const outcomes: string[] = [];
  let pending = 0;
  const ledger = {
    async reserve(input: any) {
      if (opts.refuseOn && input.event.invoiceId === opts.refuseOn) {
        return { state: "held" as const, reason: "already_claimed" as const };
      }
      reserved.push({ invoiceId: input.event.invoiceId, dayPastDue: input.event.dayPastDue,
        channel: input.channel, body: input.body,
        covers: input.event.coversInvoiceNumbers, coversBalanceMinor: input.event.coversBalanceMinor });
      return { state: "reserved" as const, reservation: { id: `r${reserved.length}`, token: "t",
        eventHash: "e", bodyHash: "b", destinationHash: "d" } };
    },
    async assertReserved() { return true; },
    async markPending() { if (opts.pendingFails) return false; pending += 1; return true; },
    async markOutcome(_h: any, o: any) { outcomes.push(o.state); return true; },
  };
  return { ledger, reserved, outcomes, get pending() { return pending; } };
}

const io = (over: Partial<CatchupDispatchIO> & { ledger?: unknown } = {}): CatchupDispatchIO => ({
  ledger: (over.ledger ?? fakeLedger().ledger) as never,
  confirmStillDue: over.confirmStillDue
    ?? (async () => ({ stillOpen: true, balanceMinor: 9000, dayPastDue: 7, invoiceStatus: "past_due" })),
  attemptSend: over.attemptSend
    ?? (async () => (OK as never)),
});

test("a clean text reserves its row, marks it pending, sends once, records accepted", async () => {
  const led = fakeLedger();
  const sent: unknown[] = [];
  const action = planned();
  const result = await dispatchCatchupSend(action, action.sends[0], context("sms") as never,
    io({ ledger: led.ledger, attemptSend: async (d: never) => {
      sent.push(d);
      return OK as never;
    } }));
  assert.equal(result.state, "sent", JSON.stringify(result));
  if (result.state !== "sent") return;
  assert.equal(result.channel, "sms");
  assert.equal(result.providerMessageId, "m-1");
  assert.deepEqual([...result.invoiceNumbers], ["7272"]);
  assert.equal(led.reserved.length, 1);
  assert.equal(led.reserved[0].dayPastDue, 7, "recorded at its REAL day number");
  assert.equal(led.pending, 1);
  assert.deepEqual(led.outcomes, ["accepted"]);
  assert.equal(sent.length, 1, "exactly one attempt, never a retry");
});

test("THE LEDGER RECORDS THE SHARED BODY, so both channels record the same words", async () => {
  const smsLed = fakeLedger();
  const emailLed = fakeLedger();
  const action = planned();
  await dispatchCatchupSend(action, action.sends[0], context("sms") as never, io({ ledger: smsLed.ledger }));
  await dispatchCatchupSend(action, action.sends[1], context("email") as never, io({ ledger: emailLed.ledger }));
  assert.equal(smsLed.reserved.length, 1);
  assert.equal(emailLed.reserved.length, 1);
  assert.equal(smsLed.reserved[0].body, emailLed.reserved[0].body);
  assert.doesNotMatch(smsLed.reserved[0].body, /Reply STOP/, "the suffix is a receipt, not the body");
});

test("TWO INVOICES: BOTH ROWS ARE TAKEN BEFORE THE ONE MESSAGE GOES OUT", async () => {
  const led = fakeLedger();
  let sends = 0;
  const action = planned({
    invoices: [invoice(), invoice({ invoiceId: "inv-7286", invoiceNumber: "7286", dueOn: "2026-11-19" })],
  });
  const result = await dispatchCatchupSend(action, action.sends[0], context("sms") as never,
    io({ ledger: led.ledger,
      confirmStillDue: async (id: string) => ({ stillOpen: true, balanceMinor: 9000,
        dayPastDue: id === "inv-7272" ? 7 : 5, invoiceStatus: "past_due" }),
      attemptSend: async () => { sends += 1; return OK as never; } }));
  assert.equal(result.state, "sent", JSON.stringify(result));
  // ONE message, ONE row. The ledger's per-contact index allows one row per
  // contact per day per channel, so a row each would refuse the second and
  // strand the first - which is how a two-invoice customer used to be
  // unsendable. The row instead NAMES both invoices.
  assert.equal(led.reserved.length, 1, "one row for the one message");
  assert.equal(sends, 1, "and still only ONE text");
  assert.deepEqual(led.outcomes, ["accepted"]);
  assert.equal(led.reserved[0].invoiceId, "inv-7272", "identity comes from the first covered invoice");
  assert.equal(led.reserved[0].dayPastDue, 7, "at that invoice's own real day");
  assert.deepEqual([...(led.reserved[0].covers ?? [])], ["7272", "7286"],
    "but the row records every invoice the words mention");
  assert.equal(led.reserved[0].coversBalanceMinor, 18000, "and the total those words state");
});

test("IF THE ROW CANNOT BE TAKEN, NOTHING IS SENT", async () => {
  const led = fakeLedger({ refuseOn: "inv-7272" });
  let sends = 0;
  const action = planned({
    invoices: [invoice(), invoice({ invoiceId: "inv-7286", invoiceNumber: "7286", dueOn: "2026-11-19" })],
  });
  const result = await dispatchCatchupSend(action, action.sends[0], context("sms") as never,
    io({ ledger: led.ledger,
      confirmStillDue: async (id: string) => ({ stillOpen: true, balanceMinor: 9000,
        dayPastDue: id === "inv-7272" ? 7 : 5, invoiceStatus: "past_due" }),
      attemptSend: async () => { sends += 1; return OK as never; } }));
  assert.equal(sends, 0, "a customer must never get a message we failed to record");
  assert.equal(result.state, "incomplete");
  if (result.state !== "incomplete") return;
  // Nothing was taken, so nothing is stranded. One claim per message means a
  // refusal costs no row at all - the whole point of the change.
  assert.deepEqual([...result.strandedInvoiceNumbers], []);
  assert.equal(led.reserved.length, 0);
  assert.ok(result.reasons.some(r => r.includes("already_claimed")), result.reasons.join(","));
});

test("a ledger that will not mark pending sends nothing", async () => {
  const led = fakeLedger({ pendingFails: true });
  let sends = 0;
  const action = planned();
  const result = await dispatchCatchupSend(action, action.sends[0], context("sms") as never,
    io({ ledger: led.ledger,
      attemptSend: async () => { sends += 1; return OK as never; } }));
  assert.equal(sends, 0);
  assert.equal(result.state, "incomplete");
  if (result.state !== "incomplete") return;
  assert.ok(result.reasons.includes("ledger_would_not_mark_pending"), result.reasons.join(","));
});

test("A PAYMENT THAT LANDED SINCE PLANNING STOPS THE SEND, AT NO LEDGER COST", async () => {
  for (const [live, reason] of [
    [{ stillOpen: false, balanceMinor: 9000, dayPastDue: 7, invoiceStatus: "past_due" }, "invoice_no_longer_open"],
    [{ stillOpen: true, balanceMinor: 0, dayPastDue: 7, invoiceStatus: "past_due" }, "invoice_no_longer_owes"],
    [{ stillOpen: true, balanceMinor: null, dayPastDue: 7, invoiceStatus: "past_due" }, "invoice_no_longer_owes"],
    [{ stillOpen: true, balanceMinor: 9000, dayPastDue: 8, invoiceStatus: "past_due" }, "day_past_due_changed_since_planning"],
  ] as const) {
    const led = fakeLedger();
    let sends = 0;
    const action = planned();
    const result = await dispatchCatchupSend(action, action.sends[0], context("sms") as never,
      io({ ledger: led.ledger, confirmStillDue: async () => live as never,
        attemptSend: async () => { sends += 1; return OK as never; } }));
    assert.equal(result.state, "refused", reason);
    if (result.state !== "refused") continue;
    assert.ok(result.reasons.includes(reason), `${reason}: ${result.reasons.join(",")}`);
    assert.equal(led.reserved.length, 0, "a stale invoice must cost no reservation");
    assert.equal(sends, 0);
  }
});

test("a failed live read stops the send rather than assuming still due", async () => {
  const action = planned();
  const result = await dispatchCatchupSend(action, action.sends[0], context("sms") as never,
    io({ confirmStillDue: async () => { throw new Error("jobber down"); } }));
  assert.equal(result.state, "refused");
  if (result.state !== "refused") return;
  assert.ok(result.reasons.includes("live_invoice_read_failed"), result.reasons.join(","));
});

test("the live look happens once per invoice, in order", async () => {
  const seen: string[] = [];
  const action = planned({
    invoices: [invoice(), invoice({ invoiceId: "inv-7286", invoiceNumber: "7286", dueOn: "2026-11-19" })],
  });
  await dispatchCatchupSend(action, action.sends[0], context("sms") as never, io({
    confirmStillDue: async (id: string) => {
      seen.push(id);
      return { stillOpen: true, balanceMinor: 9000, dayPastDue: id === "inv-7272" ? 7 : 5, invoiceStatus: "past_due" };
    },
  }));
  assert.deepEqual(seen, ["inv-7272", "inv-7286"]);
});

test("A REJECTED OR TIMED-OUT ATTEMPT IS NEVER RETRIED, AND READS AS UNKNOWN", async () => {
  for (const observation of [
    { version: VER, statusCode: 500, body: {} },
    { version: VER, statusCode: 429, body: {} },
    { version: VER, statusCode: 201, body: "not json" },
    { version: VER, statusCode: 201, body: {} },
    { version: VER, statusCode: 201, body: { messageId: "m-1" } },   // no conversationId
    { version: "nope", statusCode: 201, body: { messageId: "m-1", conversationId: "c-1" } },
  ]) {
    const led = fakeLedger();
    let sends = 0;
    const action = planned();
    const result = await dispatchCatchupSend(action, action.sends[0], context("sms") as never,
      io({ ledger: led.ledger,
        attemptSend: async () => { sends += 1; return observation as never; } }));
    assert.equal(sends, 1, `one attempt only: ${observation.statusCode}`);
    assert.equal(result.state, "incomplete", String(observation.statusCode));
    if (result.state !== "incomplete") continue;
    assert.ok(result.reasons.includes("send_attempt_left_incomplete"), result.reasons.join(","));
    assert.deepEqual(led.outcomes, ["unknown"], "never accepted without the provider's own id");
  }
});

test("a thrown attempt is also final, and recorded unknown", async () => {
  const led = fakeLedger();
  const action = planned();
  const result = await dispatchCatchupSend(action, action.sends[0], context("sms") as never,
    io({ ledger: led.ledger, attemptSend: async () => { throw new Error("socket hang up"); } }));
  assert.equal(result.state, "incomplete");
  assert.deepEqual(led.outcomes, ["unknown"]);
});

test("a text with no opt-out policy is refused, before the ledger is touched", async () => {
  const led = fakeLedger();
  const action = planned();
  const result = await dispatchCatchupSend(action, action.sends[0],
    context("sms", { smsReceiptSuffixPolicy: undefined }) as never, io({ ledger: led.ledger }));
  assert.equal(result.state, "refused");
  if (result.state !== "refused") return;
  assert.ok(result.reasons.includes("sms_receipt_suffix_policy_required"), result.reasons.join(","));
  assert.equal(led.reserved.length, 0);
});

test("an email carrying an SMS suffix policy is refused", async () => {
  const action = planned();
  const result = await dispatchCatchupSend(action, action.sends[1],
    context("email", { smsReceiptSuffixPolicy: suffixPolicy }) as never, io());
  assert.equal(result.state, "refused");
  if (result.state !== "refused") return;
  assert.ok(result.reasons.includes("sms_receipt_suffix_policy_must_not_apply_to_email"), result.reasons.join(","));
});

test("an unapproved sender sends nothing and reserves nothing", async () => {
  const led = fakeLedger();
  const action = planned();
  const result = await dispatchCatchupSend(action, action.sends[0],
    context("sms", { senderReview: { ...senderReview("sms"), approved: false } }) as never,
    io({ ledger: led.ledger }));
  assert.equal(result.state, "refused");
  assert.equal(led.reserved.length, 0, "a construction failure must cost no reservation");
});

test("a malformed run date is refused", async () => {
  for (const bad of ["24-11-2026", "2026-13-01x", "today", ""]) {
    const action = planned();
    const result = await dispatchCatchupSend(action, action.sends[0],
      context("sms", { scheduledOn: bad }) as never, io());
    assert.equal(result.state, "refused", bad);
  }
});

test("structural refusals: no reservations, a bad channel, a non-send action", async () => {
  const action = planned();
  const empty = await dispatchCatchupSend(action,
    { ...action.sends[0], reservations: [] } as never, context("sms") as never, io());
  assert.equal(empty.state, "refused");
  if (empty.state === "refused") assert.ok(empty.reasons.includes("no_reservations_planned"));

  const voice = await dispatchCatchupSend(action,
    { ...action.sends[0], channel: "voice" } as never, context("sms") as never, io());
  assert.equal(voice.state, "refused");
  if (voice.state === "refused") assert.ok(voice.reasons.includes("channel_is_not_a_catchup_channel"));

  const held = await dispatchCatchupSend({ state: "hold" } as never, action.sends[0],
    context("sms") as never, io());
  assert.equal(held.state, "refused");
});

// ---------------------------------------------------------------------------
// THE REAL LEDGER, NOT A PERMISSIVE FAKE.
//
// The fake above answers `markPending` with true whether or not the claim was
// ever asserted. The real ledger does not: `markPending` only accepts a handle
// it has verified, so a dispatcher that skips `assertReserved` strands every
// row in "reserved" and sends nothing. That is what happened in production on
// 2026-11-24 - 31 rows claimed, 31 refused at pending, no message sent - and
// no test here could see it, because no test used the real phase machine.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown> & { id: string; state: string };

/** An in-memory stand-in for the three unique indexes and the state column. */
function memoryLedgerDatabase() {
  const rows: Row[] = [];
  const statements: string[] = [];
  const key = (r: Row) => String(r.eventKey);
  const perInvoice = (r: Row) => [r.accountId, r.invoiceId, r.dayPastDue, r.audience, r.channel].join("|");
  const perContact = (r: Row) => [r.accountId, r.contactId, r.scheduledOn, r.channel].join("|");
  const find = (p: readonly unknown[]) => rows.find(r => r.id === p[0] && r.reservationToken === p[1]
    && r.eventHash === p[2] && r.bodyHash === p[3] && r.destinationHash === p[4]);
  return {
    rows, statements,
    database: {
      async transaction<T>(work: (tx: { query: (s: string, p: readonly unknown[]) => Promise<Array<{ id: unknown }>> }) => Promise<T>): Promise<T> {
        return work({
          query: async (statement: string, p: readonly unknown[]) => {
            statements.push(statement.split("\n")[0].trim());
            if (statement.includes("notification-ledger:reserve")) {
              const row: Row = { id: String(p[0]), reservationToken: p[1], eventKey: p[2], accountId: p[3],
                invoiceId: p[4], dayPastDue: p[5], audience: p[6], contactId: p[7], scheduledOn: p[8],
                channel: p[9], eventPayload: p[10], body: p[11], destination: p[12],
                eventHash: p[13], bodyHash: p[14], destinationHash: p[15], state: "reserved" };
              // ON CONFLICT DO NOTHING across all three unique indexes.
              if (rows.some(r => key(r) === key(row) || perInvoice(r) === perInvoice(row) || perContact(r) === perContact(row))) {
                return [];
              }
              rows.push(row);
              return [{ id: row.id }];
            }
            if (statement.includes("notification-ledger:assert")) {
              const row = find(p);
              return row && row.state === "reserved" ? [{ id: row.id }] : [];
            }
            if (statement.includes("notification-ledger:pending")) {
              const row = find(p);
              if (!row || row.state !== "reserved") return [];
              row.state = "pending";
              return [{ id: row.id }];
            }
            if (statement.includes("notification-ledger:outcome")) {
              const row = find(p);
              if (!row || row.state !== "pending") return [];
              row.state = String(p[5]);
              return [{ id: row.id }];
            }
            throw new Error(`unexpected statement: ${statement}`);
          },
        });
      },
    },
  };
}

test("AGAINST THE REAL LEDGER: the claim is asserted, marked pending, and sent once", async () => {
  const { createNotificationLedger } = await import("../lib/notification-ledger");
  const db = memoryLedgerDatabase();
  const ledger = createNotificationLedger(db.database as never);
  const action = planned();
  const sent: unknown[] = [];

  const result = await dispatchCatchupSend(action, action.sends[0], context("sms") as never,
    io({ ledger: ledger as never, attemptSend: async (d: never) => { sent.push(d); return OK as never; } }));

  assert.equal(result.state, "sent", JSON.stringify(result));
  assert.equal(sent.length, 1, "exactly one attempt");
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].state, "accepted", "the row must reach a terminal state, not sit in reserved");

  // The order matters: a pending that precedes its assertion is the bug.
  const order = db.statements.map(s => s.replace(/^\/\* notification-ledger:(\w+).*$/, "$1"));
  assert.deepEqual(order, ["reserve", "assert", "pending", "outcome"], order.join(" -> "));
});

test("AGAINST THE REAL LEDGER: a two-invoice customer sends, on one row naming both", async () => {
  // The per-contact unique index is one message per contact, per day, per
  // channel, so a row per invoice is impossible: the second is refused and the
  // first cannot be released. One row per MESSAGE fits the index exactly, and
  // the row names both invoices. Run against the real ledger, because this is
  // precisely the case a permissive fake said was fine and production did not.
  const { createNotificationLedger } = await import("../lib/notification-ledger");
  const db = memoryLedgerDatabase();
  const ledger = createNotificationLedger(db.database as never);

  const two: CatchupRecipientInput = {
    accountId: ACCOUNT, jobberClientId: "client-2", clientName: "Two Invoices",
    contactId: CONTACT, exactContactMatches: 1, phone: PHONE, email: EMAIL,
    smsOptedOut: false, emailOptedOut: false,
    invoices: [
      { invoiceId: "inv-a", invoiceNumber: "9001", balanceMinor: 5000, dueOn: "2026-11-17", payLink: LINK },
      { invoiceId: "inv-b", invoiceNumber: "9002", balanceMinor: 6000, dueOn: "2026-11-16", payLink: LINK },
    ],
  };
  const action = planCatchupRecipient(two, SEND_ON);
  assert.equal(action.state, "send", JSON.stringify(action));
  if (action.state !== "send") return;

  const sent: unknown[] = [];
  const live: Record<string, { stillOpen: boolean; balanceMinor: number; dayPastDue: number; invoiceStatus: string }> = {
    "inv-a": { stillOpen: true, balanceMinor: 5000, dayPastDue: 7, invoiceStatus: "past_due" },
    "inv-b": { stillOpen: true, balanceMinor: 6000, dayPastDue: 8, invoiceStatus: "past_due" },
  };
  const result = await dispatchCatchupSend(action, action.sends[0], context("sms") as never,
    io({ ledger: ledger as never,
      confirmStillDue: (async (id: string) => live[id]) as never,
      attemptSend: async (d: never) => { sent.push(d); return OK as never; } }));

  assert.equal(result.state, "sent", JSON.stringify(result));
  assert.equal(sent.length, 1, "exactly one text for the two invoices");
  assert.equal(db.rows.length, 1, "recorded on exactly one row");
  assert.equal(db.rows[0].state, "accepted", "and that row reaches a terminal state");
  assert.equal(db.rows[0].invoiceId, "inv-a", "identity from the first covered invoice");

  // The row must say what the message really covered, or a later reader would
  // believe only #9001 was ever mentioned to this customer.
  const payload = JSON.parse(String(db.rows[0].eventPayload));
  assert.deepEqual(payload.coversInvoiceNumbers, ["9001", "9002"]);
  assert.equal(payload.coversBalanceMinor, 11000);
});

// ---- THE SEND-TIME STATUS CHECK ------------------------------------------
//
// Added 2026-11-25, after an audit of the Nov 24 catch-up asked whether a paid
// customer could be texted. The last live look already read every invoice's
// status from the source and then looked only at its balance. A balance is not
// a status: Jobber reports `paid` invoices that still carry one - the status
// refresh treats exactly that pair as a conflict needing review - and reports
// `void`, `draft` and `bad_debt` invoices that may carry one too.

test("AN INVOICE THE SOURCE CALLS PAID IS NEVER SENT ON, WHATEVER ITS BALANCE", async () => {
  for (const invoiceStatus of ["paid", "PAID", " Paid "]) {
    const led = fakeLedger();
    let sends = 0;
    const action = planned();
    // Everything else agrees with the plan: open, owing the planned figure, on
    // the planned day. Only the status says this invoice is settled.
    const result = await dispatchCatchupSend(action, action.sends[0], context("sms") as never,
      io({ ledger: led.ledger,
        confirmStillDue: async () => ({ stillOpen: true, balanceMinor: 9000, dayPastDue: 7, invoiceStatus }),
        attemptSend: async () => { sends += 1; return OK as never; } }));
    assert.equal(result.state, "refused", invoiceStatus);
    if (result.state !== "refused") continue;
    assert.ok(result.reasons.includes("invoice_is_paid_at_send_time"),
      `${invoiceStatus}: ${result.reasons.join(",")}`);
    assert.equal(sends, 0, "nothing sent");
    assert.equal(led.reserved.length, 0, "and it costs no reservation");
  }
});

test("a status the source does not call open stops the send too", async () => {
  // Not just paid. None of these is a thing to send a past-due notice about,
  // and an unreadable status is not evidence that anything is owed.
  for (const invoiceStatus of ["void", "draft", "bad_debt", "", "   ", null, "something_new"]) {
    const led = fakeLedger();
    let sends = 0;
    const action = planned();
    const result = await dispatchCatchupSend(action, action.sends[0], context("sms") as never,
      io({ ledger: led.ledger,
        confirmStillDue: async () => ({ stillOpen: true, balanceMinor: 9000, dayPastDue: 7, invoiceStatus }),
        attemptSend: async () => { sends += 1; return OK as never; } }));
    assert.equal(result.state, "refused", String(invoiceStatus));
    if (result.state !== "refused") continue;
    assert.ok(result.reasons.includes("invoice_status_is_not_sendable_at_send_time"),
      `${invoiceStatus}: ${result.reasons.join(",")}`);
    assert.equal(sends, 0, String(invoiceStatus));
    assert.equal(led.reserved.length, 0, String(invoiceStatus));
  }
});

test("the status check does not depend on the adapter's own stillOpen", async () => {
  // The point of reading the status here rather than trusting `stillOpen`: an
  // adapter that computes it from the balance alone - which is exactly what
  // this repo's own adapter did until today - cannot smuggle a paid invoice
  // past this step by answering true.
  const led = fakeLedger();
  let sends = 0;
  const action = planned();
  const result = await dispatchCatchupSend(action, action.sends[0], context("sms") as never,
    io({ ledger: led.ledger,
      confirmStillDue: async () => ({ stillOpen: true, balanceMinor: 9000, dayPastDue: 7, invoiceStatus: "paid" }),
      attemptSend: async () => { sends += 1; return OK as never; } }));
  assert.equal(result.state, "refused");
  assert.equal(sends, 0);
});

test("the two open statuses still send", async () => {
  for (const invoiceStatus of SENDABLE_INVOICE_STATUSES) {
    const action = planned();
    const result = await dispatchCatchupSend(action, action.sends[0], context("sms") as never,
      io({ confirmStillDue: async () => ({ stillOpen: true, balanceMinor: 9000, dayPastDue: 7, invoiceStatus }) }));
    assert.equal(result.state, "sent", `${invoiceStatus}: ${JSON.stringify(result)}`);
  }
});

test("one paid invoice in a two-invoice message stops the whole message", async () => {
  // The message names both, so sending it with one of them settled would put a
  // wrong figure in a customer's hand. Both halves are refused, and neither
  // costs a reservation.
  const led = fakeLedger();
  let sends = 0;
  const action = planned({
    invoices: [invoice(), invoice({ invoiceId: "inv-7286", invoiceNumber: "7286", dueOn: "2026-11-19" })],
  });
  const result = await dispatchCatchupSend(action, action.sends[0], context("sms") as never,
    io({ ledger: led.ledger,
      confirmStillDue: async (id: string) => ({ stillOpen: true, balanceMinor: 9000,
        dayPastDue: id === "inv-7272" ? 7 : 5,
        invoiceStatus: id === "inv-7286" ? "paid" : "past_due" }),
      attemptSend: async () => { sends += 1; return OK as never; } }));
  assert.equal(result.state, "refused", JSON.stringify(result));
  if (result.state !== "refused") return;
  assert.ok(result.reasons.includes("invoice_is_paid_at_send_time"), result.reasons.join(","));
  assert.equal(sends, 0);
  assert.equal(led.reserved.length, 0);
});
