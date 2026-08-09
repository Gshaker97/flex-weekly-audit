import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { StatCard } from "@/components/ui/StatCard";
import DateRangeFilter from "@/components/ui/DateRangeFilter";
import SegmentToggle from "@/components/ui/SegmentToggle";
import DownloadReportButton from "@/components/ui/DownloadReportButton";
import LabourRateInput from "@/components/ui/LabourRateInput";
import { resolveDateRange, getDateRange } from "@/lib/dateRange";
import { computeTimesheetData, HOUR } from "@/lib/timesheetData";
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

  // Every figure below comes from the shared module the downloadable
  // report also uses, so the page and the report can never disagree.
  const {
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
  } = await computeTimesheetData({ range, segmentFilter, manualRate });

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
          <DownloadReportButton
            endpoint="/api/report/timesheets"
            extraParams={{
              segment: searchParams.segment,
              rate: searchParams.rate,
            }}
            title="Download time report"
            blurb="Every crew, job, entry and the untracked gap"
          />
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
                !hasCost
                  ? "Set an hourly rate above to cost these hours"
                  : // Quoting a share of revenue off a sliver of the hours
                    // reads as a real labour ratio when it isn't. Say what
                    // the figure actually covers until it covers most of it.
                    costedSeconds < totalSeconds * 0.9
                    ? `Only ${formatHoursDecimal(
                        costedSeconds
                      )} of ${formatHoursDecimal(
                        totalSeconds
                      )} h carry a rate — set one above`
                    : labourShare != null
                    ? `${labourShare.toFixed(1)}% of the revenue generated`
                    : "Wages for the hours logged"
              }
              accent={
                labourShare == null || costedSeconds < totalSeconds * 0.9
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
