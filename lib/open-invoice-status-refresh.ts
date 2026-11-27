import { prisma } from "./prisma";
import { jobberGraphQL } from "./jobber";
import { log, logError } from "./log";
import { INVOICE_VERIFY_CONFIRMED } from "./invoiceMetrics";
import { invoiceSettlement, settledOrOwingStatus } from "./invoice-settlement";

const OPEN_STATUSES = ["awaiting_payment", "past_due"];
const KNOWN_STATUSES = new Set([...OPEN_STATUSES, "draft", "paid", "void", "bad_debt"]);
const BATCH_SIZE = 25;

/**
 * THE ROWS THIS RE-CHECK READS.
 *
 * It used to be the two owing labels alone, and that was the bug. A row
 * labelled `paid` while money is still outstanding was invisible to BOTH the
 * things that could have fixed it:
 *
 *   - the hourly sync fetches invoices by Jobber's own updatedAt, so an invoice
 *     Jobber has not touched in months is never re-upserted and the labelling
 *     fix in `upsertInvoices` never runs on it;
 *   - this re-check only selected rows that already said they were owing, so a
 *     row that wrongly said `paid` was never looked at either.
 *
 * Measured 2026-11-27: 12 invoices sat `paid` with $25,983.82 outstanding
 * between those two scopes, indefinitely. Adding the paid-with-a-balance rows
 * here is what lets the correction reach them. It is a small, bounded addition
 * - those 12 rows against 77 open ones - not a widening to all 6,027 invoices.
 */
export const RECHECK_SCOPE_WHERE = Object.freeze({
  OR: [
    { invoiceStatus: { in: [...OPEN_STATUSES] } },
    { invoiceStatus: "paid", amountDue: { gt: 0 } },
  ],
});

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
  /**
   * Needed only for the paid-while-owing correction: when Jobber's own label is
   * not an owing one, past_due versus awaiting_payment has to come from the due
   * date rather than be guessed. Null is treated as not yet overdue.
   */
  dueAt: Date | null;
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
/**
 * One entry per checked invoice. `outcome` is INVOICE_VERIFY_CONFIRMED only when
 * this read confirmed the invoice AND the stored row agrees with it. Anything
 * else carries a short machine code, so "Jobber confirmed it minutes ago" and
 * "Jobber has not confirmed it for 159 days" stop looking identical.
 */
export interface InvoiceVerification {
  id: string;
  jobberInvoiceId: string;
  outcome: string;
}
export interface StatusRefreshPlan {
  checked: number;
  updates: InvoiceStatusCorrection[];
  holds: Array<{ jobberInvoiceId: string; reason: string }>;
  verifications: InvoiceVerification[];
}

/**
 * The calendar day in Phoenix, which never observes DST, so UTC-7 is a constant
 * and no library or shared clock module is needed. Used only to choose between
 * the two owing labels when one has to be invented.
 */
