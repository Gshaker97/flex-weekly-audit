// Splitting tracked time into residential vs commercial crew work.
//
// Flexx runs the split through Jobber itself: alongside the individual team
// members, the Timesheets view has two crew accounts — "Residential
// Maintenance" and "Commercial Maintenance" — and the crews clock in under
// those. So the team member a time entry belongs to IS the crew type, and that
// is the primary signal.
//
// Two fallbacks cover time logged under an individual's own account:
//   2. the Jobber time label on the entry, if the crew picked a category
//   3. the client record — a client with a company name is commercial work,
//      an individual is residential
//
// Every entry therefore lands in a segment, and the UI reports how many came
// from each signal so the split is never a black box.

export type Segment = "residential" | "commercial";
export type SegmentFilter = Segment | "all";
export type SegmentSource = "crew" | "label" | "client";

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

/**
 * Segment for a Jobber team member. Deliberately stricter than the label
 * matching below — it only fires on the whole words "residential" and
 * "commercial", so the crew accounts match while a real person's name never
 * does by accident.
 */
export function segmentFromCrewName(
  employeeName: string | null | undefined
): Segment | null {
  if (!employeeName) return null;
  const text = employeeName.trim();
  if (!text) return null;
  if (/\bcommercial\b/i.test(text)) return "commercial";
  if (/\bresidential\b/i.test(text)) return "residential";
  return null;
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
  employeeName: string | null;
  label: string | null;
  clientCompanyName: string | null;
}

export interface Classification {
  segment: Segment;
  source: SegmentSource;
}

export function classifyEntry(entry: ClassifiableEntry): Classification {
  const fromCrew = segmentFromCrewName(entry.employeeName);
  if (fromCrew) return { segment: fromCrew, source: "crew" };

  const fromLabel = segmentFromLabel(entry.label);
  if (fromLabel) return { segment: fromLabel, source: "label" };

  const hasCompany = !!entry.clientCompanyName?.trim();
  return {
    segment: hasCompany ? "commercial" : "residential",
    source: "client",
  };
}

/** Is this team member one of the dedicated crew accounts? */
export function isCrewAccount(employeeName: string | null | undefined): boolean {
  return segmentFromCrewName(employeeName) != null;
}

export function matchesFilter(segment: Segment, filter: SegmentFilter): boolean {
  return filter === "all" || segment === filter;
}

/** Carry the active segment through links, alongside the date-range params. */
export function segmentQueryParam(filter: SegmentFilter): string | null {
  return filter === "all" ? null : filter;
}
