import { prisma } from "@/lib/prisma";
import type { DateRange } from "@/lib/dateRange";
import {
  classifyEntry,
  isCrewAccount,
  matchesFilter,
  parseSegmentFilter,
  SEGMENT_LABELS,
  type Segment,
  type SegmentFilter,
} from "@/lib/crewSegments";

// Every number the Time Tracking page shows, computed in one place.
//
// The page renders this and the downloadable report serialises it, so the two
// can never drift apart — which matters here, because several of these figures
// (per-visit revenue, on-job vs General hours, scheduled vs serviced) have
// subtle definitions that were easy to get wrong twice.

export const HOUR = 3600;

interface WorkedOnJob {
  visitIds: Set<string>;
  linkedDays: Set<string>;
  unlinkedDays: Set<string>;
}

/** Local calendar day of an entry; entries with no date share one bucket. */
function dayKey(at: Date | null): string {
  if (!at) return "unknown";
  return `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}`;
}

export interface TimesheetDataInput {
  range: DateRange;
  segmentFilter: SegmentFilter;
  manualRate: number | null;
}

export async function computeTimesheetData({
  range,
  segmentFilter,
  manualRate,
}: TimesheetDataInput) {
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
    select: {
      jobberVisitId: true,
      jobberJobId: true,
      jobNumber: true,
      title: true,
      clientName: true,
      visitDate: true,
    },
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

  /**
   * How many trips a job was serviced in this range.
   *
   * Visit-linked entries are counted directly. A timer started from the job
   * rather than from a scheduled visit carries no visit, so those are counted
   * by DISTINCT DAY instead — a crew that services a property four times does
   * it on four different days. Days already covered by a visit-linked entry
   * aren't counted twice.
   *
   * Capped at the job's scheduled visit count, so a multi-day one-off install
   * can't be credited more trips than the schedule holds. Two separate trips
   * to the same property on the same day still count once; undercounting is
   * the safer error.
   */
  function tripsForJob(jobberJobId: string, worked: WorkedOnJob): number {
    let extraDays = 0;
    for (const day of worked.unlinkedDays) {
      if (!worked.linkedDays.has(day)) extraDays += 1;
    }
    const trips = Math.max(1, worked.visitIds.size + extraDays);
    const scheduled = visitCountByJob.get(jobberJobId) ?? 0;
    return scheduled > 0 ? Math.min(trips, scheduled) : trips;
  }

  /** Value earned on a job by the trips actually worked in this range. */
  function revenueForJob(jobberJobId: string | null): number {
    if (!jobberJobId) return 0;
    const worked = workedByJob.get(jobberJobId);
    if (!worked) return 0;
    return tripsForJob(jobberJobId, worked) * visitValueOf(jobberJobId);
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

  // What each job was serviced with in this range: the visits we can see, plus
  // the days that carry time with no visit attached.
  const workedByJob = new Map<string, WorkedOnJob>();
  for (const { entry: e } of onJobRows) {
    if (!e.jobberJobId) continue;
    const worked =
      workedByJob.get(e.jobberJobId) ??
      ({
        visitIds: new Set<string>(),
        linkedDays: new Set<string>(),
        unlinkedDays: new Set<string>(),
      } as WorkedOnJob);
    const day = dayKey(e.occurredAt);
    if (e.visitId) {
      worked.visitIds.add(e.visitId);
      worked.linkedDays.add(day);
    } else {
      worked.unlinkedDays.add(day);
    }
    workedByJob.set(e.jobberJobId, worked);
  }

  // Revenue earned in this range: the value of the trips worked, not the full
  // value of every job those trips belong to. A season-long recurring job
  // contributes one trip's share to a one-week view, not the whole contract.
  const jobRevenue = Array.from(workedByJob.keys()).reduce(
    (sum, jobberJobId) => sum + revenueForJob(jobberJobId),
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
  for (const worked of workedByJob.values()) {
    for (const id of worked.visitIds) servicedVisitIds.add(id);
  }
  // Trips actually serviced, counted the same way revenue is — so the card
  // can't credit sixteen trips of revenue while reporting four.
  const servicedTrips = Array.from(workedByJob).reduce(
    (sum, [jobberJobId, worked]) => sum + tripsForJob(jobberJobId, worked),
    0
  );
  const scheduledVisitCount = scheduledInSegment.length;
  const servicedVisitCount = Math.min(
    scheduledVisitCount,
    Math.max(
      servicedTrips,
      scheduledInSegment.filter((v) => servicedVisitIds.has(v.jobberVisitId))
        .length
    )
  );

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
    job.revenue = revenueForJob(job.jobberJobId);
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
  return {
    visitValueOf,
    allEntries,
    scheduledVisits,
    jobIdList,
    jobRecords,
    jobByJobberId,
    visitCountRows,
    visitCountByJob,
    customerIds,
    customers,
    customerById,
    classified,
    bySource,
    crewAccounts,
    segmentTotals,
    labelSeconds,
    labelsSeen,
    rows,
    entries,
    onJobRows,
    generalRows,
    totalSeconds,
    onJobSeconds,
    generalSeconds,
    jobKeys,
    avgSecondsPerJob,
    visitRows,
    visitIds,
    visitLinkedSeconds,
    avgSecondsPerVisit,
    visitCoverage,
    LONG_ENTRY_SECONDS,
    longEntries,
    longEntrySeconds,
    labourCost,
    hasCost,
    workedByJob,
    jobRevenue,
    scheduledInSegment,
    scheduledJobIds,
    expectedRevenue,
    servicedVisitIds,
    servicedTrips,
    scheduledVisitCount,
    servicedVisitCount,
    jobCoverage,
    untrackedRevenue,
    untrackedShare,
    labourShare,
    revenuePerHour,
    byEmployee,
    employees,
    byJob,
    jobs,
    segmentNoun,
    showSplitColumns,
    loggingAccounts,
    crewAccountsOnly,
    costedSeconds,
    uncostedSeconds,
  };
}