function phoenixDay(value: Date | null): string | null {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return null;
  return new Date(value.getTime() - 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
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
  const plan: StatusRefreshPlan = { checked: cached.length, updates: [], holds: [], verifications: [] };
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
      const verify = (outcome: string) =>
        plan.verifications.push({ id: invoice.id, jobberInvoiceId: invoice.jobberInvoiceId, outcome });
      // Every hold is also a non-confirmation: the stored figure is not known current.
      const hold = (reason: string, outcome: string) => {
        plan.holds.push({ jobberInvoiceId: invoice.jobberInvoiceId, reason });
        verify(outcome);
      };
      const confirm = () => verify(INVOICE_VERIFY_CONFIRMED);
      if (source === null) { hold("Source object unavailable; retained last-known state", "source_unavailable"); continue; }
      if (!record(source) || source.id !== invoice.jobberInvoiceId) {
        throw new Error("Mismatched Jobber status refresh identity");
      }
      if (typeof source.invoiceStatus !== "string" || !KNOWN_STATUSES.has(source.invoiceStatus)) {
        hold("Unknown source status", "source_unreadable"); continue;
      }
      if (!record(source.client) || typeof source.client.id !== "string" ||
          !invoice.customer?.jobberClientId || source.client.id !== invoice.customer.jobberClientId) {
        hold("Unknown or changed invoice owner", "source_owner_unverified"); continue;
      }
      const total = record(source.amounts) ? cents(source.amounts.total) : null;
      const balance = record(source.amounts) ? cents(source.amounts.invoiceBalance) : null;
      if (total === null || balance === null) { hold("Unknown source amounts", "source_unreadable"); continue; }
      // `paid` with a balance still on it stops being a conflict to hold, but
      // ONLY behind the same release gate as the rest of this module's
      // corrections - with the gate off this behaves exactly as the previous
      // release did, hold reasons included, which is the gate's whole promise.
      //
      // With it on: that pair is what Jobber leaves behind after a refund
      // reverses the payment, or when only a deposit was ever paid, and the
      // balance is the true figure. Genuinely unreadable figures still hold.
      const paidWhileOwing = correctBalance
        ? invoiceSettlement(source.invoiceStatus, total, balance) === "unreadable"
        : source.invoiceStatus === "paid" && balance !== 0;
      if (total < 0 || balance < 0 || balance > total || paidWhileOwing ||
          (OPEN_STATUSES.includes(source.invoiceStatus) && balance <= 0)) {
        hold("Conflicting or credit balance requires review", "source_conflicting"); continue;
      }
      if (!correctBalance) {
        // Previous release behaviour, retained verbatim while the gate is off.
        if (total !== cents(invoice.total) || balance !== cents(invoice.amountDue)) {
          hold("Amounts changed; requires full invoice sync, not a status-only correction", "stored_value_differs"); continue;
        }
      } else if (total !== cents(invoice.total)) {
        // A changed total means the invoice itself was re-issued or edited. That
        // is more than this read covers, so it stays the full invoice sync's job.
        hold("Invoice total changed; requires full invoice sync, not a status correction", "stored_value_differs"); continue;
      }
      // WHAT THIS READ IS ALLOWED TO CORRECT.
      //
      // Until 2026-11-27 this was the open labels alone, which held every
      // paid-labelled row as "no longer open" - the exact row the paid-while-
      // owing correction exists to fix, so the correction could never reach it.
      //
      // One case is added, and only behind the same release gate as every other
      // correction here: a row this system stored as `paid` WHILE ITS OWN
      // STORED BALANCE STILL SHOWS MONEY, and this live read agrees that money
      // is outstanding. Jobber's label is irrelevant to that test; the balance
      // decides, which is `invoiceSettlement`'s whole job.
      //
      // The stored balance is part of the test on purpose, and it is what keeps
      // the old protection intact. A row that reads paid with NOTHING
      // outstanding is a verified payment, and a stale read claiming the
      // invoice is still open must never reopen it. Requiring the stored
      // balance to be non-zero holds that row here, for the original reason,
      // instead of leaning on a later guard to catch it. It also makes this
      // test agree exactly with `RECHECK_SCOPE_WHERE`, so the rows selected and
      // the rows acted on are the same set.
      const liveSettlement = invoiceSettlement(source.invoiceStatus, total, balance);
      const locallyOwing = OPEN_STATUSES.includes(invoice.invoiceStatus ?? "");
      const locallyPaidWhileOwing = correctBalance && invoice.invoiceStatus === "paid"
        && (cents(invoice.amountDue) ?? 0) > 0 && liveSettlement === "owing";
      if (!locallyOwing && !locallyPaidWhileOwing) {
        hold("Cached invoice is no longer open", "not_open_locally"); continue;
      }
      const cachedBalance = cents(invoice.amountDue);
      const cachedPaid = cents(invoice.amountPaid);
      if (cachedBalance === null || cachedPaid === null) { hold("Unknown cached amounts", "cached_unreadable"); continue; }

      // THE LABEL THIS ROW SHOULD CARRY, not the one Jobber printed.
      //
      // Writing source.invoiceStatus verbatim would undo the sync's own fix:
      // Jobber says `paid` on a refunded or deposit-only invoice, so the next
      // pass would push a row that correctly reads past_due back to paid and
      // pull it straight out of collections again.
      //
      // Only that contradiction is overridden. When Jobber already calls the
      // invoice owing, its label is taken as given, so an ordinary
      // past_due/awaiting_payment correction still goes through exactly as
      // before.
      const dueDay = phoenixDay(invoice.dueAt), today = phoenixDay(new Date());
      const correctedStatus = correctBalance
        ? settledOrOwingStatus(source.invoiceStatus, total, balance,
            dueDay !== null && today !== null && dueDay < today) ?? source.invoiceStatus
        : source.invoiceStatus;
      const statusChanged = invoice.invoiceStatus !== correctedStatus;
      const balanceChanged = balance !== cachedBalance;
      // THE FIX for the dashboard. This read confirmed the invoice and the stored
      // row already agrees with it. Previously that fact was discarded, which is
      // why a row checked minutes ago still read as 159 days unrefreshed.
      if (!statusChanged && !balanceChanged) { confirm(); continue; }
      if (!correctBalance) {
        // The balance is already known unchanged here, so this is status-only.
        plan.updates.push({ cached: invoice, invoiceStatus: correctedStatus });
        confirm();
        continue;
      }
      // A balance that moved on its own may be a partial payment, a credit or a
      // line-item edit, none of which this narrow read can distinguish.
      if (!statusChanged) {
        hold("Balance changed without a status change; requires full invoice sync", "stored_value_differs"); continue;
      }
      if (!balanceChanged) {
        plan.updates.push({ cached: invoice, invoiceStatus: correctedStatus });
        confirm();
        continue;
      }
      // THE FIX. An open invoice that is now paid with nothing outstanding is the
      // one transition where the balance is unambiguous, so it is carried across
      // from this same read instead of waiting for the incremental full sync.
      // amountPaid is derived, not invented: total and balance come from one read
      // and the total is already known to be unchanged.
      if (source.invoiceStatus !== "paid" || balance !== 0) {
        hold("Balance changed on a non-payment transition; requires full invoice sync", "stored_value_differs"); continue;
      }
      plan.updates.push({
        cached: invoice,
        invoiceStatus: correctedStatus,
        amountDue: 0,
        amountPaid: total / 100,
      });
      confirm();
    }
  }
  return plan;
}

