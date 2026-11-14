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
import type { Event } from "./notification-gate";
import type { NotificationLedger, NotificationOutcome } from "./notification-ledger";

export const PILOT_MILESTONE_DAY = 21;
export const PILOT_AUDIENCE = "internal" as const;
export const PILOT_CHANNEL = "email" as const;
/** One email for the entire pilot. Not per run, not per day. */
export const PILOT_TOTAL_SEND_CAP = 1;

export type PilotBlock =
  | "channel_not_email" | "audience_not_internal" | "milestone_not_day_21"
  | "destination_not_the_approved_internal_address" | "destination_is_a_customer_destination"
  | "pilot_cap_already_used" | "provider_not_fake"
  | "invoice_not_proven_new" | "ledger_refused";

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

/** How many reservations this pilot has ever made, in any state. */
export interface PilotLedgerCount { countPilotReservations(): Promise<number | null> }

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
  /** Jobber's issue date. Operator-settable: measured drift of -2 min to +3 days. */
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
 * An issue date set before the record was created also holds, because the
 * milestone clock runs off the issue date and a back-dated one could land on
 * day 21 immediately.
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
  ledger: NotificationLedger;
  ledgerCount: PilotLedgerCount;
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

  // The cap is counted across the whole pilot, in any state, so a reserved,
  // pending, accepted, rejected or unknown row all use it up.
  const used = await input.ledgerCount.countPilotReservations();
  if (used === null) return blocked("pilot_cap_already_used", "pilot reservation count unreadable; treated as used");
  if (used >= PILOT_TOTAL_SEND_CAP) return blocked("pilot_cap_already_used", `${used} of ${PILOT_TOTAL_SEND_CAP} used`);

  // Reserve BEFORE the provider is called. The unique key is the guarantee.
  const reservation = await input.ledger.reserve({ event, body: input.body, destination: event.destination,
    channel: PILOT_CHANNEL, contactId: event.contactId, scheduledOn: input.scheduledOn });
  if (reservation.state !== "reserved") return blocked("ledger_refused", reservation.reason);
  const handle = reservation.reservation;

  if (!await input.ledger.assertReserved(handle)) return blocked("ledger_refused", "reservation did not verify");
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
