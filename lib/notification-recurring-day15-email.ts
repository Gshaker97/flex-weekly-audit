/**
 * Day 15 customer EMAIL, recurring, over the existing machinery.
 *
 * This is the Day 10 cohort service's shape with one milestone and one channel changed.
 * Everything that decides whether a message may leave is reused unchanged:
 *
 *   Jobber decides       - the inventory/source batch supplies the exact invoice, its
 *                          live balance and its dates. No GHL pipeline stage is
 *                          consulted, so a stale opportunity stage cannot enrol anyone.
 *   the gate decides     - `notification-runner` -> `notification-gate`, including the
 *                          09:00-09:15 America/Phoenix window and no catch-up.
 *   the ledger admits    - one reservation per logical event, keyed on
 *                          (account, invoice, dayPastDue, audience). Invoice AND
 *                          milestone, never contact alone.
 *   history deduplicates - accessible GHL history unioned with the local ledger, so a
 *                          send by the OLD workflow blocks this one. Ambiguous history
 *                          is a hold, never a pass.
 *
 * Differences from Day 10 that matter:
 *   - channel email: the sender is an email address and the message carries a subject.
 *   - fee-free copy: the day-15 milestone requires `three_percent_fee_applied`; this
 *     copy claims no fee, so the gate's narrow `feeClaimFreeDay15` exemption applies.
 *     Both evidence reads must independently assert the template is fee-claim-free.
 *   - the live Jobber client-hub link is read per invoice and re-compared on every read.
 *   - two invoices for the same customer on the same day are HELD with an explicit
 *     reason rather than silently collapsed to one. Each keeps its own ledger event.
 *
 * Default is an exact no-op. Read-only does real reads but cannot reserve or POST.
 * Import is inert. No route, no scheduler, no ambient client, no catch-up.
 */
import { notificationModuleFunctions } from "./notification-module-interop";
import { createHash } from "node:crypto";
import { eventKey, immutableEvent, type Event } from "./notification-gate";
import { createNotificationRunner, type NotificationRunnerDependencies, type NotificationRunnerResult } from "./notification-runner";
import { readNotificationHistory, projectAccessibleGhlExternalHistory, composeAccessibleGhlExternalAttempts,
  NOTIFICATION_HISTORY_CONTRACT } from "./notification-history";
import { DAY15_EMAIL_TEMPLATE_POLICY, PROPOSED_DAY15_EMAIL_BODY, PROPOSED_DAY15_EMAIL_SUBJECT,
  day15EmailCopyIsFeeClaimFree, day15EmailTemplateShapeIsExact, renderDay15EmailBody } from "./notification-day15-email-copy";
import type { RecurringNotificationReadScope } from "./notification-recurring-coordinator";
import type { NotificationInventoryIO } from "./notification-inventory";
import type { NotificationRecurringSourceIO } from "./notification-source";
import type { NotificationLedgerDatabase } from "./notification-ledger";

/** One read-only Jobber query. The reader rejects anything not starting with `query`. */
export const DAY15_EMAIL_INVOICE_LINK_QUERY =
  `query ReadDay15EmailInvoiceClientHubLink($invoiceId: EncodedId!) {
    account { id }
    invoice(id: $invoiceId) { id clientHubUri }
  }`;

const CLIENT_HUB = /^https:\/\/clienthub\.getjobber\.com\/client_hubs\/[0-9a-f-]{36}\/invoices\/[A-Za-z0-9._~-]{1,256}$/;

/**
 * Install only from authorized deployment configuration, never request JSON. The shape
 * checks below establish integrity, not the deployer's authority.
 */
