/**
 * THE ONE THING THIS REPO HAS NEVER HAD: a credentialed send.
 *
 * Everything else in the catch-up chain was already built and tested. The gap
 * was always this - the single authenticated POST - and it was left open on
 * purpose, because a transport that exists is a transport that can be called by
 * accident. This closes it for ONE batch, under an approval that names every
 * message by the hash of its own bytes.
 *
 * WHY THIS IS NOT `lib/notification-ghl-transport.ts`, WHICH ALREADY POSTS.
 * That module is the LADDER's transport, and it requires the notification gate
 * to find each message eligible. The gate holds anything that is not a real
 * milestone, today, inside the 09:00-09:15 Phoenix window:
 *
 *   unsupported_milestone_or_audience   the catch-up replays days 1, 4, 5, 6,
 *                                       8, 11, 13, 14, 41, 57, 69 and 71. The
 *                                       rungs are 10, 15, 20, 21, 25, 30, 35.
 *                                       Not one catch-up day is a rung.
 *   past_milestone_no_replay            a catch-up IS a replay of rungs that
 *                                       were missed. That is its purpose.
 *   outside_proposed_window_no_catch_up the gate's own name for refusing this.
 *
 * So the ladder transport would refuse all of these messages three times over,
 * and the only way to push them through it is to relax the gate - which would
 * relax it for every ordinary reminder too. That is not a trade worth making
 * for a one-time batch, so this is a second, narrower path instead, and the
 * reason is written here rather than left to be discovered.
 *
 * WHAT IT KEEPS FROM THE LADDER TRANSPORT, DELIBERATELY UNCHANGED: one attempt
 * and never a retry, the pinned URL and version, the request byte ceiling, the
 * response byte and chunk ceilings, a hard timeout, `redirect: "error"`, fatal
 * UTF-8 decoding, and no logging of any response or secret.
 *
 * WHAT IT ADDS: nothing is sent unless the exact serialized request appears in
 * an approved manifest, and each approved request may be attempted once.
 *
 * WHAT IT CANNOT DO. It cannot approve anything, choose a recipient, write the
 * words, or decide an invoice is owed. It receives a finished request and
 * either posts it once or refuses. A refusal is reported as an unknown outcome,
 * never as a success and never as a reason to try again.
 */
import { GHL_NOTIFICATION_CONTRACT, type GhlHttpObservation, type GhlRequestDescriptor } from "./notification-ghl-contract";
import { GHL_TRANSPORT_LIMITS, type GhlPostFetch } from "./notification-ghl-transport";
import {
  catchupApprovalCovers, catchupApprovedManifest, catchupRequestSha256, claimCatchupAttempt,
  type CatchupApproval,
} from "./catchup-attestation";

/** The one mode string that permits a send. Absent means disabled. */
export const CATCHUP_TRANSPORT_MODE = "approved-one-attempt-per-message" as const;

export type CatchupTransportOptions = Readonly<{
  /** Absent means disabled, including with a valid approval. */
  mode?: typeof CATCHUP_TRANSPORT_MODE;
  fetch: GhlPostFetch;
  credential: string;
  accountId: string;
  locationId: string;
  scopes: readonly string[];
  approval: CatchupApproval;
  now: () => Date;
  timeoutMs?: number;
}>;

export type CatchupTransportReadiness = Readonly<{
  ready: boolean;
  missing: readonly string[];
  approvedMessages: number;
}>;

export type CatchupTransport = Readonly<{
  /** Matches `CatchupDispatchIO["attemptSend"]`, so the dispatcher is unchanged. */
  attemptSend(descriptor: GhlRequestDescriptor): Promise<GhlHttpObservation>;
  /** Would this request be sent, without attempting it? For a pre-flight. */
  covers(descriptor: GhlRequestDescriptor): boolean;
  readonly attempted: readonly string[];
  readonly refused: readonly Readonly<{ requestSha256: string; reason: string }>[];
}>;

