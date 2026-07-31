// Splitting tracked time into residential vs commercial crew work.
//
// The authoritative signal is Jobber's own timesheet label (the Track Time
// category the crew picks when they clock in), which the sync now carries
// through on TimeEntry.label. Entries that arrived before that field was synced
// — or that the crew logged without picking a category — fall back to the
// client record: a Jobber client with a company name is commercial work, an
// individual is residential.
//
// Every entry therefore lands in a segment, and the UI reports how many were
// classified by label vs by fallback so the split is never a black box.

export type Segment = "residential" | "commercial";
export type SegmentFilter = Segment | "all";
export type SegmentSource = "label" | "client";

export const SEGMENT_LABELS: Record<Segment, string> = {
  residential: "Residential",
  commercial: "Commercial",
};

// Matched against the Jobber label, loosest-but-still-unambiguous wording.
// "res"/"comm" as whole words catch shorthand like "Res Maint" or "Comm Crew".
const RESIDENTIAL_PATTERNS = [/residential/i, /\bres\b/i, /\bhome(s|owner)?\b/i];
const COMMERCIAL_PATTERNS = [
  /commercial/i,
  /\bcomm\b/i,
  /\bhoa\b/i,
  /\bproperty\s*(mgmt|management)\b/i,
];

export function parseSegmentFilter(value: string | null | undefined): SegmentFilter {
  if (value === "residential" || value === "commercial") return value;
  return "all";
}

/** Segment implied by a Jobber timesheet label, or null if it says neither. */
export function segmentFromLabel(
  label: string | null | undefined
): Segment | null {
  if (!label) return null;
  const text = label.trim();
  if (!text) return null;
  // Commercial first: "HOA - Residential Units" is commercial work.
  if (COMMERCIAL_PATTERNS.some((re) => re.test(text))) return "commercial";
  if (RESIDENTIAL_PATTERNS.some((re) => re.test(text))) return "residential";
  return null;
}

export interface ClassifiableEntry {
  label: string | null;
  clientCompanyName: string | null;
}

export interface Classification {
  segment: Segment;
  source: SegmentSource;
}

export function classifyEntry(entry: ClassifiableEntry): Classification {
  const fromLabel = segmentFromLabel(entry.label);
  if (fromLabel) return { segment: fromLabel, source: "label" };
  const hasCompany = !!entry.clientCompanyName?.trim();
  return {
    segment: hasCompany ? "commercial" : "residential",
    source: "client",
  };
}

export function matchesFilter(segment: Segment, filter: SegmentFilter): boolean {
  return filter === "all" || segment === filter;
}

/** Carry the active segment through links, alongside the date-range params. */
export function segmentQueryParam(filter: SegmentFilter): string | null {
  return filter === "all" ? null : filter;
}
