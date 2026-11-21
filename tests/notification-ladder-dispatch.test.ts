import test from "node:test";
import assert from "node:assert/strict";
import {
  dispatchLadderSend, dispatchLadderTask, dispatchLadderAction,
  type LadderDispatchIO, type LadderSendContext,
} from "../lib/notification-ladder-dispatch";
import { planLadderStep, type LadderStepInput, type LadderAction } from "../lib/notification-ladder-plan";
import { parseGhlRecipient } from "../lib/notification-ghl-contract";
import { notificationBodyDigest, type NotificationLedgerEvent } from "../lib/notification-ledger";
import { DAY20_SMS_BODY } from "../lib/notification-ladder-copy";

/**
 * The half that acts.
 *
 * Almost every test here is about ORDER, because the order is the safety. A
 * text must not leave the building before the ledger has handed over a
 * reservation AND accepted it as pending; if either refuses, the customer is
 * not texted. And one attempt means one attempt: a timeout is recorded as
 * unknown and reported, never tried again.
 */

const ACCOUNT = "account-1";
const LOCATION = "location-1";
const CONTACT = "contact-1";
const PHONE = "+14805550000";
const SENDER = "+16025550000";
const TODAY = "2026-11-19";

const senderReview = {
  accountId: ACCOUNT, locationId: LOCATION, channel: "sms" as const, sender: SENDER,
  scope: "conversations/message.write" as const, approved: true as const, validated: true as const,
  evidenceRef: "sender-approved-ref",
};
const review = {
  mode: "reviewed-construction-only" as const, version: "2021-07-28" as const,
  evidenceRef: "construction-review-ref", accountId: ACCOUNT, locationId: LOCATION,
  channel: "sms" as const, proposedStatus: "pending" as const,
};

/** A real consent read, produced by the contract rather than hand-made. */
const allowedRecipient = () => parseGhlRecipient({
  version: "2021-07-28",
  body: { contact: { id: CONTACT, locationId: LOCATION, phone: PHONE, dndSettings: {} } },
  expected: { accountId: ACCOUNT, locationId: LOCATION, contactId: CONTACT, channel: "sms", destination: PHONE },
});

const event = (over: Partial<NotificationLedgerEvent> = {}): NotificationLedgerEvent => ({
  accountId: ACCOUNT, invoiceId: "inv-1", dayPastDue: 20, audience: "homeowner",
  sourceRevision: "rev-1", ownerRevision: "own-1", ownerId: "owner-1", homeownerContactId: CONTACT,
  issuedDate: "2026-10-01", dueDate: "2026-10-15", balanceMinor: 16_000, currency: "USD",
  category: "maintenance", recipientId: CONTACT, contactId: CONTACT, channel: "sms",
  destination: PHONE, templateId: "ladder-day20", templateVersion: "1",
  bodyDigest: notificationBodyDigest(DAY20_SMS_BODY), claimedFacts: [], ...over,
});

const context = (over: Partial<LadderSendContext> = {}): LadderSendContext => ({
  event: event(), recipient: allowedRecipient(), senderReview, review, scheduledOn: TODAY, ...over,
});

const step = (over: Partial<LadderStepInput> = {}): LadderStepInput => ({
  dayPastDue: 20, category: "maintenance", scheduledOn: TODAY, today: TODAY,
  invoiceId: "inv-1", invoiceNumber: "7226", balanceMinor: 16_000, currency: "USD",
  invoiceIssuedOn: "2026-10-01", jobberClientId: "client-1",
  homeownerContactId: CONTACT, assignee: { userId: "angie", displayName: "Angie Wiggins", approvalRef: "ref" },
  holds: [], alreadySent: false, termsEvidence: null, suspensionEvidence: null, ...over,
});

const plannedSend = () => {
  const action = planLadderStep(step());
  assert.equal(action.kind, "send_sms");
  return action as Extract<LadderAction, { kind: "send_sms" }>;
};
const plannedTask = (day: 21 | 35) => {
  const action = planLadderStep(step({ dayPastDue: day }));
  assert.equal(action.kind, "create_task");
  return action as Extract<LadderAction, { kind: "create_task" }>;
};

type Ledger = {
  reserveResult: "reserved" | "already_claimed" | "ledger_uncertain";
  pending: boolean; outcomeAccepts: boolean;
  /** What the last live look reports as the current day past due. */
  confirmDay: number;
};

