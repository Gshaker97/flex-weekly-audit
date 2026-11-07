import { prisma } from "./prisma";
import { DateRange } from "./dateRange";
import { computeDashboardKPIs } from "./kpis";
import { COLLECTIONS_SINCE } from "./lateInvoices";
import { openReceivablesWhere, balanceReviewWhere, overdueInvoicesWhere, legacyOverdueWhere, invoiceValueIncluded, invoiceReviewReason, totalLessBalance, invoiceMonthKey, sumInvoiceMonths } from "./invoiceMetrics";
import {
  excludeNotYetDue,
  getVisitFreshnessCutoff,
  stillInJobber,
} from "./visitFreshness";
import { classifyEntry, SEGMENT_LABELS } from "./crewSegments";
import {
  formatCurrency,
  formatCurrencyDetailed,
  formatNumber,
  formatPercent,
} from "./utils";

// A single downloadable report covering everything the dashboard and its
// drill-down pages show, scoped to one date range. Each section reuses the same
// invoice query definitions as the page it mirrors. Values reflect the cache
// at report generation; separate requests can observe different sync results.

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
  /** Defaults to "Full Business Report". */
  reportTitle?: string;
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
  const visitCutoff = await getVisitFreshnessCutoff();

  // ---------------------------------------------------------------- summary

  // Overdue invoices use the Collections definition (Jobber's exact "past_due"
  // status, issued on/after the cutoff), matching the dashboard stat.
  const [
    invoices,
    completedJobs,
    uninvoicedVisits,
    notCompletedVisits,
    receivables,
    overdueInvoices,
    balanceReviewInvoices,
    legacyOverdueInvoices,
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
        OR: [{ isComplete: true }, { jobComplete: true }],
        hasInvoice: false,
        noInvoiceFlag: false,
        visitDate: { gte: range.start, lte: range.end },
        ...stillInJobber(visitCutoff),
      },
      orderBy: { visitDate: "desc" },
    }),
    prisma.visitRecord.findMany({
      where: {
        isComplete: false,
        jobComplete: false,
        hasInvoice: false,
        visitDate: { gte: range.start, lte: range.end, lt: asOf },
        ...stillInJobber(visitCutoff),
        ...excludeNotYetDue(),
      },
      orderBy: { visitDate: "desc" },
    }),
    prisma.invoiceRecord.findMany({
      where: openReceivablesWhere(range),
      include: { customer: true },
      orderBy: { issuedAt: "desc" },
    }),
    prisma.invoiceRecord.findMany({
      where: overdueInvoicesWhere(range, COLLECTIONS_SINCE),
      include: { customer: true },
      orderBy: { dueAt: "asc" },
    }),
    prisma.invoiceRecord.findMany({
      where: balanceReviewWhere(range),
      include: { customer: true },
      orderBy: { issuedAt: "desc" },
    }),
    prisma.invoiceRecord.findMany({
      where: legacyOverdueWhere(range, COLLECTIONS_SINCE),
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
      label: "Issued Invoice Value",
      value: formatCurrencyDetailed(kpis.revenueInRange),
      detail:
        kpis.revenueChangePercent == null
          ? "Known issued states; excludes void/draft/unknown; not cash · no prior period data"
          : `Issued invoice value, not cash · ${
              kpis.revenueChangePercent >= 0 ? "+" : ""
            }${formatPercent(kpis.revenueChangePercent, 1)} vs ${formatCurrency(
              kpis.revenueCompareValue
            )} prior period`,
    },
    {
      label: "Average Job Value",
      value: formatCurrencyDetailed(kpis.averageJobValue),
      // The average covers only jobs that carry a value, so quoting the full
      // completed count next to it overstated what it was averaged over.
      detail: `${formatNumber(
        completedJobs.filter((j) => (j.total || 0) > 0).length
      )} of ${formatNumber(
        completedJobs.length
      )} completed jobs carry a value`,
    },
    {
      label: "Outstanding Receivables",
      value: formatCurrencyDetailed(kpis.outstandingReceivables),
      detail: `${formatNumber(receivables.length)} open-status positive balances now, issued in range; review conflicts excluded`,
    },
    {
      label: "Recurring share of estimated visit value",
      value: recurringShare == null ? "—" : formatPercent(recurringShare),
      detail: `${formatCurrencyDetailed(
        kpis.recurringRevenueInRange
      )} recurring · ${formatCurrencyDetailed(
        kpis.oneOffRevenueInRange
      )} one-off. Estimated completed or invoiced visit value in range; not invoice revenue or cash`,
    },
    {
      label: "Jobs Not Marked Completed",
      value: formatCurrencyDetailed(kpis.overdueRevenue),
      detail: `${formatNumber(
        kpis.overdueJobCount
      )} visits past their date, not completed`,
    },
    {
      label: "Overdue Invoices in Collections Scope",
      value: formatCurrencyDetailed(overdueInvoiceTotal),
      detail: `${formatNumber(overdueInvoices.length)} current past_due balances, issued since ${COLLECTIONS_SINCE.toISOString().slice(0, 10)} and in selected range`,
    },
    {
      label: "Estimated Uninvoiced Work",
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
      label: "Invoice Records in Range",
      value: formatNumber(invoices.length),
      detail: `${formatNumber(invoices.filter(i => invoiceValueIncluded(i.invoiceStatus)).length)} included in issued invoice value; raw records retained below`,
    },
    {
      label: "Balances Requiring Review",
      value: formatCurrencyDetailed(kpis.balanceReviewTotal),
      detail: `${kpis.balanceReviewCount} positive balances with paid/void/draft/bad-debt/unknown status; not confirmed collectible`,
    },
    {
      label: "Past Due Before Collections Cutoff",
      value: formatCurrencyDetailed(legacyOverdueInvoices.reduce((sum, i) => sum + i.amountDue, 0)),
      detail: `${legacyOverdueInvoices.length} older past_due records within selected range; not automatically settled`,
    },
    {
      label: "Excluded Invoice Value",
      value: formatCurrencyDetailed(invoices.filter(i => !invoiceValueIncluded(i.invoiceStatus)).reduce((sum, i) => sum + i.total, 0)),
      detail: "Draft, void or unrecognized status; all underlying records retained",
    },
    {
      label: "Cash Collected",
      value: "Not verified",
      detail: "No payment transaction ledger or actual payment dates in this report; total minus balance is not proof of cash",
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
  const monthlyInvoiceValues = sumInvoiceMonths(invoices.filter(i => invoiceValueIncluded(i.invoiceStatus)));
  const jobsByMonth = new Map<string, typeof completedJobs>();
  for (const job of completedJobs) {
    if (!job.completedAt) continue;
    const key = invoiceMonthKey(job.completedAt);
    jobsByMonth.set(key, [...(jobsByMonth.get(key) ?? []), job]);
  }
  const customersByMonth = new Map<string, number>();
  for (const customer of newCustomers) {
    if (!customer.createdAtJobber) continue;
    const key = invoiceMonthKey(customer.createdAtJobber);
    customersByMonth.set(key, (customersByMonth.get(key) ?? 0) + 1);
  }
  sections.push({
    key: "monthly",
    title: "Monthly Performance",
    description: "Issued invoice value (not cash), completed jobs and new customers within the exact selected dates. Partial months are not expanded.",
    columns: [
      { header: "Month", type: "text" },
      { header: "Issued Invoice Value", type: "currency" },
      { header: "Jobs Completed", type: "int" },
      { header: "Avg Job Value", type: "currency" },
      { header: "New Customers", type: "int" },
    ],
    rows: monthly.map((m) => {
      const key = `${m.year}-${String(m.month).padStart(2, "0")}`;
      const jobs = jobsByMonth.get(key) ?? [];
      const valued = jobs.filter(j => j.total > 0);
      return [m.label, monthlyInvoiceValues.get(key) ?? 0, jobs.length,
        valued.length ? valued.reduce((sum, j) => sum + j.total, 0) / valued.length : 0,
        customersByMonth.get(key) ?? 0];
    }),
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
    title: "Completed Job Value by Customer",
    description:
      "Completed job values in range, highest first. This is not the invoice or cash total.",
    columns: [
      { header: "Customer", type: "text" },
      { header: "Job Value", type: "currency" },
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
    title: "Completed Job Value by Service Type",
    description: "Completed jobs in range, grouped by job type.",
    columns: [
      { header: "Service", type: "text" },
      { header: "Job Value", type: "currency" },
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
    title: "Invoice Records in Range",
    description: "Every cached invoice record dated in range, including excluded statuses. Issued invoice value uses paid, awaiting_payment, past_due and bad_debt only. Total minus balance can include credits, write-offs or voids and is not cash received.",
    columns: [
      { header: "Invoice #", type: "text" },
      { header: "Customer", type: "text" },
      { header: "Status", type: "text" },
      { header: "Issued", type: "date" },
      { header: "Due", type: "date" },
      { header: "Total", type: "currency" },
      { header: "Total Minus Balance", type: "currency" },
      { header: "Balance Due", type: "currency" },
      { header: "Review Note", type: "text" },
    ],
    rows: invoices.map((i) => [
      i.invoiceNumber ?? null,
      nameOf(i.clientName, i.customer),
      i.invoiceStatus ?? null,
      i.issuedAt,
      i.dueAt,
      i.total || 0,
      totalLessBalance(i.total, i.amountDue),
      i.amountDue || 0,
      invoiceReviewReason(i),
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
    title: "Estimated Uninvoiced Work",
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
      "Current positive balances for awaiting_payment or past_due invoices issued in range. Other positive balances are in the review section; this is not a historical as-of balance.",
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
    title: "Overdue Invoices in Collections Scope",
    description: `Current positive balances with cached Jobber "past_due" status, issued on or after ${COLLECTIONS_SINCE.toISOString().slice(
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

  for (const [key, title, description, records] of [
    ["invoice-review", "Invoice Balances Requiring Review", "Positive balances with non-open status. Verify current source, credits and actual payments before collection or settlement.", balanceReviewInvoices],
    ["legacy-overdue", "Past Due Before Collections Cutoff", "Older past_due records within the selected range, excluded by the collections cutoff rather than proven settled. Do not automatically send catch-up reminders.", legacyOverdueInvoices],
  ] as const) {
    sections.push({ key, title, description, columns: [
      { header: "Invoice #", type: "text" }, { header: "Customer", type: "text" },
      { header: "Status", type: "text" }, { header: "Issued", type: "date" },
      { header: "Total", type: "currency" }, { header: "Balance", type: "currency" },
      { header: "Review Note", type: "text" },
    ], rows: records.map(i => [i.invoiceNumber, nameOf(i.clientName, i.customer), i.invoiceStatus,
      i.issuedAt, i.total, i.amountDue, invoiceReviewReason(i) || "Outside collections cutoff; verify before any action"]), });
  }

  sections.push({
    key: "churn",
    title: "Recurring Churn (90 days)",
    description:
      "Recurring customers with no job completed in 90+ days. This list is always trailing-90-day and is not affected by the selected range. Cached Job Value is the sum of cached linked job totals across statuses; not lifetime invoiced or collected revenue.",
    columns: [
      { header: "Customer", type: "text" },
      { header: "Last Job", type: "date" },
      { header: "Cached Job Value", type: "currency" },
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
    description: "Customers created in Jobber during the range, newest first. Cached Job Value is the sum of cached linked job totals across statuses; not lifetime invoiced or collected revenue.",
    columns: [
      { header: "Customer", type: "text" },
      { header: "Created", type: "date" },
      { header: "Recurring", type: "bool" },
      { header: "Cached Job Value", type: "currency" },
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

  // Timesheets. Each entry is split into residential vs commercial crew work
  // the same way the Time Tracking page does it, so the two always agree.
  const entryJobIds = Array.from(
    new Set(timeEntries.map((t) => t.jobberJobId).filter(Boolean))
  ) as string[];
  const entryJobs = entryJobIds.length
    ? await prisma.jobRecord.findMany({
        where: { jobberJobId: { in: entryJobIds } },
        select: { jobberJobId: true, customerId: true },
      })
    : [];
  const entryJobById = new Map(entryJobs.map((j) => [j.jobberJobId, j]));
  const entryCustomerIds = Array.from(
    new Set(entryJobs.map((j) => j.customerId).filter(Boolean))
  ) as string[];
  const entryCustomers = entryCustomerIds.length
    ? await prisma.customer.findMany({
        where: { id: { in: entryCustomerIds } },
        select: { id: true, companyName: true },
      })
    : [];
  const entryCustomerById = new Map(entryCustomers.map((c) => [c.id, c]));

  const classifiedEntries = timeEntries.map((t) => {
    const job = t.jobberJobId ? entryJobById.get(t.jobberJobId) : null;
    const customer = job?.customerId ? entryCustomerById.get(job.customerId) : null;
    return {
      entry: t,
      ...classifyEntry({
        employeeName: t.employeeName,
        label: t.label,
        clientCompanyName: t.clientCompanyName ?? customer?.companyName ?? null,
      }),
    };
  });

  const byEmployee = new Map<
    string,
    { hours: number; residential: number; commercial: number; entries: number }
  >();
  for (const { entry: t, segment } of classifiedEntries) {
    const key = t.employeeName || "Unassigned";
    const ex =
      byEmployee.get(key) ?? { hours: 0, residential: 0, commercial: 0, entries: 0 };
    const h = hours(t.durationSeconds);
    ex.hours += h;
    if (segment === "residential") ex.residential += h;
    else ex.commercial += h;
    ex.entries += 1;
    byEmployee.set(key, ex);
  }
  sections.push({
    key: "timesheets-summary",
    title: "Hours by Crew Member",
    description:
      "Time entries in range, rolled up per crew member and split by crew type.",
    columns: [
      { header: "Crew Member", type: "text" },
      { header: "Residential Hours", type: "number" },
      { header: "Commercial Hours", type: "number" },
      { header: "Total Hours", type: "number" },
      { header: "Entries", type: "int" },
    ],
    rows: Array.from(byEmployee.entries())
      .sort((a, b) => b[1].hours - a[1].hours)
      .map(([name, agg]) => [
        name,
        Math.round(agg.residential * 100) / 100,
        Math.round(agg.commercial * 100) / 100,
        Math.round(agg.hours * 100) / 100,
        agg.entries,
      ]),
  });

  sections.push({
    key: "time-entries",
    title: "Time Entries",
    description:
      "Every time entry logged in range, newest first. Crew type comes from the Jobber crew account the time was logged under, falling back to the entry's time label and then the client type.",
    columns: [
      { header: "Date", type: "date" },
      { header: "Crew Member", type: "text" },
      { header: "Crew Type", type: "text" },
      { header: "Jobber Label", type: "text" },
      { header: "Customer", type: "text" },
      { header: "Job #", type: "text" },
      { header: "Job Title", type: "text" },
      { header: "Hours", type: "number" },
      { header: "Approved", type: "bool" },
    ],
    rows: classifiedEntries.map(({ entry: t, segment }) => [
      t.occurredAt,
      t.employeeName ?? null,
      SEGMENT_LABELS[segment],
      t.label ?? null,
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