/** The columns one snapshot needs. Shared so every caller reads the same shape. */
export const INVOICE_SNAPSHOT_SELECT = Object.freeze({
  id: true, jobberInvoiceId: true, invoiceStatus: true,
  total: true, amountPaid: true, amountDue: true, customerId: true,
  customer: { select: { jobberClientId: true } }, dueAt: true, lastSyncedAt: true,
} as const);

/**
 * Commit a batch of status corrections, all or nothing.
 *
 * The whole pre-image is the guard. A newer verified payment already written by
 * another pass changes these values, so a stale in-flight correction matches no
 * row and rolls the entire batch back.
 */
export async function applyInvoiceStatusCorrections(updates: InvoiceStatusCorrection[]): Promise<void> {
  if (!updates.length) return;
  await prisma.$transaction(async (tx) => {
    for (const correction of updates) {
      const { cached: invoice, invoiceStatus } = correction;
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

/**
 * Plan, apply and record one re-check over an explicit set of snapshots.
 *
 * Extracted from `refreshOpenInvoiceStatuses` unchanged, so the hourly re-check
 * and the daily full reconcile share ONE code path: the same by-id Jobber read,
 * the same hold reasons, the same pre-image-guarded write and the same
 * verification recording. The only thing a caller chooses is which rows to pass.
 */
export async function runInvoiceStatusRecheck(
  cached: OpenInvoiceSnapshot[], label: string
): Promise<StatusRefreshPlan> {
  // Read once per run, before any correction is planned.
  const correctBalance = paidBalanceCorrectionEnabled();
  const plan = await planOpenInvoiceStatusRefresh(cached, jobberGraphQL, { paidBalanceCorrection: correctBalance });
  await applyInvoiceStatusCorrections(plan.updates);
  // Record what this run actually established, per invoice. Written AFTER the
  // corrections above, and never inside their transaction: these two columns are
  // not part of the pre-image guard, so they cannot cause a correction to roll
  // back. A confirmed read advances lastVerifiedAt; every other outcome records
  // the code only, leaving lastVerifiedAt where it was.
  await recordInvoiceVerifications(plan.verifications);
  log(`[sync] ${label}: checked=${plan.checked} changed=${plan.updates.length} held=${plan.holds.length} paidBalanceCorrection=${correctBalance}`);
  // IDs/reasons only; no customer contact details or financial values in logs.
  for (const hold of plan.holds) log(`[sync] ${label} held ${hold.jobberInvoiceId}: ${hold.reason}`);
  return plan;
}

/**
 * Separate, default-off release gate. Enabling this can change downstream GHL
 * enrollment even though this module never calls GHL or sends a message.
 */
export async function refreshOpenInvoiceStatuses(): Promise<StatusRefreshPlan | null> {
  if (process.env.JOBBER_OPEN_STATUS_REFRESH_ENABLED !== "true") return null;
  const cached = await prisma.invoiceRecord.findMany({
    where: RECHECK_SCOPE_WHERE, select: INVOICE_SNAPSHOT_SELECT });
  return runInvoiceStatusRecheck(cached, "open invoice status refresh");
}

/**
 * Persist one verification outcome per checked invoice.
 *
 * Deliberately non-fatal. The corrections above have already been committed by
 * the time this runs, and this writes display metadata only -- no status, no
 * balance, no payment date. If the columns are missing because the migration has
 * not been applied yet, the hourly refresh must still succeed, so the failure is
 * logged and the run continues. That also means code and migration can be
 * deployed in either order.
 */
export async function recordInvoiceVerifications(
  verifications: InvoiceVerification[],
  at: Date = new Date(),
): Promise<void> {
  if (!verifications.length) return;
  const byOutcome = new Map<string, string[]>();
  for (const row of verifications) {
    const ids = byOutcome.get(row.outcome);
    if (ids) ids.push(row.id); else byOutcome.set(row.outcome, [row.id]);
  }
  try {
    for (const [outcome, ids] of byOutcome) {
      await prisma.invoiceRecord.updateMany({
        where: { id: { in: ids } },
        // A failed check proves nothing about the invoice, so it must NOT look
        // freshly confirmed. Only a confirmed outcome moves lastVerifiedAt.
        data: outcome === INVOICE_VERIFY_CONFIRMED
          ? { lastVerifiedAt: at, lastVerifyOutcome: INVOICE_VERIFY_CONFIRMED }
          : { lastVerifyOutcome: outcome },
      });
    }
    const confirmed = byOutcome.get(INVOICE_VERIFY_CONFIRMED)?.length ?? 0;
    log(`[sync] invoice verification recorded: confirmed=${confirmed} unconfirmed=${verifications.length - confirmed}`);
  } catch (error) {
    // Codes and counts only; no invoice identifiers or financial values.
    logError(`[sync] invoice verification not recorded (dashboard freshness will read as unknown): ${
      error instanceof Error ? error.message.slice(0, 160) : "unknown error"}`);
  }
}
