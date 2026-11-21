/** Local, read-only candidate. No fetch, credentials, send, database connection, or production callsite. */
import { createHash } from "node:crypto";
import { invoiceCalendarDate } from "./invoice-reminder-clock";
import { eventKey, type AttemptState, type Event, type Evidence } from "./notification-gate";
import { notificationEventHash } from "./notification-ledger";

export const NOTIFICATION_HISTORY_CONTRACT = Object.freeze({
  origin: "https://services.leadconnectorhq.com", version: "2021-04-15",
  pageSize: 20, maxRequests: 101, maxMessages: 2000, maxLedgerRows: 1000,
  maxResponseBytes: 1_000_000, maxTotalBytes: 4_000_000, maxChunks: 4096,
  maxReadMs: 15_000, maxRequestMs: 5000, proofLifetimeMs: 60_000,
  productionSendCapability: false,
} as const);
export type NotificationHistoryScope = Readonly<{
  accountId: string; locationId: string; contactId: string; invoiceId: string;
  /** User-authoritative send date, not opportunity creation/stage-entry time. */
  issuedDate: string; audience: "homeowner";
}>;
export type NotificationHistoryRequest = Readonly<{
  scope: NotificationHistoryScope; reviewRef: string;
}>;
export type NotificationHistoryGet = Readonly<{
  method: "GET"; url: string; headers: Readonly<{ Version: "2021-04-15"; Accept: "application/json" }>;
  redirect: "error"; signal: AbortSignal; maximumAttempts: 1; automaticRetry: false;
}>;
/** Trusted application dependencies, never JSON/request-body assertions. The implementation
 * must bind credentials to this exact account/location, honor GET, abort, and no retries.
 * There is no ambient fetch/credential fallback. This module cannot authenticate a malicious IO. */
