/** Disabled GHL send contract and explicitly injected GET-only reads. No ambient credentials or ledger writes. */
import { createHash } from "node:crypto";

export const GHL_NOTIFICATION_CONTRACT = Object.freeze({
  baseUrl: "https://services.leadconnectorhq.com", version: "2021-07-28",
  sendPath: "/conversations/messages", writeScope: "conversations/message.write",
  productionSendCapability: false, automaticRetry: false, maximumAttempts: 1,
} as const);
export type GhlChannel = "sms" | "email";
export type GhlRecipientBinding = Readonly<{
  accountId: string; locationId: string; contactId: string; channel: GhlChannel; destination: string;
}>;
export type GhlMessageBinding = GhlRecipientBinding & Readonly<{
  /** Local correlation only. GHL does not expose invoice attribution or an idempotency contract. */
  eventKey: string; invoiceId: string; sender: string; bodyHash: string;
}>;
export type GhlRecipientResult = Readonly<{
  state: "allowed" | "blocked" | "held"; reasons: readonly string[]; productionSendCapability: false;
}>;
export type GhlConstructionReview = Readonly<{
  mode: "reviewed-construction-only"; version: "2021-07-28"; evidenceRef: string;
  accountId: string; locationId: string; channel: GhlChannel;
  /** Construction review only. A native SMS observation does not verify live Email semantics. */
  proposedStatus: "pending";
}>;
export type GhlSenderReview = Readonly<{
  accountId: string; locationId: string; channel: GhlChannel; sender: string;
  scope: "conversations/message.write"; approved: true; validated: true; evidenceRef: string;
}>;
/** Trusted upstream receipt comparison policy, never permission to append content or send.
 * The evidence must establish this exact suffix for this account/location/sender.
 */
export type GhlSmsReceiptSuffixPolicy = Readonly<{
  mode: "reviewed-exact-native-sms-suffix"; version: "2021-07-28"; channel: "sms"; source: "app";
  accountId: string; locationId: string; sender: string; suffix: string; evidenceRef: string;
}>;
export type GhlConstructionInput = Readonly<{
  binding: GhlMessageBinding; recipient: GhlRecipientResult; senderReview: GhlSenderReview;
  body: string; contentType: "text/plain" | "text/html"; subject?: string;
  review?: GhlConstructionReview;
  smsReceiptSuffixPolicy?: GhlSmsReceiptSuffixPolicy;
}>;
type WireBody = Readonly<Record<string, string>>;
export type GhlRequestDescriptor = Readonly<{
  method: "POST"; url: string;
  /** Deliberately no Authorization header and no place to supply credentials. */
  headers: Readonly<{ Version: "2021-07-28"; "Content-Type": "application/json" }>;
  body: WireBody; serializedBody: string; maximumAttempts: 1; automaticRetry: false;
  productionSendCapability: false;
}>;
export type GhlConstructionResult = Readonly<{
  state: "held" | "constructed_disabled"; reasons: readonly string[];
  request: GhlRequestDescriptor | null; productionSendCapability: false;
}>;
export type GhlHttpObservation = Readonly<{
  version: unknown; statusCode: unknown; body: unknown;
}>;
export type GhlAcceptanceResult = Readonly<{
  state: "accepted" | "unknown"; reasons: readonly string[];
  messageId: string | null; emailMessageId: string | null; conversationId: string | null;
  deliveryConfirmed: false; invoiceAttributionVerified: false; retryAllowed: false;
  productionSendCapability: false;
}>;
export type GhlReceiptState = "pending" | "sent" | "delivered" | "failed" | "suppressed" | "engagement" | "unknown";
export type GhlReceiptResult = Readonly<{
  state: GhlReceiptState; reasons: readonly string[]; identityMatched: boolean;
  deliveryConfirmed: boolean; invoiceAttributionVerified: false; retryAllowed: false;
  productionSendCapability: false;
}>;
export type GhlPrivateEvidence = Readonly<{
  rawStatus: unknown; rawError: unknown; rawMessage: unknown; rawBody: unknown;
}>;

