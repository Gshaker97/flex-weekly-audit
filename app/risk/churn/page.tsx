import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { StatCard } from "@/components/ui/StatCard";
import { formatCurrencyDetailed, formatDate } from "@/lib/utils";
import { Repeat, Users, DollarSign } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function ChurnPage() {
  const ninetyAgo = new Date();
  ninetyAgo.setDate(ninetyAgo.getDate() - 90);

  const customers = await prisma.customer.findMany({
    where: {
      isRecurring: true,
      lastJobAt: { lt: ninetyAgo },
    },
    orderBy: { totalRevenue: "desc" },
  });

  const totalLostValue = customers.reduce((acc, c) => acc + (c.totalRevenue || 0), 0);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
          ← Back to dashboard
        </Link>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight">
          Recurring Churn (90 days)
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Customers who used to receive recurring service but haven&apos;t had a
          job completed in 90+ days. These are candidates for win-back outreach.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label="Churned Customers"
          value={customers.length}
          sublabel="Recurring, no job in 90+ days"
          accent="warning"
          icon={<Repeat size={18} />}
        />
        <StatCard
          label="Historical Revenue"
          value={formatCurrencyDetailed(totalLostValue)}
          sublabel="Lifetime revenue from these customers"
          icon={<DollarSign size={18} />}
        />
        <StatCard
          label="Average Customer Value"
          value={
            customers.length > 0
              ? formatCurrencyDetailed(totalLostValue / customers.length)
              : "—"
          }
          sublabel="Per churned customer"
          icon={<Users size={18} />}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Churned Customers</CardTitle>
          <CardDescription>
            Sorted by historical revenue (most valuable first — prioritize outreach here)
          </CardDescription>
        </CardHeader>
        <CardContent>
          {customers.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No recurring customer churn detected. 🎉
            </p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">Customer</th>
                    <th className="px-4 py-2.5 font-medium">Contact</th>
                    <th className="px-4 py-2.5 font-medium">Last job</th>
                    <th className="px-4 py-2.5 font-medium">Total jobs</th>
                    <th className="px-4 py-2.5 font-medium">Lifetime Revenue</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {customers.map((c) => (
                    <tr key={c.id} className="hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">
                            {c.companyName || c.name || "Unknown"}
                          </span>
                          <Badge variant="warning">Churned</Badge>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {c.email && <div>{c.email}</div>}
                        {c.phone && <div>{c.phone}</div>}
                        {!c.email && !c.phone && "—"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {formatDate(c.lastJobAt)}
                      </td>
                      <td className="px-4 py-3">{c.jobCount}</td>
                      <td className="px-4 py-3 font-semibold">
                        {formatCurrencyDetailed(c.totalRevenue)}
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
