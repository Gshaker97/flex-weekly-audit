import { prisma } from "./prisma";

export interface DashboardKPIs {
  revenueYTD: number;
  revenueLastMonth: number;
  revenueThisMonth: number;
  momChangePercent: number | null;

  revenueAtRisk: number;
  uninvoicedRevenue: number;
  outstandingReceivables: number;
  averageJobValue: number;

  totalCustomers: number;
  recurringCustomers: number;
  newCustomersThisMonth: number;
  newCustomersLastMonth: number;
  churnedRecurringLast90: number;

  recurringRevenueYTD: number;
  oneOffRevenueYTD: number;

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

export async function computeDashboardKPIs(): Promise<DashboardKPIs> {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  const lastMonthDate = new Date(year, month - 2, 1);
  const lastMonthY = lastMonthDate.getFullYear();
  const lastMonthM = lastMonthDate.getMonth() + 1;

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

  const thisMonthSnap = monthlyAll.find((m) => m.year === year && m.month === month);
  const lastMonthSnap = monthlyAll.find(
    (m) => m.year === lastMonthY && m.month === lastMonthM
  );

  const revenueThisMonth = thisMonthSnap?.invoicedRevenue ?? 0;
  const revenueLastMonth = lastMonthSnap?.invoicedRevenue ?? 0;
  const momChangePercent =
    revenueLastMonth > 0
      ? ((revenueThisMonth - revenueLastMonth) / revenueLastMonth) * 100
      : null;

  const revenueYTD = monthlyAll
    .filter((m) => m.year === year)
    .reduce((acc, m) => acc + m.invoicedRevenue, 0);

  const recurringRevenueYTD = monthlyAll
    .filter((m) => m.year === year)
    .reduce((acc, m) => acc + m.recurringRevenue, 0);

  const oneOffRevenueYTD = monthlyAll
    .filter((m) => m.year === year)
    .reduce((acc, m) => acc + m.oneOffRevenue, 0);

  const newCustomersThisMonth = thisMonthSnap?.newCustomers ?? 0;
  const newCustomersLastMonth = lastMonthSnap?.newCustomers ?? 0;

  // Revenue at risk: jobs not marked complete but past end date, with a $ value
  const now0 = new Date();
  const revAtRiskAgg = await prisma.jobRecord.aggregate({
    where: {
      completedAt: null,
      endAt: { lt: now0 },
    },
    _sum: { total: true },
  });
  const revenueAtRisk = revAtRiskAgg._sum.total ?? 0;

  // Uninvoiced revenue: completed jobs with no invoice
  const uninvAgg = await prisma.jobRecord.aggregate({
    where: {
      completedAt: { not: null },
      hasInvoice: false,
    },
    _sum: { total: true },
  });
  const uninvoicedRevenue = uninvAgg._sum.total ?? 0;

  // Outstanding receivables: sum of amountDue on invoices
  const outstandingAgg = await prisma.invoiceRecord.aggregate({
    where: { amountDue: { gt: 0 } },
    _sum: { amountDue: true },
  });
  const outstandingReceivables = outstandingAgg._sum.amountDue ?? 0;

  // Average job value YTD (over completed jobs in this year with non-zero total)
  const ytdJobs = await prisma.jobRecord.findMany({
    where: {
      completedAt: { gte: new Date(year, 0, 1), lte: new Date(year, 11, 31, 23, 59, 59) },
      total: { gt: 0 },
    },
    select: { total: true },
  });
  const averageJobValue =
    ytdJobs.length > 0
      ? ytdJobs.reduce((a, j) => a + j.total, 0) / ytdJobs.length
      : 0;

  const totalCustomers = await prisma.customer.count();
  const recurringCustomers = await prisma.customer.count({
    where: { isRecurring: true },
  });

  // Churn: recurring customers whose lastJobAt is older than 90 days
  const ninetyAgo = new Date(now0);
  ninetyAgo.setDate(ninetyAgo.getDate() - 90);
  const churnedRecurringLast90 = await prisma.customer.count({
    where: {
      isRecurring: true,
      lastJobAt: { lt: ninetyAgo },
    },
  });

  const topCustomerRows = await prisma.customer.findMany({
    where: { totalRevenue: { gt: 0 } },
    orderBy: { totalRevenue: "desc" },
    take: 10,
  });
  const topCustomers = topCustomerRows.map((c) => ({
    id: c.id,
    name: c.companyName || c.name || "Unknown",
    revenue: c.totalRevenue,
    jobCount: c.jobCount,
    isRecurring: c.isRecurring,
  }));

  const stRows = await prisma.serviceTypeRevenue.findMany({
    where: { year },
    orderBy: { revenue: "desc" },
  });
  const serviceTypeRevenue = stRows.map((r) => ({
    serviceName: r.serviceName,
    revenue: r.revenue,
    jobCount: r.jobCount,
  }));

  const lastSync = await prisma.syncRun.findFirst({
    where: { status: "complete" },
    orderBy: { completedAt: "desc" },
  });

  return {
    revenueYTD,
    revenueLastMonth,
    revenueThisMonth,
    momChangePercent,
    revenueAtRisk,
    uninvoicedRevenue,
    outstandingReceivables,
    averageJobValue,
    totalCustomers,
    recurringCustomers,
    newCustomersThisMonth,
    newCustomersLastMonth,
    churnedRecurringLast90,
    recurringRevenueYTD,
    oneOffRevenueYTD,
    monthlySeries,
    topCustomers,
    serviceTypeRevenue,
    lastSyncAt: lastSync?.completedAt ?? null,
  };
}