type RecordValue = Record<string, unknown>;
type Construction = Readonly<{
  binding: GhlMessageBinding; contentType: string; subject?: string;
  smsReceiptSuffix?: Readonly<{ policy: GhlSmsReceiptSuffixPolicy; receiptBodyHash: string }>;
}>;
type Acceptance = Construction & Readonly<{ messageId: string; emailMessageId: string | null; conversationId: string }>;
type Receipt = Readonly<{ acceptance: Acceptance; observedAt: number }>;
const recipients = new WeakMap<GhlRecipientResult, GhlRecipientBinding>();
const constructions = new WeakMap<GhlConstructionResult, Construction>();
const acceptances = new WeakMap<GhlAcceptanceResult, Acceptance>();
const receipts = new WeakMap<GhlReceiptResult, Receipt>();
const privateEvidence = new WeakMap<object, GhlPrivateEvidence>();
const frozenReasons = (reasons: string[]) => Object.freeze([...new Set(reasons)]);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && value.trim() === value;
const identifier = (value: unknown): value is string => text(value) && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const validHash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const phone = (value: unknown): value is string => typeof value === "string" && /^\+[1-9]\d{7,14}$/.test(value) &&
  (!value.startsWith("+1") || /^\+1[2-9]\d{2}[2-9]\d{6}$/.test(value));
