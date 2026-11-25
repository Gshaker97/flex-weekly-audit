/**
 * THE HALF THAT ACTS, for the one-time catch-up.
 *
 * `catchup-plan.ts` decides; this carries one decision out. It owns exactly one
 * thing: the ORDER of operations around an irreversible act.
 *
 * THE ORDER IS THE SAFETY, and it is the ladder dispatcher's order, kept
 * deliberately identical so the two cannot drift:
 *
 *   1. check the plan still describes the message about to be sent;
 *   2. TAKE A LAST LIVE LOOK at every invoice - still open, STILL NOT PAID,
 *      still owing the same figure, still on the same day past due;
 *   3. RESERVE EVERY LEDGER ROW for this channel;
 *   4. mark them pending, so a crash mid-send cannot read as "never attempted";
 *   5. make exactly ONE attempt;
 *   6. record the outcome, accepted only with the provider's own message id.
 *
 * STEP 2 EXISTS BECAUSE PLANNING IS NOT SENDING. A batch is planned once and
 * worked through; by the twentieth recipient the first read is minutes old and
 * a payment may have landed. So something has to look again at the last moment,
 * and it is here, immediately before the first irreversible step.
 *
 * RESERVE-ALL-THEN-SEND, AND WHAT IT COSTS. One message may name two invoices,
 * and the ledger is per invoice, so a single text needs two rows. Both are
 * taken BEFORE the attempt: if the second cannot be taken, nothing is sent.
 *
 * The cost is real and worth stating plainly. The ledger has no release,
 * expiry or reset - deliberately - so a row reserved for a message that then
 * does not go out stays reserved forever, and that invoice can never be
 * messaged again at that day number. For a one-time catch-up this is the right
 * trade: the day number never recurs, so the stuck row blocks nothing in the
 * future, whereas sending a customer a message that names an invoice we failed
 * to record would corrupt every later decision about them. The runner reports
 * every such row by invoice number so a person can see it.
 *
 * NEVER A RETRY, ANYWHERE. A message has no idempotency key, so a replay is a
 * second message to a customer. A timeout, a 429 and a 500 are all final: the
 * outcome is recorded as unknown and reported for a person to look at.
 *
 * WHAT IT DOES NOT DO. It holds no credential and performs no HTTP itself; the
 * single attempt is injected. It cannot approve a sender, establish consent, or
 * decide what the words say - all of that arrives as evidence and is only ever
 * checked here, never produced.
 */
import type { CatchupAction, CatchupChannel, CatchupSend } from "./catchup-plan";
import { CATCHUP_SMS_SUFFIX, catchupSmsReceiptBody } from "./catchup-copy";
import {
  buildGhlMessageRequest, parseGhlAcceptance,
  type GhlConstructionResult, type GhlConstructionReview, type GhlHttpObservation,
  type GhlRecipientResult,
  type GhlRequestDescriptor, type GhlSenderReview,
} from "./notification-ghl-contract";
import {
  notificationBodyDigest,
  type NotificationLedger, type NotificationReservation,
} from "./notification-ledger";

/**
 * The statuses an invoice may carry and still be chased. Jobber's own set is
 * wider - `paid`, `draft`, `void` and `bad_debt` are all real - and none of
 * those is a thing to send a customer a past-due notice about.
 */
export const SENDABLE_INVOICE_STATUSES = Object.freeze(["awaiting_payment", "past_due"] as const);

/** The last live look at one invoice, read at send time. */
export type CatchupDueConfirmation = Readonly<{
  stillOpen: boolean;
  balanceMinor: number | null;
  dayPastDue: number | null;
  /**
   * The status the SOURCE gives this invoice, at send time. Required, and null
   * only when it could not be read - which refuses the send, because an
   * unreadable status is not evidence that anything is owed.
   *
   * It is kept separate from `stillOpen` on purpose. An adapter computes
   * `stillOpen` and can compute it wrongly; the status is a fact read straight
   * off the source, and checking it here means no adapter can accidentally
   * decide for itself that a paid invoice is still chaseable.
   */
  invoiceStatus: string | null;
}>;

export type CatchupDispatchIO = Readonly<{
  ledger: NotificationLedger;
  /** Required, and called before anything irreversible, once per invoice. */
  confirmStillDue(invoiceId: string): Promise<CatchupDueConfirmation>;
  /** Exactly one HTTP attempt. Must not retry internally. */
  attemptSend(descriptor: GhlRequestDescriptor): Promise<GhlHttpObservation>;
}>;

