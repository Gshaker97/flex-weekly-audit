/** Explicit READ-ONLY orchestration. Import/default run never initializes application clients. */
import { notificationModuleFunctions } from "./notification-module-interop";
import type { ReviewedOmissionPolicy } from "./ghl-identity-coverage";
import type { NotificationInventoryIO } from "./notification-inventory";
import type { NotificationRecurringSourceIO } from "./notification-source";
import type { NotificationHistoryIO } from "./notification-history";
import type { GhlReadOnlyOptions } from "./notification-ghl-contract";
import type { NotificationWorklistItem, NotificationWorklistTiming } from "./notification-worklist";

export type RecurringNotificationReadScope = Readonly<{
  version: 1; accountId: string; locationId: string; reviewRef: string; expiresAt: string;
  identityCoveragePolicy: ReviewedOmissionPolicy;
}>;
/** Authenticated application dependencies, never browser/request JSON. Scope review identifies
 * the authorized READ, not message authorization. No send/refresh/reserve hook exists here. */
export type RecurringNotificationReadRuntime = Readonly<{
  accountId: string; locationId: string; inventoryIO: NotificationInventoryIO; sourceIO: NotificationRecurringSourceIO;
  contact: Omit<GhlReadOnlyOptions, "now">; history: Omit<NotificationHistoryIO, "now">;
  verifyActiveHolds(): void;
  /** Standalone operator cleanup only; application callers retain their own connection lifetime. */
  close?(): Promise<void>;
}>;
export type RecurringChannelReport = Readonly<{
  primary: "verified_matching_primary" | "unavailable";
  dnd: "allowed" | "blocked" | "held" | "not_evaluated";
  suppression: "observed_suppression" | "no_suppression_in_verified_fields" | "unknown_not_observed_opt_out";
  history: "bounded_accessible_and_local_checked" | "attribution_unresolved_not_proof_of_reminder" | "held" | "not_evaluated";
  readEligibility: "checks_passed_at_observation" | "held" | "not_evaluated";
  holds: readonly string[];
  transportReadiness: "existing_sms_runner_requires_service_policy" | "email_transport_not_live_verified";
}>;
export type RecurringInvoiceReport = Readonly<{
  invoiceOrdinal: number; source: "verified_at_observation" | "held" | "excluded";
  holds: readonly string[];
  milestones: readonly Readonly<{
    dayPastDue: number; audience: "homeowner" | "internal"; timing: NotificationWorklistTiming;
    category: "irrigation" | "maintenance" | null; planningHolds: readonly string[];
    priorAttempt: boolean | null; readHolds: readonly string[]; executionHolds: readonly string[]; copyStatus: NotificationWorklistItem["copyStatus"];
  }>[];
  channels: Readonly<{ sms: RecurringChannelReport; email: RecurringChannelReport }>;
  observedAt: string | null; freshUntil: string | null;
}>;
export type RecurringNotificationReport = Readonly<{
  state: "disabled" | "read_only_report" | "held"; holds: readonly string[];
  inventory: Readonly<{ coverage: "not_read" | "exhausted-query-result" | "partial-held"; pages: number; invoices: number;
    defaultStatusScope: "unverified"; cacheOnlyInvoiceCount: null; cacheOnlyEligibility: "unknown_not_evaluated" }>;
  invoices: readonly RecurringInvoiceReport[];
  internalDigests: readonly Readonly<{ digestOrdinal: number; timing: NotificationWorklistTiming; invoiceOrdinals: readonly number[];
    holds: readonly string[] }>[];
  observedAt: string | null; completedAt: string | null; durationMs: number;
  sendCapable: false; rolloutReady: false; reservationsCreated: 0; attempts: 0;
  messagePolicyAdmission: "not_evaluated";
}>;
const freeze = <T>(x: T): T => { if (x && typeof x === "object") { Object.values(x).forEach(freeze); Object.freeze(x); } return x; };
const validId = (x: unknown): x is string => typeof x === "string" && !!x && x.length <= 256 && x.trim() === x && !/[\x00-\x1f\x7f]/.test(x);
const instant = (x: unknown) => typeof x === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x) &&
  Number.isFinite(Date.parse(x)) && new Date(Date.parse(x)).toISOString() === x ? Date.parse(x) : NaN;
