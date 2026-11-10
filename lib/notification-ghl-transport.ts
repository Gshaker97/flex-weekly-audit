/** Unwired one-attempt candidate. Explicit injected dependencies only; never call with live inputs without authorization. */
import { createHash } from "node:crypto";
import { eventKey, immutableEvent, planNotification, type Event, type Request } from "./notification-gate";
import { notificationDestinationHash, notificationEventHash, type NotificationLedger, type NotificationReservation } from "./notification-ledger";
import { GHL_NOTIFICATION_CONTRACT, inspectGhlConstructionForTransport, parseGhlAcceptance,
  type GhlConstructionResult, type GhlAcceptanceResult, type GhlMessageBinding, type GhlReadFetch,
  type GhlHttpObservation, type GhlSenderReview } from "./notification-ghl-contract";

export const GHL_TRANSPORT_LIMITS = Object.freeze({ requestBytes: 65_536, responseBytes: 65_536,
  responseChunks: 1024, timeoutMs: 5000, maxTimeoutMs: 30_000, reviewMaxAgeMs: 60_000,
  productionSendCapability: false, automaticRetry: false, maximumAttempts: 1 } as const);
declare const reviewedHandle: unique symbol;
export type GhlReviewedTransportHandle = Readonly<{ kind: "ghl-reviewed-one-attempt"; readonly [reviewedHandle]: true }>;
export type GhlTransportReview = Readonly<{
  mode: "reviewed-one-attempt"; event: Event; binding: GhlMessageBinding;
  reviewedAt: string; expiresAt: string;
  statusSemantics: Readonly<{ verified: true; version: "2021-07-28"; status: "pending"; evidenceRef: string }>;
  sender: GhlSenderReview;
  content: Readonly<{ approved: true; requestSha256: string; evidenceRef: string }>;
  /** Explicit authorization of this exact event, audience, destination and proposed timing. */
  authorization: Readonly<{ approved: true; timingApproved: true; requestSha256: string; evidenceRef: string }>;
}>;
export type GhlTransportReviewResult = Readonly<{
  state: "held" | "reviewed_candidate"; handle: GhlReviewedTransportHandle | null;
  reasons: readonly string[]; productionSendCapability: false;
}>;
export type GhlPostFetch = (url: string, init: Readonly<{
  method: "POST"; body: string; redirect: "error"; signal: AbortSignal;
  headers: Readonly<{ Authorization: string; Version: "2021-07-28"; "Content-Type": "application/json"; Accept: "application/json" }>;
}>) => Promise<Awaited<ReturnType<GhlReadFetch>>>;
export type GhlTransportOptions = Readonly<{
  /** Absent means disabled, including for an otherwise valid reviewed handle. */
  mode?: "reviewed-one-attempt";
  fetch: GhlPostFetch; credential: string; accountId: string; locationId: string; scopes: readonly string[];
  ledger: NotificationLedger; now: () => Date; timeoutMs?: number;
}>;
export type GhlTransportResult = Readonly<{
  state: "held" | "accepted" | "unknown"; attempted: boolean; reasons: readonly string[];
  acceptance: GhlAcceptanceResult | null; outcomePersisted: boolean;
  deliveryConfirmed: false; invoiceAttributionVerified: false; retryAllowed: false; productionSendCapability: false;
}>;
export type GhlOneAttemptTransport = Readonly<{
  productionSendCapability: false;
  /** Owns assertReserved → markPending → one POST → markOutcome. Do not markPending elsewhere first. */
  attempt(handle: GhlReviewedTransportHandle, reservation: NotificationReservation, finalGate: Request): Promise<GhlTransportResult>;
}>;

type Reviewed = Readonly<{ construction: GhlConstructionResult; binding: GhlMessageBinding; event: Event;
  requestSha256: string; reviewedAt: number; expiresAt: number }>;
const handles = new WeakMap<GhlReviewedTransportHandle, Reviewed>();
const reviewedConstructions = new WeakSet<GhlConstructionResult>();
const claimedEvents = new Set<string>();
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && value.trim() === value;
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
  Object.values(Object.getOwnPropertyDescriptors(value)).every(property => "value" in property);