export type NotificationHistoryIO = Readonly<{
  accountId: string; locationId: string;
  get(request: NotificationHistoryGet): Promise<Readonly<{ status: number; body: ReadableStream<Uint8Array> | null }>>;
  /** Execute the supplied fixed SELECT once, exhaust its bounded result, with no retry. */
  select(statement: string, parameters: readonly string[]): Promise<readonly Record<string, unknown>[]>;
  now?: () => Date;
}>;
export type NotificationHistoryMessage = Readonly<{
  id: string; conversationId: string; dateAdded: string; messageType: string;
  direction: "inbound" | "outbound"; status: string | null;
  disposition: "before_issue_date" | "inbound" | "non_sms_email" | "mapped" | "unattributed" | "unsupported";
  eventKey: string | null; deliveryConfirmed: false;
}>;
export type NotificationHistorySnapshot = Readonly<{
  kind: "notification-history-v1"; scope: NotificationHistoryScope;
  observedAt: string; completedAt: string; expiresAt: string; sourceRef: string;
  state: "bounded_ready" | "held"; reasons: readonly string[];
  apiPaginationComplete: boolean; ledgerReadComplete: boolean;
  boundedAbsence: "no_outbound_sms_email_since_issue_date_in_returned_history" | null;
  messages: readonly NotificationHistoryMessage[];
  /** All validated local rows, including this runner's current reservation. Never excluded. */
  localLedgerRecords: Evidence["attempts"]["records"];
  /** Only actual mapped external message observations, never local-only reservations. */
  externalMessageRecords: Evidence["attempts"]["records"];
  /** Full union for inspection/standalone composition; NOT the runner's external input. */
  records: Evidence["attempts"]["records"];
  requests: number; responseBytes: number; limitations: readonly string[];
  productionSendCapability: false;
}>;
declare const historyBrand: unique symbol;
export type NotificationHistoryHandle = Readonly<{ [historyBrand]: true }>;
declare const externalHistoryBrand: unique symbol;
export type NotificationExternalHistoryHandle = Readonly<{ [externalHistoryBrand]: true }>;
export type NotificationExternalHistorySnapshot = Readonly<{
  kind: "notification-external-history-v1";
  coverage: "accessible-ghl-external-message-history-only";
  requiresIndependentLocalLedgerUnion: true;
  scope: NotificationHistoryScope;
  observedAt: string; completedAt: string; expiresAt: string; sourceRef: string;
  records: Evidence["attempts"]["records"];
  limitations: readonly string[]; productionSendCapability: false;
}>;
const issued = new WeakMap<NotificationHistoryHandle, NotificationHistorySnapshot>();
const externalIssued = new WeakMap<NotificationExternalHistoryHandle, NotificationExternalHistorySnapshot>();
const C = NOTIFICATION_HISTORY_CONTRACT;
const LIMITATIONS = Object.freeze([
  "accessible_api_history_only_not_global_history", "deleted_or_inaccessible_messages_not_provable",
  "non_atomic_pages_ledger_and_send_new_activity_can_race", "email_thread_expansion_unsupported",
  "search_continuation_cursor_not_documented_holds_if_total_exceeds_returned_page",
  "fresh_invoice_owner_recipient_dnd_and_authorizations_required_independently",
  "internal_angie_and_general_rollout_unsupported",
]);
const LEDGER = `/* notification-history:read-only */
SELECT "id", "accountId", "invoiceId", "dayPastDue", "audience", "contactId", "channel",
  "eventKey", "eventPayload", "eventHash", "state", "providerMessageId"
FROM "NotificationLedger" WHERE "accountId" = $1 AND "contactId" = $2 ORDER BY "id" LIMIT 1001`;
const states: readonly string[] = ["reserved", "pending", "accepted", "delivered", "rejected", "unknown"];
const statuses = ["connected", "delivered", "failed", "opened", "pending", "read", "scheduled", "sent", "undelivered", "clicked", "opt_out"];
const smsTypes = ["TYPE_SMS", "TYPE_SMS_REVIEW_REQUEST", "TYPE_SMS_NO_SHOW_REQUEST", "TYPE_CAMPAIGN_SMS"];
const emailTypes = ["TYPE_EMAIL", "TYPE_CAMPAIGN_EMAIL"];
// Only these documented non-text channels can be dismissed. All other types hold.
const irrelevantTypes = ["TYPE_CALL"];
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(v);
const text = (v: unknown): v is string => typeof v === "string" && !!v && v.length <= 256 && v.trim() === v && !v.includes("\0");
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function timestamp(v: unknown): number {
  if (typeof v !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v)) return NaN;
  const canonical = v.replace(/(?:\.(\d{1,3}))?Z$/, (_, f: string | undefined) => `.${(f ?? "").padEnd(3, "0")}Z`);
  const n = Date.parse(v);
  return Number.isFinite(n) && new Date(n).toISOString() === canonical ? n : NaN;
}
class HistoryFailure extends Error {}
function fail(reason: string): never { throw new HistoryFailure(reason); }
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
type Mapping = { event: Event; key: string; state: AttemptState; providerId: string | null };

/** Parse only actual documented fields. No invoiceId/opportunityId, wording, status or
 * schedule/date heuristics can supply invoice attribution. Responses are parsed here,
 * not replaced by caller booleans. Ledger records are copied before asynchronous GETs. */
