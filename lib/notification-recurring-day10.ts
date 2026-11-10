/** Disabled service binding. No route, scheduler, environment enable switch or ambient clients. */
import { notificationModuleFunctions } from "./notification-module-interop";
import { createHash } from "node:crypto";
import { ORIGINAL_DAY10_SMS_BODY } from "./notification-copy-policy";
import { eventKey, immutableEvent, type Event } from "./notification-gate";
import { createNotificationRunner, type NotificationRunnerDependencies, type NotificationRunnerResult } from "./notification-runner";
import { createNotificationSenderReader, inspectNotificationSender, type NotificationSenderHandle } from "./notification-sender";
import { readNotificationHistory, projectAccessibleGhlExternalHistory, composeAccessibleGhlExternalAttempts,
  NOTIFICATION_HISTORY_CONTRACT } from "./notification-history";
import type { RecurringNotificationReadScope } from "./notification-recurring-coordinator";
import type { NotificationInventoryIO } from "./notification-inventory";
import type { NotificationRecurringSourceIO } from "./notification-source";
import type { NotificationLedgerDatabase } from "./notification-ledger";

/** Install only from authenticated application/operator configuration, NOT request JSON.
 * Installation is the privileged authorization boundary. Shape/hash checks below establish
 * integrity, not the caller's authority. No approved:true or arbitrary reference grants it.
 * This standing cohort policy replaces manual invoice/destination approval files. */
export type RecurringDay10Policy = Readonly<{
  accountId: string; locationId: string; validFrom: string; validUntil: string;
  cohort: "source-verified-open-homeowner-invoices";
  quarantine: RecurringNotificationReadScope["identityCoveragePolicy"]["quarantine"];
  template: Readonly<{ id: string; version: string; body: typeof ORIGINAL_DAY10_SMS_BODY }>;
  sender: string;
  nativeSms: Readonly<{ version: "2021-07-28"; status: "pending"; receiptSource: "app"; suffix: string }>;
  channel: "sms"; dayPastDue: 10; timeZone: "America/Phoenix"; window: "[09:00:00,09:15:00)";
  missed: "no-catch-up"; maximumAdmissionsPerRun: number;
  action: "read-only" | "attempt";
}>;
declare const policyBrand: unique symbol;
export type InstalledRecurringDay10Policy = Readonly<{ [policyBrand]: true }>;
const policies = new WeakMap<InstalledRecurringDay10Policy, { policy: RecurringDay10Policy; sourceRef: string }>();
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const now = () => new Date(Date.now());
const text = (x: unknown): x is string => typeof x === "string" && !!x && x.length <= 256 && x.trim() === x && !/[\x00-\x1f\x7f]/.test(x);
const instant = (x: unknown) => typeof x === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x) &&
  Number.isFinite(Date.parse(x)) && new Date(Date.parse(x)).toISOString() === x ? Date.parse(x) : NaN;
const freeze = <T>(x: T): T => { if (x && typeof x === "object") { Object.values(x).forEach(freeze); Object.freeze(x); } return x; };
const exact = (x: unknown, keys: string[]) => !!x && typeof x === "object" && !Array.isArray(x) &&
  Object.keys(x).length === keys.length && Object.keys(x).every(k => keys.includes(k));
