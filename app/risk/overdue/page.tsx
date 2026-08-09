import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { StatCard } from "@/components/ui/StatCard";
import DateRangeFilter from "@/components/ui/DateRangeFilter";
import { resolveDateRange, getDateRange } from "@/lib/dateRange";
import { getVisitFreshnessCutoff, stillInJobber } from "@/lib/visitFreshness";
import {
  formatCurrency,
  formatCurrencyDetailed,
  formatDate,
  formatDateTime,
  formatNumber,
} from "@/lib/utils";
import { AlertCircle, ListTodo, Users } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function OverdueRevenuePage({
  searchParams,
}: {
  searchParams: { range?: string; start?: string; end?: string };
}) {
  const now = new Date();
  const hasFilter =
    !!searchParams.range || !!searchParams.start || !!searchParams.end;
  const range = hasFilter ? resolveDateRange(searchParams) : getDateRange("allTime");
  const asOf = range.end.getTime() < now.getTime() ? range.end : now;

  // Visits whose scheduled date has passed but aren't marked complete (and
  // aren't invoiced) — work that should have happened and hasn't been closed out.
  const visitCutoff = await getVisitFreshnessCutoff();
  const baseWhere = {
    isComplete: false,
    jobComplete: false,
    hasInvoice: false,
    visitDate: { gte: range.start, lte: range.end, lt: asOf },
  };

  const visits = await prisma.visitRecord.findMany({
    where: { ...baseWhere, ...stillInJobber(visitCutoff) },
    orderBy: { visitDate: "desc" },
  });

  // Rows the latest pull no longer returned: removed or rescheduled in Jobber.
  // Counted separately so the headline isn't inflated by work that no longer
  // exists, but still reported rather than silently dropped.
  const vanished = visitCutoff
    ? await prisma.visitRecord.count({
        where: { ...baseWhere, lastSyncedAt: { lt: visitCutoff } },
      })
    : 0;

  // Why is each row still here? Show the raw signals rather than making
  // anyone guess: what Jobber says about the visit, what it says about the
  // parent job, and when this row was last touched by a sync.
  const jobIds = Array.from(
    new Set(visits.map((v) => v.jobberJobId).filter(Boolean))
  ) as string[];
  const jobs = jobIds.length
    ? await prisma.jobRecord.findMany({
        where: { jobberJobId: { in: jobIds } },
        select: { jobberJobId: true, jobStatus: true, completedAt: true },
      })
    : [];
  const jobById = new Map(jobs.map((j) => [j.jobberJobId, j]));

  const lastSync = await prisma.syncRun.findFirst({
    orderBy: { startedAt: "desc" },
  });
  // A visit far older than the newest one wasn't refreshed by the last pull —
  // the signature of a feed that stopped short before reaching it.
  const newestVisitSync = visits.reduce<Date | null>(
    (acc, v) => (!acc || v.lastSyncedAt > acc ? v.lastSyncedAt : acc),
    null
  );

  const totalValue = visits.reduce((acc, v) => acc + (v.estimatedValue || 0), 0);
  const uniqueCustomers = new Set(visits.map((v) => v.clientName).filter(Boolean)).size;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
          ← Back to dashboard
        </Link>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">Overdue Revenue</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Visits whose scheduled date has passed that haven&apos;t been marked
              complete or invoiced. Showing{" "}
              <span className="font-medium text-foreground">{range.label}</span>.
            </p>
          </div>
          <DateRangeFilter />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label="Total Value"
          value={formatCurrency(totalValue)}
          sublabel="Est. value of overdue visits"
          accent="danger"
          icon={<AlertCircle size={18} />}
        />
        <StatCard
          label="Visit Count"
          value={visits.length}
          sublabel="Visits flagged"
          icon={<ListTodo size={18} />}
        />
        <StatCard
          label="Customers Affected"
          value={uniqueCustomers}
          sublabel="Unique customers"
          icon={<Users size={18} />}
        />
      </div>

      {lastSync && (
        <Card>
          <CardContent className="space-y-1 py-4 text-xs text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">Last sync:</span>{" "}
              {lastSync.completedAt
                ? formatDateTime(lastSync.completedAt)
                : `started ${formatDateTime(lastSync.startedAt)}`}{" "}
              · status {lastSync.status} ·{" "}
              {formatNumber(lastSync.visitsFetched)} visits pulled from Jobber
            </p>
            {lastSync.errorMessage && (
              <p className="text-danger">
                <span className="font-medium">Sync warning:</span>{" "}
                {lastSync.errorMessage}
              </p>
            )}
            {vanished > 0 && (
              <p>
                <span className="font-medium text-foreground">
                  {formatNumber(vanished)} visit
                  {vanished === 1 ? "" : "s"} excluded:
                </span>{" "}
                the latest sync no longer found them in Jobber, so they were
                rescheduled or removed there. They are not outstanding work and
                are left out of the total above.
              </p>
            )}
            <p>
              A row still listed here means Jobber itself reports the visit
              incomplete and its job not closed out. Check the two status
              columns below: if the job reads complete, tell us the job number.
              If &quot;row last synced&quot; is older than the others, that row
              isn&apos;t being refreshed and the sync is the problem, not the
              data.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Overdue Visits</CardTitle>
          <CardDescription>Most recent date first</CardDescription>
        </CardHeader>
        <CardContent>
          {visits.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No overdue visits in this range. 🎉 (If you expected results, run a Sync —
              visit data populates on sync.)
            </p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">Job / Visit</th>
                    <th className="px-4 py-2.5 font-medium">Customer</th>
                    <th className="px-4 py-2.5 font-medium">Scheduled date</th>
                    <th className="px-4 py-2.5 font-medium">Visit says</th>
                    <th className="px-4 py-2.5 font-medium">Job says</th>
                    <th className="px-4 py-2.5 font-medium">Row last synced</th>
                    <th className="px-4 py-2.5 font-medium">Est. Value</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {visits.map((v) => (
                    <tr key={v.id} className="hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <div className="font-medium">
                          {v.jobNumber ? `#${v.jobNumber}` : "—"}
                        </div>
                        <div className="text-xs text-muted-foreground">{v.title ?? ""}</div>
                      </td>
                      <td className="px-4 py-3">{v.clientName ?? "—"}</td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {formatDate(v.visitDate)}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="muted">{v.visitStatus ?? "incomplete"}</Badge>
                      </td>
                      <td className="px-4 py-3">
                        {(() => {
                          const job = v.jobberJobId
                            ? jobById.get(v.jobberJobId)
                            : null;
                          if (!job) {
                            return (
                              <span className="text-xs text-muted-foreground">
                                job not synced
                              </span>
                            );
                          }
                          return (
                            <div>
                              <Badge variant="muted">
                                {job.jobStatus ?? "unknown"}
                              </Badge>
                              <div className="mt-1 text-xs text-muted-foreground">
                                {job.completedAt
                                  ? `completed ${formatDate(job.completedAt)}`
                                  : "no completion date"}
                              </div>
                            </div>
                          );
                        })()}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {formatDateTime(v.lastSyncedAt)}
                        {newestVisitSync &&
                          v.lastSyncedAt.getTime() <
                            newestVisitSync.getTime() - 60 * 60 * 1000 && (
                            <div className="text-danger">not refreshed</div>
                          )}
                      </td>
                      <td className="px-4 py-3 font-semibold">
                        {formatCurrencyDetailed(v.estimatedValue)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
