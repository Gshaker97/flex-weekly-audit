/**
 * Day 15 homeowner SMS, fee-free copy. One reviewed invoice, one attempt, no retry.
 *
 * Jobber decides whether the exact invoice is still unpaid; GHL only carries the text.
 * Every safeguard here is the Day 10 machinery reused unchanged: the gate decides
 * eligibility, the ledger admits exactly one attempt per logical event, and the
 * transport alone owns assertReserved -> markPending -> POST -> markOutcome.
 *
 * What this module adds on top of Day 10:
 *   - recorded homeowner consent to billing texts is mandatory (no DND-derived path);
 *   - the body must state no late fee at all, so no fee fact has to be proven;
 *   - the Jobber client-hub invoice link is re-read and compared on every source read.
 *
 * Import, readiness inspection and the default execution path are inert.
 */
import { createHash } from "node:crypto";
import { addInvoiceCalendarDays, invoiceCalendarDate } from "./invoice-reminder-clock";
import { bodyMakesNoFeeClaim, smsConsentIsRecorded, type Day15SmsConsent } from "./notification-day15-pilot";
import { eventKey, immutableEvent, type Event } from "./notification-gate";
import { createNotificationRunner, type NotificationRunnerDependencies, type NotificationRunnerResult } from "./notification-runner";
import { createNotificationSenderReader, inspectNotificationSender, type NotificationSenderHandle } from "./notification-sender";
import { readNotificationHistory, projectAccessibleGhlExternalHistory, composeAccessibleGhlExternalAttempts,
  NOTIFICATION_HISTORY_CONTRACT } from "./notification-history";
import type { NotificationSourceRequest, NotificationSourceIO, NotificationSourceSnapshot } from "./notification-source";
import type { NotificationLedgerDatabase } from "./notification-ledger";

export const DAY15_SENDER_KIND = "day15-homeowner-sms-fee-free-pilot" as const;
export const DAY15_TEMPLATE_POLICY = "day15-no-fee-claim" as const;

/** The reviewed Jobber client-hub link for this one invoice. Pinned, then re-read. */
export type Day15InvoiceLink = Readonly<{
  source: "jobber-invoice-client-hub-uri"; invoiceId: string; url: string; evidenceRef: string;
}>;

export type Day15SenderConfig = Readonly<{
  version: 1; kind: typeof DAY15_SENDER_KIND; reviewRef: string; reviewedAt: string; expiresAt: string;
  source: NotificationSourceRequest;
  destination: string;
  scope: Readonly<{ scheduledOn: string; dayPastDue: 15; audience: "homeowner"; channel: "sms"; maximumAttempts: 1;
    history: "accessible-ghl-plus-local-ledger"; timeZone: "America/Phoenix"; window: "[09:00:00,09:15:00)";
    authorizationRef: string; timingRef: string; credentialBindingRef: string }>;
  currencyPolicy: Readonly<{ accountId: string; invoiceId: string; currency: string; minorUnitExponent: 2; evidenceRef: string }>;
  consent: Day15SmsConsent;
  invoiceLink: Day15InvoiceLink;
  sender: Readonly<{ number: string; approvalRef: string; writeScopeEvidenceRef: string }>;
  template: Readonly<{ id: string; version: string; body: string; policy: typeof DAY15_TEMPLATE_POLICY; approvalRef: string }>;
  nativeSms: Readonly<{ version: "2021-07-28"; status: "pending"; receiptSource: "app"; semanticsRef: string;
    footer: Readonly<{ mode: "exact-native-suffix"; suffix: string; evidenceRef: string }> }>;
}>;

/** Out-of-band operator review. Never populated from config JSON or an environment flag. */
export type Day15SenderReview = Readonly<{ configSha256: string; reviewRef: string; action: "read-only" | "one-attempt" }>;
declare const configBrand: unique symbol;
export type ReviewedDay15Sender = Readonly<{ [configBrand]: true }>;
export type Day15SenderReadiness = Readonly<{
  state: "held" | "reviewed_configuration"; configSha256: string | null;
  missing: readonly string[]; actualRuntimeChecks: readonly string[];
  productionSendCapability: false; rolloutReady: false;
}>;
/** Jobber read for the exact invoice's client-hub link. Read-only; no write, no refresh. */
export type Day15InvoiceLinkReader = (invoiceId: string) => Promise<string>;
export type Day15SenderRuntime = Readonly<{
  accountId: string; locationId: string; credential: string; fetch: typeof fetch;
  sourceIO: NotificationSourceIO; database: NotificationLedgerDatabase;
  readInvoiceLink: Day15InvoiceLinkReader;
  verifyActiveHolds(): void;
  close?(): Promise<void>;
}>;

