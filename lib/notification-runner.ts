/** Local integration candidate. No ambient credentials, environment enable switch or production callsite. */
import { notificationModuleFunctions } from "./notification-module-interop";
import { createHash } from "node:crypto";
import { addInvoiceCalendarDays, invoiceCalendarDate } from "./invoice-reminder-clock";
import { eventKey, immutableEvent, planNotification, type Event, type Evidence, type Proof } from "./notification-gate";
import { createNotificationLedger, notificationEventHash, type NotificationLedgerDatabase,
  type NotificationReservation } from "./notification-ledger";
import type { NotificationSourceRequest, NotificationSourceIO, NotificationSourceSnapshot,
  NotificationSourceHandle, NotificationExternalEvidence } from "./notification-source";
import { buildGhlMessageRequest, createGhlReadOnlyReader, type GhlConstructionReview, type GhlSenderReview,
  type GhlConstructionResult, type GhlMessageBinding, type GhlReadOnlyOptions, type GhlSmsReceiptSuffixPolicy } from "./notification-ghl-contract";
import { createGhlOneAttemptTransport, reviewGhlTransportConstruction, type GhlTransportOptions,
  type GhlTransportReview, type GhlTransportResult } from "./notification-ghl-transport";

export type NotificationRunnerPreparation = Readonly<{
  event: Event; body: string; contentType: "text/plain" | "text/html"; subject?: string;
  sender: GhlSenderReview; constructionReview: GhlConstructionReview; smsReceiptSuffixPolicy?: GhlSmsReceiptSuffixPolicy;
}>;
/** These are authenticated application dependencies, never a request body or a JSON approval file.
 * External history MUST cover prior workflow/manual/provider attempts, independently of this ledger.
 * No callback receives the reservation or a way to erase a local attempt. */
export type NotificationRunnerSource =
  | Readonly<{ sourceRequest: NotificationSourceRequest; sourceIO: NotificationSourceIO; recurringSource?: never }>
  | Readonly<{ recurringSource: NotificationSourceHandle; sourceRequest?: never; sourceIO?: never }>;
export type NotificationRunnerDependencies = NotificationRunnerSource & Readonly<{
  database: NotificationLedgerDatabase;
  contact: Omit<GhlReadOnlyOptions, "now">;
  transport: Omit<GhlTransportOptions, "ledger" | "now" | "mode">;
  prepare(source: NotificationSourceSnapshot, handle: NotificationSourceHandle): Promise<NotificationRunnerPreparation>;
  readExternal(source: NotificationSourceSnapshot, event: Event, handle: NotificationSourceHandle): Promise<Omit<NotificationExternalEvidence, "dnd">>;
  review(construction: GhlConstructionResult, event: Event, binding: GhlMessageBinding): Promise<GhlTransportReview>;
}>;
export type NotificationRunnerResult = Readonly<{
  state: "disabled" | "held" | "accepted" | "unknown"; phase: string; reasons: readonly string[];
  reservationCreated: boolean; attempted: boolean; transport: GhlTransportResult | null;
  productionSendCapability: false; retryAllowed: false;
}>;
const hash = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const now = () => new Date(Date.now());
// Do not defeat the ledger's same-process uncertainty fence by constructing a new runner.
const attemptedEvents = new Set<string>();
const report = (state: NotificationRunnerResult["state"], phase: string, reasons: readonly string[],
  reservationCreated = false, transport: GhlTransportResult | null = null): NotificationRunnerResult =>
  Object.freeze({ state, phase, reasons: Object.freeze([...reasons]), reservationCreated,
    attempted: transport?.attempted ?? false, transport, productionSendCapability: false, retryAllowed: false });
const proof = (observedAt: number, sourceRef: string): Proof => Object.freeze({
  observedAt: new Date(observedAt).toISOString(), expiresAt: new Date(observedAt + 60_000).toISOString(), sourceRef });