export async function readNotificationHistory(request: NotificationHistoryRequest, io: NotificationHistoryIO): Promise<NotificationHistoryHandle> {
  const scope = Object.freeze({ ...request.scope }), reviewRef = request.reviewRef;
  const clock = io.now ?? (() => new Date()), get = io.get.bind(io), select = io.select.bind(io);
  const started = clock().getTime(), wallStarted = performance.now();
  const sentOn = invoiceCalendarDate(scope.issuedDate);
  if (![scope.accountId, scope.invoiceId, reviewRef].every(text) || !id(scope.locationId) || !id(scope.contactId) ||
      scope.audience !== "homeowner" || !sentOn || !Number.isFinite(started) ||
      sentOn > invoiceCalendarDate(new Date(started))! || io.accountId !== scope.accountId || io.locationId !== scope.locationId)
    fail("invalid_exact_history_scope");
  const reasons: string[] = [], messages: NotificationHistoryMessage[] = [];
  const records: { eventKey: string; state: AttemptState }[] = [];
  const localLedgerRecords: { eventKey: string; state: AttemptState }[] = [];
  const externalMessageRecords: { eventKey: string; state: AttemptState }[] = [];
  const mappings = new Map<string, Mapping>();
  let requests = 0, responseBytes = 0, apiPaginationComplete = false, ledgerReadComplete = false;
  let outbound = 0, lastClock = started;
  const hold = (r: string) => { if (!reasons.includes(r)) reasons.push(r); };
  function remaining() {
    const at = clock().getTime();
    if (!Number.isFinite(at) || at < lastClock) fail("history_clock_invalid_or_reversed");
    lastClock = at;
    const left = C.maxReadMs - Math.max(at - started, performance.now() - wallStarted);
    if (left <= 0) fail("history_deadline");
    return left;
  }
  async function bounded<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve().then(() => work(controller.signal)), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new HistoryFailure("history_deadline")); }, ms);
      })]);
    } finally { if (timer) clearTimeout(timer); controller.abort(); }
  }
  async function read(path: string, query: URLSearchParams): Promise<Record<string, unknown>> {
    if (requests >= C.maxRequests) fail("history_request_limit");
    const deadline = Math.min(remaining(), C.maxRequestMs);
    requests++;
    return bounded(async signal => {
      const response = await get(Object.freeze({ method: "GET", url: `${C.origin}${path}?${query}`,
        headers: Object.freeze({ Version: C.version, Accept: "application/json" }), redirect: "error", signal,
        maximumAttempts: 1, automaticRetry: false }));
      if (signal.aborted) fail("history_deadline");
      if (response.status !== 200 || !response.body) {
        if (response.body) void response.body.cancel().catch(() => undefined);
        fail("history_http_unavailable");
      }
      const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
      const cancel = () => { void reader.cancel().catch(() => undefined); };
      signal.addEventListener("abort", cancel, { once: true });
      let bytes = 0, chunks = 0, body = "";
      try {
        for (;;) {
          const part = await reader.read();
          if (signal.aborted) fail("history_deadline");
          remaining();
          if (part.done) break;
          if (!(part.value instanceof Uint8Array) || ++chunks > C.maxChunks) fail("history_chunk_limit");
          bytes += part.value.byteLength; responseBytes += part.value.byteLength;
          if (bytes > C.maxResponseBytes || responseBytes > C.maxTotalBytes) fail("history_byte_limit");
          body += decoder.decode(part.value, { stream: true });
        }
        body += decoder.decode();
        let parsed: unknown;
        try { parsed = JSON.parse(body); } catch { fail("history_malformed_json"); }
        if (!object(parsed)) fail("history_malformed_response");
        return parsed;
      } finally { signal.removeEventListener("abort", cancel); cancel(); }
    }, deadline);
  }
  // Independent ledger read remains useful even if provider history is unavailable.
  try {
    const rows = await bounded(() => select(LEDGER, Object.freeze([scope.accountId, scope.contactId])), remaining());
    remaining();
    if (!Array.isArray(rows) || rows.length > C.maxLedgerRows) fail("ledger_history_limit_or_malformed");
    const seen = new Set<string>(); let ledgerBytes = 0;
    for (const row of rows) {
      if (!object(row) || !id(row.id) || seen.has(row.id) || row.accountId !== scope.accountId || row.contactId !== scope.contactId ||
          !states.includes(row.state as string) || !object(row.eventPayload)) fail("ledger_history_unverified");
      seen.add(row.id);
      // Canonical hash validates bounded plain JSON before snapshotting it.
      if (notificationEventHash(row.eventPayload as Event) !== row.eventHash) fail("ledger_immutable_event_mismatch");
      ledgerBytes += Buffer.byteLength(JSON.stringify(row), "utf8");
      if (ledgerBytes > C.maxTotalBytes) fail("ledger_history_byte_limit");
      const event = JSON.parse(JSON.stringify(row.eventPayload)) as Event, key = eventKey(event);
      if (key !== row.eventKey || event.accountId !== scope.accountId || event.contactId !== scope.contactId ||
          event.invoiceId !== row.invoiceId || event.dayPastDue !== row.dayPastDue || event.audience !== row.audience ||
          event.channel !== row.channel || !["homeowner", "internal"].includes(event.audience) ||
          !["sms", "email"].includes(event.channel) || !text(event.invoiceId) || !Number.isSafeInteger(event.dayPastDue))
        fail("ledger_immutable_event_mismatch");
      const localRecord = Object.freeze({ eventKey: key, state: row.state as AttemptState });
      records.push(localRecord); localLedgerRecords.push(localRecord);
      if (row.providerMessageId != null) {
        if (!id(row.providerMessageId) || mappings.has(row.providerMessageId)) fail("ledger_provider_mapping_ambiguous");
        mappings.set(row.providerMessageId, { event, key, state: row.state as AttemptState, providerId: row.providerMessageId });
      }
    }
    ledgerReadComplete = true;
  } catch (error) { hold(error instanceof HistoryFailure ? error.message : "ledger_history_unavailable"); }
  try {
    const search = await read("/conversations/search", new URLSearchParams({ locationId: scope.locationId,
      contactId: scope.contactId, status: "all", sortBy: "last_message_date", sort: "desc", limit: String(C.pageSize) }));
    if (!Array.isArray(search.conversations) || search.conversations.length > C.pageSize ||
        !Number.isSafeInteger(search.total) || (search.total as number) < search.conversations.length) fail("conversation_search_malformed");
    // The documented schema has no sort value/cursor field. Never guess lastMessageDate,
    // derive a cursor from wording, or treat a short page as proof of exhaustion.
    if (search.total !== search.conversations.length) fail("conversation_search_continuation_unverified");
    const conversationIds = new Set<string>(), messageIds = new Set<string>();
    for (const c of search.conversations) {
      if (!object(c) || !id(c.id) || c.contactId !== scope.contactId || c.locationId !== scope.locationId || conversationIds.has(c.id))
        fail("conversation_identity_or_duplicate");
      conversationIds.add(c.id);
    }
    for (const conversationId of conversationIds) {
      let cursor: string | undefined;
      const cursors = new Set<string>();
      for (;;) {
        const query = new URLSearchParams({ limit: String(C.pageSize) });
        if (cursor) query.set("lastMessageId", cursor);
        const page = await read(`/conversations/${encodeURIComponent(conversationId)}/messages`, query), p = page.messages;
        if (!object(p) || !Array.isArray(p.messages) || p.messages.length > C.pageSize || typeof p.nextPage !== "boolean" ||
            typeof p.lastMessageId !== "string") fail("message_page_malformed");
        if ((p.messages.length && (!id(p.lastMessageId) || p.lastMessageId !== p.messages.at(-1)?.id)) ||
            (p.nextPage && (!p.messages.length || !id(p.lastMessageId) || cursors.has(p.lastMessageId)))) fail("message_cursor_invalid_or_duplicate");
        if (p.messages.length && cursors.has(p.lastMessageId)) fail("message_cursor_invalid_or_duplicate");
        for (const m of p.messages) {
          if (!object(m) || !id(m.id) || messageIds.has(m.id)) fail("message_identity_or_duplicate");
          messageIds.add(m.id);
          if (messageIds.size > C.maxMessages) fail("history_message_limit");
          if (m.contactId !== scope.contactId || m.locationId !== scope.locationId || m.conversationId !== conversationId)
            fail("message_scope_mismatch");
          if (!Number.isFinite(timestamp(m.dateAdded)) || timestamp(m.dateAdded) > clock().getTime()) fail("message_timestamp_unverified");
          if (m.direction !== "inbound" && m.direction !== "outbound") fail("message_direction_unverified");
          if (!Number.isSafeInteger(m.type) || typeof m.messageType !== "string") fail("message_type_unverified");
          const isSms = smsTypes.includes(m.messageType), isEmail = emailTypes.includes(m.messageType), irrelevant = irrelevantTypes.includes(m.messageType);
          const afterIssue = invoiceCalendarDate(m.dateAdded as string)! >= sentOn;
          const mapping = mappings.get(m.id);
          let disposition: NotificationHistoryMessage["disposition"] = "unsupported", mappedKey: string | null = null;
          if ((!isSms && !isEmail && !irrelevant) || (isSms && [1, 3, 10].includes(m.type as number)) ||
              (irrelevant && m.type !== 1)) hold("message_type_unverified");
          else if (isEmail || (object(m.meta) && m.meta.email !== undefined)) {
            // A thread's direction/date/status do not describe every individual email.
            hold("email_thread_history_unresolved");
          } else if (m.direction === "inbound") disposition = "inbound";
          else if (irrelevant) disposition = "non_sms_email";
          else if (!afterIssue && !mapping) disposition = "before_issue_date";
          else {
            if (afterIssue) outbound++;
            if (!statuses.includes(m.status as string)) hold("provider_outcome_unknown");
            if (!mapping) { disposition = "unattributed"; hold("outbound_invoice_attribution_unresolved"); }
            else if (mapping.event.channel !== "sms" || mapping.event.audience !== "homeowner" ||
                     mapping.event.homeownerContactId !== scope.contactId) hold("ledger_provider_binding_mismatch");
            else {
              disposition = "mapped"; mappedKey = mapping.key;
              // Add the observed attempt without rewriting ANY immutable ledger record or
              // upgrading 'sent' to delivery. Receipt semantics require separate verification.
              const externalRecord = Object.freeze({ eventKey: mapping.key, state: "unknown" as const });
              records.push(externalRecord); externalMessageRecords.push(externalRecord);
            }
          }
          // A provider ID in the ledger cannot be ignored as inbound/non-SMS or before issue.
          if (mapping && disposition !== "mapped") hold("ledger_provider_binding_mismatch");
          messages.push(Object.freeze({ id: m.id, conversationId, dateAdded: m.dateAdded as string,
            messageType: m.messageType, direction: m.direction, status: typeof m.status === "string" ? m.status : null,
            disposition, eventKey: mappedKey, deliveryConfirmed: false }));
        }
        if (!p.nextPage) break;
        cursors.add(p.lastMessageId); cursor = p.lastMessageId;
      }
    }
    remaining(); apiPaginationComplete = true;
  } catch (error) {
    hold(error instanceof HistoryFailure ? error.message : "history_read_unavailable");
  }
  const completed = clock().getTime();
  if (!Number.isFinite(completed) || completed < started || completed - started >= C.maxReadMs) hold("history_clock_invalid_or_expired");
  const ready = reasons.length === 0 && apiPaginationComplete && ledgerReadComplete;
  const snapshot: NotificationHistorySnapshot = Object.freeze({ kind: "notification-history-v1", scope,
    observedAt: new Date(started).toISOString(), completedAt: new Date(Number.isFinite(completed) ? completed : started).toISOString(),
    expiresAt: new Date(started + C.proofLifetimeMs).toISOString(), sourceRef: `notification-history:${hash([scope, reviewRef, started, messages, records])}`,
    state: ready ? "bounded_ready" : "held", reasons: Object.freeze(reasons), apiPaginationComplete, ledgerReadComplete,
    boundedAbsence: ready && outbound === 0 ? "no_outbound_sms_email_since_issue_date_in_returned_history" : null,
    messages: Object.freeze(messages), localLedgerRecords: Object.freeze(localLedgerRecords),
    externalMessageRecords: Object.freeze(externalMessageRecords), records: Object.freeze(records), requests, responseBytes,
    limitations: LIMITATIONS, productionSendCapability: false });
  const handle = Object.freeze({}) as NotificationHistoryHandle;
  issued.set(handle, snapshot); return handle;
}

