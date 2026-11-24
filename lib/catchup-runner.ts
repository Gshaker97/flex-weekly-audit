/**
 * THE CATCH-UP RUNNER: everything between "here is live data" and "the
 * dispatcher may act".
 *
 * It wires the three tested modules together and does the bookkeeping a batch
 * needs - ordering, the per-customer daily cap, the report - and nothing else.
 * It plans by default and sends only when a caller hands it reviewed senders.
 *
 * WHY IT CANNOT MANUFACTURE A SENDER REVIEW, AND WILL NOT PRETEND TO.
 * `lib/notification-runner.ts` sets the precedent in its own words: the factory
 * and run are "exact no-ops by default, even if ambient environment variables
 * request sending", and an explicit mode "merely exercises these dependencies;
 * it is NOT approval". There is deliberately no `senderReviewFromEnv` anywhere
 * in this codebase, because a variable is not a human looking at a sender and
 * approving it. So this runner takes `GhlSenderReview`, `GhlConstructionReview`
 * and the SMS suffix policy as INJECTED dependencies and refuses to send
 * without them. Reading them from `process.env` would convert a deployment
 * detail into an approval, which is the one thing the contract exists to stop.
 *
 * WHAT IT DOES ASSEMBLE, because these are facts rather than approvals:
 *   - the recipient set, grouped one message per customer
 *   - each invoice's real day past due and its ledger event
 *   - the body and subject, through the approved copy
 *   - the destination for each channel
 *   - the per-customer cap, so one customer cannot be messaged twice
 *
 * THE CAP IS ENFORCED HERE, NOT HOPED FOR. The ledger stops a repeat of the
 * SAME invoice on the SAME day and channel, which is not the same promise as
 * "one text and one email per customer". A customer appearing twice in the
 * input - two Jobber client records resolving to one GHL contact, which has
 * already happened once on this board with Sodalicious - would otherwise be
 * two messages. The runner refuses the second.
 */
import { dispatchCatchupSend, type CatchupDispatchIO, type CatchupDispatchResult,
  type CatchupSendContext } from "./catchup-dispatch";
import { planCatchupBatch, type CatchupChannel, type CatchupPlan,
  type CatchupRecipientInput } from "./catchup-plan";
import type { GhlConstructionReview, GhlRecipientResult, GhlSenderReview } from "./notification-ghl-contract";

/** Everything a real send needs that this module cannot produce itself. */
export type CatchupReviewedSenders = Readonly<{
  accountId: string;
  locationId: string;
  /** Per channel, because a sender review is scoped to one channel. */
  sms: Readonly<{ senderReview: GhlSenderReview; review: GhlConstructionReview; smsReceiptSuffixPolicy: unknown }>;
  email: Readonly<{ senderReview: GhlSenderReview; review: GhlConstructionReview }>;
}>;

export type CatchupRunnerDependencies = Readonly<{
  io: CatchupDispatchIO;
  /**
   * The consent read for one contact on one channel, as the contract's own
   * `parseGhlRecipient` returned it. Required, and read per contact rather
   * than passed in wholesale, so a stale read cannot authorize a send.
   */
  readRecipient(contactId: string, channel: CatchupChannel): Promise<GhlRecipientResult>;
  senders: CatchupReviewedSenders;
}>;

export type CatchupRunReport = Readonly<{
  state: "planned" | "sent" | "held";
  sendDate: string;
  /** The plan, always produced, whether or not anything was sent. */
  plan: CatchupPlan;
  results: readonly Readonly<{
    clientName: string | null;
    invoiceNumbers: readonly string[];
    outcome: CatchupDispatchResult | Readonly<{ state: "not_attempted"; reasons: readonly string[] }>;
  }>[];
  summary: Readonly<{
    customers: number; invoices: number; texts: number; emails: number;
    sent: number; refused: number; incomplete: number; notAttempted: number;
  }>;
  /** Why no send was attempted, when that is the answer. */
  reasons: readonly string[];
}>;

const sorted = (values: readonly string[]) => Object.freeze([...new Set(values)].sort());

/**
 * What is still missing before a catch-up can go out. Mirrors
 * `notificationRunnerReadiness` so the two read alike.
 */
export function catchupRunnerReadiness() {
  return Object.freeze({
    state: "plan-only" as const,
    productionSendCapability: false as const,
    missing: Object.freeze([
      "reviewed_sms_sender_and_construction_review",
      "reviewed_email_sender_and_construction_review",
      "verified_email_sending_domain",
      "two_reviewed_jobber_client_ids_for_the_run_level_exclusion_guard",
    ]),
  });
}

/**
 * Plans the batch. Pure, and the only thing most callers want.
 *
 * Separated from sending so a report can be produced, read and argued about
 * without a credential anywhere near it.
 */
export function planCatchupRun(
  recipients: readonly CatchupRecipientInput[], sendDate: string,
): CatchupPlan {
  return planCatchupBatch(recipients, sendDate);
}

/**
 * Runs the batch.
 *
 * `mode` is the whole safety story:
 *   "plan"  - produces the report and touches nothing. The default.
 *   "send"  - may act, and ONLY with injected reviewed senders.
 *
 * A missing dependency in "send" mode is a held run with a reason, never a
 * silent downgrade to planning.
 */
