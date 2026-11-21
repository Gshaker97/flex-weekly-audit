/** Unwired, GET-only configured-SMS-sender facts. No ambient credentials, approval, or send path. */
export const NOTIFICATION_SENDER_CONTRACT = Object.freeze({
  baseUrl: "https://services.leadconnectorhq.com", version: "v3", readScope: "phonenumbers.read",
  page: 0, pageSize: 100, skipNumberPool: false,
  responseBytes: 1_000_000, responseChunks: 2048, timeoutMs: 5000, maxTimeoutMs: 30_000,
  factMaxAgeMs: 60_000, maximumRequests: 1, automaticRetry: false, productionSendCapability: false,
} as const);
export type NotificationSenderBinding = Readonly<{
  accountId: string; locationId: string; expectedNumber: string;
}>;
export type NotificationSenderFetch = (url: string, init: Readonly<{
  method: "GET"; redirect: "error"; signal: AbortSignal;
  headers: Readonly<{ Authorization: string; Version: "v3"; Accept: "application/json" }>;
}>) => Promise<Readonly<{
  status: number; url: string; redirected: boolean;
  body: Readonly<{ getReader(): Readonly<{
    read(): Promise<Readonly<{ done: boolean; value?: Uint8Array }>>;
    cancel(): Promise<unknown>;
  }> }> | null;
}>>;
export type NotificationSenderOptions = Readonly<{
  fetch: NotificationSenderFetch; credential: string; accountId: string; locationId: string;
  scopes: readonly string[]; now: () => Date; timeoutMs?: number;
}>;
declare const senderFactBrand: unique symbol;
export type NotificationSenderHandle = Readonly<{ [senderFactBrand]: true }>;
export type NotificationSenderFacts = NotificationSenderBinding & Readonly<{
  kind: "configured-sms-sender-v1"; version: "v3"; observedAt: string; expiresAt: string;
  accountBinding: "caller-supplied"; locationBinding: "request-path";
  responseLocationId: string | null; numberLocationId: string | null;
  accountStatus: "active"; isUnderLc: boolean | null;
  capabilities: Readonly<{ sms: true; mms: boolean | null; voice: boolean | null; fax: boolean | null }>;
  isDefaultNumber: boolean | null;
  page: 0; pageSize: 100; returnedEntries: number; total: number | null;
  matchingEntriesInPage: 1; inventoryComplete: null; globalUniquenessVerified: false;
  /** Facts are not approval, credential scope attestation, consent, or delivery evidence. */
  senderApproved: false; writeScopeVerified: false; a2pRegistration: null;
  deliveryVerified: false; consentVerified: false; productionSendCapability: false;
}>;
export type NotificationSenderResult = Readonly<{
  state: "observed" | "held"; handle: NotificationSenderHandle | null;
  reasons: readonly string[]; productionSendCapability: false;
}>;
export type NotificationSenderReader = Readonly<{
  productionSendCapability: false;
  read(expected: NotificationSenderBinding): Promise<NotificationSenderResult>;
}>;
type RecordValue = Record<string, unknown>;
type PrivateFact = { facts: NotificationSenderFacts; now: () => Date; lastCheckedAt: number };
const issued = new WeakMap<NotificationSenderHandle, PrivateFact>();
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const account = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 &&
  value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
const phone = (value: unknown): value is string => typeof value === "string" && /^\+[1-9]\d{7,14}$/.test(value) &&
  (!value.startsWith("+1") || /^\+1[2-9]\d{2}[2-9]\d{6}$/.test(value));
function record(value: unknown): RecordValue | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null ||
      Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !("value" in d))) return null;
  return value as RecordValue;
}
function validBinding(value: unknown): value is NotificationSenderBinding {
  const item = record(value);
  return !!item && account(item.accountId) && identifier(item.locationId) && phone(item.expectedNumber);
}
function clock(now: () => Date): number {
  const at = now().getTime();
  if (!Number.isSafeInteger(at) || at < 0 || at > 8_640_000_000_000_000 - NOTIFICATION_SENDER_CONTRACT.factMaxAgeMs)
    throw new Error("invalid_sender_clock");
  return at;
}
const held = (reason: string): NotificationSenderResult => Object.freeze({ state: "held", handle: null,
  reasons: Object.freeze([reason]), productionSendCapability: false });