export function inspectNotificationHistory(handle: NotificationHistoryHandle): NotificationHistorySnapshot {
  const result = issued.get(handle); if (!result) fail("unrecognized_history_handle"); return result;
}

/** Full-union projection, NOT suitable as NotificationRunner.readExternal's history input:
 * it deliberately includes the current local reservation. Use the opaque external-only
 * projection below for a caller which independently reads/unions the local ledger.
 * Narrow projection for a separately reviewed single homeowner invoice. 'historyComplete'
 * here means exhausted, attributable accessible API + trusted ledger evidence, NOT global
 * completeness. This cannot substitute for fresh invoice/source/owner/DND/approval evidence.
 * Final checks must obtain a NEW handle, not restamp/reuse this observation. */
export function composeNotificationHistoryAttempts(handle: NotificationHistoryHandle, event: Event, now: Date):
  Readonly<{ attempts: Evidence["attempts"] | null; reasons: readonly string[]; productionSendCapability: false }> {
  const snapshot = inspectNotificationHistory(handle), s = snapshot.scope, at = now.getTime();
  const reasons = [...snapshot.reasons];
  if (snapshot.state !== "bounded_ready") reasons.push("history_not_ready");
  if (!Number.isFinite(at) || at < timestamp(snapshot.completedAt) || at >= timestamp(snapshot.expiresAt)) reasons.push("history_not_fresh");
  if (event.accountId !== s.accountId || event.invoiceId !== s.invoiceId || event.contactId !== s.contactId ||
      event.homeownerContactId !== s.contactId || event.audience !== "homeowner" || event.issuedDate !== s.issuedDate ||
      !["sms", "email"].includes(event.channel)) reasons.push("history_event_scope_mismatch");
  return Object.freeze({ attempts: reasons.length ? null : Object.freeze({ accountId: s.accountId, historyComplete: true,
    observedAt: snapshot.observedAt, expiresAt: snapshot.expiresAt, sourceRef: snapshot.sourceRef, records: snapshot.records }),
    reasons: Object.freeze([...new Set(reasons)]), productionSendCapability: false });
}

