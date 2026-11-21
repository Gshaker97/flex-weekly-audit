/**
 * The reminder audit: did anything slip through the cracks?
 *
 * This module answers ONE question, and it is not the question the preflight
 * answers. The preflight looks forward: if the reminder were live today, who
 * would get one. The audit looks BACKWARD: for every invoice whose milestone day
 * has already passed, did a message go out, and if not, is there a reason on
 * record — or did we simply never look?
 *
 * THE DISTINCTION THE WHOLE AUDIT EXISTS TO MAKE
 *   A hold is a decision. "We did not email this customer because their email
 *   consent is unknown" is the system working. It belongs in a report a person
 *   reads, not in an alarm.
 *   A gap is NOT a decision. "This invoice passed day 15 three weeks ago, is
 *   still unpaid, has no message against it, and nothing explains why" means the
 *   cron did not run, or the code had a bug, or the invoice fell between two
 *   reads. Nobody would ever find out. That is the crack.
 * So `held_explained_by_todays_hold` and `missed_no_explanation` must never be
 * allowed to blur into one another, and an unreadable input must become neither.
 *
 * WHAT THIS MODULE CANNOT DO, STATED PLAINLY
 *   It cannot know what was true on the milestone day. The holds it is given are
 *   RECOMPUTED TODAY. A customer who opted out last week explains today's
 *   silence but did not necessarily explain it then, and a customer whose
 *   consent arrived yesterday leaves a gap that today looks sendable. So the
 *   verdict is named `held_explained_by_todays_hold`, not `correctly_held`, and
 *   every report built on it must carry that caveat. Proving the decision on the
 *   day would need a stored per-run record; the migrations for
 *   `ReminderEvaluationRun`/`Row` were deliberately never applied, so that
 *   evidence does not exist and this module does not pretend otherwise.
 *
 * WHY THE UNIT IS INVOICE x MILESTONE x CHANNEL
 *   Since 2026-11-18 a text and an email are two messages with two ledger rows
 *   and two keys. A text that delivered and an email that bounced are two
 *   different facts about one invoice, and collapsing them would hide the
 *   bounce. So each channel is audited on its own evidence.
 *
 * READ-ONLY BY CONSTRUCTION. This module takes plain data and returns plain
 * data. It imports no provider client, no database, no sender and no ledger
 * writer, so it cannot send, reserve, retry or repair anything. Labels are
 * invoice numbers; no customer name, address, phone, email or contact id is
 * accepted or returned, so an audit report can be pasted anywhere.
 */

export type AuditChannel = "sms" | "email";

/**
 * Exactly one verdict per invoice/milestone/channel. Mutually exclusive, and
 * `auditWindow` asserts they sum, so a verdict can never be quietly dropped.
 */
export type AuditVerdict =
  /** The milestone is still in the future. Nothing is owed by the system yet. */
  | "not_yet_due"
  /** Accepted by the provider AND the provider reports it delivered. */
  | "sent_and_delivered"
  /** Accepted, but nobody has confirmed it reached the customer. */
  | "sent_delivery_unconfirmed"
  /** The provider says it did not arrive. The customer was never reminded. */
  | "sent_but_delivery_failed"
  /** The provider refused the message outright. */
  | "send_rejected_by_provider"
  /** Reserved or pending and never closed out: a send that stopped half-way. */
  | "send_attempt_left_incomplete"
  /** More than one row for one invoice, milestone and channel. */
  | "sent_more_than_once"
  /** The provider shows our message, the ledger does not. Our records are wrong. */
  | "sent_without_a_ledger_row"
  /** Settled on or before its milestone day, so no message was ever owed. */
  | "paid_before_its_milestone"
  /** It got paid, but after its milestone, and we never sent. No harm, no credit. */
  | "paid_after_its_milestone_never_sent"
  /** Nothing sent, and a hold recomputed TODAY accounts for it. A decision. */
  | "held_explained_by_todays_hold"
  /** Nothing sent, still unpaid, and nothing accounts for it. THE CRACK. */
  | "missed_no_explanation"
  /** Something could not be read. Never a pass and never an accusation. */
  | "audit_inconclusive";

/**
 * Verdicts a person must look at, in the order they should look. Everything
 * absent from this list is either fine or merely informational. `missed` leads
 * because it is the only verdict that means the system failed silently.
 */
export const NEEDS_ATTENTION: readonly AuditVerdict[] = Object.freeze([
  "missed_no_explanation",
  "sent_more_than_once",
  "sent_without_a_ledger_row",
  "send_attempt_left_incomplete",
  "sent_but_delivery_failed",
  "send_rejected_by_provider",
  "audit_inconclusive",
  "sent_delivery_unconfirmed",
]);

