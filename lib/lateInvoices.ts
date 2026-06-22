import { prisma } from "./prisma";
import { findContactByEmail, getOutboundSms } from "./ghl";

const DAY_MS = 24 * 60 * 60 * 1000;
// Reminder-text cadence: a dunning SMS is expected at dueAt + N days.
export const REMINDER_THRESHOLDS = [10, 15, 20, 25, 30];
// A reminder counts as "sent" if an outbound SMS exists within ±this many days
// of the expected send date (no exact text match required).
const WINDOW_DAYS = 3;
// Only collect on invoices issued from this date onward (ignore older past-dues).
// Exported so the dashboard's "Overdue Invoices" stat and detail page apply the
// same cutoff and report the same count as the Collections tab.
export const COLLECTIONS_SINCE = new Date("2026-01-01T00:00:00Z");

export type ReminderStatus = "sent" | "pending" | "overdue";

export interface ReminderCell {
  threshold: number;
  status: ReminderStatus;
  daysUntil?: number; // populated when status === "pending"
}

export interface LateInvoiceRow {
  invoiceId: string; // InvoiceRecord.id
  invoiceNumber: string | null;
  customerName: string;
  email: string | null;
  phone: string | null;
  amountDue: number;
  daysPastDue: number;
  dueAt: Date | null;
  serviceDate: Date | null; // job completion/scheduled date for this invoice
  reminders: ReminderCell[];
  called: boolean;
  calledAt: Date | null;
  calledBy: string | null;
  ghlError: boolean; // GHL lookup failed for this customer
}

// Run an async op over items with a small concurrency cap (GHL is rate-limited).
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 1 }, worker));
}

export async function getLateInvoiceCollections(): Promise<LateInvoiceRow[]> {
  const now = new Date();

  const invoices = await prisma.invoiceRecord.findMany({
    where: { invoiceStatus: "past_due", issuedAt: { gte: COLLECTIONS_SINCE } },
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

  // One GHL lookup per unique email; `null` marks a failed lookup.
  const smsByEmail = new Map<string, Date[] | null>();
  const uniqueEmails = Array.from(
    new Set(
      invoices
        .map((i) => i.customer?.email?.trim().toLowerCase())
        .filter((e): e is string => !!e)
    )
  );

  await mapLimit(uniqueEmails, 5, async (email) => {
    try {
      const contact = await findContactByEmail(email);
      const exact = contact && (contact.email ?? "").toLowerCase() === email;
      if (!exact) {
        smsByEmail.set(email, []); // no matching GHL contact → no reminders sent
        return;
      }
      const sms = await getOutboundSms(contact!.id);
      smsByEmail.set(email, sms.map((m) => m.dateAdded));
    } catch {
      smsByEmail.set(email, null); // lookup error
    }
  });

  const rows = invoices.map((inv) => {
    const email = inv.customer?.email?.trim().toLowerCase() || null;
    const lookup = email ? smsByEmail.get(email) : [];
    const ghlError = lookup === null;
    const dates = lookup ?? [];

    const dueAt = inv.dueAt;
    const daysPastDue = dueAt
      ? Math.floor((now.getTime() - dueAt.getTime()) / DAY_MS)
      : 0;

    // Service date: the matched job's date when it's a real (past) completion;
    // recurring jobs have a future schedule end, so fall back to the invoice's
    // issue date (a sane "when serviced/billed" proxy) rather than a future date.
    const jobDate = inv.invoiceNumber
      ? serviceDateByInvoice.get(inv.invoiceNumber) ?? null
      : null;
    const serviceDate =
      jobDate && jobDate <= now ? jobDate : inv.issuedAt ?? null;

    const reminders: ReminderCell[] = REMINDER_THRESHOLDS.map((threshold) => {
      if (!dueAt) return { threshold, status: "pending" };
      const expected = dueAt.getTime() + threshold * DAY_MS;
      const lo = expected - WINDOW_DAYS * DAY_MS;
      const hi = expected + WINDOW_DAYS * DAY_MS;
      const sent = dates.some((d) => d.getTime() >= lo && d.getTime() <= hi);
      if (sent) return { threshold, status: "sent" };
      if (now.getTime() < expected) {
        return {
          threshold,
          status: "pending",
          daysUntil: Math.ceil((expected - now.getTime()) / DAY_MS),
        };
      }
      return { threshold, status: "overdue" };
    });

    const call = callByInvoice.get(inv.id);
    return {
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      customerName:
        inv.clientName || inv.customer?.name || inv.customer?.companyName || "—",
      email: inv.customer?.email ?? null,
      phone: inv.customer?.phone ?? null,
      amountDue: inv.amountDue || 0,
      daysPastDue,
      dueAt,
      serviceDate,
      reminders,
      called: !!call?.calledAt,
      calledAt: call?.calledAt ?? null,
      calledBy: call?.calledBy ?? null,
      ghlError,
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
