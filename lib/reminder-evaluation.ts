import { INVOICE_TIME_ZONE, invoiceReminderClock, invoiceReminderMilestones } from "./invoice-reminder-clock";
import { resolveServiceType, serviceTypeIsConfirmed, type ServiceTypeResolution } from "./reminder-service-type";

/**
 * Evaluate-only reminder runner.
 *
 * It answers one question: if reminders were live right now, who would get one
 * and who would be held, and why. It has no send path and no GoHighLevel write
 * path at all — not a disabled one, not a gated one. Making it send would mean
 * adding code, not flipping a flag.
 *
 * Deliberate properties:
 *  - 09:00–09:15 America/Phoenix only, and no catch-up. A milestone whose day
 *    has passed is reconciled by a person, never replayed.
 *  - Every candidate is verified against a fresh per-invoice source read. The
 *    cache decides nothing.
 *  - Service type must be confirmed by Jobber AND corroborated. Unknown,
 *    one-sided or contradictory holds; it never falls back to maintenance.
 *  - Two or more exactly-matching destination contacts hold. Nothing is merged.
 *  - The two reviewed exclusions must be verified before anything is reported as
 *    sendable, independently of every other check.
 */
const OPEN_STATUSES = new Set(["awaiting_payment", "past_due"]);
const SETTLED_STATUSES = new Set(["paid", "void", "bad_debt"]);
/** Compared case-insensitively; the GHL client reports stage names lowercased. */
const OVERDUE_STAGE = "invoice overdue";
export const ARIZONA_WINDOW_START_HOUR = 9;
export const ARIZONA_WINDOW_MINUTES = 15;

export type ReminderDecision = "eligible" | "held" | "not_due" | "no_longer_owes" | "window_passed";

export interface ReminderCandidate {
  jobberInvoiceId: string;
  invoiceNumber: string | null;
  clientName: string | null;
  jobberClientId: string | null;
  email: string | null;
  phone: string | null;
}
export interface SourceInvoice {
  invoiceStatus: string | null;
  totalCents: number | null;
  balanceCents: number | null;
  issuedDate: string | null;
  dueDate: string | null;
  clientId: string | null;
  clientTags: readonly string[] | null;
  lineItemNames: readonly string[] | null;
}
export interface DestinationContact {
  id: string;
  tags: readonly string[];
  dnd: boolean;
  phone: string | null;
  email: string | null;
}
export interface DestinationCard { id: string; stage: string | null; status: string | null }

export interface ReminderEvaluationReaders {
  /** Fresh single-invoice source read. null means unreadable, which holds. */
  readInvoice(jobberInvoiceId: string): Promise<SourceInvoice | null>;
  /** EVERY exactly-matching contact, so ambiguity is visible rather than guessed away. */
  matchContacts(candidate: ReminderCandidate): Promise<readonly DestinationContact[]>;
  cardsForContact(contactId: string): Promise<readonly DestinationCard[]>;
}

export interface ReminderEvaluationRow {
  jobberInvoiceId: string;
  invoiceNumber: string | null;
  clientName: string | null;
  decision: ReminderDecision;
  holds: string[];
  category: string | null;
  categorySource: string | null;
  categoryEvidence: string | null;
  daysPastDue: number | null;
  balanceCents: number | null;
  milestoneDay: number | null;
  audience: string | null;
}
export interface ReminderEvaluationPlan {
  mode: "evaluate";
  state: "completed" | "outside_window";
  phoenixDate: string | null;
  exclusionsVerified: boolean;
  /** Always 0. This module has no send path. */
  sendsAttempted: 0;
  rows: ReminderEvaluationRow[];
  notes: string[];
}

/** Phoenix is UTC−7 year round, but the zone is asked rather than assumed. */
export function phoenixParts(now: Date): { date: string; hour: number; minute: number } | null {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: INVOICE_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find(part => part.type === type)?.value;
  const [year, month, day, hour, minute] = ["year", "month", "day", "hour", "minute"].map(get);
  if (!year || !month || !day || hour === undefined || minute === undefined) return null;
  return { date: `${year}-${month}-${day}`, hour: Number(hour), minute: Number(minute) };
}

export function withinArizonaWindow(now: Date): boolean {
  const parts = phoenixParts(now);
  if (!parts) return false;
  return parts.hour === ARIZONA_WINDOW_START_HOUR && parts.minute < ARIZONA_WINDOW_MINUTES;
}

/**
 * Day 10 is owned by the hourly sender wired into lib/sync.ts. This daily
 * runner never sends it, so one milestone can never be sent by two schedules.
 */
