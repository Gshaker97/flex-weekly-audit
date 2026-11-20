/**
 * ONE WORKER FOR THE WHOLE LADDER - the half that acts.
 *
 * `notification-ladder-plan.ts` decides; this carries the decision out. It is
 * deliberately the only place where a ladder decision becomes an outward act,
 * and it owns exactly one thing: the ORDER of operations around that act.
 *
 * THE ORDER IS THE SAFETY. For a text it is always:
 *
 *   1. check the event really describes the message we are about to send;
 *   2. construct the request through the pinned contract (which refuses to
 *      build anything the recipient read or the sender review does not allow);
 *   3. TAKE A LAST LIVE LOOK at the invoice - still open, still owing, still on
 *      this same day past due;
 *   4. RESERVE in the ledger - the reservation is what makes this the only
 *      process that may send this message;
 *   5. mark it pending, so a crash mid-send cannot read as "never attempted";
 *   6. make exactly ONE attempt;
 *   7. record the outcome, accepted only with the provider's own message id.
 *
 * STEP 3 EXISTS BECAUSE PLANNING IS NOT SENDING. A morning run reads every
 * invoice, then works through them; by the time the twentieth is sent the first
 * read is minutes old, and a payment may have landed in between. The planner
 * deliberately trusts the day number it is handed, so SOMETHING has to look
 * again at the last moment - and it is here, immediately before the first
 * irreversible step. It also catches the quieter error: if the live dates now
 * put this invoice on a different day of the ladder, the planned words are the
 * wrong words, and nothing is sent. This mirrors the Day 15 sender, which
 * re-reads the live Jobber balance on every one of its source reads. It cannot
 * close a sub-second race - nothing can, without an idempotency key - but it
 * removes the minutes-long staleness, which is the error that would actually
 * happen.
 *
 * Nothing is skipped and nothing is reordered. In particular a send never
 * happens before step 3 or 4 succeeds: if the ledger will not hand over the
 * reservation, or will not move it to pending, the message does not go out.
 * That is what stops a customer being texted twice when two runs overlap.
 *
 * NEVER A RETRY, ANYWHERE. A reminder has no idempotency key, so a replay is a
 * second message to a customer. A timeout, a 429 and a 500 are all final: the
 * outcome is recorded as unknown and reported for a person to look at. The
 * audit then names it `send_attempt_left_incomplete` rather than quietly
 * treating it as a gap.
 *
 * WHAT IT DOES NOT DO. It holds no credential and performs no HTTP itself; the
 * single attempt is injected by the deployment. It cannot approve a sender,
 * establish a recipient's consent, or decide what the words say - all of that
 * arrives as evidence and is only ever checked, never produced here.
 *
 * TASKS ARE GUARDED DIFFERENTLY, AND THIS IS A KNOWN LIMITATION. The ledger
 * models messages, so its channel is "sms" or "email" and an internal task is
 * neither. Until the ledger models a task, duplicate protection for day 21 and
 * day 35 comes from READING the contact's existing open tasks and skipping if
 * one for this invoice and day is already there. That is weaker than the
 * ledger's reservation - two runs in the same second could both see none - so
 * the day 21 cutover still requires the single scheduled run, not overlapping
 * ones.
 */
import type { LadderAction } from "./notification-ladder-plan";
import {
  buildGhlMessageRequest, parseGhlAcceptance,
  type GhlConstructionReview, type GhlHttpObservation, type GhlMessageBinding,
  type GhlRecipientResult, type GhlRequestDescriptor, type GhlSenderReview,
} from "./notification-ghl-contract";
import { eventKey } from "./notification-gate";
import {
  notificationBodyDigest,
  type NotificationLedger, type NotificationLedgerEvent,
} from "./notification-ledger";
import type { InternalTaskOutcome } from "./notification-internal-task-runtime";

/**
 * The last live look at an invoice, read at send time rather than planning time.
 * Every field is what the SOURCE says now, not what the cache said earlier.
 */