export type RecurringDay15EmailPolicy = Readonly<{
  accountId: string; locationId: string; validFrom: string; validUntil: string;
  cohort: "source-verified-open-homeowner-invoices";
  quarantine: RecurringNotificationReadScope["identityCoveragePolicy"]["quarantine"];
  /** Body and subject are pinned to the reviewed constants; no substitution at install. */
  template: Readonly<{ id: string; version: string; subject: typeof PROPOSED_DAY15_EMAIL_SUBJECT;
    body: typeof PROPOSED_DAY15_EMAIL_BODY; policy: typeof DAY15_EMAIL_TEMPLATE_POLICY }>;
  /** The approved From address. An email address, not a phone number. */
  sender: string;
  /** ISO 4217. Day 15 renders money, so an exact currency is required. */
  currency: string;
  channel: "email"; dayPastDue: 15; timeZone: "America/Phoenix"; window: "[09:00:00,09:15:00)";
  missed: "no-catch-up"; maximumAdmissionsPerRun: number;
  action: "read-only" | "attempt";
}>;

declare const policyBrand: unique symbol;
export type InstalledRecurringDay15EmailPolicy = Readonly<{ [policyBrand]: true }>;
const policies = new WeakMap<InstalledRecurringDay15EmailPolicy, { policy: RecurringDay15EmailPolicy; sourceRef: string }>();

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const now = () => new Date(Date.now());
const text = (x: unknown): x is string => typeof x === "string" && !!x && x.length <= 256 && x.trim() === x && !/[\x00-\x1f\x7f]/.test(x);
const emailish = (x: unknown): x is string => text(x) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x as string);
const instant = (x: unknown) => typeof x === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x) &&
  Number.isFinite(Date.parse(x)) && new Date(Date.parse(x)).toISOString() === x ? Date.parse(x) : NaN;
const freeze = <T>(x: T): T => { if (x && typeof x === "object") { Object.values(x as object).forEach(freeze); Object.freeze(x); } return x; };
const exact = (x: unknown, keys: string[]) => !!x && typeof x === "object" && !Array.isArray(x) &&
  Object.keys(x).length === keys.length && Object.keys(x).every(k => keys.includes(k));

export function installRecurringDay15EmailPolicy(input: RecurringDay15EmailPolicy): InstalledRecurringDay15EmailPolicy {
  const p = structuredClone(input);
  if (!exact(p, ["accountId", "locationId", "validFrom", "validUntil", "cohort", "quarantine", "template", "sender",
      "currency", "channel", "dayPastDue", "timeZone", "window", "missed", "maximumAdmissionsPerRun", "action"]) ||
      ![p.accountId, p.locationId].every(text) ||
      !(instant(p.validFrom) <= Date.now() && Date.now() < instant(p.validUntil)) ||
      p.cohort !== "source-verified-open-homeowner-invoices" ||
      !Array.isArray(p.quarantine) || p.quarantine.length !== 2 ||
      new Set(p.quarantine.map(q => q.jobberClientId)).size !== 2 ||
      p.quarantine.some(q => !exact(q, ["jobberClientId", "email", "phone"]) || !text(q.jobberClientId) ||
        !(q.email === null || text(q.email)) || !(q.phone === null || text(q.phone))) ||
      !exact(p.template, ["id", "version", "subject", "body", "policy"]) ||
      ![p.template.id, p.template.version].every(text) ||
      p.template.policy !== DAY15_EMAIL_TEMPLATE_POLICY ||
      // Pinned to the reviewed constants. Unreviewed wording cannot be installed.
      p.template.subject !== PROPOSED_DAY15_EMAIL_SUBJECT || p.template.body !== PROPOSED_DAY15_EMAIL_BODY ||
      !day15EmailTemplateShapeIsExact(p.template.body) ||
      !day15EmailCopyIsFeeClaimFree(p.template.subject, p.template.body) ||
      !emailish(p.sender) || !/^[A-Z]{3}$/.test(p.currency ?? "") ||
      p.channel !== "email" || p.dayPastDue !== 15 || p.timeZone !== "America/Phoenix" ||
      p.window !== "[09:00:00,09:15:00)" || p.missed !== "no-catch-up" ||
      !Number.isSafeInteger(p.maximumAdmissionsPerRun) || p.maximumAdmissionsPerRun < 1 || p.maximumAdmissionsPerRun > 1000 ||
      !["read-only", "attempt"].includes(p.action)) throw new Error("Invalid standing Day15 email service policy");
  const handle = Object.freeze({}) as InstalledRecurringDay15EmailPolicy;
  policies.set(handle, { policy: freeze(p), sourceRef: `standing-day15-email-policy:${sha(JSON.stringify(p))}` });
  return handle;
}