/** A ledger and a transport that record the exact order they were called in. */
function io(
  over: Partial<Ledger> = {}, send?: () => any, tasks?: Partial<LadderDispatchIO["tasks"]>,
  confirm?: LadderDispatchIO["confirmStillDue"],
) {
  const cfg: Ledger = { reserveResult: "reserved", pending: true, outcomeAccepts: true, confirmDay: 20, ...over };
  const order: string[] = [];
  const outcomes: any[] = [];
  const dispatchIO: LadderDispatchIO = {
    ledger: {
      reserve: async () => {
        order.push("reserve");
        return cfg.reserveResult === "reserved"
          ? { state: "reserved", reservation: { id: "r1", token: "t1", eventHash: "e", bodyHash: "b", destinationHash: "d" } }
          : { state: "held", reason: cfg.reserveResult } as any;
      },
      assertReserved: async () => true,
      markPending: async () => { order.push("markPending"); return cfg.pending; },
      markOutcome: async (_h, outcome) => { order.push(`markOutcome:${outcome.state}`); outcomes.push(outcome); return cfg.outcomeAccepts; },
    },
    confirmStillDue: confirm ?? (async () => {
      order.push("confirmStillDue");
      return { stillOpen: true, balanceMinor: 16_000, dayPastDue: cfg.confirmDay };
    }),
    attemptSend: async () => {
      order.push("attemptSend");
      return send ? send() : { version: "2021-07-28", statusCode: 201, body: { messageId: "msg-1", conversationId: "conv-1" } };
    },
    tasks: {
      list: async () => { order.push("tasks.list"); return []; },
      create: async () => { order.push("tasks.create"); return { state: "created_and_confirmed", reasons: [], httpStatus: 201, taskId: "task-1", descriptor: null } as any; },
      ...tasks,
    },
  };
  return { dispatchIO, order, outcomes };
}

// ------------------------------------------------- the consent read is real

test("the contract's own consent read is what gets used", () => {
  const recipient = allowedRecipient();
  assert.equal(recipient.state, "allowed", `reasons: ${JSON.stringify(recipient.reasons)}`);
});

// ----------------------------------------------------------- the happy order

test("a text goes out in exactly one order: reserve, pending, attempt, record", async () => {
  const { dispatchIO, order, outcomes } = io();
  const result = await dispatchLadderSend(plannedSend(), context(), dispatchIO);
  assert.equal(result.result, "sent", JSON.stringify(result.reasons));
  assert.equal(result.providerMessageId, "msg-1");
  assert.deepEqual(order, ["confirmStillDue", "reserve", "markPending", "attemptSend", "markOutcome:accepted"]);
  assert.deepEqual(outcomes, [{ state: "accepted", providerMessageId: "msg-1" }]);
});

test("the request carries the planned words to the planned number", async () => {
  let sentBody: any = null;
  const { dispatchIO } = io({}, undefined);
  const spy: LadderDispatchIO = { ...dispatchIO, attemptSend: async descriptor => {
    sentBody = JSON.parse(descriptor.serializedBody);
    assert.equal(descriptor.maximumAttempts, 1);
    assert.equal(descriptor.automaticRetry, false);
    assert.ok(!("Authorization" in (descriptor.headers as Record<string, string>)));
    // The contract requires BOTH ids: a message id without a conversation id is
    // not an acceptance.
    return { version: "2021-07-28", statusCode: 201, body: { messageId: "msg-1", conversationId: "conv-1" } };
  } };
  const result = await dispatchLadderSend(plannedSend(), context(), spy);
  assert.equal(result.result, "sent");
  assert.equal(sentBody.type, "SMS");
  assert.equal(sentBody.message, DAY20_SMS_BODY);
  assert.equal(sentBody.toNumber, PHONE);
  assert.equal(sentBody.fromNumber, SENDER);
});

// ----------------------------------- nothing is sent before the ledger agrees

test("if the ledger will not reserve, the customer is NOT texted", async () => {
  for (const reason of ["already_claimed", "ledger_uncertain"] as const) {
    const { dispatchIO, order } = io({ reserveResult: reason });
    const result = await dispatchLadderSend(plannedSend(), context(), dispatchIO);
    assert.equal(result.result, "held", reason);
    assert.deepEqual([...result.reasons], [`ledger_${reason}`]);
    assert.deepEqual(order, ["confirmStillDue", "reserve"], "no attempt may follow a refused reservation");
  }
});

