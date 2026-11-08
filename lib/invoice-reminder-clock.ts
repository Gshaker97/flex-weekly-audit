/** Operational calendar, not evidence of message delivery.
 * User policy: issuedDate is the send date; due date is day one, and the next
 * Arizona calendar date is "day two" / the first day overdue. Texts remain
 * anchored to days PAST DUE, not time since an opportunity entered a stage.
 */
export const INVOICE_TIME_ZONE = "America/Phoenix";
const DAY_MS = 86_400_000;
const dateFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: INVOICE_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
});

function validDatePart(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Date-only values are calendar dates. Offset timestamps are converted into
 * the business timezone. Never interpret an offset-less datetime in host TZ.
 */
export function invoiceCalendarDate(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    if (validDatePart(value)) return value;
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!match || !validDatePart(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return null;
    if (match[5] !== "Z" && (Number(match[5].slice(1, 3)) > 23 || Number(match[5].slice(4, 6)) > 59)) return null;
  }
  const date = typeof value === "string" ? new Date(value) : value;
  if (!Number.isFinite(date.getTime())) return null;
  const parts = dateFormat.formatToParts(date);
  return ["year", "month", "day"].map(type => parts.find(part => part.type === type)!.value).join("-");
}

function dayNumber(value: string): number { return Date.parse(`${value}T00:00:00Z`) / DAY_MS; }
export function addInvoiceCalendarDays(value: string, count: number): string | null {
  if (!validDatePart(value) || !Number.isSafeInteger(count)) return null;
  const date = new Date((dayNumber(value) + count) * DAY_MS);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

export function invoiceReminderClock(issuedDate: string | null, dueDate: string | null, now: Date) {
  const sentOn = invoiceCalendarDate(issuedDate);
  const dueOn = invoiceCalendarDate(dueDate);
  const today = invoiceCalendarDate(now);
  // Do not substitute createdAt or move an invoice's source dates.
  if (!sentOn || !dueOn || !today || sentOn > dueOn || sentOn > today) return null;
  const daysPastDue = dayNumber(today) - dayNumber(dueOn);
  return { sentOn, dueOn, today, daysPastDue,
    overdueOn: addInvoiceCalendarDays(dueOn, 1)!, isOverdue: daysPastDue >= 1 };
}

export type InvoiceReminderCategory = "maintenance" | "irrigation";
export type ReminderMilestone = { dayPastDue: number; audience: "homeowner" | "internal";
  requiredFacts: readonly ("three_percent_fee_applied" | "recurring_late_fee_policy" | "service_suspended" | "collections_after_day_35_policy")[] };
const milestones: Record<InvoiceReminderCategory, readonly ReminderMilestone[]> = {
  maintenance: [
    { dayPastDue: 10, audience: "homeowner", requiredFacts: [] },
    { dayPastDue: 15, audience: "homeowner", requiredFacts: ["three_percent_fee_applied"] },
    { dayPastDue: 20, audience: "homeowner", requiredFacts: ["recurring_late_fee_policy"] },
    { dayPastDue: 21, audience: "internal", requiredFacts: [] },
    { dayPastDue: 25, audience: "homeowner", requiredFacts: ["recurring_late_fee_policy"] },
    { dayPastDue: 30, audience: "homeowner", requiredFacts: ["service_suspended", "collections_after_day_35_policy"] },
  ],
  irrigation: [
    { dayPastDue: 10, audience: "homeowner", requiredFacts: [] },
    { dayPastDue: 15, audience: "homeowner", requiredFacts: ["three_percent_fee_applied"] },
    { dayPastDue: 21, audience: "internal", requiredFacts: [] },
  ],
};

/** Pure planning only: not send eligibility, enrollment, a fee, or suspension.
 * Old steps require reconciliation, never automatic catch-up. Recipients,
 * balances, opt-outs, deduplication, fact evidence and approval are separate.
 * Internal day 21 retains the user-approved internal recipient in GHL.
 */
export function invoiceReminderMilestones(category: InvoiceReminderCategory, issuedDate: string | null, dueDate: string | null, now: Date) {
  const clock = invoiceReminderClock(issuedDate, dueDate, now);
  if (!clock || !Object.hasOwn(milestones, category)) return null;
  return milestones[category].map(step => {
    const scheduledOn = addInvoiceCalendarDays(clock.dueOn, step.dayPastDue)!;
    return { ...step, requiredFacts: [...step.requiredFacts], scheduledOn,
      timing: scheduledOn < clock.today ? "past_reconcile" as const : scheduledOn === clock.today ? "today" as const : "future" as const };
  });
}
