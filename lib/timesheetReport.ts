import { prisma } from "@/lib/prisma";
import type { DateRange } from "@/lib/dateRange";
import { SEGMENT_LABELS, type SegmentFilter } from "@/lib/crewSegments";
import { computeTimesheetData, HOUR } from "@/lib/timesheetData";
import type { CellValue, ReportData, ReportSection } from "@/lib/report";
import {
  formatCurrency,
  formatCurrencyDetailed,
  formatHoursDecimal,
  formatNumber,
  formatPercent,
} from "@/lib/utils";

// The Time Tracking page as a downloadable report. It reads the same
// computeTimesheetData() the page renders, so every figure here is the figure
// on screen — no second implementation to drift.

function hours(seconds: number): number {
  return Math.round((seconds / HOUR) * 100) / 100;
}

export async function buildTimesheetReport(opts: {
  range: DateRange;
  segmentFilter: SegmentFilter;
  manualRate: number | null;
}): Promise<ReportData> {
  const { range, segmentFilter, manualRate } = opts;
  const d = await computeTimesheetData({ range, segmentFilter, manualRate });

  const lastSync = await prisma.syncRun.findFirst({
    where: { status: "complete" },
    orderBy: { completedAt: "desc" },
  });

  const crewNoun =
    segmentFilter === "all"
      ? "All crews"
      : `${SEGMENT_LABELS[segmentFilter]} crews`;

  const summary = [
    {
      label: "Crew Filter",
      value: crewNoun,
      detail:
        segmentFilter === "all"
          ? `Residential ${formatHoursDecimal(
              d.segmentTotals.residential
            )} h · Commercial ${formatHoursDecimal(d.segmentTotals.commercial)} h`
          : "Only this crew type is included below",
    },
    {
      label: "Total Hours",
      value: `${formatHoursDecimal(d.totalSeconds)} h`,
      detail:
        d.generalSeconds > 0
          ? `${formatHoursDecimal(d.onJobSeconds)} h on jobs · ${formatHoursDecimal(
              d.generalSeconds
            )} h general (no job attached)`
          : "All tracked against a job",
    },
    {
      label: "Jobs Worked",
      value: formatNumber(d.jobKeys.size),
      detail: `${formatNumber(d.entries.length)} time entries`,
    },
    {
      label: "Revenue Generated",
      value: d.jobRevenue > 0 ? formatCurrencyDetailed(d.jobRevenue) : "—",
      detail:
        d.revenuePerHour != null
          ? `${formatCurrency(d.revenuePerHour)} per on-job hour`
          : "Value of the visits worked in range",
    },
    {
      label: "Avg Hours per Job",
      value: `${formatHoursDecimal(d.avgSecondsPerJob)} h`,
      detail: "A whole job, every visit added up",
    },
    {
      label: "Avg Hours per Visit",
      value:
        d.avgSecondsPerVisit != null
          ? `${formatHoursDecimal(d.avgSecondsPerVisit)} h`
          : "—",
      detail:
        d.avgSecondsPerVisit != null
          ? `One trip out · ${d.visitIds.size} visits, ${Math.round(
              d.visitCoverage
            )}% of on-job time is visit-linked`
          : "No entries are linked to a visit",
    },
    {
      label: "Labor Cost",
      value: d.hasCost ? formatCurrencyDetailed(d.labourCost) : "—",
      detail:
        d.labourShare != null
          ? `${formatPercent(d.labourShare, 1)} of revenue generated`
          : "Set an hourly rate to cost these hours",
    },
    {
      label: "Jobs With Time Logged",
      value:
        d.scheduledJobIds.size > 0
          ? `${d.jobKeys.size} of ${d.scheduledJobIds.size}`
          : formatNumber(d.jobKeys.size),
      detail:
        d.jobCoverage != null
          ? `${Math.round(d.jobCoverage)}% of jobs scheduled in range`
          : "No jobs scheduled in range",
    },
    {
      label: "Expected Revenue",
      value: d.expectedRevenue > 0 ? formatCurrencyDetailed(d.expectedRevenue) : "—",
      detail: `If all ${formatNumber(
        d.scheduledVisitCount
      )} visits scheduled in range are serviced`,
    },
    {
      label: "Revenue Not Time-Tracked",
      value:
        d.expectedRevenue > 0 ? formatCurrencyDetailed(d.untrackedRevenue) : "—",
      detail:
        d.untrackedShare != null
          ? `${Math.round(d.untrackedShare)}% of expected · ${
              d.servicedVisitCount
            } of ${d.scheduledVisitCount} visits have time`
          : "Nothing scheduled to compare against",
    },
    {
      label: "General (No Job)",
      value: `${formatHoursDecimal(d.generalSeconds)} h`,
      detail: `${formatNumber(
        d.generalRows.length
      )} entries clocked without a job attached`,
    },
    {
      label: "Entries Over 14 Hours",
      value: formatNumber(d.longEntries.length),
      detail:
        d.longEntries.length > 0
          ? `${formatHoursDecimal(
              d.longEntrySeconds
            )} h — usually a timer left running`
          : "None — no runaway timers",
    },
  ];

  const sections: ReportSection[] = [];

  sections.push({
    key: "crew",
    title: "Hours by Crew",
    description:
      "Every Jobber account that logged time in range, most hours first.",
    columns: [
      { header: "Crew / Team Member", type: "text" },
      { header: "Hours", type: "number" },
      { header: "Residential h", type: "number" },
      { header: "Commercial h", type: "number" },
      { header: "Jobs", type: "int" },
      { header: "Entries", type: "int" },
      { header: "Labor Cost", type: "currency" },
    ],
    rows: d.employees.map((e) => [
      e.name,
      hours(e.seconds),
      hours(e.residentialSeconds),
      hours(e.commercialSeconds),
      e.jobs.size,
      e.entries,
      e.costed ? e.cost : null,
    ]) as CellValue[][],
  });

  sections.push({
    key: "jobs",
    title: "Time on Site by Job",
    description:
      "Every job with logged time, longest first. General (no-job) time is excluded.",
    columns: [
      { header: "Job #", type: "text" },
      { header: "Title", type: "text" },
      { header: "Customer", type: "text" },
      { header: "Crew Type", type: "text" },
      { header: "Logged By", type: "text" },
      { header: "Visits", type: "int" },
      { header: "Hours", type: "number" },
      { header: "Labor Cost", type: "currency" },
      { header: "Revenue", type: "currency" },
      { header: "Labor %", type: "number" },
      { header: "First Worked", type: "date" },
      { header: "Last Worked", type: "date" },
      { header: "Clocked In Now", type: "bool" },
    ],
    rows: d.jobs.map((j) => [
      j.jobNumber ? `#${j.jobNumber}` : null,
      j.jobTitle,
      j.clientName,
      SEGMENT_LABELS[j.segment],
      Array.from(j.crew).join(", ") || null,
      j.visits.size,
      hours(j.seconds),
      j.costed ? j.cost : null,
      j.revenue > 0 ? j.revenue : null,
      j.costed && j.revenue > 0
        ? Math.round((j.cost / j.revenue) * 1000) / 10
        : null,
      j.firstAt,
      j.lastAt,
      j.ticking,
    ]) as CellValue[][],
  });

  // The actionable gap: scheduled work nobody clocked into.
  const untrackedByJob = new Map<
    string,
    {
      jobNumber: string | null;
      title: string | null;
      clientName: string | null;
      visits: number;
      revenue: number;
      lastScheduled: Date | null;
    }
  >();
  for (const v of d.scheduledInSegment) {
    if (!v.jobberJobId || d.jobKeys.has(v.jobberJobId)) continue;
    const ex = untrackedByJob.get(v.jobberJobId) ?? {
      jobNumber: v.jobNumber,
      title: v.title,
      clientName: v.clientName,
      visits: 0,
      revenue: 0,
      lastScheduled: null as Date | null,
    };
    ex.visits += 1;
    ex.revenue += d.visitValueOf(v.jobberJobId);
    if (v.visitDate && (!ex.lastScheduled || v.visitDate > ex.lastScheduled)) {
      ex.lastScheduled = v.visitDate;
    }
    untrackedByJob.set(v.jobberJobId, ex);
  }
  sections.push({
    key: "untracked",
    title: "Jobs Scheduled With No Time Logged",
    description:
      "Visits on the schedule in this range that no crew clocked into. This is the gap between Expected Revenue and Revenue Generated, job by job.",
    columns: [
      { header: "Job #", type: "text" },
      { header: "Title", type: "text" },
      { header: "Customer", type: "text" },
      { header: "Visits Scheduled", type: "int" },
      { header: "Expected Revenue", type: "currency" },
      { header: "Last Scheduled", type: "date" },
    ],
    rows: Array.from(untrackedByJob.values())
      .sort((a, b) => b.revenue - a.revenue)
      .map((j) => [
        j.jobNumber ? `#${j.jobNumber}` : null,
        j.title,
        j.clientName,
        j.visits,
        j.revenue,
        j.lastScheduled,
      ]) as CellValue[][],
  });

  sections.push({
    key: "entries",
    title: "Time Entries",
    description:
      "Every entry logged in range, newest first. \"General\" means no job was attached.",
    columns: [
      { header: "Date", type: "date" },
      { header: "Crew / Team Member", type: "text" },
      { header: "Crew Type", type: "text" },
      { header: "Customer", type: "text" },
      { header: "Job #", type: "text" },
      { header: "Job Title", type: "text" },
      { header: "Visit-Linked", type: "bool" },
      { header: "Hours", type: "number" },
      { header: "Rate", type: "currency" },
      { header: "Cost", type: "currency" },
      { header: "Jobber Label", type: "text" },
      { header: "Approved", type: "bool" },
    ],
    rows: d.rows.map(({ entry: e, segment }) => {
      const rate = e.labourRate ?? manualRate;
      const seconds = e.durationSeconds || 0;
      const onJob = !!(e.jobberJobId || e.jobNumber);
      return [
        e.occurredAt,
        e.employeeName,
        SEGMENT_LABELS[segment],
        e.clientName,
        onJob ? (e.jobNumber ? `#${e.jobNumber}` : "—") : "General",
        e.jobTitle,
        !!e.visitId,
        hours(seconds),
        rate,
        rate != null ? (seconds / HOUR) * rate : null,
        e.label,
        e.approved,
      ] as CellValue[];
    }),
  });

  return {
    businessName: "Flexx Landscaping",
    reportTitle: "Time Tracking Report",
    rangeLabel: `${range.label} · ${crewNoun}`,
    rangeStart: range.start,
    rangeEnd: range.end,
    generatedAt: new Date(),
    lastSyncAt: lastSync?.completedAt ?? null,
    summary,
    sections,
  };
}