test("if the ledger will not move to pending, the customer is NOT texted", async () => {
  const { dispatchIO, order } = io({ pending: false });
  const result = await dispatchLadderSend(plannedSend(), context(), dispatchIO);
  assert.equal(result.result, "held");
  assert.deepEqual([...result.reasons], ["ledger_would_not_move_to_pending"]);
  assert.deepEqual(order, ["confirmStillDue", "reserve", "markPending"]);
});

// ------------------------------------------- the event must describe the message

test("an event that does not match the planned message is refused, unsent", async () => {
  const cases: Array<[string, LadderSendContext]> = [
    ["event_channel_is_not_sms", context({ event: event({ channel: "email" }) })],
    ["event_day_does_not_match_the_plan", context({ event: event({ dayPastDue: 25 }) })],
    ["event_contact_does_not_match_the_plan", context({ event: event({ contactId: "someone-else" }) })],
    ["event_body_digest_does_not_match_the_words", context({ event: event({ bodyDigest: notificationBodyDigest("different words") }) })],
    ["scheduled_date_unusable", context({ scheduledOn: "19/11/2026" })],
  ];
  for (const [reason, ctx] of cases) {
    const { dispatchIO, order } = io();
    const result = await dispatchLadderSend(plannedSend(), ctx, dispatchIO);
    assert.equal(result.result, "held", reason);
    assert.ok(result.reasons.includes(reason), `${reason} -> ${JSON.stringify(result.reasons)}`);
    assert.deepEqual(order, [], "nothing may be reserved or sent");
  }
});

test("a hand-made consent read cannot be passed off as an allowed one", async () => {
  const forged = Object.freeze({ state: "allowed" as const, reasons: Object.freeze([]), productionSendCapability: false as const });
  const { dispatchIO, order } = io();
  const result = await dispatchLadderSend(plannedSend(), context({ recipient: forged }), dispatchIO);
  assert.equal(result.result, "held");
  assert.ok(result.reasons.includes("recipient_not_exact_parsed_allowed"));
  assert.deepEqual(order, []);
});

test("an unapproved sender cannot send", async () => {
  const { dispatchIO, order } = io();
  const result = await dispatchLadderSend(plannedSend(),
    context({ senderReview: { ...senderReview, approved: false as never } }), dispatchIO);
  assert.equal(result.result, "held");
  assert.ok(result.reasons.includes("sender_not_exact_validated_approved_scope"));
  assert.deepEqual(order, []);
});

// -------------------------------------------------- one attempt, never a retry

test("a timeout is recorded as unknown and never retried", async () => {
  const { dispatchIO, order, outcomes } = io({}, () => { throw Object.assign(new Error("x"), { name: "AbortError" }); });
  const result = await dispatchLadderSend(plannedSend(), context(), dispatchIO);
  assert.equal(result.result, "attempted_unconfirmed");
  assert.ok(result.reasons.includes("send_attempt_outcome_unknown"));
  assert.deepEqual(order, ["confirmStillDue", "reserve", "markPending", "attemptSend", "markOutcome:unknown"]);
  assert.equal(order.filter(o => o === "attemptSend").length, 1);
  assert.deepEqual(outcomes, [{ state: "unknown" }]);
});

test("a refusal or a 429 is recorded as unknown, with one attempt only", async () => {
  for (const statusCode of [429, 400, 401, 500, 503]) {
    const { dispatchIO, order } = io({}, () => ({ version: "2021-07-28", statusCode, body: {} }));
    const result = await dispatchLadderSend(plannedSend(), context(), dispatchIO);
    assert.equal(result.result, "attempted_unconfirmed", String(statusCode));
    assert.equal(order.filter(o => o === "attemptSend").length, 1, String(statusCode));
    assert.ok(order.includes("markOutcome:unknown"), String(statusCode));
  }
});

test("a 201 without BOTH provider ids is not a send", async () => {
  // GoHighLevel returns a message id and a conversation id. One without the
  // other is not an acceptance, so it is recorded as unknown, not as sent.
  for (const body of [{}, { messageId: "msg-1" }, { conversationId: "conv-1" }]) {
    const { dispatchIO, order } = io({}, () => ({ version: "2021-07-28", statusCode: 201, body }));
    const result = await dispatchLadderSend(plannedSend(), context(), dispatchIO);
    assert.equal(result.result, "attempted_unconfirmed", JSON.stringify(body));
    assert.equal(result.providerMessageId, null);
    assert.ok(order.includes("markOutcome:unknown"));
  }
});

