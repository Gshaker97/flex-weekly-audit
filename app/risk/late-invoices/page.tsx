import Link from "next/link";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/Card";
import { StatCard } from "@/components/ui/StatCard";
import { formatCurrency, formatCurrencyDetailed, formatDate } from "@/lib/utils";
import {
  getLateInvoiceCollections,
  REMINDER_THRESHOLDS,
  type ReminderCell,
} from "@/lib/lateInvoices";
import { hasAmbiguousDateOnlyEncoding, smsReadiness } from "@/lib/collection-evidence";
import { CalledCheckbox } from "./CalledCheckbox";
import { PiggyBank, FileText, Phone } from "lucide-react";

export const dynamic = "force-dynamic";
function collectionDateLabel(date: Date | null): string {
  if (!date || !Number.isFinite(date.getTime())) return "Unknown";
  return hasAmbiguousDateOnlyEncoding(date)
    ? `${date.toISOString()} (stored UTC value; source date meaning unverified)`
    : formatDate(date);
}
function ReminderCellView({ cell }: { cell: ReminderCell }) {
  const days = cell.approximateDaysUntil;
  const timing = days == null ? "Due-date timing unverified" : days > 0
    ? `Due-date reference in ${days}d`
    : days === 0 ? "Due-date reference today" : `Due-date reference ${-days}d ago`;
  return (
    <span title="No invoice-linked reminder evidence. Timing is approximate, not a send schedule." className="inline-flex flex-col items-center text-muted-foreground">
      <span className="text-xs font-medium">Unknown</span>
      <span className="mt-1 text-[10px]">{timing}</span>
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
            Positive balances on invoices issued since January 1, 2026: cached past_due status or awaiting_payment whose stored due date has passed. Stored-date aging is a display calculation, not refreshed source status or the original sent-day reminder clock. Includes phone-only and email-only customers.
            Reminder evidence is unverified: there is no stored association between an invoice,
            a reminder milestone and a message receipt. Unrelated outbound SMS does not prove a reminder was sent.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label="Past-Due Invoices"
          value={rows.length}
          sublabel="Cached status or stored-date aging"
          icon={<FileText size={18} />}
        />
        <StatCard
          label="Total Past Due"
          value={formatCurrency(totalDue)}
          sublabel="Positive balances in this display scope"
          accent="warning"
          icon={<PiggyBank size={18} />}
        />
        <StatCard
          label="Calls manually marked"
          value={`${calledCount} / ${rows.length}`}
          sublabel="Self-reported, not verified calls"
          icon={<Phone size={18} />}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Reminder Evidence and Policy Reference</CardTitle>
          <CardDescription>
            Maintenance reference: days 10, 15, 20, 25 and 30. Irrigation reference: days 10 and 15 only.
            Sarah&apos;s manual call prompt is day 21; a prompt is not proof of a call.
            Service classification is unknown for these invoices, so the columns do not indicate required steps.
            Timing below is approximate, based on the stored due date in Arizona time.
            UTC-midnight values may encode date-only source fields; their calendar age is withheld until verified.
            Policy: invoice sent day is day 0 and due that day; the next Arizona calendar day is day 1 late.
            The verified sent date is not yet available, so stored source due dates are not treated as that policy clock.
            A documented attempt needs an invoice-and-milestone-linked message record. Provider-confirmed delivery
            needs a delivery receipt for that exact message; an attempt alone does not prove delivery.
            Neither evidence is available here. No automatic sends are scheduled by this page.
            Unknown means neither sent nor not sent is established.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No positive overdue balances by cached status or stored due date in this scope.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">Customer</th>
                    <th className="px-4 py-2.5 font-medium">Invoice</th>
                    <th className="px-4 py-2.5 font-medium">Service / Issue Date (proxy)</th>
                    <th className="px-4 py-2.5 text-center font-medium">Days Past Stored Due Date (approx.)</th>
                    {REMINDER_THRESHOLDS.map((t) => (
                      <th key={t} className="px-3 py-2.5 text-center font-medium">
                        Day {t} reference
                      </th>
                    ))}
                    <th className="px-4 py-2.5 text-center font-medium">Manual call mark (day 21 reference)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((r) => (
                    <tr key={r.invoiceId} className="hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <div className="font-medium">{r.customerName}</div>
                        <div className="text-xs text-muted-foreground">Service type: unknown</div>
                        <div className="text-xs text-muted-foreground">{smsReadiness(r.phone)}</div>
                        <div className="text-xs text-muted-foreground">
                          {r.email ?? "no email"}
                          {r.phone ? ` · ${r.phone}` : ""}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium">
                          {r.invoiceNumber ? `#${r.invoiceNumber}` : "—"}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {formatCurrencyDetailed(r.amountDue)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Stored due value: {collectionDateLabel(r.dueAt)}
                        </div>
                        <div className="text-xs text-muted-foreground">Cached status: {r.cachedStatus ?? "Unknown"}</div>
                        <div className="text-xs text-muted-foreground">{r.displayBasis}</div>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {collectionDateLabel(r.serviceDate)}
                      </td>
                      <td className="px-4 py-3 text-center font-semibold">{r.daysPastDue ?? "Unknown"}</td>
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
                          calledAt={r.calledAt?.toISOString() ?? null}
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