/** Static read-scope inspection. A successful shape check is not authorization to read or send. */
export function inspectRecurringReadScope(scope: unknown): readonly string[] {
  const missing: string[] = [];
  try {
    const s = scope as RecurringNotificationReadScope, p = s.identityCoveragePolicy, at = Date.now();
    const exact = (x: unknown, keys: string[]) => !!x && typeof x === "object" && !Array.isArray(x) &&
      Object.keys(x).length === keys.length && Object.keys(x).every(key => keys.includes(key));
    if (!exact(s, ["version", "accountId", "locationId", "reviewRef", "expiresAt", "identityCoveragePolicy"]) ||
        s.version !== 1 || ![s.accountId, s.locationId, s.reviewRef].every(validId)) missing.push("exact_account_location_read_scope");
    if (!(instant(s.expiresAt) > at)) missing.push("current_finite_read_scope_expiry");
    if (!exact(p, ["accountId", "reviewRef", "reviewedAt", "expiresAt", "quarantine"]) || p.accountId !== s.accountId ||
        !validId(p.reviewRef) || !(instant(p.reviewedAt) <= at && at < instant(p.expiresAt))) missing.push("current_matching_omission_review");
    if (!Array.isArray(p.quarantine) || p.quarantine.length !== 2 || new Set(p.quarantine.map(q => q.jobberClientId)).size !== 2 ||
        p.quarantine.some(q => !exact(q, ["jobberClientId", "email", "phone"]) || !validId(q.jobberClientId) ||
          !(q.email === null || validId(q.email)) || !(q.phone === null || validId(q.phone)))) missing.push("exact_two_reviewed_quarantine_identities");
  } catch { missing.push("malformed_read_scope"); }
  return Object.freeze(missing);
}
export function recurringCoordinatorReadiness() {
  return freeze({ state: "disabled", runtimeAction: "read-only", productionCallsite: false,
    actualChecks: ["exhaust_unfiltered_invoice_query_default_status_scope_unverified", "real_shared_identity_population_and_quarantine", "fresh_exact_source_and_primary_destinations",
      "exact_contact_tags_existing_irrigation_branch", "real_per_channel_dnd", "accessible_history_and_local_ledger_union", "arizona_window_no_catch_up"],
    servicePolicyBoundary: ["authenticated_standing_recipient_cohort_and_milestone_scope", "approved_channel_template_and_truthful_effect_evidence",
      "explicit_sender_and_native_footer_policy", "reviewed_timing_and_action_authority"],
    remaining: ["trusted_no_refresh_runtime_and_read_scope", "bind_service_policy_to_existing_send_time_runner",
      "email_transport_live_verification", "atomic_angie_digest_member_claims_and_history", "reviewed_recurring_activation"],
    sendCapable: false, rolloutReady: false });
}
const blankChannel = (channel: "sms" | "email"): RecurringChannelReport => ({ primary: "unavailable", dnd: "not_evaluated", suppression: "unknown_not_observed_opt_out", history: "not_evaluated",
  readEligibility: "not_evaluated", holds: [], transportReadiness: channel === "sms"
    ? "existing_sms_runner_requires_service_policy" : "email_transport_not_live_verified" });
const pendingInvoice = (invoiceOrdinal: number): RecurringInvoiceReport => ({ invoiceOrdinal, source: "held",
  holds: ["invoice_not_evaluated"], milestones: [], channels: { sms: blankChannel("sms"), email: blankChannel("email") },
  observedAt: null, freshUntil: null });
const base = (state: RecurringNotificationReport["state"], holds: string[]): RecurringNotificationReport => ({ state, holds,
  inventory: { coverage: "not_read", pages: 0, invoices: 0, defaultStatusScope: "unverified", cacheOnlyInvoiceCount: null, cacheOnlyEligibility: "unknown_not_evaluated" }, invoices: [], internalDigests: [], observedAt: null, completedAt: null, durationMs: 0,
  sendCapable: false, rolloutReady: false, reservationsCreated: 0, attempts: 0, messagePolicyAdmission: "not_evaluated" });

/** Standing cohort scope, no manually enumerated invoice approvals. This reports independent
 * source/channel/history observations; it does NOT fabricate an Event or a template approval
 * to make the send-time gate pass. The existing runner still owns final admission/reservation.
 * Single-use, no automatic retry or renewal of expired population evidence. */
