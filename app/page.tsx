import { prisma } from "@/lib/prisma";
import { computeDashboardKPIs } from "@/lib/kpis";
import { resolveDateRange, rangeQueryString } from "@/lib/dateRange";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { StatCard } from "@/components/ui/StatCard";
import { ClickableStatCard } from "@/components/ui/ClickableStatCard";
import DateRangeFilter from "@/components/ui/DateRangeFilter";
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

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: { range?: string; start?: string; end?: string };
}) {
  const auth = await prisma.jobberAuth.findFirst({
    orderBy: { createdAt: "desc" },
  });

  if (!auth) return <ConnectJobberPrompt />;

  const lastSync = await prisma.syncRun.findFirst({
    where: { status: "complete" },
    orderBy: { completedAt: "desc" },
  });

  if (!lastSync) return <FirstSyncPrompt />;

  const range = resolveDateRange(searchParams);
  const kpis = await computeDashboardKPIs(range);

  // Overdue invoices (unpaid + past their due date), scoped to the selected date
  // range by issue date (matches the Outstanding Receivables card).
  const overdueInvoiceRows = await prisma.invoiceRecord.findMany({
    where: {
      amountDue: { gt: 0 },
      dueAt: { lt: new Date() },
      issuedAt: { gte: range.start, lte: range.end },
    },
    select: { amountDue: true, invoiceStatus: true },
  });
  const overdueUnpaid = overdueInvoiceRows.filter((i) => {
    const s = (i.invoiceStatus ?? "").toLowerCase();
    return s !== "paid" && s !== "void" && s !== "bad_debt" && s !== "draft";
  });
  const overdueInvoiceTotal = overdueUnpaid.reduce((a, i) => a + (i.amountDue || 0), 0);
  const overdueInvoiceCount = overdueUnpaid.length;

  // Carry the active range into detail-page links so the number you click
  // matches the list you land on. Default to YTD when nothing is set.
  const qs = rangeQueryString({
    range:
      searchParams.start || searchParams.end
        ? undefined
        : searchParams.range ?? "ytd",
    start: searchParams.start,
    end: searchParams.end,
  });

  const last12Months = kpis.monthlySeries.slice(-12);

  const compareLabel =
    kpis.revenueCompareValue > 0
      ? `vs ${formatCurrency(kpis.revenueCompareValue)} prior period`
      : "No prior period data";

  return (
    <div className="space-y-8">
      <DashboardHeader
        lastSyncAt={kpis.lastSyncAt}
        rangeLabel={kpis.range.label}
      />

      <section className="space-y-3">
        <SectionTitle title="Revenue" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label={`Revenue (${kpis.range.label})`}
            value={formatCurrency(kpis.revenueInRange)}
            sublabel="Invoiced in range"
            accent="brand"
            icon={<DollarSign size={18} />}
            changePercent={kpis.revenueChangePercent}
          />
          <StatCard
            label="Average Job Value"
            value={formatCurrency(kpis.averageJobValue)}
            sublabel="Completed jobs in range"
            icon={<Receipt size={18} />}
          />
          <ClickableStatCard
            href={`/risk/receivables${qs}`}
            label="Outstanding Receivables"
            value={formatCurrency(kpis.outstandingReceivables)}
            sublabel="Invoiced in range, unpaid"
            accent={kpis.outstandingReceivables > 0 ? "warning" : "default"}
            icon={<PiggyBank size={18} />}
          />
          <StatCard
            label="Recurring vs One-off"
            value={
              kpis.recurringRevenueInRange + kpis.oneOffRevenueInRange > 0
                ? `${Math.round(
                    (kpis.recurringRevenueInRange /
                      (kpis.recurringRevenueInRange + kpis.oneOffRevenueInRange)) *
                      100
                  )}%`
                : "—"
            }
            sublabel="Recurring share of revenue"
            icon={<Repeat size={18} />}
          />
        </div>
        <p className="text-xs text-muted-foreground">{compareLabel}</p>
      </section>

      <section className="space-y-3">
        <SectionTitle title="Risk &amp; Gaps" />
        <p className="text-xs text-muted-foreground">
          Click any card to see the specific jobs or customers behind the number.
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <ClickableStatCard
            href={`/risk/overdue${qs}`}
            label="Jobs not marked as completed"
            value={formatCurrency(kpis.overdueRevenue)}
            sublabel={`${kpis.overdueJobCount} past their date, not completed`}
            accent={kpis.overdueRevenue > 0 ? "danger" : "success"}
            icon={<AlertCircle size={18} />}
          />
          <ClickableStatCard
            href={`/risk/overdue-invoices${qs}`}
            label="Overdue Invoices"
            value={formatCurrency(overdueInvoiceTotal)}
            sublabel={`${overdueInvoiceCount} unpaid invoices past due`}
            accent={overdueInvoiceTotal > 0 ? "danger" : "success"}
            icon={<Receipt size={18} />}
          />
          <ClickableStatCard
            href={`/risk/uninvoiced${qs}`}
            label="Uninvoiced Revenue"
            value={formatCurrency(kpis.uninvoicedRevenue)}
            sublabel={`${kpis.uninvoicedJobCount} completed visits with no invoice`}
            accent={kpis.uninvoicedRevenue > 0 ? "warning" : "success"}
            icon={<Receipt size={18} />}
          />
          <ClickableStatCard
            href={`/risk/churn${qs}`}
            label="Recurring Churn (90d)"
            value={formatNumber(kpis.churnedRecurringLast90)}
            sublabel="Recurring customers with no recent job"
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
            label={`New (${kpis.range.label})`}
            value={formatNumber(kpis.newCustomersInRange)}
            sublabel={`vs ${kpis.newCustomersCompare} prior period`}
            accent="success"
            icon={<UserPlus size={18} />}
          />
          <StatCard
            label="One-off vs Recurring Rev"
            value={
              kpis.recurringRevenueInRange + kpis.oneOffRevenueInRange > 0
                ? `${Math.round(
                    (kpis.oneOffRevenueInRange /
                      (kpis.recurringRevenueInRange + kpis.oneOffRevenueInRange)) *
                      100
                  )}%`
                : "—"
            }
            sublabel="One-off share of revenue"
            icon={<TrendingUp size={18} />}
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
            <CardDescription>Within selected range</CardDescription>
          </CardHeader>
          <CardContent>
            {kpis.topCustomers.length === 0 ? (
              <EmptyState message="No customer revenue in this range." />
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
                            {c.isRecurring && <Badge variant="success">Recurring</Badge>}
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
            <CardDescription>Within selected range</CardDescription>
          </CardHeader>
          <CardContent>
            {kpis.serviceTypeRevenue.length === 0 ? (
              <EmptyState message="No service type data in this range." />
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

function DashboardHeader({
  lastSyncAt,
  rangeLabel,
}: {
  lastSyncAt: Date | null;
  rangeLabel: string;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Business Overview</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Showing data for <span className="font-medium text-foreground">{rangeLabel}</span>
          {" · "}
          {lastSyncAt
            ? `synced ${formatDateTime(lastSyncAt)}`
            : "not yet synced"}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <DateRangeFilter />
        <SyncButton />
      </div>
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
        </CardContent>
      </Card>
    </div>
  );
}
