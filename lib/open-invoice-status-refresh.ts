import { prisma } from "./prisma";
import { jobberGraphQL } from "./jobber";
import { log } from "./log";

const OPEN_STATUSES = ["awaiting_payment", "past_due"];
const KNOWN_STATUSES = new Set([...OPEN_STATUSES, "draft", "paid", "void", "bad_debt"]);
const BATCH_SIZE = 25;

type ReadQuery = (query: string, variables: Record<string, string>) => Promise<unknown>;
export interface OpenInvoiceSnapshot {
  id: string;
  jobberInvoiceId: string;
  invoiceStatus: string | null;
  total: number;
  amountDue: number;
  customerId: string | null;
  customer: { jobberClientId: string } | null;
  lastSyncedAt: Date;
}
export interface StatusRefreshPlan {
  checked: number;
  updates: Array<{ cached: OpenInvoiceSnapshot; invoiceStatus: string }>;
  holds: Array<{ jobberInvoiceId: string; reason: string }>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cents(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value * 100);
  return Number.isSafeInteger(rounded) && Math.abs(value * 100 - rounded) < 0.000001
    ? rounded : null;
}

/**
 * Read every requested ID, independently of updatedAt and connection defaults.
 * Missing aliases, wrong IDs, malformed envelopes and thrown GraphQL/HTTP errors
 * abort the whole plan. Explicit null/unknown business fields hold that invoice.
 * No database or provider mutations happen here, even if a later batch fails.
 */
export async function planOpenInvoiceStatusRefresh(
  cached: OpenInvoiceSnapshot[],
  read: ReadQuery = jobberGraphQL
): Promise<StatusRefreshPlan> {
  const plan: StatusRefreshPlan = { checked: cached.length, updates: [], holds: [] };
  const ids = new Set<string>();
  const localIds = new Set<string>();
  for (const invoice of cached) {
    if (!invoice.id || !invoice.jobberInvoiceId || ids.has(invoice.jobberInvoiceId) || localIds.has(invoice.id)) {
      throw new Error("Invalid or duplicate cached invoice identity in status refresh");
    }
    ids.add(invoice.jobberInvoiceId);
    localIds.add(invoice.id);
  }
  for (let offset = 0; offset < cached.length; offset += BATCH_SIZE) {
    const batch = cached.slice(offset, offset + BATCH_SIZE);
    const definitions = batch.map((_, i) => `$id${i}: EncodedId!`).join(", ");
    const fields = batch.map((_, i) => `i${i}: invoice(id: $id${i}) {
      id invoiceStatus amounts { total invoiceBalance } client { id }
    }`).join("\n");
    const variables = Object.fromEntries(batch.map((invoice, i) => [`id${i}`, invoice.jobberInvoiceId]));
    const data = await read(`query RefreshOpenInvoiceStatuses(${definitions}) { ${fields} }`, variables);
    if (!record(data) || Object.keys(data).length !== batch.length) {
      throw new Error("Incomplete Jobber status refresh response");
    }
    for (let i = 0; i < batch.length; i++) {
      const invoice = batch[i];
      const key = `i${i}`;
      if (!Object.prototype.hasOwnProperty.call(data, key) || data[key] === undefined) {
        throw new Error("Missing Jobber status refresh alias");
      }
      const source = data[key];
      const hold = (reason: string) => plan.holds.push({ jobberInvoiceId: invoice.jobberInvoiceId, reason });
      if (source === null) { hold("Source object unavailable; retained last-known state"); continue; }
      if (!record(source) || source.id !== invoice.jobberInvoiceId) {
        throw new Error("Mismatched Jobber status refresh identity");
      }
      if (typeof source.invoiceStatus !== "string" || !KNOWN_STATUSES.has(source.invoiceStatus)) {
        hold("Unknown source status"); continue;
      }
      if (!record(source.client) || typeof source.client.id !== "string" ||
          !invoice.customer?.jobberClientId || source.client.id !== invoice.customer.jobberClientId) {
        hold("Unknown or changed invoice owner"); continue;
      }
      const total = record(source.amounts) ? cents(source.amounts.total) : null;
      const balance = record(source.amounts) ? cents(source.amounts.invoiceBalance) : null;
      if (total === null || balance === null) { hold("Unknown source amounts"); continue; }
      if (total < 0 || balance < 0 || balance > total ||
          (source.invoiceStatus === "paid" && balance !== 0) ||
          (OPEN_STATUSES.includes(source.invoiceStatus) && balance <= 0)) {
        hold("Conflicting or credit balance requires review"); continue;
      }
      if (total !== cents(invoice.total) || balance !== cents(invoice.amountDue)) {
        hold("Amounts changed; requires full invoice sync, not a status-only correction"); continue;
      }
      if (!OPEN_STATUSES.includes(invoice.invoiceStatus ?? "")) {
        hold("Cached invoice is no longer open"); continue;
      }
      if (invoice.invoiceStatus !== source.invoiceStatus) {
        plan.updates.push({ cached: invoice, invoiceStatus: source.invoiceStatus });
      }
    }
  }
  return plan;
}

/**
 * Separate, default-off release gate. Enabling this can change downstream GHL
 * enrollment even though this module never calls GHL or sends a message.
 */
export async function refreshOpenInvoiceStatuses(): Promise<StatusRefreshPlan | null> {
  if (process.env.JOBBER_OPEN_STATUS_REFRESH_ENABLED !== "true") return null;
  const cached = await prisma.invoiceRecord.findMany({
    where: { invoiceStatus: { in: OPEN_STATUSES } },
    select: {
      id: true, jobberInvoiceId: true, invoiceStatus: true,
      total: true, amountDue: true, customerId: true,
      customer: { select: { jobberClientId: true } }, lastSyncedAt: true,
    },
  });
  const plan = await planOpenInvoiceStatusRefresh(cached);
  if (plan.updates.length) {
    await prisma.$transaction(async (tx) => {
      for (const { cached: invoice, invoiceStatus } of plan.updates) {
        const result = await tx.invoiceRecord.updateMany({
          where: {
            id: invoice.id, jobberInvoiceId: invoice.jobberInvoiceId,
            invoiceStatus: invoice.invoiceStatus, total: invoice.total,
            amountDue: invoice.amountDue, customerId: invoice.customerId,
            customer: { is: { jobberClientId: invoice.customer!.jobberClientId } },
            lastSyncedAt: invoice.lastSyncedAt,
          },
          // Do not invent amountPaid/paidAt, rewrite balances, or claim the
          // entire row was refreshed by advancing lastSyncedAt.
          data: { invoiceStatus },
        });
        if (result.count !== 1) throw new Error("Invoice changed during status refresh; rolled back all status corrections");
      }
    }, { isolationLevel: "Serializable", timeout: 30000 });
  }
  log(`[sync] open invoice status refresh: checked=${plan.checked} changed=${plan.updates.length} held=${plan.holds.length}`);
  // IDs/reasons only; no customer contact details or financial values in logs.
  for (const hold of plan.holds) log(`[sync] status refresh held ${hold.jobberInvoiceId}: ${hold.reason}`);
  return plan;
}