export type LadderDueConfirmation = Readonly<{
  /** Is the invoice still an open, unpaid invoice in the source? */
  stillOpen: boolean;
  /** Live balance in minor units. Null means it could not be read. */
  balanceMinor: number | null;
  /** Days past due recomputed from the live issue and due dates. */
  dayPastDue: number | null;
}>;

export type LadderDispatchIO = Readonly<{
  ledger: NotificationLedger;
  /**
   * Required, and called before anything irreversible. Supplying a function
   * that always says "still due" would defeat it, which is why it reads the
   * source rather than being passed a value.
   */
  confirmStillDue(invoiceId: string): Promise<LadderDueConfirmation>;
  /**
   * Exactly one HTTP attempt against the pinned send route. The deployment owns
   * the credential and the timeout; this module never sees either. It must not
   * retry internally - that would defeat the single-attempt rule entirely.
   */
  attemptSend(descriptor: GhlRequestDescriptor): Promise<GhlHttpObservation>;
  tasks: Readonly<{
    create(request: unknown): Promise<InternalTaskOutcome>;
    list(contactId: string): Promise<readonly Readonly<{ id: string; title: string; completed: boolean }>[]>;
  }>;
}>;

/** Everything about this one send that must be established elsewhere, live. */
export type LadderSendContext = Readonly<{
  /** The ledger event. Must describe exactly the message being sent. */
  event: NotificationLedgerEvent;
  /**
   * The result of reading this contact's own consent and channel state. It must
   * be the object `parseGhlRecipient` returned: the contract tracks its own
   * results, so a hand-made "allowed" cannot be passed off as a consent read.
   */
  recipient: GhlRecipientResult;
  /** Reviewed sender. This module cannot approve one. */
  senderReview: GhlSenderReview;
  /** Evidence that this construction was reviewed. Also never produced here. */
  review: GhlConstructionReview;
  /** Phoenix calendar date of this run, for the per-customer daily cap. */
  scheduledOn: string;
}>;

export type LadderDispatchOutcome = Readonly<{
  result: "sent" | "task_created" | "held" | "attempted_unconfirmed" | "not_due";
  dayPastDue: number;
  reasons: readonly string[];
  providerMessageId: string | null;
  taskId: string | null;
}>;

const out = (
  result: LadderDispatchOutcome["result"], dayPastDue: number, reasons: readonly string[] = [],
  providerMessageId: string | null = null, taskId: string | null = null,
): LadderDispatchOutcome =>
  Object.freeze({ result, dayPastDue, reasons: Object.freeze([...new Set(reasons)].sort()),
    providerMessageId, taskId });

/**
 * Send one planned text.
 *
 * Every early return here is a message that does NOT go out, which is always the
 * safe direction. The one irreversible step - the attempt - happens after the
 * ledger has handed over a reservation and accepted it as pending.
 */
