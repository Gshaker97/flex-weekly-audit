export type DateRangePreset =
  | "thisWeek"
  | "thisMonth"
  | "lastMonth"
  | "last30"
  | "last90"
  | "last12mo"
  | "ytd";

export const ALL_PRESETS: DateRangePreset[] = [
  "thisWeek",
  "thisMonth",
  "lastMonth",
  "last30",
  "last90",
  "last12mo",
  "ytd",
];

export interface DateRange {
  start: Date;
  end: Date;
  label: string;
  isMonthOverMonth: boolean;
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
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    return { start, end, label: "This week", isMonthOverMonth: false };
  }

  if (preset === "thisMonth") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    return { start, end, label: "This month", isMonthOverMonth: true };
  }

  if (preset === "lastMonth") {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    end.setMilliseconds(-1);
    return { start, end, label: "Last month", isMonthOverMonth: false };
  }

  if (preset === "last30") {
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    const start = new Date(now);
    start.setDate(start.getDate() - 30);
    start.setHours(0, 0, 0, 0);
    return { start, end, label: "Last 30 days", isMonthOverMonth: false };
  }

  if (preset === "last90") {
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    const start = new Date(now);
    start.setDate(start.getDate() - 90);
    start.setHours(0, 0, 0, 0);
    return { start, end, label: "Last 90 days", isMonthOverMonth: false };
  }

  if (preset === "last12mo") {
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    const start = new Date(now);
    start.setMonth(start.getMonth() - 12);
    start.setHours(0, 0, 0, 0);
    return { start, end, label: "Last 12 months", isMonthOverMonth: false };
  }

  // ytd
  const start = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return { start, end, label: `Year to date (${now.getFullYear()})`, isMonthOverMonth: false };
}

export function parsePreset(value: string | null | undefined): DateRangePreset {
  if (value && (ALL_PRESETS as string[]).includes(value)) {
    return value as DateRangePreset;
  }
  return "ytd";
}

export function presetLabel(preset: DateRangePreset): string {
  return getDateRange(preset).label;
}
