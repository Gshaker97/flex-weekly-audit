import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { StatCard } from "@/components/ui/StatCard";
import DateRangeFilter from "@/components/ui/DateRangeFilter";
import { resolveDateRange, getDateRange } from "@/lib/dateRange";
import { formatCurrency, formatCurrencyDetailed, formatDate } from "@/lib/utils";
import { PiggyBank, FileText, Users, AlertTriangle, Phone } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function ReceivablesPage({
  searchParams,
}: {
  searchParams: { range?: string; start?: string; end?: string };
}) {
  const hasFilter =
    !!searchParams.range || !!searchParams.start || !!searchParams.end;
  const range = hasFilter ? resolveDateRange(searchParams) : getDateRange("allTime");

  const invoices = await prisma.invoiceRecord.findMany({
    where: {
      amountDue: { gt: 0 },
      issuedAt: { gte: range.start, lte: range.end },
    },
    orderBy: { issuedAt: "desc" },
  });

  const totalDue = invoices.reduce((acc, inv) => acc + (inv.amountDue || 0), 0);
  const uniqueCustomers = new Set(
    invoices.map((inv) => inv.clientName).filter(Boolean)
  ).size;

  const now = new Date();

  // Dedicated worklist: past-due invoices whose customer has no email. These are
  // skipped by the GHL Invoice Pipeline sync (it needs an email to create a
  // contact), so they need manual follow-up. Range-independent (all overdue).
  const overdueForContactCheck = await prisma.invoiceRecord.findMany({
    where: { amountDue: { gt: 0 }, dueAt: { not: null, lt: now } },
    include: { customer: true },
    orderBy: { dueAt: "asc" },
  });
  const SETTLED = new Set(["paid", "void", "bad_debt", "draft"]);
  const noContactInvoices = overdueForContactCheck.filter((inv) => {
    if (SETTLED.has((inv.invoiceStatus ?? "").toLowerCase())) return false;
    return !inv.customer?.email?.trim();
  });
  const noContactTotal = noContactInvoices.reduce(
    (acc, inv) => acc + (inv.amountDue || 0),
    0
  );

  return (
    <div className="space-y-6">
      <div>
        <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
          ← Back to dashboard
        </Link>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">Outstanding Receivables</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Invoices that have been issued but still have a balance owing. Showing{" "}
              <span className="font-medium text-foreground">{range.label}</span>.
            </p>
          </div>
          <DateRangeFilter />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label="Total Outstanding"
          value={formatCurrency(totalDue)}
          sublabel="Balance still owed"
          accent="warning"
          icon={<PiggyBank size={18} />}
        />
        <StatCard
          label="Invoice Count"
          value={invoices.length}
          sublabel="Unpaid invoices"
          icon={<FileText size={18} />}
        />
        <StatCard
          label="Customers Affected"
          value={uniqueCustomers}
          sublabel="Unique customers"
          icon={<Users size={18} />}
        />
      </div>

      <Card className="border-amber-500/40">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle size={18} className="text-amber-500" />
            Overdue · No Email on File
          </CardTitle>
          <CardDescription>
            Past-due invoices whose customer has no email — these can&apos;t auto-sync to
            GoHighLevel and need manual follow-up.{" "}
            <span className="font-medium text-foreground">
              {formatCurrency(noContactTotal)}
            </span>{" "}
            across {noContactInvoices.length} invoice
            {noContactInvoices.length === 1 ? "" : "s"} (all dates).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {noContactInvoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Every overdue invoice has an email on file. 🎉
            </p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">Customer</th>
                    <th className="px-4 py-2.5 font-medium">Invoice</th>
                    <th className="px-4 py-2.5 font-medium">Due</th>
                    <th className="px-4 py-2.5 font-medium">Phone</th>
                    <th className="px-4 py-2.5 font-medium">Amount Due</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {noContactInvoices.map((inv) => {
                    const daysOverdue = inv.dueAt
                      ? Math.floor((now.getTime() - inv.dueAt.getTime()) / 86400000)
                      : 0;
                    const phone = inv.customer?.phone?.trim();
                    return (
                      <tr key={inv.id} className="hover:bg-muted/30">
                        <td className="px-4 py-3">
                          {inv.clientName ?? inv.customer?.name ?? "—"}
                        </td>
                        <td className="px-4 py-3 font-medium">
                          {inv.invoiceNumber ? `#${inv.invoiceNumber}` : "—"}
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-muted-foreground">{formatDate(inv.dueAt)}</span>
                          <Badge variant="danger" className="ml-2">
                            {daysOverdue}d overdue
                          </Badge>
                        </td>
                        <td className="px-4 py-3">
                          {phone ? (
                            <a
                              href={`tel:${phone}`}
                              className="inline-flex items-center gap-1 text-foreground hover:underline"
                            >
                              <Phone size={13} /> {phone}
                            </a>
                          ) : (
                            <span className="text-muted-foreground">no phone</span>
                          )}
                        </td>
                        <td className="px-4 py-3 font-semibold">
                          {formatCurrencyDetailed(inv.amountDue)}
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

      <Card>
        <CardHeader>
          <CardTitle>Unpaid Invoices</CardTitle>
          <CardDescription>Most recently issued first</CardDescription>
        </CardHeader>
        <CardContent>
          {invoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No outstanding receivables in this range. 🎉
            </p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">Invoice</th>
                    <th className="px-4 py-2.5 font-medium">Customer</th>
                    <th className="px-4 py-2.5 font-medium">Issued</th>
                    <th className="px-4 py-2.5 font-medium">Due</th>
                    <th className="px-4 py-2.5 font-medium">Amount Due</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {invoices.map((inv) => {
                    const overdue = inv.dueAt ? inv.dueAt < now : false;
                    return (
                      <tr key={inv.id} className="hover:bg-muted/30">
                        <td className="px-4 py-3 font-medium">
                          {inv.invoiceNumber ? `#${inv.invoiceNumber}` : "—"}
                        </td>
                        <td className="px-4 py-3">{inv.clientName ?? "—"}</td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {formatDate(inv.issuedAt)}
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-muted-foreground">{formatDate(inv.dueAt)}</span>
                          {overdue && (
                            <Badge variant="danger" className="ml-2">
                              Past due
                            </Badge>
                          )}
                        </td>
                        <td className="px-4 py-3 font-semibold">
                          {formatCurrencyDetailed(inv.amountDue)}
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
