/** Disabled pure planning over supplied invoice rows. No source capability, approval, IO or dispatch. */
import { invoiceCalendarDate, invoiceReminderClock, invoiceReminderMilestones,
  type InvoiceReminderCategory } from "./invoice-reminder-clock";
import { eventKey, PROPOSAL, type Fact } from "./notification-gate";

export const NOTIFICATION_WORKLIST_LIMIT = 1000;
export type NotificationWorklistTagSnapshot = Readonly<{
  kind: "complete-ghl-contact-tags"; accountId: string; locationId: string; contactId: string;
  tags: readonly string[]; observedAt: string; expiresAt: string; sourceRef: string;
}>;
export type NotificationWorklistInvoice = Readonly<{
  accountId: string; locationId: string; invoiceId: string; ownerId: string; homeownerContactId: string | null;
  issuedDate: string | null; dueDate: string | null;
  status: "open" | "paid" | "void" | "unknown"; balanceMinor: number;
  /** Supplied reader snapshot, not a capability minted by this planner. No product taxonomy. */
  contactTags: NotificationWorklistTagSnapshot | null;
}>;
export type NotificationWorklistTiming = "future" | "waiting_for_09" | "current_window" | "past_reconcile" | "missed_no_catch_up";
export type NotificationWorklistItem = Readonly<{
  eventKey: string; accountId: string; locationId: string; invoiceId: string; ownerId: string; homeownerContactId: string | null;
  dayPastDue: number; audience: "homeowner" | "internal"; scheduledOn: string;
  targetLocalTime: "09:00:00"; timeZone: "America/Phoenix"; timing: NotificationWorklistTiming;
  category: InvoiceReminderCategory | null; categoryNotes: readonly string[]; requiredFacts: readonly Fact[];
  planningHolds: readonly string[]; runtimeChecks: readonly string[];
  copyStatus: "bind_existing_day10_authorization" | "conditional_copy_unapproved" | "digest_copy_unapproved";
  dispatchEligible: false;
}>;
export type NotificationInternalDigestPlan = Readonly<{
  digestKey: string; accountId: string; locationId: string; scheduledOn: string; targetLocalTime: "09:00:00";
  timeZone: "America/Phoenix"; recipientRole: "angie"; timing: NotificationWorklistTiming;
  /** Every independently keyed Day21 invoice is retained. No first/last selection or aggregation of proof. */
  members: readonly NotificationWorklistItem[];
  templateApproval: "unresolved"; dispatchEligible: false;
  runtimeChecks: readonly string[];
}>;
export type NotificationWorklist = Readonly<{
  mode: "disabled-planning-only"; coverage: "supplied-invoices-only"; plannedAt: string | null;
  invoiceCount: number; batchHolds: readonly string[];
  invoiceHolds: readonly Readonly<{ inputIndex: number; accountId: string | null; invoiceId: string | null; reason: string }>[];
  homeowner: readonly NotificationWorklistItem[]; internalDigests: readonly NotificationInternalDigestPlan[];
  contactDayConflicts: readonly Readonly<{ accountId: string; locationId: string; contactId: string; scheduledOn: string; eventKeys: readonly string[] }>[];
  dispatchEligible: false; sourceCoverageVerified: false;
}>;
const runtimeChecks = Object.freeze(["fresh_exact_source_invoice_and_owner", "positive_unchanged_balance_and_source_dates",
  "fresh_exact_recipient_and_channel_dnd", "complete_supported_history_and_local_ledger_union",
  "recurring_recipient_content_and_action_authorization", "original_owned_reservation_and_final_reread"]);
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 &&
  value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
const timeFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Phoenix", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
function branch(invoice: NotificationWorklistInvoice, at: number): { category: InvoiceReminderCategory | null; notes: string[] } {
  const snapshot = invoice.contactTags;
  if (!snapshot) return { category: null, notes: ["contact_tag_snapshot_missing"] };
  const instant = (value: unknown) => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value ? Date.parse(value) : NaN;
  const observed = instant(snapshot.observedAt), expires = instant(snapshot.expiresAt);
  if (snapshot.kind !== "complete-ghl-contact-tags" || snapshot.accountId !== invoice.accountId ||
      snapshot.locationId !== invoice.locationId || snapshot.contactId !== invoice.homeownerContactId || !id(snapshot.sourceRef) ||
      !Number.isFinite(observed) || !Number.isFinite(expires) || observed > at || at >= expires ||
      at - observed >= 60_000 || expires <= observed || !Array.isArray(snapshot.tags) || snapshot.tags.length > 1000 ||
      snapshot.tags.some(tag => !id(tag))) return { category: null, notes: ["contact_tag_snapshot_unverified"] };
  if (snapshot.tags.some(tag => tag.toLowerCase() === "irrigation" && tag !== "irrigation"))
    return { category: null, notes: ["contact_tag_case_semantics_unverified"] };
  // Preserve the inspected workflow rule: exact irrigation tag wins; verified absence
  // takes the existing other/maintenance branch. A second label does not invent a new taxonomy.
  const irrigation = snapshot.tags.includes("irrigation");
  return { category: irrigation ? "irrigation" : "maintenance",
    notes: irrigation && snapshot.tags.includes("maintenance") ? ["mixed_labels_exact_irrigation_rule_retained"] : [] };
}
function timing(scheduledOn: string, today: string, seconds: number): NotificationWorklistTiming {
  if (scheduledOn < today) return "past_reconcile";
  if (scheduledOn > today) return "future";
  if (seconds < 9 * 3600) return "waiting_for_09";
  // Reuse the existing gate boundary; this planner does not grant new timing approval.
  return seconds < 9 * 3600 + PROPOSAL.toleranceMinutes * 60 ? "current_window" : "missed_no_catch_up";
}
function blank(count: number, reason: string): NotificationWorklist {
  return freeze({ mode: "disabled-planning-only", coverage: "supplied-invoices-only", plannedAt: null,
    invoiceCount: count, batchHolds: [reason], invoiceHolds: [], homeowner: [], internalDigests: [], contactDayConflicts: [],
    dispatchEligible: false, sourceCoverageVerified: false });
}

/** Pure bounded inventory, NOT an Event/Evidence factory. Future/past entries remain visible,
 * but nothing here may reserve, send, apply fees, suspend service or revive retired workflows.
 * Recurring policy can cover a cohort; this function creates no per-invoice approval requirement. */