export async function dispatchLadderSend(
  action: Extract<LadderAction, { kind: "send_sms" }>,
  context: LadderSendContext,
  io: LadderDispatchIO,
): Promise<LadderDispatchOutcome> {
  if (!action || action.kind !== "send_sms") return out("held", -1, ["not_a_planned_send"]);
  const day = action.dayPastDue;
  if (!context?.event || !io?.ledger || typeof io?.attemptSend !== "function")
    return out("held", day, ["dispatch_io_unavailable"]);

  const event = context.event;

  // Step 1. The event is what the ledger keys and records, so it has to be
  // about THIS message. A mismatch here would mean reserving one thing and
  // sending another - the ledger would show a message nobody received.
  const mismatches: string[] = [];
  if (event.channel !== "sms") mismatches.push("event_channel_is_not_sms");
  if (event.dayPastDue !== day) mismatches.push("event_day_does_not_match_the_plan");
  if (event.contactId !== action.contactId) mismatches.push("event_contact_does_not_match_the_plan");
  if (event.bodyDigest !== notificationBodyDigest(action.body)) mismatches.push("event_body_digest_does_not_match_the_words");
  if (typeof context.scheduledOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(context.scheduledOn))
    mismatches.push("scheduled_date_unusable");
  if (mismatches.length) return out("held", day, mismatches);

  // Step 2. The pinned contract builds the request, and refuses if the
  // recipient read or the sender review does not support it.
  const binding: GhlMessageBinding = {
    accountId: event.accountId, locationId: context.senderReview?.locationId ?? "",
    contactId: event.contactId, channel: "sms", destination: event.destination,
    // The ledger's own key for this event, so the request and the ledger row
    // describe the same thing and cannot drift apart.
    eventKey: eventKey(event), invoiceId: event.invoiceId,
    sender: context.senderReview?.sender ?? "", bodyHash: notificationBodyDigest(action.body),
  };
  const construction = buildGhlMessageRequest({
    binding, recipient: context.recipient, senderReview: context.senderReview,
    review: context.review, body: action.body, contentType: "text/plain",
  });
  if (construction.state !== "constructed_disabled" || !construction.request)
    return out("held", day, construction.reasons.length ? construction.reasons : ["send_request_not_constructible"]);

  // Step 3. The last live look. Anything that has moved since planning stops
  // the send - including the day number, because a different day means these
  // are the wrong words for this invoice.
  const confirmation = await confirmDue(io, event.invoiceId, day);
  if (confirmation) return out("held", day, confirmation);

  // Step 4. The reservation is the right to send this exact message once.
  const reserved = await io.ledger.reserve({
    event, body: action.body, destination: event.destination,
    channel: "sms", contactId: event.contactId, scheduledOn: context.scheduledOn,
  });
  if (reserved.state !== "reserved") return out("held", day, [`ledger_${reserved.reason}`]);
  const handle = reserved.reservation;

  // Step 5. Pending BEFORE the attempt. If this process dies during the send,
  // the row says "we were sending", not "we never tried" - which is the
  // difference between a human checking and a duplicate going out.
  if (!(await io.ledger.markPending(handle)))
    return out("held", day, ["ledger_would_not_move_to_pending"]);

  // Step 6. One attempt. No retry on any failure, including a timeout.
  let observation: GhlHttpObservation;
  try {
    observation = await io.attemptSend(construction.request);
  } catch (error: any) {
    await io.ledger.markOutcome(handle, { state: "unknown" });
    return out("attempted_unconfirmed", day,
      ["send_attempt_outcome_unknown", String(error?.name ?? "error")]);
  }

  // Step 7. Accepted only on the provider's own id. Our own optimism is not
  // evidence, and this is still not proof of DELIVERY - that comes later, from
  // the provider, exactly as the audit requires.
  const acceptance = parseGhlAcceptance(construction, observation);
  if (acceptance.state !== "accepted" || !acceptance.messageId) {
    await io.ledger.markOutcome(handle, { state: "unknown" });
    return out("attempted_unconfirmed", day,
      acceptance.reasons.length ? acceptance.reasons : ["provider_did_not_confirm_acceptance"]);
  }
  if (!(await io.ledger.markOutcome(handle, { state: "accepted", providerMessageId: acceptance.messageId })))
    return out("attempted_unconfirmed", day, ["ledger_would_not_record_the_outcome"], acceptance.messageId);

  return out("sent", day, [], acceptance.messageId);
}

/**
 * Returns the reasons NOT to act, or null when the invoice is still genuinely
 * due on this day. An unreadable confirmation is a refusal: not knowing whether
 * someone still owes money is never a reason to tell them that they do.
 */
