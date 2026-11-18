import { INVOICE_TIME_ZONE, addInvoiceCalendarDays, invoiceReminderClock, invoiceReminderMilestones } from "./invoice-reminder-clock";
import { resolveServiceType, serviceTypeIsConfirmed, type ServiceTypeResolution } from "./reminder-service-type";
import { day15EmailAmountsArePositive, day15EmailIssueWindow } from "./reminder-email-window";
import { classifyLinkedJobRework } from "./reminder-rework-notes";
import type { LinkedJobsResult } from "./reminder-job-notes-source";

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
 *  - A reminder GoHighLevel already sent is suppressed per channel, keyed on the
 *    exact triple (this invoice, today's milestone day, channel). Attribution is
 *    stated by the reader, never inferred from due-date arithmetic. A reminder
 *    for a different invoice suppresses nothing. Ambiguous attribution, an
 *    unconfirmed attempt, an unknown channel or milestone, history that could
 *    not be read in full, and history that could not be read at all all hold.
 *    Missing history is unknown history, never "nothing was sent".
 */
const OPEN_STATUSES = new Set(["awaiting_payment", "past_due"]);
const SETTLED_STATUSES = new Set(["paid", "void", "bad_debt"]);
/** Compared case-insensitively; the GHL client reports stage names lowercased. */
const OVERDUE_STAGE = "invoice overdue";
/** The only milestone the Day 15 email path can ever reach. */
const DAY15 = 15;
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

export type SendChannel = "email" | "sms";

/**
 * One message GoHighLevel (or anything else) may already have sent.
 *
 * `attribution` is the only thing that ties a message to an invoice, and it is
 * stated by the reader, never inferred here from due-date arithmetic:
 *  - "exact"         the enrollment or message evidence names THIS invoice
 *  - "other_invoice" the evidence names a DIFFERENT invoice; it suppresses nothing
 *  - "ambiguous"     the evidence cannot be tied to one invoice; it holds
 * `confirmed` is false when it is not certain the message actually went out.
 */
export interface PriorSend {
  messageId: string;
  channel: SendChannel | null;
  milestoneDay: number | null;
  attribution: "exact" | "other_invoice" | "ambiguous";
  confirmed: boolean;
}

/** `complete` false means the history could not be read in full. That holds. */
export interface SendHistory {
  complete: boolean;
  incompleteReason?: string | null;
  sends: readonly PriorSend[];
}

export interface ReminderEvaluationReaders {
  /** Fresh single-invoice source read. null means unreadable, which holds. */
  readInvoice(jobberInvoiceId: string): Promise<SourceInvoice | null>;
  /** EVERY exactly-matching contact, so ambiguity is visible rather than guessed away. */
  matchContacts(candidate: ReminderCandidate): Promise<readonly DestinationContact[]>;
  cardsForContact(contactId: string): Promise<readonly DestinationCard[]>;
  /**
   * Everything already sent for this invoice's owner. OPTIONAL on the type so
   * existing callers still compile, but a caller that omits it gets a hold on
   * every milestone: missing history is treated as unknown history, never as
   * "nothing was sent".
   */
  sendHistory?(candidate: ReminderCandidate): Promise<SendHistory | null>;
  /**
   * Every job Jobber links to this invoice, with each job's own notes. Required
   * by the Day 15 email path: the warranty / no-charge rule is re-read from
   * Jobber at decision time rather than trusted from a cache. OPTIONAL on the
   * type so existing callers compile, but a caller that omits it gets a hold.
   */
  linkedJobText?(candidate: ReminderCandidate): Promise<LinkedJobsResult | null>;
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
  /** Source invoice total. Reported so a $0 invoice is visible, not just held. */
  totalCents: number | null;
  /** Issue date as the SOURCE reports it, so date-scoped policy need not trust the cache. */
  sourceIssuedDate: string | null;
  /** Warranty / no-charge verdict from the linked job, on the Day 15 email path. */
  reworkVerdict: "excluded" | "hold" | "clear" | null;
  reworkReason: string | null;
  milestoneDay: number | null;
  audience: string | null;
  /** Per-channel outcome for today's milestone. Empty when no milestone is due. */
  channels: { channel: SendChannel; decision: "eligible" | "suppressed"; reason: string | null }[];
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
  /**
   * Which channels a milestone would use. Supplied by the caller on purpose:
   * this module does not decide channel policy. Absent, null or empty holds.
   */
  milestoneChannels?(step: { dayPastDue: number; audience: string }): readonly SendChannel[] | null;
  /**
   * MIRRORS the send path's `feeClaimFreeDay15` exemption in notification-gate.ts.
   *
   * The day-15 milestone requires the fact `three_percent_fee_applied`. The gate
   * waives exactly that one fact, at day 15, for a homeowner, when the template
   * claims no fee at all. Copy that states no fee makes no claim to prove. Pass
   * true only when the copy being evaluated is that fee-free copy; the waiver
   * applies to no other milestone and no other fact.
   */
  feeClaimFreeDay15?: boolean;
  /**
   * MIRRORS the ledger. `eventKey` in notification-gate.ts is
   * (account, invoice, dayPastDue, audience) and carries NO channel, so for a
   * milestone listed here a confirmed send on ANY channel occupies the single
   * ledger event and the milestone cannot be sent again on another channel.
   *
   * Without this the evaluation is per-channel and disagrees with the send path:
   * a day-15 SMS that already went out would leave the day-15 email looking
   * eligible when the ledger would in fact refuse it.
   */
  channelBlindMilestones?: readonly number[];
  /**
   * The fee-free Day 15 CUSTOMER EMAIL path, and nothing else.
   *
   * Approved 2026-11-18: on this path Jobber alone decides whether the invoice
   * is still owed and whether today is its day 15, so the two GoHighLevel
   * demands that duplicated that decision are not consulted:
   *   - the Invoice Pipeline card's stage and status, and
   *   - service-type corroboration.
   * Neither was ever needed here. The day-15 step is identical in the
   * maintenance and irrigation ladders, so no ladder has to be chosen; and the
   * pipeline board has been frozen since around 2026-10-20, so asking it to
   * confirm an overdue invoice only produced false holds.
   *
   * NOTHING ELSE IS RELAXED. The exact-contact match, the opt-out check and the
   * prior-send checks all still run, and this path adds two of its own: the
   * invoice must be issued inside the programme window, and the linked job's
   * notes must be readable and clear the warranty / no-charge rule. Both are
   * re-read from Jobber here, immediately before any send decision.
   *
   * On this path the only milestone that can ever come due is day 15.
   */
  jobberOnlyDay15Email?: boolean;
}): Promise<ReminderEvaluationPlan> {
  const { candidates, readers, now } = input;
  const day15EmailPath = input.jobberOnlyDay15Email === true;
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
      daysPastDue: null, balanceCents: null, totalCents: null, sourceIssuedDate: null,
      reworkVerdict: null, reworkReason: null, milestoneDay: null, audience: null,
      channels: [],
    };
    rows.push(row);

    const source = await readers.readInvoice(candidate.jobberInvoiceId);
    if (!source) { holds.push("source_invoice_unreadable"); continue; }
    row.balanceCents = source.balanceCents;
    row.totalCents = source.totalCents;
    row.sourceIssuedDate = source.issuedDate;

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
    // Approved rule: the invoice TOTAL must be positive as well as the balance.
    // A $0 invoice is never a reminder candidate even if a balance appears on
    // it, and a total that could not be read is unknown, never assumed good.
    const amounts = day15EmailAmountsArePositive(source.totalCents, balance);
    if (!amounts.ok) { holds.push(amounts.reason!); continue; }
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
      // The opt-out check is NOT part of the relaxation and always runs.
      if (contact.dnd) holds.push("destination_contact_opted_out");
      if (!day15EmailPath) {
        const cards = await readers.cardsForContact(contact.id);
        if (cards.length === 0) holds.push("no_invoice_pipeline_card");
        else if (cards.length > 1) holds.push(`ambiguous_pipeline_cards: ${cards.length}`);
        else {
          if ((cards[0].stage ?? "").toLowerCase() !== OVERDUE_STAGE) holds.push(`card_not_in_overdue_stage: ${cards[0].stage ?? "unknown"}`);
          if (cards[0].status !== "open") holds.push(`card_status_not_open: ${cards[0].status ?? "unknown"}`);
        }
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
    // Reported either way. Only the non-email path treats it as a requirement.
    if (!day15EmailPath && !serviceTypeIsConfirmed(service)) {
      holds.push(`service_type_${service.source}: ${service.detail}`);
      row.decision = "held";
      continue; // without a confirmed category there is no ladder to consult
    }

    // On the Day 15 email path the only milestone is day 15, which is identical
    // in both ladders, so it is built here rather than chosen from one.
    const milestones = day15EmailPath
      ? [{ dayPastDue: DAY15, audience: "homeowner" as const,
           requiredFacts: ["three_percent_fee_applied" as const],
           scheduledOn: addInvoiceCalendarDays(clock.dueOn, DAY15)!,
           timing: (addInvoiceCalendarDays(clock.dueOn, DAY15)! < clock.today ? "past_reconcile"
             : addInvoiceCalendarDays(clock.dueOn, DAY15)! === clock.today ? "today" : "future") as
             "past_reconcile" | "today" | "future" }]
      : invoiceReminderMilestones(service.category!, source.issuedDate, source.dueDate, now);
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

    // Re-read from Jobber at decision time, on the email path only.
    if (day15EmailPath) {
      const window = day15EmailIssueWindow(source.issuedDate);
      if (window !== "in_programme") holds.push(`issue_window_${window}`);
      const linked = readers.linkedJobText ? await readers.linkedJobText(candidate) : null;
      if (!linked) {
        holds.push("linked_job_unreadable: cannot apply the warranty rule");
      } else {
        const rework = classifyLinkedJobRework(linked);
        row.reworkVerdict = rework.verdict;
        row.reworkReason = rework.reason;
        if (rework.verdict !== "clear") holds.push(`job_notes_${rework.verdict}: ${rework.reason}`);
        // The invoice the notes belong to must be the invoice being decided.
        if (linked.invoiceId !== candidate.jobberInvoiceId) holds.push("linked_job_invoice_mismatch");
      }
    }

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

    // ----- prior-send suppression -------------------------------------------
    // Keyed on the exact triple (this invoice, today's milestone day, channel).
    // A reminder for a DIFFERENT invoice suppresses nothing. Anything the
    // history cannot state with certainty holds the whole row.
    const declared = input.milestoneChannels?.({ dayPastDue: today.dayPastDue, audience: today.audience }) ?? null;
    const channels = Array.isArray(declared)
      ? [...new Set(declared.filter((value): value is SendChannel => value === "email" || value === "sms"))]
      : [];
    if (channels.length === 0) {
      holds.push("milestone_channels_undeclared: no channel policy supplied for this milestone");
    }

    const history = readers.sendHistory ? await readers.sendHistory(candidate) : null;
    if (!history) {
      holds.push("send_history_unavailable: cannot prove this milestone was not already sent");
    } else {
      if (!history.complete) {
        holds.push(`send_history_incomplete: ${history.incompleteReason || "history could not be read in full"}`);
      }
      // "other_invoice" is dropped here and nowhere else: that is the one case
      // that must never suppress this invoice's reminder.
      const relevant = history.sends.filter(send => send.attribution !== "other_invoice");
      for (const send of relevant) {
        if (send.attribution === "ambiguous") {
          holds.push(`ambiguous_send_attribution: ${send.messageId} cannot be tied to one invoice`);
          continue;
        }
        if (!send.confirmed) {
          holds.push(`uncertain_send_attempt: ${send.messageId} may or may not have gone out`);
          continue;
        }
        if (send.channel === null || send.milestoneDay === null) {
          holds.push(`send_detail_unknown: ${send.messageId} has no ${send.channel === null ? "channel" : "milestone day"}`);
        }
      }
      const channelBlind = Array.isArray(input.channelBlindMilestones) &&
        input.channelBlindMilestones.includes(today.dayPastDue);
      const suppressing = new Map<SendChannel, string>();
      let blockedBy: { messageId: string; channel: SendChannel } | null = null;
      for (const send of relevant) {
        if (send.attribution !== "exact" || !send.confirmed) continue;
        if (send.channel === null || send.milestoneDay !== today.dayPastDue) continue;
        if (!suppressing.has(send.channel)) suppressing.set(send.channel, send.messageId);
        if (channelBlind && !blockedBy) blockedBy = { messageId: send.messageId, channel: send.channel };
      }
      // One ledger event for this milestone: any confirmed channel closes it.
      if (blockedBy) {
        for (const channel of channels) {
          if (!suppressing.has(channel)) suppressing.set(channel, blockedBy.messageId);
        }
        holds.push(`milestone_already_sent_on_another_channel: day ${today.dayPastDue} ` +
          `${blockedBy.channel} as ${blockedBy.messageId} occupies the single ledger event`);
      }
      row.channels = channels.map(channel => suppressing.has(channel)
        ? { channel, decision: "suppressed" as const,
            reason: `already_sent_by_ghl: day ${today.dayPastDue} ${channel} as ${suppressing.get(channel)}` }
        : { channel, decision: "eligible" as const, reason: null });
      if (channels.length > 0 && row.channels.every(entry => entry.decision === "suppressed")) {
        holds.push(`already_sent_all_channels: day ${today.dayPastDue} ` +
          `(${row.channels.map(entry => `${entry.channel}=${suppressing.get(entry.channel)}`).join(", ")})`);
      }
    }
    // ------------------------------------------------------------------------

    // Day 15 and beyond assert a fee or policy. Those need invoice-bound
    // evidence and approved copy, neither of which this runner has — except for
    // the one fact the send path itself waives for fee-free day-15 copy.
    const waived = input.feeClaimFreeDay15 === true && today.dayPastDue === 15 &&
      today.audience === "homeowner" ? "three_percent_fee_applied" : null;
    const unprovenFacts = today.requiredFacts.filter(fact => fact !== waived);
    if (unprovenFacts.length) {
      holds.push(`milestone_requires_unverified_facts: ${unprovenFacts.join(",")}`);
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
    channelsSuppressed: plan.rows.reduce((total, row) =>
      total + row.channels.filter(entry => entry.decision === "suppressed").length, 0),
    exclusionsVerified: plan.exclusionsVerified,
    sendsAttempted: plan.sendsAttempted,
  };
}