export function installRecurringDay10Policy(input: RecurringDay10Policy): InstalledRecurringDay10Policy {
  const p = structuredClone(input);
  if (!exact(p, ["accountId", "locationId", "validFrom", "validUntil", "cohort", "quarantine", "template", "sender", "nativeSms", "channel", "dayPastDue", "timeZone", "window", "missed", "maximumAdmissionsPerRun", "action"]) ||
      ![p.accountId, p.locationId].every(text) || !(instant(p.validFrom) <= Date.now() && Date.now() < instant(p.validUntil)) ||
      p.cohort !== "source-verified-open-homeowner-invoices" ||
      !Array.isArray(p.quarantine) || p.quarantine.length !== 2 || new Set(p.quarantine.map(q => q.jobberClientId)).size !== 2 ||
      p.quarantine.some(q => !exact(q, ["jobberClientId", "email", "phone"]) || !text(q.jobberClientId) ||
        !(q.email === null || text(q.email)) || !(q.phone === null || text(q.phone))) ||
      !exact(p.template, ["id", "version", "body"]) || ![p.template.id, p.template.version].every(text) || p.template.body !== ORIGINAL_DAY10_SMS_BODY ||
      !/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(p.sender) || !exact(p.nativeSms, ["version", "status", "receiptSource", "suffix"]) ||
      p.nativeSms.version !== "2021-07-28" || p.nativeSms.status !== "pending" || p.nativeSms.receiptSource !== "app" ||
      typeof p.nativeSms.suffix !== "string" || !p.nativeSms.suffix.trim() || p.nativeSms.suffix.length > 4096 || p.nativeSms.suffix.includes("\0") ||
      p.channel !== "sms" || p.dayPastDue !== 10 || p.timeZone !== "America/Phoenix" || p.window !== "[09:00:00,09:15:00)" || p.missed !== "no-catch-up" ||
      !Number.isSafeInteger(p.maximumAdmissionsPerRun) || p.maximumAdmissionsPerRun < 1 || p.maximumAdmissionsPerRun > 1000 ||
      !["read-only", "attempt"].includes(p.action)) throw new Error("Invalid standing Day10 service policy");
  const handle = Object.freeze({}) as InstalledRecurringDay10Policy;
  policies.set(handle, { policy: freeze(p), sourceRef: `standing-day10-policy:${sha(JSON.stringify(p))}` });
  return handle;
}
function owned(handle: InstalledRecurringDay10Policy | undefined, mode: "read-only" | "attempt") {
  const saved = handle && policies.get(handle), at = Date.now();
  if (!saved || at < instant(saved.policy.validFrom) || at >= instant(saved.policy.validUntil) ||
      mode === "attempt" && saved.policy.action !== "attempt") throw new Error("Original current policy and action required");
  return saved;
}
export type RecurringDay10Runtime = Readonly<{
  accountId: string; locationId: string; inventoryIO: NotificationInventoryIO; sourceIO: NotificationRecurringSourceIO;
  credential: string; fetch: typeof fetch; database: NotificationLedgerDatabase;
  verifyActiveHolds(): void; close?(): Promise<void>;
}>;
export type RecurringDay10Result = Readonly<{
  state: "disabled" | "completed" | "held" | "unknown"; reasons: readonly string[];
  invoices: readonly Readonly<{ ordinal: number; result: NotificationRunnerResult | null; holds: readonly string[] }>[];
  admissionAttempts: number; messageAttempts: number; retryAllowed: false; productionCallsite: false;
}>;
const result = (state: RecurringDay10Result["state"], reasons: string[]): RecurringDay10Result => ({ state, reasons,
  invoices: [], admissionAttempts: 0, messageAttempts: 0, retryAllowed: false, productionCallsite: false });

/** Single bounded discovery -> genuine shared population -> exact v2 source -> EXISTING runner.
 * Default is an exact no-op. Read-only does real reads but cannot reserve or POST. No Email
 * fallback, later milestone execution, fee/suspension action or Angie format is introduced. */