/** An observation the acceptance parser cannot accept: "we did not send, and we know it". */
const NOT_SENT: GhlHttpObservation = Object.freeze({ version: null, statusCode: null, body: null });

const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/**
 * What is still missing before this transport could send anything.
 *
 * Checked BEFORE the dispatcher reserves a ledger row, because the ledger has
 * no release: a row reserved for a message a misconfigured transport then
 * refuses is stuck forever. Readiness is how a bad configuration costs nothing.
 */
export function catchupTransportReadiness(options: Partial<CatchupTransportOptions>): CatchupTransportReadiness {
  const missing: string[] = [];
  if (options?.mode !== CATCHUP_TRANSPORT_MODE) missing.push("explicit_transport_mode_required");
  if (typeof options?.fetch !== "function") missing.push("http_client_required");
  if (typeof options?.now !== "function") missing.push("clock_required");
  if (!text(options?.credential) || !/^[\x21-\x7e]{1,8192}$/.test(options!.credential!)) missing.push("credential_missing_or_malformed");
  if (!text(options?.accountId)) missing.push("account_id_required");
  if (!text(options?.locationId)) missing.push("location_id_required");
  if (!Array.isArray(options?.scopes) || !options!.scopes!.includes(GHL_NOTIFICATION_CONTRACT.writeScope)) {
    missing.push("write_scope_required");
  }
  const manifest = options?.approval ? catchupApprovedManifest(options.approval) : null;
  if (!manifest) missing.push("approved_manifest_required");
  if (manifest && text(options?.accountId) && manifest.accountId !== options!.accountId) missing.push("manifest_account_mismatch");
  if (manifest && text(options?.locationId) && manifest.locationId !== options!.locationId) missing.push("manifest_location_mismatch");
  const timeoutMs = options?.timeoutMs ?? GHL_TRANSPORT_LIMITS.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > GHL_TRANSPORT_LIMITS.maxTimeoutMs) {
    missing.push("timeout_out_of_range");
  }
  return Object.freeze({
    ready: missing.length === 0,
    missing: Object.freeze([...new Set(missing)].sort()),
    approvedMessages: manifest?.entries.length ?? 0,
  });
}

