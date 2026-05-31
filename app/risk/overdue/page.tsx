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
  const asOf = range.end.getTime() < now.getTime() ? range.end : now;

  // Visits whose scheduled date has passed but aren't marked complete (and
  // aren't invoiced) — work that should have happened and hasn't been closed out.
  const visits = await prisma.visitRecord.findMany({
    where: {
      isComplete: false,
      hasInvoice: false,
      visitDate: { gte: range.start, lte: range.end, lt: asOf },
    },
    orderBy: { visitDate: "desc" },
  });

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
                    <th className="px-4 py-2.5 font-medium">Status</th>
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
