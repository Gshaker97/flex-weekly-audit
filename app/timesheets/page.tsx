import { prisma } from "@/lib/prisma";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { StatCard } from "@/components/ui/StatCard";
import DateRangeFilter from "@/components/ui/DateRangeFilter";
import SegmentToggle from "@/components/ui/SegmentToggle";
import LabourRateInput from "@/components/ui/LabourRateInput";
import { resolveDateRange, getDateRange } from "@/lib/dateRange";
import {
  classifyEntry,
  isCrewAccount,
  matchesFilter,
  parseSegmentFilter,
  SEGMENT_LABELS,
  type Segment,
} from "@/lib/crewSegments";
import {
  formatCurrency,
  formatCurrencyDetailed,
  formatDuration,
  formatHoursDecimal,
  formatDate,
} from "@/lib/utils";
import {
  Clock,
  Briefcase,
  Timer,
  DollarSign,
  Percent,
  ClipboardCheck,
  CalendarCheck,
  AlertCircle,
} from "lucide-react";

export const dynamic = "force-dynamic";

const HOUR = 3600;

export default async function TimesheetsPage({
  searchParams,
}: {
  searchParams: {
    range?: string;
    start?: string;
    end?: string;
    segment?: string;
    rate?: string;
  };
}) {
  const hasFilter =
    !!searchParams.range || !!searchParams.start || !!searchParams.end;
  const range = hasFilter ? resolveDateRange(searchParams) : getDateRange("allTime");
  const segmentFilter = parseSegmentFilter(searchParams.segment);

  const parsedRate = Number(searchParams.rate);
  const manualRate =
    Number.isFinite(parsedRate) && parsedRate > 0 ? parsedRate : null;

  // Entries with no linked visit date fall back to being shown regardless of
  // range, so logged time is never silently dropped.
  const allEntries = await prisma.timeEntry.findMany({
    where: {
      OR: [
        { occurredAt: { gte: range.start, lte: range.end } },
        { occurredAt: null },
      ],
    },
    orderBy: { occurredAt: "desc" },
  });

  // Every visit SCHEDULED in the range, whether or not anyone clocked into it.
  // This is the basis Jobber's own "Recent visits" widget uses, and it's what
  // makes the coverage row below able to reconcile against it.
  const scheduledVisits = await prisma.visitRecord.findMany({
    where: { visitDate: { gte: range.start, lte: range.end } },
    select: { jobberVisitId: true, jobberJobId: true, clientName: true },
  });

  // Job records give each tracked job its value; the customer record is the
  // fallback for classifying entries whose own client company name hasn't been
  // filled in by a sync yet. Jobs behind scheduled visits are included so
  // their value is known even when nobody logged time against them.
  const jobIdList = Array.from(
    new Set(
      [
        ...allEntries.map((e) => e.jobberJobId),
        ...scheduledVisits.map((v) => v.jobberJobId),
      ].filter(Boolean)
    )
  ) as string[];
  const jobRecords = jobIdList.length
    ? await prisma.jobRecord.findMany({
        where: { jobberJobId: { in: jobIdList } },
        select: {
          jobberJobId: true,
          total: true,
          customerId: true,
          jobType: true,
          isRecurring: true,
        },
      })
    : [];
  const jobByJobberId = new Map(jobRecords.map((j) => [j.jobberJobId, j]));

  // Revenue is credited per VISIT, not per whole job, so a one-week view isn't
  // handed a whole season's worth of work.
  //
  // Visit counts per job, so time that isn't linked to a specific visit can
  // still be credited one trip's share instead of the entire job.
  const visitCountRows = jobIdList.length
    ? await prisma.visitRecord.groupBy({
        by: ["jobberJobId"],
        where: { jobberJobId: { in: jobIdList } },
        _count: { _all: true },
      })
    : [];
  const visitCountByJob = new Map(
    visitCountRows.map((r) => [r.jobberJobId as string, r._count._all])
  );

  /**
   * What one visit to a job is worth.
   *
   * Jobber prices a RECURRING job per visit — the job total is what the
   * customer pays for a single trip, however many trips the schedule holds. A
   * ONE-OFF job prices the whole piece of work, so its total spreads across
   * however many visits it takes.
   *
   * Dividing a recurring job's total by its visit count (which includes every
   * future scheduled visit) shrank each visit to a couple of dollars and made
   * revenue collapse.
   */
  function visitValueOf(jobberJobId: string): number {
    const job = jobByJobberId.get(jobberJobId);
    const total = job?.total ?? 0;
    if (total <= 0) return 0;
    if (job?.isRecurring) return total;
    const count = visitCountByJob.get(jobberJobId) ?? 1;
    return count > 0 ? total / count : total;
  }

  /** Value earned on a job by the visits actually worked in this range. */
  function revenueForJob(
    jobberJobId: string | null,
    visitsWorked: Set<string>
  ): number {
    if (!jobberJobId) return 0;
    // Only unlinked time on this job — credit a single trip.
    const trips = visitsWorked.size === 0 ? 1 : visitsWorked.size;
    return trips * visitValueOf(jobberJobId);
  }

  const customerIds = Array.from(
    new Set(jobRecords.map((j) => j.customerId).filter(Boolean))
  ) as string[];
  const customers = customerIds.length
    ? await prisma.customer.findMany({
        where: { id: { in: customerIds } },
        select: { id: true, companyName: true },
      })
    : [];
  const customerById = new Map(customers.map((c) => [c.id, c]));

  function companyNameFor(entry: (typeof allEntries)[number]): string | null {
    if (entry.clientCompanyName?.trim()) return entry.clientCompanyName;
    const job = entry.jobberJobId ? jobByJobberId.get(entry.jobberJobId) : null;
    const customer = job?.customerId ? customerById.get(job.customerId) : null;
    return customer?.companyName ?? null;
  }

  // Classify every entry once, then filter to the selected crew type.
  const classified = allEntries.map((entry) => ({
    entry,
    ...classifyEntry({
      employeeName: entry.employeeName,
      label: entry.label,
      clientCompanyName: companyNameFor(entry),
    }),
  }));

  const bySource = {
    crew: classified.filter((c) => c.source === "crew").length,
    label: classified.filter((c) => c.source === "label").length,
    client: classified.filter((c) => c.source === "client").length,
  };

  // The Jobber crew accounts that actually logged time, so the page names the
  // thing driving the split rather than describing it abstractly.
  const crewAccounts = Array.from(
    new Set(
      classified
        .filter((c) => c.source === "crew")
        .map((c) => c.entry.employeeName)
        .filter(Boolean) as string[]
    )
  ).sort();
  const segmentTotals: Record<Segment, number> = {
    residential: 0,
    commercial: 0,
  };
  for (const c of classified) {
    segmentTotals[c.segment] += c.entry.durationSeconds || 0;
  }

  // Distinct Jobber labels present, so the split can be checked against what
  // the crews actually pick in Jobber.
  const labelSeconds = new Map<string, number>();
  for (const c of classified) {
    const key = c.entry.label?.trim();
    if (!key) continue;
    labelSeconds.set(key, (labelSeconds.get(key) ?? 0) + (c.entry.durationSeconds || 0));
  }
  const labelsSeen = Array.from(labelSeconds.entries()).sort((a, b) => b[1] - a[1]);

  const rows = classified.filter((c) => matchesFilter(c.segment, segmentFilter));
  const entries = rows.map((r) => r.entry);

  // ------------------------------------------------------------------ KPIs
  // Jobber's "General" bucket is time clocked without a job attached — travel,
  // shop time, breaks, or a timer nobody stopped. It is real payroll but it
  // isn't work on a job, so it stays out of the per-job figures and is
  // reported on its own rather than quietly inflating every average.
  const onJobRows = rows.filter(
    (r) => r.entry.jobberJobId || r.entry.jobNumber
  );
  const generalRows = rows.filter(
    (r) => !r.entry.jobberJobId && !r.entry.jobNumber
  );

  const totalSeconds = entries.reduce((a, e) => a + (e.durationSeconds || 0), 0);
  const onJobSeconds = onJobRows.reduce(
    (a, r) => a + (r.entry.durationSeconds || 0),
    0
  );
  const generalSeconds = generalRows.reduce(
    (a, r) => a + (r.entry.durationSeconds || 0),
    0
  );

  const jobKeys = new Set(
    entries.map((e) => e.jobberJobId || e.jobNumber).filter(Boolean)
  );
  const avgSecondsPerJob = jobKeys.size > 0 ? onJobSeconds / jobKeys.size : 0;

  // Hours per visit answers "how long is one trip out to the property", so it
  // must divide visit-linked time by visits. Not every job-linked entry carries
  // a visit — a timer started from the job rather than from a scheduled visit
  // has none — so the numerator is restricted to entries that do, otherwise
  // unlinked time would inflate the average against a smaller denominator.
  const visitRows = onJobRows.filter((r) => r.entry.visitId);
  const visitIds = new Set(visitRows.map((r) => r.entry.visitId as string));
  const visitLinkedSeconds = visitRows.reduce(
    (a, r) => a + (r.entry.durationSeconds || 0),
    0
  );
  const avgSecondsPerVisit =
    visitIds.size > 0 ? visitLinkedSeconds / visitIds.size : null;
  // How much of the on-job time this average actually covers.
  const visitCoverage =
    onJobSeconds > 0 ? (visitLinkedSeconds / onJobSeconds) * 100 : 0;

  // A single entry longer than this is almost certainly a timer left running,
  // which is what Jobber's own warning triangles flag. Surfaced so a runaway
  // timer is visible rather than silently swelling the hours and the cost.
  const LONG_ENTRY_SECONDS = 14 * HOUR;
  const longEntries = entries.filter(
    (e) => (e.durationSeconds || 0) > LONG_ENTRY_SECONDS
  );
  const longEntrySeconds = longEntries.reduce(
    (a, e) => a + (e.durationSeconds || 0),
    0
  );

  // Labour cost prefers Jobber's own rate on the entry; the blended rate in the
  // toolbar covers entries that don't carry one.
  let costedSeconds = 0;
  let uncostedSeconds = 0;
  const labourCost = entries.reduce((sum, e) => {
    const seconds = e.durationSeconds || 0;
    const rate = e.labourRate ?? manualRate;
    if (rate == null) {
      uncostedSeconds += seconds;
      return sum;
    }
    costedSeconds += seconds;
    return sum + (seconds / HOUR) * rate;
  }, 0);
  const hasCost = costedSeconds > 0;

  // Which visits of each job were actually worked in this range. A job that
  // only has unlinked time still gets an entry with an empty set, so it is
  // credited one trip's share rather than being dropped.
  const visitsWorkedByJob = new Map<string, Set<string>>();
  for (const { entry: e } of onJobRows) {
    if (!e.jobberJobId) continue;
    const worked = visitsWorkedByJob.get(e.jobberJobId) ?? new Set<string>();
    if (e.visitId) worked.add(e.visitId);
    visitsWorkedByJob.set(e.jobberJobId, worked);
  }

  // Revenue earned in this range: the value of the visits worked, not the full
  // value of every job those visits belong to. A season-long recurring job
  // contributes one trip's share to a one-week view, not the whole contract.
  const jobRevenue = Array.from(visitsWorkedByJob).reduce(
    (sum, [jobberJobId, worked]) => sum + revenueForJob(jobberJobId, worked),
    0
  );

  // ------------------------------------------------- scheduled vs serviced
  // What was on the schedule, against what actually got time logged. A visit
  // with no time entry has no crew to classify it by, so these fall back to
  // the client: a company is commercial work, an individual is residential.
  const scheduledInSegment = scheduledVisits.filter((v) => {
    if (segmentFilter === "all") return true;
    const job = v.jobberJobId ? jobByJobberId.get(v.jobberJobId) : null;
    const customer = job?.customerId ? customerById.get(job.customerId) : null;
    const { segment } = classifyEntry({
      employeeName: null,
      label: null,
      clientCompanyName: customer?.companyName ?? null,
    });
    return matchesFilter(segment, segmentFilter);
  });

  const scheduledJobIds = new Set(
    scheduledInSegment.map((v) => v.jobberJobId).filter(Boolean) as string[]
  );
  // Jobs that were worked but whose visits sit outside the range still count
  // as scheduled work for this view, so coverage can never exceed 100%.
  for (const key of jobKeys) scheduledJobIds.add(key as string);

  const expectedRevenue = scheduledInSegment.reduce(
    (sum, v) => sum + (v.jobberJobId ? visitValueOf(v.jobberJobId) : 0),
    0
  );

  const servicedVisitIds = new Set<string>();
  for (const worked of visitsWorkedByJob.values()) {
    for (const id of worked) servicedVisitIds.add(id);
  }
  const scheduledVisitCount = scheduledInSegment.length;
  const servicedVisitCount = scheduledInSegment.filter((v) =>
    servicedVisitIds.has(v.jobberVisitId)
  ).length;

  const jobCoverage =
    scheduledJobIds.size > 0 ? (jobKeys.size / scheduledJobIds.size) * 100 : null;
  // Scheduled work carrying no logged time. Clamped, since a job worked in
  // range whose visits fall outside it can earn more than this view scheduled.
  const untrackedRevenue = Math.max(0, expectedRevenue - jobRevenue);
  const untrackedShare =
    expectedRevenue > 0 ? (untrackedRevenue / expectedRevenue) * 100 : null;

  const labourShare =
    hasCost && jobRevenue > 0 ? (labourCost / jobRevenue) * 100 : null;
  // What an hour on site is worth. Uses on-job time, since General hours
  // aren't what earned the revenue.
  const revenuePerHour =
    jobRevenue > 0 && onJobSeconds > 0
      ? jobRevenue / (onJobSeconds / HOUR)
      : null;

  // -------------------------------------------------------------- rollups
  const byEmployee = new Map<
    string,
    {
      name: string;
      seconds: number;
      residentialSeconds: number;
      commercialSeconds: number;
      jobs: Set<string>;
      entries: number;
      cost: number;
      costed: boolean;
    }
  >();
  for (const { entry: e, segment } of rows) {
    const key = e.employeeId || e.employeeName || "Unknown";
    const ex = byEmployee.get(key) ?? {
      name: e.employeeName || "Unknown",
      seconds: 0,
      residentialSeconds: 0,
      commercialSeconds: 0,
      jobs: new Set<string>(),
      entries: 0,
      cost: 0,
      costed: false,
    };
    const seconds = e.durationSeconds || 0;
    ex.seconds += seconds;
    if (segment === "residential") ex.residentialSeconds += seconds;
    else ex.commercialSeconds += seconds;
    if (e.jobberJobId) ex.jobs.add(e.jobberJobId);
    ex.entries += 1;
    const rate = e.labourRate ?? manualRate;
    if (rate != null) {
      ex.cost += (seconds / HOUR) * rate;
      ex.costed = true;
    }
    byEmployee.set(key, ex);
  }
  const employees = Array.from(byEmployee.values()).sort(
    (a, b) => b.seconds - a.seconds
  );

  const byJob = new Map<
    string,
    {
      jobberJobId: string | null;
      jobNumber: string | null;
      jobTitle: string | null;
      clientName: string | null;
      segment: Segment;
      seconds: number;
      crew: Set<string>;
      visits: Set<string>;
      entries: number;
      firstAt: Date | null;
      lastAt: Date | null;
      ticking: boolean;
      cost: number;
      costed: boolean;
      revenue: number;
    }
  >();
  for (const { entry: e, segment } of onJobRows) {
    const key = e.jobberJobId || `#${e.jobNumber}`;
    const ex = byJob.get(key) ?? {
      jobberJobId: e.jobberJobId,
      jobNumber: e.jobNumber,
      jobTitle: e.jobTitle,
      clientName: e.clientName,
      segment,
      seconds: 0,
      crew: new Set<string>(),
      visits: new Set<string>(),
      entries: 0,
      firstAt: null as Date | null,
      lastAt: null as Date | null,
      ticking: false,
      cost: 0,
      costed: false,
      // Filled in after the loop, once every visit worked is known.
      revenue: 0,
    };
    const seconds = e.durationSeconds || 0;
    ex.seconds += seconds;
    if (e.employeeName) ex.crew.add(e.employeeName);
    if (e.visitId) ex.visits.add(e.visitId);
    ex.entries += 1;
    if (e.occurredAt && (!ex.lastAt || e.occurredAt > ex.lastAt)) ex.lastAt = e.occurredAt;
    if (e.occurredAt && (!ex.firstAt || e.occurredAt < ex.firstAt)) ex.firstAt = e.occurredAt;
    if (e.ticking) ex.ticking = true;
    const rate = e.labourRate ?? manualRate;
    if (rate != null) {
      ex.cost += (seconds / HOUR) * rate;
      ex.costed = true;
    }
    byJob.set(key, ex);
  }
  // Credit each job only the value of the visits worked in this range, so the
  // table's revenue column adds up to the Revenue Generated stat above it.
  for (const job of byJob.values()) {
    job.revenue = revenueForJob(job.jobberJobId, job.visits);
  }
  const jobs = Array.from(byJob.values()).sort((a, b) => b.seconds - a.seconds);

  const segmentNoun =
    segmentFilter === "all" ? "all crews" : `${SEGMENT_LABELS[segmentFilter]} crews`;
  const showSplitColumns = segmentFilter === "all";

  // Flexx logs everything under the two Jobber crew accounts rather than under
  // individual people, so when that's all we see, call them crews — counting
  // them as "crew members" would read as a headcount, which it isn't.
  const loggingAccounts = Array.from(
    new Set(entries.map((e) => e.employeeName).filter(Boolean))
  ) as string[];
  const crewAccountsOnly =
    loggingAccounts.length > 0 && loggingAccounts.every(isCrewAccount);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Time Tracking</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Hours clocked in and time on the job site, from Jobber timesheets.
            Showing <span className="font-medium text-foreground">{segmentNoun}</span>{" "}
            for <span className="font-medium text-foreground">{range.label}</span>.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <SegmentToggle current={segmentFilter} />
          <LabourRateInput current={manualRate} />
          <DateRangeFilter defaultPreset="allTime" />
        </div>
      </div>

      {allEntries.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="text-sm text-muted-foreground">
              No timesheet entries found. Make sure the time-tracking scope is enabled,
              you&apos;ve reconnected Jobber, and a sync has run since then.
            </p>
          </CardContent>
        </Card>
      ) : entries.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="text-sm text-muted-foreground">
              No {segmentNoun} time logged in this range. Try another crew type or a
              wider date range.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <StatCard
              label="Total Hours"
              value={`${formatHoursDecimal(totalSeconds)} h`}
              sublabel={
                generalSeconds > 0
                  ? `${formatHoursDecimal(onJobSeconds)} h on jobs · ${formatHoursDecimal(
                      generalSeconds
                    )} h general`
                  : `Tracked on site · ${segmentNoun}`
              }
              accent="brand"
              icon={<Clock size={18} />}
            />
            <StatCard
              label="Jobs Worked"
              value={jobKeys.size}
              sublabel="Jobs with logged time"
              icon={<Briefcase size={18} />}
            />
            <StatCard
              label="Revenue Generated"
              value={jobRevenue > 0 ? formatCurrency(jobRevenue) : "—"}
              sublabel={
                jobRevenue > 0
                  ? `Earned in range across ${jobKeys.size} job${
                      jobKeys.size === 1 ? "" : "s"
                    }${
                      revenuePerHour != null
                        ? ` · ${formatCurrency(revenuePerHour)}/hr`
                        : ""
                    }`
                  : "No job value on the visits worked"
              }
              accent="brand"
              icon={<DollarSign size={18} />}
            />
            <StatCard
              label="Avg Hours per Job"
              value={`${formatHoursDecimal(avgSecondsPerJob)} h`}
              sublabel={`A whole job, every visit added up · ${jobKeys.size} job${
                jobKeys.size === 1 ? "" : "s"
              }`}
              icon={<Timer size={18} />}
            />
            <StatCard
              label="Avg Hours per Visit"
              value={
                avgSecondsPerVisit != null
                  ? `${formatHoursDecimal(avgSecondsPerVisit)} h`
                  : "—"
              }
              sublabel={
                avgSecondsPerVisit == null
                  ? "Needs a sync to link entries to visits"
                  : visitCoverage < 99
                  ? `One trip out to the property · ${visitIds.size} visit${
                      visitIds.size === 1 ? "" : "s"
                    }, ${Math.round(visitCoverage)}% of on-job time`
                  : `One trip out to the property · ${visitIds.size} visit${
                      visitIds.size === 1 ? "" : "s"
                    }`
              }
              icon={<Timer size={18} />}
            />
            <StatCard
              label="Labor Cost vs Revenue"
              value={hasCost ? formatCurrency(labourCost) : "—"}
              sublabel={
                hasCost
                  ? labourShare != null
                    ? `${labourShare.toFixed(1)}% of the revenue generated`
                    : "Wages for the hours logged"
                  : "Set an hourly rate above to cost these hours"
              }
              accent={
                labourShare == null
                  ? "default"
                  : labourShare > 50
                  ? "danger"
                  : labourShare > 35
                  ? "warning"
                  : "success"
              }
              icon={hasCost ? <DollarSign size={18} /> : <Percent size={18} />}
            />
          </div>

          {/* What was on the schedule, against what actually got tracked. */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatCard
              label="Jobs With Time Logged"
              value={
                scheduledJobIds.size > 0
                  ? `${jobKeys.size} of ${scheduledJobIds.size}`
                  : String(jobKeys.size)
              }
              sublabel={
                jobCoverage != null
                  ? `${Math.round(jobCoverage)}% of the jobs scheduled in range`
                  : "Jobs with any time logged"
              }
              accent={
                jobCoverage == null
                  ? "default"
                  : jobCoverage >= 80
                  ? "success"
                  : jobCoverage >= 50
                  ? "warning"
                  : "danger"
              }
              icon={<ClipboardCheck size={18} />}
            />
            <StatCard
              label="Expected Revenue"
              value={expectedRevenue > 0 ? formatCurrency(expectedRevenue) : "—"}
              sublabel={
                scheduledVisitCount > 0
                  ? `If all ${scheduledVisitCount} visit${
                      scheduledVisitCount === 1 ? "" : "s"
                    } scheduled in range are serviced`
                  : "No visits scheduled in this range"
              }
              accent="brand"
              icon={<CalendarCheck size={18} />}
            />
            <StatCard
              label="Revenue Not Time-Tracked"
              value={
                expectedRevenue > 0 ? formatCurrency(untrackedRevenue) : "—"
              }
              sublabel={
                untrackedShare != null
                  ? `${Math.round(
                      untrackedShare
                    )}% of expected · ${servicedVisitCount} of ${scheduledVisitCount} visits have time`
                  : "Nothing scheduled to compare against"
              }
              accent={
                untrackedShare == null
                  ? "default"
                  : untrackedShare > 50
                  ? "danger"
                  : untrackedShare > 20
                  ? "warning"
                  : "success"
              }
              icon={<AlertCircle size={18} />}
            />
          </div>

          <Card>
            <CardContent className="space-y-2 py-4 text-xs text-muted-foreground">
              {scheduledVisitCount > 0 && (
                <p>
                  <span className="font-medium text-foreground">
                    Scheduled vs time-tracked:
                  </span>{" "}
                  Jobber counts every visit on the schedule; this page can only
                  credit revenue to visits your crews clocked into. That is why
                  Expected Revenue matches Jobber&apos;s visit widget while Revenue
                  Generated is lower — the difference is work that happened without
                  time logged against a job, most of it sitting in the General
                  bucket. Visits with no time entry have no crew to classify them,
                  so they fall back to the client: a company counts as commercial,
                  an individual as residential.
                </p>
              )}
              <p>
                <span className="font-medium text-foreground">
                  Hours per job vs hours per visit:
                </span>{" "}
                a <span className="font-medium text-foreground">visit</span> is one trip
                out to the property. A{" "}
                <span className="font-medium text-foreground">job</span> is the whole
                piece of work, which for recurring customers is many visits over months.
                {avgSecondsPerVisit != null && jobKeys.size > 0 && (
                  <>
                    {" "}
                    Here a job averages {formatHoursDecimal(avgSecondsPerJob)} h in
                    total but only {formatHoursDecimal(avgSecondsPerVisit)} h per trip
                    {visitIds.size >= jobKeys.size && (
                      <>
                        {" "}
                        — about {Math.round(visitIds.size / jobKeys.size)} visit
                        {Math.round(visitIds.size / jobKeys.size) === 1 ? "" : "s"} per
                        job
                      </>
                    )}
                    .
                  </>
                )}{" "}
                Use <span className="font-medium text-foreground">per visit</span> to
                price and schedule a single stop, and{" "}
                <span className="font-medium text-foreground">per job</span> to see what
                an account has cost you in total.
              </p>
              <p>
                <span className="font-medium text-foreground">How crews are split:</span>{" "}
                {crewAccounts.length > 0 ? (
                  <>
                    {bySource.crew} of {classified.length} entries were logged under
                    your Jobber crew accounts ({crewAccounts.join(", ")}).
                  </>
                ) : (
                  <>
                    no time was logged under a Jobber crew account named
                    &ldquo;Residential&rdquo; or &ldquo;Commercial&rdquo; in this range.
                  </>
                )}
                {bySource.label > 0 && (
                  <> {bySource.label} came from a Jobber time label.</>
                )}
                {bySource.client > 0 && (
                  <>
                    {" "}
                    {bySource.client} were logged under an individual&apos;s own account
                    and are classified by client type (company = commercial).
                  </>
                )}{" "}
                Residential {formatDuration(segmentTotals.residential)} · Commercial{" "}
                {formatDuration(segmentTotals.commercial)}.
              </p>
              {labelsSeen.length > 0 && (
                <p className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium text-foreground">Jobber labels seen:</span>
                  {labelsSeen.map(([label, seconds]) => (
                    <Badge key={label} variant="muted">
                      {label} · {formatDuration(seconds)}
                    </Badge>
                  ))}
                </p>
              )}
              {generalSeconds > 0 && (
                <p>
                  <span className="font-medium text-foreground">
                    General (not on a job):
                  </span>{" "}
                  {formatDuration(generalSeconds)} across {generalRows.length}{" "}
                  {generalRows.length === 1 ? "entry" : "entries"} — Jobber&apos;s
                  General bucket is time clocked without a job attached (travel, shop
                  time, breaks, or a timer left running). It counts toward total hours
                  and labor cost but is left out of the per-job table and the per-job
                  averages.
                </p>
              )}
              {longEntries.length > 0 && (
                <p className="text-warning">
                  <span className="font-medium">Check these:</span>{" "}
                  {longEntries.length}{" "}
                  {longEntries.length === 1 ? "entry runs" : "entries run"} longer than
                  14 hours ({formatDuration(longEntrySeconds)} in total) — usually a
                  timer nobody stopped. Fix them in Jobber and re-sync, or these hours
                  will overstate the totals and the labor cost.
                </p>
              )}
              {uncostedSeconds > 0 && hasCost && (
                <p>
                  {formatDuration(uncostedSeconds)} has no labour rate and is excluded
                  from the labor cost.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Time on Site by Job</CardTitle>
              <CardDescription>
                Every job with logged time, longest first — how long it took, who worked
                it, and what it billed.
                {generalSeconds > 0 && " General (no-job) time is excluded."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {jobs.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border py-10 text-center">
                  <p className="text-sm text-muted-foreground">
                    No time was logged against a specific job in this range — all of it
                    sits in Jobber&apos;s General bucket.
                  </p>
                </div>
              ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[860px] text-sm">
                  <thead className="bg-muted/50">
                    <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-2.5 font-medium">Job</th>
                      <th className="px-4 py-2.5 font-medium">Customer</th>
                      <th className="px-4 py-2.5 font-medium">Type</th>
                      <th className="px-4 py-2.5 font-medium">Last worked</th>
                      <th className="px-4 py-2.5 font-medium">Logged by</th>
                      <th className="px-4 py-2.5 font-medium">Visits</th>
                      <th className="px-4 py-2.5 font-medium">Time on site</th>
                      <th className="px-4 py-2.5 font-medium">Labor cost</th>
                      <th className="px-4 py-2.5 font-medium">Revenue</th>
                      <th className="px-4 py-2.5 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {jobs.map((j, i) => {
                      const share =
                        j.costed && j.revenue > 0 ? (j.cost / j.revenue) * 100 : null;
                      return (
                        <tr key={i} className="hover:bg-muted/30">
                          <td className="px-4 py-3">
                            <div className="font-medium">
                              {j.jobNumber ? `#${j.jobNumber}` : "—"}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {j.jobTitle ?? ""}
                            </div>
                          </td>
                          <td className="px-4 py-3">{j.clientName ?? "—"}</td>
                          <td className="px-4 py-3">
                            <Badge
                              variant={j.segment === "commercial" ? "default" : "muted"}
                            >
                              {SEGMENT_LABELS[j.segment]}
                            </Badge>
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {formatDate(j.lastAt)}
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {j.crew.size > 0 ? (
                              <span title={Array.from(j.crew).join(", ")}>
                                {Array.from(j.crew)[0]}
                                {j.crew.size > 1 && ` +${j.crew.size - 1}`}
                              </span>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {j.visits.size || "—"}
                          </td>
                          <td className="px-4 py-3 font-semibold">
                            {formatDuration(j.seconds)}
                          </td>
                          <td className="px-4 py-3">
                            {j.costed ? (
                              <>
                                {formatCurrencyDetailed(j.cost)}
                                {share != null && (
                                  <span className="ml-1 text-xs text-muted-foreground">
                                    ({share.toFixed(0)}%)
                                  </span>
                                )}
                              </>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            {j.revenue > 0 ? (
                              formatCurrencyDetailed(j.revenue)
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            {j.ticking ? (
                              <Badge variant="success">Clocked in now</Badge>
                            ) : (
                              <Badge variant="muted">Started</Badge>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>
                {crewAccountsOnly ? "Hours by Crew" : "Hours by Crew Member"}
              </CardTitle>
              <CardDescription>
                {showSplitColumns
                  ? `Total time clocked in, split by the work each ${
                      crewAccountsOnly ? "crew" : "person"
                    } spent it on.`
                  : `Total time clocked in on ${segmentNoun}.`}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="bg-muted/50">
                    <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-2.5 font-medium">
                        {crewAccountsOnly ? "Crew" : "Crew member"}
                      </th>
                      {showSplitColumns && (
                        <>
                          <th className="px-4 py-2.5 font-medium">Residential</th>
                          <th className="px-4 py-2.5 font-medium">Commercial</th>
                        </>
                      )}
                      <th className="px-4 py-2.5 font-medium">Time on site</th>
                      <th className="px-4 py-2.5 font-medium">Jobs</th>
                      <th className="px-4 py-2.5 font-medium">Entries</th>
                      <th className="px-4 py-2.5 font-medium">Labor cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {employees.map((e, i) => (
                      <tr key={i} className="hover:bg-muted/30">
                        <td className="px-4 py-3">
                          <span className="font-medium">{e.name}</span>
                          {isCrewAccount(e.name) && (
                            <Badge variant="muted" className="ml-2">
                              Crew account
                            </Badge>
                          )}
                        </td>
                        {showSplitColumns && (
                          <>
                            <td className="px-4 py-3 text-muted-foreground">
                              {formatDuration(e.residentialSeconds)}
                            </td>
                            <td className="px-4 py-3 text-muted-foreground">
                              {formatDuration(e.commercialSeconds)}
                            </td>
                          </>
                        )}
                        <td className="px-4 py-3 font-semibold">
                          {formatDuration(e.seconds)}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{e.jobs.size}</td>
                        <td className="px-4 py-3 text-muted-foreground">{e.entries}</td>
                        <td className="px-4 py-3">
                          {e.costed ? (
                            formatCurrencyDetailed(e.cost)
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
