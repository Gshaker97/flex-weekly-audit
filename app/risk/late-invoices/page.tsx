import Link from "next/link";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/Card";
import { StatCard } from "@/components/ui/StatCard";
import { formatCurrency, formatCurrencyDetailed } from "@/lib/utils";
import {
  getLateInvoiceCollections,
  REMINDER_THRESHOLDS,
  type ReminderCell,
} from "@/lib/lateInvoices";
import { CalledCheckbox } from "./CalledCheckbox";
import { CheckCircle2, Clock, XCircle, PiggyBank, FileText, Phone } from "lucide-react";

export const dynamic = "force-dynamic";
// GHL conversation lookups per customer take a little while; allow headroom.
export const maxDuration = 120;

function ReminderCellView({ cell }: { cell: ReminderCell }) {
  if (cell.status === "sent") {
    return (
      <span title={`Reminder sent (~${cell.threshold}d)`} className="inline-flex justify-center text-green-600">
        <CheckCircle2 size={18} />
      </span>
    );
  }
  if (cell.status === "pending") {
    return (
      <span className="inline-flex flex-col items-center text-amber-500">
        <Clock size={16} />
        <span className="mt-0.5 text-[10px] leading-none text-muted-foreground">
          {cell.daysUntil != null ? `${cell.daysUntil}d` : "—"}
        </span>
      </span>
    );
  }
  return (
    <span title={`No reminder sent (was due ~${cell.threshold}d)`} className="inline-flex justify-center text-red-500">
      <XCircle size={18} />
    </span>
  );
}

export default async function LateInvoicesPage() {
  const rows = await getLateInvoiceCollections();

  const totalDue = rows.reduce((acc, r) => acc + r.amountDue, 0);
  const calledCount = rows.filter((r) => r.called).length;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
          ← Back to dashboard
        </Link>
        <div className="mt-2">
          <h2 className="text-2xl font-semibold tracking-tight">Collections — Late Invoices</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Every past-due invoice and whether the customer has been contacted per the
            reminder sequence. Reminder status comes from outbound SMS in GoHighLevel
            (±3 days of the expected send date).
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label="Past-Due Invoices"
          value={rows.length}
          sublabel="Status: past_due"
          icon={<FileText size={18} />}
        />
        <StatCard
          label="Total Past Due"
          value={formatCurrency(totalDue)}
          sublabel="Balance owed"
          accent="warning"
          icon={<PiggyBank size={18} />}
        />
        <StatCard
          label="Called by Sarah"
          value={`${calledCount} / ${rows.length}`}
          sublabel="21-day phone step"
          icon={<Phone size={18} />}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Reminder Sequence</CardTitle>
          <CardDescription className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="inline-flex items-center gap-1">
              <CheckCircle2 size={14} className="text-green-600" /> sent
            </span>
            <span className="inline-flex items-center gap-1">
              <Clock size={14} className="text-amber-500" /> not yet due (sends in Xd)
            </span>
            <span className="inline-flex items-center gap-1">
              <XCircle size={14} className="text-red-500" /> overdue, not sent
            </span>
          </CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No past-due invoices. 🎉</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">Customer</th>
                    <th className="px-4 py-2.5 font-medium">Invoice</th>
                    <th className="px-4 py-2.5 text-center font-medium">Days Past Due</th>
                    {REMINDER_THRESHOLDS.map((t) => (
                      <th key={t} className="px-3 py-2.5 text-center font-medium">
                        {t}-day
                      </th>
                    ))}
                    <th className="px-4 py-2.5 text-center font-medium">Sarah called (21d)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((r) => (
                    <tr key={r.invoiceId} className="hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <div className="font-medium">{r.customerName}</div>
                        <div className="text-xs text-muted-foreground">
                          {r.email ?? "no email"}
                          {r.phone ? ` · ${r.phone}` : ""}
                          {r.ghlError ? " · GHL lookup failed" : ""}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium">
                          {r.invoiceNumber ? `#${r.invoiceNumber}` : "—"}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {formatCurrencyDetailed(r.amountDue)}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-center font-semibold">{r.daysPastDue}</td>
                      {r.reminders.map((cell) => (
                        <td key={cell.threshold} className="px-3 py-3 text-center">
                          <ReminderCellView cell={cell} />
                        </td>
                      ))}
                      <td className="px-4 py-3 text-center">
                        <CalledCheckbox
                          invoiceId={r.invoiceId}
                          initial={r.called}
                          calledBy={r.calledBy}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