const email = (value: unknown): value is string => typeof value === "string" && value.length <= 254 &&
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?)+$/.test(value);
const destination = (channel: unknown, value: unknown) => channel === "sms" ? phone(value) : channel === "email" && email(value);
function record(value: unknown): RecordValue | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !("value" in d))) return null;
  return value as RecordValue;
}
function validRecipient(value: unknown): value is GhlRecipientBinding & RecordValue {
  const item = record(value);
  return !!item && text(item.accountId) && identifier(item.locationId) && identifier(item.contactId) &&
    destination(item.channel, item.destination);
}
function sameRecipient(a: GhlRecipientBinding, b: GhlRecipientBinding): boolean {
  return a.accountId === b.accountId && a.locationId === b.locationId && a.contactId === b.contactId &&
    a.channel === b.channel && a.destination === b.destination;
}
function timestamp(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return NaN;
  const parsed = Date.parse(value);
  const canonical = value.replace(/(?:\.(\d{1,3}))?Z$/, (_match, fraction: string | undefined) => `.${(fraction ?? "").padEnd(3, "0")}Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === canonical ? parsed : NaN;
}
/** JSON evidence snapshots exclude all other response/contact fields. Never log or display them. */
function snapshot(value: unknown, depth = 0): unknown {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (depth > 12) throw new Error("invalid_evidence");
  if (Array.isArray(value)) return Object.freeze(value.map(v => snapshot(v, depth + 1)));
  const item = record(value);
  if (!item) throw new Error("invalid_evidence");
  return Object.freeze(Object.fromEntries(Object.entries(item).map(([key, v]) => [key, snapshot(v, depth + 1)])));
}
function retain(result: object, item: RecordValue | null): void {
  privateEvidence.set(result, Object.freeze({ rawStatus: snapshot(item?.status), rawError: snapshot(item?.error), rawMessage: snapshot(item?.msg), rawBody: snapshot(item?.body) }));
}
/** Private audit access only. Not part of ordinary serialized results, logs, or user-facing summaries. */
export function inspectGhlPrivateEvidence(result: object): GhlPrivateEvidence | null {
  return privateEvidence.get(result) ?? null;
}

/** Parses only the pinned contact wrapper. Inputs must be authenticated/fresh upstream; parsing is not authentication. */
export function parseGhlRecipient(input: Readonly<{ version: unknown; body: unknown; expected: GhlRecipientBinding }>): GhlRecipientResult {
  const reasons: string[] = [];
  let blocked = false, valid = false;
  try {
    if (input.version !== GHL_NOTIFICATION_CONTRACT.version) reasons.push("unsupported_contact_version");
    const contact = record(record(input.body)?.contact);
    if (!validRecipient(input.expected)) reasons.push("invalid_expected_recipient");
    if (!contact || contact.id !== input.expected.contactId || contact.locationId !== input.expected.locationId)
      reasons.push("contact_identity_missing_or_mismatched");
    if (contact && validRecipient(input.expected)) {
      const primary = input.expected.channel === "sms" ? contact.phone : contact.email;
      const extra = input.expected.channel === "sms" ? contact.additionalPhones : contact.additionalEmails;
      const field = input.expected.channel === "sms" ? "phone" : "email";
      let associated = primary === input.expected.destination;
      if (extra !== undefined) {
        if (!Array.isArray(extra) || extra.some(item => !record(item) || typeof record(item)![field] !== "string"))
          reasons.push("malformed_associated_destinations");
        else associated ||= extra.some(item => record(item)![field] === input.expected.destination);
      }
      if (!associated) reasons.push("destination_not_exact_contact_association");
      const channelKey = input.expected.channel === "sms" ? "SMS" : "Email";
      const settings = record(contact.dndSettings);
      const channelSettings = settings && Object.hasOwn(settings, channelKey) ? record(settings[channelKey]) : null;
      const status = channelSettings && Object.hasOwn(channelSettings, "status") ? channelSettings.status : undefined;
      const incompatibleTopLevel = Object.getOwnPropertyNames(contact).some(key =>
        (key.toLowerCase() === "dnd" && key !== "dnd") || (key.toLowerCase() === "dndsettings" && key !== "dndSettings"));
      const incompatibleChannel = settings && Object.getOwnPropertyNames(settings).some(key =>
        key.toLowerCase() === input.expected.channel && key !== channelKey);
      if (incompatibleTopLevel) reasons.push("incompatible_contact_dnd_schema");
      if (incompatibleChannel) reasons.push("incompatible_channel_dnd_schema");
      if (channelSettings && Object.getOwnPropertyNames(channelSettings).some(key => key.toLowerCase() === "status" && key !== "status"))
        reasons.push("incompatible_dnd_status_schema");
      if (settings && (Object.hasOwn(settings, "sms") || Object.hasOwn(settings, "email")))
        reasons.push("incompatible_lowercase_dnd_schema");
      // HighLevel explicitly documents omitted global dnd as false across APIs.
      // The reviewed pinned contact response also uses genuine SMS/settings omission
      // for no SMS override. This observed encoding is not consent or an Email default.
      // Present malformed values and conflicting casing never receive that default.
      const noSmsOverride = input.expected.channel === "sms" && !incompatibleTopLevel && !incompatibleChannel &&
        (!Object.hasOwn(contact, "dndSettings") || !!settings && !Object.hasOwn(settings, channelKey));
      const globalDnd = Object.hasOwn(contact, "dnd") ? contact.dnd : false;
      blocked = globalDnd === true || status === "active" || status === "permanent";
      if (typeof globalDnd !== "boolean") reasons.push("global_dnd_unknown");
      if (!noSmsOverride && !["active", "inactive", "permanent"].includes(status as string)) reasons.push("channel_dnd_unknown");
      if (blocked) reasons.push("recipient_suppressed");
      valid = reasons.length === 0 && globalDnd === false && (status === "inactive" || noSmsOverride);
    }
  } catch { reasons.push("malformed_contact_input"); }
  const result: GhlRecipientResult = Object.freeze({ state: valid ? "allowed" : blocked ? "blocked" : "held",
    reasons: frozenReasons(reasons), productionSendCapability: false });
  if (valid) recipients.set(result, Object.freeze({ ...input.expected }));
  return result;
}

/** Produces data only under an explicit construction review. There is intentionally no send function. */
export function buildGhlMessageRequest(input: GhlConstructionInput): GhlConstructionResult {
  const reasons: string[] = [];
  let request: GhlRequestDescriptor | null = null, construction: Construction | null = null;
  try {
    const b = record(input.binding), review = record(input.review), sender = record(input.senderReview);
    const suffix = record(input.smsReceiptSuffixPolicy);
    if (!review || review.mode !== "reviewed-construction-only" || review.version !== GHL_NOTIFICATION_CONTRACT.version ||
        review.proposedStatus !== "pending" || !text(review.evidenceRef)) reasons.push("send_contract_unverified");
    if (!validRecipient(b) || !text(b?.eventKey) || !text(b?.invoiceId) || !validHash(b?.bodyHash) || !destination(b?.channel, b?.sender))
      reasons.push("invalid_message_binding");
    const recipient = recipients.get(input.recipient);
    if (!recipient || !validRecipient(b) || !sameRecipient(recipient, b)) reasons.push("recipient_not_exact_parsed_allowed");
    if (!sender || sender.approved !== true || sender.validated !== true || !text(sender.evidenceRef) ||
        sender.scope !== GHL_NOTIFICATION_CONTRACT.writeScope || sender.accountId !== b?.accountId ||
        sender.locationId !== b?.locationId || sender.channel !== b?.channel || sender.sender !== b?.sender)
      reasons.push("sender_not_exact_validated_approved_scope");
    if (review && (review.accountId !== b?.accountId || review.locationId !== b?.locationId || review.channel !== b?.channel))
      reasons.push("review_scope_mismatch");
    if (typeof input.body !== "string" || !input.body.trim() || input.body.length > 1_000_000 || hash(input.body) !== b?.bodyHash)
      reasons.push("body_hash_mismatch_or_invalid");
    if (b?.channel === "sms" && (input.contentType !== "text/plain" || input.subject !== undefined)) reasons.push("invalid_sms_content");
    if (b?.channel === "email" && (!["text/plain", "text/html"].includes(input.contentType) || !text(input.subject) || /[\r\n]/.test(input.subject)))
      reasons.push("invalid_email_content");
    if (input.smsReceiptSuffixPolicy !== undefined && (!suffix ||
        suffix.mode !== "reviewed-exact-native-sms-suffix" || suffix.version !== GHL_NOTIFICATION_CONTRACT.version ||
        suffix.channel !== "sms" || suffix.source !== "app" || b?.channel !== "sms" ||
        suffix.accountId !== b?.accountId || suffix.locationId !== b?.locationId || suffix.sender !== b?.sender ||
        !text(suffix.evidenceRef) || typeof suffix.suffix !== "string" || !suffix.suffix.trim() || suffix.suffix.length > 4096))
      reasons.push("invalid_or_mismatched_sms_receipt_suffix_policy");
    if (!reasons.length) {
      const body: WireBody = Object.freeze((b!.channel === "sms"
        ? { type: "SMS", contactId: b!.contactId as string, fromNumber: b!.sender as string,
          toNumber: b!.destination as string, message: input.body, status: "pending" }
        : { type: "Email", contactId: b!.contactId as string, emailFrom: b!.sender as string,
          emailTo: b!.destination as string, subject: input.subject!,
          [input.contentType === "text/html" ? "html" : "message"]: input.body, status: "pending" }) as Record<string, string>);
      request = Object.freeze({ method: "POST", url: GHL_NOTIFICATION_CONTRACT.baseUrl + GHL_NOTIFICATION_CONTRACT.sendPath,
        headers: Object.freeze({ Version: GHL_NOTIFICATION_CONTRACT.version, "Content-Type": "application/json" }),
        body, serializedBody: JSON.stringify(body), maximumAttempts: 1, automaticRetry: false, productionSendCapability: false });
      construction = Object.freeze({ binding: Object.freeze({ ...input.binding }), contentType: input.contentType, subject: input.subject,
        ...(suffix ? { smsReceiptSuffix: Object.freeze({
          policy: Object.freeze({ ...input.smsReceiptSuffixPolicy! }), receiptBodyHash: hash(input.body + suffix.suffix),
        }) } : {}),
      });
    }
  } catch { reasons.push("malformed_construction_input"); request = null; }
  const result: GhlConstructionResult = Object.freeze({ state: request ? "constructed_disabled" : "held",
    reasons: frozenReasons(reasons), request, productionSendCapability: false });
  if (request && construction) constructions.set(result, construction);
  return result;
}

/** HTTP success and IDs establish acceptance only. All uncertain outcomes remain non-retryable. */
export function parseGhlAcceptance(construction: GhlConstructionResult, response: GhlHttpObservation): GhlAcceptanceResult {
  const reasons: string[] = [], built = constructions.get(construction);
  let item: RecordValue | null = null, accepted: Acceptance | null = null;
  try {
    item = record(response.body);
    if (!built) reasons.push("unrecognized_construction");
    if (response.version !== GHL_NOTIFICATION_CONTRACT.version) reasons.push("unsupported_acceptance_version");
    if (response.statusCode !== 200 && !(response.statusCode === 201 && built?.binding.channel === "sms"))
      reasons.push(response.statusCode === 429 ? "rate_limited_no_retry" : "http_outcome_unknown_no_retry");
    if (!item || !identifier(item.messageId) || !identifier(item.conversationId)) reasons.push("acceptance_ids_missing_or_malformed");
    if (item) {
      if (built && !availableIdentityMatches(item, {
        id: item.messageId, message_id: item.messageId, conversation_id: item.conversationId,
        accountId: built.binding.accountId, account_id: built.binding.accountId,
        locationId: built.binding.locationId, location_id: built.binding.locationId,
        contactId: built.binding.contactId, contact_id: built.binding.contactId,
        from: built.binding.sender, to: built.binding.destination,
        fromNumber: built.binding.sender, toNumber: built.binding.destination,
      })) reasons.push("acceptance_identity_conflict");
      if (["message", "data", "result"].some(key => Object.hasOwn(item!, key))) reasons.push("unsupported_acceptance_envelope");
      if (item.status !== undefined || item.error !== undefined || item.success !== undefined) reasons.push("undocumented_acceptance_outcome_fields");
      if (item.msg !== undefined && typeof item.msg !== "string") reasons.push("malformed_acceptance_message");
      if (item.messageIds !== undefined && (!Array.isArray(item.messageIds) || item.messageIds.length !== 0)) reasons.push("unexpected_multiple_message_ids");
      if (item.emailMessageId !== undefined && (!identifier(item.emailMessageId) || built?.binding.channel !== "email" || item.emailMessageId === item.messageId))
        reasons.push("invalid_individual_email_id");
    }
    // Validate private evidence before recording a positive state.
    snapshot(item?.status); snapshot(item?.error); snapshot(item?.msg);
    if (!reasons.length && built && item) accepted = Object.freeze({ ...built, messageId: item.messageId as string,
      conversationId: item.conversationId as string, emailMessageId: (item.emailMessageId as string | undefined) ?? null });
  } catch { reasons.push("malformed_acceptance_input"); }
  const result: GhlAcceptanceResult = Object.freeze({ state: accepted ? "accepted" : "unknown", reasons: frozenReasons(reasons),
    messageId: accepted?.messageId ?? null, emailMessageId: accepted?.emailMessageId ?? null, conversationId: accepted?.conversationId ?? null,
    deliveryConfirmed: false, invoiceAttributionVerified: false, retryAllowed: false, productionSendCapability: false });
  if (accepted) acceptances.set(result, accepted);
  try { retain(result, item); } catch { /* Non-JSON input cannot be preserved as provider JSON evidence. */ }
  return result;
}

function normalizedStatus(status: unknown, channel: GhlChannel, emailEndpoint: boolean): GhlReceiptState {
  if (status === "pending" || status === "scheduled") return "pending";
  if (status === "sent" || status === "delivered") return status;
  if (status === "failed" || status === "undelivered") return "failed";
  if (status === "opt_out" && !emailEndpoint) return "suppressed";
  if (channel === "email" && (status === "read" || status === "opened")) return "engagement";
  // clicked/opt_out are not in the individual-email enum; read/opened are not SMS delivery proof.
  return "unknown";
}
function emptyArrayOrMissing(value: unknown): boolean { return value === undefined || Array.isArray(value) && value.length === 0; }
/** Optional identities can corroborate, never replace required canonical fields or contradict them. */
function availableIdentityMatches(item: RecordValue, expected: RecordValue): boolean {
  return Object.entries(expected).every(([key, value]) => !Object.hasOwn(item, key) || item[key] === value);
}
function receiptObject(body: unknown, emailEndpoint: boolean): { item: RecordValue | null; nativeSms: boolean } {
  const root = record(body);
  if (!root) return { item: null, nativeSms: false };
  if (Object.hasOwn(root, "message")) {
    // Only the observed native-SMS envelope. Never choose a wrapper over competing root facts.
    if (emailEndpoint || Object.keys(root).some(key => key !== "message" && key !== "traceId") || !text(root.traceId))
      return { item: null, nativeSms: false };
    const item = record(root.message);
    if (!item || ["message", "data", "result"].some(key => Object.hasOwn(item, key))) return { item: null, nativeSms: false };
    return { item, nativeSms: true };
  }
  if (["data", "result", "messages"].some(key => Object.hasOwn(root, key))) return { item: null, nativeSms: false };
  return { item: root, nativeSms: false };
}
function parseReceipt(acceptance: GhlAcceptanceResult, response: GhlHttpObservation, observedAt: string, emailEndpoint: boolean): GhlReceiptResult {
  const reasons: string[] = [], accepted = acceptances.get(acceptance), observed = timestamp(observedAt);
  let item: RecordValue | null = null, state: GhlReceiptState = "unknown", matched = false;
  try {
    const parsed = receiptObject(response.body, emailEndpoint);
    item = parsed.item;
    if (!accepted) reasons.push("unrecognized_acceptance");
    if (response.version !== GHL_NOTIFICATION_CONTRACT.version) reasons.push("unsupported_receipt_version");
    if (response.statusCode !== 200) reasons.push("receipt_unavailable");
    if (!Number.isFinite(observed)) reasons.push("invalid_observation_time");
    if (!item) reasons.push("invalid_receipt_shape");
    if (accepted && item) {
      const b = accepted.binding, expectedId = emailEndpoint ? accepted.emailMessageId : accepted.messageId;
      if (!expectedId || item.id !== expectedId) reasons.push("provider_message_identity_missing_or_mismatched");
      if (item.locationId !== b.locationId || item.contactId !== b.contactId || item.conversationId !== accepted.conversationId)
        reasons.push("receipt_contact_location_conversation_mismatch");
      if (!availableIdentityMatches(item, {
        messageId: expectedId, message_id: expectedId, _id: expectedId,
        accountId: b.accountId, account_id: b.accountId, location_id: b.locationId, contact_id: b.contactId,
        conversation_id: accepted.conversationId, fromNumber: b.sender, toNumber: b.destination,
      })) reasons.push("receipt_identity_alias_conflict");
      const nativeSms = parsed.nativeSms && !emailEndpoint && b.channel === "sms" && item.type === 2 && item.messageType === "TYPE_SMS";
      if (item.direction !== "outbound" || item.source !== (parsed.nativeSms ? "app" : "api") || parsed.nativeSms && !nativeSms)
        reasons.push("receipt_direction_or_source_mismatch");
      const bodyHash = typeof item.body === "string" ? hash(item.body) : null;
      if (bodyHash !== b.bodyHash && !(nativeSms && item.source === "app" && accepted.smsReceiptSuffix &&
          bodyHash === accepted.smsReceiptSuffix.receiptBodyHash)) reasons.push("receipt_body_hash_mismatch");
      if (item.contentType !== accepted.contentType) reasons.push("receipt_content_type_mismatch");
      const created = timestamp(item.dateAdded);
      if (!Number.isFinite(created) || created > observed) reasons.push("receipt_creation_time_invalid");
      if (Object.hasOwn(item, "dateUpdated")) {
        const updated = timestamp(item.dateUpdated);
        if (!Number.isFinite(updated) || updated < created || updated > observed) reasons.push("receipt_update_time_invalid");
      }
      if (!emptyArrayOrMissing(item.attachments)) reasons.push("unexpected_receipt_attachments");
      if (emailEndpoint) {
        if (b.channel !== "email") reasons.push("receipt_channel_mismatch");
        if (!accepted.emailMessageId || accepted.emailMessageId === accepted.messageId || item.threadId !== accepted.messageId)
          reasons.push("individual_email_thread_binding_missing_or_mismatched");
        if (item.from !== b.sender || !Array.isArray(item.to) || item.to.length !== 1 || item.to[0] !== b.destination)
          reasons.push("receipt_sender_or_destination_mismatch");
        if (item.subject !== accepted.subject || !emptyArrayOrMissing(item.cc) || !emptyArrayOrMissing(item.bcc))
          reasons.push("receipt_email_content_or_audience_mismatch");
      } else {
        if (b.channel === "email") reasons.push("individual_email_receipt_required");
        if (item.messageType !== "TYPE_SMS" || !Number.isSafeInteger(item.type) || (item.type as number) < 0 || [1, 3, 10].includes(item.type as number))
          reasons.push("receipt_channel_unverified");
        if (item.from !== b.sender || item.to !== b.destination) reasons.push("receipt_sender_or_destination_mismatch");
      }
      matched = reasons.length === 0;
      state = normalizedStatus(item.status, b.channel, emailEndpoint);
      if (state === "unknown") reasons.push("unknown_or_channel_inapplicable_status");
      if (item.error !== undefined && typeof item.error !== "string") reasons.push("malformed_receipt_error");
      if (typeof item.error === "string" && item.error.length > 0 && state !== "failed" && state !== "suppressed")
        reasons.push("status_error_conflict");
      snapshot(item.status); snapshot(item.error); snapshot(item.body);
    }
  } catch { reasons.push("malformed_receipt_input"); matched = false; }
  if (reasons.length) state = "unknown";
  const result: GhlReceiptResult = Object.freeze({ state, reasons: frozenReasons(reasons), identityMatched: matched,
    deliveryConfirmed: state === "delivered", invoiceAttributionVerified: false, retryAllowed: false, productionSendCapability: false });
  if (accepted && Number.isFinite(observed)) receipts.set(result, Object.freeze({ acceptance: accepted, observedAt: observed }));
  try { retain(result, item); } catch { /* Reject unsupported non-JSON evidence without inventing raw values. */ }
  return result;
}
/** GET /conversations/messages/{id}: documented root or the observed unambiguous native-SMS message/traceId envelope. */
export function parseGhlMessageReceipt(acceptance: GhlAcceptanceResult, response: GhlHttpObservation, observedAt: string): GhlReceiptResult {
  return parseReceipt(acceptance, response, observedAt, false);
}
/** Requires the individual ID returned by send; a thread-level message alone can never qualify. */
export function parseGhlEmailReceipt(acceptance: GhlAcceptanceResult, response: GhlHttpObservation, observedAt: string): GhlReceiptResult {
  return parseReceipt(acceptance, response, observedAt, true);
}

/** Pure, conservative reconciliation, not polling. Unknown/conflicting observations cannot be erased. */
export function reconcileGhlReceipts(observations: readonly GhlReceiptResult[]): GhlReceiptResult {
  const reasons: string[] = [];
  let previous: Receipt | undefined, state: GhlReceiptState = "unknown";
  if (!observations.length) reasons.push("no_receipt_evidence");
  for (const observation of observations) {
    const current = receipts.get(observation);
    if (!current || !observation.identityMatched || observation.state === "unknown") reasons.push("unverified_receipt_observation");
    if (previous && current) {
      if (current.acceptance !== previous.acceptance) reasons.push("receipt_binding_conflict");
      if (current.observedAt <= previous.observedAt) reasons.push("receipt_observation_order_unknown");
      const rank: Partial<Record<GhlReceiptState, number>> = { pending: 0, sent: 1, delivered: 2, engagement: 3 };
      if (state !== observation.state && ((state === "failed" || state === "suppressed") ||
          (observation.state === "failed" || observation.state === "suppressed") && (state === "delivered" || state === "engagement")))
        reasons.push("conflicting_receipt_outcomes");
      if (rank[state] !== undefined && rank[observation.state] !== undefined && rank[observation.state]! < rank[state]!)
        reasons.push("nonmonotonic_receipt_requires_review");
    }
    previous = current; state = observation.state;
  }
  if (reasons.length) state = "unknown";
  return Object.freeze({ state, reasons: frozenReasons(reasons), identityMatched: reasons.length === 0,
    deliveryConfirmed: state === "delivered", invoiceAttributionVerified: false, retryAllowed: false, productionSendCapability: false });
}

/** Deliberately narrower than a general HTTP client: callers cannot supply a URL, method, or headers. */
export type GhlReadFetch = (url: string, init: Readonly<{
  method: "GET"; headers: Readonly<{ Authorization: string; Version: "2021-07-28"; Accept: "application/json" }>;
  redirect: "error"; signal: AbortSignal;
}>) => Promise<Readonly<{
  status: number;
  body: Readonly<{ getReader(): Readonly<{
    read(): Promise<Readonly<{ done: boolean; value?: Uint8Array }>>;
    cancel(): Promise<unknown>;
  }> }> | null;
}>>;
export type GhlReadOnlyOptions = Readonly<{
  fetch: GhlReadFetch; credential: string; accountId: string; locationId: string;
  scopes: readonly string[]; timeoutMs?: number; now: () => Date;
}>;
export type GhlReadOnlyReader = Readonly<{
  productionSendCapability: false;
  readContact(expected: GhlRecipientBinding): Promise<GhlRecipientResult>;
  readMessageReceipt(acceptance: GhlAcceptanceResult): Promise<GhlReceiptResult>;
  readEmailReceipt(acceptance: GhlAcceptanceResult): Promise<GhlReceiptResult>;
}>;

/** Inert until a named GET method is called. Never uses global fetch or environment credentials.
 * The injected credential/scope/location association must be verified upstream; strings cannot authenticate it.
 * Abort plus a local deadline bounds waiting, not proof that an injected client canceled its socket.
 */
export function createGhlReadOnlyReader(options: GhlReadOnlyOptions): GhlReadOnlyReader {
  const timeoutMs = options.timeoutMs ?? 5000;
  if (typeof options.fetch !== "function" || typeof options.now !== "function" || !text(options.accountId) || !identifier(options.locationId) ||
      typeof options.credential !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(options.credential) ||
      !Array.isArray(options.scopes) || options.scopes.some(scope => typeof scope !== "string") ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("invalid_read_only_configuration");
  // Snapshot configuration. Errors intentionally contain no credential, URL, response, or contact data.
  const fetch = options.fetch, now = options.now, accountId = options.accountId, locationId = options.locationId;
  const scopes = new Set(options.scopes);
  const headers = Object.freeze({ Authorization: `Bearer ${options.credential}`, Version: GHL_NOTIFICATION_CONTRACT.version, Accept: "application/json" as const });
  async function get(path: string): Promise<GhlHttpObservation | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<null>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs); });
      const read = (async (): Promise<GhlHttpObservation | null> => {
        const response = await fetch(GHL_NOTIFICATION_CONTRACT.baseUrl + path, { method: "GET", headers, redirect: "error", signal: controller.signal });
        if (!Number.isSafeInteger(response.status) || response.status < 100 || response.status > 599) return null;
        if (!response.body || typeof response.body.getReader !== "function") return null;
        const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
        const chunks: string[] = [];
        let bytes = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (controller.signal.aborted) return null;
            if (chunk.done) break;
            if (!(chunk.value instanceof Uint8Array) || chunk.value.byteLength === 0 || chunks.length >= 8192) return null;
            bytes += chunk.value.byteLength;
            if (bytes > 2_000_000) { controller.abort(); return null; }
            chunks.push(decoder.decode(chunk.value, { stream: true }));
          }
          chunks.push(decoder.decode());
          return { version: GHL_NOTIFICATION_CONTRACT.version, statusCode: response.status, body: JSON.parse(chunks.join("")) as unknown };
        } finally {
          // Cancellation is best-effort; the local deadline remains authoritative for caller waiting.
          try { void reader.cancel().catch(() => {}); } catch { /* No response/secret logging. */ }
        }
      })();
      return await Promise.race([read, deadline]);
    } catch { return null; }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
  const heldContact = (): GhlRecipientResult => Object.freeze({ state: "held", reasons: Object.freeze(["contact_read_unavailable_or_scope_mismatch"]), productionSendCapability: false });
  const heldReceipt = (): GhlReceiptResult => Object.freeze({ state: "unknown", reasons: Object.freeze(["receipt_read_unavailable_or_scope_mismatch"]),
    identityMatched: false, deliveryConfirmed: false, invoiceAttributionVerified: false, retryAllowed: false, productionSendCapability: false });
  async function readReceipt(acceptance: GhlAcceptanceResult, emailEndpoint: boolean): Promise<GhlReceiptResult> {
    try {
      const bound = acceptances.get(acceptance), id = emailEndpoint ? bound?.emailMessageId : bound?.messageId;
      if (!bound || !id || bound.binding.accountId !== accountId || bound.binding.locationId !== locationId ||
          !scopes.has("conversations/message.readonly") || (emailEndpoint ? bound.binding.channel !== "email" : bound.binding.channel !== "sms")) return heldReceipt();
      const result = await get(`/conversations/messages/${emailEndpoint ? "email/" : ""}${encodeURIComponent(id)}`);
      return result ? parseReceipt(acceptance, result, now().toISOString(), emailEndpoint) : heldReceipt();
    } catch { return heldReceipt(); }
  }
  return Object.freeze({ productionSendCapability: false,
    async readContact(expected: GhlRecipientBinding): Promise<GhlRecipientResult> {
      try {
        if (!validRecipient(expected) || expected.accountId !== accountId || expected.locationId !== locationId || !scopes.has("contacts.readonly")) return heldContact();
        const snapshot = Object.freeze({ ...expected });
        const result = await get(`/contacts/${encodeURIComponent(snapshot.contactId)}`);
        return result?.statusCode === 200 ? parseGhlRecipient({ version: result.version, body: result.body, expected: snapshot }) : heldContact();
      } catch { return heldContact(); }
    },
    readMessageReceipt: acceptance => readReceipt(acceptance, false),
    readEmailReceipt: acceptance => readReceipt(acceptance, true),
  });
}

/** Narrow internal seam: only an original parser-built descriptor has a binding.
 * This inspection grants no send permission; transport requires a separate one-use review and ledger fence.
 */
export function inspectGhlConstructionForTransport(value: GhlConstructionResult): Readonly<{
  binding: GhlMessageBinding; request: GhlRequestDescriptor;
}> | null {
  const construction = constructions.get(value);
  return construction && value.request ? Object.freeze({ binding: construction.binding, request: value.request }) : null;
}
