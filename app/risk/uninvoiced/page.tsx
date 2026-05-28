import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { StatCard } from "@/components/ui/StatCard";
import DateRangeFilter from "@/components/ui/DateRangeFilter";
import { resolveDateRange, getDateRange } from "@/lib/dateRange";
import { formatCurrency, formatCurrencyDetailed, formatDate } from "@/lib/utils";
import { Receipt, ListTodo, Users } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function UninvoicedRevenuePage({
  searchParams,
}: {
  searchParams: { range?: string; start?: string; end?: string };
}) {
  // Default to all time so old unbilled jobs are never hidden; the filter
  // narrows it down when the user wants a specific window.
  const hasFilter =
    !!searchParams.range || !!searchParams.start || !!searchParams.end;
  const range = hasFilter ? resolveDateRange(searchParams) : getDateRange("allTime");

  const jobs = await prisma.jobRecord.findMany({
    where: {
      completedAt: { gte: range.start, lte: range.end },
      hasInvoice: false,
      total: { gt: 0 },
    },
    orderBy: { completedAt: "desc" },
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
            <h2 className="text-2xl font-semibold tracking-tight">Uninvoiced Revenue</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Completed jobs that don&apos;t have an invoice attached. These should
              be billed. Showing{" "}
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
          sublabel="Sum of uninvoiced jobs"
          accent="warning"
          icon={<Receipt size={18} />}
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
          <CardTitle>Uninvoiced Jobs</CardTitle>
          <CardDescription>Most recently completed first</CardDescription>
        </CardHeader>
        <CardContent>
          {jobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No uninvoiced jobs in this range. 🎉
            </p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">Job</th>
                    <th className="px-4 py-2.5 font-medium">Customer</th>
                    <th className="px-4 py-2.5 font-medium">Completed</th>
                    <th className="px-4 py-2.5 font-medium">Type</th>
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
                        {formatDate(j.completedAt)}
                      </td>
                      <td className="px-4 py-3">
                        {j.isRecurring ? (
                          <Badge variant="success">Recurring</Badge>
                        ) : (
                          <Badge variant="muted">One-off</Badge>
                        )}
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