const configHandles = new WeakMap<ReviewedDay15Sender, { config: Day15SenderConfig; review: Day15SenderReview }>();
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const now = () => new Date(Date.now());
const text = (x: unknown): x is string => typeof x === "string" && !!x && x.length <= 256 && x.trim() === x && !/[\x00-\x1f\x7f]/.test(x);
const phone = (x: unknown): x is string => typeof x === "string" && /^\+1[2-9]\d{2}[2-9]\d{6}$/.test(x);
const instant = (x: unknown): number => typeof x === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x) &&
  Number.isFinite(Date.parse(x)) && new Date(Date.parse(x)).toISOString() === x ? Date.parse(x) : NaN;
function freeze<T>(x: T): T { if (x && typeof x === "object") { Object.values(x).forEach(freeze); Object.freeze(x); } return x; }
function keys(x: unknown, expected: string[]): boolean {
  return !!x && typeof x === "object" && !Array.isArray(x) &&
    Object.keys(x).length === expected.length && Object.keys(x).every(k => expected.includes(k));
}

const actualChecks = Object.freeze([
  "recorded_homeowner_consent_to_billing_sms",
  "fee_claim_free_rendered_body",
  "live_jobber_balance_on_three_reads",
  "live_jobber_invoice_link_compared_on_every_read",
  "fresh_channel_dnd_contact_get_2021_07_28",
  "exhaust_accessible_history_and_union_local_ledger",
  "single_reservation_per_logical_event_no_retry",
  "single_pending_post_boundary",
]);

/** The only link shape we accept. A plain https client-hub URL for this invoice. */
const CLIENT_HUB = /^https:\/\/clienthub\.getjobber\.com\/client_hubs\/[0-9a-f-]{36}\/invoices\/[A-Za-z0-9._~-]{1,256}$/;
const validLink = (link: unknown, invoiceId: string): link is Day15InvoiceLink =>
  keys(link, ["source", "invoiceId", "url", "evidenceRef"]) &&
  (link as Day15InvoiceLink).source === "jobber-invoice-client-hub-uri" &&
  (link as Day15InvoiceLink).invoiceId === invoiceId &&
  typeof (link as Day15InvoiceLink).url === "string" && CLIENT_HUB.test((link as Day15InvoiceLink).url) &&
  text((link as Day15InvoiceLink).evidenceRef);

