/**
 * Day 21 internal-email pilot — DRAFT, FAKE PROVIDER ONLY.
 *
 * One email, to one approved internal address, for the whole pilot. Not one per
 * run and not one per day.
 *
 * This module imports no transport. The provider is injected, and
 * `assertFakeProvider` refuses anything that is not explicitly marked fake, so
 * there is no mode or flag that makes it deliver. Making it deliver would mean
 * adding code.
 *
 * Hard blocks, checked before anything else and not overridable by input:
 *   - channel must be email. SMS is refused outright.
 *   - audience must be internal, milestone must be day 21.
 *   - the destination must be the one approved internal address, and must not
 *     be any customer destination offered alongside it.
 *   - the pilot cap is one reservation in the ledger, ever.
 */
import { invoiceReminderMilestones } from "./invoice-reminder-clock";
import type { Event } from "./notification-gate";
import type { NotificationLedger, NotificationOutcome } from "./notification-ledger";

export const PILOT_MILESTONE_DAY = 21;
export const PILOT_AUDIENCE = "internal" as const;
export const PILOT_CHANNEL = "email" as const;
/** One email for the entire pilot. Not per run, not per day. Enforced by the
 *  single durable allowance row below, not by counting. */
export const PILOT_TOTAL_SEND_CAP = 1;

export type PilotBlock =
  | "channel_not_email" | "audience_not_internal" | "milestone_not_day_21"
  | "destination_not_the_approved_internal_address" | "destination_is_a_customer_destination"
  | "pilot_allowance_already_spent" | "provider_not_fake"
  | "invoice_not_proven_new" | "day_21_not_due_by_the_jobber_due_date" | "ledger_refused";

export type PilotResult =
  | Readonly<{ state: "blocked"; block: PilotBlock; detail: string }>
  | Readonly<{ state: "sent_to_fake_provider"; providerMessageId: string }>
  | Readonly<{ state: "uncertain"; detail: string }>;

/** A provider this module will talk to. Only a fake may set `fake: true`. */
export interface FakeEmailProvider {
  readonly fake: true;
  readonly name: string;
  send(input: { to: string; subject: string; body: string }): Promise<NotificationOutcome>;
}
export function assertFakeProvider(provider: unknown): FakeEmailProvider {
  const candidate = provider as FakeEmailProvider | null;
  if (!candidate || candidate.fake !== true || typeof candidate.send !== "function" ||
      typeof candidate.name !== "string" || !candidate.name.toLowerCase().includes("fake")) {
    throw new Error("provider_not_fake");
  }
  return candidate;
}

/**
 * The pilot's single allowance: ONE durable row, shared across every invoice,
 * worker, contact and date.
 *
 * Sorting reservations by (createdAt, id) was not safe. A reservation is
 * invisible to other transactions until it commits, so a worker that started
 * earlier can commit later: the second worker reads only its own row, wins, and
 * sends; then the first commits, sorts itself ahead, wins too, and sends again.
 *
 * So the allowance is not derived from the reservations at all. It is a single
 * row whose primary key is a fixed literal, claimed with
 * `INSERT ... ON CONFLICT DO NOTHING` in its own committed transaction. The
 * index decides at commit time, so exactly one claim can ever succeed, whatever
 * order anything else commits in.
 *
 * It is claimed BEFORE the provider is reachable, and once claimed it stays
 * consumed: there is no update, delete, expiry or release path, so a crash, an
 * uncertain outcome, or a restart on a later Phoenix date cannot spend it again.
 */
export const PILOT_ALLOWANCE_KEY = "day21-internal-email-pilot";

export interface PilotAllowance {
  /**
   * Must COMMIT before returning. "claimed" means this reservation holds the
   * pilot's one allowance; "already_claimed" means someone else does; "unknown"
   * means the claim could not be established, which is treated as not held.
   */
  claim(reservationId: string): Promise<"claimed" | "already_claimed" | "unknown">;
}

/* ---------- what proves an invoice is genuinely new ---------------------- */

