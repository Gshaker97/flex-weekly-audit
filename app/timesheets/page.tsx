import { prisma } from "@/lib/prisma";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { StatCard } from "@/components/ui/StatCard";
import DateRangeFilter from "@/components/ui/DateRangeFilter";
import { resolveDateRange, getDateRange } from "@/lib/dateRange";
import { formatDuration, formatHoursDecimal, formatDate } from "@/lib/utils";
import { Clock, Users, Briefcase } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function TimesheetsPage({
  searchParams,
}: {
  searchParams: { range?: string; start?: string; end?: string };
}) {
  const hasFilter =
    !!searchParams.range || !!searchParams.start || !!searchParams.end;
  const range = hasFilter ? resolveDateRange(searchParams) : getDateRange("allTime");

  // Entries with no linked visit date fall back to being shown regardless of
  // range, so logged time is never silently dropped.
  const entries = await prisma.timeEntry.findMany({
    where: {
      OR: [
        { occurredAt: { gte: range.start, lte: range.end } },
        { occurredAt: null },
      ],
    },
    orderBy: { occurredAt: "desc" },
  });

  const totalSeconds = entries.reduce((a, e) => a + (e.durationSeconds || 0), 0);
  const employeeIds = new Set(entries.map((e) => e.employeeId).filter(Boolean));
  const jobIds = new Set(entries.map((e) => e.jobberJobId).filter(Boolean));

  // Per-employee rollup
  const byEmployee = new Map<
    string,
    { name: string; seconds: number; jobs: Set<string>; entries: number }
  >();
  for (const e of entries) {
    const key = e.employeeId || e.employeeName || "Unknown";
    const ex = byEmployee.get(key) ?? {
      name: e.employeeName || "Unknown",
      seconds: 0,
      jobs: new Set<string>(),
      entries: 0,
    };
    ex.seconds += e.durationSeconds || 0;
    if (e.jobberJobId) ex.jobs.add(e.jobberJobId);
    ex.entries += 1;
    byEmployee.set(key, ex);
  }
  const employees = Array.from(byEmployee.values()).sort((a, b) => b.seconds - a.seconds);

  // Per-job rollup
  const byJob = new Map<
    string,
    {
      jobNumber: string | null;
      jobTitle: string | null;
      clientName: string | null;
      seconds: number;
      employees: Set<string>;
      lastAt: Date | null;
      ticking: boolean;
    }
  >();
  for (const e of entries) {
    const key = e.jobberJobId || `${e.jobNumber ?? "?"}`;
    const ex = byJob.get(key) ?? {
      jobNumber: e.jobNumber,
      jobTitle: e.jobTitle,
      clientName: e.clientName,
      seconds: 0,
      employees: new Set<string>(),
      lastAt: null as Date | null,
      ticking: false,
    };
    ex.seconds += e.durationSeconds || 0;
    if (e.employeeName) ex.employees.add(e.employeeName);
    if (e.occurredAt && (!ex.lastAt || e.occurredAt > ex.lastAt)) ex.lastAt = e.occurredAt;
    if (e.ticking) ex.ticking = true;
    byJob.set(key, ex);
  }
  const jobs = Array.from(byJob.values()).sort((a, b) => b.seconds - a.seconds);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Time Tracking</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Hours clocked in and time on the job site, from Jobber timesheets. Showing{" "}
            <span className="font-medium text-foreground">{range.label}</span>.
          </p>
        </div>
        <DateRangeFilter />
      </div>

      {entries.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="text-sm text-muted-foreground">
              No timesheet entries found. Make sure the time-tracking scope is enabled,
              you&apos;ve reconnected Jobber, and a sync has run since then.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatCard
              label="Total Hours"
              value={`${formatHoursDecimal(totalSeconds)} h`}
              sublabel="Tracked on site"
              accent="brand"
              icon={<Clock size={18} />}
            />
            <StatCard
              label="Team Members"
              value={employeeIds.size || employees.length}
              sublabel="Clocked in"
              icon={<Users size={18} />}
            />
            <StatCard
              label="Jobs Worked"
              value={jobIds.size}
              sublabel="Jobs with logged time"
              icon={<Briefcase size={18} />}
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Hours by Employee</CardTitle>
              <CardDescription>Total time clocked in, most hours first</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-2.5 font-medium">Employee</th>
                      <th className="px-4 py-2.5 font-medium">Time on site</th>
                      <th className="px-4 py-2.5 font-medium">Jobs</th>
                      <th className="px-4 py-2.5 font-medium">Entries</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {employees.map((e, i) => (
                      <tr key={i} className="hover:bg-muted/30">
                        <td className="px-4 py-3 font-medium">{e.name}</td>
                        <td className="px-4 py-3 font-semibold">{formatDuration(e.seconds)}</td>
                        <td className="px-4 py-3 text-muted-foreground">{e.jobs.size}</td>
                        <td className="px-4 py-3 text-muted-foreground">{e.entries}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Time on Site by Job</CardTitle>
              <CardDescription>
                A job with logged time has been started; one with none hasn&apos;t.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-2.5 font-medium">Job</th>
                      <th className="px-4 py-2.5 font-medium">Customer</th>
                      <th className="px-4 py-2.5 font-medium">Last worked</th>
                      <th className="px-4 py-2.5 font-medium">Crew</th>
                      <th className="px-4 py-2.5 font-medium">Time on site</th>
                      <th className="px-4 py-2.5 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {jobs.map((j, i) => (
                      <tr key={i} className="hover:bg-muted/30">
                        <td className="px-4 py-3">
                          <div className="font-medium">
                            {j.jobNumber ? `#${j.jobNumber}` : "—"}
                          </div>
                          <div className="text-xs text-muted-foreground">{j.jobTitle ?? ""}</div>
                        </td>
                        <td className="px-4 py-3">{j.clientName ?? "—"}</td>
                        <td className="px-4 py-3 text-muted-foreground">{formatDate(j.lastAt)}</td>
                        <td className="px-4 py-3 text-muted-foreground">{j.employees.size}</td>
                        <td className="px-4 py-3 font-semibold">{formatDuration(j.seconds)}</td>
                        <td className="px-4 py-3">
                          {j.ticking ? (
                            <Badge variant="success">Clocked in now</Badge>
                          ) : (
                            <Badge variant="muted">Started</Badge>
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
