import { prisma } from "./prisma";
import { DateRange } from "./dateRange";

export interface DashboardKPIs {
  range: DateRange;

  revenueInRange: number;
  revenueCompareValue: number;
  revenueChangePercent: number | null;

  overdueRevenue: number;
  overdueJobCount: number;
  uninvoicedRevenue: number;
  uninvoicedJobCount: number;
  outstandingReceivables: number;
  averageJobValue: number;

  totalCustomers: number;
  recurringCustomers: number;
  newCustomersInRange: number;
  newCustomersCompare: number;
  churnedRecurringLast90: number;

  recurringRevenueInRange: number;
  oneOffRevenueInRange: number;

  monthlySeries: Array<{
    year: number;
    month: number;
    label: string;
    invoicedRevenue: number;
    newCustomers: number;
    jobsCompleted: number;
    averageJobValue: number;
  }>;

  topCustomers: Array<{
    id: string;
    name: string;
    revenue: number;
    jobCount: number;
    isRecurring: boolean;
  }>;

  serviceTypeRevenue: Array<{
    serviceName: string;
    revenue: number;
    jobCount: number;
  }>;

  lastSyncAt: Date | null;
}

function previousPeriod(range: DateRange): { start: Date; end: Date } {
  const ms = range.end.getTime() - range.start.getTime();
  const end = new Date(range.start.getTime() - 1);
  const start = new Date(range.start.getTime() - ms - 1);
  return { start, end };
}

