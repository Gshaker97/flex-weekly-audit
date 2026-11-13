import { prisma } from "./prisma";
import { jobberGraphQL } from "./jobber";
import { log } from "./log";

const OPEN_STATUSES = ["awaiting_payment", "past_due"];
const KNOWN_STATUSES = new Set([...OPEN_STATUSES, "draft", "paid", "void", "bad_debt"]);
const BATCH_SIZE = 25;

type ReadQuery = (query: string, variables: Record<string, string>) => Promise<unknown>;

/**
 * Second, independent release gate for the paid balance correction alone. Off by
 * default and off unless the value is exactly "true". While it is off, this
 * module behaves identically to the previous release, hold reasons included.
 */
export interface StatusRefreshOptions { paidBalanceCorrection?: boolean }
export function paidBalanceCorrectionEnabled(env = process.env): boolean {
  return env.JOBBER_PAID_BALANCE_CORRECTION_ENABLED === "true";
}
export interface OpenInvoiceSnapshot {
  id: string;
  jobberInvoiceId: string;
  invoiceStatus: string | null;
  total: number;
  amountPaid: number;
  amountDue: number;
  customerId: string | null;
  customer: { jobberClientId: string } | null;
  lastSyncedAt: Date;
}
/**
 * A correction always carries the status. It additionally carries the balance
 * only for a settled-to-zero payment, where status and balance necessarily move
 * together and correcting one without the other leaves the row contradicting
 * itself. Every other transition stays status-only, exactly as before.
 */
export interface InvoiceStatusCorrection {
  cached: OpenInvoiceSnapshot;
  invoiceStatus: string;
  amountDue?: number;
  amountPaid?: number;
}
export interface StatusRefreshPlan {
  checked: number;
  updates: InvoiceStatusCorrection[];
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
 *
 * A status change may carry its own balance across from the same read. Anything
 * unreadable, conflicting, or ambiguous holds, leaving the last verified values
 * in place rather than guessing at them.
 */
export async function planOpenInvoiceStatusRefresh(
  cached: OpenInvoiceSnapshot[],
  read: ReadQuery = jobberGraphQL,
  options: StatusRefreshOptions = {}
): Promise<StatusRefreshPlan> {
  // Snapshot the gate once for the whole plan. A batch is never half-corrected
  // because the environment changed partway through a run.
  const correctBalance = options.paidBalanceCorrection === true;
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
      if (!correctBalance) {
        // Previous release behaviour, retained verbatim while the gate is off.
        if (total !== cents(invoice.total) || balance !== cents(invoice.amountDue)) {
          hold("Amounts changed; requires full invoice sync, not a status-only correction"); continue;
        }
      } else if (total !== cents(invoice.total)) {
        // A changed total means the invoice itself was re-issued or edited. That
        // is more than this read covers, so it stays the full invoice sync's job.
        hold("Invoice total changed; requires full invoice sync, not a status correction"); continue;
      }
      if (!OPEN_STATUSES.includes(invoice.invoiceStatus ?? "")) {
        hold("Cached invoice is no longer open"); continue;
      }
      const cachedBalance = cents(invoice.amountDue);
      const cachedPaid = cents(invoice.amountPaid);
      if (cachedBalance === null || cachedPaid === null) { hold("Unknown cached amounts"); continue; }

      const statusChanged = invoice.invoiceStatus !== source.invoiceStatus;
      const balanceChanged = balance !== cachedBalance;
      if (!statusChanged && !balanceChanged) continue;
      if (!correctBalance) {
        // The balance is already known unchanged here, so this is status-only.
        plan.updates.push({ cached: invoice, invoiceStatus: source.invoiceStatus });
        continue;
      }
      // A balance that moved on its own may be a partial payment, a credit or a
      // line-item edit, none of which this narrow read can distinguish.
      if (!statusChanged) {
        hold("Balance changed without a status change; requires full invoice sync"); continue;
      }
      if (!balanceChanged) {
        plan.updates.push({ cached: invoice, invoiceStatus: source.invoiceStatus });
        continue;
      }
      // THE FIX. An open invoice that is now paid with nothing outstanding is the
      // one transition where the balance is unambiguous, so it is carried across
      // from this same read instead of waiting for the incremental full sync.
      // amountPaid is derived, not invented: total and balance come from one read
      // and the total is already known to be unchanged.
      if (source.invoiceStatus !== "paid" || balance !== 0) {
        hold("Balance changed on a non-payment transition; requires full invoice sync"); continue;
      }
      plan.updates.push({
        cached: invoice,
        invoiceStatus: source.invoiceStatus,
        amountDue: 0,
        amountPaid: total / 100,
      });
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
      total: true, amountPaid: true, amountDue: true, customerId: true,
      customer: { select: { jobberClientId: true } }, lastSyncedAt: true,
    },
  });
  // Read once per run, before any correction is planned.
  const correctBalance = paidBalanceCorrectionEnabled();
  const plan = await planOpenInvoiceStatusRefresh(cached, jobberGraphQL, { paidBalanceCorrection: correctBalance });
  if (plan.updates.length) {
    await prisma.$transaction(async (tx) => {
      for (const correction of plan.updates) {
        const { cached: invoice, invoiceStatus } = correction;
        // The whole pre-image is the guard. A newer verified payment already
        // written by another pass changes these values, so a stale in-flight
        // correction matches no row and rolls the entire batch back.
        const result = await tx.invoiceRecord.updateMany({
          where: {
            id: invoice.id, jobberInvoiceId: invoice.jobberInvoiceId,
            invoiceStatus: invoice.invoiceStatus, total: invoice.total,
            amountPaid: invoice.amountPaid, amountDue: invoice.amountDue,
            customerId: invoice.customerId,
            customer: { is: { jobberClientId: invoice.customer!.jobberClientId } },
            lastSyncedAt: invoice.lastSyncedAt,
          },
          // Status alone, unless this is the settled-to-zero payment case, where
          // the balance from the same read goes with it. paidAt is deliberately
          // left alone: this read carries no payment timestamp, and a guessed one
          // would misdate collections reporting. lastSyncedAt is not advanced
          // either, because the row was not fully refreshed.
          data: correction.amountDue === undefined
            ? { invoiceStatus }
            : { invoiceStatus, amountDue: correction.amountDue, amountPaid: correction.amountPaid },
        });
        if (result.count !== 1) throw new Error("Invoice changed during status refresh; rolled back all status corrections");
      }
    }, { isolationLevel: "Serializable", timeout: 30000 });
  }
  log(`[sync] open invoice status refresh: checked=${plan.checked} changed=${plan.updates.length} held=${plan.holds.length} paidBalanceCorrection=${correctBalance}`);
  // IDs/reasons only; no customer contact details or financial values in logs.
  for (const hold of plan.holds) log(`[sync] status refresh held ${hold.jobberInvoiceId}: ${hold.reason}`);
  return plan;
}
