import { prisma } from "./prisma";
import { DateRange } from "./dateRange";
import { computeDashboardKPIs } from "./kpis";
import { COLLECTIONS_SINCE } from "./lateInvoices";
import {
  formatCurrency,
  formatCurrencyDetailed,
  formatNumber,
  formatPercent,
} from "./utils";

// A single downloadable report covering everything the dashboard and its
// drill-down pages show, scoped to one date range. Each section reuses the same
// query definitions as the page it mirrors, so the report and the UI never
// disagree about a number.

export type CellValue = string | number | boolean | Date | null;

export type ColumnType =
  | "text"
  | "currency"
  | "number"
  | "int"
  | "date"
  | "datetime"
  | "bool";

export interface ReportColumn {
  header: string;
  type: ColumnType;
}

export interface ReportSection {
  key: string;
  title: string;
  description: string;
  columns: ReportColumn[];
  rows: CellValue[][];
}

export interface ReportSummaryItem {
  label: string;
  value: string;
  detail?: string;
}

export interface ReportData {
  businessName: string;
  rangeLabel: string;
  rangeStart: Date;
  rangeEnd: Date;
  generatedAt: Date;
  lastSyncAt: Date | null;
  summary: ReportSummaryItem[];
  sections: ReportSection[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function nameOf(
  clientName: string | null | undefined,
  customer?: { name: string | null; companyName: string | null } | null
): string {
  return (
    clientName ||
    customer?.companyName ||
    customer?.name ||
    "—"
  );
}

function hours(seconds: number | null | undefined): number {
  if (!seconds || seconds <= 0) return 0;
  return Math.round((seconds / 3600) * 100) / 100;
}

export async function buildReport(range: DateRange): Promise<ReportData> {
  const now = new Date();
  // Same "as of now" cap the KPI layer uses, so a historical range only counts
  // what was actually overdue inside that window.
  const asOf = range.end.getTime() < now.getTime() ? range.end : now;

  const kpis = await computeDashboardKPIs(range);

  // ---------------------------------------------------------------- summary

  // Overdue invoices use the Collections definition (Jobber's exact "past_due"
  // status, issued on/after the cutoff), matching the dashboard stat.
  const overdueFrom =
    range.start > COLLECTIONS_SINCE ? range.start : COLLECTIONS_SINCE;

  const [
    invoices,
    completedJobs,
    uninvoicedVisits,
    notCompletedVisits,
    receivables,
    overdueInvoices,
    churnedCustomers,
    newCustomers,
    timeEntries,
  ] = await Promise.all([
    prisma.invoiceRecord.findMany({
      where: { issuedAt: { gte: range.start, lte: range.end } },
      include: { customer: true },
      orderBy: { issuedAt: "desc" },
    }),
    prisma.jobRecord.findMany({
      where: { completedAt: { gte: range.start, lte: range.end } },
      orderBy: { completedAt: "desc" },
    }),
    prisma.visitRecord.findMany({
      where: {
        isComplete: true,
        hasInvoice: false,
        noInvoiceFlag: false,
        visitDate: { gte: range.start, lte: range.end },
      },
      orderBy: { visitDate: "desc" },
    }),
    prisma.visitRecord.findMany({
      where: {
        isComplete: false,
        hasInvoice: false,
        visitDate: { gte: range.start, lte: range.end, lt: asOf },
      },
      orderBy: { visitDate: "desc" },
    }),
    prisma.invoiceRecord.findMany({
      where: {
        amountDue: { gt: 0 },
        issuedAt: { gte: range.start, lte: range.end },
      },
      include: { customer: true },
      orderBy: { issuedAt: "desc" },
    }),
    prisma.invoiceRecord.findMany({
      where: {
        invoiceStatus: "past_due",
        issuedAt: { gte: overdueFrom, lte: range.end },
      },
      include: { customer: true },
      orderBy: { dueAt: "asc" },
    }),
    prisma.customer.findMany({
      where: {
        isRecurring: true,
        lastJobAt: { lt: new Date(now.getTime() - 90 * DAY_MS) },
      },
      orderBy: { totalRevenue: "desc" },
    }),
    prisma.customer.findMany({
      where: { createdAtJobber: { gte: range.start, lte: range.end } },
      orderBy: { createdAtJobber: "desc" },
    }),
    prisma.timeEntry.findMany({
      where: { occurredAt: { gte: range.start, lte: range.end } },
      orderBy: { occurredAt: "desc" },
    }),
  ]);

  const overdueInvoiceTotal = overdueInvoices.reduce(
    (a, i) => a + (i.amountDue || 0),
    0
  );
  const recurringShare =
    kpis.recurringRevenueInRange + kpis.oneOffRevenueInRange > 0
      ? (kpis.recurringRevenueInRange /
          (kpis.recurringRevenueInRange + kpis.oneOffRevenueInRange)) *
        100
      : null;

  const summary: ReportSummaryItem[] = [
    {
      label: "Revenue",
      value: formatCurrencyDetailed(kpis.revenueInRange),
      detail:
        kpis.revenueChangePercent == null
          ? "Invoiced in range · no prior period data"
          : `Invoiced in range · ${
              kpis.revenueChangePercent >= 0 ? "+" : ""
            }${formatPercent(kpis.revenueChangePercent, 1)} vs ${formatCurrency(
              kpis.revenueCompareValue
            )} prior period`,
    },
    {
      label: "Average Job Value",
      value: formatCurrencyDetailed(kpis.averageJobValue),
      detail: `${formatNumber(completedJobs.length)} jobs completed in range`,
    },
    {
      label: "Outstanding Receivables",
      value: formatCurrencyDetailed(kpis.outstandingReceivables),
      detail: `${formatNumber(receivables.length)} invoices issued in range, unpaid`,
    },
    {
      label: "Recurring vs One-off",
      value: recurringShare == null ? "—" : formatPercent(recurringShare),
      detail: `${formatCurrencyDetailed(
        kpis.recurringRevenueInRange
      )} recurring · ${formatCurrencyDetailed(kpis.oneOffRevenueInRange)} one-off`,
    },
    {
      label: "Jobs Not Marked Completed",
      value: formatCurrencyDetailed(kpis.overdueRevenue),
      detail: `${formatNumber(
        kpis.overdueJobCount
      )} visits past their date, not completed`,
    },
    {
      label: "Overdue Invoices",
      value: formatCurrencyDetailed(overdueInvoiceTotal),
      detail: `${formatNumber(overdueInvoices.length)} unpaid invoices past due`,
    },
    {
      label: "Uninvoiced Revenue",
      value: formatCurrencyDetailed(kpis.uninvoicedRevenue),
      detail: `${formatNumber(
        kpis.uninvoicedJobCount
      )} completed visits with no invoice`,
    },
    {
      label: "Recurring Churn (90d)",
      value: formatNumber(kpis.churnedRecurringLast90),
      detail: "Recurring customers with no job in 90+ days",
    },
    {
      label: "Total Customers",
      value: formatNumber(kpis.totalCustomers),
      detail: `${formatNumber(kpis.recurringCustomers)} recurring`,
    },
    {
      label: "New Customers",
      value: formatNumber(kpis.newCustomersInRange),
      detail: `vs ${formatNumber(kpis.newCustomersCompare)} prior period`,
    },
    {
      label: "Invoices Issued",
      value: formatNumber(invoices.length),
      detail: `${formatCurrencyDetailed(
        invoices.reduce((a, i) => a + (i.total || 0), 0)
      )} invoiced`,
    },
    {
      label: "Hours Logged",
      value: formatNumber(
        Math.round(
          timeEntries.reduce((a, t) => a + hours(t.durationSeconds), 0)
        )
      ),
      detail: `${formatNumber(timeEntries.length)} time entries in range`,
    },
  ];

  // --------------------------------------------------------------- sections

  const sections: ReportSection[] = [];

  // Monthly performance, limited to months touching the range.
  const monthly = kpis.monthlySeries.filter((m) => {
    const mStart = new Date(m.year, m.month - 1, 1);
    const mEnd = new Date(m.year, m.month, 0, 23, 59, 59, 999);
    return mStart <= range.end && mEnd >= range.start;
  });
  sections.push({
    key: "monthly",
    title: "Monthly Performance",
    description: "Invoiced revenue, jobs, and new customers per month in range.",
    columns: [
      { header: "Month", type: "text" },
      { header: "Invoiced Revenue", type: "currency" },
      { header: "Jobs Completed", type: "int" },
      { header: "Avg Job Value", type: "currency" },
      { header: "New Customers", type: "int" },
    ],
    rows: monthly.map((m) => [
      `${m.label}`,
      m.invoicedRevenue,
      m.jobsCompleted,
      m.averageJobValue,
      m.newCustomers,
    ]),
  });

  // Customer revenue in range — every customer, not just the dashboard top 10.
  const jobsByCustomer = completedJobs.filter(
    (j) => j.customerId && (j.total || 0) > 0
  );
  const custAgg = new Map<
    string,
    { revenue: number; jobs: number; recurring: boolean }
  >();
  for (const j of jobsByCustomer) {
    const id = j.customerId as string;
    const ex = custAgg.get(id) ?? { revenue: 0, jobs: 0, recurring: false };
    ex.revenue += j.total || 0;
    ex.jobs += 1;
    if (j.isRecurring) ex.recurring = true;
    custAgg.set(id, ex);
  }
  const custRecords = custAgg.size
    ? await prisma.customer.findMany({
        where: { id: { in: Array.from(custAgg.keys()) } },
      })
    : [];
  const custById = new Map(custRecords.map((c) => [c.id, c]));
  sections.push({
    key: "customers-revenue",
    title: "Customer Revenue",
    description:
      "Every customer with completed-job revenue in range, highest first.",
    columns: [
      { header: "Customer", type: "text" },
      { header: "Revenue", type: "currency" },
      { header: "Jobs", type: "int" },
      { header: "Avg Job", type: "currency" },
      { header: "Recurring", type: "bool" },
      { header: "Email", type: "text" },
      { header: "Phone", type: "text" },
    ],
    rows: Array.from(custAgg.entries())
      .sort((a, b) => b[1].revenue - a[1].revenue)
      .map(([id, agg]) => {
        const c = custById.get(id);
        return [
          nameOf(null, c) === "—" ? "Unknown" : nameOf(null, c),
          agg.revenue,
          agg.jobs,
          agg.jobs > 0 ? agg.revenue / agg.jobs : 0,
          agg.recurring,
          c?.email ?? null,
          c?.phone ?? null,
        ] as CellValue[];
      }),
  });

  sections.push({
    key: "service-types",
    title: "Revenue by Service Type",
    description: "Completed jobs in range, grouped by job type.",
    columns: [
      { header: "Service", type: "text" },
      { header: "Revenue", type: "currency" },
      { header: "Jobs", type: "int" },
      { header: "Avg Job", type: "currency" },
    ],
    rows: kpis.serviceTypeRevenue.map((s) => [
      s.serviceName,
      s.revenue,
      s.jobCount,
      s.jobCount > 0 ? s.revenue / s.jobCount : 0,
    ]),
  });

  sections.push({
    key: "invoices",
    title: "Invoices Issued",
    description: "Every invoice issued in range, newest first.",
    columns: [
      { header: "Invoice #", type: "text" },
      { header: "Customer", type: "text" },
      { header: "Status", type: "text" },
      { header: "Issued", type: "date" },
      { header: "Due", type: "date" },
      { header: "Total", type: "currency" },
      { header: "Paid", type: "currency" },
      { header: "Balance Due", type: "currency" },
    ],
    rows: invoices.map((i) => [
      i.invoiceNumber ?? null,
      nameOf(i.clientName, i.customer),
      i.invoiceStatus ?? null,
      i.issuedAt,
      i.dueAt,
      i.total || 0,
      i.amountPaid || 0,
      i.amountDue || 0,
    ]),
  });

  sections.push({
    key: "jobs",
    title: "Jobs Completed",
    description: "Every job with a completion date in range, newest first.",
    columns: [
      { header: "Job #", type: "text" },
      { header: "Title", type: "text" },
      { header: "Customer", type: "text" },
      { header: "Type", type: "text" },
      { header: "Status", type: "text" },
      { header: "Completed", type: "date" },
      { header: "Recurring", type: "bool" },
      { header: "Invoiced", type: "bool" },
      { header: "Invoice #", type: "text" },
      { header: "Total", type: "currency" },
    ],
    rows: completedJobs.map((j) => [
      j.jobNumber ?? null,
      j.title ?? null,
      nameOf(j.clientName),
      j.jobType ?? null,
      j.jobStatus ?? null,
      j.completedAt,
      j.isRecurring,
      j.hasInvoice,
      j.invoiceNumber ?? null,
      j.total || 0,
    ]),
  });

  sections.push({
    key: "uninvoiced",
    title: "Uninvoiced Revenue",
    description:
      "Completed visits with no invoice attached — work done but not yet billed. Excludes jobs marked \"No Invoice\" in Jobber notes.",
    columns: [
      { header: "Visit Date", type: "date" },
      { header: "Job #", type: "text" },
      { header: "Title", type: "text" },
      { header: "Customer", type: "text" },
      { header: "Completed", type: "date" },
      { header: "Est. Value", type: "currency" },
    ],
    rows: uninvoicedVisits.map((v) => [
      v.visitDate,
      v.jobNumber ?? null,
      v.title ?? null,
      nameOf(v.clientName),
      v.completedAt,
      v.estimatedValue || 0,
    ]),
  });

  sections.push({
    key: "not-completed",
    title: "Jobs Not Marked As Completed",
    description:
      "Visits whose scheduled date has passed that aren't marked complete or invoiced.",
    columns: [
      { header: "Visit Date", type: "date" },
      { header: "Job #", type: "text" },
      { header: "Title", type: "text" },
      { header: "Customer", type: "text" },
      { header: "Status", type: "text" },
      { header: "Days Past", type: "int" },
      { header: "Est. Value", type: "currency" },
    ],
    rows: notCompletedVisits.map((v) => [
      v.visitDate,
      v.jobNumber ?? null,
      v.title ?? null,
      nameOf(v.clientName),
      v.visitStatus ?? null,
      v.visitDate
        ? Math.max(
            0,
            Math.floor((asOf.getTime() - v.visitDate.getTime()) / DAY_MS)
          )
        : null,
      v.estimatedValue || 0,
    ]),
  });

  sections.push({
    key: "receivables",
    title: "Outstanding Receivables",
    description:
      "Invoices issued in range that still have a balance owing, newest first.",
    columns: [
      { header: "Invoice #", type: "text" },
      { header: "Customer", type: "text" },
      { header: "Status", type: "text" },
      { header: "Issued", type: "date" },
      { header: "Due", type: "date" },
      { header: "Total", type: "currency" },
      { header: "Balance Due", type: "currency" },
      { header: "Email", type: "text" },
      { header: "Phone", type: "text" },
    ],
    rows: receivables.map((i) => [
      i.invoiceNumber ?? null,
      nameOf(i.clientName, i.customer),
      i.invoiceStatus ?? null,
      i.issuedAt,
      i.dueAt,
      i.total || 0,
      i.amountDue || 0,
      i.customer?.email ?? null,
      i.customer?.phone ?? null,
    ]),
  });

  sections.push({
    key: "overdue-invoices",
    title: "Overdue Invoices",
    description: `Past-due invoices, same definition as the Collections tab: Jobber "past_due" status, issued on or after ${COLLECTIONS_SINCE.toISOString().slice(
      0,
      10
    )}. Oldest due date first.`,
    columns: [
      { header: "Invoice #", type: "text" },
      { header: "Customer", type: "text" },
      { header: "Issued", type: "date" },
      { header: "Due", type: "date" },
      { header: "Days Past Due", type: "int" },
      { header: "Total", type: "currency" },
      { header: "Balance Due", type: "currency" },
      { header: "Email", type: "text" },
      { header: "Phone", type: "text" },
    ],
    rows: overdueInvoices.map((i) => [
      i.invoiceNumber ?? null,
      nameOf(i.clientName, i.customer),
      i.issuedAt,
      i.dueAt,
      i.dueAt
        ? Math.max(0, Math.floor((now.getTime() - i.dueAt.getTime()) / DAY_MS))
        : null,
      i.total || 0,
      i.amountDue || 0,
      i.customer?.email ?? null,
      i.customer?.phone ?? null,
    ]),
  });

  sections.push({
    key: "churn",
    title: "Recurring Churn (90 days)",
    description:
      "Recurring customers with no job completed in 90+ days. This list is always trailing-90-day and is not affected by the selected range.",
    columns: [
      { header: "Customer", type: "text" },
      { header: "Last Job", type: "date" },
      { header: "Lifetime Revenue", type: "currency" },
      { header: "Lifetime Jobs", type: "int" },
      { header: "Email", type: "text" },
      { header: "Phone", type: "text" },
    ],
    rows: churnedCustomers.map((c) => [
      nameOf(null, c),
      c.lastJobAt,
      c.totalRevenue || 0,
      c.jobCount || 0,
      c.email ?? null,
      c.phone ?? null,
    ]),
  });

  sections.push({
    key: "new-customers",
    title: "New Customers",
    description: "Customers created in Jobber during the range, newest first.",
    columns: [
      { header: "Customer", type: "text" },
      { header: "Created", type: "date" },
      { header: "Recurring", type: "bool" },
      { header: "Lifetime Revenue", type: "currency" },
      { header: "Lifetime Jobs", type: "int" },
      { header: "Email", type: "text" },
      { header: "Phone", type: "text" },
    ],
    rows: newCustomers.map((c) => [
      nameOf(null, c),
      c.createdAtJobber,
      c.isRecurring,
      c.totalRevenue || 0,
      c.jobCount || 0,
      c.email ?? null,
      c.phone ?? null,
    ]),
  });

  // Timesheets: per-employee rollup, then the underlying entries.
  const byEmployee = new Map<string, { hours: number; entries: number }>();
  for (const t of timeEntries) {
    const key = t.employeeName || "Unassigned";
    const ex = byEmployee.get(key) ?? { hours: 0, entries: 0 };
    ex.hours += hours(t.durationSeconds);
    ex.entries += 1;
    byEmployee.set(key, ex);
  }
  sections.push({
    key: "timesheets-summary",
    title: "Hours by Employee",
    description: "Time entries in range, rolled up per employee.",
    columns: [
      { header: "Employee", type: "text" },
      { header: "Hours", type: "number" },
      { header: "Entries", type: "int" },
    ],
    rows: Array.from(byEmployee.entries())
      .sort((a, b) => b[1].hours - a[1].hours)
      .map(([name, agg]) => [
        name,
        Math.round(agg.hours * 100) / 100,
        agg.entries,
      ]),
  });

  sections.push({
    key: "time-entries",
    title: "Time Entries",
    description: "Every time entry logged in range, newest first.",
    columns: [
      { header: "Date", type: "date" },
      { header: "Employee", type: "text" },
      { header: "Customer", type: "text" },
      { header: "Job #", type: "text" },
      { header: "Job Title", type: "text" },
      { header: "Hours", type: "number" },
      { header: "Approved", type: "bool" },
    ],
    rows: timeEntries.map((t) => [
      t.occurredAt,
      t.employeeName ?? null,
      nameOf(t.clientName),
      t.jobNumber ?? null,
      t.jobTitle ?? null,
      hours(t.durationSeconds),
      t.approved,
    ]),
  });

  return {
    businessName: "Flexx Landscaping",
    rangeLabel: range.label,
    rangeStart: range.start,
    rangeEnd: range.end,
    generatedAt: now,
    lastSyncAt: kpis.lastSyncAt,
    summary,
    sections,
  };
}

// Filename stem shared by both formats, e.g. flexx-report-2026-01-01_2026-07-31
export function reportFileStem(data: ReportData): string {
  const ymd = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate()
    ).padStart(2, "0")}`;
  return `flexx-report-${ymd(data.rangeStart)}_${ymd(data.rangeEnd)}`;
}