export function planNotificationWorklist(invoices: readonly NotificationWorklistInvoice[], now: Date): NotificationWorklist {
  if (!Array.isArray(invoices) || invoices.length > NOTIFICATION_WORKLIST_LIMIT)
    return blank(Array.isArray(invoices) ? invoices.length : 0, "invoice_input_limit_or_shape");
  const at = now instanceof Date ? now.getTime() : NaN, today = Number.isFinite(at) ? invoiceCalendarDate(now) : null;
  if (!today) return blank(invoices.length, "invalid_now");
  const parts = timeFormat.formatToParts(now), part = (name: string) => Number(parts.find(p => p.type === name)!.value);
  const seconds = part("hour") * 3600 + part("minute") * 60 + part("second");
  const counts = new Map<string, number>();
  for (const invoice of invoices) if (id(invoice?.accountId) && id(invoice?.invoiceId)) {
    const key = JSON.stringify([invoice.accountId, invoice.invoiceId]); counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const held: { inputIndex: number; accountId: string | null; invoiceId: string | null; reason: string }[] = [];
  const items: NotificationWorklistItem[] = [];
  invoices.forEach((invoice, inputIndex) => {
    const hold = (reason: string) => held.push({ inputIndex, accountId: id(invoice?.accountId) ? invoice.accountId : null,
      invoiceId: id(invoice?.invoiceId) ? invoice.invoiceId : null, reason });
    if (!invoice || ![invoice.accountId, invoice.locationId, invoice.invoiceId, invoice.ownerId].every(id) ||
        !(invoice.homeownerContactId === null || id(invoice.homeownerContactId))) { hold("invalid_invoice_planning_fields"); return; }
    if (counts.get(JSON.stringify([invoice.accountId, invoice.invoiceId])) !== 1) { hold("duplicate_or_conflicting_source_invoice"); return; }
    if (!Number.isSafeInteger(invoice.balanceMinor) || invoice.balanceMinor < 0) { hold("invalid_source_balance"); return; }
    if (invoice.status !== "open" || invoice.balanceMinor === 0) {
      hold(invoice.status === "paid" && invoice.balanceMinor === 0 ? "paid_zero_balance_no_reminder" :
        invoice.status === "void" ? "void_no_reminder" : "source_not_open_positive_balance"); return;
    }
    const clock = invoiceReminderClock(invoice.issuedDate, invoice.dueDate, now);
    if (!clock) { hold("invalid_or_missing_source_dates"); return; }
    // Unknown category retains all common work and visibly holds maintenance-only possibilities.
    // Choosing maintenance here enumerates possibilities; it NEVER supplies a category proof.
    const classification = branch(invoice, at);
    const steps = invoiceReminderMilestones(classification.category ?? "maintenance", invoice.issuedDate, invoice.dueDate, now)!;
    for (const step of steps) {
      const maintenanceOnly = [20, 25, 30].includes(step.dayPastDue);
      const planningHolds = [
        ...(maintenanceOnly && classification.category === null ? ["maintenance_contact_tag_branch_unresolved"] : []),
        ...(step.audience === "homeowner" && invoice.homeownerContactId === null ? ["homeowner_contact_unresolved"] : []),
      ];
      const item: NotificationWorklistItem = {
        eventKey: eventKey({ accountId: invoice.accountId, invoiceId: invoice.invoiceId, dayPastDue: step.dayPastDue, audience: step.audience }),
        accountId: invoice.accountId, locationId: invoice.locationId, invoiceId: invoice.invoiceId, ownerId: invoice.ownerId,
        homeownerContactId: invoice.homeownerContactId, dayPastDue: step.dayPastDue, audience: step.audience,
        scheduledOn: step.scheduledOn, targetLocalTime: "09:00:00", timeZone: "America/Phoenix",
        timing: timing(step.scheduledOn, today, seconds), category: classification.category, categoryNotes: classification.notes, requiredFacts: [...step.requiredFacts], planningHolds,
        runtimeChecks: [...runtimeChecks, ...(maintenanceOnly ? ["fresh_verified_contact_tag_branch"] : []),
          ...(step.requiredFacts.length ? ["fresh_invoice_bound_effect_or_policy_evidence", "conditional_template_authorization"] : [])],
        copyStatus: step.audience === "internal" ? "digest_copy_unapproved" : step.dayPastDue === 10
          ? "bind_existing_day10_authorization" : "conditional_copy_unapproved",
        dispatchEligible: false,
      };
      items.push(item);
    }
  });
  const sort = (a: NotificationWorklistItem, b: NotificationWorklistItem) =>
    a.accountId.localeCompare(b.accountId) || a.scheduledOn.localeCompare(b.scheduledOn) || a.eventKey.localeCompare(b.eventKey);
  items.sort(sort);
  const homeowner = items.filter(item => item.audience === "homeowner"), groups = new Map<string, NotificationWorklistItem[]>();
  for (const item of items.filter(item => item.audience === "internal")) {
    const key = JSON.stringify(["notification-internal-digest-v1", item.accountId, item.locationId, item.scheduledOn, "angie"]);
    const members = groups.get(key) ?? []; members.push(item); groups.set(key, members);
  }
  const internalDigests: NotificationInternalDigestPlan[] = [...groups].map(([digestKey, members]) => ({
    digestKey, accountId: members[0].accountId, locationId: members[0].locationId, scheduledOn: members[0].scheduledOn,
    targetLocalTime: "09:00:00", timeZone: "America/Phoenix", recipientRole: "angie", timing: members[0].timing,
    members, templateApproval: "unresolved", dispatchEligible: false,
    runtimeChecks: ["existing_approved_angie_recipient_binding", "daily_digest_template_authorization",
      "recheck_each_member_independently_before_inclusion", "durably_claim_digest_and_every_member_without_partial_replay",
      "preserve_member_history_on_unknown_digest_outcome", "fresh_internal_recipient_dnd_and_final_digest_body_binding"],
  }));
  const contacts = new Map<string, NotificationWorklistItem[]>();
  for (const item of homeowner) if (item.homeownerContactId) {
    const key = JSON.stringify([item.accountId, item.locationId, item.homeownerContactId, item.scheduledOn]);
    const group = contacts.get(key) ?? []; group.push(item); contacts.set(key, group);
  }
  const contactDayConflicts = [...contacts.values()].filter(group => group.length > 1).map(group => ({
    accountId: group[0].accountId, locationId: group[0].locationId, contactId: group[0].homeownerContactId!, scheduledOn: group[0].scheduledOn,
    eventKeys: group.map(item => item.eventKey),
  }));
  // Do not silently choose a homeowner invoice or combine unapproved customer copy.
  const conflicting = new Set(contactDayConflicts.flatMap(group => group.eventKeys));
  const finalHomeowner = homeowner.map(item => conflicting.has(item.eventKey)
    ? { ...item, planningHolds: [...item.planningHolds, "homeowner_contact_day_conflict"] } : item);
  return freeze({ mode: "disabled-planning-only", coverage: "supplied-invoices-only", plannedAt: new Date(at).toISOString(),
    invoiceCount: invoices.length, batchHolds: [], invoiceHolds: held, homeowner: finalHomeowner, internalDigests,
    contactDayConflicts, dispatchEligible: false, sourceCoverageVerified: false });
}
