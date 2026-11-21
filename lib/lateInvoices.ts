import { prisma } from "./prisma";
import { buildUnverifiedReminders, sourceDueDateAge, type ReminderCell } from "./collection-evidence";
import { overdueInvoicesWhere, overdueDisplayBasis } from "./invoiceMetrics";
export { REMINDER_THRESHOLDS } from "./collection-evidence";
export type { ReminderCell, ReminderStatus } from "./collection-evidence";

// Only collect on invoices issued from this date onward (ignore older past-dues).
// Exported so the dashboard's "Overdue Invoices" stat and detail page apply the
// same cutoff and report the same count as the Collections tab.
export const COLLECTIONS_SINCE = new Date("2026-01-01T00:00:00Z");

export interface LateInvoiceRow {
  invoiceId: string; // InvoiceRecord.id
  invoiceNumber: string | null;
  customerName: string;
  email: string | null;
  phone: string | null;
  amountDue: number;
  cachedStatus: string | null;
  displayBasis: string | null;
  daysPastDue: number | null;
  dueAt: Date | null;
  serviceDate: Date | null; // job completion/scheduled date for this invoice
  reminders: ReminderCell[];
  called: boolean;
  calledAt: Date | null;
  calledBy: string | null;
}

export async function getLateInvoiceCollections(now = new Date()): Promise<LateInvoiceRow[]> {
  const invoices = await prisma.invoiceRecord.findMany({
    where: overdueInvoicesWhere(undefined, COLLECTIONS_SINCE, now),
    include: { customer: true },
  });

  // Service date per invoice: match InvoiceRecord.invoiceNumber -> JobRecord and
  // use the job's completion (or scheduled end) date.
  const invoiceNumbers = invoices
    .map((i) => i.invoiceNumber)
    .filter((n): n is string => !!n);
  const jobs = invoiceNumbers.length
    ? await prisma.jobRecord.findMany({
        where: { invoiceNumber: { in: invoiceNumbers } },
        select: { invoiceNumber: true, completedAt: true, endAt: true },
      })
    : [];
  const serviceDateByInvoice = new Map<string, Date>();
  for (const j of jobs) {
    if (!j.invoiceNumber) continue;
    const d = j.completedAt ?? j.endAt;
    if (!d) continue;
    const existing = serviceDateByInvoice.get(j.invoiceNumber);
    if (!existing || d > existing) serviceDateByInvoice.set(j.invoiceNumber, d);
  }

  const calls = await prisma.lateInvoiceCall.findMany();
  const callByInvoice = new Map(calls.map((c) => [c.invoiceId, c]));

  const rows = invoices.map((inv) => {
    const dueAt = inv.dueAt;
    const daysPastDue = sourceDueDateAge(dueAt, now);

    // Service date: the matched job's date when it's a real (past) completion;
    // recurring jobs have a future schedule end, so fall back to the invoice's
    // issue date (a sane "when serviced/billed" proxy) rather than a future date.
    const jobDate = inv.invoiceNumber
      ? serviceDateByInvoice.get(inv.invoiceNumber) ?? null
      : null;
    const serviceDate =
      jobDate && jobDate <= now ? jobDate : inv.issuedAt ?? null;

    // No invoice/milestone-linked receipt store exists. Conversation SMS cannot
    // establish which invoice or reminder was sent, even at a matching time.
    const reminders: ReminderCell[] = buildUnverifiedReminders(dueAt, now);

    const call = callByInvoice.get(inv.id);
    return {
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      customerName:
        inv.clientName || inv.customer?.name || inv.customer?.companyName || "—",
      email: inv.customer?.email ?? null,
      phone: inv.customer?.phone ?? null,
      amountDue: inv.amountDue || 0,
      cachedStatus: inv.invoiceStatus,
      displayBasis: overdueDisplayBasis(inv, now),
      daysPastDue,
      dueAt,
      serviceDate,
      reminders,
      called: !!call?.calledAt,
      calledAt: call?.calledAt ?? null,
      calledBy: call?.calledBy ?? null,
    };
  });

  // Newest at the top, oldest at the bottom — by service date, falling back to
  // the due date when an invoice has no matching job.
  rows.sort((a, b) => {
    const ad = (a.serviceDate ?? a.dueAt)?.getTime() ?? 0;
    const bd = (b.serviceDate ?? b.dueAt)?.getTime() ?? 0;
    return bd - ad;
  });
  return rows;
}