export function createCatchupTransport(options: CatchupTransportOptions): CatchupTransport {
  const readiness = catchupTransportReadiness(options);
  if (!readiness.ready) throw new Error(`invalid_catchup_transport_configuration:${readiness.missing.join(",")}`);

  const { fetch: post, credential, accountId, locationId, approval, now } = options;
  const timeoutMs = options.timeoutMs ?? GHL_TRANSPORT_LIMITS.timeoutMs;
  const headers = Object.freeze({
    Authorization: `Bearer ${credential}`,
    Version: GHL_NOTIFICATION_CONTRACT.version,
    "Content-Type": "application/json" as const,
    Accept: "application/json" as const,
  });
  const attempted: string[] = [];
  const refused: { requestSha256: string; reason: string }[] = [];

  /** Every reason a finished request is still not postable. */
  function reject(descriptor: GhlRequestDescriptor): string | null {
    if (!descriptor || typeof descriptor !== "object") return "descriptor_missing";
    if (descriptor.method !== "POST") return "descriptor_method_not_post";
    if (descriptor.url !== GHL_NOTIFICATION_CONTRACT.baseUrl + GHL_NOTIFICATION_CONTRACT.sendPath) return "descriptor_url_not_pinned_send_path";
    if (descriptor.headers?.Version !== GHL_NOTIFICATION_CONTRACT.version) return "descriptor_version_mismatch";
    if ((descriptor.body as Record<string, unknown> | undefined)?.status !== "pending") return "descriptor_status_not_pending";
    if (descriptor.maximumAttempts !== 1 || descriptor.automaticRetry !== false) return "descriptor_retry_policy_mismatch";
    if (typeof descriptor.serializedBody !== "string") return "descriptor_body_not_serialized";
    if (Buffer.byteLength(descriptor.serializedBody, "utf8") > GHL_TRANSPORT_LIMITS.requestBytes) return "request_byte_limit";
    const manifest = catchupApprovedManifest(approval);
    if (!manifest) return "approval_not_recognized";
    if (manifest.accountId !== accountId || manifest.locationId !== locationId) return "approval_scope_mismatch";
    return null;
  }

  async function exchange(body: string): Promise<GhlHttpObservation | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, cancel: (() => void) | undefined;
    const abort = () => { controller.abort(); cancel?.(); };
    try {
      const deadline = new Promise<null>(resolve => { timer = setTimeout(() => { abort(); resolve(null); }, timeoutMs); });
      const read = (async (): Promise<GhlHttpObservation | null> => {
        const response = await post(GHL_NOTIFICATION_CONTRACT.baseUrl + GHL_NOTIFICATION_CONTRACT.sendPath,
          { method: "POST", headers, body, redirect: "error", signal: controller.signal });
        if (controller.signal.aborted || !Number.isSafeInteger(response.status)
          || response.status < 100 || response.status > 599 || !response.body) return null;
        const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
        cancel = () => { try { void reader.cancel().catch(() => {}); } catch { /* No response or secret logging. */ } };
        const chunks: string[] = [];
        let bytes = 0;
        while (true) {
          const chunk = await reader.read();
          if (controller.signal.aborted) return null;
          if (chunk.done) break;
          if (!(chunk.value instanceof Uint8Array) || !chunk.value.byteLength
            || chunks.length >= GHL_TRANSPORT_LIMITS.responseChunks) { abort(); return null; }
          bytes += chunk.value.byteLength;
          if (bytes > GHL_TRANSPORT_LIMITS.responseBytes) { abort(); return null; }
          chunks.push(decoder.decode(chunk.value, { stream: true }));
        }
        chunks.push(decoder.decode());
        if (controller.signal.aborted) return null;
        return { version: GHL_NOTIFICATION_CONTRACT.version, statusCode: response.status, body: JSON.parse(chunks.join("")) as unknown };
      })();
      return await Promise.race([read, deadline]);
    } catch { return null; }
    finally { if (timer !== undefined) clearTimeout(timer); abort(); }
  }

  return Object.freeze({
    get attempted() { return Object.freeze([...attempted]); },
    get refused() { return Object.freeze(refused.map(row => Object.freeze({ ...row }))); },

    covers(descriptor: GhlRequestDescriptor): boolean {
      if (reject(descriptor)) return false;
      return catchupApprovalCovers(approval, catchupRequestSha256(descriptor.serializedBody));
    },

    async attemptSend(descriptor: GhlRequestDescriptor): Promise<GhlHttpObservation> {
      let hash = "";
      try {
        const bad = reject(descriptor);
        if (bad) { refused.push({ requestSha256: "", reason: bad }); return NOT_SENT; }
        hash = catchupRequestSha256(descriptor.serializedBody);

        // The whole gate: these exact bytes must be in the approved manifest.
        // Claimed BEFORE the attempt, so an attempt that crashes or times out
        // cannot be mistaken for one that never happened.
        if (!claimCatchupAttempt(approval, hash)) {
          refused.push({ requestSha256: hash,
            reason: catchupApprovedManifest(approval)?.entries.some(e => e.requestSha256 === hash)
              ? "message_already_attempted_under_this_approval"
              : "message_not_in_approved_manifest" });
          return NOT_SENT;
        }
        if (!Number.isFinite(now().getTime())) { refused.push({ requestSha256: hash, reason: "clock_unreadable" }); return NOT_SENT; }

        attempted.push(hash);
        const observation = await exchange(descriptor.serializedBody);
        // A null exchange is a real, final uncertain outcome. Not a retry.
        return observation ?? NOT_SENT;
      } catch {
        if (hash && !attempted.includes(hash)) refused.push({ requestSha256: hash, reason: "attempt_threw_before_send" });
        return NOT_SENT;
      }
    },
  });
}
