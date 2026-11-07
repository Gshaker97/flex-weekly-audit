import type { Prisma } from "@prisma/client";
import type { DateRange } from "./dateRange";

// Billing value is not cash received. Bad debt remains historical billing;
// draft, void and unrecognized states must not silently become revenue.
export const ISSUED_INVOICE_STATUSES = [
  "paid", "awaiting_payment", "past_due", "bad_debt",
];
export const OPEN_INVOICE_STATUSES = ["awaiting_payment", "past_due"];

export function issuedInvoiceWhere(range?: Pick<DateRange, "start" | "end">): Prisma.InvoiceRecordWhereInput {
  return {
    invoiceStatus: { in: ISSUED_INVOICE_STATUSES },
    ...(range ? { issuedAt: { gte: range.start, lte: range.end } } : {}),
  };
}

export function openReceivablesWhere(range?: Pick<DateRange, "start" | "end">): Prisma.InvoiceRecordWhereInput {
  return {
    invoiceStatus: { in: OPEN_INVOICE_STATUSES },
    amountDue: { gt: 0 },
    ...(range ? { issuedAt: { gte: range.start, lte: range.end } } : {}),
  };
}

// Preserve contradictory balances in an explicit review list, never classify
// them as collectible or settled just from one of the two fields.
export function balanceReviewWhere(range?: Pick<DateRange, "start" | "end">): Prisma.InvoiceRecordWhereInput {
  return {
    amountDue: { gt: 0 },
    OR: [
      { invoiceStatus: { notIn: OPEN_INVOICE_STATUSES } },
      { invoiceStatus: null },
    ],
    ...(range ? { issuedAt: { gte: range.start, lte: range.end } } : {}),
  };
}

export function overdueInvoicesWhere(range: Pick<DateRange, "start" | "end">, cutoff: Date): Prisma.InvoiceRecordWhereInput {
  return {
    invoiceStatus: "past_due",
    amountDue: { gt: 0 },
    issuedAt: { gte: range.start > cutoff ? range.start : cutoff, lte: range.end },
  };
}

export function legacyOverdueWhere(range: Pick<DateRange, "start" | "end">, cutoff: Date): Prisma.InvoiceRecordWhereInput {
  return {
    invoiceStatus: "past_due",
    amountDue: { gt: 0 },
    issuedAt: { gte: range.start, lte: range.end, lt: cutoff },
  };
}

export function invoiceValueIncluded(status: string | null | undefined): boolean {
  return ISSUED_INVOICE_STATUSES.includes(status ?? "");
}

export function invoiceReviewReason(invoice: { invoiceStatus: string | null; amountDue: number }): string {
  if (invoice.amountDue > 0 && !OPEN_INVOICE_STATUSES.includes(invoice.invoiceStatus ?? "")) {
    return `${invoice.invoiceStatus || "Unknown status"} with a positive balance; verify in Jobber before collection or settlement`;
  }
  if (invoice.amountDue <= 0 && OPEN_INVOICE_STATUSES.includes(invoice.invoiceStatus ?? "")) {
    return `${invoice.invoiceStatus} with a zero or negative balance; verify source and payment evidence before treating as settled`;
  }
  if (!invoiceValueIncluded(invoice.invoiceStatus)) {
    return "Excluded from issued invoice value: draft, void or unrecognized status";
  }
  return "";
}

export function totalLessBalance(total: number, balance: number): number {
  return Math.round((total - balance) * 100) / 100;
}

export function invoiceMonthKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Phoenix", year: "numeric", month: "2-digit",
  }).formatToParts(date);
  return `${parts.find(p => p.type === "year")!.value}-${parts.find(p => p.type === "month")!.value}`;
}

export function sumInvoiceMonths(invoices: Array<{ issuedAt: Date | null; total: number }>): Map<string, number> {
  const months = new Map<string, number>();
  for (const invoice of invoices) {
    if (!invoice.issuedAt) continue;
    const key = invoiceMonthKey(invoice.issuedAt);
    months.set(key, (months.get(key) ?? 0) + invoice.total);
  }
  return months;
}
