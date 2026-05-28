import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { StatCard } from "@/components/ui/StatCard";
import DateRangeFilter from "@/components/ui/DateRangeFilter";
import { resolveDateRange, getDateRange } from "@/lib/dateRange";
import { formatCurrency, formatCurrencyDetailed, formatDate } from "@/lib/utils";
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
  // Only count jobs that are actually past due as of now (or the range end).
  const asOf = range.end.getTime() < now.getTime() ? range.end : now;

  const jobs = await prisma.jobRecord.findMany({
    where: {
      isRecurring: false,
      completedAt: null,
      hasInvoice: false,
      endAt: { gte: range.start, lte: range.end, lt: asOf },
      total: { gt: 0 },
    },
    orderBy: { endAt: "desc" },
  });

  const totalValue = jobs.reduce((acc, j) => acc + (j.total || 0), 0);
  const uniqueCustomers = new Set(jobs.map((j) => j.customerId).filter(Boolean)).size;

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
              One-off jobs past their end date that haven&apos;t been marked complete
              or invoiced. Showing{" "}
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
          sublabel="Sum of overdue jobs"
          accent="danger"
          icon={<AlertCircle size={18} />}
        />
        <StatCard
          label="Job Count"
          value={jobs.length}
          sublabel="Jobs flagged"
          icon={<ListTodo size={18} />}
        />
        <StatCard
          label="Customers Affected"
          value={uniqueCustomers}
          sublabel="Unique customers"
          icon={<Users size={18} />}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Overdue Jobs</CardTitle>
          <CardDescription>Most recent end date first</CardDescription>
        </CardHeader>
        <CardContent>
          {jobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No overdue jobs in this range. 🎉</p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">Job</th>
                    <th className="px-4 py-2.5 font-medium">Customer</th>
                    <th className="px-4 py-2.5 font-medium">End date</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    <th className="px-4 py-2.5 font-medium">Value</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {jobs.map((j) => (
                    <tr key={j.id} className="hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <div className="font-medium">
                          {j.jobNumber ? `#${j.jobNumber}` : "—"}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {j.title ?? ""}
                        </div>
                      </td>
                      <td className="px-4 py-3">{j.clientName ?? "—"}</td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {formatDate(j.endAt)}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="muted">{j.jobStatus ?? "unknown"}</Badge>
                      </td>
                      <td className="px-4 py-3 font-semibold">
                        {formatCurrencyDetailed(j.total)}
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
