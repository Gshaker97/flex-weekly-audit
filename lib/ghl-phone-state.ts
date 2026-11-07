import { jobberGraphQL } from "./jobber";

export interface PhoneInvoiceEvidence {
  id: string;
  client: { id: string } | null;
  invoiceStatus: string | null;
  amounts: { total: number | null; invoiceBalance: number | null } | null;
  issuedDate: string | null;
  createdAt: string | null;
  dueDate: string | null;
}
// Same connection/fields as the deployed invoice query, but no incremental
// filter and no successful partial result on missing/repeated cursors.
export async function readPhoneInvoiceEvidence(): Promise<PhoneInvoiceEvidence[]> {
  const query = `query PhoneInvoiceExit($after: String) {
    invoices(first: 25, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id invoiceStatus amounts { total invoiceBalance }
        issuedDate createdAt dueDate client { id } }
    }
  }`;
  const invoices: PhoneInvoiceEvidence[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let after: string | null = null;
  for (let page = 0; page < 1000; page++) {
    const data: any = await jobberGraphQL(query, { after });
    const connection = data?.invoices;
    if (!Array.isArray(connection?.nodes) || typeof connection.pageInfo?.hasNextPage !== "boolean") {
      throw new Error("Incomplete Jobber phone-exit evidence");
    }
    for (const invoice of connection.nodes) {
      if (!invoice?.id || !invoice.client?.id || ids.has(invoice.id)) {
        throw new Error("Unmapped or repeated Jobber phone-exit invoice");
      }
      ids.add(invoice.id);
      invoices.push(invoice);
    }
    if (!connection.pageInfo.hasNextPage) return invoices;
    after = connection.pageInfo.endCursor;
    if (!after || cursors.has(after) || !connection.nodes.length) throw new Error("Truncated Jobber phone-exit evidence");
    cursors.add(after);
  }
  throw new Error("Jobber phone-exit evidence exceeded page limit");
}

// Require explicit nonnegative, finite, safe integer-cent source amounts. The
// round trip permits ordinary decimal cents (e.g. 0.29) despite binary floating
// point, without rounding sub-cent source values into valid amounts.
export function moneyCents(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const cents = Math.round(value * 100);
  return Number.isSafeInteger(cents) && cents / 100 === value ? cents : null;
}

// Shared by email and phone reconciliation. A null plan holds the entire owner
// before any card change; it does not rely on status-refresh informational holds.
// Never infer payment from an empty eligible group or cached incremental rows.
// Old/zero invoices must be explicitly settled too; they are never filtered out.
export function phoneSourcePlan(
  jobberClientId: string,
  storedInvoiceIds: string[],
  source: PhoneInvoiceEvidence[],
  now: Date
): { stage: "Invoice Paid" | "Invoice Sent" | "Invoice Overdue"; total: number; count: number } | null {
  const invoices = source.filter(inv => inv.client?.id === jobberClientId);
  const sourceIds = new Set(invoices.map(inv => inv.id));
  if (!invoices.length || !storedInvoiceIds.length || storedInvoiceIds.some(id => !sourceIds.has(id))) return null;
  let awaitingCents = 0;
  let awaitingCount = 0;
  let overdueCents = 0;
  let overdueCount = 0;
  for (const inv of invoices) {
    const issued = new Date(inv.issuedDate ?? inv.createdAt ?? "");
    const total = moneyCents(inv.amounts?.total);
    const balance = moneyCents(inv.amounts?.invoiceBalance);
    if (total === null || balance === null || balance > total) return null;
    const status = inv.invoiceStatus?.toLowerCase();
    // Explicitly settled historical/zero-total rows are accounted for, not
    // silently omitted. Positive/unknown/void balances still block an exit.
    if (status === "paid" && balance === 0) continue;
    if (!Number.isFinite(issued.getTime()) || issued < new Date("2026-01-01T00:00:00Z") || total === 0) return null;
    const due = new Date(inv.dueDate ?? "");
    if (balance > 0 && (status === "past_due" || (status === "awaiting_payment" && Number.isFinite(due.getTime())))) {
      if (status === "past_due" || due < now) {
        overdueCents += balance;
        if (!Number.isSafeInteger(overdueCents)) return null;
        overdueCount += 1;
      } else {
        awaitingCents += balance;
        if (!Number.isSafeInteger(awaitingCents)) return null;
        awaitingCount += 1;
      }
      continue;
    }
    return null;
  }
  // Converting a very large safe cent sum back to dollars must not lose a cent.
  if (moneyCents(overdueCents / 100) !== overdueCents || moneyCents(awaitingCents / 100) !== awaitingCents) return null;
  if (overdueCount) return { stage: "Invoice Overdue", total: overdueCents / 100, count: overdueCount };
  if (awaitingCount) return { stage: "Invoice Sent", total: awaitingCents / 100, count: awaitingCount };
  return { stage: "Invoice Paid", total: 0, count: 0 };
}

export function phoneExitStage(jobberClientId: string, storedInvoiceIds: string[], source: PhoneInvoiceEvidence[], now: Date): "Invoice Paid" | "Invoice Sent" | null {
  const plan = phoneSourcePlan(jobberClientId, storedInvoiceIds, source, now);
  return plan && plan.stage !== "Invoice Overdue" ? plan.stage : null;
}