function readiness(raw: string | undefined, review?: Day15SenderReview): { result: Day15SenderReadiness; config?: Day15SenderConfig } {
  const missing: string[] = [], check = (ok: unknown, name: string) => { if (!ok) missing.push(name); };
  let config: Day15SenderConfig | undefined, configSha256: string | null = null;
  if (typeof raw !== "string" || !raw || Buffer.byteLength(raw, "utf8") > 32_768) missing.push("bounded_config_file");
  else {
    configSha256 = sha(raw);
    try { config = JSON.parse(raw) as Day15SenderConfig; } catch { missing.push("valid_config_json"); }
  }
  const c = config;
  if (c) {
    check(keys(c, ["version", "kind", "reviewRef", "reviewedAt", "expiresAt", "source", "destination", "scope",
      "currencyPolicy", "consent", "invoiceLink", "sender", "template", "nativeSms"]), "exact_config_schema");
    check(c.version === 1 && c.kind === DAY15_SENDER_KIND, "day15_sender_version");
    const at = Date.now(), reviewed = instant(c.reviewedAt), expires = instant(c.expiresAt);
    check(text(c.reviewRef) && reviewed <= at && at < expires && expires > reviewed && expires - reviewed <= 86_400_000,
      "current_finite_config_review");
    const s = c.source, accountId = s?.identityCoveragePolicy?.accountId, invoiceId = s?.scope?.invoiceId;
    check(s?.version === 1 && text(s.reviewRef) && s.scope && Object.values(s.scope).every(text) &&
      keys(s.scope, ["locationId", "jobberClientId", "contactId", "invoiceId"]) &&
      instant(s.expiresAt) >= expires && text(accountId) && s.originalInvoice &&
      Number.isSafeInteger(s.originalInvoice.totalMinor) && s.originalInvoice.totalMinor > 0 &&
      invoiceCalendarDate(s.originalInvoice.issuedDate) && invoiceCalendarDate(s.originalInvoice.dueDate),
      "exact_source_request_and_original_pins");
    const scope = c.scope;
    check(keys(scope, ["scheduledOn", "dayPastDue", "audience", "channel", "maximumAttempts", "history", "timeZone",
      "window", "authorizationRef", "timingRef", "credentialBindingRef"]) &&
      scope?.dayPastDue === 15 && scope.audience === "homeowner" && scope.channel === "sms" && scope.maximumAttempts === 1 &&
      scope.history === "accessible-ghl-plus-local-ledger" && scope.timeZone === "America/Phoenix" &&
      scope.window === "[09:00:00,09:15:00)" &&
      [scope.authorizationRef, scope.timingRef, scope.credentialBindingRef].every(text),
      "finite_day15_sms_scope_and_review_references");
    const due = s?.originalInvoice && invoiceCalendarDate(s.originalInvoice.dueDate);
    check(due && scope?.scheduledOn === addInvoiceCalendarDays(due, 15), "exact_day15_scheduled_date");
    check(phone(c.destination), "exact_homeowner_sms_destination");
    const currency = c.currencyPolicy;
    check(keys(currency, ["accountId", "invoiceId", "currency", "minorUnitExponent", "evidenceRef"]) &&
      currency?.accountId === accountId && currency?.invoiceId === invoiceId &&
      /^[A-Z]{3}$/.test(currency?.currency ?? "") && currency?.minorUnitExponent === 2 && text(currency?.evidenceRef),
      "reviewed_exact_invoice_currency_policy");
    // No DND reading can satisfy this. "Nothing on file" is not consent.
    check(typeof invoiceId === "string" && text(s?.scope?.contactId) &&
      smsConsentIsRecorded(c.consent ?? null, s!.scope.contactId), "recorded_homeowner_consent_to_billing_sms");
    check(typeof invoiceId === "string" && validLink(c.invoiceLink, invoiceId), "reviewed_exact_jobber_invoice_link");
    check(keys(c.sender, ["number", "approvalRef", "writeScopeEvidenceRef"]) && phone(c.sender?.number) &&
      text(c.sender?.approvalRef) && text(c.sender?.writeScopeEvidenceRef), "explicit_sender_and_scope_review");
    const t = c.template;
    const tokens = typeof t?.body === "string" ? t.body.replace(/\{\{(balance|invoiceLink)\}\}/g, "") : "{";
    check(keys(t, ["id", "version", "body", "policy", "approvalRef"]) && [t?.id, t?.version, t?.approvalRef].every(text) &&
      t?.policy === DAY15_TEMPLATE_POLICY && typeof t?.body === "string" && t.body.trim() &&
      Buffer.byteLength(t.body, "utf8") <= 4000 && !t.body.includes("\0") &&
      t.body.includes("{{balance}}") && t.body.includes("{{invoiceLink}}") && !tokens.match(/[{}]/),
      "day15_fee_free_body_rendering_policy");
    // The template must state no fee, with and without its placeholders filled in.
    check(typeof t?.body === "string" && bodyMakesNoFeeClaim(t.body), "template_states_no_late_fee");
    const n = c.nativeSms;
    check(keys(n, ["version", "status", "receiptSource", "semanticsRef", "footer"]) && n?.version === "2021-07-28" &&
      n.status === "pending" && n.receiptSource === "app" && text(n.semanticsRef), "verified_native_sms_semantics_reference");
    check(keys(n?.footer, ["mode", "suffix", "evidenceRef"]) && n?.footer?.mode === "exact-native-suffix" &&
      typeof n.footer.suffix === "string" && !!n.footer.suffix.trim() && n.footer.suffix.length <= 4096 &&
      text(n.footer.evidenceRef), "exact_native_footer_policy");
  }
  check(review && review.configSha256 === configSha256 && /^[a-f0-9]{64}$/.test(review.configSha256), "out_of_band_reviewed_config_sha256");
  check(review && text(review.reviewRef) && review.reviewRef === c?.reviewRef, "out_of_band_review_reference");
  check(review && ["read-only", "one-attempt"].includes(review.action), "explicit_runtime_action");
  const result: Day15SenderReadiness = Object.freeze({ state: missing.length ? "held" : "reviewed_configuration",
    configSha256, missing: Object.freeze(missing), actualRuntimeChecks: actualChecks,
    productionSendCapability: false, rolloutReady: false });
  return { result, config: missing.length ? undefined : c };
}

