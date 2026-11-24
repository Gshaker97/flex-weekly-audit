import test from "node:test";
import assert from "node:assert/strict";
import { dispatchCatchupSend, type CatchupDispatchIO } from "../lib/catchup-dispatch";
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
  const reserved: { invoiceId: string; dayPastDue: number; channel: string; body: string }[] = [];
  const outcomes: string[] = [];
  let pending = 0;
  const ledger = {
    async reserve(input: any) {
      if (opts.refuseOn && input.event.invoiceId === opts.refuseOn) {
        return { state: "held" as const, reason: "already_claimed" as const };
      }
      reserved.push({ invoiceId: input.event.invoiceId, dayPastDue: input.event.dayPastDue,
        channel: input.channel, body: input.body });
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
    ?? (async () => ({ stillOpen: true, balanceMinor: 9000, dayPastDue: 7 })),
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
        dayPastDue: id === "inv-7272" ? 7 : 5 }),
      attemptSend: async () => { sends += 1; return OK as never; } }));
  assert.equal(result.state, "sent", JSON.stringify(result));
  assert.equal(led.reserved.length, 2, "one row per invoice");
  assert.equal(sends, 1, "but only ONE text");
  assert.deepEqual(led.outcomes, ["accepted", "accepted"], "both rows get the outcome");
  assert.deepEqual(led.reserved.map(r => r.dayPastDue), [7, 5], "each at its own real day");
});

test("IF THE SECOND ROW CANNOT BE TAKEN, NOTHING IS SENT", async () => {
  const led = fakeLedger({ refuseOn: "inv-7286" });
  let sends = 0;
  const action = planned({
    invoices: [invoice(), invoice({ invoiceId: "inv-7286", invoiceNumber: "7286", dueOn: "2026-11-19" })],
  });
  const result = await dispatchCatchupSend(action, action.sends[0], context("sms") as never,
    io({ ledger: led.ledger,
      confirmStillDue: async (id: string) => ({ stillOpen: true, balanceMinor: 9000,
        dayPastDue: id === "inv-7272" ? 7 : 5 }),
      attemptSend: async () => { sends += 1; return OK as never; } }));
  assert.equal(sends, 0, "a customer must never get a message we failed to record");
  assert.equal(result.state, "incomplete");
  if (result.state !== "incomplete") return;
  // And the row that WAS taken is reported, because it can never be released.
  assert.deepEqual([...result.strandedInvoiceNumbers], ["7272"]);
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
    [{ stillOpen: false, balanceMinor: 9000, dayPastDue: 7 }, "invoice_no_longer_open"],
    [{ stillOpen: true, balanceMinor: 0, dayPastDue: 7 }, "invoice_no_longer_owes"],
    [{ stillOpen: true, balanceMinor: null, dayPastDue: 7 }, "invoice_no_longer_owes"],
    [{ stillOpen: true, balanceMinor: 9000, dayPastDue: 8 }, "day_past_due_changed_since_planning"],
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
      return { stillOpen: true, balanceMinor: 9000, dayPastDue: id === "inv-7272" ? 7 : 5 };
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