function optionalBoolean(item: RecordValue, key: string): boolean | null {
  if (!Object.hasOwn(item, key)) return null;
  if (typeof item[key] !== "boolean") throw new Error("malformed_sender_boolean");
  return item[key] as boolean;
}
function optionalLocation(item: RecordValue, expected: string): string | null {
  if (!Object.hasOwn(item, "locationId")) return null;
  if (item.locationId !== expected) throw new Error("sender_location_mismatch");
  return expected;
}
/** Pinned documented v3 envelope plus observed field spellings. No alternate legacy wrapper or aliases. */
function factsFromBody(body: unknown, expected: NotificationSenderBinding, begun: number): NotificationSenderFacts {
  const root = record(body), data = record(root?.data);
  if (!root || root.status !== "success" || root.statusCode !== 200 || typeof root.message !== "string" || !data ||
      !Array.isArray(data.numbers) || data.page !== 0 || data.pageSize !== 100 || data.numbers.length > 100)
    throw new Error("sender_response_shape_unverified");
  if (data.accountStatus !== "active") throw new Error("sender_account_not_active");
  const responseLocationId = optionalLocation(data, expected.locationId);
  const isUnderLc = optionalBoolean(data, "isUnderLc");
  // A malformed unrelated row could conceal a second match; never silently skip it.
  const rows = data.numbers.map(record);
  if (rows.some(row => !row || !phone(row.phoneNumber))) throw new Error("sender_number_rows_unverified");
  const matches = rows.filter(row => row!.phoneNumber === expected.expectedNumber);
  if (matches.length !== 1) throw new Error(matches.length ? "sender_match_ambiguous" : "expected_sender_not_observed");
  const match = matches[0]!, capabilities = record(match.capabilities);
  if (!capabilities || capabilities.sms !== true) throw new Error("sender_sms_not_supported");
  const numberLocationId = optionalLocation(match, expected.locationId);
  let total: number | null = null;
  if (Object.hasOwn(data, "total")) {
    if (!Number.isSafeInteger(data.total) || (data.total as number) < rows.length) throw new Error("sender_total_unverified");
    total = data.total as number;
  }
  return Object.freeze({ ...expected, kind: "configured-sms-sender-v1", version: "v3",
    observedAt: new Date(begun).toISOString(), expiresAt: new Date(begun + NOTIFICATION_SENDER_CONTRACT.factMaxAgeMs).toISOString(),
    accountBinding: "caller-supplied", locationBinding: "request-path", responseLocationId, numberLocationId,
    accountStatus: "active", isUnderLc, capabilities: Object.freeze({ sms: true,
      mms: optionalBoolean(capabilities, "mms"), voice: optionalBoolean(capabilities, "voice"), fax: optionalBoolean(capabilities, "fax") }),
    isDefaultNumber: optionalBoolean(match, "isDefaultNumber"), page: 0, pageSize: 100, returnedEntries: rows.length,
    total, matchingEntriesInPage: 1, inventoryComplete: null, globalUniquenessVerified: false,
    senderApproved: false, writeScopeVerified: false, a2pRegistration: null, deliveryVerified: false,
    consentVerified: false, productionSendCapability: false });
}

/** Factory is inert. The caller must independently verify the credential/account/location/scope association.
 * Each explicit read makes at most one fixed GET. No account discovery, fallback, pagination, or retry.
 * The client and clock are trusted IO, not authenticated by TypeScript or caller-supplied strings.
 */