export function createRecurringNotificationCoordinator(options: Readonly<{
  mode?: "read-only"; scope?: RecurringNotificationReadScope;
  runtime?: () => Promise<RecurringNotificationReadRuntime>;
}> = {}) {
  const enabled = options.mode === "read-only";
  const scopeInput = enabled ? options.scope : undefined, bootstrap = enabled ? options.runtime : undefined;
  let used = false;
  return Object.freeze({ async run(): Promise<RecurringNotificationReport> {
    if (!enabled) return freeze(base("disabled", ["recurring_coordinator_disabled"]));
    if (used) return freeze(base("held", ["coordinator_already_consumed_no_retry"]));
    used = true;
    let scope: RecurringNotificationReadScope;
    try {
      scope = structuredClone(scopeInput!);
      if (inspectRecurringReadScope(scope).length || !bootstrap)
        return freeze(base("held", ["current_trusted_read_scope_and_runtime_required"]));
    } catch { return freeze(base("held", ["current_trusted_read_scope_and_runtime_required"])); }
    const started = Date.now(), wall = performance.now();
    // Bounds waiting even for stalled injected IO. Guard wrappers prevent late work from
    // initiating further reads after timeout; a malicious IO's socket cancellation is not claimed.
    const deadline = Math.min(instant(scope.expiresAt), started + 300_000);
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => { if (stopped || Date.now() < started || Date.now() >= deadline || performance.now() - wall >= 300_000)
      throw new Error("coordinator_deadline_or_scope_expired"); };
    const result = base("read_only_report", []) as { -readonly [K in keyof RecurringNotificationReport]: RecurringNotificationReport[K] };
    result.observedAt = new Date(started).toISOString();
    async function evaluate(): Promise<RecurringNotificationReport> {
      try {
        check(); const r = await bootstrap!(); check();
        if (r.accountId !== scope.accountId || r.locationId !== scope.locationId ||
            r.contact.accountId !== scope.accountId || r.contact.locationId !== scope.locationId ||
            r.history.accountId !== scope.accountId || r.history.locationId !== scope.locationId)
          throw new Error("runtime_scope_mismatch");
        const verify = () => { check(); r.verifyActiveHolds(); };
        const guard = <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A): R => { verify(); return fn(...args); };
        const inventoryIO = { locationId: guard(r.inventoryIO.locationId.bind(r.inventoryIO)),
          tokenExpiresAt: guard(r.inventoryIO.tokenExpiresAt.bind(r.inventoryIO)), query: guard(r.inventoryIO.query.bind(r.inventoryIO)) };
        const sourceIO: NotificationRecurringSourceIO = { locationId: guard(r.sourceIO.locationId.bind(r.sourceIO)),
          customers: guard(r.sourceIO.customers.bind(r.sourceIO)), contacts: guard(r.sourceIO.contacts.bind(r.sourceIO)),
          customer: guard(r.sourceIO.customer.bind(r.sourceIO)), contact: guard(r.sourceIO.contact.bind(r.sourceIO)),
          storedInvoices: guard(r.sourceIO.storedInvoices.bind(r.sourceIO)), quarantineCounts: guard(r.sourceIO.quarantineCounts.bind(r.sourceIO)),
          query: guard(r.sourceIO.query.bind(r.sourceIO)) };
        const historyIO: NotificationHistoryIO = { ...r.history, now: () => new Date(Date.now()),
          get: guard(r.history.get.bind(r.history)), select: guard(r.history.select.bind(r.history)) };
        const { readNotificationInventory, inspectNotificationInventory, planNotificationInventory, readDiscoveredNotificationSource } = notificationModuleFunctions(await import("./notification-inventory"),
          ["readNotificationInventory", "inspectNotificationInventory", "planNotificationInventory", "readDiscoveredNotificationSource"]);
        const { readNotificationSourceBatch, inspectNotificationSource, inspectNotificationSourceDestinations } = notificationModuleFunctions(await import("./notification-source"),
          ["readNotificationSourceBatch", "inspectNotificationSource", "inspectNotificationSourceDestinations"]);
        const { createGhlReadOnlyReader } = notificationModuleFunctions(await import("./notification-ghl-contract"),
          ["createGhlReadOnlyReader"]);
        const { readNotificationHistory, inspectNotificationHistory } = notificationModuleFunctions(await import("./notification-history"),
          ["readNotificationHistory", "inspectNotificationHistory"]);
        const contact = createGhlReadOnlyReader({ ...r.contact, fetch: guard(r.contact.fetch), now: () => new Date(Date.now()) });
        verify(); const inventory = await readNotificationInventory(scope, inventoryIO), scan = inspectNotificationInventory(inventory);
        result.inventory = { coverage: scan.coverage === "complete-account-invoices" ? "exhausted-query-result" : "partial-held",
          pages: scan.pages, invoices: scan.invoiceCount, defaultStatusScope: "unverified", cacheOnlyInvoiceCount: null,
          cacheOnlyEligibility: "unknown_not_evaluated" };
        // Preserve every discovered row even if population or any selected read later stalls.
        result.invoices = scan.rows.map((_, i) => pendingInvoice(i + 1));
        if (scan.coverage !== "complete-account-invoices") { result.state = "held"; result.holds = [...scan.holds]; return result; }
        verify(); const batch = await readNotificationSourceBatch(scope.identityCoveragePolicy, sourceIO);
        const initial = planNotificationInventory(inventory, batch);
        const allItems = [...initial.worklist.homeowner, ...initial.worklist.internalDigests.flatMap(d => d.members)];
        const ordinals = new Map(scan.rows.map((row, i) => [row.invoiceId, i + 1]));
        result.internalDigests = initial.worklist.internalDigests.map((d, i) => ({ digestOrdinal: i + 1, timing: d.timing,
          invoiceOrdinals: d.members.map(member => ordinals.get(member.invoiceId)!),
          holds: ["digest_copy_unapproved", "atomic_digest_member_admission_and_history_unwired", "internal_recipient_not_evaluated"] }));
        const invoices: RecurringInvoiceReport[] = [...result.invoices];
        for (const row of scan.rows) {
          let items = allItems.filter(item => item.invoiceId === row.invoiceId);
          const exclusion = initial.excluded.find(item => item.invoiceId === row.invoiceId);
          let report: RecurringInvoiceReport = { invoiceOrdinal: ordinals.get(row.invoiceId)!, source: exclusion ? "excluded" : "held",
            holds: exclusion ? [...exclusion.reasons] : [], milestones: [], channels: { sms: blankChannel("sms"), email: blankChannel("email") },
            observedAt: null, freshUntil: null };
          const milestoneReports = (records?: readonly { eventKey: string }[], absenceProven = false) => items.map(item => ({ dayPastDue: item.dayPastDue,
            audience: item.audience, timing: item.timing, category: item.category, planningHolds: [...item.planningHolds],
            priorAttempt: item.audience !== "homeowner" ? null : records?.some(record => record.eventKey === item.eventKey)
              ? true : absenceProven ? false : null,
            readHolds: [...item.planningHolds, ...(item.timing === "current_window" ? [] : [`timing_${item.timing}`]),
              ...(item.audience === "internal" ? ["internal_history_not_evaluated"] : [
                ...(records?.some(record => record.eventKey === item.eventKey) ? ["prior_attempt_no_retry"] : []),
                ...(!absenceProven ? ["history_absence_unproven"] : [])])],
            executionHolds: ["read_only_no_message_policy_admission", ...(item.copyStatus === "conditional_copy_unapproved" ? ["conditional_copy_and_effect_evidence_unapproved"] :
              item.copyStatus === "digest_copy_unapproved" ? ["digest_copy_and_atomic_member_admission_unwired"] : [])], copyStatus: item.copyStatus }));
          let failure = "fresh_source_or_required_read_unavailable";
          if (!exclusion) try {
            if (Date.now() >= Date.parse(initial.population.expiresAt)) { failure = "shared_population_expired_no_renewal"; throw new Error(failure); }
            verify();
            if (initial.holds.length || initial.worklist.batchHolds.length) { failure = "worklist_capacity_or_shape_held"; throw new Error(failure); }
            const handle = await readDiscoveredNotificationSource(inventory, batch, row.invoiceId);
            const source = inspectNotificationSource(handle), destinations = inspectNotificationSourceDestinations(handle);
            const refreshed = planNotificationInventory(inventory, batch, [handle]);
            items = [...refreshed.worklist.homeowner, ...refreshed.worklist.internalDigests.flatMap(d => d.members)]
              .filter(item => item.invoiceId === row.invoiceId);
            const currentExclusion = refreshed.worklist.invoiceHolds.find(item => item.invoiceId === row.invoiceId);
            if (currentExclusion) { failure = "fresh_source_not_open_positive_balance"; throw new Error(failure); }
            const channelResults = { sms: blankChannel("sms"), email: blankChannel("email") };
            let freshness = Date.parse(source.expiresAt);
            for (const channel of ["sms", "email"] as const) {
              const destination = destinations[channel];
              if (!destination) { channelResults[channel] = { ...channelResults[channel], readEligibility: "held", holds: ["matching_primary_destination_unavailable"] }; continue; }
              const observed = Date.now(); verify();
              const dnd = await contact.readContact({ accountId: source.accountId, locationId: source.locationId,
                contactId: source.homeownerContactId, channel, destination });
              freshness = Math.min(freshness, observed + 60_000);
              channelResults[channel] = { ...channelResults[channel], primary: "verified_matching_primary", dnd: dnd.state,
                suppression: dnd.state === "blocked" ? "observed_suppression" : dnd.state === "allowed"
                  ? "no_suppression_in_verified_fields" : "unknown_not_observed_opt_out",
                readEligibility: dnd.state === "allowed" ? "checks_passed_at_observation" : "held", holds: [...dnd.reasons] };
            }
            verify();
            const history = inspectNotificationHistory(await readNotificationHistory({ scope: { accountId: source.accountId,
              locationId: source.locationId, contactId: source.homeownerContactId, invoiceId: source.invoiceId,
              issuedDate: source.issuedDate, audience: "homeowner" }, reviewRef: scope.reviewRef }, historyIO));
            verify(); inspectNotificationSource(handle);
            freshness = Math.min(freshness, Date.parse(history.expiresAt));
            for (const channel of ["sms", "email"] as const) {
              channelResults[channel] = { ...channelResults[channel],
                history: history.state === "bounded_ready" ? "bounded_accessible_and_local_checked" :
                  history.reasons.includes("outbound_invoice_attribution_unresolved") ? "attribution_unresolved_not_proof_of_reminder" : "held",
                ...(history.state !== "bounded_ready" ? { readEligibility: "held" as const, holds: [...channelResults[channel].holds, ...history.reasons] } : {}) };
            }
            report = { ...report, source: "verified_at_observation", observedAt: source.observedAt, freshUntil: new Date(freshness).toISOString(),
              channels: channelResults, milestones: milestoneReports(history.records, history.state === "bounded_ready") };
          } catch { report = { ...report, holds: [failure] }; }
          invoices[report.invoiceOrdinal - 1] = { ...report, milestones: report.milestones.length ? report.milestones : milestoneReports() };
          result.invoices = [...invoices];
        }
        result.holds = ["provider_default_invoice_status_scope_unverified", "cache_only_source_omissions_not_reconciled",
          ...initial.holds, ...initial.worklist.batchHolds];
        result.invoices = invoices;
        return result;
      } catch {
        result.state = "held"; result.holds = [...result.holds, "inventory_population_or_runtime_unavailable"]; return result;
      }
    }
    try {
      const completed = await Promise.race([evaluate(), new Promise<RecurringNotificationReport>(resolve => {
        timer = setTimeout(() => { stopped = true; resolve({ ...result, state: "held", holds: [...result.holds, "coordinator_deadline_no_retry"],
          invoices: result.invoices.map(row => row.holds.includes("invoice_not_evaluated")
            ? { ...row, holds: ["invoice_not_evaluated_before_deadline_no_retry"] } : row) }); },
          Math.max(1, deadline - Date.now()));
      })]);
      const at = Date.now();
      return freeze({ ...completed, completedAt: new Date(at).toISOString(), durationMs: Math.max(0, at - started, Math.ceil(performance.now() - wall)), invoices: completed.invoices.map(row =>
        row.freshUntil && at >= Date.parse(row.freshUntil) ? { ...row, holds: [...row.holds, "observations_expired_before_report"],
          channels: { sms: { ...row.channels.sms, readEligibility: "held" as const }, email: { ...row.channels.email, readEligibility: "held" as const } } } : row) });
    } finally { stopped = true; if (timer) clearTimeout(timer); }
  } });
}
