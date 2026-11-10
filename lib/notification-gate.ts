/** DESIGN ONLY. Pure functions, no transport, persistence, credentials, or live adapters. */
import { permitsUnknownCurrency } from "./notification-copy-policy";
import { INVOICE_TIME_ZONE, invoiceCalendarDate, invoiceReminderClock, invoiceReminderMilestones,
  type InvoiceReminderCategory, type ReminderMilestone } from "./invoice-reminder-clock";

export type Audience = "homeowner" | "internal";
export type Channel = "sms" | "email";
export type Fact = ReminderMilestone["requiredFacts"][number];
export type AttemptState = "reserved" | "pending" | "accepted" | "delivered" | "rejected" | "unknown";
export type Proof = Readonly<{ observedAt: string; expiresAt: string; sourceRef: string }>;

/** Explicitly unapproved design values. These are NOT authorization or a catch-up policy. */
export const PROPOSAL = Object.freeze({
  timeZone: INVOICE_TIME_ZONE, targetLocalTime: "09:00:00", toleranceMinutes: 15,
  window: "[09:00:00,09:15:00)", maxProofAgeSeconds: 60, maxIdentityProofAgeSeconds: 300,
  timingApproved: false, sendCapability: false,
} as const);

/** Stable identity deliberately excludes mutable due date, owner, channel, destination, template. */
export function eventKey(event: Pick<Event, "accountId" | "invoiceId" | "dayPastDue" | "audience">): string {
  return JSON.stringify(["notification-v1", event.accountId, event.invoiceId, event.dayPastDue, event.audience]);
}

export type Event = Readonly<{
  accountId: string; invoiceId: string; dayPastDue: number; audience: Audience;
  sourceRevision: string; ownerRevision: string; ownerId: string; homeownerContactId: string;
  issuedDate: string; dueDate: string; balanceMinor: number; currency: string | null;
  category: InvoiceReminderCategory | null;
  recipientId: string; contactId: string; channel: Channel; destination: string;
  templateId: string; templateVersion: string; bodyDigest: string;
  claimedFacts: readonly Fact[];
}>;

/** Copy primitives and freeze the only nested collection. Caller changes cannot change this event. */
export function immutableEvent(event: Event): Event {
  return Object.freeze({ ...event, claimedFacts: Object.freeze([...event.claimedFacts]) });
}

export type Evidence = Readonly<{
  source: Proof & Readonly<{
    accountId: string; invoiceId: string; revision: string; available: boolean; complete: boolean;
    status: "open" | "paid" | "void" | "unknown"; balanceMinor: number; currency: string | null;
    ownerId: string; issuedDate: string; dueDate: string;
    category: InvoiceReminderCategory | null; categoryVerified: boolean;
  }>;
  owner: Proof & Readonly<{
    accountId: string; invoiceId: string; revision: string; ownerId: string;
    homeownerContactId: string; exactSourceIdentity: boolean; complete: boolean;
  }>;
  recipient: Proof & Readonly<{
    accountId: string; recipientId: string; contactId: string; audience: Audience;
    channel: Channel; destination: string; exactSourceIdentity: boolean;
    destinationVerified: boolean; internalRecipientApproved: boolean;
  }>;
  dnd: Proof & Readonly<{
    accountId: string; contactId: string; channel: Channel; destination: string;
    state: "allowed" | "blocked" | "unknown";
  }>;
  template: Proof & Readonly<{
    approved: boolean; accountId: string; id: string; version: string; bodyDigest: string;
    audience: Audience; dayPastDue: number; channel: Channel; claimedFacts: readonly Fact[];
  }>;
  /** Required for every channel. Email is never an automatic fallback from SMS. */
  channelAuthorization: Proof & Readonly<{
    approved: boolean; eventKey: string; recipientId: string; channel: Channel; destination: string;
  }>;
  facts: readonly (Proof & Readonly<{
    fact: Fact; accountId: string; invoiceId: string; sourceRevision: string; value: boolean;
  }>)[];
  attempts: Proof & Readonly<{
    accountId: string; historyComplete: boolean;
    records: readonly Readonly<{ eventKey: string; state: AttemptState }>[];
  }>;
}>;

