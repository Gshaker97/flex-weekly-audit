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
import { overdueInvoicesWhere, legacyOverdueWhere, overdueDisplayBasis } from "@/lib/invoiceMetrics";
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

  // Same display predicate and issue-date cutoff as the dashboard/report.
  // Stored-date aging does not overwrite the cached status or trigger reminders.
  const invoices = await prisma.invoiceRecord.findMany({
    where: overdueInvoicesWhere(range, COLLECTIONS_SINCE, now),
    include: { customer: true },
    orderBy: { dueAt: "asc" },
  });

  const legacyInvoices = await prisma.invoiceRecord.findMany({
    where: legacyOverdueWhere(range, COLLECTIONS_SINCE, now),
    orderBy: { dueAt: "asc" },
  });
  const legacyTotal = legacyInvoices.reduce((sum, i) => sum + i.amountDue, 0);

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
              Positive balances with cached past_due status or awaiting_payment whose stored due date has passed, issued since January 1, 2026 and within{" "}
              <span className="font-medium text-foreground">{range.label}</span>. Stored-date aging is calculated for display, not refreshed source status or the original sent-day reminder clock. This is the Collections cutoff scope.
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
          sublabel="Cached status or stored-date aging"
          icon={<Receipt size={18} />}
        />
        <StatCard
          label="Customers Affected"
          value={uniqueCustomers}
          sublabel="Unique customers"
          icon={<Users size={18} />}
        />
      </div>

      {legacyInvoices.length > 0 && <Card className="border-amber-500/40">
        <CardHeader><CardTitle>Older Past Due Outside Collections Scope</CardTitle><CardDescription>{legacyInvoices.length} records / {formatCurrencyDetailed(legacyTotal)} within the selected range predate the cutoff. Policy exclusion does not prove settlement. Verify before any catch-up reminder.</CardDescription></CardHeader>
        <CardContent><div className="overflow-x-auto"><table className="w-full text-sm">
          <thead><tr className="text-left"><th className="p-2">Invoice</th><th className="p-2">Customer</th><th className="p-2">Issued</th><th className="p-2">Balance</th></tr></thead>
          <tbody>{legacyInvoices.map(inv => <tr key={inv.id} className="border-t border-border"><td className="p-2">#{inv.invoiceNumber ?? "Unknown"}<div className="text-xs text-muted-foreground">Cached status: {inv.invoiceStatus ?? "Unknown"}<br />{overdueDisplayBasis(inv, now)}</div></td><td className="p-2">{inv.clientName ?? "Unknown"}</td><td className="p-2">{formatDate(inv.issuedAt)}</td><td className="p-2">{formatCurrencyDetailed(inv.amountDue)}</td></tr>)}</tbody>
        </table></div></CardContent>
      </Card>}

      <Card>
        <CardHeader>
          <CardTitle>Overdue Invoices in Collections Scope</CardTitle>
          <CardDescription>Oldest stored due date first. Age is elapsed days from that due date, not from the sent date. Linked job dates can describe a recurring job term, not this invoice service date or sent date.</CardDescription>
        </CardHeader>
        <CardContent>
          {invoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">No overdue invoices within this Collections scope.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">Customer</th>
                    <th className="px-4 py-2.5 font-medium">Invoice</th>
                    <th className="px-4 py-2.5 font-medium">Due Date</th>
                    <th className="px-4 py-2.5 font-medium">Linked Job Date</th>
                    <th className="px-4 py-2.5 text-right font-medium">Balance Due</th>
                    <th className="px-4 py-2.5 text-right font-medium">Due-Date Age</th>
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
                          <div className="text-xs font-normal text-muted-foreground">Cached status: {inv.invoiceStatus ?? "Unknown"}</div>
                          <div className="text-xs font-normal text-muted-foreground">{overdueDisplayBasis(inv, now)}</div>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {formatDate(inv.dueAt)}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {jobDate ? formatDate(jobDate) : "—"}
                        </td>
                        <td className="px-4 py-3 text-right font-semibold">
                          {formatCurrencyDetailed(inv.amountDue)}
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