async function confirmDue(
  io: LadderDispatchIO, invoiceId: string, day: number,
): Promise<readonly string[] | null> {
  if (typeof io?.confirmStillDue !== "function") return ["no_last_look_at_the_invoice_available"];
  let live: LadderDueConfirmation;
  try {
    live = await io.confirmStillDue(invoiceId);
  } catch {
    return ["could_not_confirm_the_invoice_is_still_due"];
  }
  if (!live || typeof live !== "object") return ["could_not_confirm_the_invoice_is_still_due"];
  const reasons: string[] = [];
  if (live.stillOpen !== true) reasons.push("invoice_no_longer_open_at_send_time");
  if (!Number.isSafeInteger(live.balanceMinor as number) || (live.balanceMinor as number) <= 0)
    reasons.push("invoice_no_longer_owes_at_send_time");
  // A changed day number means the ladder moved under us, so the planned words
  // belong to a different rung. Silence, and a reason the audit can report.
  if (live.dayPastDue !== day) reasons.push("days_past_due_changed_since_planning");
  return reasons.length ? reasons : null;
}

/** Does this contact already have an open task for this invoice and day? */
function alreadyOpen(
  rows: readonly Readonly<{ title: string; completed: boolean }>[],
  invoiceNumber: string, day: number,
): boolean {
  return rows.some(row => !row.completed &&
    typeof row.title === "string" &&
    row.title.includes(`#${invoiceNumber}`) && row.title.includes(`day ${day}`));
}

/**
 * Create one planned internal task.
 *
 * The duplicate guard is a read of the contact's open tasks, not a ledger
 * reservation - see the limitation at the top of this file. If that read fails
 * the task is HELD rather than created: an unread list is not an empty one, and
 * a duplicate task is a colleague calling a customer twice.
 */
export async function dispatchLadderTask(
  action: Extract<LadderAction, { kind: "create_task" }>,
  io: LadderDispatchIO,
): Promise<LadderDispatchOutcome> {
  if (!action || action.kind !== "create_task") return out("held", -1, ["not_a_planned_task"]);
  const day = action.dayPastDue;
  if (typeof io?.tasks?.create !== "function" || typeof io?.tasks?.list !== "function")
    return out("held", day, ["task_runtime_unavailable"]);

  // A task is work for a colleague, so the same last look applies: nobody
  // should be asked to chase an invoice that was paid an hour ago.
  const confirmation = await confirmDue(io, action.request.invoiceId, day);
  if (confirmation) return out("held", day, confirmation);

  let existing: readonly Readonly<{ id: string; title: string; completed: boolean }>[];
  try {
    existing = await io.tasks.list(action.request.contactId);
  } catch {
    return out("held", day, ["could_not_read_existing_tasks"]);
  }
  if (alreadyOpen(existing, action.request.invoiceNumber, day))
    return out("held", day, ["task_already_open_for_this_invoice_and_day"]);

  const created = await io.tasks.create(action.request);
  if (created.state === "created_and_confirmed")
    return out("task_created", day, [], null, created.taskId);
  if (created.state === "attempted_unconfirmed")
    return out("attempted_unconfirmed", day, created.reasons, null, created.taskId);
  return out("held", day, created.reasons.length ? created.reasons : ["task_not_created"]);
}

/**
 * Carry out one planned action, whatever kind it is.
 *
 * A send needs a context that only the caller can establish live, so a planned
 * send with no context is HELD rather than sent on assumptions.
 */
export async function dispatchLadderAction(
  action: LadderAction,
  io: LadderDispatchIO,
  context?: LadderSendContext,
): Promise<LadderDispatchOutcome> {
  if (!action || typeof action !== "object") return out("held", -1, ["no_action_to_dispatch"]);
  switch (action.kind) {
    case "not_due":
      return out("not_due", action.dayPastDue);
    case "hold":
      return out("held", action.dayPastDue, action.reasons);
    case "create_task":
      return dispatchLadderTask(action, io);
    case "send_sms":
      return context
        ? dispatchLadderSend(action, context, io)
        : out("held", action.dayPastDue, ["no_send_context_established"]);
    default:
      return out("held", -1, ["unknown_action_kind"]);
  }
}