/** Mint an opaque EXTERNAL-ONLY view from complete original source facts, never exclusions.
 * Local rows supplied only the trusted ID→immutable event mapping. This view's records are
 * actual external observations; absence here says nothing about local attempts/reservations.
 * Every original local row remains in the full inspection. Held reads cannot mint this view. */
export function projectAccessibleGhlExternalHistory(handle: NotificationHistoryHandle):
  Readonly<{ handle: NotificationExternalHistoryHandle | null; reasons: readonly string[] }> {
  const source = inspectNotificationHistory(handle);
  if (source.state !== "bounded_ready") return Object.freeze({ handle: null, reasons: source.reasons });
  const snapshot: NotificationExternalHistorySnapshot = Object.freeze({ kind: "notification-external-history-v1",
    coverage: "accessible-ghl-external-message-history-only", requiresIndependentLocalLedgerUnion: true,
    scope: source.scope, observedAt: source.observedAt, completedAt: source.completedAt, expiresAt: source.expiresAt,
    sourceRef: `notification-external-history:${hash(source.sourceRef)}`, records: source.externalMessageRecords,
    limitations: source.limitations, productionSendCapability: false });
  const projected = Object.freeze({}) as NotificationExternalHistoryHandle;
  externalIssued.set(projected, snapshot);
  return Object.freeze({ handle: projected, reasons: Object.freeze([]) });
}

