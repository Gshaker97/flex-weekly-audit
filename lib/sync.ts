import { cancelPaidOwnedInvoiceCycle } from "./ghl-paid-cycle-cancellation";
import { syncExistingOverdueBootstrap } from "./ghl-bootstrap-operation";
import { readPrePaidDateWitness, readPaidDateReadback } from "./ghl-paid-date-witness";
import { readConfiguredStandingIdentityPolicy, readStandingIdentityInventory } from "./ghl-standing-identity";
import { inspectReviewedIdentityInventory, reviewedIdentityOwnerEvidence } from "./ghl-identity-coverage";
import { prisma } from "./prisma";
import { latestCycleOwner, admitSyncRun, SyncEntrypoint, SyncRunWriter, SyncWriterBlockedError } from "./sync-writer-control";
import { buildGhlWriteIntent, approvedGhlCards } from "./ghl-write-intent";
import { verifyFreshGhlIdentity, readFreshJobberIdentities, strictGhlIdentityHold, validGhlContactIdentity } from "./ghl-write-identity";
import { refreshOpenInvoiceStatuses } from "./open-invoice-status-refresh";
import { runConfiguredPaidCycle } from "./ghl-paid-cycle";
import { resetJournalOwnedInvoiceCycle } from "./ghl-cycle-reset";
import { syncRecurringDueDateBeforeStage } from "./ghl-recurring-due-date";
import { runConfiguredDateRepair } from "./ghl-date-repair-operation";
import { runConfiguredRecurringDay10, recurringDay10SyncIssue } from "./notification-recurring-cron";
import {
  fetchAllClients,
  fetchAllJobs,
  fetchAllInvoices,
  fetchAllJobTimesheets,
  fetchAllJobVisits,
  takePaginationWarnings,
  JobberJobNode,
  JobberClientNode,
  JobberInvoiceNode,
  FlatTimeEntry,
  FlatVisit,
  concatJobNotes,
  jobberGraphQL,
} from "./jobber";
import {
  getInvoicePipelineRefs,
  listContactsForPhoneMatching,
  listPipelineOpportunities,
  moveOpportunityToStage,
  readOpportunity,
  GhlContact,
  GhlOpportunity,
} from "./ghl";
import { phoneSourcePlan, readPhoneInvoiceEvidence } from "./ghl-phone-state";
import { canonicalPhone, matchPhoneCustomer, phoneMayShareOwner } from "./ghl-phone-match";
import { log, logError } from "./log";

// Backfill scope: when set to a Date, invoices are pulled in full but limited to
// those issued on/after it (instead of the incremental updatedAt filter). null =
// normal incremental invoice syncing.
const INVOICE_ISSUED_AFTER: Date | null = null;

// Clients mark jobs that intentionally don't need an invoice by writing
// "No Invoice" in the job's Notes in Jobber. Any job whose notes contain this
// phrase (case-insensitive substring) is excluded from Uninvoiced Revenue,
// along with all of its visits.
const NO_INVOICE_PHRASE = "no invoice";

function hasNoInvoiceNote(notesText: string): boolean {
  return notesText.toLowerCase().includes(NO_INVOICE_PHRASE);
}

// Run an async op over many items with bounded concurrency. The old code awaited
// each upsert one at a time (thousands of sequential round-trips → multi-minute
// syncs). A small batch size parallelizes without exhausting the DB pool.
// Concurrent writes per batch. Each upsert is a round trip to Railway's
// Postgres, so this is latency-bound rather than CPU-bound; Prisma queues
// anything beyond the pool, so a larger batch costs nothing when the pool is
// small and saves real time when it isn't.
const DB_BATCH_SIZE = 25;
export async function inBatches<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  size = DB_BATCH_SIZE
): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    const settled = await Promise.allSettled(items.slice(i, i + size).map(item => Promise.resolve().then(() => fn(item))));
    const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
  }
}

