/** Explicit one-invoice pilot composition. Import/readiness/default execution are inert. */
import { createHash } from "node:crypto";
import { ORIGINAL_DAY10_SMS_BODY } from "./notification-copy-policy";
import { addInvoiceCalendarDays, invoiceCalendarDate } from "./invoice-reminder-clock";
import { eventKey, immutableEvent, type Event } from "./notification-gate";
import { createNotificationRunner, type NotificationRunnerDependencies, type NotificationRunnerResult } from "./notification-runner";
import { createNotificationSenderReader, inspectNotificationSender, type NotificationSenderHandle } from "./notification-sender";
import { readNotificationHistory, projectAccessibleGhlExternalHistory, composeAccessibleGhlExternalAttempts,
  NOTIFICATION_HISTORY_CONTRACT } from "./notification-history";
import type { NotificationSourceRequest, NotificationSourceIO, NotificationSourceSnapshot } from "./notification-source";
import type { NotificationLedgerDatabase } from "./notification-ledger";

export type Day10PilotConfig = Readonly<{
  version: 1; kind: "day10-homeowner-sms-pilot"; reviewRef: string; reviewedAt: string; expiresAt: string;
  source: NotificationSourceRequest;
  destination: string;
  scope: Readonly<{ scheduledOn: string; dayPastDue: 10; audience: "homeowner"; channel: "sms"; maximumAttempts: 1;
    history: "accessible-ghl-plus-local-ledger"; timeZone: "America/Phoenix"; window: "[09:00:00,09:15:00)";
    authorizationRef: string; timingRef: string; credentialBindingRef: string }>;
  currencyPolicy: Readonly<{ accountId: string; invoiceId: string; currency: string; minorUnitExponent: 2; evidenceRef: string }> | null;
  sender: Readonly<{ number: string; approvalRef: string; writeScopeEvidenceRef: string }> | null;
  template: Readonly<{ id: string; version: string; body: string; policy: "day10-open-balance-no-enforcement"; approvalRef: string }> | null;
  nativeSms: Readonly<{ version: "2021-07-28"; status: "pending"; receiptSource: "app"; semanticsRef: string;
    footer: Readonly<{ mode: "exact-native-suffix"; suffix: string; evidenceRef: string }> }> | null;
}>;
/** Out-of-band, explicit operator review, never populated from config JSON or an environment flag.
 * This process-local boundary is NOT cryptographic authentication or a remotely exposed API. */
export type Day10PilotReview = Readonly<{ configSha256: string; reviewRef: string; action: "read-only" | "one-attempt" }>;
declare const configBrand: unique symbol;
export type ReviewedDay10Pilot = Readonly<{ [configBrand]: true }>;
export type Day10PilotReadiness = Readonly<{ state: "held" | "reviewed_configuration";
  configSha256: string | null; missing: readonly string[]; actualRuntimeChecks: readonly string[];
  productionSendCapability: false; rolloutReady: false }>;
export type Day10PilotRuntime = Readonly<{
  accountId: string; locationId: string; credential: string; fetch: typeof fetch;
  sourceIO: NotificationSourceIO; database: NotificationLedgerDatabase;
  /** Real bootstrap checks the existing deployment/write holds and configuration continuity. */
  verifyActiveHolds(): void;
  /** Standalone CLI cleanup only; never a source mutation or retry. */
  close?(): Promise<void>;
}>;
const configHandles = new WeakMap<ReviewedDay10Pilot, { config: Day10PilotConfig; review: Day10PilotReview }>();
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const now = () => new Date(Date.now());
const text = (x: unknown): x is string => typeof x === "string" && !!x && x.length <= 256 && x.trim() === x && !/[\x00-\x1f\x7f]/.test(x);
const phone = (x: unknown): x is string => typeof x === "string" && /^\+1[2-9]\d{2}[2-9]\d{6}$/.test(x);
const instant = (x: unknown): number => typeof x === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x) &&
  Number.isFinite(Date.parse(x)) && new Date(Date.parse(x)).toISOString() === x ? Date.parse(x) : NaN;
function freeze<T>(x: T): T { if (x && typeof x === "object") { Object.values(x).forEach(freeze); Object.freeze(x); } return x; }
const actualChecks = Object.freeze(["read_only_existing_token_with_900_second_coverage", "active_deployment_write_holds",
  "opaque_jobber_owner_invoice_and_both_primary_destinations", "fresh_channel_dnd_contact_get_2021_07_28",
  "configured_sender_get_v3", "exhaust_accessible_history_2021_04_15_and_preserve_all_attempts",
  "real_local_ledger_union_and_original_owned_reservation", "fresh_final_source_and_external_rereads",
  "approved_exact_rendered_request_and_single_pending_post_boundary"]);