function assertProof(value: Proof): void {
  const instant = (s: string) => typeof s === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(s) && invoiceCalendarDate(s)
    ? Date.parse(s) : NaN;
  const observed = instant(value?.observedAt), expires = instant(value?.expiresAt), at = Date.now();
  if (typeof value?.sourceRef !== "string" || !value.sourceRef || value.sourceRef.length > 256 ||
      value.sourceRef.trim() !== value.sourceRef || value.sourceRef.includes("\0") ||
      !Number.isFinite(observed) || !Number.isFinite(expires) || observed > at || at >= expires ||
      expires <= observed || at - observed >= 60_000) throw new Error("invalid_original_external_proof");
}
function intersection(a: Proof, b: Proof, sourceRef: string): Proof {
  // Validate originals first: min() must not launder a future/invalid observation or missing provenance.
  assertProof(a); assertProof(b);
  // Never re-stamp external evidence. Earliest observation/expiry bounds every component.
  return Object.freeze({ observedAt: new Date(Math.min(Date.parse(a.observedAt), Date.parse(b.observedAt))).toISOString(),
    expiresAt: new Date(Math.min(Date.parse(a.expiresAt), Date.parse(b.expiresAt),
      Date.parse(a.observedAt) + 60_000, Date.parse(b.observedAt) + 60_000)).toISOString(), sourceRef });
}
const HISTORY = `/* notification-runner:history */
SELECT "id", "reservationToken", "eventKey", "eventHash", "bodyHash", "destinationHash", "state"
FROM "NotificationLedger" WHERE "accountId" = $1 AND "eventKey" = $2 LIMIT 1001`;
type HistoryRow = Record<string, unknown> & { id: string; reservationToken: string; eventKey: string;
  eventHash: string; bodyHash: string; destinationHash: string; state: Evidence["attempts"]["records"][number]["state"] };
const states = ["reserved", "pending", "accepted", "delivered", "rejected", "unknown"];

export function notificationRunnerReadiness() {
  return Object.freeze({ state: "disabled" as const, productionSendCapability: false as const,
    productionCallsite: false as const, scope: "one-reviewed-owner-invoice" as const,
    missing: Object.freeze(["trusted_currency_category_and_fact_readers", "complete_external_attempt_history",
      "authenticated_template_sender_content_and_timing_reviews", "verified_provider_status_semantics",
      "approved_database_migration_and_live_rollout", "production_dependency_composition_and_reconciliation"]) });
}

/** Factory/run are exact no-ops by default, even if ambient environment variables request sending.
 * Explicit mode merely exercises these dependencies; it is NOT approval. The existing review and
 * eligibility checks remain mandatory. runOne takes no request booleans and is single-use. */