export interface CutoverProof {
  /** The instant the old workflow was off and its queue was confirmed drained. */
  cutoverAt: string;
  /** EVERY Jobber invoice id that existed at the cutover. */
  inventory: ReadonlySet<string>;
  /** False if pagination was truncated, which makes the inventory unusable. */
  inventoryComplete: boolean;
  inventoryCount: number;
}
export interface InvoiceNoveltyInput {
  jobberInvoiceId: string;
  /** Jobber's record-creation timestamp. Server-assigned, carries a real time. */
  createdAt: string | null;
  /**
   * Jobber's issue date. Operator-settable: measured drift of -2 minutes to
   * +3 days against createdAt. It is NOT the milestone anchor - the due date is.
   */
  issuedDate: string | null;
}
export type NoveltyVerdict =
  | Readonly<{ proven: true; evidence: readonly string[] }>
  | Readonly<{ proven: false; reason: string }>;

const parse = (value: string | null) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
};
/** Clock skew between Jobber's writer and ours. Anything inside it is ambiguous. */
const SKEW_MS = 60_000;

/**
 * `issuedDate` cannot establish novelty. Measured over 800 invoices it always
 * carries a real time (never midnight), but it drifts from `createdAt`: one was
 * set about two minutes earlier, one three days later. It is operator-settable,
 * so it proves nothing about when the record came into existence.
 *
 * Novelty needs BOTH of these, and ambiguity holds:
 *   1. `createdAt` strictly after the cutover, by more than clock skew.
 *   2. The invoice id absent from a COMPLETE inventory taken at the cutover.
 *
 * Neither of these touches the milestone. Day 21 is computed by
 * invoice-reminder-clock from the verified Jobber DUE date in Phoenix, and
 * nothing here can move it: `createdAt` and the inventory decide only whether
 * the invoice is new enough to be in the pilot at all.
 *
 * An issue date set before the record was created still holds, but not because
 * it could move a milestone - it cannot. It holds because the dates were
 * evidently hand-set, which makes every date on the invoice untrustworthy, and
 * an issue date later than the due date makes the clock refuse the invoice
 * outright.
 */
export function invoiceIsProvenNew(input: InvoiceNoveltyInput, proof: CutoverProof): NoveltyVerdict {
  if (!proof.inventoryComplete) {
    return { proven: false, reason: "cutover_inventory_incomplete: pagination was truncated" };
  }
  const cutover = parse(proof.cutoverAt);
  if (cutover === null) return { proven: false, reason: "cutover_instant_unusable" };
  if (typeof input.jobberInvoiceId !== "string" || !input.jobberInvoiceId.trim()) {
    return { proven: false, reason: "invoice_id_missing" };
  }
  if (proof.inventory.has(input.jobberInvoiceId)) {
    return { proven: false, reason: "invoice_existed_at_cutover: present in the inventory" };
  }
  const created = parse(input.createdAt);
  if (created === null) return { proven: false, reason: "created_at_missing_or_unparseable" };
  if (created <= cutover + SKEW_MS) {
    return { proven: false, reason: `created_at_not_after_cutover: ${input.createdAt} vs ${proof.cutoverAt}` };
  }
  const issued = parse(input.issuedDate);
  if (issued === null) return { proven: false, reason: "issued_date_missing_or_unparseable" };
  if (issued < created - SKEW_MS) {
    return { proven: false, reason: `issue_date_set_before_the_record_existed: issued ${input.issuedDate}, created ${input.createdAt}` };
  }
  return { proven: true, evidence: [
    `created_at_after_cutover: ${input.createdAt} > ${proof.cutoverAt}`,
    `absent_from_complete_cutover_inventory_of_${proof.inventoryCount}_invoices`,
    `issue_date_not_back_dated: ${input.issuedDate}`,
  ] };
}

/* ---------- the pilot attempt ------------------------------------------- */