function owned(handle: InstalledRecurringDay15EmailPolicy | undefined, mode: "read-only" | "attempt") {
  const saved = handle && policies.get(handle), at = Date.now();
  if (!saved || at < instant(saved.policy.validFrom) || at >= instant(saved.policy.validUntil) ||
      mode === "attempt" && saved.policy.action !== "attempt") throw new Error("Original current policy and action required");
  return saved;
}

export type RecurringDay15EmailRuntime = Readonly<{
  accountId: string; locationId: string; inventoryIO: NotificationInventoryIO; sourceIO: NotificationRecurringSourceIO;
  credential: string; fetch: typeof fetch; database: NotificationLedgerDatabase;
  verifyActiveHolds(): void; close?(): Promise<void>;
}>;

export type RecurringDay15EmailResult = Readonly<{
  state: "disabled" | "completed" | "held" | "unknown"; reasons: readonly string[];
  invoices: readonly Readonly<{ ordinal: number; result: NotificationRunnerResult | null; holds: readonly string[] }>[];
  admissionAttempts: number; messageAttempts: number; retryAllowed: false; productionCallsite: false;
}>;

const result = (state: RecurringDay15EmailResult["state"], reasons: string[]): RecurringDay15EmailResult =>
  ({ state, reasons, invoices: [], admissionAttempts: 0, messageAttempts: 0, retryAllowed: false, productionCallsite: false });