test("a ledger that will not record a successful send reports it, keeping the id", async () => {
  const { dispatchIO } = io({ outcomeAccepts: false });
  const result = await dispatchLadderSend(plannedSend(), context(), dispatchIO);
  assert.equal(result.result, "attempted_unconfirmed");
  assert.deepEqual([...result.reasons], ["ledger_would_not_record_the_outcome"]);
  assert.equal(result.providerMessageId, "msg-1", "the message went out; say so with its id");
});

// ----------------------------------------------------------------- tasks

test("a task is created after checking for one that is already open", async () => {
  const { dispatchIO, order } = io({ confirmDay: 21 });
  const result = await dispatchLadderTask(plannedTask(21), dispatchIO);
  assert.equal(result.result, "task_created");
  assert.equal(result.taskId, "task-1");
  assert.deepEqual(order, ["confirmStillDue", "tasks.list", "tasks.create"]);
});

test("an open task for the same invoice and day stops a duplicate", async () => {
  const { dispatchIO, order } = io({ confirmDay: 21 }, undefined, {
    list: async () => [{ id: "t0", title: "Call about past-due invoice #7226 (USD 160.00, day 21)", completed: false }],
  });
  const result = await dispatchLadderTask(plannedTask(21), dispatchIO);
  assert.equal(result.result, "held");
  assert.deepEqual([...result.reasons], ["task_already_open_for_this_invoice_and_day"]);
  assert.ok(!order.includes("tasks.create"));
});

test("a COMPLETED task does not block the next one, and another day does not either", async () => {
  const done = { id: "t0", title: "Call about past-due invoice #7226 (USD 160.00, day 21)", completed: true };
  const otherDay = { id: "t1", title: "Decide on collections for past-due invoice #7226 (USD 160.00, day 35)", completed: false };
  const { dispatchIO } = io({ confirmDay: 21 }, undefined, { list: async () => [done, otherDay] });
  assert.equal((await dispatchLadderTask(plannedTask(21), dispatchIO)).result, "task_created");
});

test("if the existing tasks cannot be read, no task is created", async () => {
  // An unread list is not an empty one, and a duplicate task means a colleague
  // calls the same customer twice.
  const { dispatchIO, order } = io({ confirmDay: 21 }, undefined, { list: async () => { throw new Error("boom"); } });
  const result = await dispatchLadderTask(plannedTask(21), dispatchIO);
  assert.equal(result.result, "held");
  assert.deepEqual([...result.reasons], ["could_not_read_existing_tasks"]);
  assert.ok(!order.includes("tasks.create"));
});

test("an unconfirmed task attempt is reported as unconfirmed", async () => {
  const { dispatchIO } = io({ confirmDay: 35 }, undefined, {
    create: async () => ({ state: "attempted_unconfirmed", reasons: ["internal_task_http_429"], httpStatus: 429, taskId: null, descriptor: null }) as any,
  });
  const result = await dispatchLadderTask(plannedTask(35), dispatchIO);
  assert.equal(result.result, "attempted_unconfirmed");
  assert.deepEqual([...result.reasons], ["internal_task_http_429"]);
});

// ------------------------------------------------------------ the router

test("holds and not-due actions need no transport at all", async () => {
  const { dispatchIO, order } = io();
  const held = await dispatchLadderAction({ kind: "hold", dayPastDue: 20, reasons: ["contact_opted_out"] }, dispatchIO);
  assert.equal(held.result, "held");
  assert.deepEqual([...held.reasons], ["contact_opted_out"]);
  const notDue = await dispatchLadderAction({ kind: "not_due", dayPastDue: 25, reason: "future" }, dispatchIO);
  assert.equal(notDue.result, "not_due");
  assert.deepEqual(order, []);
});

test("a planned send with no established context is held, not sent on assumptions", async () => {
  const { dispatchIO, order } = io();
  const result = await dispatchLadderAction(plannedSend(), dispatchIO);
  assert.equal(result.result, "held");
  assert.deepEqual([...result.reasons], ["no_send_context_established"]);
  assert.deepEqual(order, []);
});

test("the router sends and creates tasks through the same checks", async () => {
  const send = io();
  assert.equal((await dispatchLadderAction(plannedSend(), send.dispatchIO, context())).result, "sent");
  const task = io({ confirmDay: 21 });
  assert.equal((await dispatchLadderAction(plannedTask(21), task.dispatchIO)).result, "task_created");
});