export type CatchupSendContext = Readonly<{
  accountId: string;
  locationId: string;
  /** The reviewed sender for THIS channel. This module cannot approve one. */
  senderReview: GhlSenderReview;
  /** Evidence the construction was reviewed. Also never produced here. */
  review: GhlConstructionReview;
  /** The consent read, as `parseGhlRecipient` returned it. */
  recipient: GhlRecipientResult;
  /** Phoenix calendar date of this run. */
  scheduledOn: string;
  /** Required for sms, and only for sms. */
  smsReceiptSuffixPolicy?: unknown;
}>;

export type CatchupDispatchResult =
  | Readonly<{ state: "sent"; channel: CatchupChannel; providerMessageId: string; invoiceNumbers: readonly string[] }>
  | Readonly<{ state: "refused"; channel: CatchupChannel; reasons: readonly string[] }>
  | Readonly<{
      state: "incomplete"; channel: CatchupChannel; reasons: readonly string[];
      /** Rows taken that no message used. Reported so a person can see them. */
      strandedInvoiceNumbers: readonly string[];
    }>;

const sorted = (values: readonly string[]) => Object.freeze([...new Set(values)].sort());

/**
 * Sends ONE channel of ONE recipient's catch-up message.
 *
 * Called twice per recipient - once for the text, once for the email - because
 * the ledger keys on channel and the two halves are two reservations each.
 */
/**
 * The construction step on its own, exported so NOTHING ELSE HAS TO REBUILD IT.
 *
 * The approval manifest must name the byte-exact request that will later be
 * posted, which means the manifest and the sender have to construct through one
 * code path. Two paths would eventually disagree, and a disagreement here is a
 * message a person approved in one form and a customer received in another.
 *
 * Sends nothing, reads nothing, reserves nothing. `buildGhlMessageRequest`
 * returns a descriptor that deliberately carries no credential and no place to
 * put one, so a constructed request is still not a sent one.
 */
export type CatchupConstruction = Readonly<{
  state: "constructed" | "refused";
  construction: GhlConstructionResult | null;
  request: GhlRequestDescriptor | null;
  bodyHash: string;
  reasons: readonly string[];
}>;

export function constructCatchupRequest(
  action: CatchupAction, send: CatchupSend, context: CatchupSendContext,
): CatchupConstruction {
  const channel = send?.channel;
  const no = (...reasons: string[]): CatchupConstruction => Object.freeze({
    state: "refused", construction: null, request: null, bodyHash: "", reasons: sorted(reasons) });
  if (!action || action.state !== "send") return no("action_is_not_a_send");
  if (channel !== "sms" && channel !== "email") return no("channel_is_not_a_catchup_channel");
  if (!send.reservations?.length) return no("no_reservations_planned");

  const bodyHash = notificationBodyDigest(action.body);
  const built = buildGhlMessageRequest({
    binding: {
      accountId: context.accountId, locationId: context.locationId,
      // One binding serves every invoice in this message; the ledger rows carry
      // the per-invoice identity. The FIRST reservation's key is the binding's,
      // so a binding can never name an invoice this message does not cover.
      eventKey: send.reservations[0].eventKey,
      invoiceId: send.reservations[0].invoiceId,
      contactId: action.contactId, channel,
      sender: context.senderReview?.sender, destination: send.destination,
      bodyHash,
    },
    recipient: context.recipient,
    senderReview: context.senderReview,
    review: context.review,
    body: action.body,
    contentType: "text/plain",
    ...(channel === "email" ? { subject: action.subject } : {}),
    ...(channel === "sms" ? { smsReceiptSuffixPolicy: context.smsReceiptSuffixPolicy } : {}),
  } as never);
  if (!built.request) return no(...(built.reasons ?? ["request_could_not_be_constructed"]));

  // The text must carry the opt-out line, and the contract's own suffix policy
  // is the only sanctioned way to add it. Prove it is actually in play.
  if (channel === "sms") {
    const receipt = catchupSmsReceiptBody(action.body);
    if (!receipt || !receipt.endsWith(CATCHUP_SMS_SUFFIX)) return no("sms_opt_out_line_unavailable");
  }
  return Object.freeze({ state: "constructed", construction: built,
    request: built.request, bodyHash, reasons: Object.freeze([]) });
}

