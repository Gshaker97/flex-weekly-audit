import { prisma } from "@/lib/prisma";
import { computeDashboardKPIs } from "@/lib/kpis";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { StatCard } from "@/components/ui/StatCard";
import RevenueLineChart from "@/components/ui/RevenueLineChart";
import NewCustomersBarChart from "@/components/ui/NewCustomersBarChart";
import SyncButton from "./SyncButton";
import {
  formatCurrency,
  formatCurrencyDetailed,
  formatNumber,
  formatDateTime,
} from "@/lib/utils";
import {
  DollarSign,
  Users,
  AlertCircle,
  Receipt,
  Repeat,
  UserPlus,
  TrendingUp,
  PiggyBank,
} from "lucide-react";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const auth = await prisma.jobberAuth.findFirst({
    orderBy: { createdAt: "desc" },
  });

  if (!auth) return <ConnectJobberPrompt />;

  const lastSync = await prisma.syncRun.findFirst({
    where: { status: "complete" },
    orderBy: { completedAt: "desc" },
  });

  if (!lastSync) return <FirstSyncPrompt />;

  const kpis = await computeDashboardKPIs();

  const last12Months = kpis.monthlySeries.slice(-12);

  return (
    <div className="space-y-8">
      <DashboardHeader lastSyncAt={kpis.lastSyncAt} />

      <section className="space-y-3">
        <SectionTitle title="Revenue" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Revenue YTD"
            value={formatCurrency(kpis.revenueYTD)}
            sublabel={`Invoiced this year`}
            accent="brand"
            icon={<DollarSign size={18} />}
          />
          <StatCard
            label="This Month"
            value={formatCurrency(kpis.revenueThisMonth)}
            sublabel={
              kpis.momChangePercent != null
                ? `vs ${formatCurrency(kpis.revenueLastMonth)} last month`
                : "First month tracked"
            }
            accent="success"
            icon={<TrendingUp size={18} />}
            changePercent={kpis.momChangePercent}
          />
          <StatCard
            label="Average Job Value"
            value={formatCurrency(kpis.averageJobValue)}
            sublabel="YTD completed jobs"
            icon={<Receipt size={18} />}
          />
          <StatCard
            label="Outstanding Receivables"
            value={formatCurrency(kpis.outstandingReceivables)}
            sublabel="Invoiced but unpaid"
            accent={kpis.outstandingReceivables > 0 ? "warning" : "default"}
            icon={<PiggyBank size={18} />}
          />
        </div>
      </section>

      <section className="space-y-3">
        <SectionTitle title="Risk &amp; Gaps" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard
            label="Revenue at Risk"
            value={formatCurrency(kpis.revenueAtRisk)}
            sublabel="Past end date, not completed"
            accent={kpis.revenueAtRisk > 0 ? "danger" : "success"}
            icon={<AlertCircle size={18} />}
          />
          <StatCard
            label="Uninvoiced Revenue"
            value={formatCurrency(kpis.uninvoicedRevenue)}
            sublabel="Completed but no invoice"
            accent={kpis.uninvoicedRevenue > 0 ? "warning" : "success"}
            icon={<Receipt size={18} />}
          />
          <StatCard
            label="Recurring Churn (90d)"
            value={formatNumber(kpis.churnedRecurringLast90)}
            sublabel="Recurring with no recent job"
            accent={kpis.churnedRecurringLast90 > 0 ? "warning" : "success"}
            icon={<Repeat size={18} />}
          />
        </div>
      </section>

      <section className="space-y-3">
        <SectionTitle title="Customers" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Total Customers"
            value={formatNumber(kpis.totalCustomers)}
            sublabel="All-time"
            icon={<Users size={18} />}
          />
          <StatCard
            label="Recurring Customers"
            value={formatNumber(kpis.recurringCustomers)}
            sublabel={
              kpis.totalCustomers > 0
                ? `${Math.round((kpis.recurringCustomers / kpis.totalCustomers) * 100)}% of base`
                : undefined
            }
            accent="brand"
            icon={<Repeat size={18} />}
          />
          <StatCard
            label="New This Month"
            value={formatNumber(kpis.newCustomersThisMonth)}
            sublabel={`vs ${kpis.newCustomersLastMonth} last month`}
            accent="success"
            icon={<UserPlus size={18} />}
          />
          <StatCard
            label="Recurring vs One-off (YTD)"
            value={
              kpis.recurringRevenueYTD + kpis.oneOffRevenueYTD > 0
                ? `${Math.round(
                    (kpis.recurringRevenueYTD /
                      (kpis.recurringRevenueYTD + kpis.oneOffRevenueYTD)) *
                      100
                  )}%`
                : "—"
            }
            sublabel="Share of revenue from recurring"
            icon={<Repeat size={18} />}
          />
        </div>
      </section>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Monthly Revenue</CardTitle>
            <CardDescription>Invoiced revenue, trailing 12 months</CardDescription>
          </CardHeader>
          <CardContent>
            {last12Months.length > 0 ? (
              <RevenueLineChart data={last12Months} />
            ) : (
              <EmptyState message="No revenue data yet." />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>New Customers per Month</CardTitle>
            <CardDescription>Trailing 12 months</CardDescription>
          </CardHeader>
          <CardContent>
            {last12Months.length > 0 ? (
              <NewCustomersBarChart data={last12Months} />
            ) : (
              <EmptyState message="No customer data yet." />
            )}
          </CardContent>
        </Card>
      </section>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Top 10 Customers by Revenue</CardTitle>
            <CardDescription>YTD totals</CardDescription>
          </CardHeader>
          <CardContent>
            {kpis.topCustomers.length === 0 ? (
              <EmptyState message="No customer revenue recorded yet." />
            ) : (
              <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-2.5 font-medium">Customer</th>
                      <th className="px-4 py-2.5 font-medium">Jobs</th>
                      <th className="px-4 py-2.5 font-medium">Revenue</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {kpis.topCustomers.map((c, i) => (
                      <tr key={c.id} className="hover:bg-muted/30">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground">{i + 1}.</span>
                            <span className="font-medium">{c.name}</span>
                            {c.isRecurring && (
                              <Badge variant="success">Recurring</Badge>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{c.jobCount}</td>
                        <td className="px-4 py-3 font-semibold">
                          {formatCurrencyDetailed(c.revenue)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Revenue by Service Type</CardTitle>
            <CardDescription>YTD breakdown</CardDescription>
          </CardHeader>
          <CardContent>
            {kpis.serviceTypeRevenue.length === 0 ? (
              <EmptyState message="No service type data yet." />
            ) : (
              <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-2.5 font-medium">Service</th>
                      <th className="px-4 py-2.5 font-medium">Jobs</th>
                      <th className="px-4 py-2.5 font-medium">Revenue</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {kpis.serviceTypeRevenue.map((s) => (
                      <tr key={s.serviceName} className="hover:bg-muted/30">
                        <td className="px-4 py-3 font-medium">{s.serviceName}</td>
                        <td className="px-4 py-3 text-muted-foreground">{s.jobCount}</td>
                        <td className="px-4 py-3 font-semibold">
                          {formatCurrencyDetailed(s.revenue)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function DashboardHeader({ lastSyncAt }: { lastSyncAt: Date | null }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">
          Business Overview
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {lastSyncAt
            ? `Last synced ${formatDateTime(lastSyncAt)} from Jobber`
            : "Not yet synced"}
        </p>
      </div>
      <SyncButton />
    </div>
  );
}

function SectionTitle({ title }: { title: string }) {
  return (
    <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
      {title}
    </h3>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border py-10 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

function ConnectJobberPrompt() {
  return (
    <div className="mx-auto mt-12 max-w-xl">
      <Card>
        <CardHeader>
          <CardTitle>Connect Jobber to get started</CardTitle>
          <CardDescription>
            Authorize this app to read jobs, invoices, and clients from
            Flexx Landscaping&apos;s Jobber account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <a href="/api/auth/jobber/connect">
            <Button variant="accent" size="lg" className="w-full">
              Connect Jobber Account
            </Button>
          </a>
          <p className="mt-3 text-xs text-muted-foreground">
            Read-only access — this app never modifies Jobber data.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function FirstSyncPrompt() {
  return (
    <div className="mx-auto mt-12 max-w-xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Run your first sync</CardTitle>
          <CardDescription>
            Pull Flexx Landscaping&apos;s clients, jobs, and invoices from Jobber.
            The first sync may take 5–10 minutes depending on data volume.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SyncButton />
          <p className="mt-3 text-xs text-muted-foreground">
            After the sync completes, your KPI dashboard will populate
            automatically.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
