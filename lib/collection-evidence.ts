// Reference policy only: service classification and the verified invoice sent
// date are not persisted yet. These markers never schedule or send messages.
export const REMINDER_THRESHOLDS = [10, 15, 20, 25, 30] as const;
export type ReminderStatus = "unknown";
export interface ReminderCell {
  threshold: number;
  status: ReminderStatus;
  // Approximate reference from stored dueAt, NOT a verified policy deadline.
  approximateDaysUntil?: number;
}

const DAY_MS = 86_400_000;
function phoenixDay(date: Date): number | undefined {
  if (!Number.isFinite(date.getTime())) return undefined;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Phoenix", year: "numeric", month: "numeric", day: "numeric",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(get("year"), get("month") - 1, get("day")) / DAY_MS;
}

// new Date("YYYY-MM-DD") produces UTC midnight, indistinguishable in this
// cache from a real midnight instant. The raw scalar/precision was discarded.
// Do not interpret that value as the prior Phoenix day without source proof.
export function hasAmbiguousDateOnlyEncoding(date: Date): boolean {
  return Number.isFinite(date.getTime()) && date.getUTCHours() === 0 &&
    date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0;
}

// Calendar-day age is only a source due-date reference, not the desired policy
// clock (verified sent date = day 0; next Arizona calendar day = day 1 late).
export function sourceDueDateAge(dueAt: Date | null, now: Date): number | null {
  if (dueAt && hasAmbiguousDateOnlyEncoding(dueAt)) return null;
  const dueDay = dueAt ? phoenixDay(dueAt) : undefined;
  const today = phoenixDay(now);
  return dueDay === undefined || today === undefined ? null : today - dueDay;
}

export function smsReadiness(phone: string | null | undefined): string {
  return phone?.trim()
    ? "SMS eligibility unverified (number, contact match and consent need verification)"
    : "SMS blocked: no phone on record (historical delivery remains unknown)";
}

// Deliberately accepts neither phone/email nor unrelated outbound messages:
// neither contact-channel availability nor SMS timing proves reminder delivery.
export function buildUnverifiedReminders(dueAt: Date | null, now: Date): ReminderCell[] {
  const age = sourceDueDateAge(dueAt, now);
  return REMINDER_THRESHOLDS.map((threshold) => ({
    threshold,
    status: "unknown",
    ...(age !== null
      ? { approximateDaysUntil: threshold - age }
      : {}),
  }));
}

// This is a manual mark, not a verified call or authenticated caller attribution.
export function manualCallMark(called: boolean, now = new Date()) {
  return { calledAt: called ? now : null, calledBy: null };
}
