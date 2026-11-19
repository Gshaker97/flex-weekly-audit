// Arizona calendar helpers and the late-invoice reminder ladder used by the
// daily audit.
//
// Rule (same as docs/invoice-reminder-clock.md on the reminder branches):
//   - The Jobber due date is day one. The next America/Phoenix calendar date is
//     the first day past due; the customer's card should then sit in
//     "Invoice Overdue" in the GHL Invoice Pipeline.
//   - Jobber sends its own reminder emails on days 3 and 6. Jobber's API does
//     not expose those sends, so the audit cannot confirm them.
//   - Maintenance customers get a GHL text 10, 15, 20, 25 and 30 days past due.
//   - Irrigation customers get a GHL text 10 and 15 days past due only.
//   - The internal call prompt is 21 days past due (tracked by the
//     "Called" checkbox on the Collections page).

export const BUSINESS_TZ = "America/Phoenix";
const DAY_MS = 86_400_000;

const dateFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function isDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Arizona calendar date (YYYY-MM-DD) for a Jobber date value or an instant.
 * A date-only string is taken literally; a timestamp is converted to Arizona.
 */
export function azDate(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  if (typeof value === "string" && isDateOnly(value)) return value;
  const d = typeof value === "string" ? new Date(value) : value;
  if (!Number.isFinite(d.getTime())) return null;
  const parts = dateFormat.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function dayNumber(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) / DAY_MS;
}

export function addDays(date: string, count: number): string {
  return new Date((dayNumber(date) + count) * DAY_MS).toISOString().slice(0, 10);
}

/** Whole calendar days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
  return dayNumber(b) - dayNumber(a);
}

export type ServiceCategory = "maintenance" | "irrigation" | "unknown";

/** Customer text milestones, in days past due. */
export const TEXT_LADDER: Record<Exclude<ServiceCategory, "unknown">, number[]> = {
  maintenance: [10, 15, 20, 25, 30],
  irrigation: [10, 15],
};

/** Steps both ladders share; the only ones checked when the type is unknown. */
export const SHARED_STEPS = [10, 15];

export const JOBBER_EMAIL_DAYS = [3, 6];
export const CALL_PROMPT_DAY = 21;

/**
 * Service type from Jobber (client tags + invoice line item names), with a
 * GoHighLevel "irrigation" tag allowed only to agree, never to decide alone.
 * Mirrors lib/reminder-service-type.ts on the reminder branches.
 */
export function resolveServiceCategory(input: {
  jobberLabels: string[] | null;
  ghlTags: string[] | null;
}): { category: ServiceCategory; reason: string } {
  const jobber = input.jobberLabels ?? [];
  const irrigation = jobber.some((l) => /irrigation/i.test(l));
  const maintenance = jobber.some((l) => /maintenance/i.test(l));
  const ghlIrrigation = (input.ghlTags ?? []).some((t) => /irrigation/i.test(t));

  if (input.jobberLabels === null) {
    return { category: "unknown", reason: "Couldn't read Jobber tags or line items" };
  }
  if (irrigation && maintenance) {
    return { category: "unknown", reason: "Jobber shows both irrigation and maintenance" };
  }
  if (irrigation) return { category: "irrigation", reason: "Jobber says irrigation" };
  if (maintenance) {
    if (ghlIrrigation) {
      return {
        category: "unknown",
        reason: "Jobber says maintenance but the GHL contact is tagged irrigation",
      };
    }
    return { category: "maintenance", reason: "Jobber says maintenance" };
  }
  return {
    category: "unknown",
    reason: ghlIrrigation
      ? "Only the GHL contact says irrigation; Jobber has no service tag"
      : "No irrigation or maintenance tag or line item in Jobber",
  };
}

export type StepStatus = "sent" | "late" | "early" | "missed" | "due" | "upcoming";

/**
 * Was a message sent for a milestone? A text on the milestone day or the day
 * after counts as sent; two or three days after is late; one day before is
 * early. The windows stay inside the five-day gap between milestones.
 */
export function stepStatus(
  scheduledOn: string,
  today: string,
  sentDates: string[]
): { status: StepStatus; sentOn: string | null } {
  let best: { status: StepStatus; sentOn: string; rank: number } | null = null;
  for (const d of sentDates) {
    const offset = daysBetween(scheduledOn, d);
    let status: StepStatus | null = null;
    let rank = 0;
    if (offset === 0 || offset === 1) {
      status = "sent";
      rank = 3;
    } else if (offset === -1) {
      status = "early";
      rank = 2;
    } else if (offset === 2 || offset === 3) {
      status = "late";
      rank = 1;
    }
    if (status && (!best || rank > best.rank)) best = { status, sentOn: d, rank };
  }
  if (best) return { status: best.status, sentOn: best.sentOn };
  const age = daysBetween(scheduledOn, today);
  if (age < 0) return { status: "upcoming", sentOn: null };
  // Give the workflow until the end of the day after the milestone.
  if (age <= 1) return { status: "due", sentOn: null };
  return { status: "missed", sentOn: null };
}