export function createNotificationRunner(options: Readonly<{
  mode?: "reviewed-one-event-candidate" | "read-only-candidate"; dependencies?: NotificationRunnerDependencies;
}> = {}) {
  const readOnly = options.mode === "read-only-candidate";
  const enabled = options.mode === "reviewed-one-event-candidate" || readOnly;
  // Do not even inspect the dependency object on the disabled path.
  const dependencies = enabled ? options.dependencies : undefined;
  let consumed = false;
  return Object.freeze({ productionSendCapability: false as const,
    async runOne(): Promise<NotificationRunnerResult> {
      if (!enabled) return report("disabled", "configuration", ["runner_disabled"]);
      if (consumed) return report("held", "configuration", ["runner_already_consumed_no_retry"]);
      consumed = true; // Burns a run before any asynchronous IO, including ambiguous failures.
      if (!dependencies) return report("held", "configuration", ["trusted_dependencies_required"]);
      let phase = "configuration", reserved = false, reserveAttempted = false;
      try {
        const d = dependencies;
        const { prepare, readExternal, review, database } = d;
        const ledger = createNotificationLedger(database);
        const contactReader = createGhlReadOnlyReader({ ...d.contact, now });
        const transport = createGhlOneAttemptTransport({ ...d.transport, mode: "reviewed-one-attempt", ledger, now });
        // The source module transitively initializes legacy production clients. Keep that
        // import out of the disabled/readiness path; no deployed source bindings are invoked.
        const { readNotificationSource, refreshNotificationSource, inspectNotificationSource, inspectRecurringNotificationSource, composeNotificationEvidence } = notificationModuleFunctions(await import("./notification-source"),
          ["readNotificationSource", "refreshNotificationSource", "inspectNotificationSource", "inspectRecurringNotificationSource", "composeNotificationEvidence"]);
        phase = "initial_source";
        let handle: NotificationSourceHandle;
        if (d.recurringSource !== undefined) {
          // Only an issuer-owned v2 capability. JSON/request clones cannot select a new IO
          // implementation, re-stamp source evidence or renew its population lifetime.
          inspectRecurringNotificationSource(d.recurringSource);
          handle = d.recurringSource;
        } else handle = await readNotificationSource(structuredClone(d.sourceRequest!), d.sourceIO!);
        const initialSource = inspectNotificationSource(handle);
        const prepared = structuredClone(await prepare(initialSource, handle));
        const event = immutableEvent(prepared.event), key = eventKey(event);
        notificationEventHash(event); // Reject non-JSON/unsupported data before any admission.
        const binding: GhlMessageBinding = Object.freeze({ accountId: event.accountId, locationId: initialSource.locationId,
          contactId: event.contactId, channel: event.channel, destination: event.destination,
          eventKey: key, invoiceId: event.invoiceId, sender: prepared.sender.sender, bodyHash: event.bodyDigest });
        if (event.accountId !== d.transport.accountId || binding.locationId !== d.transport.locationId ||
            !d.transport.scopes.includes("conversations/message.write"))
          return report("held", phase, ["transport_account_location_or_scope_mismatch"]);

        async function evidence(source: NotificationSourceHandle, reservation?: NotificationReservation) {
          const snapshot = inspectNotificationSource(source);
          const external = structuredClone(await readExternal(snapshot, event, source));
          const contactAt = Date.now(), recipient = await contactReader.readContact(binding);
          if (recipient.state !== "allowed") throw new Error("contact_not_allowed");
          const contactProof = proof(contactAt, `ghl-contact-read:${hash(JSON.stringify(binding))}`);
          // A final history exclusion requires the ORIGINAL capability issued by OUR ledger,
          // fresh ownership verification and all persisted reservation digests, never eventKey alone.
          if (reservation && !await ledger.assertReserved(reservation)) throw new Error("reservation_not_owned");
          const historyAt = Date.now();
          const rows = await database.transaction(tx => tx.query<HistoryRow>(HISTORY, [event.accountId, key]));
          if (!Array.isArray(rows) || rows.length > 1000 || new Set(rows.map(row => row.id)).size !== rows.length ||
              rows.some(row => !row || typeof row.id !== "string" || !row.id || row.eventKey !== key || !states.includes(row.state)))
            throw new Error("ledger_history_unverified");
          let own = 0;
          const records = rows.filter(row => {
            const exact = reservation && row.id === reservation.id && row.reservationToken === reservation.token &&
              row.eventHash === reservation.eventHash && row.bodyHash === reservation.bodyHash &&
              row.destinationHash === reservation.destinationHash && row.state === "reserved";
            if (exact) own++;
            return !exact;
          }).map(row => ({ eventKey: row.eventKey, state: row.state }));
          if (reservation && own !== 1) throw new Error("original_reservation_not_in_history");
          const historyProof = proof(historyAt, "notification-ledger-exact-event-read");
          const combined: NotificationExternalEvidence = {
            ...external,
            recipient: { ...external.recipient, ...intersection(external.recipient, contactProof,
              `recipient-and-contact:${hash(JSON.stringify([external.recipient, contactProof]))}`) },
            dnd: { ...contactProof, accountId: event.accountId, contactId: event.contactId,
              channel: event.channel, destination: event.destination, state: "allowed" },
            attempts: { ...external.attempts, ...intersection(external.attempts, historyProof,
              `external-and-ledger-history:${hash(JSON.stringify([external.attempts, historyProof]))}`),
              // External records are NEVER removed, even when they name this same event.
              records: [...external.attempts.records, ...records] },
          };
          return { evidence: composeNotificationEvidence(source, event, combined).evidence, recipient };
        }

        phase = "preflight_evidence";
        const preflight = await evidence(handle);
        phase = "admission_source";
        handle = await refreshNotificationSource(handle);
        phase = "admission_evidence";
        const admission = await evidence(handle);
        const plan = planNotification({ event, preflight: preflight.evidence, final: admission.evidence }, now());
        if (plan.designStatus !== "eligible_in_proposal") return report("held", phase, plan.reasons);
        phase = "construction_review";
        const construction = buildGhlMessageRequest({ binding, recipient: admission.recipient, senderReview: prepared.sender,
          body: prepared.body, contentType: prepared.contentType, subject: prepared.subject, review: prepared.constructionReview,
          smsReceiptSuffixPolicy: prepared.smsReceiptSuffixPolicy });
        if (construction.state !== "constructed_disabled") return report("held", phase, construction.reasons);
        if (readOnly) return report("held", "read_only", ["read_only_evaluation_passed_no_reservation"]);
        const transportReview = structuredClone(await review(construction, event, binding));
        if (notificationEventHash(transportReview.event) !== notificationEventHash(event))
          return report("held", phase, ["transport_review_full_event_mismatch"]);
        const reviewed = reviewGhlTransportConstruction(construction, transportReview, now());
        if (!reviewed.handle) return report("held", phase, reviewed.reasons);
        // Reviews may wait. Recheck the two actual reads before writing any reservation.
        const boundary = planNotification({ event, preflight: preflight.evidence, final: admission.evidence }, now());
        if (boundary.designStatus !== "eligible_in_proposal") return report("held", phase, boundary.reasons);
        const due = invoiceCalendarDate(event.dueDate), scheduledOn = due && addInvoiceCalendarDays(due, event.dayPastDue);
        if (!scheduledOn) return report("held", phase, ["invalid_schedule"]);
        phase = "reservation";
        if (attemptedEvents.has(key)) return report("held", phase, ["logical_event_admission_already_attempted_no_retry"]);
        attemptedEvents.add(key); reserveAttempted = true;
        const claim = await ledger.reserve({ event, body: prepared.body, destination: event.destination,
          channel: event.channel, contactId: event.contactId, scheduledOn });
        if (claim.state !== "reserved") return report(claim.reason === "ledger_uncertain" ? "unknown" : "held", phase, [claim.reason]);
        reserved = true;
        phase = "final_source";
        handle = await refreshNotificationSource(handle);
        phase = "final_evidence";
        const final = await evidence(handle, claim.reservation);
        const gate = { event, preflight: admission.evidence, final: final.evidence };
        const finalPlan = planNotification(gate, now());
        if (finalPlan.designStatus !== "eligible_in_proposal") return report("held", phase, finalPlan.reasons, reserved);
        phase = "transport";
        // The real transport alone owns assertReserved → markPending → POST → markOutcome.
        const outcome = await transport.attempt(reviewed.handle, claim.reservation, gate);
        return report(outcome.state, phase, outcome.reasons, reserved, outcome);
      } catch {
        // No retry, no pending/outcome rewrite, no release/reclaim, no sensitive exception logs.
        return report(reserveAttempted ? "unknown" : "held", phase,
          [reserveAttempted ? "post_admission_failure_no_retry" : "required_input_or_read_unavailable"], reserved);
      }
    },
  });
}