export function verdictNeedsAttention(verdict: AuditVerdict): boolean {
  return NEEDS_ATTENTION.includes(verdict);
}

/** Report order: attention first in its own severity order, then the quiet ones. */
export const VERDICT_ORDER: readonly AuditVerdict[] = Object.freeze([
  ...NEEDS_ATTENTION,
  "sent_and_delivered",
  "held_explained_by_todays_hold",
  "paid_after_its_milestone_never_sent",
  "paid_before_its_milestone",
  "not_yet_due",
]);

/** A ledger row as the audit needs it. `state` is the ledger's own vocabulary. */
export interface AuditLedgerRow {
  /** "reserved" | "pending" | "accepted" | "rejected" | "unknown", or anything unexpected. */
  state: string;
  providerMessageId: string | null;
}

/** What the provider says became of one accepted message. */
export interface AuditDeliveryRecord {
  providerMessageId: string;
  /** "delivered" | "failed" | "undelivered" | anything else the provider returns. */
  status: string | null;
}

export interface AuditChannelSubject {
  channel: AuditChannel;
  /**
   * Today's recomputed decision for this channel:
   *   "eligible"   nothing stops a send today, so silence needs explaining
   *   "suppressed" something stops it today; `suppressedReason` names what
   *   "unknown"    the decision could not be recomputed -> inconclusive
   */
  expectation: "eligible" | "suppressed" | "unknown";
  suppressedReason: string | null;
  ledger: readonly AuditLedgerRow[];
  delivery: readonly AuditDeliveryRecord[];
  /** False when the provider's outcome could not be read in full. */
  deliveryComplete: boolean;
  /**
   * True when the provider's own history shows a message of ours for this
   * invoice and milestone. Only consulted when the ledger is empty, where it
   * turns "we never sent" into "we sent and failed to record it".
   */
  providerShowsOurMessage?: boolean;
}

export interface AuditSubject {
  invoiceId: string;
  /** Label only. Never a name, address or contact id. */
  invoiceNumber: string | null;
  milestoneDay: number;
  /** The Phoenix calendar date this invoice hit the milestone. Null = unreadable. */
  milestoneOn: string | null;
  /** Null when the live status could not be read. */
  openNow: boolean | null;
  balanceCents: number | null;
  /** Phoenix calendar date the cache records payment on. Null = not recorded. */
  paidOn: string | null;
  /** Invoice-level holds recomputed today, channel-independent. */
  invoiceHolds: readonly string[];
  /** False when today's decision could not be recomputed at all. */
  holdsComplete: boolean;
  /** False when the ledger could not be read in full. */
  ledgerComplete: boolean;
  channels: readonly AuditChannelSubject[];
}