test("a malformed action or missing transport is held", async () => {
  const { dispatchIO } = io();
  for (const bad of [null, undefined, 42, { kind: "nonsense" }]) {
    assert.equal((await dispatchLadderAction(bad as never, dispatchIO)).result, "held");
  }
  assert.equal((await dispatchLadderSend(plannedSend(), context(), {} as never)).result, "held");
  assert.equal((await dispatchLadderTask(plannedTask(21), {} as never)).result, "held");
});


// ------------------------------------------------- the last look at the invoice

test("an invoice paid between planning and sending is NOT texted", async () => {
  const paid = async () => ({ stillOpen: false, balanceMinor: 0, dayPastDue: 20 });
  const { dispatchIO, order } = io({}, undefined, undefined, paid);
  const result = await dispatchLadderSend(plannedSend(), context(), dispatchIO);
  assert.equal(result.result, "held");
  assert.ok(result.reasons.includes("invoice_no_longer_open_at_send_time"));
  assert.ok(result.reasons.includes("invoice_no_longer_owes_at_send_time"));
  // Nothing was reserved, so nothing is left half-done in the ledger either.
  assert.deepEqual(order, []);
});

test("a balance that has gone to zero stops the send even if still 'open'", async () => {
  const settled = async () => ({ stillOpen: true, balanceMinor: 0, dayPastDue: 20 });
  const { dispatchIO } = io({}, undefined, undefined, settled);
  const result = await dispatchLadderSend(plannedSend(), context(), dispatchIO);
  assert.equal(result.result, "held");
  assert.deepEqual([...result.reasons], ["invoice_no_longer_owes_at_send_time"]);
});

test("if the live day number has moved, the planned words are the wrong words", async () => {
  // Day 25's text must never go out describing day 20, or the other way round.
  for (const dayPastDue of [19, 21, 25, null]) {
    const moved = async () => ({ stillOpen: true, balanceMinor: 16_000, dayPastDue });
    const { dispatchIO, order } = io({}, undefined, undefined, moved as never);
    const result = await dispatchLadderSend(plannedSend(), context(), dispatchIO);
    assert.equal(result.result, "held", String(dayPastDue));
    assert.ok(result.reasons.includes("days_past_due_changed_since_planning"), String(dayPastDue));
    assert.deepEqual(order, []);
  }
});

test("an unreadable last look refuses: not knowing is never a reason to send", async () => {
  const broken = async () => { throw new Error("jobber down"); };
  const { dispatchIO, order } = io({}, undefined, undefined, broken as never);
  const result = await dispatchLadderSend(plannedSend(), context(), dispatchIO);
  assert.equal(result.result, "held");
  assert.deepEqual([...result.reasons], ["could_not_confirm_the_invoice_is_still_due"]);
  assert.deepEqual(order, []);

  for (const junk of [null, undefined, "fine", 42]) {
    const { dispatchIO: io2 } = io({}, undefined, undefined, (async () => junk) as never);
    const result2 = await dispatchLadderSend(plannedSend(), context(), io2);
    assert.equal(result2.result, "held", JSON.stringify(junk));
  }
});

test("a dispatcher with no last look at all cannot send", async () => {
  const { dispatchIO } = io();
  const blind = { ...dispatchIO, confirmStillDue: undefined } as never;
  const result = await dispatchLadderSend(plannedSend(), context(), blind);
  assert.equal(result.result, "held");
  assert.deepEqual([...result.reasons], ["no_last_look_at_the_invoice_available"]);
});

test("nobody is asked to chase an invoice that was just paid", async () => {
  const paid = async () => ({ stillOpen: false, balanceMinor: 0, dayPastDue: 21 });
  const { dispatchIO, order } = io({}, undefined, undefined, paid);
  const result = await dispatchLadderTask(plannedTask(21), dispatchIO);
  assert.equal(result.result, "held");
  assert.ok(result.reasons.includes("invoice_no_longer_open_at_send_time"));
  assert.ok(!order.includes("tasks.create"));
  assert.ok(!order.includes("tasks.list"), "no need to read her list at all");
});

test("the task path checks the same day number", async () => {
  const confirm = async () => ({ stillOpen: true, balanceMinor: 16_000, dayPastDue: 21 });
  const { dispatchIO } = io({}, undefined, undefined, confirm);
  assert.equal((await dispatchLadderTask(plannedTask(21), dispatchIO)).result, "task_created");
  // The same confirmation is wrong for day 35.
  const result = await dispatchLadderTask(plannedTask(35), dispatchIO);
  assert.equal(result.result, "held");
  assert.deepEqual([...result.reasons], ["days_past_due_changed_since_planning"]);
});