export function createRecurringDay10Service(options: Readonly<{
  mode?: "read-only" | "attempt"; policy?: InstalledRecurringDay10Policy;
  runtime?: (scope: RecurringNotificationReadScope) => Promise<RecurringDay10Runtime>;
}> = {}) {
  const mode = options.mode, enabled = mode === "read-only" || mode === "attempt";
  const policyHandle = enabled ? options.policy : undefined, bootstrap = enabled ? options.runtime : undefined;
  let used = false;
  return Object.freeze({ async run(): Promise<RecurringDay10Result> {
    if (!enabled) return freeze(result("disabled", ["recurring_day10_disabled"]));
    if (used) return freeze(result("held", ["service_consumed_no_retry"]));
    used = true;
    const output = result("completed", []) as { -readonly [K in keyof RecurringDay10Result]: RecurringDay10Result[K] };
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const saved = owned(policyHandle, mode), p = saved.policy;
      if (mode === "attempt") {
        const local = new Intl.DateTimeFormat("en-GB", { timeZone: p.timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(now());
        if (local < "09:00" || local >= "09:15") return freeze(result("held", ["outside_arizona_window_no_catch_up"]));
      }
      // A new invocation under standing policy gets a new bounded READ request. Its real
      // population reader still rechecks active/archive identities and both quarantine
      // absences/counts. This never renews an existing inventory/batch/source capability.
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
        const sourceIO: NotificationRecurringSourceIO = { locationId: guard(r.sourceIO.locationId.bind(r.sourceIO)), query: guard(r.sourceIO.query.bind(r.sourceIO)),
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
        const { readNotificationInventory, inspectNotificationInventory, planNotificationInventory, readDiscoveredNotificationSource } = notificationModuleFunctions(await import("./notification-inventory"),
          ["readNotificationInventory", "inspectNotificationInventory", "planNotificationInventory", "readDiscoveredNotificationSource"]);
        const { readNotificationSourceBatch, inspectNotificationSourceDestinations, inspectRecurringNotificationSource } = notificationModuleFunctions(await import("./notification-source"),
          ["readNotificationSourceBatch", "inspectNotificationSourceDestinations", "inspectRecurringNotificationSource"]);
        const inventory = await readNotificationInventory(scope, inventoryIO), scan = inspectNotificationInventory(inventory);
        output.invoices = scan.rows.map((_, i) => ({ ordinal: i + 1, result: null, holds: ["not_current_day10"] }));
        if (scan.coverage !== "complete-account-invoices") { output.state = "held"; output.reasons = [...scan.holds]; return; }
        const batch = await readNotificationSourceBatch(scope.identityCoveragePolicy, sourceIO);
        const plan = planNotificationInventory(inventory, batch);
        if (plan.holds.length || plan.worklist.batchHolds.length) { output.state = "held"; output.reasons = [...plan.holds, ...plan.worklist.batchHolds]; return; }
        const current = plan.worklist.homeowner.filter(item => item.dayPastDue === 10 && item.timing === "current_window");
        // The wider planner includes unimplemented milestones. Only this service's actual
        // Day10 candidates can collide here; the durable ledger still enforces contact/day.
        const due = current.map(item => ({ ...item, planningHolds: [
          ...item.planningHolds.filter(hold => hold !== "homeowner_contact_day_conflict"),
          ...(current.filter(other => other.homeownerContactId === item.homeownerContactId && other.scheduledOn === item.scheduledOn).length > 1
            ? ["homeowner_contact_day_conflict"] : []),
        ] }));
        const dueIds = new Set(due.map(item => item.invoiceId));
        output.invoices = output.invoices.map((row, i) => dueIds.has(scan.rows[i].invoiceId)
          ? { ...row, holds: ["day10_not_evaluated_before_batch_stopped_no_retry"] } : row);
        if (due.filter(item => !item.planningHolds.length).length > p.maximumAdmissionsPerRun) {
          output.state = "held"; output.reasons = ["current_cohort_exceeds_action_limit_no_subset_selected"]; return;
        }
        for (const item of due) {
          check(); const ordinal = scan.rows.findIndex(row => row.invoiceId === item.invoiceId) + 1;
          const write = (value: RecurringDay10Result["invoices"][number]) => {
            output.invoices = output.invoices.map(row => row.ordinal === ordinal ? value : row);
          };
          if (item.planningHolds.length) { write({ ordinal, result: null, holds: item.planningHolds }); continue; }
          try {
            const source = await readDiscoveredNotificationSource(inventory, batch, item.invoiceId);
            const senderReader = createNotificationSenderReader({ fetch: fetcher, credential: r.credential,
              accountId: p.accountId, locationId: p.locationId, scopes: ["phonenumbers.read"], now });
            let senderHandle: NotificationSenderHandle | null = null;
            const freshSender = async () => {
              verify(); senderHandle = (await senderReader.read({ accountId: p.accountId, locationId: p.locationId, expectedNumber: p.sender })).handle;
              const facts = senderHandle && inspectNotificationSender(senderHandle);
              if (!facts) throw new Error("Exact configured SMS sender unavailable");
              return facts;
            };
            const senderReview = () => {
              if (!senderHandle || !inspectNotificationSender(senderHandle)) throw new Error("Sender expired");
              return { accountId: p.accountId, locationId: p.locationId, channel: "sms" as const, sender: p.sender,
                scope: "conversations/message.write" as const, approved: true as const, validated: true as const, evidenceRef: saved.sourceRef };
            };
            const dependencies: NotificationRunnerDependencies = {
              recurringSource: source, database,
              contact: { fetch: fetcher, credential: r.credential, accountId: p.accountId, locationId: p.locationId, scopes: ["contacts.readonly"] },
              transport: { fetch: fetcher, credential: r.credential, accountId: p.accountId, locationId: p.locationId, scopes: ["conversations/message.write"] },
              prepare: async (s, handle) => {
                verify(); inspectRecurringNotificationSource(handle); await freshSender();
                const destination = inspectNotificationSourceDestinations(handle).sms;
                if (!destination || s.accountId !== p.accountId || s.locationId !== p.locationId) throw new Error("Cohort SMS identity unavailable");
                const event: Event = immutableEvent({ accountId: s.accountId, invoiceId: s.invoiceId, ownerId: s.ownerId,
                  homeownerContactId: s.homeownerContactId, sourceRevision: s.sourceRevision, ownerRevision: s.ownerRevision,
                  issuedDate: s.issuedDate, dueDate: s.dueDate, balanceMinor: s.balanceMinor, currency: null, category: null,
                  dayPastDue: 10, audience: "homeowner", recipientId: s.homeownerContactId, contactId: s.homeownerContactId,
                  channel: "sms", destination, templateId: p.template.id, templateVersion: p.template.version,
                  bodyDigest: sha(p.template.body), claimedFacts: [] });
                return { event, body: p.template.body, contentType: "text/plain", sender: senderReview(),
                  constructionReview: { mode: "reviewed-construction-only", version: p.nativeSms.version, accountId: p.accountId,
                    locationId: p.locationId, channel: "sms", proposedStatus: "pending", evidenceRef: saved.sourceRef },
                  smsReceiptSuffixPolicy: { mode: "reviewed-exact-native-sms-suffix", version: p.nativeSms.version, channel: "sms", source: "app",
                    accountId: p.accountId, locationId: p.locationId, sender: p.sender, suffix: p.nativeSms.suffix, evidenceRef: saved.sourceRef } };
              },
              readExternal: async (s, event, handle) => {
                verify(); inspectRecurringNotificationSource(handle);
                if (inspectNotificationSourceDestinations(handle).sms !== event.destination) throw new Error("SMS identity changed");
                const sender = await freshSender();
                const history = await readNotificationHistory({ scope: { accountId: p.accountId, locationId: p.locationId,
                  contactId: s.homeownerContactId, invoiceId: s.invoiceId, issuedDate: s.issuedDate, audience: "homeowner" }, reviewRef: saved.sourceRef }, {
                  accountId: p.accountId, locationId: p.locationId, now,
                  get: async req => {
                    verify(); if (req.method !== "GET" || req.headers.Version !== NOTIFICATION_HISTORY_CONTRACT.version) throw new Error("History contract changed");
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
                // Revalidate the installed immutable policy with this actual sender observation.
                // Hash is provenance only. No caller can inject approval fields into this adapter.
                const proof = { observedAt: sender.observedAt, expiresAt: new Date(Math.min(Date.parse(sender.expiresAt), deadline)).toISOString(), sourceRef: saved.sourceRef };
                return { metadata: { ...proof, accountId: p.accountId, invoiceId: s.invoiceId, sourceRevision: s.sourceRevision,
                  currency: null, category: null, categoryVerified: false },
                  recipient: { ...proof, accountId: p.accountId, recipientId: event.recipientId, contactId: event.contactId, audience: "homeowner",
                    channel: "sms", destination: event.destination, exactSourceIdentity: true, destinationVerified: true, internalRecipientApproved: false },
                  template: { ...proof, approved: true, accountId: p.accountId, id: p.template.id, version: p.template.version,
                    bodyDigest: sha(p.template.body), audience: "homeowner", dayPastDue: 10, channel: "sms", claimedFacts: [] },
                  channelAuthorization: { ...proof, approved: true, eventKey: eventKey(event), recipientId: event.recipientId, channel: "sms", destination: event.destination },
                  facts: [], attempts: attempts.attempts };
              },
              review: async (construction, event, binding) => {
                verify();
                if (mode !== "attempt" || !construction.request || construction.request.body.message !== p.template.body ||
                    event.bodyDigest !== sha(p.template.body) || event.channel !== "sms" || binding.sender !== p.sender)
                  throw new Error("Exact standing content/action mismatch");
                const requestSha256 = sha(construction.request.serializedBody), at = Date.now();
                return { mode: "reviewed-one-attempt", event, binding, sender: senderReview(), reviewedAt: new Date(at).toISOString(),
                  expiresAt: new Date(Math.min(at + 30000, deadline)).toISOString(),
                  statusSemantics: { verified: true, version: p.nativeSms.version, status: "pending", evidenceRef: saved.sourceRef },
                  content: { approved: true, requestSha256, evidenceRef: saved.sourceRef },
                  authorization: { approved: true, timingApproved: true, requestSha256, evidenceRef: saved.sourceRef } };
              },
            };
            const outcome = await createNotificationRunner({ mode: mode === "read-only" ? "read-only-candidate" : "reviewed-one-event-candidate", dependencies }).runOne();
            write({ ordinal, result: outcome, holds: [] });
            if (outcome.state === "unknown") { output.state = "unknown"; output.reasons = ["uncertain_event_stops_batch_no_retry"]; return; }
          } catch { write({ ordinal, result: null, holds: ["exact_source_or_service_evidence_unavailable"] }); }
        }
      }
      // The admitted cron owner must not be released while an operation is unsettled.
      // Timeout stops future IO; bounded source/contact/history/transport/DB adapters drain.
      // Do not Promise.race-return over a possibly in-flight reservation or provider POST.
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

/** Explicit deployment binding, no invocation or activation by import. Validates the ORIGINAL
 * installed service policy before credential acquisition. Read scope is still read authority. */
export async function deployedRecurringDay10Runtime(handle: InstalledRecurringDay10Policy, scope: RecurringNotificationReadScope,
  mode: "read-only" | "attempt" = "read-only"): Promise<RecurringDay10Runtime> {
  const { policy } = owned(handle, mode);
  if (scope.accountId !== policy.accountId || scope.locationId !== policy.locationId ||
      JSON.stringify(scope.identityCoveragePolicy.quarantine) !== JSON.stringify(policy.quarantine)) throw new Error("Runtime policy scope mismatch");
  const { bootstrapRecurringDay10Runtime } = notificationModuleFunctions(await import("./notification-recurring-runtime"),
    ["bootstrapRecurringDay10Runtime"]);
  return bootstrapRecurringDay10Runtime({ ...structuredClone(scope), expiresAt: new Date(Math.min(instant(scope.expiresAt), instant(policy.validUntil))).toISOString() }, mode);
}