function instant(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return NaN;
  const result = Date.parse(value);
  return Number.isFinite(result) && new Date(result).toISOString() === value ? result : NaN;
}
function bindingMatches(a: GhlMessageBinding, b: GhlMessageBinding): boolean {
  return (["accountId", "locationId", "contactId", "channel", "destination", "eventKey", "invoiceId", "sender", "bodyHash"] as const)
    .every(key => a[key] === b[key]);
}
function fresh(review: Pick<Reviewed, "reviewedAt" | "expiresAt">, now: number): boolean {
  return Number.isFinite(now) && review.reviewedAt <= now && now < review.expiresAt &&
    review.expiresAt > review.reviewedAt && review.expiresAt - review.reviewedAt <= GHL_TRANSPORT_LIMITS.reviewMaxAgeMs;
}
function result(state: GhlTransportResult["state"], attempted: boolean, reasons: readonly string[],
  acceptance: GhlAcceptanceResult | null = null, outcomePersisted = false): GhlTransportResult {
  return Object.freeze({ state, attempted, reasons: Object.freeze([...new Set(reasons)]), acceptance, outcomePersisted,
    deliveryConfirmed: false, invoiceAttributionVerified: false, retryAllowed: false, productionSendCapability: false });
}

/** Reviews are trusted explicit evidence assertions, not automatically discovered permission.
 * A construction-only descriptor, clone, or serialized handle cannot be sent by this module.
 */
export function reviewGhlTransportConstruction(construction: GhlConstructionResult, review: GhlTransportReview,
  now: Date): GhlTransportReviewResult {
  const reasons: string[] = [];
  let prepared: Reviewed | null = null;
  try {
    const original = inspectGhlConstructionForTransport(construction);
    if (!original || reviewedConstructions.has(construction)) reasons.push("construction_not_original_or_already_reviewed");
    if (!plain(review) || !plain(review.binding) || !plain(review.sender) || !plain(review.statusSemantics) ||
        !plain(review.content) || !plain(review.authorization)) throw new Error("invalid_review");
    if (review.mode !== "reviewed-one-attempt") reasons.push("explicit_transport_review_required");
    const reviewedAt = instant(review.reviewedAt), expiresAt = instant(review.expiresAt);
    if (!fresh({ reviewedAt, expiresAt }, now.getTime())) reasons.push("review_not_current");
    const s = review.statusSemantics;
    if (s.verified !== true || s.version !== GHL_NOTIFICATION_CONTRACT.version || s.status !== "pending" || !text(s.evidenceRef))
      reasons.push("status_semantics_not_verified");
    if (original) {
      const b = original.binding, wire = original.request, sender = review.sender, requestSha256 = hash(wire.serializedBody);
      if (!bindingMatches(b, review.binding)) reasons.push("review_binding_mismatch");
      if (sender.approved !== true || sender.validated !== true || !text(sender.evidenceRef) || sender.scope !== GHL_NOTIFICATION_CONTRACT.writeScope ||
          sender.accountId !== b.accountId || sender.locationId !== b.locationId || sender.channel !== b.channel || sender.sender !== b.sender)
        reasons.push("sender_not_reviewed_for_exact_scope");
      if (review.content.approved !== true || review.content.requestSha256 !== requestSha256 || !text(review.content.evidenceRef))
        reasons.push("exact_content_not_approved");
      if (review.authorization.approved !== true || review.authorization.timingApproved !== true ||
          review.authorization.requestSha256 !== requestSha256 || !text(review.authorization.evidenceRef)) reasons.push("exact_attempt_not_authorized");
      const event = immutableEvent(structuredClone(review.event));
      if (eventKey(event) !== b.eventKey || event.accountId !== b.accountId || event.invoiceId !== b.invoiceId || event.contactId !== b.contactId ||
          event.channel !== b.channel || event.destination !== b.destination || event.bodyDigest !== b.bodyHash) reasons.push("review_event_binding_mismatch");
      notificationEventHash(event); // Reject unsupported/non-JSON event data before issuing a handle.
      if (Buffer.byteLength(wire.serializedBody, "utf8") > GHL_TRANSPORT_LIMITS.requestBytes) reasons.push("request_byte_limit");
      if (wire.url !== GHL_NOTIFICATION_CONTRACT.baseUrl + GHL_NOTIFICATION_CONTRACT.sendPath || wire.method !== "POST" ||
          wire.headers.Version !== GHL_NOTIFICATION_CONTRACT.version || wire.body.status !== "pending") reasons.push("wire_contract_mismatch");
      if (!reasons.length) prepared = Object.freeze({ construction, binding: b, event, requestSha256, reviewedAt, expiresAt });
    }
  } catch { reasons.push("malformed_transport_review"); }
  let handle: GhlReviewedTransportHandle | null = null;
  if (prepared) {
    handle = Object.freeze({ kind: "ghl-reviewed-one-attempt" }) as GhlReviewedTransportHandle;
    handles.set(handle, prepared); reviewedConstructions.add(construction);
  }
  return Object.freeze({ state: handle ? "reviewed_candidate" : "held", handle, reasons: Object.freeze(reasons), productionSendCapability: false });
}

