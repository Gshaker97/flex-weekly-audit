export type DateRangePreset =
  | "thisWeek"
  | "thisMonth"
  | "lastMonth"
  | "last30"
  | "last90"
  | "last12mo"
  | "ytd"
  | "allTime"
  | "custom";

// Presets shown in the dropdown (custom is selected by picking dates).
export const ALL_PRESETS: DateRangePreset[] = [
  "thisWeek",
  "thisMonth",
  "lastMonth",
  "last30",
  "last90",
  "last12mo",
  "ytd",
  "allTime",
];

export interface DateRange {
  start: Date;
  end: Date;
  label: string;
  isMonthOverMonth: boolean;
}

const ALL_TIME_START = new Date(2000, 0, 1, 0, 0, 0, 0);

function endOfDay(d: Date): Date {
  const e = new Date(d);
  e.setHours(23, 59, 59, 999);
  return e;
}

function shortDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function getDateRange(
  preset: DateRangePreset,
  reference: Date = new Date()
): DateRange {
  const now = new Date(reference);

  if (preset === "thisWeek") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    const day = d.getDay();
    const diffToMonday = (day + 6) % 7;
    const start = new Date(d);
    start.setDate(d.getDate() - diffToMonday);
    return { start, end: endOfDay(now), label: "This week", isMonthOverMonth: false };
  }

  if (preset === "thisMonth") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    return { start, end: endOfDay(now), label: "This month", isMonthOverMonth: true };
  }

  if (preset === "lastMonth") {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    end.setMilliseconds(-1);
    return { start, end, label: "Last month", isMonthOverMonth: false };
  }

  if (preset === "last30") {
    const start = new Date(now);
    start.setDate(start.getDate() - 30);
    start.setHours(0, 0, 0, 0);
    return { start, end: endOfDay(now), label: "Last 30 days", isMonthOverMonth: false };
  }

  if (preset === "last90") {
    const start = new Date(now);
    start.setDate(start.getDate() - 90);
    start.setHours(0, 0, 0, 0);
    return { start, end: endOfDay(now), label: "Last 90 days", isMonthOverMonth: false };
  }

  if (preset === "last12mo") {
    const start = new Date(now);
    start.setMonth(start.getMonth() - 12);
    start.setHours(0, 0, 0, 0);
    return { start, end: endOfDay(now), label: "Last 12 months", isMonthOverMonth: false };
  }

  if (preset === "allTime") {
    return {
      start: new Date(ALL_TIME_START),
      end: endOfDay(now),
      label: "All time",
      isMonthOverMonth: false,
    };
  }

  if (preset === "custom") {
    // No explicit dates supplied — behave like all time until dates are picked.
    return {
      start: new Date(ALL_TIME_START),
      end: endOfDay(now),
      label: "Custom range",
      isMonthOverMonth: false,
    };
  }

  // ytd
  const start = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
  return {
    start,
    end: endOfDay(now),
    label: `Year to date (${now.getFullYear()})`,
    isMonthOverMonth: false,
  };
}

export function parsePreset(value: string | null | undefined): DateRangePreset {
  if (value === "custom") return "custom";
  if (value && (ALL_PRESETS as string[]).includes(value)) {
    return value as DateRangePreset;
  }
  return "ytd";
}

export function presetLabel(preset: DateRangePreset): string {
  if (preset === "custom") return "Custom range";
  return getDateRange(preset).label;
}

// Parse a native <input type="date"> value (YYYY-MM-DD) in LOCAL time,
// avoiding the UTC-shift bug of new Date("2026-01-01").
function parseDateInput(v: string | undefined, atEndOfDay = false): Date | null {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const [, y, mo, d] = m;
  return new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    atEndOfDay ? 23 : 0,
    atEndOfDay ? 59 : 0,
    atEndOfDay ? 59 : 0,
    atEndOfDay ? 999 : 0
  );
}

export interface RangeParams {
  range?: string;
  start?: string;
  end?: string;
}

// Resolve a DateRange from URL search params. Explicit start/end (custom)
// take precedence over a named preset.
export function resolveDateRange(
  params: RangeParams,
  reference: Date = new Date()
): DateRange {
  const { range, start, end } = params;

  if (start || end) {
    const s = parseDateInput(start) ?? new Date(ALL_TIME_START);
    const e = parseDateInput(end, true) ?? endOfDay(new Date(reference));
    return {
      start: s,
      end: e,
      label: `${shortDate(s)} – ${shortDate(e)}`,
      isMonthOverMonth: false,
    };
  }

  return getDateRange(parsePreset(range), reference);
}

// Serialize the current range into a query string so it can be carried
// across links (e.g. clicking a dashboard card into a detail page).
export function rangeQueryString(params: RangeParams): string {
  const p = new URLSearchParams();
  if (params.start) p.set("start", params.start);
  if (params.end) p.set("end", params.end);
  if (!params.start && !params.end && params.range) p.set("range", params.range);
  const s = p.toString();
  return s ? `?${s}` : "";
}