export async function attemptDay21PilotEmail(input: {
  event: Event;
  body: string;
  subject: string;
  scheduledOn: string;
  approvedInternalDestination: string;
  /** Customer destinations for this invoice. Present only to be refused. */
  customerDestinations: readonly string[];
  novelty: InvoiceNoveltyInput;
  cutover: CutoverProof;
  /** The Phoenix instant the decision is being made at. */
  now: Date;
  ledger: NotificationLedger;
  allowance: PilotAllowance;
  provider: unknown;
}): Promise<PilotResult> {
  const { event } = input;
  const blocked = (block: PilotBlock, detail: string): PilotResult => ({ state: "blocked", block, detail });

  // Hard blocks first, in order, before any provider or ledger work.
  if (event.channel !== PILOT_CHANNEL) return blocked("channel_not_email", `channel=${event.channel}`);
  if (event.audience !== PILOT_AUDIENCE) return blocked("audience_not_internal", `audience=${event.audience}`);
  if (event.dayPastDue !== PILOT_MILESTONE_DAY) return blocked("milestone_not_day_21", `day=${event.dayPastDue}`);

  const approved = input.approvedInternalDestination.trim().toLowerCase();
  const destination = String(event.destination ?? "").trim().toLowerCase();
  if (!approved || destination !== approved) {
    return blocked("destination_not_the_approved_internal_address", "destination does not equal the approved address");
  }
  const customers = new Set(input.customerDestinations.map(value => String(value).trim().toLowerCase()).filter(Boolean));
  if (customers.has(destination)) {
    return blocked("destination_is_a_customer_destination", "the approved address matches a customer destination");
  }

  let provider: FakeEmailProvider;
  try { provider = assertFakeProvider(input.provider); }
  catch { return blocked("provider_not_fake", "only a provider explicitly marked fake is accepted"); }

  const novelty = invoiceIsProvenNew(input.novelty, input.cutover);
  if (!novelty.proven) return blocked("invoice_not_proven_new", novelty.reason);

  // Day 21 comes from the clock, computed off the verified Jobber DUE date in
  // America/Phoenix. The issue date is not the anchor and neither is createdAt.
  // The caller's scheduledOn must be the date the clock says, or nothing runs.
  const milestones = invoiceReminderMilestones(event.category!, event.issuedDate, event.dueDate, input.now);
  const day21 = milestones?.find(step => step.dayPastDue === PILOT_MILESTONE_DAY);
  if (!day21) return blocked("day_21_not_due_by_the_jobber_due_date", "the clock produced no day 21 for these dates");
  if (day21.scheduledOn !== input.scheduledOn) {
    return blocked("day_21_not_due_by_the_jobber_due_date",
      `clock says day 21 falls on ${day21.scheduledOn} (due ${event.dueDate}), caller said ${input.scheduledOn}`);
  }
  if (day21.timing !== "today") {
    return blocked("day_21_not_due_by_the_jobber_due_date",
      `day 21 is ${day21.timing} on ${day21.scheduledOn}, not today in Phoenix`);
  }

  // Reserve BEFORE the provider is called. The unique key is the guarantee
  // that two workers cannot both act on the SAME invoice and milestone.
  const reservation = await input.ledger.reserve({ event, body: input.body, destination: event.destination,
    channel: PILOT_CHANNEL, contactId: event.contactId, scheduledOn: input.scheduledOn });
  if (reservation.state !== "reserved") return blocked("ledger_refused", reservation.reason);
  const handle = reservation.reservation;

  if (!await input.ledger.assertReserved(handle)) return blocked("ledger_refused", "reservation did not verify");

  // The one allowance for the whole pilot, claimed and COMMITTED here: after
  // reserving, before the provider is reachable. Two workers on different
  // invoices both reserve, and exactly one of them can claim this. The other
  // leaves its row at `reserved` for a person to see; it is never advanced.
  const claim = await input.allowance.claim(handle.id);
  if (claim !== "claimed") {
    return blocked("pilot_allowance_already_spent", claim === "already_claimed"
      ? `the pilot's one allowance (${PILOT_ALLOWANCE_KEY}) is already held; this reservation stays reserved and unsent`
      : "the allowance claim could not be committed; treated as not held");
  }

  if (!await input.ledger.markPending(handle)) return blocked("ledger_refused", "could not move to pending");

  // One call. No retry, ever, whatever comes back.
  let outcome: NotificationOutcome;
  try { outcome = await provider.send({ to: event.destination, subject: input.subject, body: input.body }); }
  catch { outcome = { state: "unknown" }; }

  const recorded = await input.ledger.markOutcome(handle, outcome);
  if (outcome.state === "accepted" && recorded) {
    return { state: "sent_to_fake_provider", providerMessageId: outcome.providerMessageId };
  }
  // Accepted but unrecorded, or unknown, or rejected: the row stays where it is
  // and nothing here can move it. Reconciliation is a separate, manual act.
  return { state: "uncertain", detail: outcome.state === "accepted"
    ? "the fake provider accepted but the outcome did not persist; blocked until reconciled"
    : `provider outcome ${outcome.state}; blocked until reconciled` };
}