/** Factory is inert. Inject only the real reviewed ledger implementation for any future live use.
 * Its transaction acknowledgments, the clock and HTTP client are trusted dependency boundaries.
 */
export function createGhlOneAttemptTransport(options: GhlTransportOptions): GhlOneAttemptTransport {
  let fetch: GhlPostFetch, now: () => Date, ledger: NotificationLedger, credential: string, accountId: string, locationId: string;
  let mode: GhlTransportOptions["mode"], scopes: Set<string>, timeoutMs: number;
  try {
    if (!plain(options) || typeof options.fetch !== "function" || typeof options.now !== "function" || !text(options.accountId) ||
        !text(options.locationId) || typeof options.credential !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(options.credential) ||
        !options.ledger || ![options.ledger.assertReserved, options.ledger.markPending, options.ledger.markOutcome].every(fn => typeof fn === "function") ||
        !Array.isArray(options.scopes) || options.scopes.some(scope => typeof scope !== "string")) throw new Error();
    timeoutMs = options.timeoutMs ?? GHL_TRANSPORT_LIMITS.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > GHL_TRANSPORT_LIMITS.maxTimeoutMs) throw new Error();
    ({ fetch, now, ledger, credential, accountId, locationId, mode } = options); scopes = new Set(options.scopes);
  } catch { throw new Error("invalid_one_attempt_transport_configuration"); }
  const headers = Object.freeze({ Authorization: `Bearer ${credential}`, Version: GHL_NOTIFICATION_CONTRACT.version,
    "Content-Type": "application/json" as const, Accept: "application/json" as const });

  async function post(body: string): Promise<GhlHttpObservation | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, cancel: (() => void) | undefined;
    const abort = () => { controller.abort(); cancel?.(); };
    try {
      const deadline = new Promise<null>(resolve => { timer = setTimeout(() => { abort(); resolve(null); }, timeoutMs); });
      const exchange = (async (): Promise<GhlHttpObservation | null> => {
        const response = await fetch(GHL_NOTIFICATION_CONTRACT.baseUrl + GHL_NOTIFICATION_CONTRACT.sendPath,
          { method: "POST", headers, body, redirect: "error", signal: controller.signal });
        if (controller.signal.aborted || !Number.isSafeInteger(response.status) || response.status < 100 || response.status > 599 || !response.body) return null;
        const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
        cancel = () => { try { void reader.cancel().catch(() => {}); } catch { /* No logs. */ } };
        const chunks: string[] = [];
        let bytes = 0;
        while (true) {
          const chunk = await reader.read();
          if (controller.signal.aborted) return null;
          if (chunk.done) break;
          if (!(chunk.value instanceof Uint8Array) || !chunk.value.byteLength || chunks.length >= GHL_TRANSPORT_LIMITS.responseChunks) { abort(); return null; }
          bytes += chunk.value.byteLength;
          if (bytes > GHL_TRANSPORT_LIMITS.responseBytes) { abort(); return null; }
          chunks.push(decoder.decode(chunk.value, { stream: true }));
        }
        chunks.push(decoder.decode());
        if (controller.signal.aborted) return null;
        return { version: GHL_NOTIFICATION_CONTRACT.version, statusCode: response.status, body: JSON.parse(chunks.join("")) as unknown };
      })();
      return await Promise.race([exchange, deadline]);
    } catch { return null; }
    finally { if (timer !== undefined) clearTimeout(timer); abort(); }
  }

  return Object.freeze({ productionSendCapability: false,
    async attempt(handle, reservation, finalGate): Promise<GhlTransportResult> {
      const reviewed = handles.get(handle);
      if (!reviewed) return result("held", false, ["reviewed_handle_missing_forged_or_consumed"]);
      // Consume before any asynchronous work, including failures and use by another transport instance.
      handles.delete(handle);
      const claimKey = JSON.stringify([reviewed.binding.accountId, reviewed.binding.eventKey]);
      if (claimedEvents.has(claimKey)) return result("held", false, ["logical_event_already_attempted_in_process"]);
      claimedEvents.add(claimKey);
      let gate: Request, pending = false, attempted = false;
      let acceptance: GhlAcceptanceResult | null = null;
      try {
        const original = inspectGhlConstructionForTransport(reviewed.construction);
        if (mode !== "reviewed-one-attempt" || !scopes.has(GHL_NOTIFICATION_CONTRACT.writeScope) || accountId !== reviewed.binding.accountId ||
            locationId !== reviewed.binding.locationId || !original) return result("held", false, ["transport_disabled_or_scope_mismatch"]);
        if (!fresh(reviewed, now().getTime())) return result("held", false, ["review_expired_at_boundary"]);
        if (!reservation || reservation.eventHash !== notificationEventHash(reviewed.event) || reservation.bodyHash !== reviewed.binding.bodyHash ||
            reservation.destinationHash !== notificationDestinationHash(reviewed.event)) return result("held", false, ["reservation_exact_binding_mismatch"]);
        gate = structuredClone(finalGate);
        if (notificationEventHash(gate.event) !== reservation.eventHash || planNotification(gate, now()).designStatus !== "eligible_in_proposal")
          return result("held", false, ["fresh_final_gate_not_eligible"]);
        if (!await ledger.assertReserved(reservation)) return result("held", false, ["reservation_not_owned"]);
        if (!fresh(reviewed, now().getTime()) || planNotification(gate, now()).designStatus !== "eligible_in_proposal")
          return result("held", false, ["evidence_expired_before_pending"]);
        if (!await ledger.markPending(reservation)) return result("unknown", false, ["pending_commit_not_acknowledged"]);
        pending = true;
        if (!fresh(reviewed, now().getTime()) || planNotification(gate, now()).designStatus !== "eligible_in_proposal") {
          const saved = await ledger.markOutcome(reservation, { state: "unknown" });
          return result("held", false, ["evidence_expired_after_pending"], null, saved);
        }
        if (hash(original.request.serializedBody) !== reviewed.requestSha256) throw new Error("wire_changed");
        attempted = true;
        const response = await post(original.request.serializedBody);
        acceptance = parseGhlAcceptance(reviewed.construction, response ?? { version: GHL_NOTIFICATION_CONTRACT.version, statusCode: 0, body: null });
        const saved = await ledger.markOutcome(reservation, acceptance.state === "accepted" && acceptance.messageId
          ? { state: "accepted", providerMessageId: acceptance.messageId } : { state: "unknown" });
        if (!saved) return result("unknown", true, ["provider_outcome_not_durably_confirmed"], acceptance);
        return result(acceptance.state === "accepted" ? "accepted" : "unknown", true,
          acceptance.state === "accepted" ? ["acceptance_not_delivery"] : ["provider_outcome_unknown_no_retry"], acceptance, true);
      } catch {
        // No retry of the pending operation, provider request, or outcome write, even if acknowledgment was lost.
        return result("unknown", attempted, [pending ? "post_pending_outcome_unknown" : "admission_outcome_unknown"], acceptance);
      }
    },
  });
}