/** Times a sync step and logs it, so a slow sync names its own bottleneck. */
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    log(`[sync] step ${name} took ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
}

function isCompletedStatus(status: string | null | undefined) {
  if (!status) return false;
  const s = status.toLowerCase();
  return (
    s.includes("complete") ||
    s === "archived" ||
    s === "invoiced" ||
    s === "paid"
  );
}

function isRecurringJob(j: JobberJobNode): boolean {
  // Signal 1: explicit jobType field
  if (j.jobType) {
    const t = j.jobType.toLowerCase();
    if (t.includes("recurring")) return true;
    if (t.includes("one") && t.includes("off")) return false;
  }

  // Signal 2: billingType — recurring jobs are billed per visit / monthly / etc
  if (j.billingType) {
    const b = j.billingType.toLowerCase();
    if (
      b.includes("per_visit") ||
      b.includes("monthly") ||
      b.includes("fixed_price_per_visit") ||
      b.includes("recurring")
    ) {
      return true;
    }
  }

  // Signal 3: visit count — recurring jobs almost always have multiple visits
  const visitCount = j.visits?.totalCount ?? 0;
  if (visitCount >= 2) return true;

  // Signal 4: jobStatus — Jobber sometimes uses "Active" for ongoing recurring
  if (j.jobStatus) {
    const s = j.jobStatus.toLowerCase();
    if (s === "active" && visitCount >= 1) return true;
  }

  return false;
}

export async function runFullSync(
  opts: { triggeredBy?: "manual" | "cron"; full?: boolean; entrypoint?: SyncEntrypoint } = {}
) {
  const { run, since } = await admitSyncRun({ ...opts, entrypoint: opts.entrypoint ?? "http" });
  const writer = new SyncRunWriter(run.id);
  let heavyFeeds: Promise<{ ok: true } | { ok: false; err: unknown }> | undefined;
  let recurringDay10Issue: string | null = null;
  log(`[sync] mode=${run.mode}${since ? ` since=${since.toISOString()}` : ""}`);

  try {
    const clientNodes = await fetchAllClients(since);
    await upsertClients(clientNodes);
    await prisma.syncRun.update({
      where: { id: run.id },
      data: { customersFetched: clientNodes.length },
    });

    // Optional, default-disabled notification phase. Only an admitted standalone
    // cron may load its private standing policy. The first ordinary Jobber call
    // above owns the existing token lifecycle; no notification-driven refresh.
    // Await all notification settlement before heavy feeds; unknown event outcomes
    // retain their ledger fence without stopping unrelated dashboard cache refresh.
    const recurringDay10 = await runConfiguredRecurringDay10({ entrypoint: opts.entrypoint ?? "http" });
    recurringDay10Issue = recurringDay10SyncIssue(recurringDay10);
    if (recurringDay10Issue) await prisma.syncRun.update({ where: { id: run.id }, data: { errorMessage: recurringDay10Issue } });

    // Jobs and visits are the two heavy feeds — neither accepts an updatedAt
    // filter, so both pull in full every sync and together they are the large
    // majority of the pages fetched. They are independent of each other and
    // write to different tables, so they run side by side rather than one
    // after the other. Jobber throttles on query cost; jobberGraphQL already
    // backs off on a THROTTLED reply and the page delay widens with it, so
    // overlapping them degrades into the old behaviour rather than failing.
    // Settled into a value rather than left as a rejectable promise: nothing
    // awaits this until after the invoice and timesheet steps, and an
    // unhandled rejection in that window takes the whole process down.
    heavyFeeds = Promise.allSettled([
      (async () => {
        const jobNodes = await step("jobs", () => fetchAllJobs(since));
        await step("jobs:write", () => upsertJobs(jobNodes));
        await prisma.syncRun.update({
          where: { id: run.id },
          data: { jobsFetched: jobNodes.length },
        });
      })(),
      // Visits are best-effort: they drive the visit-level Overdue/Uninvoiced
      // tabs, and a failure here must not take the rest of the sync with it.
      (async () => {
        try {
          const visits = await step("visits", () => fetchAllJobVisits(since));
          await step("visits:write", () => upsertVisits(visits));
          const warnings = takePaginationWarnings();
          await prisma.syncRun.update({
            where: { id: run.id },
            data: {
              visitsFetched: visits.length,
              // A truncated pull is not an error, but it silently leaves the
              // newest records stale — so it has to be recorded, not just logged.
              ...(warnings.length ? { errorMessage: [recurringDay10Issue, ...warnings].filter(Boolean).join(" · ") } : {}),
            },
          });
        } catch (err: any) {
          // Recorded, not just logged: a silent failure here is
          // indistinguishable from "I re-synced and nothing changed".
          logError("Visit sync failed (continuing):", err?.message ?? err);
          await prisma.syncRun
            .update({
              where: { id: run.id },
              data: { errorMessage: [recurringDay10Issue, `Visit sync failed: ${err?.message ?? err}`].filter(Boolean).join(" · ") },
            })
            .catch(() => {});
        }
      })(),
    ]).then(results => {
      const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      return failed ? { ok: false as const, err: failed.reason } : { ok: true as const };
    });

    // Backfill: full invoice pull scoped to invoices issued on/after 2026-01-01,
    // replacing the incremental updatedAt filter for invoices. (Temporary — revert
    // INVOICE_ISSUED_AFTER to resume normal incremental invoice syncing.)
    const invoiceNodes = await fetchAllInvoices(since, INVOICE_ISSUED_AFTER);
    await upsertInvoices(invoiceNodes);
    await prisma.syncRun.update({
      where: { id: run.id },
      data: { invoicesFetched: invoiceNodes.length },
    });

    // Timesheets are best-effort: requires the time-tracking scope + a plan
    // that supports it. A failure here must not fail the whole sync.
    try {
      const timeEntries = await fetchAllJobTimesheets(since);
      await upsertTimeEntries(timeEntries);
      await prisma.syncRun.update({
        where: { id: run.id },
        data: { timeEntriesFetched: timeEntries.length },
      });
    } catch (err: any) {
      logError("Timesheet sync failed (continuing):", err?.message ?? err);
    }

    // Everything after this point reads jobs and visits together.
    const heavy = await step("jobs+visits", () => heavyFeeds!);
    if (!heavy.ok) throw heavy.err;

    // Some source statuses change as time passes without appearing in the
    // incremental updatedAt feed. The gated refresh reads all cached open IDs.
    // Read/write failure propagates, so this run cannot continue into GHL with
    // a partially applied status correction. Activation requires release review.
    await step("refreshOpenInvoiceStatuses", () => refreshOpenInvoiceStatuses());

    // Stamp the "No Invoice" note flag onto visits so the Uninvoiced Revenue
    // metric excludes intentionally-uninvoiced jobs and all their visits.
    log("[sync] step: reconcileVisitNoInvoiceFlags");
    await step("reconcileVisitNoInvoiceFlags", () => reconcileVisitNoInvoiceFlags());

    // Visits whose job was closed out without each visit being ticked complete.
    log("[sync] step: reconcileVisitJobCompletion");
    await step("reconcileVisitJobCompletion", () => reconcileVisitJobCompletion());

    log("[sync] step: recomputeCustomerAggregates");
    await step("recomputeCustomerAggregates", () => recomputeCustomerAggregates());
    log("[sync] step: recomputeMonthlySnapshots");
    await step("recomputeMonthlySnapshots", () => recomputeMonthlySnapshots());
    log("[sync] step: recomputeServiceTypeRevenue");
    await step("recomputeServiceTypeRevenue", () => recomputeServiceTypeRevenue());

    // Flag missing source objects without inventing void/payment. Fresh full
    // source evidence below independently holds all ambiguous GHL changes.
    try {
      log("[sync] step: reconcileDeletedInvoices");
      await reconcileDeletedInvoices();
    } catch (err: any) {
      logError("Deleted-invoice reconciliation failed (continuing):", err?.message ?? err);
    }

    // Reconcile existing ordinary GHL cards. Defaults to verified email Paid
    // exits only; other changes require explicit mode/gates. Best-effort: a GHL
    // outage must not prevent refreshing the Jobber dashboard cache.
    try {
      const ghlSynced = await syncGhlInvoicePipeline({ writer });
      await prisma.syncRun.update({
        where: { id: run.id },
        data: { ghlOpportunitiesSynced: ghlSynced },
      });
      log(`[sync] ghlInvoicePipeline: ${ghlSynced} invoices synced to GHL`);
    } catch (err: any) {
      if (err instanceof SyncWriterBlockedError) throw err;
      logError("GHL invoice sync failed (continuing):", err?.message ?? err);
    }

    // No-op unless an exact, short-lived request is separately approved and
    // enabled. Only the admitted standalone cron can reach a field-only write;
    // review mode and phone-write hold remain required. Unknown outcomes retain
    // the durable barrier and must not be swallowed as a best-effort failure.
    const dateRepair = await runConfiguredDateRepair({ writer, entrypoint: opts.entrypoint ?? "http" });
    if (dateRepair.state !== "disabled") log(`[sync] exactOpportunityDateRepair: ${dateRepair.state}`);
    if (dateRepair.state === "applied") await prisma.syncRun.update({ where: { id: run.id },
      data: { ghlOpportunitiesSynced: { increment: 1 } } });
    const paidCycle = await runConfiguredPaidCycle({ writer, entrypoint: opts.entrypoint ?? "http" });
    if (paidCycle.state !== "disabled") log(`[sync] exactPaidCycle: ${paidCycle.state}`);
    if (paidCycle.state === "applied") await prisma.syncRun.update({ where: { id: run.id },
      data: { ghlOpportunitiesSynced: { increment: 1 } } });

    return await writer.finish("complete");
  } catch (err: any) {
    // Never release admission while a rejected feed still has sibling work.
    // A killed process leaves running/blocked state for explicit operator review.
    await heavyFeeds;
    await writer.finish("failed", [recurringDay10Issue, err?.message ?? "Unknown error"].filter(Boolean).join(" · "));
    throw err;
  }
}

async function upsertClients(nodes: JobberClientNode[]) {
  await inBatches(nodes, async (c) => {
    const email = c.emails?.find((e) => e.primary)?.address ?? c.emails?.[0]?.address ?? null;
    const phone = c.phones?.find((p) => p.primary)?.number ?? c.phones?.[0]?.number ?? null;

    await prisma.customer.upsert({
      where: { jobberClientId: c.id },
      create: {
        jobberClientId: c.id,
        name: c.name ?? null,
        companyName: c.companyName ?? null,
        email,
        phone,
        createdAtJobber: c.createdAt ? new Date(c.createdAt) : null,
      },
      update: {
        name: c.name ?? null,
        companyName: c.companyName ?? null,
        email,
        phone,
        createdAtJobber: c.createdAt ? new Date(c.createdAt) : null,
        lastSyncedAt: new Date(),
      },
    });
  });
}

async function upsertJobs(nodes: JobberJobNode[]) {
  // Preload the customer id map once instead of a findUnique per job.
  const clientIds = Array.from(
    new Set(nodes.map((n) => n.client?.id).filter(Boolean) as string[])
  );
  const customers = clientIds.length
    ? await prisma.customer.findMany({
        where: { jobberClientId: { in: clientIds } },
        select: { id: true, jobberClientId: true },
      })
    : [];
  const customerByClientId = new Map(customers.map((c) => [c.jobberClientId, c.id]));

  await inBatches(nodes, async (j) => {
    const customerId = j.client?.id
      ? customerByClientId.get(j.client.id) ?? null
      : null;

    const recurring = isRecurringJob(j);
    const invoiceNumber = j.invoices?.nodes?.[0]?.invoiceNumber ?? null;
    const hasInvoice = (j.invoices?.nodes?.length ?? 0) > 0;
    const notesText = concatJobNotes(j);
    const noInvoiceFlag = hasNoInvoiceNote(notesText);

    // Store a richer jobType string so the service-type breakdown is useful
    const storedJobType =
      j.jobType ||
      (recurring ? "Recurring" : "One-off");

    await prisma.jobRecord.upsert({
      where: { jobberJobId: j.id },
      create: {
        jobberJobId: j.id,
        jobNumber: j.jobNumber != null ? String(j.jobNumber) : null,
        title: j.title ?? null,
        jobStatus: j.jobStatus ?? null,
        jobType: storedJobType,
        isRecurring: recurring,
        total: j.total != null ? Number(j.total) : 0,
        completedAt: j.completedAt ? new Date(j.completedAt) : null,
        startAt: j.startAt ? new Date(j.startAt) : null,
        endAt: j.endAt ? new Date(j.endAt) : null,
        createdAtJobber: j.createdAt ? new Date(j.createdAt) : null,
        customerId,
        clientName: j.client?.companyName || j.client?.name || null,
        hasInvoice,
        invoiceNumber,
        notes: notesText || null,
        noInvoiceFlag,
      },
      update: {
        jobNumber: j.jobNumber != null ? String(j.jobNumber) : null,
        title: j.title ?? null,
        jobStatus: j.jobStatus ?? null,
        jobType: storedJobType,
        isRecurring: recurring,
        total: j.total != null ? Number(j.total) : 0,
        completedAt: j.completedAt ? new Date(j.completedAt) : null,
        startAt: j.startAt ? new Date(j.startAt) : null,
        endAt: j.endAt ? new Date(j.endAt) : null,
        createdAtJobber: j.createdAt ? new Date(j.createdAt) : null,
        customerId,
        clientName: j.client?.companyName || j.client?.name || null,
        hasInvoice,
        invoiceNumber,
        notes: notesText || null,
        noInvoiceFlag,
        lastSyncedAt: new Date(),
      },
    });
  });
}

// Propagate each job's "No Invoice" note flag down to its visits, so the
// visit-level Uninvoiced Revenue metric can exclude them. Runs every sync and
// reconciles in both directions (notes added AND removed), independent of
// whether a given visit was re-fetched this run.
async function reconcileVisitNoInvoiceFlags() {
  const flaggedJobIds = (
    await prisma.jobRecord.findMany({
      where: { noInvoiceFlag: true },
      select: { jobberJobId: true },
    })
  ).map((j) => j.jobberJobId);

  // Mark visits belonging to flagged jobs.
  await prisma.visitRecord.updateMany({
    where: { jobberJobId: { in: flaggedJobIds }, noInvoiceFlag: false },
    data: { noInvoiceFlag: true },
  });

  // Clear the flag on any visit whose job is no longer flagged (note removed).
  // An empty flaggedJobIds list correctly clears everything.
  await prisma.visitRecord.updateMany({
    where: { noInvoiceFlag: true, jobberJobId: { notIn: flaggedJobIds } },
    data: { noInvoiceFlag: false },
  });
}

/**
 * Inherit completion from the parent job.
 *
 * Jobber lets you close out a JOB without ticking each of its visits complete
 * on the schedule, and crews routinely do exactly that. Those visits keep
 * isComplete = false forever, so they sat in "Jobs not marked as completed"
 * through every re-sync even though the job reads Complete in Jobber.
 *
 * A visit counts as done-by-job when its job is complete (or is sitting in
 * Jobber's requires-invoicing state, which means the work is finished) and the
 * visit happened on or before the job was completed — so visits scheduled
 * after a job was closed out aren't swept up with it.
 *
 * Set-based on purpose: doing this per job would be thousands of round trips.
 */
async function reconcileVisitJobCompletion() {
  const COMPLETE_JOB = `(
    j."completedAt" IS NOT NULL
    OR lower(coalesce(j."jobStatus", '')) LIKE '%complete%'
    OR lower(coalesce(j."jobStatus", '')) LIKE '%requires_invoicing%'
    OR lower(coalesce(j."jobStatus", '')) LIKE '%requires invoicing%'
    OR lower(coalesce(j."jobStatus", '')) LIKE '%archiv%'
  )`;
  // An ARCHIVED job is closed out and gone from Jobber's working set, so every
  // one of its visits is settled no matter what date it carries. Recurring
  // schedules routinely leave visits dated after the job was archived, and
  // those were the ones the date guard kept flagging forever.
  const ARCHIVED = `lower(coalesce(j."jobStatus", '')) LIKE '%archiv%'`;
  const IN_WINDOW = `(
    ${ARCHIVED}
    OR j."completedAt" IS NULL
    OR v."visitDate" <= j."completedAt"
  )`;

  const marked = await prisma.$executeRawUnsafe(`
    UPDATE "VisitRecord" v
    SET "jobComplete" = true
    FROM "JobRecord" j
    WHERE v."jobberJobId" = j."jobberJobId"
      AND v."jobComplete" = false
      AND ${COMPLETE_JOB}
      AND ${IN_WINDOW}
  `);

  // Clear it again if the job was reopened, or the visit moved past the
  // completion date. An unmatched visit correctly falls back to false.
  const cleared = await prisma.$executeRawUnsafe(`
    UPDATE "VisitRecord" v
    SET "jobComplete" = false
    WHERE v."jobComplete" = true
      AND NOT EXISTS (
        SELECT 1 FROM "JobRecord" j
        WHERE j."jobberJobId" = v."jobberJobId"
          AND ${COMPLETE_JOB}
          AND ${IN_WINDOW}
      )
  `);

  log(`[sync] visit job-completion: ${marked} marked, ${cleared} cleared`);
}

async function upsertInvoices(nodes: JobberInvoiceNode[]) {
  const clientIds = Array.from(
    new Set(nodes.map((n) => n.client?.id).filter(Boolean) as string[])
  );
  const customers = clientIds.length
    ? await prisma.customer.findMany({
        where: { jobberClientId: { in: clientIds } },
        select: { id: true, jobberClientId: true },
      })
    : [];
  const customerByClientId = new Map(customers.map((c) => [c.jobberClientId, c.id]));

  await inBatches(nodes, async (inv) => {
    const customerId = inv.client?.id
      ? customerByClientId.get(inv.client.id) ?? null
      : null;

    const total = inv.amounts?.total ?? 0;
    const balance = inv.amounts?.invoiceBalance ?? 0;
    const amountPaid = total - balance;
    const isPaid = balance === 0 && total > 0;

    await prisma.invoiceRecord.upsert({
      where: { jobberInvoiceId: inv.id },
      create: {
        jobberInvoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber ?? null,
        invoiceStatus: inv.invoiceStatus ?? null,
        subtotal: inv.subtotal ?? inv.amounts?.subtotal ?? 0,
        total,
        amountPaid,
        amountDue: balance,
        issuedAt: inv.issuedDate ? new Date(inv.issuedDate) : null,
        dueAt: inv.dueDate ? new Date(inv.dueDate) : null,
        paidAt: isPaid && inv.issuedDate ? new Date(inv.issuedDate) : null,
        createdAtJobber: inv.createdAt ? new Date(inv.createdAt) : null,
        customerId,
        clientName: inv.client?.companyName || inv.client?.name || null,
      },
      update: {
        invoiceNumber: inv.invoiceNumber ?? null,
        invoiceStatus: inv.invoiceStatus ?? null,
        subtotal: inv.subtotal ?? inv.amounts?.subtotal ?? 0,
        total,
        amountPaid,
        amountDue: balance,
        issuedAt: inv.issuedDate ? new Date(inv.issuedDate) : null,
        dueAt: inv.dueDate ? new Date(inv.dueDate) : null,
        paidAt: isPaid && inv.issuedDate ? new Date(inv.issuedDate) : null,
        createdAtJobber: inv.createdAt ? new Date(inv.createdAt) : null,
        customerId,
        clientName: inv.client?.companyName || inv.client?.name || null,
        lastSyncedAt: new Date(),
      },
    });
  });
}

// Supported ordinary stages. Every other stage is a manual-review hold.
const GHL_STAGE_SENT = "Invoice Sent";
const GHL_STAGE_OVERDUE = "Invoice Overdue";
const GHL_STAGE_PAID = "Invoice Paid";

// Existing entry cutoff. Old positive debt still blocks a Paid exit.
const GHL_SYNC_SINCE = new Date("2026-01-01T00:00:00Z");

// True when an invoice shouldn't have a GHL opportunity: it's too old (issued —
// or, if there's no issue date, created — before the cutoff) or has a $0/null
// total. Keyed on total (not amountDue) so a fully-paid invoice with a real
// total isn't treated as a zero-dollar invoice.
function isOldOrZeroInvoice(inv: {
  issuedAt: Date | null;
  createdAtJobber: Date | null;
  total: number | null;
}): boolean {
  const issued = inv.issuedAt ?? inv.createdAtJobber;
  if (!issued || issued < GHL_SYNC_SINCE) return true;
  return !(inv.total ?? 0);
}

// Group-order eligibility only; the fresh source plan authorizes any write.
function skipForSync(inv: {
  issuedAt: Date | null;
  createdAtJobber: Date | null;
  total: number | null;
  amountDue: number | null;
}): boolean {
  return isOldOrZeroInvoice(inv) || (inv.amountDue ?? 0) <= 0;
}

// Missing source objects are unknown, not evidence of payment or cancellation.
// Keep last-known cache balances visible for review; never invent void/zero.
export async function reconcileDeletedInvoices(): Promise<number> {
  const open = await prisma.invoiceRecord.findMany({
    where: {
      invoiceStatus: { in: ["past_due", "awaiting_payment"] },
      issuedAt: { gte: GHL_SYNC_SINCE },
    },
    select: { id: true, jobberInvoiceId: true },
  });
  if (open.length === 0) {
    log("[sync] reconcile deleted invoices — checked=0 voided=0");
    return 0;
  }

  const BATCH = 25;
  const missingIds: string[] = [];
  for (let i = 0; i < open.length; i += BATCH) {
    const slice = open.slice(i, i + BATCH);
    // One aliased query per batch: i0: invoice(id:$id0){id} i1: … — a null field
    // means the source object is unavailable, not proof it was paid or voided.
    const varDefs = slice.map((_, j) => `$id${j}: EncodedId!`).join(", ");
    const fields = slice
      .map((_, j) => `i${j}: invoice(id: $id${j}) { id }`)
      .join(" ");
    const variables: Record<string, string> = {};
    slice.forEach((inv, j) => {
      variables[`id${j}`] = inv.jobberInvoiceId;
    });
    try {
      const data = await jobberGraphQL<Record<string, { id: string } | null>>(
        `query(${varDefs}) { ${fields} }`,
        variables
      );
      slice.forEach((inv, j) => {
        if (data[`i${j}`] === null) missingIds.push(inv.id);
      });
    } catch (err: any) {
      logError(
        `[sync] reconcile: batch of ${slice.length} failed (skipping):`,
        err?.message ?? err
      );
    }
  }

  if (missingIds.length > 0) {
    logError(`[sync] ${missingIds.length} invoices missing at source; retained last-known balances for review, not marked void or paid`);
  }
  return 0;
}

// Explicit modes separate cache/dashboard refresh from reminder enrollment.
// paid_only preserves verified settled exits, but does NOT cancel queued GHL
// reminders by itself. Both the exit workflow and any enrollment need review.
export type GhlInvoiceWriteMode = "review" | "paid_only" | "sync";
export interface GhlInvoiceReview {
  customerId?: string;
  jobberClientId?: string;
  candidateContactIds?: string[];
  storedInvoiceIds?: string[];
  contactId?: string;
  opportunityId?: string;
  action: "hold" | "unchanged" | "planned" | "applied" | "failed";
  reason: string;
  from?: { stageId?: string | null; status?: string | null; monetaryValue?: number | null; name?: string | null };
  to?: { stageId: string; monetaryValue: number; name?: string };
}

// Existing cards only. Never delete duplicates/old cards, infer payment from
// absence, use a duplicate-create error as identity, or reopen won/lost cards.
export async function syncGhlInvoicePipeline(opts: {
  mode?: GhlInvoiceWriteMode;
  report?: (entry: GhlInvoiceReview) => void;
  writer?: Pick<SyncRunWriter, "prepare" | "assertPending" | "confirm" | "block"> & Partial<Pick<SyncRunWriter, "readCycleHistory">>;
} = {}): Promise<number> {
  const mode = opts.mode ?? process.env.GHL_INVOICE_WRITE_MODE ?? "paid_only";
  if (!["review", "paid_only", "sync"].includes(mode)) throw new Error("Invalid GHL_INVOICE_WRITE_MODE");
  const phoneWrites = process.env.GHL_PHONE_WRITES_ENABLED === "true";
  const approvedCards = approvedGhlCards();
  const report = (entry: GhlInvoiceReview) => {
    log(`[ghl-plan] ${JSON.stringify(entry)}`);
    opts.report?.(entry);
  };
  const refs = await getInvoicePipelineRefs();
  const sentId = refs.stageIdByName[GHL_STAGE_SENT.toLowerCase()];
  const overdueId = refs.stageIdByName[GHL_STAGE_OVERDUE.toLowerCase()];
  const paidId = refs.stageIdByName[GHL_STAGE_PAID.toLowerCase()];
  if (!sentId || !overdueId || !paidId) throw new Error("Required invoice stages missing");
  const now = new Date();
  const customers = await prisma.customer.findMany();
  const invoices = await prisma.invoiceRecord.findMany({ include: { customer: true } });
  // Complete, status=all snapshots are required BEFORE the first write.
  let contacts: GhlContact[];
  let cards: GhlOpportunity[];
  try {
    contacts = await listContactsForPhoneMatching();
    if (contacts.some(contact => !validGhlContactIdentity(contact))) throw new Error("GHL identity field shape is unverified");
    cards = await listPipelineOpportunities(refs.pipelineId);
  } catch (err: any) {
    report({ action: "hold", reason: `Incomplete GHL preflight; no writes: ${err?.message ?? err}` });
    return 0;
  }
  const phoneCustomers = customers.filter(c => !c.email?.trim() && c.phone?.trim() &&
    invoices.some(inv => inv.customerId === c.id && !isOldOrZeroInvoice(inv)));
  const phoneIdentities = new Map(phoneCustomers.map(customer =>
    [customer.id, matchPhoneCustomer(customer, customers, contacts)]));
  const protectedPhoneContacts = new Set([...phoneIdentities.values()].flatMap(identity => identity.candidateIds));
  const protectedPhones = phoneCustomers.filter(c => phoneIdentities.get(c.id)?.candidateIds.length)
    .map(c => canonicalPhone(c.phone)).filter((phone): phone is string => !!phone);
  const reviewedCards = new Set<string>();
  const processedCustomers = new Set<string>();
  let source: ReturnType<typeof readPhoneInvoiceEvidence> | undefined;
  let freshIdentities: ReturnType<typeof readFreshJobberIdentities> | undefined;
  let standingInventory: ReturnType<typeof readStandingIdentityInventory> | undefined;
  let standingInventoryPolicy: string | undefined;
  let sourceObservedAt: string | undefined;
  let applied = 0;
  let writesHalted = false;
  const cardInfo = (card: GhlOpportunity) => ({ opportunityId: card.id, contactId: card.contactId ?? undefined,
    from: { stageId: card.pipelineStageId, status: card.status, monetaryValue: card.monetaryValue, name: card.name } });
  const holdCards = (reason: string, candidateIds: string[], customer?: typeof customers[number]) => {
    const affected = cards.filter(card => !!card.contactId && candidateIds.includes(card.contactId));
    const owner = customer ? { customerId: customer.id, jobberClientId: customer.jobberClientId, candidateContactIds: candidateIds } : {};
    if (!affected.length) report({ ...owner, action: "hold", reason });
    for (const card of affected) {
      reviewedCards.add(card.id);
      report({ ...owner, ...cardInfo(card), action: "hold", reason });
    }
  };
  // Unsupported relevant phone formats leave ownership unresolved across paths.
  if (phoneCustomers.some(c => !canonicalPhone(c.phone))) {
    for (const card of cards) report({ ...cardInfo(card), action: "hold", reason: "Unresolved phone ownership; no pipeline writes" });
    return 0;
  }

  const reconcile = async (customer: typeof customers[number]) => {
    if (processedCustomers.has(customer.id)) return;
    // Mark before any request: a failed/uncertain write is never retried by an
    // exit/cleanup pass during the same run.
    processedCustomers.add(customer.id);
    const ownInvoices = invoices.filter(inv => inv.customerId === customer.id);
    const email = customer.email?.trim().toLowerCase();
    let candidateIds: string[];
    if (email) {
      candidateIds = contacts.filter(c => c.email?.trim().toLowerCase() === email).map(c => c.id);
      if (customers.filter(c => c.email?.trim().toLowerCase() === email).length !== 1) {
        holdCards("Email belongs to multiple Jobber customers", candidateIds, customer); return;
      }
      if (candidateIds.some(id => protectedPhoneContacts.has(id)) || protectedPhones.some(phone => phoneMayShareOwner(customer.phone, phone))) {
        holdCards("Contact has a phone-only ownership hold", candidateIds, customer); return;
      }
    } else {
      const identity = phoneIdentities.get(customer.id);
      if (!identity) return;
      candidateIds = identity.candidateIds;
      if (!identity.contactId) { holdCards(`Phone identity: ${identity.reason}`, candidateIds, customer); return; }
      candidateIds = [identity.contactId];
    }
    if (candidateIds.length !== 1) {
      holdCards(candidateIds.length ? "Multiple exact GHL contacts" : "No existing exact GHL contact", candidateIds, customer); return;
    }
    const contactId = candidateIds[0];
    const identityHold = strictGhlIdentityHold(customer, customers, contacts, contactId);
    if (identityHold) { holdCards(identityHold, candidateIds, customer); return; }
    const matchingCards = cards.filter(card => card.contactId === contactId);
    if (matchingCards.length !== 1) {
      holdCards(matchingCards.length ? "Multiple existing cards, including closed statuses" : "No existing card; creation disabled", candidateIds, customer); return;
    }
    const card = matchingCards[0];
    reviewedCards.add(card.id);
    const context = { customerId: customer.id, jobberClientId: customer.jobberClientId,
      storedInvoiceIds: ownInvoices.map(inv => inv.jobberInvoiceId), ...cardInfo(card) };
    if (card.status !== "open") {
      report({ ...context, action: "hold", reason: "Closed or unknown status; automatic reopening disabled" }); return;
    }
    if (![sentId, overdueId, paidId].includes(card.pipelineStageId ?? "")) {
      report({ ...context, action: "hold", reason: "Special stage protected, including Late Fee and Closed Out" }); return;
    }
    let mutationStarted = false;
    try {
      source ??= readPhoneInvoiceEvidence();
      const evidence = await source;
      sourceObservedAt ??= new Date().toISOString();
      const plan = phoneSourcePlan(customer.jobberClientId, ownInvoices.map(inv => inv.jobberInvoiceId), evidence, now);
      if (!plan) {
        report({ ...context, action: "hold", reason: "Incomplete, missing, unknown, void, old outstanding, or inconsistent Jobber evidence, including invalid monetary amounts" }); return;
      }
      const stageId = refs.stageIdByName[plan.stage.toLowerCase()];
      const paid = plan.stage === GHL_STAGE_PAID;
      const label = ownInvoices[0]?.clientName ?? customer.companyName ?? customer.name ?? customer.jobberClientId;
      const to = { stageId, monetaryValue: plan.total,
        ...(paid ? {} : { name: `${label} — ${plan.count} ${plan.stage === GHL_STAGE_OVERDUE ? "overdue" : "unpaid"} invoice${plan.count === 1 ? "" : "s"}` }) };
      const cancellationCandidate = !paid && card.pipelineStageId!==paidId && process.env.GHL_DIRECT_WORKFLOW_REMOVAL_ENABLED==="true"
        && process.env.GHL_CYCLE_OWNERSHIP_ENABLED==="true" && process.env.GHL_RECURRING_DUE_DATE_ENABLED==="true";
      const bootstrapOverdue = !paid && card.pipelineStageId === overdueId && process.env.GHL_EXISTING_OVERDUE_BOOTSTRAP_ENABLED === "true";
      if (!paid && card.pipelineStageId === overdueId && !cancellationCandidate && !bootstrapOverdue) {
        report({ ...context, to, action: "hold", reason: "Existing Overdue cycle requires execution review; no re-enrollment or clock restart" }); return;
      }
      if (!cancellationCandidate && !bootstrapOverdue && card.pipelineStageId === stageId && (paid || (card.monetaryValue === to.monetaryValue && card.name === to.name))) {
        report({ ...context, to, action: "unchanged", reason: "Already matches verified source" }); return;
      }
      const blocked = writesHalted ? "Earlier GHL write outcome unconfirmed; remaining writes halted" :
        mode === "review" ? "Review mode; no writes" :
        !email && !phoneWrites ? "Phone writes not enabled" :
        mode === "paid_only" && !paid ? "Enrollment and non-Paid changes require explicit sync mode" :
        !opts.writer ? "No admitted durable writer; no writes" :
        !approvedCards.has(card.id) ? "Card is outside the explicitly approved write cohort; Paid exits are also held" : null;
      report({ ...context, to, action: blocked ? "hold" : "planned", reason: blocked ?? "Fresh complete Jobber source verified" });
      if (blocked) return;
      const standingPolicy = readConfiguredStandingIdentityPolicy();
      let identityReason: string | null;
      let standingHandle: Awaited<ReturnType<typeof readStandingIdentityInventory>> | undefined;
      let standingEvidence: ReturnType<typeof reviewedIdentityOwnerEvidence> | undefined;
      if (standingPolicy) {
        const policyKey = JSON.stringify(standingPolicy);
        if (standingInventoryPolicy !== policyKey) { standingInventory = undefined; standingInventoryPolicy = policyKey; }
        standingInventory ??= readStandingIdentityInventory(standingPolicy, customers);
        standingHandle = await standingInventory;
        const inventory = inspectReviewedIdentityInventory(standingHandle);
        standingEvidence = reviewedIdentityOwnerEvidence(standingHandle, customer.jobberClientId);
        identityReason = verifyFreshGhlIdentity(customer, customers, contacts, contactId, inventory.identities, standingEvidence);
      } else {
        freshIdentities ??= readFreshJobberIdentities();
        identityReason = verifyFreshGhlIdentity(customer, customers, contacts, contactId, await freshIdentities);
      }
      if (identityReason) { report({ ...context, to, action: "hold", reason: identityReason }); return; }
      const standingHold = (): string | null => {
        if (!standingPolicy) return null;
        try {
          if (JSON.stringify(readConfiguredStandingIdentityPolicy()) !== JSON.stringify(standingPolicy))
            return "Standing identity authorization changed before write";
          if (!standingHandle || !standingEvidence) return "Standing identity evidence unavailable";
          const inventory = inspectReviewedIdentityInventory(standingHandle);
          // Reuse the SAME bounded handle and owner proof: never refresh either
          // its observation time or authorization just to get past a slow read.
          return verifyFreshGhlIdentity(customer, customers, contacts, contactId, inventory.identities, standingEvidence);
        } catch { return "Standing identity evidence expired or changed before write"; }
      };
      const current = await readOpportunity(card.id);
      const currentObservedAt = new Date().toISOString();
      if (current.pipelineId !== refs.pipelineId || current.contactId !== contactId || current.status !== "open") {
        report({ ...context, to, action: "hold", reason: "Card ownership/status changed before write" }); return;
      }
      if (!cancellationCandidate && !bootstrapOverdue && current.pipelineStageId === stageId && (paid || (current.monetaryValue === to.monetaryValue && current.name === to.name))) {
        report({ ...context, to, action: "unchanged", reason: "Fresh GHL read already matches target; no repeated PUT" }); return;
      }
      if (current.pipelineStageId !== card.pipelineStageId || current.name !== card.name || current.monetaryValue !== card.monetaryValue) {
        report({ ...context, to, action: "hold", reason: "Card changed since preflight; replan on a fresh run" }); return;
      }
      const postReadStandingHold = standingHold();
      if (postReadStandingHold) { report({ ...context, to, action: "hold", reason: postReadStandingHold }); return; }
      if(cancellationCandidate){
        if(!opts.writer!.readCycleHistory){report({...context,to,action:"hold",reason:"Cancellation requires durable cycle history"});return;}
        mutationStarted=true;
        const cancelled=await cancelPaidOwnedInvoiceCycle({
          scope:{locationId:process.env.GHL_LOCATION_ID??"",opportunityId:card.id,contactId,jobberClientId:customer.jobberClientId},
          expectedCard:current,mode,phoneOwner:!email,writer:{
            prepare:opts.writer!.prepare.bind(opts.writer),assertPending:opts.writer!.assertPending.bind(opts.writer),
            confirm:opts.writer!.confirm.bind(opts.writer),block:opts.writer!.block.bind(opts.writer),
            readCycleHistory:opts.writer!.readCycleHistory.bind(opts.writer)},
        });
        if(cancelled.state==="cancelled"){
          if(!cancelled.reused)applied+=1;
          report({...context,to,action:cancelled.reused?"hold":"applied",
            reason:"Owned paid invoice workflow removal acknowledged; aggregate card unchanged and successor entry held"});
          return;
        }
        if(cancelled.state==="held"){report({...context,to,action:"hold",reason:cancelled.reason});return;}
        if(current.pipelineStageId===overdueId && !bootstrapOverdue){
          report({...context,to,action:"hold",reason:"Existing Overdue cycle requires execution review; no re-enrollment or clock restart"});return;
        }
      }
      if (bootstrapOverdue) {
        const unpaid = evidence.filter(i => i.client?.id === customer.jobberClientId &&
          (i.invoiceStatus?.toLowerCase() !== "paid" || i.amounts?.invoiceBalance !== 0));
        if (unpaid.length !== 1 || !opts.writer!.readCycleHistory) {
          report({ ...context, to, action:"hold", reason:"Bootstrap requires unique unpaid source and durable complete history" }); return;
        }
        mutationStarted=true;
        const result=await syncExistingOverdueBootstrap({
          scope:{locationId:process.env.GHL_LOCATION_ID??"",opportunityId:card.id,contactId,
            jobberClientId:customer.jobberClientId,invoiceId:unpaid[0].id},
          expectedCard:current,target:to,mode,phoneOwner:!email,writer:{
            prepare:opts.writer!.prepare.bind(opts.writer),assertPending:opts.writer!.assertPending.bind(opts.writer),
            confirm:opts.writer!.confirm.bind(opts.writer),block:opts.writer!.block.bind(opts.writer),
            readCycleHistory:opts.writer!.readCycleHistory.bind(opts.writer)},
        });
        if(result.state==="applied")applied+=1;
        report({...context,to,action:result.state==="applied"?"applied":"hold",
          reason:result.state==="applied"?"Reviewed existing-overdue cycle entered with source date and past milestones skipped":result.reason});
        return;
      }
      if (!paid && process.env.GHL_CYCLE_OWNERSHIP_ENABLED === "true" && current.pipelineStageId === paidId) {
        const unpaid = evidence.filter(i => i.client?.id === customer.jobberClientId &&
          (i.invoiceStatus?.toLowerCase() !== "paid" || i.amounts?.invoiceBalance !== 0));
        if (unpaid.length !== 1 || !opts.writer!.readCycleHistory) {
          report({ ...context, to, action: "hold", reason: "Cycle reset requires unique unpaid source and durable cycle history" }); return;
        }
        mutationStarted = true;
        const result = await resetJournalOwnedInvoiceCycle({ scope: { locationId: process.env.GHL_LOCATION_ID ?? "", opportunityId: card.id,
          contactId, jobberClientId: customer.jobberClientId, invoiceId: unpaid[0].id }, expectedCard: current, name: to.name,
          writer: { prepare: opts.writer!.prepare.bind(opts.writer), assertPending: opts.writer!.assertPending.bind(opts.writer),
            confirm: opts.writer!.confirm.bind(opts.writer), block: opts.writer!.block.bind(opts.writer), readCycleHistory: opts.writer!.readCycleHistory.bind(opts.writer) },
          mode, phoneOwner: !email });
        if (result.state === "applied") applied += 1;
        report({ ...context, action: result.state === "applied" ? "applied" : "hold",
          reason: result.state === "applied" ? "Journal-owned next invoice reset to Sent after reviewed cleanup evidence; no enrollment claimed" : result.reason });
        return;
      }
      // Every possible Overdue enrollment goes through date-before-stage. When
      // disabled or effects are unverified, HOLD rather than fall back to the
      // legacy stage PUT. Existing Paid exit gates are unchanged.
      if (!paid && (stageId === overdueId || process.env.GHL_RECURRING_DUE_DATE_ENABLED === "true")) {
        const unpaid = evidence.filter(i => i.client?.id === customer.jobberClientId &&
          (i.invoiceStatus?.toLowerCase() !== "paid" || i.amounts?.invoiceBalance !== 0));
        if (unpaid.length !== 1) {
          report({ ...context, to, action: "hold", reason: "Recurring date binding requires exactly one unpaid owner invoice" }); return;
        }
        // The helper owns durable claims and blocks on any uncertain outcome.
        // Mark locally too, so an exception halts subsequent cards this run.
        mutationStarted = true;
        const result = await syncRecurringDueDateBeforeStage({
          scope: { locationId: process.env.GHL_LOCATION_ID ?? "", opportunityId: card.id,
            contactId, jobberClientId: customer.jobberClientId, invoiceId: unpaid[0].id },
          expectedCard: current, target: to, mode, phoneOwner: !email, writer: opts.writer!,
        });
        if (result.state === "applied") applied += 1;
        report({ ...context, to, action: result.state === "applied" ? "applied" : "hold",
          reason: result.state === "applied" ? "Due date read back before fresh verified stage transition; delivery not asserted" : result.reason });
        return;
      }
      const intent = buildGhlWriteIntent({ current, to, jobberClientId: customer.jobberClientId,
        source: evidence, storedInvoiceIds: ownInvoices.map(inv => inv.jobberInvoiceId), observedAt: sourceObservedAt });
      if (!intent) { report({ ...context, to, action: "hold", reason: "Immutable card/source evidence is unavailable" }); return; }
      if (paid && process.env.GHL_CYCLE_OWNERSHIP_ENABLED === "true" && opts.writer!.readCycleHistory) {
        const history = await opts.writer!.readCycleHistory();
        const owned = latestCycleOwner(history, { ...intent, locationId: process.env.GHL_LOCATION_ID ?? "" });
        // Keep the original owned card date as history; the actual paid source
        // may have edited its due date. Never misattribute a reset successor to
        // an older enrollment or repeat an already recorded Paid claim.
        const alreadyPaid = owned?.intent.cycle && history.some(w => w.intent.cycle?.phase === "paid"
          && w.intent.cycle.locationId === owned.intent.cycle!.locationId && w.intent.cycle.workflowId === owned.intent.cycle!.workflowId
          && w.intent.cycle.invoiceId === owned.intent.cycle!.invoiceId && w.intent.jobberClientId === intent.jobberClientId);
        if (owned?.intent.cycle && !alreadyPaid) {
          intent.cycle = { ...owned.intent.cycle, phase: "paid" };
          const witness = await readPrePaidDateWitness({ current, owner: owned, observedAt: currentObservedAt });
          if (witness) intent.cycle.paidDateWitness = witness;
        }
      }
      const preAdmissionStandingHold = standingHold();
      if (preAdmissionStandingHold) {
        report({ ...context, to, action: "hold", reason: preAdmissionStandingHold }); return;
      }
      // A failure anywhere after attempting the durable claim halts this writer.
      mutationStarted = true;
      const intentId = await opts.writer!.prepare(intent);
      await opts.writer!.assertPending(intentId);
      const preMutationStandingHold = standingHold();
      if (preMutationStandingHold) throw new Error(preMutationStandingHold);
      await moveOpportunityToStage(card.id, stageId, plan.total, to.name);
      const accepted = await readOpportunity(card.id);
      if (accepted.pipelineId !== current.pipelineId || accepted.contactId !== current.contactId || accepted.status !== "open"
          || accepted.pipelineStageId !== stageId || accepted.monetaryValue !== plan.total
          || accepted.name !== (to.name ?? current.name)) throw new Error("Post-write card state not confirmed");
      await opts.writer!.confirm(intentId, await readPaidDateReadback(intent, accepted));
      applied += 1;
      report({ ...context, to, action: "applied", reason: "GHL accepted update; downstream workflow effects not verified" });
    } catch (err: any) {
      // A timeout may have applied. No retry or compensating move, and no
      // remaining writes this run. This in-memory halt is NOT cross-run fencing.
      if (mutationStarted) { writesHalted = true; await opts.writer!.block(); }
      report({ ...context, action: "failed", reason: `${mutationStarted ? "GHL write outcome unconfirmed; remaining writes halted. " : "Source/read validation failed; held. "}${err?.message ?? err}` });
    }
  };

  // Preserve overdue group precedence. In particular this guard existed in
  // production; a future awaiting invoice must never demote its overdue group.
  const groups = new Map<string, typeof customers[number]>();
  for (const inv of invoices.filter(inv => inv.invoiceStatus === "past_due" && !skipForSync(inv))) {
    const customer = customers.find(c => c.id === inv.customerId);
    const email = customer?.email?.trim().toLowerCase();
    if (customer && email) groups.set(email, customer);
  }
  for (const customer of groups.values()) await reconcile(customer);
  for (const inv of invoices.filter(inv => inv.invoiceStatus === "awaiting_payment" && !skipForSync(inv))) {
    const customer = customers.find(c => c.id === inv.customerId);
    const email = customer?.email?.trim().toLowerCase();
    if (email && groups.has(email)) continue;
    if (customer) await reconcile(customer);
  }
  // Remaining owners include paid/unknown cache rows. Only explicit fresh
  // evidence can authorize their exit; lack of an overdue group proves nothing.
  for (const customer of customers) {
    if (invoices.some(inv => inv.customerId === customer.id)) await reconcile(customer);
  }
  for (const card of cards) {
    if (!reviewedCards.has(card.id)) report({ ...cardInfo(card), action: "hold", reason: "No unambiguous Jobber owner with stored invoice coverage" });
  }
  if (process.env.CLEANUP_INVALID_OPPS === "true") {
    log("[ghl] Invalid-card deletion disabled; old, zero, duplicate, closed and special-stage cards require individual review");
  }
  log(`[ghl] invoice sync mode=${mode} applied=${applied}; existing queued reminders are not canceled by holds`);
  return applied;
}

async function upsertTimeEntries(entries: FlatTimeEntry[]) {
  await inBatches(entries, async (e) => {
    const occurredAt = e.occurredAt ? new Date(e.occurredAt) : null;
    await prisma.timeEntry.upsert({
      where: { jobberEntryId: e.jobberEntryId },
      create: {
        jobberEntryId: e.jobberEntryId,
        jobberJobId: e.jobberJobId,
        jobNumber: e.jobNumber,
        jobTitle: e.jobTitle,
        clientName: e.clientName,
        clientCompanyName: e.clientCompanyName,
        label: e.label,
        labourRate: e.labourRate,
        visitId: e.visitId,
        employeeId: e.employeeId,
        employeeName: e.employeeName,
        durationSeconds: e.durationSeconds,
        approved: e.approved,
        ticking: e.ticking,
        note: e.note,
        occurredAt,
      },
      update: {
        jobberJobId: e.jobberJobId,
        jobNumber: e.jobNumber,
        jobTitle: e.jobTitle,
        clientName: e.clientName,
        clientCompanyName: e.clientCompanyName,
        label: e.label,
        labourRate: e.labourRate,
        visitId: e.visitId,
        employeeId: e.employeeId,
        employeeName: e.employeeName,
        durationSeconds: e.durationSeconds,
        approved: e.approved,
        ticking: e.ticking,
        note: e.note,
        occurredAt,
        lastSyncedAt: new Date(),
      },
    });
  });
}

/** Everything upsertVisits writes, flattened so two versions can be compared. */
function visitSignature(v: {
  jobberJobId: string | null;
  jobNumber: string | null;
  title: string | null;
  clientName: string | null;
  isComplete: boolean;
  visitStatus: string | null;
  visitDate: Date | null;
  startAt: Date | null;
  endAt: Date | null;
  completedAt: Date | null;
  hasInvoice: boolean;
  estimatedValue: number;
}): string {
  const t = (d: Date | null) => (d ? d.getTime() : 0);
  return [
    v.jobberJobId ?? "",
    v.jobNumber ?? "",
    v.title ?? "",
    v.clientName ?? "",
    v.isComplete ? 1 : 0,
    v.visitStatus ?? "",
    t(v.visitDate),
    t(v.startAt),
    t(v.endAt),
    t(v.completedAt),
    v.hasInvoice ? 1 : 0,
    Math.round((v.estimatedValue ?? 0) * 100),
  ].join("|");
}

async function upsertVisits(visits: FlatVisit[]) {
  // The visit feed is the largest by far and barely changes between syncs —
  // rewriting every row was the bulk of the database time. Read the current
  // rows once, write only what actually differs.
  //
  // Unchanged rows still need lastSyncedAt moved forward: that timestamp is
  // what marks a visit as still present in Jobber, and leaving it behind would
  // make every untouched visit look like it had been deleted there.
  const now = new Date();
  const incoming = visits.map((v) => {
    const start = v.startAt ? new Date(v.startAt) : null;
    const end = v.endAt ? new Date(v.endAt) : null;
    const completed = v.completedAt ? new Date(v.completedAt) : null;
    return {
      flat: v,
      visitDate: end ?? start ?? completed ?? null,
      start,
      end,
      completed,
    };
  });

  const existing = new Map<string, string>();
  const ids = incoming.map((i) => i.flat.jobberVisitId);
  for (let i = 0; i < ids.length; i += 2000) {
    const rows = await prisma.visitRecord.findMany({
      where: { jobberVisitId: { in: ids.slice(i, i + 2000) } },
      select: {
        jobberVisitId: true,
        jobberJobId: true,
        jobNumber: true,
        title: true,
        clientName: true,
        isComplete: true,
        visitStatus: true,
        visitDate: true,
        startAt: true,
        endAt: true,
        completedAt: true,
        hasInvoice: true,
        estimatedValue: true,
      },
    });
    for (const r of rows) existing.set(r.jobberVisitId, visitSignature(r));
  }

  const changed: typeof incoming = [];
  const unchangedIds: string[] = [];
  for (const item of incoming) {
    const v = item.flat;
    const next = visitSignature({
      jobberJobId: v.jobberJobId,
      jobNumber: v.jobNumber,
      title: v.title,
      clientName: v.clientName,
      isComplete: v.isComplete,
      visitStatus: v.visitStatus,
      visitDate: item.visitDate,
      startAt: item.start,
      endAt: item.end,
      completedAt: item.completed,
      hasInvoice: v.hasInvoice,
      estimatedValue: v.estimatedValue,
    });
    const prev = existing.get(v.jobberVisitId);
    if (prev !== undefined && prev === next) unchangedIds.push(v.jobberVisitId);
    else changed.push(item);
  }

  // One cheap statement per chunk keeps the untouched rows marked as present.
  for (let i = 0; i < unchangedIds.length; i += 2000) {
    await prisma.visitRecord.updateMany({
      where: { jobberVisitId: { in: unchangedIds.slice(i, i + 2000) } },
      data: { lastSyncedAt: now },
    });
  }
  log(
    `[sync] visits: ${changed.length} changed, ${unchangedIds.length} unchanged (timestamp only)`
  );

  await inBatches(changed, async ({ flat: v, visitDate, start, end, completed }) => {
    await prisma.visitRecord.upsert({
      where: { jobberVisitId: v.jobberVisitId },
      create: {
        jobberVisitId: v.jobberVisitId,
        jobberJobId: v.jobberJobId,
        jobNumber: v.jobNumber,
        title: v.title,
        clientName: v.clientName,
        isComplete: v.isComplete,
        visitStatus: v.visitStatus,
        visitDate,
        startAt: start,
        endAt: end,
        completedAt: completed,
        hasInvoice: v.hasInvoice,
        estimatedValue: v.estimatedValue,
      },
      update: {
        jobberJobId: v.jobberJobId,
        jobNumber: v.jobNumber,
        title: v.title,
        clientName: v.clientName,
        isComplete: v.isComplete,
        visitStatus: v.visitStatus,
        visitDate,
        startAt: start,
        endAt: end,
        completedAt: completed,
        hasInvoice: v.hasInvoice,
        estimatedValue: v.estimatedValue,
        lastSyncedAt: new Date(),
      },
    });
  });
}

async function recomputeCustomerAggregates() {
  const customers = await prisma.customer.findMany({ select: { id: true } });

  // Load all customer-linked jobs once and group in memory, instead of a
  // findMany per customer.
  const jobs = await prisma.jobRecord.findMany({
    where: { customerId: { not: null } },
    select: { customerId: true, total: true, isRecurring: true, completedAt: true, endAt: true },
  });
  const jobsByCustomer = new Map<string, typeof jobs>();
  for (const j of jobs) {
    if (!j.customerId) continue;
    const arr = jobsByCustomer.get(j.customerId);
    if (arr) arr.push(j);
    else jobsByCustomer.set(j.customerId, [j]);
  }

  await inBatches(customers, async (c) => {
    const cJobs = jobsByCustomer.get(c.id) ?? [];
    const totalRevenue = cJobs.reduce((acc, j) => acc + (j.total || 0), 0);
    const isRecurring = cJobs.some((j) => j.isRecurring);
    const lastJob =
      cJobs
        .map((j) => j.completedAt || j.endAt)
        .filter(Boolean)
        .sort((a, b) => b!.getTime() - a!.getTime())[0] || null;

    await prisma.customer.update({
      where: { id: c.id },
      data: {
        totalRevenue,
        jobCount: cJobs.length,
        isRecurring,
        lastJobAt: lastJob,
      },
    });
  });
}

async function recomputeMonthlySnapshots() {
  await prisma.monthlySnapshot.deleteMany({});

  const now = new Date();
  const startYear = now.getFullYear() - 1;

  const buckets: Map<string, {
    year: number;
    month: number;
    invoicedRevenue: number;
    collectedRevenue: number;
    newCustomers: number;
    jobsCompleted: number;
    jobValues: number[];
    recurringRevenue: number;
    oneOffRevenue: number;
  }> = new Map();

  function bucketKey(d: Date) {
    return `${d.getFullYear()}-${d.getMonth() + 1}`;
  }

  function getOrInit(d: Date) {
    const key = bucketKey(d);
    let b = buckets.get(key);
    if (!b) {
      b = {
        year: d.getFullYear(),
        month: d.getMonth() + 1,
        invoicedRevenue: 0,
        collectedRevenue: 0,
        newCustomers: 0,
        jobsCompleted: 0,
        jobValues: [],
        recurringRevenue: 0,
        oneOffRevenue: 0,
      };
      buckets.set(key, b);
    }
    return b;
  }

  for (let y = startYear; y <= now.getFullYear(); y++) {
    const monthStart = y === startYear ? now.getMonth() + 1 : 1;
    const monthEnd = y === now.getFullYear() ? now.getMonth() + 1 : 12;
    for (let m = monthStart; m <= monthEnd; m++) {
      getOrInit(new Date(y, m - 1, 1));
    }
  }

  const invoices = await prisma.invoiceRecord.findMany();
  for (const inv of invoices) {
    if (!inv.issuedAt) continue;
    const b = getOrInit(inv.issuedAt);
    b.invoicedRevenue += inv.total || 0;
    b.collectedRevenue += inv.amountPaid || 0;
  }

  const jobs = await prisma.jobRecord.findMany();
  for (const j of jobs) {
    if (!j.completedAt) continue;
    const b = getOrInit(j.completedAt);
    b.jobsCompleted += 1;
    if (j.total > 0) b.jobValues.push(j.total);
    if (j.isRecurring) b.recurringRevenue += j.total || 0;
    else b.oneOffRevenue += j.total || 0;
  }

  const customers = await prisma.customer.findMany();
  for (const c of customers) {
    if (!c.createdAtJobber) continue;
    const b = getOrInit(c.createdAtJobber);
    b.newCustomers += 1;
  }

  for (const b of Array.from(buckets.values())) {
    const avg =
      b.jobValues.length > 0
        ? b.jobValues.reduce((a, n) => a + n, 0) / b.jobValues.length
        : 0;
    await prisma.monthlySnapshot.create({
      data: {
        year: b.year,
        month: b.month,
        invoicedRevenue: b.invoicedRevenue,
        collectedRevenue: b.collectedRevenue,
        newCustomers: b.newCustomers,
        jobsCompleted: b.jobsCompleted,
        averageJobValue: avg,
        recurringRevenue: b.recurringRevenue,
        oneOffRevenue: b.oneOffRevenue,
      },
    });
  }
}

async function recomputeServiceTypeRevenue() {
  await prisma.serviceTypeRevenue.deleteMany({});

  const now = new Date();
  const year = now.getFullYear();
  const yearStart = new Date(year, 0, 1);
  const yearEnd = new Date(year, 11, 31, 23, 59, 59, 999);

  const jobs = await prisma.jobRecord.findMany({
    where: {
      completedAt: { gte: yearStart, lte: yearEnd },
    },
  });

  const buckets: Map<string, { revenue: number; count: number }> = new Map();
  for (const j of jobs) {
    const key = j.jobType || "Other";
    let b = buckets.get(key);
    if (!b) {
      b = { revenue: 0, count: 0 };
      buckets.set(key, b);
    }
    b.revenue += j.total || 0;
    b.count += 1;
  }

  for (const [serviceName, b] of Array.from(buckets.entries())) {
    await prisma.serviceTypeRevenue.create({
      data: { serviceName, revenue: b.revenue, jobCount: b.count, year },
    });
  }
}