export function createRecurringDay15EmailService(options: Readonly<{
  mode?: "read-only" | "attempt"; policy?: InstalledRecurringDay15EmailPolicy;
  runtime?: (scope: RecurringNotificationReadScope) => Promise<RecurringDay15EmailRuntime>;
}> = {}) {
  const mode = options.mode, enabled = mode === "read-only" || mode === "attempt";
  const policyHandle = enabled ? options.policy : undefined, bootstrap = enabled ? options.runtime : undefined;
  let used = false;
  return Object.freeze({ async run(): Promise<RecurringDay15EmailResult> {
    if (!enabled) return freeze(result("disabled", ["recurring_day15_email_disabled"]));
    if (used) return freeze(result("held", ["service_consumed_no_retry"]));
    used = true;
    const output = result("completed", []) as { -readonly [K in keyof RecurringDay15EmailResult]: RecurringDay15EmailResult[K] };
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const saved = owned(policyHandle, mode), p = saved.policy;
      if (mode === "attempt") {
        const local = new Intl.DateTimeFormat("en-GB", { timeZone: p.timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(now());
        if (local < "09:00" || local >= "09:15") return freeze(result("held", ["outside_arizona_window_no_catch_up"]));
      }
      const began = Date.now(), expiresAt = new Date(Math.min(began + 900000, instant(p.validUntil))).toISOString();
      const scope: RecurringNotificationReadScope = freeze({ version: 1, accountId: p.accountId, locationId: p.locationId,
        reviewRef: saved.sourceRef, expiresAt, identityCoveragePolicy: { accountId: p.accountId, reviewRef: saved.sourceRef,
          reviewedAt: new Date(began).toISOString(), expiresAt, quarantine: structuredClone(p.quarantine) } });
      const { inspectRecurringReadScope } = notificationModuleFunctions(await import("./notification-recurring-coordinator"),
        ["inspectRecurringReadScope"]);
      if (!bootstrap || inspectRecurringReadScope(scope).length || scope.accountId !== p.accountId || scope.locationId !== p.locationId)
        return freeze(result("held", ["matching_current_read_scope_and_runtime_required"]));
      const started = Date.now(), wall = performance.now(), deadline = Math.min(started + 300000, instant(scope.expiresAt), instant(p.validUntil));
      const check = () => {
        owned(policyHandle, mode);
        if (stopped || Date.now() < started || Date.now() >= deadline || performance.now() - wall >= 300000)
          throw new Error("Original batch deadline expired; no renewal");
      };
      async function execute() {
        check(); const r = await bootstrap!(scope); check();
        if (r.accountId !== p.accountId || r.locationId !== p.locationId) throw new Error("Runtime scope mismatch");
        const verify = () => { check(); r.verifyActiveHolds(); };
        const guard = <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A): R => { verify(); return fn(...args); };
        const inventoryIO: NotificationInventoryIO = { locationId: guard(r.inventoryIO.locationId.bind(r.inventoryIO)),
          tokenExpiresAt: guard(r.inventoryIO.tokenExpiresAt.bind(r.inventoryIO)), query: guard(r.inventoryIO.query.bind(r.inventoryIO)) };
        const sourceIO: NotificationRecurringSourceIO = { locationId: guard(r.sourceIO.locationId.bind(r.sourceIO)),
          query: async <T = any>(statement: string, variables?: Record<string, any>, readOptions?: Readonly<{ deadlineAt?: number }>): Promise<T> => {
            verify(); const value = await r.sourceIO.query<T>(statement, variables,
              { deadlineAt: Math.min(deadline, readOptions?.deadlineAt ?? Infinity) }); verify(); return value;
          },
          customers: guard(r.sourceIO.customers.bind(r.sourceIO)), contacts: guard(r.sourceIO.contacts.bind(r.sourceIO)),
          customer: guard(r.sourceIO.customer.bind(r.sourceIO)), contact: guard(r.sourceIO.contact.bind(r.sourceIO)),
          quarantineCounts: guard(r.sourceIO.quarantineCounts.bind(r.sourceIO)), storedInvoices: guard(r.sourceIO.storedInvoices.bind(r.sourceIO)) };
        const database: NotificationLedgerDatabase = { transaction: work => {
          verify(); return r.database.transaction(tx => work({ query: (sql, values) => {
            verify();
            if (mode === "read-only" && !/^\/\*[^]*?\*\/\s*SELECT\b/.test(sql)) throw new Error("Read-only database");
            if (sql.startsWith("/* notification-ledger:reserve */")) {
              if (output.admissionAttempts >= p.maximumAdmissionsPerRun) throw new Error("Standing action limit");
              output.admissionAttempts++; // Burn before IO/acknowledgment, including ambiguity.
            }
            return tx.query(sql, values);
          } }));
        } };
        const fetcher: typeof fetch = (url, init) => {
          verify();
          if (init?.method === "POST") {
            if (mode !== "attempt" || String(url) !== "https://services.leadconnectorhq.com/conversations/messages" ||
                output.messageAttempts >= p.maximumAdmissionsPerRun) throw new Error("Standing action boundary");
            output.messageAttempts++;
          } else if (init?.method !== "GET") throw new Error("Unexpected service HTTP operation");
          return r.fetch(url, init);
        };
        /** One read-only Jobber read for this invoice's live client-hub link. */
        const readInvoiceLink = async (invoiceId: string): Promise<string> => {
          verify();
          const data: any = await sourceIO.query(DAY15_EMAIL_INVOICE_LINK_QUERY, { invoiceId });
          // Account-pinned like every other source read: a link read that did not
          // confirm the account could describe another Jobber account's invoice.
          if (data?.account?.id !== p.accountId) throw new Error("Day15 email invoice link account changed or unavailable");
          const invoice = data?.invoice;
          if (!invoice || invoice.id !== invoiceId) throw new Error("Day15 email invoice link identity mismatch");
          const url = invoice.clientHubUri;
          if (typeof url !== "string" || !CLIENT_HUB.test(url)) throw new Error("Day15 email invoice link shape unverified");
          verify(); return url;
        };
        const { readNotificationInventory, inspectNotificationInventory, planNotificationInventory, readDiscoveredNotificationSource } =
          notificationModuleFunctions(await import("./notification-inventory"),
            ["readNotificationInventory", "inspectNotificationInventory", "planNotificationInventory", "readDiscoveredNotificationSource"]);
        const { readNotificationSourceBatch, inspectNotificationSourceDestinations, inspectRecurringNotificationSource } =
          notificationModuleFunctions(await import("./notification-source"),
            ["readNotificationSourceBatch", "inspectNotificationSourceDestinations", "inspectRecurringNotificationSource"]);
        const inventory = await readNotificationInventory({ ...scope, expiresAt: new Date(deadline).toISOString() }, inventoryIO);
        const scan = inspectNotificationInventory(inventory);
        output.invoices = scan.rows.map((_, i) => ({ ordinal: i + 1, result: null, holds: ["not_current_day15"] }));
        if (scan.coverage !== "complete-account-invoices") { output.state = "held"; output.reasons = [...scan.holds]; return; }
        const batch = await readNotificationSourceBatch(scope.identityCoveragePolicy, sourceIO);
        const plan = planNotificationInventory(inventory, batch);
        if (plan.holds.length || plan.worklist.batchHolds.length) {
          output.state = "held"; output.reasons = [...plan.holds, ...plan.worklist.batchHolds]; return;
        }
        // Only this service's own milestone, and only today's window. No catch-up.
        const current = plan.worklist.homeowner.filter(item => item.dayPastDue === 15 && item.timing === "current_window");
        // The planner's contact-day conflict spans every milestone it enumerates, most of
        // which this service does not implement. Recompute it over THIS service's real
        // candidates only, so an unimplemented milestone cannot hold a genuine Day 15.
        // Two separate invoices for one customer on one day still hold: each keeps its
        // own ledger event, but combined customer copy is not approved, so neither is
        // silently chosen and neither is silently dropped.
        const due = current.map(item => ({ ...item, planningHolds: [
          ...item.planningHolds.filter(hold => hold !== "homeowner_contact_day_conflict"),
          ...(current.filter(other => other.homeownerContactId === item.homeownerContactId &&
            other.scheduledOn === item.scheduledOn).length > 1
            ? ["same_contact_two_invoices_same_day_copy_not_approved"] : []),
        ] }));
        const dueIds = new Set(due.map(item => item.invoiceId));
        output.invoices = output.invoices.map((row, i) => dueIds.has(scan.rows[i].invoiceId)
          ? { ...row, holds: ["day15_not_evaluated_before_batch_stopped_no_retry"] } : row);
        if (due.filter(item => !item.planningHolds.length).length > p.maximumAdmissionsPerRun) {
          output.state = "held"; output.reasons = ["current_cohort_exceeds_action_limit_no_subset_selected"]; return;
        }
        for (const item of due) {
          check(); const ordinal = scan.rows.findIndex(row => row.invoiceId === item.invoiceId) + 1;
          const write = (value: RecurringDay15EmailResult["invoices"][number]) => {
            output.invoices = output.invoices.map(row => row.ordinal === ordinal ? value : row);
          };
          if (item.planningHolds.length) { write({ ordinal, result: null, holds: item.planningHolds }); continue; }
          try {
            const source = await readDiscoveredNotificationSource(inventory, batch, item.invoiceId);
            let renderedBody: string | null = null;
            const dependencies: NotificationRunnerDependencies = {
              recurringSource: source, database,
              contact: { fetch: fetcher, credential: r.credential, accountId: p.accountId, locationId: p.locationId, scopes: ["contacts.readonly"] },
              transport: { fetch: fetcher, credential: r.credential, accountId: p.accountId, locationId: p.locationId, scopes: ["conversations/message.write"] },
              prepare: async (s, handle) => {
                verify(); inspectRecurringNotificationSource(handle);
                const destination = inspectNotificationSourceDestinations(handle).email;
                if (!destination || s.accountId !== p.accountId || s.locationId !== p.locationId)
                  throw new Error("Cohort email identity unavailable");
                // Live balance and live link, rendered together. A zero or paid balance
                // throws here rather than producing a message.
                const body = renderDay15EmailBody(p.template.body,
                  { balanceMinor: s.balanceMinor, currency: p.currency }, await readInvoiceLink(s.invoiceId));
                renderedBody = body;
                const event: Event = immutableEvent({ accountId: s.accountId, invoiceId: s.invoiceId, ownerId: s.ownerId,
                  homeownerContactId: s.homeownerContactId, sourceRevision: s.sourceRevision, ownerRevision: s.ownerRevision,
                  issuedDate: s.issuedDate, dueDate: s.dueDate, balanceMinor: s.balanceMinor, currency: p.currency, category: null,
                  dayPastDue: 15, audience: "homeowner", recipientId: s.homeownerContactId, contactId: s.homeownerContactId,
                  channel: "email", destination, templateId: p.template.id, templateVersion: p.template.version,
                  bodyDigest: sha(body), claimedFacts: [] });
                return { event, body, contentType: "text/plain", subject: p.template.subject,
                  sender: { accountId: p.accountId, locationId: p.locationId, channel: "email" as const, sender: p.sender,
                    scope: "conversations/message.write" as const, approved: true as const, validated: true as const,
                    evidenceRef: saved.sourceRef },
                  constructionReview: { mode: "reviewed-construction-only", version: "2021-07-28", accountId: p.accountId,
                    locationId: p.locationId, channel: "email", proposedStatus: "pending", evidenceRef: saved.sourceRef } };
              },
              readExternal: async (s, event, handle) => {
                verify(); inspectRecurringNotificationSource(handle);
                if (inspectNotificationSourceDestinations(handle).email !== event.destination)
                  throw new Error("Email identity changed");
                // The balance, the dates and the link must all still describe this invoice.
                const rerendered = renderDay15EmailBody(p.template.body,
                  { balanceMinor: s.balanceMinor, currency: p.currency }, await readInvoiceLink(s.invoiceId));
                if (sha(rerendered) !== event.bodyDigest) throw new Error("Source render drift");
                const history = await readNotificationHistory({ scope: { accountId: p.accountId, locationId: p.locationId,
                  contactId: s.homeownerContactId, invoiceId: s.invoiceId, issuedDate: s.issuedDate, audience: "homeowner" },
                  reviewRef: saved.sourceRef }, {
                  accountId: p.accountId, locationId: p.locationId, now,
                  get: async req => {
                    verify();
                    if (req.method !== "GET" || req.headers.Version !== NOTIFICATION_HISTORY_CONTRACT.version)
                      throw new Error("History contract changed");
                    const response = await fetcher(req.url, { method: "GET", redirect: "error", signal: req.signal,
                      headers: { ...req.headers, Authorization: `Bearer ${r.credential}` } });
                    if (response.redirected || response.url !== req.url) throw new Error("History response location changed");
                    return { status: response.status, body: response.body };
                  }, select: (sql, values) => database.transaction(tx => tx.query(sql, values)),
                });
                const projected = projectAccessibleGhlExternalHistory(history);
                if (!projected.handle) throw new Error("Accessible history held");
                const attempts = composeAccessibleGhlExternalAttempts(projected.handle, event, now());
                if (!attempts.attempts || !attempts.requiresIndependentLocalLedgerUnion) throw new Error("History union required");
                verify();
                // Must come from this service's clock, not the wall clock: the runner
                // rejects any proof observed in its own future or older than 60s.
                const observedAt = now().toISOString();
                const proof = { observedAt,
                  expiresAt: new Date(Math.min(Date.now() + 60_000, deadline)).toISOString(),
                  sourceRef: saved.sourceRef };
                return { metadata: { ...proof, accountId: p.accountId, invoiceId: s.invoiceId, sourceRevision: s.sourceRevision,
                    currency: p.currency, category: null, categoryVerified: false },
                  recipient: { ...proof, accountId: p.accountId, recipientId: event.recipientId, contactId: event.contactId,
                    audience: "homeowner", channel: "email", destination: event.destination, exactSourceIdentity: true,
                    destinationVerified: true, internalRecipientApproved: false },
                  // feeClaimFree is asserted here only because the rendered body was just
                  // re-checked by renderDay15EmailBody, which throws on any fee wording.
                  template: { ...proof, approved: true, accountId: p.accountId, id: p.template.id, version: p.template.version,
                    bodyDigest: event.bodyDigest, audience: "homeowner", dayPastDue: 15, channel: "email",
                    claimedFacts: [], feeClaimFree: true },
                  channelAuthorization: { ...proof, approved: true, eventKey: eventKey(event), recipientId: event.recipientId,
                    channel: "email", destination: event.destination },
                  facts: [], attempts: attempts.attempts };
              },
              review: async (construction, event, binding) => {
                verify();
                if (mode !== "attempt" || !construction.request || renderedBody === null ||
                    construction.request.body.message !== renderedBody ||
                    event.bodyDigest !== sha(renderedBody) || event.channel !== "email" || binding.sender !== p.sender)
                  throw new Error("Exact standing content/action mismatch");
                const requestSha256 = sha(construction.request.serializedBody), at = Date.now();
                return { mode: "reviewed-one-attempt", event, binding,
                  sender: { accountId: p.accountId, locationId: p.locationId, channel: "email" as const, sender: p.sender,
                    scope: "conversations/message.write" as const, approved: true as const, validated: true as const,
                    evidenceRef: saved.sourceRef },
                  reviewedAt: new Date(at).toISOString(),
                  expiresAt: new Date(Math.min(at + 30000, deadline)).toISOString(),
                  statusSemantics: { verified: true, version: "2021-07-28", status: "pending", evidenceRef: saved.sourceRef },
                  content: { approved: true, requestSha256, evidenceRef: saved.sourceRef },
                  authorization: { approved: true, timingApproved: true, requestSha256, evidenceRef: saved.sourceRef } };
              },
            };
            const outcome = await createNotificationRunner({
              mode: mode === "read-only" ? "read-only-candidate" : "reviewed-one-event-candidate", dependencies }).runOne();
            write({ ordinal, result: outcome, holds: [] });
            // An uncertain send is never retried and stops the batch.
            if (outcome.state === "unknown") { output.state = "unknown"; output.reasons = ["uncertain_event_stops_batch_no_retry"]; return; }
          } catch { write({ ordinal, result: null, holds: ["exact_source_or_service_evidence_unavailable"] }); }
        }
      }
      timer = setTimeout(() => {
        stopped = true; output.state = output.admissionAttempts ? "unknown" : "held";
        output.reasons = ["batch_deadline_no_retry"];
      }, Math.max(1, deadline - Date.now()));
      await execute();
      return freeze(structuredClone(output));
    } catch {
      output.state = output.admissionAttempts ? "unknown" : "held";
      output.reasons = ["policy_scope_or_runtime_unavailable_no_retry"];
      return freeze(structuredClone(output));
    } finally { stopped = true; if (timer) clearTimeout(timer); }
  } });
}

/** Explicit deployment binding. No invocation or activation by import. */
export async function deployedRecurringDay15EmailRuntime(handle: InstalledRecurringDay15EmailPolicy,
  scope: RecurringNotificationReadScope, mode: "read-only" | "attempt" = "read-only"): Promise<RecurringDay15EmailRuntime> {
  const { policy } = owned(handle, mode);
  if (scope.accountId !== policy.accountId || scope.locationId !== policy.locationId ||
      JSON.stringify(scope.identityCoveragePolicy.quarantine) !== JSON.stringify(policy.quarantine))
    throw new Error("Runtime policy scope mismatch");
  const { bootstrapRecurringDay10Runtime } = notificationModuleFunctions(await import("./notification-recurring-runtime"),
    ["bootstrapRecurringDay10Runtime"]);
  // The same deployed runtime, with the same write and notification holds. The channel
  // lives in the policy and the event, never in the credential or the bootstrap.
  return bootstrapRecurringDay10Runtime({ ...structuredClone(scope),
    expiresAt: new Date(Math.min(instant(scope.expiresAt), instant(policy.validUntil))).toISOString() }, mode);
}