function keys(x: unknown, expected: string[]): boolean {
  return !!x && typeof x === "object" && !Array.isArray(x) &&
    Object.keys(x).length === expected.length && Object.keys(x).every(k => expected.includes(k));
}
function readiness(raw: string | undefined, review?: Day10PilotReview): { result: Day10PilotReadiness; config?: Day10PilotConfig } {
  const missing: string[] = [], check = (ok: unknown, name: string) => { if (!ok) missing.push(name); };
  let config: Day10PilotConfig | undefined, configSha256: string | null = null;
  if (typeof raw !== "string" || !raw || Buffer.byteLength(raw, "utf8") > 32_768) missing.push("bounded_config_file");
  else {
    configSha256 = sha(raw);
    try { config = JSON.parse(raw) as Day10PilotConfig; } catch { missing.push("valid_config_json"); }
  }
  const c = config;
  if (c) {
    check(keys(c, ["version", "kind", "reviewRef", "reviewedAt", "expiresAt", "source", "destination", "scope", "currencyPolicy", "sender", "template", "nativeSms"]), "exact_config_schema");
    check(c.version === 1 && c.kind === "day10-homeowner-sms-pilot", "day10_pilot_version");
    const at = Date.now(), reviewed = instant(c.reviewedAt), expires = instant(c.expiresAt);
    check(text(c.reviewRef) && reviewed <= at && at < expires && expires > reviewed && expires - reviewed <= 86_400_000, "current_finite_config_review");
    const s = c.source, accountId = s?.identityCoveragePolicy?.accountId;
    check(s?.version === 1 && text(s.reviewRef) && s.scope && Object.values(s.scope).every(text) &&
      keys(s.scope, ["locationId", "jobberClientId", "contactId", "invoiceId"]) &&
      instant(s.expiresAt) >= expires && text(accountId) && s.originalInvoice &&
      Number.isSafeInteger(s.originalInvoice.totalMinor) && s.originalInvoice.totalMinor > 0 &&
      invoiceCalendarDate(s.originalInvoice.issuedDate) && invoiceCalendarDate(s.originalInvoice.dueDate), "exact_source_request_and_original_pins");
    const scope = c.scope;
    check(keys(scope, ["scheduledOn", "dayPastDue", "audience", "channel", "maximumAttempts", "history", "timeZone", "window", "authorizationRef", "timingRef", "credentialBindingRef"]) &&
      scope?.dayPastDue === 10 && scope.audience === "homeowner" && scope.channel === "sms" && scope.maximumAttempts === 1 &&
      scope.history === "accessible-ghl-plus-local-ledger" && scope.timeZone === "America/Phoenix" && scope.window === "[09:00:00,09:15:00)" &&
      [scope.authorizationRef, scope.timingRef, scope.credentialBindingRef].every(text), "finite_day10_sms_scope_and_review_references");
    const due = s?.originalInvoice && invoiceCalendarDate(s.originalInvoice.dueDate);
    check(due && scope?.scheduledOn === addInvoiceCalendarDays(due, 10), "exact_day10_scheduled_date");
    check(phone(c.destination), "exact_homeowner_sms_destination");
    const currency = c.currencyPolicy, originalStaticCopy = c.template?.body === ORIGINAL_DAY10_SMS_BODY;
    const validCurrencyPolicy = keys(currency, ["accountId", "invoiceId", "currency", "minorUnitExponent", "evidenceRef"]) && currency?.accountId === accountId &&
      currency?.invoiceId === s?.scope?.invoiceId && /^[A-Z]{3}$/.test(currency?.currency ?? "") && currency?.minorUnitExponent === 2 &&
      text(currency?.evidenceRef);
    check(currency === null && originalStaticCopy || validCurrencyPolicy, "reviewed_exact_invoice_currency_policy");
    check(keys(c.sender, ["number", "approvalRef", "writeScopeEvidenceRef"]) && phone(c.sender?.number) &&
      text(c.sender?.approvalRef) && text(c.sender?.writeScopeEvidenceRef), "explicit_sender_and_scope_review");
    const t = c.template;
    check(keys(t, ["id", "version", "body", "policy", "approvalRef"]) && [t?.id, t?.version, t?.approvalRef].every(text) &&
      t?.policy === "day10-open-balance-no-enforcement" && typeof t?.body === "string" && t.body.trim() &&
      Buffer.byteLength(t.body, "utf8") <= 4000 && !t.body.includes("\0") && (originalStaticCopy || t.body.includes("{{balance}}")) &&
      !t.body.replace(/\{\{(balance|invoiceNumber|dueDate)\}\}/g, "").match(/[{}]/), "approved_day10_exact_body_rendering_policy");
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
  const result: Day10PilotReadiness = Object.freeze({ state: missing.length ? "held" : "reviewed_configuration", configSha256,
    missing: Object.freeze(missing), actualRuntimeChecks: actualChecks, productionSendCapability: false, rolloutReady: false });
  return { result, config: missing.length ? undefined : c };
}
/** Static validation only. No imports of clients or access to env/files/database/network. */
export function inspectDay10PilotReadiness(raw?: string, review?: Day10PilotReview): Day10PilotReadiness {
  try { return readiness(raw, review).result; } catch { return Object.freeze({ state: "held", configSha256: null,
    missing: Object.freeze(["malformed_configuration"]), actualRuntimeChecks: actualChecks, productionSendCapability: false, rolloutReady: false }); }
}
/** Call only from the trusted operator/application boundary with the separately reviewed hash.
 * A hash is an integrity pin, not proof that the caller had authority to approve its contents. */
export function reviewDay10PilotConfiguration(raw: string, review: Day10PilotReview) {
  const result = inspectDay10PilotReadiness(raw, review);
  if (result.state !== "reviewed_configuration") return Object.freeze({ readiness: result, handle: null });
  const handle = Object.freeze({}) as ReviewedDay10Pilot;
  configHandles.set(handle, { config: freeze(JSON.parse(raw) as Day10PilotConfig), review: freeze(structuredClone(review)) });
  return Object.freeze({ readiness: result, handle });
}
function render(c: Day10PilotConfig, s: NotificationSourceSnapshot): string {
  if (c.template!.body === ORIGINAL_DAY10_SMS_BODY) return c.template!.body;
  if (!c.currencyPolicy) throw new Error("monetary_rendering_requires_reviewed_currency");
  if (c.template!.body.includes("{{invoiceNumber}}") && !s.invoiceNumber) throw new Error("invoice_display_number_required");
  const balance = `${c.currencyPolicy!.currency} ${Math.floor(s.balanceMinor / 100)}.${String(s.balanceMinor % 100).padStart(2, "0")}`;
  return c.template!.body.replace(/\{\{(balance|invoiceNumber|dueDate)\}\}/g, (_, token: string) =>
    token === "balance" ? balance : token === "invoiceNumber" ? s.invoiceNumber! : s.dueOn);
}

export function createDay10Pilot(options: Readonly<{
  mode?: "read-only" | "reviewed-one-attempt"; config?: ReviewedDay10Pilot;
  runtime?: () => Promise<Day10PilotRuntime>;
}> = {}) {
  const mode = options.mode;
  // Exact default no-op: do not inspect a config/runtime getter, env or ambient clients.
  const enabled = mode === "read-only" || mode === "reviewed-one-attempt";
  const configHandle = enabled ? options.config : undefined, bootstrap = enabled ? options.runtime : undefined;
  let used = false;
  return Object.freeze({ async run(): Promise<NotificationRunnerResult> {
    const held = (reason: string): NotificationRunnerResult => Object.freeze({ state: "held", phase: "pilot_configuration",
      reasons: Object.freeze([reason]), reservationCreated: false, attempted: false, transport: null, productionSendCapability: false, retryAllowed: false });
    if (!enabled) return createNotificationRunner().runOne();
    if (used) return held("pilot_already_consumed_no_retry");
    used = true;
    const saved = configHandle && configHandles.get(configHandle);
    if (!saved || !bootstrap) return held("original_reviewed_config_and_runtime_required");
    const { config: c, review } = saved;
    if (Date.now() >= instant(c.expiresAt) || Date.now() < instant(c.reviewedAt)) return held("pilot_review_expired");
    if (mode === "reviewed-one-attempt" && review.action !== "one-attempt") return held("read_only_review_cannot_authorize_attempt");
    try {
      const runtime = await bootstrap();
      const accountId = c.source.identityCoveragePolicy.accountId, locationId = c.source.scope.locationId;
      if (runtime.accountId !== accountId || runtime.locationId !== locationId) return held("runtime_account_location_mismatch");
      const { fetch: fetcher, credential, database, sourceIO, verifyActiveHolds } = runtime;
      const verify = () => { verifyActiveHolds(); if (Date.now() >= instant(c.expiresAt) || Date.now() < instant(c.reviewedAt)) throw new Error("pilot_review_expired"); };
      verify();
      const guardedFetch: typeof fetch = (input, init) => { verify();
        if (mode === "read-only" && init?.method !== "GET") throw new Error("read_only_http_write_blocked");
        return fetcher(input, init); };
      const senderReader = createNotificationSenderReader({ fetch: guardedFetch, credential, accountId, locationId,
        scopes: ["phonenumbers.read"], now });
      let senderHandle: NotificationSenderHandle | null = null;
      let latest: NotificationSourceSnapshot | null = null;
      async function freshSender() {
        verify(); const result = await senderReader.read({ accountId, locationId, expectedNumber: c.sender!.number });
        senderHandle = result.handle;
        const facts = senderHandle && inspectNotificationSender(senderHandle);
        if (!facts) throw new Error("configured_sender_unverified");
        return facts;
      }
      const senderReview = () => {
        if (!senderHandle || !inspectNotificationSender(senderHandle)) throw new Error("sender_expired");
        return { accountId, locationId, channel: "sms" as const, sender: c.sender!.number, scope: "conversations/message.write" as const,
          approved: true as const, validated: true as const, evidenceRef: c.sender!.approvalRef };
      };
      const dependencies: NotificationRunnerDependencies = {
        sourceRequest: c.source, sourceIO, database,
        contact: { fetch: guardedFetch, credential, accountId, locationId, scopes: ["contacts.readonly"] },
        transport: { fetch: guardedFetch, credential, accountId, locationId, scopes: ["conversations/message.write"] },
        prepare: async s => {
          verify(); latest = s; await freshSender();
          const body = render(c, s);
          const event: Event = immutableEvent({ accountId: s.accountId, invoiceId: s.invoiceId, ownerId: s.ownerId,
            homeownerContactId: s.homeownerContactId, sourceRevision: s.sourceRevision, ownerRevision: s.ownerRevision,
            issuedDate: s.issuedDate, dueDate: s.dueDate, balanceMinor: s.balanceMinor, currency: c.currencyPolicy?.currency ?? null,
            category: null, dayPastDue: 10, audience: "homeowner", recipientId: s.homeownerContactId, contactId: s.homeownerContactId,
            channel: "sms", destination: c.destination, templateId: c.template!.id, templateVersion: c.template!.version,
            bodyDigest: sha(body), claimedFacts: [] });
          return { event, body, contentType: "text/plain", sender: senderReview(), constructionReview: {
            mode: "reviewed-construction-only", version: "2021-07-28", accountId, locationId, channel: "sms",
            proposedStatus: "pending", evidenceRef: c.nativeSms!.semanticsRef }, smsReceiptSuffixPolicy: {
            mode: "reviewed-exact-native-sms-suffix", version: "2021-07-28", channel: "sms", source: "app", accountId,
            locationId, sender: c.sender!.number, suffix: c.nativeSms!.footer.suffix, evidenceRef: c.nativeSms!.footer.evidenceRef } };
        },
        readExternal: async (s, event) => {
          verify(); latest = s;
          if (s.dueOn !== invoiceCalendarDate(c.source.originalInvoice.dueDate) ||
              sha(render(c, s)) !== event.bodyDigest) throw new Error("source_render_drift");
          const facts = await freshSender();
          const history = await readNotificationHistory({ scope: { accountId, locationId, contactId: s.homeownerContactId,
            invoiceId: s.invoiceId, issuedDate: s.issuedDate, audience: "homeowner" }, reviewRef: c.reviewRef }, {
            accountId, locationId, now,
            get: async req => { verify();
              if (req.headers.Version !== NOTIFICATION_HISTORY_CONTRACT.version || req.method !== "GET") throw new Error("history_contract_drift");
              const response = await guardedFetch(req.url, { method: "GET", redirect: "error", signal: req.signal,
                headers: { ...req.headers, Authorization: `Bearer ${credential}` } });
              if (response.redirected || response.url !== req.url) throw new Error("history_redirect_or_url_mismatch");
              return { status: response.status, body: response.body }; },
            select: (sql, parameters) => { verify(); return database.transaction(tx => tx.query(sql, parameters)); },
          });
          const external = projectAccessibleGhlExternalHistory(history);
          if (!external.handle) throw new Error("accessible_history_held");
          const attempts = composeAccessibleGhlExternalAttempts(external.handle, event, now());
          if (!attempts.attempts || !attempts.requiresIndependentLocalLedgerUnion) throw new Error("history_projection_unverified");
          // This is a revalidation of the immutable reviewed policy, not a new source observation.
          verify(); const observedAt = facts.observedAt;
          const expiresAt = new Date(Math.min(Date.parse(facts.expiresAt), instant(c.expiresAt))).toISOString();
          const p = { observedAt, expiresAt, sourceRef: `reviewed-day10-policy:${review.configSha256}` };
          return { metadata: { ...p, accountId, invoiceId: s.invoiceId, sourceRevision: s.sourceRevision,
            currency: c.currencyPolicy?.currency ?? null, category: null, categoryVerified: false },
            recipient: { ...p, accountId, recipientId: event.recipientId, contactId: event.contactId, audience: "homeowner",
              channel: "sms", destination: c.destination, exactSourceIdentity: true, destinationVerified: true, internalRecipientApproved: false },
            template: { ...p, approved: true, accountId, id: c.template!.id, version: c.template!.version,
              bodyDigest: event.bodyDigest, audience: "homeowner", dayPastDue: 10, channel: "sms", claimedFacts: [] },
            channelAuthorization: { ...p, approved: true, eventKey: eventKey(event), recipientId: event.recipientId, channel: "sms", destination: c.destination },
            facts: [], attempts: attempts.attempts };
        },
        review: async (construction, event, binding) => {
          verify(); if (!latest || !construction.request || sha(render(c, latest)) !== event.bodyDigest ||
            construction.request.body.message !== render(c, latest) || mode !== "reviewed-one-attempt" || review.action !== "one-attempt")
            throw new Error("exact_request_or_action_not_reviewed");
          const requestSha256 = sha(construction.request.serializedBody), at = Date.now();
          return { mode: "reviewed-one-attempt", event, binding, sender: senderReview(), reviewedAt: new Date(at).toISOString(),
            expiresAt: new Date(Math.min(at + 30_000, instant(c.expiresAt))).toISOString(),
            statusSemantics: { verified: true, version: "2021-07-28", status: "pending", evidenceRef: c.nativeSms!.semanticsRef },
            content: { approved: true, requestSha256, evidenceRef: c.template!.approvalRef },
            authorization: { approved: true, timingApproved: true, requestSha256, evidenceRef: c.scope.authorizationRef } };
        },
      };
      return await createNotificationRunner({ mode: mode === "read-only" ? "read-only-candidate" : "reviewed-one-event-candidate", dependencies }).runOne();
    } catch { return held("pilot_runtime_or_required_evidence_unavailable"); }
  } });
}

/** Explicit no-refresh deployment bootstrap, reachable only with an original reviewed config.
 * Merely importing or inspecting readiness never imports this module or acquires credentials. */
export async function deployedDay10PilotRuntime(handle: ReviewedDay10Pilot, action: "read-only" | "one-attempt" = "read-only"): Promise<Day10PilotRuntime> {
  const saved = configHandles.get(handle);
  if (!saved || Date.now() >= instant(saved.config.expiresAt) || (action === "one-attempt" && saved.review.action !== "one-attempt"))
    throw new Error("current_reviewed_config_and_action_required");
  const { bootstrapDay10PilotRuntime } = await import("./notification-day10-runtime");
  return bootstrapDay10PilotRuntime({ accountId: saved.config.source.identityCoveragePolicy.accountId,
    locationId: saved.config.source.scope.locationId, action, expiresAt: saved.config.expiresAt });
}

/** Redacted action outcome, not a static capability claim. An attempted/accepted result may
 * describe a real explicit pilot action; rollout permission and retry permission remain false. */
export function summarizeDay10PilotExecution(result: NotificationRunnerResult) {
  return Object.freeze({ state: result.state, phase: result.phase, reasons: result.reasons,
    reservationAcknowledged: result.reservationCreated, attempted: result.attempted,
    rolloutReady: false as const, retryAllowed: false as const });
}
