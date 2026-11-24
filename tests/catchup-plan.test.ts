import test from "node:test";
import assert from "node:assert/strict";
import {
  CATCHUP_CHANNELS, catchupDayPastDue, planCatchupBatch, planCatchupRecipient,
  type CatchupRecipientInput,
} from "../lib/catchup-plan";
import { CATCHUP_PAY_LINK_HOST } from "../lib/catchup-copy";
import { planKeyOfEventKey } from "../lib/notification-gate";

const LINK = `https://${CATCHUP_PAY_LINK_HOST}/client_hubs/abc123/invoices/def456`;
const SEND_ON = "2026-11-24";

const invoice = (over: Record<string, unknown> = {}) => ({
  invoiceId: "Z2lkOi8vSm9iYmVyL0ludm9pY2UvMQ", invoiceNumber: "7272",
  balanceMinor: 9000, dueOn: "2026-11-17", payLink: LINK, ...over,
});

const recipient = (over: Partial<CatchupRecipientInput> = {}): CatchupRecipientInput => ({
  accountId: "acct-1", jobberClientId: "client-1", clientName: "Jessica Noonan",
  contactId: "contact-abc123", exactContactMatches: 1,
  phone: "+16025550100", email: "jessica@example.test",
  smsOptedOut: false, emailOptedOut: false,
  invoices: [invoice()],
  ...over,
});