export type Request = Readonly<{ event: Event; preflight: Evidence; final: Evidence }>;
export type Plan = Readonly<{
  eventKey: string; designStatus: "eligible_in_proposal" | "hold";
  reasons: readonly string[]; sendCapability: false; timingApproved: false;
  priorAttemptStates: readonly AttemptState[];
}>;

const knownFacts: readonly Fact[] = ["three_percent_fee_applied", "recurring_late_fee_policy",
  "service_suspended", "collections_after_day_35_policy"];
const knownStates: readonly AttemptState[] = ["reserved", "pending", "accepted", "delivered", "rejected", "unknown"];
const timeFormat = new Intl.DateTimeFormat("en-GB", { timeZone: INVOICE_TIME_ZONE,
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const nonempty = (value: string) => typeof value === "string" && value.trim().length > 0;
const instant = (value: string) => typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && invoiceCalendarDate(value) !== null
  ? Date.parse(value) : NaN;
const sameFacts = (a: readonly Fact[], b: readonly Fact[]) =>
  new Set(a).size === a.length && new Set(b).size === b.length &&
  a.length === b.length && a.every(fact => b.includes(fact));

function fresh(proof: Proof, nowMs: number, maxAgeSeconds: number = PROPOSAL.maxProofAgeSeconds): boolean {
  const observed = instant(proof.observedAt), expires = instant(proof.expiresAt);
  return nonempty(proof.sourceRef) && Number.isFinite(observed) && Number.isFinite(expires) &&
    observed <= nowMs && nowMs < expires && expires > observed &&
    nowMs - observed < maxAgeSeconds * 1000;
}

/** A positive result is a hypothetical assessment, never an executable send instruction.
 * Typed adapter input is assumed; real adapters and proof/receipt authenticity are not implemented.
 */
export function planNotification(request: Request, now: Date): Plan {
  const event = immutableEvent(request.event), key = eventKey(event), nowMs = now.getTime();
  const reasons: string[] = [], priorStates = new Set<AttemptState>();
  const hold = (reason: string) => { if (!reasons.includes(reason)) reasons.push(reason); };
  if (!Number.isFinite(nowMs)) hold("invalid_now");
  const strings = [event.accountId, event.invoiceId, event.sourceRevision, event.ownerRevision,
    event.ownerId, event.homeownerContactId, event.recipientId, event.contactId, event.destination,
    event.templateId, event.templateVersion, event.bodyDigest];
  const validCurrency = typeof event.currency === "string" ? /^[A-Z]{3}$/.test(event.currency)
    : event.currency === null && permitsUnknownCurrency(event);
  if (!strings.every(nonempty) || !["homeowner", "internal"].includes(event.audience) ||
      !["sms", "email"].includes(event.channel) || !Number.isSafeInteger(event.dayPastDue) ||
      (event.category !== null && !["maintenance", "irrigation"].includes(event.category)) ||
      !validCurrency || !Number.isSafeInteger(event.balanceMinor) || event.balanceMinor <= 0)
    hold("invalid_event_binding");
  if (event.channel === "sms" && (!/^\+[1-9]\d{7,14}$/.test(event.destination) ||
      (event.destination.startsWith("+1") && !/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(event.destination)))) hold("invalid_exact_phone");
  if (event.channel === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(event.destination)) hold("invalid_exact_email");
  if (!event.claimedFacts.every(fact => knownFacts.includes(fact)) || new Set(event.claimedFacts).size !== event.claimedFacts.length)
    hold("invalid_fact_claims");

  const clock = invoiceReminderClock(event.issuedDate, event.dueDate, now);
  if (!clock) hold("invalid_invoice_dates");
  const common = [10, 15, 21].includes(event.dayPastDue);
  // Common timing/facts are identical in both exact helper categories. Unresolved is not guessed.
  const lookupCategory = common ? "maintenance" : event.category;
  const step = lookupCategory ? invoiceReminderMilestones(lookupCategory, event.issuedDate, event.dueDate, now)
    ?.find(item => item.dayPastDue === event.dayPastDue && item.audience === event.audience) : undefined;
  if (!step) hold("unsupported_milestone_or_audience");
  if (!common && event.category !== "maintenance") hold("verified_maintenance_category_required");
  if (step && step.timing !== "today") hold(step.timing === "past_reconcile" ? "past_milestone_no_replay" : "future_milestone");
  if (Number.isFinite(nowMs)) {
    const parts = timeFormat.formatToParts(now);
    const seconds = Number(parts.find(p => p.type === "hour")!.value) * 3600 +
      Number(parts.find(p => p.type === "minute")!.value) * 60 + Number(parts.find(p => p.type === "second")!.value);
    if (seconds < 9 * 3600 || seconds >= (9 * 3600 + PROPOSAL.toleranceMinutes * 60)) hold("outside_proposed_window_no_catch_up");
  }
  if (step && !step.requiredFacts.every(fact => event.claimedFacts.includes(fact))) hold("required_template_fact_missing");

  for (const [phase, evidence] of [["preflight", request.preflight], ["final", request.final]] as const) {
    const fail = (reason: string) => hold(`${phase}:${reason}`);
    for (const name of ["source", "owner", "recipient", "dnd", "template", "channelAuthorization", "attempts"] as const)
      if (!fresh(evidence[name], nowMs, name === "owner" ? PROPOSAL.maxIdentityProofAgeSeconds : PROPOSAL.maxProofAgeSeconds)) fail(`${name}_proof_not_fresh`);
    const { source, owner, recipient, dnd, template, channelAuthorization, attempts } = evidence;
    if (!source.available || !source.complete) fail("source_unavailable_or_incomplete");
    if (source.status !== "open" || !Number.isSafeInteger(source.balanceMinor) || source.balanceMinor <= 0) fail("not_open_positive_balance");
    if (source.accountId !== event.accountId || source.invoiceId !== event.invoiceId ||
        source.revision !== event.sourceRevision || source.ownerId !== event.ownerId ||
        source.issuedDate !== event.issuedDate || source.dueDate !== event.dueDate ||
        source.balanceMinor !== event.balanceMinor || source.currency !== event.currency || source.category !== event.category)
      fail("source_event_drift");
    if (!common && (!source.categoryVerified || source.category !== "maintenance")) fail("verified_maintenance_category_required");
    if (!owner.complete || !owner.exactSourceIdentity || owner.accountId !== event.accountId ||
        owner.invoiceId !== event.invoiceId || owner.ownerId !== event.ownerId ||
        owner.revision !== event.ownerRevision || owner.homeownerContactId !== event.homeownerContactId)
      fail("owner_identity_not_exact_or_changed");
    if (recipient.accountId !== event.accountId || recipient.recipientId !== event.recipientId ||
        recipient.contactId !== event.contactId || recipient.audience !== event.audience ||
        recipient.channel !== event.channel || recipient.destination !== event.destination ||
        !recipient.destinationVerified || !recipient.exactSourceIdentity ||
        (event.audience === "homeowner" && recipient.contactId !== owner.homeownerContactId) ||
        (event.audience === "internal" && !recipient.internalRecipientApproved)) fail("recipient_not_exact_verified_approved");
    if (dnd.accountId !== event.accountId || dnd.contactId !== event.contactId ||
        dnd.channel !== event.channel || dnd.destination !== event.destination || dnd.state !== "allowed") fail("current_dnd_not_allowed");
    if (!template.approved || template.accountId !== event.accountId || template.id !== event.templateId ||
        template.version !== event.templateVersion || template.bodyDigest !== event.bodyDigest ||
        template.audience !== event.audience || template.dayPastDue !== event.dayPastDue ||
        template.channel !== event.channel || !sameFacts(template.claimedFacts, event.claimedFacts)) fail("template_not_exact_approved");
    if (!channelAuthorization.approved || channelAuthorization.eventKey !== key ||
        channelAuthorization.recipientId !== event.recipientId || channelAuthorization.channel !== event.channel ||
        channelAuthorization.destination !== event.destination) fail("channel_not_explicitly_authorized");
    for (const fact of event.claimedFacts) {
      const matches = evidence.facts.filter(item => item.fact === fact);
      if (matches.length !== 1 || !matches[0].value || !fresh(matches[0], nowMs) ||
          matches[0].accountId !== event.accountId || matches[0].invoiceId !== event.invoiceId ||
          matches[0].sourceRevision !== event.sourceRevision) fail(`fact_not_proven:${fact}`);
    }
    if (!attempts.historyComplete || attempts.accountId !== event.accountId) fail("attempt_history_incomplete_or_wrong_account");
    for (const attempt of attempts.records.filter(item => item.eventKey === key)) {
      if (knownStates.includes(attempt.state)) priorStates.add(attempt.state);
      // Rejection also blocks: this planner does not grant retries or infer non-delivery.
      fail(`prior_attempt:${knownStates.includes(attempt.state) ? attempt.state : "unknown"}`);
    }
  }
  for (const name of ["source", "owner", "recipient", "dnd", "template", "channelAuthorization", "attempts"] as const) {
    // A complete identity proof may be carried unchanged within its original five-minute
    // lifetime. It is never relabeled fresh or extended. The trusted source adapter must
    // retain the opaque capability and recheck exact invoice ownership in the final read.
    // All send-sensitive source/destination/DND/fact evidence still needs a newer read.
    const before = request.preflight[name], after = request.final[name];
    const unchangedOwner = name === "owner" && JSON.stringify(before) === JSON.stringify(after);
    if (!unchangedOwner && instant(after.observedAt) <= instant(before.observedAt)) hold(`final:${name}_not_newer_than_preflight`);
  }
  for (const fact of event.claimedFacts) {
    const before = request.preflight.facts.find(item => item.fact === fact);
    const after = request.final.facts.find(item => item.fact === fact);
    if (before && after && instant(after.observedAt) <= instant(before.observedAt)) hold(`final:fact_not_rechecked:${fact}`);
  }
  return Object.freeze({ eventKey: key, designStatus: reasons.length ? "hold" : "eligible_in_proposal",
    reasons: Object.freeze(reasons), sendCapability: false, timingApproved: false,
    priorAttemptStates: Object.freeze([...priorStates]) });
}

/** No silent priority choice. Duplicate events and distinct same-contact events all hold. */
export function planBatch(requests: readonly Request[], now: Date): readonly Plan[] {
  const keys = new Map<string, number>(), contacts = new Map<string, Set<string>>();
  for (const { event } of requests) {
    const key = eventKey(event), contact = JSON.stringify([event.accountId, event.contactId]);
    keys.set(key, (keys.get(key) ?? 0) + 1);
    const contactKeys = contacts.get(contact) ?? new Set<string>();
    contactKeys.add(key); contacts.set(contact, contactKeys);
  }
  return Object.freeze(requests.map(request => {
    const plan = planNotification(request, now), reasons = [...plan.reasons];
    if (keys.get(plan.eventKey)! > 1) reasons.push("duplicate_event_in_batch");
    if (contacts.get(JSON.stringify([request.event.accountId, request.event.contactId]))!.size > 1)
      reasons.push("simultaneous_contact_event_conflict");
    return Object.freeze({ ...plan, designStatus: reasons.length ? "hold" as const : "eligible_in_proposal" as const,
      reasons: Object.freeze(reasons) });
  }));
}