export async function computeDashboardKPIs(
  range: DateRange
): Promise<DashboardKPIs> {
  const prev = previousPeriod(range);
  const now0 = new Date();
  // Cap the "as of now" bound to the end of the selected range so past
  // ranges only count what was overdue/uninvoiced within that window.
  const asOf = range.end.getTime() < now0.getTime() ? range.end : now0;

  const monthlyAll = await prisma.monthlySnapshot.findMany({
    orderBy: [{ year: "asc" }, { month: "asc" }],
  });

  const monthlySeries = monthlyAll.map((m) => ({
    year: m.year,
    month: m.month,
    label: new Date(m.year, m.month - 1, 1).toLocaleDateString("en-US", {
      month: "short",
      year: "2-digit",
    }),
    invoicedRevenue: m.invoicedRevenue,
    newCustomers: m.newCustomers,
    jobsCompleted: m.jobsCompleted,
    averageJobValue: m.averageJobValue,
  }));

  const revInRange = await prisma.invoiceRecord.aggregate({
    where: { issuedAt: { gte: range.start, lte: range.end } },
    _sum: { total: true },
  });
  const revenueInRange = revInRange._sum.total ?? 0;

  const revPrev = await prisma.invoiceRecord.aggregate({
    where: { issuedAt: { gte: prev.start, lte: prev.end } },
    _sum: { total: true },
  });
  const revenueCompareValue = revPrev._sum.total ?? 0;
  const revenueChangePercent =
    revenueCompareValue > 0
      ? ((revenueInRange - revenueCompareValue) / revenueCompareValue) * 100
      : null;

  // Overdue Revenue (range-aware): one-off jobs whose end date falls in the
  // range, already past, not completed, not invoiced.
  const overdueAgg = await prisma.jobRecord.aggregate({
    where: {
      isRecurring: false,
      completedAt: null,
      hasInvoice: false,
      endAt: { gte: range.start, lte: range.end, lt: asOf },
      total: { gt: 0 },
    },
    _sum: { total: true },
    _count: true,
  });
  const overdueRevenue = overdueAgg._sum.total ?? 0;
  const overdueJobCount = overdueAgg._count ?? 0;

  // Uninvoiced Revenue (range-aware): completed in range, no invoice.
  const uninvAgg = await prisma.jobRecord.aggregate({
    where: {
      completedAt: { gte: range.start, lte: range.end },
      hasInvoice: false,
      total: { gt: 0 },
    },
    _sum: { total: true },
    _count: true,
  });
  const uninvoicedRevenue = uninvAgg._sum.total ?? 0;
  const uninvoicedJobCount = uninvAgg._count ?? 0;

  // Outstanding Receivables (range-aware): invoices issued in range still owed.
  const outstandingAgg = await prisma.invoiceRecord.aggregate({
    where: {
      amountDue: { gt: 0 },
      issuedAt: { gte: range.start, lte: range.end },
    },
    _sum: { amountDue: true },
  });
  const outstandingReceivables = outstandingAgg._sum.amountDue ?? 0;

  const rangeJobs = await prisma.jobRecord.findMany({
    where: {
      completedAt: { gte: range.start, lte: range.end },
      total: { gt: 0 },
    },
    select: { total: true, isRecurring: true },
  });
  const averageJobValue =
    rangeJobs.length > 0
      ? rangeJobs.reduce((a, j) => a + j.total, 0) / rangeJobs.length
      : 0;
  const recurringRevenueInRange = rangeJobs
    .filter((j) => j.isRecurring)
    .reduce((a, j) => a + j.total, 0);
  const oneOffRevenueInRange = rangeJobs
    .filter((j) => !j.isRecurring)
    .reduce((a, j) => a + j.total, 0);

  const totalCustomers = await prisma.customer.count();
  const recurringCustomers = await prisma.customer.count({
    where: { isRecurring: true },
  });

  const newCustomersInRange = await prisma.customer.count({
    where: { createdAtJobber: { gte: range.start, lte: range.end } },
  });
  const newCustomersCompare = await prisma.customer.count({
    where: { createdAtJobber: { gte: prev.start, lte: prev.end } },
  });

  // Recurring churn stays a fixed trailing-90-day metric (it answers
  // "who's gone quiet recently", independent of the dashboard range).
  const ninetyAgo = new Date(now0);
  ninetyAgo.setDate(ninetyAgo.getDate() - 90);
  const churnedRecurringLast90 = await prisma.customer.count({
    where: {
      isRecurring: true,
      lastJobAt: { lt: ninetyAgo },
    },
  });

  // Top 10 customers within the date range
  const rangeCustomerJobs = await prisma.jobRecord.findMany({
    where: {
      completedAt: { gte: range.start, lte: range.end },
      total: { gt: 0 },
      customerId: { not: null },
    },
    select: { customerId: true, total: true, isRecurring: true },
  });
  const customerTotals = new Map<string, { revenue: number; jobs: number; recurring: boolean }>();
  for (const j of rangeCustomerJobs) {
    if (!j.customerId) continue;
    const ex = customerTotals.get(j.customerId) ?? { revenue: 0, jobs: 0, recurring: false };
    ex.revenue += j.total;
    ex.jobs += 1;
    if (j.isRecurring) ex.recurring = true;
    customerTotals.set(j.customerId, ex);
  }
  const sortedCustomerIds = Array.from(customerTotals.entries())
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, 10);
  const customerLookups = await prisma.customer.findMany({
    where: { id: { in: sortedCustomerIds.map(([id]) => id) } },
  });
  const customerById = new Map(customerLookups.map((c) => [c.id, c]));
  const topCustomers = sortedCustomerIds
    .map(([id, agg]) => {
      const c = customerById.get(id);
      if (!c) return null;
      return {
        id: c.id,
        name: c.companyName || c.name || "Unknown",
        revenue: agg.revenue,
        jobCount: agg.jobs,
        isRecurring: agg.recurring,
      };
    })
    .filter(Boolean) as DashboardKPIs["topCustomers"];

  const rangeJobsWithType = await prisma.jobRecord.findMany({
    where: { completedAt: { gte: range.start, lte: range.end } },
    select: { jobType: true, total: true },
  });
  const stMap = new Map<string, { revenue: number; jobCount: number }>();
  for (const j of rangeJobsWithType) {
    const key = j.jobType || "Other";
    const ex = stMap.get(key) ?? { revenue: 0, jobCount: 0 };
    ex.revenue += j.total || 0;
    ex.jobCount += 1;
    stMap.set(key, ex);
  }
  const serviceTypeRevenue = Array.from(stMap.entries())
    .map(([serviceName, agg]) => ({ serviceName, ...agg }))
    .sort((a, b) => b.revenue - a.revenue);

  const lastSync = await prisma.syncRun.findFirst({
    where: { status: "complete" },
    orderBy: { completedAt: "desc" },
  });

  return {
    range,
    revenueInRange,
    revenueCompareValue,
    revenueChangePercent,
    overdueRevenue,
    overdueJobCount,
    uninvoicedRevenue,
    uninvoicedJobCount,
    outstandingReceivables,
    averageJobValue,
    totalCustomers,
    recurringCustomers,
    newCustomersInRange,
    newCustomersCompare,
    churnedRecurringLast90,
    recurringRevenueInRange,
    oneOffRevenueInRange,
    monthlySeries,
    topCustomers,
    serviceTypeRevenue,
    lastSyncAt: lastSync?.completedAt ?? null,
  };
}