export function createNotificationSenderReader(options: NotificationSenderOptions): NotificationSenderReader {
  let fetch: NotificationSenderFetch, now: () => Date, credential: string, accountId: string, locationId: string;
  let scopes: Set<string>, timeoutMs: number;
  try {
    if (!record(options) || typeof options.fetch !== "function" || typeof options.now !== "function" ||
        !account(options.accountId) || !identifier(options.locationId) || typeof options.credential !== "string" ||
        !/^[\x21-\x7e]{1,8192}$/.test(options.credential) || !Array.isArray(options.scopes) ||
        options.scopes.some(scope => typeof scope !== "string" || scope.length > 256)) throw new Error();
    timeoutMs = options.timeoutMs ?? NOTIFICATION_SENDER_CONTRACT.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > NOTIFICATION_SENDER_CONTRACT.maxTimeoutMs) throw new Error();
    ({ fetch, now, credential, accountId, locationId } = options); scopes = new Set(options.scopes);
  } catch { throw new Error("invalid_sender_reader_configuration"); }
  const url = `${NOTIFICATION_SENDER_CONTRACT.baseUrl}/phone-system/numbers/location/${encodeURIComponent(locationId)}?page=0&pageSize=100&skipNumberPool=false`;
  const headers = Object.freeze({ Authorization: `Bearer ${credential}`, Version: "v3" as const, Accept: "application/json" as const });
  async function get(): Promise<{ body: unknown } | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, cancel: (() => void) | undefined;
    const abort = () => { controller.abort(); cancel?.(); };
    try {
      const deadline = new Promise<null>(resolve => { timer = setTimeout(() => { abort(); resolve(null); }, timeoutMs); });
      const exchange = (async () => {
        const response = await fetch(url, { method: "GET", headers, redirect: "error", signal: controller.signal });
        if (!response.body || typeof response.body.getReader !== "function") return null;
        const reader = response.body.getReader();
        cancel = () => { try { void reader.cancel().catch(() => {}); } catch { /* No logging or retries. */ } };
        if (controller.signal.aborted || response.status !== 200 || response.redirected !== false || response.url !== url) { abort(); return null; }
        const decoder = new TextDecoder("utf-8", { fatal: true }), chunks: string[] = [];
        let bytes = 0;
        while (true) {
          const chunk = await reader.read();
          if (controller.signal.aborted || typeof chunk.done !== "boolean") return null;
          if (chunk.done) { if (chunk.value !== undefined) return null; break; }
          if (!(chunk.value instanceof Uint8Array) || !chunk.value.byteLength || chunks.length >= NOTIFICATION_SENDER_CONTRACT.responseChunks) return null;
          bytes += chunk.value.byteLength;
          if (bytes > NOTIFICATION_SENDER_CONTRACT.responseBytes) return null;
          chunks.push(decoder.decode(chunk.value, { stream: true }));
        }
        chunks.push(decoder.decode());
        if (controller.signal.aborted) return null;
        return { body: JSON.parse(chunks.join("")) as unknown };
      })();
      return await Promise.race([exchange, deadline]);
    } catch { return null; }
    finally { if (timer !== undefined) clearTimeout(timer); abort(); }
  }
  return Object.freeze({ productionSendCapability: false,
    async read(expected): Promise<NotificationSenderResult> {
      try {
        if (!validBinding(expected) || expected.accountId !== accountId || expected.locationId !== locationId ||
            !scopes.has(NOTIFICATION_SENDER_CONTRACT.readScope)) return held("sender_binding_or_read_scope_mismatch");
        const binding = Object.freeze({ accountId: expected.accountId, locationId: expected.locationId, expectedNumber: expected.expectedNumber });
        // Record before the actual read, never relabel the completed response with a fresh start time.
        const begun = clock(now), response = await get();
        if (!response) return held("sender_read_unavailable");
        const facts = factsFromBody(response.body, binding, begun), finished = clock(now);
        if (finished < begun || finished >= begun + NOTIFICATION_SENDER_CONTRACT.factMaxAgeMs) return held("sender_fact_expired_or_clock_reversed");
        const handle = Object.freeze({}) as NotificationSenderHandle;
        issued.set(handle, { facts, now, lastCheckedAt: finished });
        return Object.freeze({ state: "observed", handle, reasons: Object.freeze([]), productionSendCapability: false });
      } catch { return held("sender_facts_unverified"); }
    },
  });
}

/** Private trusted inspection only: includes the exact number, so do not log or publish it.
 * Inspection does not reissue or extend the fact. Copies, JSON, expiry and clock reversal fail closed.
 */
export function inspectNotificationSender(handle: NotificationSenderHandle): NotificationSenderFacts | null {
  const stored = issued.get(handle);
  if (!stored) return null;
  try {
    const at = clock(stored.now);
    if (at < stored.lastCheckedAt || at >= Date.parse(stored.facts.expiresAt)) throw new Error();
    stored.lastCheckedAt = at;
    return stored.facts;
  } catch { issued.delete(handle); return null; }
}
