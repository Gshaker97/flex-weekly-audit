/**
 * One customer, one text and one email a day - as a reporting layer over the
 * evaluation, not as a new decision.
 *
 * WHY THIS EXISTS. `evaluateReminders` decides per INVOICE. A customer with
 * three unpaid invoices can therefore produce three separate sms decisions for
 * the same morning. The notification ledger already refuses the second row for
 * the same customer, day and channel, so the sender could not deliver them all;
 * but a report that lists three is still a report nobody can act on, and it
 * hides which one would actually go.
 *
 * So this module collapses the plan to what a day can actually deliver: for
 * each customer, at most ONE sms and at most ONE email. Everything it drops is
 * reported as dropped, with the reason and the invoice it belonged to, so the
 * cap is visible rather than silent.
 *
 * IT CANNOT CREATE A SEND. Every pick is a row the evaluation already called
 * eligible on a channel it already called eligible. This module only removes.
 * That property is asserted directly in the tests: picks are a subset of the
 * eligible input, never a superset.
 *
 * WHICH ONE WINS. The furthest-along milestone first, because that is the
 * message the customer most needs; then the longest overdue; then the lowest
 * invoice number, purely so two runs over the same data agree. Never the
 * largest balance - the oldest debt leads, not the biggest.
 */
import type { ReminderEvaluationRow, SendChannel } from "./reminder-evaluation";

export const DAILY_CHANNELS: readonly SendChannel[] = Object.freeze(["sms", "email"]);

/** How many messages one customer may receive in one day, per channel. */
export const MAX_PER_CUSTOMER_PER_CHANNEL_PER_DAY = 1;

export type DailyPick = Readonly<{
  channel: SendChannel;
  jobberInvoiceId: string;
  invoiceNumber: string | null;
  milestoneDay: number | null;
  daysPastDue: number | null;
}>;

export type DailyDrop = Readonly<{
  channel: SendChannel;
  jobberInvoiceId: string;
  invoiceNumber: string | null;
  reason: string;
}>;

export type DailyCustomerPlan = Readonly<{
  /** Jobber client id where known, else a name key. Never an email or phone. */
  customerKey: string;
  clientName: string | null;
  picks: readonly DailyPick[];
  drops: readonly DailyDrop[];
}>;

export type DailyReminderPlan = Readonly<{
  phoenixDate: string | null;
  customers: readonly DailyCustomerPlan[];
  /** Customers with at least one pick. */
  customersWithASend: number;
  smsPicked: number;
  emailPicked: number;
  droppedToCap: number;
}>;

export type DailyPlanCandidate = Readonly<{
  jobberInvoiceId: string;
  jobberClientId: string | null;
  clientName: string | null;
}>;

const key = (candidate: DailyPlanCandidate | undefined, row: ReminderEvaluationRow): string => {
  const clientId = candidate?.jobberClientId?.trim();
  if (clientId) return `client:${clientId}`;
  const name = (candidate?.clientName ?? row.clientName ?? "").trim().toLowerCase();
  // No Jobber client id and no name is NOT the same customer as another such
  // row, so each falls back to its own invoice and can never be merged with a
  // stranger's.
  return name ? `name:${name}` : `invoice:${row.jobberInvoiceId}`;
};

/** Furthest milestone, then longest overdue, then lowest invoice number. */
function rank(a: ReminderEvaluationRow, b: ReminderEvaluationRow): number {
  const milestone = (b.milestoneDay ?? -1) - (a.milestoneDay ?? -1);
  if (milestone !== 0) return milestone;
  const overdue = (b.daysPastDue ?? -1) - (a.daysPastDue ?? -1);
  if (overdue !== 0) return overdue;
  const an = Number(a.invoiceNumber ?? Number.MAX_SAFE_INTEGER);
  const bn = Number(b.invoiceNumber ?? Number.MAX_SAFE_INTEGER);
  if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
  return a.jobberInvoiceId.localeCompare(b.jobberInvoiceId);
}

export function planDailyReminders(input: Readonly<{
  rows: readonly ReminderEvaluationRow[];
  candidates: readonly DailyPlanCandidate[];
  phoenixDate: string | null;
}>): DailyReminderPlan {
  const byInvoice = new Map<string, DailyPlanCandidate>();
  for (const candidate of input.candidates ?? []) {
    if (candidate?.jobberInvoiceId) byInvoice.set(candidate.jobberInvoiceId, candidate);
  }

  const grouped = new Map<string, { clientName: string | null; rows: ReminderEvaluationRow[] }>();
  for (const row of input.rows ?? []) {
    if (!row || row.decision !== "eligible") continue;
    if (!row.channels.some(entry => entry.decision === "eligible")) continue;
    const candidate = byInvoice.get(row.jobberInvoiceId);
    const id = key(candidate, row);
    const bucket = grouped.get(id) ?? { clientName: candidate?.clientName ?? row.clientName ?? null, rows: [] };
    bucket.rows.push(row);
    grouped.set(id, bucket);
  }

  const customers: DailyCustomerPlan[] = [];
  let smsPicked = 0, emailPicked = 0, droppedToCap = 0;

  for (const [customerKey, bucket] of [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const picks: DailyPick[] = [];
    const drops: DailyDrop[] = [];
    for (const channel of DAILY_CHANNELS) {
      const eligible = bucket.rows
        .filter(row => row.channels.some(entry => entry.channel === channel && entry.decision === "eligible"))
        .sort(rank);
      for (const [index, row] of eligible.entries()) {
        if (index < MAX_PER_CUSTOMER_PER_CHANNEL_PER_DAY) {
          picks.push(Object.freeze({
            channel, jobberInvoiceId: row.jobberInvoiceId, invoiceNumber: row.invoiceNumber,
            milestoneDay: row.milestoneDay, daysPastDue: row.daysPastDue,
          }));
          if (channel === "sms") smsPicked += 1; else emailPicked += 1;
          continue;
        }
        drops.push(Object.freeze({
          channel, jobberInvoiceId: row.jobberInvoiceId, invoiceNumber: row.invoiceNumber,
          reason: `capped_one_${channel}_per_customer_per_day`,
        }));
        droppedToCap += 1;
      }
    }
    customers.push(Object.freeze({
      customerKey, clientName: bucket.clientName,
      picks: Object.freeze(picks), drops: Object.freeze(drops),
    }));
  }

  return Object.freeze({
    phoenixDate: input.phoenixDate ?? null,
    customers: Object.freeze(customers),
    customersWithASend: customers.filter(entry => entry.picks.length > 0).length,
    smsPicked, emailPicked, droppedToCap,
  });
}
