/** Disabled integration candidate. There is deliberately no production message transport. */
import { createHash } from "node:crypto";
import { immutableEvent, planBatch, planNotification, type Event, type Evidence, type Request } from "./notification-gate";
import { addInvoiceCalendarDays, invoiceCalendarDate } from "./invoice-reminder-clock";
import type { NotificationLedger, NotificationReservation } from "./notification-ledger";

export type SyntheticTransportResult =
  | Readonly<{ state: "accepted"; providerMessageId: string }>
  | Readonly<{ state: "rejected" }>;
export type SyntheticTransport = Readonly<{
  kind: "synthetic-no-network";
  send(input: Readonly<{ event: Event; body: string; reservation: NotificationReservation }>): Promise<SyntheticTransportResult>;
}>;
export type NotificationExerciseItem = Readonly<{ request: Request; body: string }>;
export type NotificationExerciseResult = Readonly<{
  eventKey: string; state: "held" | "simulation_accepted" | "simulation_rejected" | "unknown";
  reasons: readonly string[]; productionSendCapability: false;
}>;
export type NotificationExerciseDependencies = Readonly<{
  ledger: NotificationLedger;
  transport: SyntheticTransport;
  now: () => Date;
  /** Test-only trusted evidence reader. It must exclude only this exact, owned reservation
   * from its prior-attempt list, not unrelated attempts. A real adapter is not implemented. */
  readFinal(event: Event, reservation: NotificationReservation): Promise<Evidence>;
}>;
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const result = (key: string, state: NotificationExerciseResult["state"], ...reasons: string[]): NotificationExerciseResult =>
  Object.freeze({ eventKey: key, state, reasons: Object.freeze(reasons), productionSendCapability: false });

/** Exact no-op by default. An accidental flag cannot turn synthetic infrastructure into a sender.
 * No imports of Prisma, provider modules, secrets, timers, or runtime adapters occur here. */
export function configuredNotificationCapability(env: Record<string, string | undefined> = process.env) {
  return env.GHL_NOTIFICATIONS_ENABLED === "true"
    ? Object.freeze({ state: "held" as const, reason: "production_sender_and_approval_not_implemented", productionSendCapability: false as const })
    : Object.freeze({ state: "disabled" as const, productionSendCapability: false as const });
}

function syntheticOnly(event: Event, body: string): boolean {
  // Reserved fictional destination only. This harness must never accept a real customer's event.
  return [event.accountId, event.invoiceId, event.ownerId, event.homeownerContactId,
    event.recipientId, event.contactId].every(s => s.startsWith("synthetic-"))
    && (event.channel === "sms" ? event.destination === "+12025550123" : event.destination === "synthetic@example.invalid")
    && body.startsWith("SYNTHETIC TEST ONLY: ") && event.bodyDigest === digest(body);
}

/** Exercises ordering, fencing and uncertain outcomes against fake transport only. This is NOT a
 * production dispatch entry point and does not turn eligible_in_proposal into send authorization.
 * Any persisted reservation is consumed forever, including a pre-send hold. It is never reclaimed. */
export async function exerciseSyntheticNotificationBatch(
  input: readonly NotificationExerciseItem[], deps: NotificationExerciseDependencies,
): Promise<readonly NotificationExerciseResult[]> {
  if (deps.transport.kind !== "synthetic-no-network") throw new Error("Synthetic transport required");
  const items = input.map(item => ({ request: structuredClone(item.request), body: item.body }));
  for (const item of items) if (!syntheticOnly(item.request.event, item.body)) throw new Error("Synthetic immutable event and body required");
  const plans = planBatch(items.map(item => item.request), deps.now());
  const results: NotificationExerciseResult[] = [];
  for (let i = 0; i < items.length; i++) {
    const { request, body } = items[i], plan = plans[i], event = immutableEvent(request.event);
    if (plan.designStatus !== "eligible_in_proposal") { results.push(result(plan.eventKey, "held", ...plan.reasons)); continue; }
    const due = invoiceCalendarDate(event.dueDate);
    const scheduledOn = due ? addInvoiceCalendarDays(due, event.dayPastDue) : null;
    if (!scheduledOn) { results.push(result(plan.eventKey, "held", "invalid_schedule")); continue; }
    let reservation: NotificationReservation;
    try {
      const claim = await deps.ledger.reserve({ event, body, destination: event.destination,
        channel: event.channel, contactId: event.contactId, scheduledOn });
      if (claim.state !== "reserved") { results.push(result(plan.eventKey, "held", claim.reason)); continue; }
      reservation = claim.reservation;
    } catch {
      // A lost DB commit acknowledgment must not lead to a second reservation or provider attempt.
      results.push(result(plan.eventKey, "unknown", "reservation_outcome_unknown")); continue;
    }
    try {
      if (!await deps.ledger.assertReserved(reservation)) { results.push(result(plan.eventKey, "held", "reservation_not_owned")); continue; }
      const fresh = structuredClone(await deps.readFinal(event, reservation));
      // Compare the prior final snapshot to a strictly newer observation after durable admission.
      const finalPlan = planNotification({ event, preflight: request.final, final: fresh }, deps.now());
      if (finalPlan.designStatus !== "eligible_in_proposal") { results.push(result(plan.eventKey, "held", ...finalPlan.reasons)); continue; }
      if (!await deps.ledger.assertReserved(reservation)) { results.push(result(plan.eventKey, "held", "final_reservation_not_owned")); continue; }
      if (!await deps.ledger.markPending(reservation)) { results.push(result(plan.eventKey, "unknown", "pending_acknowledgment_unavailable")); continue; }
      // Re-evaluate expiry and time after the durable pending commit, without another provider read.
      const boundary = planNotification({ event, preflight: request.final, final: fresh }, deps.now());
      if (boundary.designStatus !== "eligible_in_proposal") {
        await deps.ledger.markOutcome(reservation, { state: "unknown" });
        results.push(result(plan.eventKey, "held", "expired_at_dispatch_boundary", ...boundary.reasons)); continue;
      }
      let outcome: SyntheticTransportResult;
      try {
        outcome = await deps.transport.send(Object.freeze({ event, body, reservation }));
      } catch {
        await deps.ledger.markOutcome(reservation, { state: "unknown" });
        results.push(result(plan.eventKey, "unknown", "transport_outcome_unknown")); continue;
      }
      if (outcome?.state === "accepted" && typeof outcome.providerMessageId === "string"
          && /^synthetic-[A-Za-z0-9._:-]{1,128}$/.test(outcome.providerMessageId)) {
        const saved = await deps.ledger.markOutcome(reservation, outcome);
        results.push(saved ? result(plan.eventKey, "simulation_accepted", "acceptance_not_delivery")
          : result(plan.eventKey, "unknown", "accepted_receipt_not_durably_confirmed"));
      } else if (outcome?.state === "rejected") {
        const saved = await deps.ledger.markOutcome(reservation, outcome);
        results.push(saved ? result(plan.eventKey, "simulation_rejected", "no_automatic_retry")
          : result(plan.eventKey, "unknown", "rejection_not_durably_confirmed"));
      } else {
        await deps.ledger.markOutcome(reservation, { state: "unknown" });
        results.push(result(plan.eventKey, "unknown", "unrecognized_transport_receipt"));
      }
    } catch {
      // If a writer/reader fails after reservation, it remains reserved/pending/unknown. No retry.
      results.push(result(plan.eventKey, "unknown", "post_admission_check_or_storage_failed"));
    }
  }
  return Object.freeze(results);
}