/** Static validation only. No clients, env, files, database or network. */
export function inspectDay15SenderReadiness(raw?: string, review?: Day15SenderReview): Day15SenderReadiness {
  try { return readiness(raw, review).result; } catch {
    return Object.freeze({ state: "held", configSha256: null, missing: Object.freeze(["malformed_configuration"]),
      actualRuntimeChecks: actualChecks, productionSendCapability: false, rolloutReady: false });
  }
}

/** Call only from the trusted operator boundary with the separately reviewed hash. */
export function reviewDay15SenderConfiguration(raw: string, review: Day15SenderReview) {
  const result = inspectDay15SenderReadiness(raw, review);
  if (result.state !== "reviewed_configuration") return Object.freeze({ readiness: result, handle: null });
  const handle = Object.freeze({}) as ReviewedDay15Sender;
  configHandles.set(handle, { config: freeze(JSON.parse(raw) as Day15SenderConfig), review: freeze(structuredClone(review)) });
  return Object.freeze({ readiness: result, handle });
}

/**
 * Renders the live balance and the live invoice link. Throws rather than send a
 * message with a stale amount, an empty amount, or a link that is not this invoice's.
 */
export function renderDay15SenderBody(config: Day15SenderConfig,
  snapshot: Readonly<{ balanceMinor: number }>, invoiceLinkUrl: string): string {
  if (!Number.isSafeInteger(snapshot.balanceMinor) || snapshot.balanceMinor <= 0)
    throw new Error("day15_requires_positive_balance");
  if (!validLink({ source: "jobber-invoice-client-hub-uri", invoiceId: config.source.scope.invoiceId,
    url: invoiceLinkUrl, evidenceRef: config.invoiceLink.evidenceRef }, config.source.scope.invoiceId))
    throw new Error("invalid_live_invoice_link");
  if (invoiceLinkUrl !== config.invoiceLink.url) throw new Error("invoice_link_drift");
  const balance = `${config.currencyPolicy.currency} ${Math.floor(snapshot.balanceMinor / 100)}.${String(snapshot.balanceMinor % 100).padStart(2, "0")}`;
  const body = config.template.body.replace(/\{\{(balance|invoiceLink)\}\}/g, (_, token: string) =>
    token === "balance" ? balance : invoiceLinkUrl);
  // Rendering must not be able to introduce fee wording that the template did not have.
  if (!bodyMakesNoFeeClaim(body)) throw new Error("rendered_body_claims_a_fee");
  return body;
}

