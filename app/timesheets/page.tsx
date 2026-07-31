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
import { Clock, Users, Briefcase, Timer, DollarSign, Percent } from "lucide-react";

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

  // Job records give each tracked job its value; the customer record is the
  // fallback for classifying entries whose own client company name hasn't been
  // filled in by a sync yet.
  const jobIdList = Array.from(
    new Set(allEntries.map((e) => e.jobberJobId).filter(Boolean))
  ) as string[];
  const jobRecords = jobIdList.length
    ? await prisma.jobRecord.findMany({
        where: { jobberJobId: { in: jobIdList } },
        select: {
          jobberJobId: true,
          total: true,
          customerId: true,
          jobType: true,
        },
      })
    : [];
  const jobByJobberId = new Map(jobRecords.map((j) => [j.jobberJobId, j]));

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
  const totalSeconds = entries.reduce((a, e) => a + (e.durationSeconds || 0), 0);
  const crewMembers = new Set(
    entries.map((e) => e.employeeId || e.employeeName).filter(Boolean)
  );
  const jobKeys = new Set(
    entries.map((e) => e.jobberJobId || e.jobNumber).filter(Boolean)
  );
  const visitIds = new Set(entries.map((e) => e.visitId).filter(Boolean));

  const avgSecondsPerJob = jobKeys.size > 0 ? totalSeconds / jobKeys.size : 0;
  const avgSecondsPerVisit =
    visitIds.size > 0 ? totalSeconds / visitIds.size : null;

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

  // Revenue of the jobs that have time logged against them in this view. The
  // job total is the whole job, so treat this as an approximation when a job
  // straddles the range boundary.
  const jobRevenue = Array.from(jobKeys).reduce((sum, key) => {
    const job = jobByJobberId.get(key as string);
    return sum + (job?.total ?? 0);
  }, 0);
  const labourShare =
    hasCost && jobRevenue > 0 ? (labourCost / jobRevenue) * 100 : null;

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
  for (const { entry: e, segment } of rows) {
    const key = e.jobberJobId || `#${e.jobNumber ?? "?"}`;
    const job = e.jobberJobId ? jobByJobberId.get(e.jobberJobId) : null;
    const ex = byJob.get(key) ?? {
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
      revenue: job?.total ?? 0,
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
  const jobs = Array.from(byJob.values()).sort((a, b) => b.seconds - a.seconds);

  const segmentNoun =
    segmentFilter === "all" ? "all crews" : `${SEGMENT_LABELS[segmentFilter]} crews`;
  const showSplitColumns = segmentFilter === "all";

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
              sublabel={`Tracked on site · ${segmentNoun}`}
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
              label="Crew Members"
              value={crewMembers.size}
              sublabel="Clocked in during range"
              icon={<Users size={18} />}
            />
            <StatCard
              label="Avg Hours per Job"
              value={`${formatHoursDecimal(avgSecondsPerJob)} h`}
              sublabel={`Across ${jobKeys.size} job${jobKeys.size === 1 ? "" : "s"}`}
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
                avgSecondsPerVisit != null
                  ? `Across ${visitIds.size} visit${visitIds.size === 1 ? "" : "s"}`
                  : "Needs a sync to link entries to visits"
              }
              icon={<Timer size={18} />}
            />
            <StatCard
              label="Labor Cost vs Job Value"
              value={hasCost ? formatCurrency(labourCost) : "—"}
              sublabel={
                hasCost
                  ? `of ${formatCurrency(jobRevenue)} job value${
                      labourShare != null ? ` · ${labourShare.toFixed(1)}% labor` : ""
                    }`
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

          <Card>
            <CardContent className="space-y-2 py-4 text-xs text-muted-foreground">
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
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[860px] text-sm">
                  <thead className="bg-muted/50">
                    <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-2.5 font-medium">Job</th>
                      <th className="px-4 py-2.5 font-medium">Customer</th>
                      <th className="px-4 py-2.5 font-medium">Type</th>
                      <th className="px-4 py-2.5 font-medium">Last worked</th>
                      <th className="px-4 py-2.5 font-medium">Crew</th>
                      <th className="px-4 py-2.5 font-medium">Visits</th>
                      <th className="px-4 py-2.5 font-medium">Time on site</th>
                      <th className="px-4 py-2.5 font-medium">Labor cost</th>
                      <th className="px-4 py-2.5 font-medium">Job value</th>
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
                                {j.crew.size}
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
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Hours by Crew Member</CardTitle>
              <CardDescription>
                {showSplitColumns
                  ? "Total time clocked in, split by the work each person spent it on."
                  : `Total time clocked in on ${segmentNoun}.`}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="bg-muted/50">
                    <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-2.5 font-medium">Crew member</th>
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