test("a clean recipient gets one text and one email, same words", () => {
  const action = planCatchupRecipient(recipient(), SEND_ON);
  assert.equal(action.state, "send");
  if (action.state !== "send") return;
  assert.deepEqual(action.sends.map(s => s.channel), [...CATCHUP_CHANNELS]);
  assert.equal(action.sends[0].destination, "+16025550100");
  assert.equal(action.sends[1].destination, "jessica@example.test");
  assert.match(action.body, /invoice #7272 for \$90\.00 is 7 days past due/);
  assert.equal(action.subject, "Invoice #7272 is 7 days past due");
});

test("EVERY ROW IS RECORDED AT ITS REAL DAY NUMBER", () => {
  // 2026-11-17 due, sent 2026-11-24 -> day 7. Not a ladder rung, and that is
  // the point: the catch-up records what actually happened, not a rung.
  const action = planCatchupRecipient(recipient(), SEND_ON);
  assert.equal(action.state, "send");
  if (action.state !== "send") return;
  for (const send of action.sends) {
    assert.equal(send.reservations.length, 1);
    assert.equal(send.reservations[0].dayPastDue, 7);
    assert.equal(send.reservations[0].dueOn, "2026-11-17");
  }
});

test("the two channels get DIFFERENT event keys, so both can be reserved", () => {
  const action = planCatchupRecipient(recipient(), SEND_ON);
  assert.equal(action.state, "send");
  if (action.state !== "send") return;
  const [sms, email] = action.sends;
  const smsKey = sms.reservations[0].eventKey;
  const emailKey = email.reservations[0].eventKey;
  assert.notEqual(smsKey, emailKey, "a channel-blind key would make the pair one send");
  // The key is the ledger's identity, so assert its real shape rather than a
  // parsed view of it.
  assert.deepEqual(JSON.parse(smsKey),
    ["notification-v2", "acct-1", "Z2lkOi8vSm9iYmVyL0ludm9pY2UvMQ", 7, "homeowner", "sms"]);
  assert.deepEqual(JSON.parse(emailKey),
    ["notification-v2", "acct-1", "Z2lkOi8vSm9iYmVyL0ludm9pY2UvMQ", 7, "homeowner", "email"]);
  // And both share one plan key, so the pair is one planned milestone.
  assert.equal(planKeyOfEventKey(smsKey), planKeyOfEventKey(emailKey));
});

test("two invoices are ONE message but FOUR reservations", () => {
  const action = planCatchupRecipient(recipient({
    clientName: "Elizabeth Brungs",
    invoices: [
      invoice({ invoiceId: "inv-7304", invoiceNumber: "7304", balanceMinor: 35000, dueOn: "2026-11-20" }),
      invoice({ invoiceId: "inv-7286", invoiceNumber: "7286", balanceMinor: 13700, dueOn: "2026-11-19" }),
    ],
  }), SEND_ON);
  assert.equal(action.state, "send");
  if (action.state !== "send") return;
  assert.equal(action.sends.length, 2, "one text and one email");
  const total = action.sends.reduce((n, s) => n + s.reservations.length, 0);
  assert.equal(total, 4, "two invoices on two channels");
  // Each invoice keeps its OWN real day count inside the one message.
  const sms = action.sends[0].reservations;
  assert.equal(sms.find(r => r.invoiceNumber === "7304")!.dayPastDue, 4);
  assert.equal(sms.find(r => r.invoiceNumber === "7286")!.dayPastDue, 5);
  assert.match(action.body, /#7304 for \$350\.00 \(4 days\) and #7286 for \$137\.00 \(5 days\)/);
});

test("an ambiguous or missing contact holds, it never guesses", () => {
  for (const [matches, reason] of [[0, "no_exact_ghl_contact"], [2, "ambiguous_destination_contacts"],
    [3, "ambiguous_destination_contacts"]] as const) {
    const action = planCatchupRecipient(recipient({ exactContactMatches: matches }), SEND_ON);
    assert.equal(action.state, "hold", String(matches));
    if (action.state !== "hold") continue;
    assert.ok(action.reasons.includes(reason), action.reasons.join(","));
  }
});

test("AN OPT-OUT ON EITHER CHANNEL HOLDS BOTH HALVES", () => {
  // Half a pair is not the approved message, so an SMS opt-out does not
  // silently become an email-only send.
  const noSms = planCatchupRecipient(recipient({ smsOptedOut: true }), SEND_ON);
  assert.equal(noSms.state, "hold");
  if (noSms.state === "hold") assert.ok(noSms.reasons.includes("contact_opted_out_of_sms"));
  const noEmail = planCatchupRecipient(recipient({ emailOptedOut: true }), SEND_ON);
  assert.equal(noEmail.state, "hold");
  if (noEmail.state === "hold") assert.ok(noEmail.reasons.includes("contact_opted_out_of_email"));
});

test("a missing phone or email holds, rather than sending one half", () => {
  for (const [over, reason] of [
    [{ phone: null }, "no_phone_on_contact"],
    [{ phone: "   " }, "no_phone_on_contact"],
    [{ email: null }, "no_email_on_contact"],
  ] as const) {
    const action = planCatchupRecipient(recipient(over as Partial<CatchupRecipientInput>), SEND_ON);
    assert.equal(action.state, "hold", JSON.stringify(over));
    if (action.state !== "hold") continue;
    assert.ok(action.reasons.includes(reason), action.reasons.join(","));
  }
});

test("an invoice that is not past due today is not a catch-up candidate", () => {
  const action = planCatchupRecipient(recipient({
    invoices: [invoice({ dueOn: SEND_ON })],
  }), SEND_ON);
  assert.equal(action.state, "hold");
  if (action.state !== "hold") return;
  assert.ok(action.reasons.includes("day_past_due_unresolvable")
    || action.reasons.includes("invoice_is_not_past_due"), action.reasons.join(","));
});

test("an unrenderable message holds the recipient", () => {
  const action = planCatchupRecipient(recipient({
    invoices: [invoice({ payLink: null })],
  }), SEND_ON);
  assert.equal(action.state, "hold");
  if (action.state !== "hold") return;
  assert.ok(action.reasons.includes("message_could_not_be_rendered_completely"), action.reasons.join(","));
});

test("a contact id that is not a plain token is refused", () => {
  for (const id of [null, "", "  ", "ab", "has space", "semi;colon", "a".repeat(65)]) {
    const action = planCatchupRecipient(recipient({ contactId: id as string }), SEND_ON);
    assert.equal(action.state, "hold", String(id));
  }
});

test("the day count matches the ledger's own calendar arithmetic", () => {
  assert.equal(catchupDayPastDue("2026-11-17", "2026-11-24"), 7);
  assert.equal(catchupDayPastDue("2026-11-23", "2026-11-24"), 1);
  assert.equal(catchupDayPastDue("2026-11-24", "2026-11-24"), null, "same day is not past due");
  assert.equal(catchupDayPastDue("2026-11-25", "2026-11-24"), null, "future due date");
  assert.equal(catchupDayPastDue("not-a-date", "2026-11-24"), null);
});

test("the batch summary counts messages, not invoices", () => {
  const plan = planCatchupBatch([
    recipient(),
    recipient({ jobberClientId: "client-2", clientName: "Elizabeth Brungs", invoices: [
      invoice({ invoiceId: "inv-7304", invoiceNumber: "7304", balanceMinor: 35000, dueOn: "2026-11-20" }),
      invoice({ invoiceId: "inv-7286", invoiceNumber: "7286", balanceMinor: 13700, dueOn: "2026-11-19" }),
    ] }),
    recipient({ jobberClientId: "client-3", exactContactMatches: 2 }),
  ], SEND_ON);
  assert.deepEqual(plan.summary, { send: 2, hold: 1, texts: 2, emails: 2, invoices: 3 });
});