export function createDay15Sender(options: Readonly<{
  mode?: "read-only" | "reviewed-one-attempt"; config?: ReviewedDay15Sender;
  runtime?: () => Promise<Day15SenderRuntime>;
}> = {}) {
  const mode = options.mode;
  // Exact default no-op: do not inspect a config/runtime getter, env or ambient clients.
  const enabled = mode === "read-only" || mode === "reviewed-one-attempt";
  const configHandle = enabled ? options.config : undefined, bootstrap = enabled ? options.runtime : undefined;
  let used = false;
  return Object.freeze({ async run(): Promise<NotificationRunnerResult> {
    const held = (reason: string): NotificationRunnerResult => Object.freeze({ state: "held", phase: "day15_sender_configuration",
      reasons: Object.freeze([reason]), reservationCreated: false, attempted: false, transport: null,
      productionSendCapability: false, retryAllowed: false });
    if (!enabled) return createNotificationRunner().runOne();
    if (used) return held("day15_sender_already_consumed_no_retry");
    used = true;
    const saved = configHandle && configHandles.get(configHandle);
    if (!saved || !bootstrap) return held("original_reviewed_config_and_runtime_required");
    const { config: c, review } = saved;
    if (Date.now() >= instant(c.expiresAt) || Date.now() < instant(c.reviewedAt)) return held("day15_sender_review_expired");
    if (mode === "reviewed-one-attempt" && review.action !== "one-attempt") return held("read_only_review_cannot_authorize_attempt");
    try {
      const runtime = await bootstrap();
      const accountId = c.source.identityCoveragePolicy.accountId, locationId = c.source.scope.locationId;
      if (runtime.accountId !== accountId || runtime.locationId !== locationId) return held("runtime_account_location_mismatch");
      const { fetch: fetcher, credential, database, sourceIO, verifyActiveHolds, readInvoiceLink } = runtime;
      const verify = () => {
        verifyActiveHolds();
        if (Date.now() >= instant(c.expiresAt) || Date.now() < instant(c.reviewedAt)) throw new Error("day15_sender_review_expired");
      };
      verify();
      const guardedFetch: typeof fetch = (input, init) => {
        verify();
        if (mode === "read-only" && init?.method !== "GET") throw new Error("read_only_http_write_blocked");
        return fetcher(input, init);
      };
      // Re-read the link on every source read. A changed link is drift, not a new link.
      const freshLink = async () => {
        verify();
        const url = await readInvoiceLink(c.source.scope.invoiceId);
        if (url !== c.invoiceLink.url) throw new Error("invoice_link_drift");
        return url;
      };
      const senderReader = createNotificationSenderReader({ fetch: guardedFetch, credential, accountId, locationId,
        scopes: ["phonenumbers.read"], now });
      let senderHandle: NotificationSenderHandle | null = null;
      let latest: NotificationSourceSnapshot | null = null;
      async function freshSender() {
        verify();
        const result = await senderReader.read({ accountId, locationId, expectedNumber: c.sender.number });
        senderHandle = result.handle;
        const facts = senderHandle && inspectNotificationSender(senderHandle);
        if (!facts) throw new Error("configured_sender_unverified");
        return facts;
      }
      const senderReview = () => {
        if (!senderHandle || !inspectNotificationSender(senderHandle)) throw new Error("sender_expired");
        return { accountId, locationId, channel: "sms" as const, sender: c.sender.number,
          scope: "conversations/message.write" as const, approved: true as const, validated: true as const,
          evidenceRef: c.sender.approvalRef };
      };
      const dependencies: NotificationRunnerDependencies = {
        sourceRequest: c.source, sourceIO, database,
        contact: { fetch: guardedFetch, credential, accountId, locationId, scopes: ["contacts.readonly"] },
        transport: { fetch: guardedFetch, credential, accountId, locationId, scopes: ["conversations/message.write"] },
        prepare: async s => {
          verify(); latest = s;
          await freshSender();
          const body = renderDay15SenderBody(c, s, await freshLink());
          const event: Event = immutableEvent({ accountId: s.accountId, invoiceId: s.invoiceId, ownerId: s.ownerId,
            homeownerContactId: s.homeownerContactId, sourceRevision: s.sourceRevision, ownerRevision: s.ownerRevision,
            issuedDate: s.issuedDate, dueDate: s.dueDate, balanceMinor: s.balanceMinor,
            currency: c.currencyPolicy.currency, category: null, dayPastDue: 15, audience: "homeowner",
            recipientId: s.homeownerContactId, contactId: s.homeownerContactId, channel: "sms",
            destination: c.destination, templateId: c.template.id, templateVersion: c.template.version,
            bodyDigest: sha(body), claimedFacts: [] });
          return { event, body, contentType: "text/plain", sender: senderReview(), constructionReview: {
            mode: "reviewed-construction-only", version: "2021-07-28", accountId, locationId, channel: "sms",
            proposedStatus: "pending", evidenceRef: c.nativeSms.semanticsRef }, smsReceiptSuffixPolicy: {
            mode: "reviewed-exact-native-sms-suffix", version: "2021-07-28", channel: "sms", source: "app", accountId,
            locationId, sender: c.sender.number, suffix: c.nativeSms.footer.suffix, evidenceRef: c.nativeSms.footer.evidenceRef } };
        },
        readExternal: async (s, event) => {
          verify(); latest = s;
          // The balance, the dates and the link must all still describe the reviewed invoice.
          if (s.dueOn !== invoiceCalendarDate(c.source.originalInvoice.dueDate) ||
              sha(renderDay15SenderBody(c, s, await freshLink())) !== event.bodyDigest)
            throw new Error("source_render_drift");
          const facts = await freshSender();
          const history = await readNotificationHistory({ scope: { accountId, locationId,
            contactId: s.homeownerContactId, invoiceId: s.invoiceId, issuedDate: s.issuedDate, audience: "homeowner" },
            reviewRef: c.reviewRef }, {
            accountId, locationId, now,
            get: async req => {
              verify();
              if (req.headers.Version !== NOTIFICATION_HISTORY_CONTRACT.version || req.method !== "GET")
                throw new Error("history_contract_drift");
              const response = await guardedFetch(req.url, { method: "GET", redirect: "error", signal: req.signal,
                headers: { ...req.headers, Authorization: `Bearer ${credential}` } });
              if (response.redirected || response.url !== req.url) throw new Error("history_redirect_or_url_mismatch");
              return { status: response.status, body: response.body };
            },
            select: (sql, parameters) => { verify(); return database.transaction(tx => tx.query(sql, parameters)); },
          });
          const external = projectAccessibleGhlExternalHistory(history);
          if (!external.handle) throw new Error("accessible_history_held");
          const attempts = composeAccessibleGhlExternalAttempts(external.handle, event, now());
          if (!attempts.attempts || !attempts.requiresIndependentLocalLedgerUnion)
            throw new Error("history_projection_unverified");
          verify();
          const observedAt = facts.observedAt;
          const expiresAt = new Date(Math.min(Date.parse(facts.expiresAt), instant(c.expiresAt))).toISOString();
          const p = { observedAt, expiresAt, sourceRef: `reviewed-day15-sender-policy:${review.configSha256}` };
          return { metadata: { ...p, accountId, invoiceId: s.invoiceId, sourceRevision: s.sourceRevision,
            currency: c.currencyPolicy.currency, category: null, categoryVerified: false },
            recipient: { ...p, accountId, recipientId: event.recipientId, contactId: event.contactId,
              audience: "homeowner", channel: "sms", destination: c.destination, exactSourceIdentity: true,
              destinationVerified: true, internalRecipientApproved: false },
            // feeClaimFree is asserted here only because the rendered body was just checked.
            template: { ...p, approved: true, accountId, id: c.template.id, version: c.template.version,
              bodyDigest: event.bodyDigest, audience: "homeowner", dayPastDue: 15, channel: "sms",
              claimedFacts: [], feeClaimFree: true },
            channelAuthorization: { ...p, approved: true, eventKey: eventKey(event), recipientId: event.recipientId,
              channel: "sms", destination: c.destination },
            facts: [], attempts: attempts.attempts };
        },
        review: async (construction, event, binding) => {
          verify();
          if (!latest || !construction.request || mode !== "reviewed-one-attempt" || review.action !== "one-attempt")
            throw new Error("exact_request_or_action_not_reviewed");
          const rendered = renderDay15SenderBody(c, latest, await freshLink());
          if (sha(rendered) !== event.bodyDigest || construction.request.body.message !== rendered)
            throw new Error("exact_request_or_action_not_reviewed");
          const requestSha256 = sha(construction.request.serializedBody), at = Date.now();
          return { mode: "reviewed-one-attempt", event, binding, sender: senderReview(),
            reviewedAt: new Date(at).toISOString(),
            expiresAt: new Date(Math.min(at + 30_000, instant(c.expiresAt))).toISOString(),
            statusSemantics: { verified: true, version: "2021-07-28", status: "pending", evidenceRef: c.nativeSms.semanticsRef },
            content: { approved: true, requestSha256, evidenceRef: c.template.approvalRef },
            authorization: { approved: true, timingApproved: true, requestSha256, evidenceRef: c.scope.authorizationRef } };
        },
      };
      return await createNotificationRunner({
        mode: mode === "read-only" ? "read-only-candidate" : "reviewed-one-event-candidate", dependencies }).runOne();
    } catch { return held("day15_runtime_or_required_evidence_unavailable"); }
  } });
}

/** Redacted outcome. Rollout and retry permission remain false whatever happened. */
export function summarizeDay15SenderExecution(result: NotificationRunnerResult) {
  return Object.freeze({ state: result.state, phase: result.phase, reasons: result.reasons,
    reservationAcknowledged: result.reservationCreated, attempted: result.attempted,
    rolloutReady: false as const, retryAllowed: false as const });
}