export async function runCatchup(input: Readonly<{
  recipients: readonly CatchupRecipientInput[];
  sendDate: string;
  mode?: "plan" | "send";
  dependencies?: CatchupRunnerDependencies;
}>): Promise<CatchupRunReport> {
  const sendDate = input?.sendDate ?? "";
  const plan = planCatchupRun(input?.recipients ?? [], sendDate);
  const sends = plan.actions.filter((a): a is Extract<typeof a, { state: "send" }> => a.state === "send");

  const report = (
    state: CatchupRunReport["state"],
    results: CatchupRunReport["results"],
    reasons: readonly string[],
  ): CatchupRunReport => {
    let sent = 0, refused = 0, incomplete = 0, notAttempted = 0;
    for (const row of results) {
      if (row.outcome.state === "sent") sent += 1;
      else if (row.outcome.state === "refused") refused += 1;
      else if (row.outcome.state === "incomplete") incomplete += 1;
      else notAttempted += 1;
    }
    return Object.freeze({
      state, sendDate, plan, results: Object.freeze(results),
      summary: Object.freeze({
        customers: plan.summary.send, invoices: plan.summary.invoices,
        texts: plan.summary.texts, emails: plan.summary.emails,
        sent, refused, incomplete, notAttempted,
      }),
      reasons: sorted(reasons),
    });
  };

  const notAttempted = (reasons: readonly string[]): CatchupRunReport["results"] =>
    Object.freeze(sends.map(action => Object.freeze({
      clientName: action.clientName,
      invoiceNumbers: action.covers,
      outcome: Object.freeze({ state: "not_attempted" as const, reasons: sorted(reasons) }),
    })));

  if (input?.mode !== "send") {
    return report("planned", notAttempted(["plan_mode"]), ["plan_mode"]);
  }

  // Every refusal below is a HELD run that still returns the full plan, so the
  // caller sees what would have gone out and exactly why it did not.
  const d = input.dependencies;
  if (!d) return report("held", notAttempted(["trusted_dependencies_required"]), ["trusted_dependencies_required"]);
  if (!d.io?.ledger || typeof d.io.confirmStillDue !== "function" || typeof d.io.attemptSend !== "function") {
    return report("held", notAttempted(["dispatch_io_incomplete"]), ["dispatch_io_incomplete"]);
  }
  if (typeof d.readRecipient !== "function") {
    return report("held", notAttempted(["consent_reader_required"]), ["consent_reader_required"]);
  }
  const s = d.senders;
  if (!s?.accountId || !s?.locationId || !s?.sms?.senderReview || !s?.sms?.review
      || s?.sms?.smsReceiptSuffixPolicy === undefined || !s?.email?.senderReview || !s?.email?.review) {
    return report("held", notAttempted(["reviewed_senders_required"]), ["reviewed_senders_required"]);
  }

  const results: CatchupRunReport["results"][number][] = [];
  /** One text and one email per contact per run, enforced rather than assumed. */
  const usedByContact = new Map<string, Set<CatchupChannel>>();

  for (const action of sends) {
    const outcomes: CatchupDispatchResult[] = [];
    let blocked: string | null = null;

    for (const send of action.sends) {
      const used = usedByContact.get(action.contactId) ?? new Set<CatchupChannel>();
      if (used.has(send.channel)) { blocked = `contact_already_messaged_on_${send.channel}_this_run`; continue; }

      let recipient: GhlRecipientResult;
      try {
        recipient = await d.readRecipient(action.contactId, send.channel);
      } catch {
        outcomes.push(Object.freeze({ state: "refused", channel: send.channel,
          reasons: sorted(["consent_read_failed"]) }));
        continue;
      }
      const context: CatchupSendContext = Object.freeze({
        accountId: s.accountId, locationId: s.locationId,
        senderReview: send.channel === "sms" ? s.sms.senderReview : s.email.senderReview,
        review: send.channel === "sms" ? s.sms.review : s.email.review,
        recipient, scheduledOn: sendDate,
        ...(send.channel === "sms" ? { smsReceiptSuffixPolicy: s.sms.smsReceiptSuffixPolicy } : {}),
      });
      const outcome = await dispatchCatchupSend(action, send, context, d.io);
      outcomes.push(outcome);
      // Mark the channel used on any outcome that reached the provider, so a
      // retry cannot be smuggled in by a later pass over the same batch.
      if (outcome.state === "sent" || outcome.state === "incomplete") {
        used.add(send.channel);
        usedByContact.set(action.contactId, used);
      }
    }

    // One row per customer, carrying the least successful outcome, because a
    // half-delivered pair is the thing a person needs to look at.
    const worst = outcomes.find(o => o.state === "incomplete")
      ?? outcomes.find(o => o.state === "refused")
      ?? outcomes.find(o => o.state === "sent");
    results.push(Object.freeze({
      clientName: action.clientName,
      invoiceNumbers: action.covers,
      outcome: worst ?? Object.freeze({ state: "not_attempted" as const,
        reasons: sorted([blocked ?? "no_channels_planned"]) }),
    }));
  }

  return report("sent", Object.freeze(results), []);
}
