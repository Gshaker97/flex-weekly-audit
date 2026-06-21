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
import { formatCurrency, formatCurrencyDetailed, formatDate } from "@/lib/utils";
import { Receipt, PiggyBank, Users } from "lucide-react";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;
const SETTLED = new Set(["paid", "void", "bad_debt", "draft"]);

export default async function OverdueInvoicesPage() {
  const now = new Date();

  // All unpaid invoices past their due date (current-state worklist, no range).
  const all = await prisma.invoiceRecord.findMany({
    where: { amountDue: { gt: 0 }, dueAt: { not: null, lt: now } },
    include: { customer: true },
    orderBy: { dueAt: "asc" },
  });
  const invoices = all.filter(
    (i) => !SETTLED.has((i.invoiceStatus ?? "").toLowerCase())
  );

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
        <div className="mt-2">
          <h2 className="text-2xl font-semibold tracking-tight">Overdue Invoices</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Every unpaid invoice past its due date, with the job date and how late it is.
          </p>
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
