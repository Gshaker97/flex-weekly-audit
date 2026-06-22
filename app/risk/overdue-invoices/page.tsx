import Link from "next/link";
import { prisma } from "@/lib/prisma";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { StatCard } from "@/components/ui/StatCard";
import DateRangeFilter from "@/components/ui/DateRangeFilter";
import { resolveDateRange, getDateRange } from "@/lib/dateRange";
import { COLLECTIONS_SINCE } from "@/lib/lateInvoices";
import { formatCurrency, formatCurrencyDetailed, formatDate } from "@/lib/utils";
import { Receipt, PiggyBank, Users } from "lucide-react";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;

export default async function OverdueInvoicesPage({
  searchParams,
}: {
  searchParams: { range?: string; start?: string; end?: string };
}) {
  const now = new Date();
  const hasFilter =
    !!searchParams.range || !!searchParams.start || !!searchParams.end;
  const range = hasFilter ? resolveDateRange(searchParams) : getDateRange("allTime");

  // Past-due invoices — same definition as the Collections tab: Jobber's exact
  // "past_due" status, issued on/after the COLLECTIONS_SINCE cutoff. The
  // selected range is intersected with the cutoff so the count here matches the
  // Collections tab and the dashboard "Overdue Invoices" stat.
  const overdueFrom =
    range.start > COLLECTIONS_SINCE ? range.start : COLLECTIONS_SINCE;
  const invoices = await prisma.invoiceRecord.findMany({
    where: {
      invoiceStatus: "past_due",
      issuedAt: { gte: overdueFrom, lte: range.end },
    },
    include: { customer: true },
    orderBy: { dueAt: "asc" },
  });

  // Job date per invoice: match InvoiceRecord.invoiceNumber -> JobRecord.invoiceNumber
  // and use the job's completion (or scheduled end) date.
  const invoiceNumbers = invoices
    .map((i) => i.invoiceNumber)
    .filter((n): n is string => !!n);
  const jobs = invoiceNumbers.length
    ? await prisma.jobRecord.findMany({
        where: { invoiceNumber: { in: invoiceNumbers } },
        select: { invoiceNumber: true, completedAt: true, endAt: true },
      })
    : [];
  const jobDateByInvoice = new Map<string, Date>();
  for (const j of jobs) {
    if (!j.invoiceNumber) continue;
    const d = j.completedAt ?? j.endAt;
    if (!d) continue;
    const existing = jobDateByInvoice.get(j.invoiceNumber);
    if (!existing || d > existing) jobDateByInvoice.set(j.invoiceNumber, d);
  }

  const totalDue = invoices.reduce((acc, i) => acc + (i.amountDue || 0), 0);
  const uniqueCustomers = new Set(
    invoices.map((i) => i.clientName).filter(Boolean)
  ).size;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
          ← Back to dashboard
        </Link>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">Overdue Invoices</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Every invoice Jobber marks past due, with the job date and how late it is.
              Issued{" "}
              <span className="font-medium text-foreground">{range.label}</span>.
            </p>
          </div>
          <DateRangeFilter />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label="Total Overdue"
          value={formatCurrency(totalDue)}
          sublabel="Balance owed"
          accent="danger"
          icon={<PiggyBank size={18} />}
        />
        <StatCard
          label="Invoice Count"
          value={invoices.length}
          sublabel="Unpaid, past due"
          icon={<Receipt size={18} />}
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
          <CardTitle>Overdue Invoices</CardTitle>
          <CardDescription>Most overdue first</CardDescription>
        </CardHeader>
        <CardContent>
          {invoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">No overdue invoices. 🎉</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">Customer</th>
                    <th className="px-4 py-2.5 font-medium">Invoice</th>
                    <th className="px-4 py-2.5 font-medium">Due Date</th>
                    <th className="px-4 py-2.5 font-medium">Job Date</th>
                    <th className="px-4 py-2.5 text-right font-medium">Total Invoice</th>
                    <th className="px-4 py-2.5 text-right font-medium">How Late</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {invoices.map((inv) => {
                    const daysLate = inv.dueAt
                      ? Math.floor((now.getTime() - inv.dueAt.getTime()) / DAY_MS)
                      : 0;
                    const jobDate = inv.invoiceNumber
                      ? jobDateByInvoice.get(inv.invoiceNumber) ?? null
                      : null;
                    return (
                      <tr key={inv.id} className="hover:bg-muted/30">
                        <td className="px-4 py-3">
                          {inv.clientName ?? inv.customer?.name ?? "—"}
                        </td>
                        <td className="px-4 py-3 font-medium">
                          {inv.invoiceNumber ? `#${inv.invoiceNumber}` : "—"}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {formatDate(inv.dueAt)}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {jobDate ? formatDate(jobDate) : "—"}
                        </td>
                        <td className="px-4 py-3 text-right font-semibold">
                          {formatCurrencyDetailed(inv.total)}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <Badge variant="danger">{daysLate}d late</Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