export async function dispatchCatchupSend(
  action: Extract<CatchupAction, { state: "send" }>,
  send: CatchupSend,
  context: CatchupSendContext,
  io: CatchupDispatchIO,
): Promise<CatchupDispatchResult> {
  const channel = send?.channel;
  if (channel !== "sms" && channel !== "email") {
    return Object.freeze({ state: "refused", channel: channel as CatchupChannel, reasons: sorted(["channel_is_not_a_catchup_channel"]) });
  }
  const refuse = (...reasons: string[]): CatchupDispatchResult =>
    Object.freeze({ state: "refused" as const, channel, reasons: sorted(reasons) });

  if (!action || action.state !== "send") return refuse("action_is_not_a_send");
  if (!send.reservations?.length) return refuse("no_reservations_planned");
  if (!send.destination?.trim()) return refuse("destination_missing");
  if (context?.scheduledOn !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(context.scheduledOn)) {
    return refuse("scheduled_on_malformed");
  }
  if (channel === "sms" && context.smsReceiptSuffixPolicy === undefined) {
    // The opt-out line is part of what was approved for the text. Sending the
    // text without it is not the approved message.
    return refuse("sms_receipt_suffix_policy_required");
  }
  if (channel === "email" && context.smsReceiptSuffixPolicy !== undefined) {
    return refuse("sms_receipt_suffix_policy_must_not_apply_to_email");
  }

  // 1. The request is built through the pinned contract, which refuses anything
  //    the consent read or the sender review does not allow. Built BEFORE the
  //    live look so a construction failure costs nothing.
  const constructed = constructCatchupRequest(action, send, context);
  if (!constructed.request || !constructed.construction) return refuse(...constructed.reasons);
  const bodyHash = constructed.bodyHash;
  const built = constructed.construction;

  // 2. The last live look, once per invoice. Any disagreement stops everything.
  for (const row of send.reservations) {
    let live: CatchupDueConfirmation;
    try {
      live = await io.confirmStillDue(row.invoiceId);
    } catch {
      return refuse("live_invoice_read_failed");
    }
    if (!live || live.stillOpen !== true) return refuse("invoice_no_longer_open");
    // THE STATUS IS CHECKED HERE, not just the balance.
    //
    // A balance is not a status. Jobber will report an invoice as `paid` while
    // a balance is still sitting on it - the status refresh treats exactly that
    // combination as a conflict needing review - and it reports `void`, `draft`
    // and `bad_debt` invoices that may carry a balance too. Any of those would
    // pass a balance-only look and go out as a past-due notice.
    const status = typeof live.invoiceStatus === "string" ? live.invoiceStatus.trim().toLowerCase() : null;
    if (status === "paid") return refuse("invoice_is_paid_at_send_time");
    if (!status || !SENDABLE_INVOICE_STATUSES.some(s => s === status)) {
      return refuse("invoice_status_is_not_sendable_at_send_time");
    }
    if (typeof live.balanceMinor !== "number" || live.balanceMinor <= 0) return refuse("invoice_no_longer_owes");
    if (live.dayPastDue !== row.dayPastDue) return refuse("day_past_due_changed_since_planning");
    // The message states a dollar figure. "Still owes something" is not the same
    // promise as "still owes THIS", and a part payment between planning and
    // sending would otherwise go out as a wrong number in the customer's hand.
    if (live.balanceMinor !== row.balanceMinor) return refuse("balance_changed_since_planning");
  }

  // 3. ONE claim for the message, not one per invoice.
  //
  // The ledger's per-contact unique index is one message per contact, per day,
  // per channel. A message covering several invoices therefore cannot take a
  // row each: the second is refused, and the first cannot be handed back
  // because there is no release. Before this, a two-invoice customer could
  // never be sent to at all, and every attempt stranded a row.
  //
  // So the ledger records MESSAGES. One message takes one row, and the row
  // names every invoice the words actually mention. The identity columns come
  // from the first covered invoice, so the per-invoice index still protects
  // that one; the rest are recorded in the payload, which the event hash
  // covers, so this claim can never be mistaken for a message about a
  // different set of invoices.
  //
  // The live look above still checks EVERY invoice. Recording one row does not
  // mean verifying one balance.
  const primary = send.reservations[0];
  if (!primary) return refuse("nothing_to_reserve");
  const covers = send.reservations.map(row => row.invoiceNumber);
  const taken: { handle: NotificationReservation; invoiceNumber: string }[] = [];
  const reservation = await io.ledger.reserve({
    event: {
      accountId: context.accountId, invoiceId: primary.invoiceId, contactId: action.contactId,
      dayPastDue: primary.dayPastDue, audience: "homeowner", channel,
      destination: send.destination, bodyDigest: bodyHash,
      dueDate: primary.dueOn,
      // What the message really covers, so a later reader is not misled into
      // thinking only the primary invoice was mentioned.
      coversInvoiceNumbers: covers,
      coversBalanceMinor: send.reservations.reduce((total, row) => total + row.balanceMinor, 0),
    } as never,
    body: action.body, destination: send.destination, channel,
    contactId: action.contactId, scheduledOn: context.scheduledOn,
  });
  if (reservation.state !== "reserved") {
    return Object.freeze({
      state: "incomplete", channel,
      reasons: sorted([`reservation_${reservation.reason}_for_${primary.invoiceNumber}`, "nothing_was_sent"]),
      // Nothing was taken, so nothing is stranded.
      strandedInvoiceNumbers: Object.freeze([] as string[]),
    });
  }
  taken.push({ handle: reservation.reservation, invoiceNumber: primary.invoiceNumber });

  // 4. Assert every claim before any of them is advanced.
  //
  // THIS STEP IS NOT OPTIONAL AND IS NOT A FORMALITY. `markPending` only
  // accepts a handle the ledger has verified against the stored row, so
  // without this the next loop refuses every message and leaves the whole set
  // stranded in "reserved" - rows that are claimed, never sent, and that the
  // ledger offers no way to release. That is exactly what happened on
  // 2026-11-24: 31 reservations taken, 31 refused at pending, nothing sent.
  for (const row of taken) {
    if (!(await io.ledger.assertReserved(row.handle))) {
      return Object.freeze({
        state: "incomplete", channel,
        reasons: sorted([`reservation_could_not_be_asserted_for_${row.invoiceNumber}`, "nothing_was_sent"]),
        strandedInvoiceNumbers: Object.freeze(taken.map(t => t.invoiceNumber)),
      });
    }
  }

  // 5. Pending, so a crash mid-send cannot read as "never attempted".
  for (const row of taken) {
    if (!(await io.ledger.markPending(row.handle))) {
      return Object.freeze({
        state: "incomplete", channel,
        reasons: sorted(["ledger_would_not_mark_pending", "nothing_was_sent"]),
        strandedInvoiceNumbers: Object.freeze(taken.map(t => t.invoiceNumber)),
      });
    }
  }

  // 6. Exactly one attempt. Never retried, whatever comes back.
  let observation: GhlHttpObservation;
  try {
    observation = await io.attemptSend(constructed.request);
  } catch {
    // A thrown attempt is an outcome, not a reason to try again. An observation
    // the parser cannot accept is exactly the right shape for "we do not know".
    observation = { version: null, statusCode: null, body: null };
  }
  // BOTH arguments matter: the parser checks the response against the
  // construction it belongs to, so a reply that names another contact, number
  // or location cannot be read as this message's acceptance.
  const acceptance = parseGhlAcceptance(built, observation);
  const accepted = acceptance.state === "accepted"
    && typeof acceptance.messageId === "string" && acceptance.messageId.trim().length > 0;
  const providerMessageId = acceptance.messageId;

  // 6. The outcome, on every row, accepted only with the provider's own id.
  for (const row of taken) {
    await io.ledger.markOutcome(row.handle, accepted
      ? { state: "accepted", providerMessageId: providerMessageId as string }
      : { state: "unknown" });
  }

  const invoiceNumbers = Object.freeze(taken.map(t => t.invoiceNumber));
  if (!accepted) {
    return Object.freeze({
      state: "incomplete", channel,
      reasons: sorted(["send_attempt_left_incomplete", ...acceptance.reasons]),
      strandedInvoiceNumbers: invoiceNumbers,
    });
  }
  return Object.freeze({ state: "sent", channel, providerMessageId: providerMessageId as string, invoiceNumbers });
}