export function inspectAccessibleGhlExternalHistory(handle: NotificationExternalHistoryHandle): NotificationExternalHistorySnapshot {
  const snapshot = externalIssued.get(handle);
  if (!snapshot) fail("unrecognized_external_history_handle");
  return snapshot;
}

/** ONLY the runner's external input, never standalone gate evidence. The caller MUST freshly
 * query/validate actual local ledger rows and union them with ALL these external records.
 * Only that separate local-ledger read may apply its original-owned-reservation capability
 * rule. This API accepts no reservation, exclusion IDs, or caller completeness boolean.
 * The legacy historyComplete field asserts ONLY the explicitly named external coverage. */
export function composeAccessibleGhlExternalAttempts(handle: NotificationExternalHistoryHandle, event: Event, now: Date):
  Readonly<{ coverage: "accessible-ghl-external-message-history-only"; requiresIndependentLocalLedgerUnion: true;
    attempts: Evidence["attempts"] | null; reasons: readonly string[]; productionSendCapability: false }> {
  const snapshot = inspectAccessibleGhlExternalHistory(handle), s = snapshot.scope, at = now.getTime();
  const reasons: string[] = [];
  if (!Number.isFinite(at) || at < timestamp(snapshot.completedAt) || at >= timestamp(snapshot.expiresAt)) reasons.push("history_not_fresh");
  if (event.accountId !== s.accountId || event.invoiceId !== s.invoiceId || event.contactId !== s.contactId ||
      event.homeownerContactId !== s.contactId || event.audience !== "homeowner" || event.issuedDate !== s.issuedDate ||
      !["sms", "email"].includes(event.channel)) reasons.push("history_event_scope_mismatch");
  return Object.freeze({ coverage: snapshot.coverage, requiresIndependentLocalLedgerUnion: true,
    attempts: reasons.length ? null : Object.freeze({ accountId: s.accountId, historyComplete: true,
      observedAt: snapshot.observedAt, expiresAt: snapshot.expiresAt, sourceRef: snapshot.sourceRef, records: snapshot.records }),
    reasons: Object.freeze(reasons), productionSendCapability: false });
}