export const DAY10_OWNED_BY_HOURLY_SENDER = 10;

/** True once 09:15 Phoenix has passed on the current Phoenix day. */
export function arizonaWindowPassed(now: Date): boolean {
  const parts = phoenixParts(now);
  if (!parts) return false;
  return parts.hour > ARIZONA_WINDOW_START_HOUR ||
    (parts.hour === ARIZONA_WINDOW_START_HOUR && parts.minute >= ARIZONA_WINDOW_MINUTES);
}

export async function evaluateReminders(input: {
  candidates: readonly ReminderCandidate[];
  readers: ReminderEvaluationReaders;
  now: Date;
  /** The two reviewed Jobber client IDs. Anything other than exactly two is unverified. */
  verifiedExclusions?: readonly string[] | null;
  /** Only a manual review may ignore the window. The scheduled runner never does. */
  ignoreWindow?: boolean;
}): Promise<ReminderEvaluationPlan> {
  const { candidates, readers, now } = input;
  const parts = phoenixParts(now);
  const notes: string[] = [];

  const exclusions = Array.isArray(input.verifiedExclusions) ? input.verifiedExclusions.filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0) : [];
  const uniqueExclusions = new Set(exclusions);
  const exclusionsVerified = uniqueExclusions.size === 2;
  if (!exclusionsVerified) {
    notes.push("exclusions_unverified: exactly two reviewed Jobber client IDs are required; live sends stay off");
  }

  if (!input.ignoreWindow && !withinArizonaWindow(now)) {
    return { mode: "evaluate", state: "outside_window", phoenixDate: parts?.date ?? null,
      exclusionsVerified, sendsAttempted: 0, rows: [],
      notes: [...notes, "outside_arizona_window_no_catch_up"] };
  }

  // Invoices per owner, so a customer with several unpaid invoices is held for
  // review instead of the system choosing a per-customer or per-invoice ladder.
  const perOwner = new Map<string, number>();
  for (const candidate of candidates) {
    if (candidate.jobberClientId) {
      perOwner.set(candidate.jobberClientId, (perOwner.get(candidate.jobberClientId) ?? 0) + 1);
    }
  }

  const rows: ReminderEvaluationRow[] = [];
  for (const candidate of candidates) {
    const holds: string[] = [];
    const row: ReminderEvaluationRow = {
      jobberInvoiceId: candidate.jobberInvoiceId, invoiceNumber: candidate.invoiceNumber,
      clientName: candidate.clientName, decision: "held", holds,
      category: null, categorySource: null, categoryEvidence: null,
      daysPastDue: null, balanceCents: null, milestoneDay: null, audience: null,
    };
    rows.push(row);

    const source = await readers.readInvoice(candidate.jobberInvoiceId);
    if (!source) { holds.push("source_invoice_unreadable"); continue; }
    row.balanceCents = source.balanceCents;

    const status = (source.invoiceStatus ?? "").toLowerCase();
    const balance = source.balanceCents;

    // "No longer owes money" is reported separately from "not eligible for a
    // reminder". A settled invoice is not a hold; there is nothing to decide.
    if (SETTLED_STATUSES.has(status) || (typeof balance === "number" && balance <= 0)) {
      row.decision = "no_longer_owes";
      holds.push(`settled_in_source: status=${status || "unknown"} balance=${balance ?? "unknown"}`);
      continue;
    }
    if (!OPEN_STATUSES.has(status)) { holds.push(`source_status_not_open: ${status || "unknown"}`); continue; }
    if (typeof balance !== "number" || !Number.isSafeInteger(balance) || balance <= 0) {
      holds.push("source_balance_unknown"); continue;
    }
    if (!source.clientId || !candidate.jobberClientId || source.clientId !== candidate.jobberClientId) {
      holds.push("source_owner_unknown_or_changed"); continue;
    }

    const clock = invoiceReminderClock(source.issuedDate, source.dueDate, now);
    if (!clock) { holds.push("source_dates_unusable"); continue; }
    row.daysPastDue = clock.daysPastDue;

    if ((perOwner.get(candidate.jobberClientId) ?? 0) > 1) {
      holds.push(`owner_has_multiple_unpaid_invoices: ${perOwner.get(candidate.jobberClientId)}`);
    }

    const contacts = await readers.matchContacts(candidate);
    let contactTags: readonly string[] | null = null;
    if (contacts.length === 0) {
      holds.push("no_exact_destination_contact");
    } else if (contacts.length > 1) {
      // Not merged, not chosen. Held, with the count visible.
      holds.push(`ambiguous_destination_contacts: ${contacts.length} exact matches, not merged`);
    } else {
      const contact = contacts[0];
      contactTags = contact.tags;
      if (contact.dnd) holds.push("destination_contact_opted_out");
      const cards = await readers.cardsForContact(contact.id);
      if (cards.length === 0) holds.push("no_invoice_pipeline_card");
      else if (cards.length > 1) holds.push(`ambiguous_pipeline_cards: ${cards.length}`);
      else {
        if ((cards[0].stage ?? "").toLowerCase() !== OVERDUE_STAGE) holds.push(`card_not_in_overdue_stage: ${cards[0].stage ?? "unknown"}`);
        if (cards[0].status !== "open") holds.push(`card_status_not_open: ${cards[0].status ?? "unknown"}`);
      }
    }

    // Service type. Jobber decides; GoHighLevel may only corroborate. Anything
    // unknown, one-sided or contradictory holds and no ladder is chosen.
    const service: ServiceTypeResolution = resolveServiceType({
      jobberClientTags: source.clientTags,
      jobberLineItemNames: source.lineItemNames,
      ghlContactTags: contactTags,
    });
    row.category = service.category;
    row.categorySource = service.source;
    row.categoryEvidence = JSON.stringify(service.evidence);
    if (!serviceTypeIsConfirmed(service)) {
      holds.push(`service_type_${service.source}: ${service.detail}`);
      row.decision = "held";
      continue; // without a confirmed category there is no ladder to consult
    }

    const milestones = invoiceReminderMilestones(service.category!, source.issuedDate, source.dueDate, now);
    if (!milestones) { holds.push("milestones_unavailable"); continue; }
    const today = milestones.find(step => step.timing === "today");
    if (!today) {
      // Explicitly not a hold and explicitly not a catch-up. A milestone that
      // already passed is reconciled by a person; it is never replayed here.
      row.decision = "not_due";
      const next = milestones.find(step => step.timing === "future");
      const missed = milestones.filter(step => step.timing === "past_reconcile");
      if (next) { row.milestoneDay = next.dayPastDue; row.audience = next.audience; }
      holds.push(next ? `not_due_today: next is day ${next.dayPastDue} on ${next.scheduledOn}`
        : "ladder_complete_no_further_milestones");
      if (missed.length) holds.push(`past_milestones_for_human_reconciliation: ${missed.map(step => step.dayPastDue).join(",")} (never replayed)`);
      continue;
    }

    row.milestoneDay = today.dayPastDue;
    row.audience = today.audience;

    // Interlock with the hourly sender. Unconditional: not a flag, not a
    // window, not dependent on either send path being enabled.
    if (today.dayPastDue === DAY10_OWNED_BY_HOURLY_SENDER) {
      holds.push(`day_${DAY10_OWNED_BY_HOURLY_SENDER}_owned_by_hourly_sender: this runner never sends it`);
    }

    // The 09:00 window already closed today. The milestone is skipped
    // outright. It is not pending exclusions or anything else, and a
    // later review run must never turn it back into a send.
    if (arizonaWindowPassed(now)) {
      holds.push(`window_passed_today: day ${today.dayPastDue} was scheduled for ` +
        `${today.scheduledOn} 09:00 Phoenix and did not send; skipped, never replayed`);
      const upcoming = milestones.find(step => step.timing === "future");
      if (upcoming) holds.push(`next_milestone: day ${upcoming.dayPastDue} on ${upcoming.scheduledOn}`);
      row.decision = "window_passed";
      continue;
    }

    if (today.requiredFacts.length) {
      // Day 15 and beyond assert a fee or policy. Those need invoice-bound
      // evidence and approved copy, neither of which this runner has.
      holds.push(`milestone_requires_unverified_facts: ${today.requiredFacts.join(",")}`);
    }
    if (!exclusionsVerified) holds.push("exclusions_unverified");

    row.decision = holds.length ? "held" : "eligible";
  }

  return { mode: "evaluate", state: "completed", phoenixDate: parts?.date ?? null,
    exclusionsVerified, sendsAttempted: 0, rows, notes };
}

export function summarizeReminderEvaluation(plan: ReminderEvaluationPlan) {
  const count = (decision: ReminderDecision) => plan.rows.filter(row => row.decision === decision).length;
  return {
    state: plan.state, phoenixDate: plan.phoenixDate, candidates: plan.rows.length,
    eligible: count("eligible"), held: count("held"), notDue: count("not_due"),
    noLongerOwes: count("no_longer_owes"), windowPassed: count("window_passed"),
    exclusionsVerified: plan.exclusionsVerified,
    sendsAttempted: plan.sendsAttempted,
  };
}