export interface AuditFinding {
  invoiceId: string;
  invoiceNumber: string | null;
  milestoneDay: number;
  milestoneOn: string | null;
  channel: AuditChannel;
  verdict: AuditVerdict;
  /** Stable machine reason, safe to log. Never free customer text. */
  reason: string;
  needsAttention: boolean;
  /** Whole days from the milestone date to the audit date. Null when unreadable. */
  ageDays: number | null;
  balanceCents: number | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Whole days between two Phoenix calendar dates. Phoenix has no DST, so UTC noon is safe. */
export function calendarDaysBetween(from: string, to: string): number | null {
  if (!DATE.test(from) || !DATE.test(to)) return null;
  const a = Date.parse(`${from}T12:00:00.000Z`);
  const b = Date.parse(`${to}T12:00:00.000Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

const DELIVERED = new Set(["delivered", "read", "opened"]);
const FAILED = new Set(["failed", "undelivered", "bounced", "rejected", "error"]);

/**
 * One channel's verdict. The order of these checks IS the policy:
 *
 *   1. anything unreadable                      -> inconclusive, never a pass
 *   2. the milestone has not arrived             -> not yet due
 *   3. the ledger has rows                       -> judge the send
 *   4. the ledger is empty but the provider has  -> our records are wrong
 *      our message
 *   5. the ledger is empty and it is settled     -> judge against the paid date
 *   6. the ledger is empty and it is still open  -> held, or MISSED
 *
 * Checks 1 and 2 come before everything so that a bad input can never be read
 * as either success or failure, and a future milestone is never a miss.
 */
export function auditChannel(
  subject: AuditSubject,
  channel: AuditChannelSubject,
  auditOn: string,
): AuditFinding {
  const ageDays = subject.milestoneOn ? calendarDaysBetween(subject.milestoneOn, auditOn) : null;
  const base = {
    invoiceId: subject.invoiceId, invoiceNumber: subject.invoiceNumber,
    milestoneDay: subject.milestoneDay, milestoneOn: subject.milestoneOn,
    channel: channel.channel, ageDays, balanceCents: subject.balanceCents,
  };
  const out = (verdict: AuditVerdict, reason: string): AuditFinding =>
    ({ ...base, verdict, reason, needsAttention: verdictNeedsAttention(verdict) });

  // 1. Unreadable inputs. An audit that cannot see is not an audit that passes.
  if (!DATE.test(auditOn)) return out("audit_inconclusive", "audit_date_unusable");
  if (!subject.milestoneOn || ageDays === null) return out("audit_inconclusive", "milestone_date_unreadable");
  if (!subject.ledgerComplete) return out("audit_inconclusive", "ledger_read_incomplete");

  // 2. Still in the future. Nothing is owed yet, whatever else is true.
  if (ageDays < 0) return out("not_yet_due", `milestone_on_${subject.milestoneOn}`);

  // 3. The ledger has something. Judge the send on its own evidence.
  if (channel.ledger.length > 0) {
    if (channel.ledger.length > 1) {
      return out("sent_more_than_once", `ledger_rows_${channel.ledger.length}`);
    }
    const row = channel.ledger[0];
    const state = String(row.state ?? "").toLowerCase();

    if (state === "reserved" || state === "pending") {
      return out("send_attempt_left_incomplete", `ledger_state_${state}`);
    }
    if (state === "rejected") return out("send_rejected_by_provider", "ledger_state_rejected");
    if (state === "unknown") return out("sent_delivery_unconfirmed", "ledger_state_unknown");
    if (state !== "accepted") return out("audit_inconclusive", `ledger_state_unrecognised_${state || "blank"}`);

    // Accepted. Only the provider can say whether it arrived; our 201 cannot.
    if (!channel.deliveryComplete) return out("sent_delivery_unconfirmed", "provider_outcome_unreadable");
    if (!row.providerMessageId) return out("sent_delivery_unconfirmed", "accepted_without_a_provider_message_id");
    const record = channel.delivery.find(entry => entry.providerMessageId === row.providerMessageId);
    if (!record) return out("sent_delivery_unconfirmed", "provider_has_no_record_of_this_message");
    const status = String(record.status ?? "").toLowerCase();
    if (FAILED.has(status)) return out("sent_but_delivery_failed", `provider_status_${status}`);
    if (DELIVERED.has(status)) return out("sent_and_delivered", `provider_status_${status}`);
    return out("sent_delivery_unconfirmed", `provider_status_${status || "blank"}`);
  }

  // 4. Nothing in the ledger, but the provider shows our message went out. The
  //    customer was reminded; our own record of it is missing. Worth knowing,
  //    because every duplicate check we run reads the ledger.
  if (channel.providerShowsOurMessage === true) {
    return out("sent_without_a_ledger_row", "provider_history_shows_a_message_the_ledger_does_not");
  }

  // 5. Nothing sent, and it is no longer open. The paid date decides whether
  //    that was correct or merely lucky.
  if (subject.openNow === null) return out("audit_inconclusive", "live_invoice_status_unreadable");
  if (subject.openNow === false) {
    if (!subject.paidOn) return out("audit_inconclusive", "settled_but_no_payment_date_on_record");
    const paidGap = calendarDaysBetween(subject.paidOn, subject.milestoneOn);
    if (paidGap === null) return out("audit_inconclusive", "payment_date_unreadable");
    // paidOn <= milestoneOn: by the milestone there was nothing left to chase.
    if (paidGap >= 0) return out("paid_before_its_milestone", `paid_on_${subject.paidOn}`);
    return out("paid_after_its_milestone_never_sent", `paid_on_${subject.paidOn}`);
  }

  // 6. Still open, still unpaid, nothing sent. Held, or missed.
  if (!subject.holdsComplete) return out("audit_inconclusive", "todays_decision_could_not_be_recomputed");
  if (channel.expectation === "unknown") return out("audit_inconclusive", "channel_decision_could_not_be_recomputed");
  if (channel.expectation === "suppressed") {
    const why = channel.suppressedReason?.trim();
    // "Suppressed" with no reason given is not an explanation.
    if (!why) return out("audit_inconclusive", "channel_suppressed_without_a_reason");
    return out("held_explained_by_todays_hold", why);
  }
  if (subject.invoiceHolds.length > 0) {
    // Deduplicated on purpose. The evaluator legitimately reports one hold per
    // ambiguous message, so a single invoice can arrive with the same reason
    // five times over; joining those verbatim produced reasons like
    // "ambiguous_send_attribution+ambiguous_send_attribution+..." that read as
    // five different problems. The repetition carries no information, and
    // grouping by reason in the summary depends on this string being stable.
    const reasons = [...new Set(subject.invoiceHolds.map(hold => hold.split(":")[0]))];
    return out("held_explained_by_todays_hold", reasons.join("+"));
  }
  // Eligible today, unpaid, past its milestone, and nothing was ever sent.
  return out("missed_no_explanation", `unpaid_${ageDays}_days_past_its_milestone_with_nothing_on_record`);
}

/** Every finding for one invoice: one per channel it was audited on. */
export function auditInvoice(subject: AuditSubject, auditOn: string): readonly AuditFinding[] {
  if (!Array.isArray(subject.channels) || subject.channels.length === 0) {
    // No channel to audit is itself a finding. Silently returning nothing would
    // drop the invoice out of the reconciliation, which is how gaps hide.
    return Object.freeze([{
      invoiceId: subject.invoiceId, invoiceNumber: subject.invoiceNumber,
      milestoneDay: subject.milestoneDay, milestoneOn: subject.milestoneOn,
      channel: "sms" as AuditChannel, verdict: "audit_inconclusive" as AuditVerdict,
      reason: "no_channel_was_audited", needsAttention: true,
      ageDays: subject.milestoneOn ? calendarDaysBetween(subject.milestoneOn, auditOn) : null,
      balanceCents: subject.balanceCents,
    }]);
  }
  return Object.freeze(subject.channels.map(channel => auditChannel(subject, channel, auditOn)));
}

export interface AuditHoldGroup {
  reason: string;
  /** Invoice-channels in this group. One invoice held on two channels counts twice. */
  count: number;
  balanceCents: number;
  /**
   * DISTINCT invoice labels, so a person can go and look. One invoice held on
   * both channels is one thing to go and fix, so it is listed once — otherwise
   * every label appeared twice and the list read as twice as much work.
   */
  invoices: readonly string[];
  /** The longest any invoice in this group has been held. */
  oldestAgeDays: number | null;
}

export interface AuditSummary {
  auditOn: string;
  /** Verdict -> count, in report order, zero-count verdicts omitted. */
  counts: readonly { verdict: AuditVerdict; count: number; balanceCents: number }[];
  total: number;
  /** Findings a person must look at, worst first. */
  attention: readonly AuditFinding[];
  /** Held findings grouped by reason, largest group first. */
  holds: readonly AuditHoldGroup[];
  /** True only when nothing needs attention. The one line a daily report leads on. */
  clean: boolean;
  /**
   * Reconciliation. `ok` false means a finding was lost, which invalidates the
   * whole report rather than just one line of it.
   */
  reconciliation: { counted: number; findings: number; ok: boolean };
}

export function summariseAudit(
  findings: readonly AuditFinding[],
  auditOn: string,
): AuditSummary {
  const counts: { verdict: AuditVerdict; count: number; balanceCents: number }[] = [];
  let counted = 0;
  for (const verdict of VERDICT_ORDER) {
    const rows = findings.filter(finding => finding.verdict === verdict);
    counted += rows.length;
    if (!rows.length) continue;
    counts.push({ verdict, count: rows.length,
      balanceCents: rows.reduce((sum, row) => sum + (row.balanceCents ?? 0), 0) });
  }

  const rank = (finding: AuditFinding) => {
    const index = NEEDS_ATTENTION.indexOf(finding.verdict);
    return index === -1 ? NEEDS_ATTENTION.length : index;
  };
  const attention = findings.filter(finding => finding.needsAttention)
    .slice()
    .sort((a, b) => rank(a) - rank(b) || (b.ageDays ?? 0) - (a.ageDays ?? 0));

  const byReason = new Map<string, AuditFinding[]>();
  for (const finding of findings) {
    if (finding.verdict !== "held_explained_by_todays_hold") continue;
    const list = byReason.get(finding.reason) ?? [];
    list.push(finding);
    byReason.set(finding.reason, list);
  }
  const holds: AuditHoldGroup[] = [...byReason.entries()].map(([reason, rows]) => ({
    reason, count: rows.length,
    balanceCents: rows.reduce((sum, row) => sum + (row.balanceCents ?? 0), 0),
    invoices: Object.freeze([...new Set(rows.map(row => `#${row.invoiceNumber ?? "?"}`))]),
    oldestAgeDays: rows.reduce<number | null>((oldest, row) =>
      row.ageDays === null ? oldest : oldest === null ? row.ageDays : Math.max(oldest, row.ageDays), null),
  })).sort((a, b) => b.count - a.count || b.balanceCents - a.balanceCents);

  return {
    auditOn,
    counts: Object.freeze(counts),
    total: findings.length,
    attention: Object.freeze(attention),
    holds: Object.freeze(holds),
    clean: attention.length === 0,
    reconciliation: { counted, findings: findings.length, ok: counted === findings.length },
  };
}
