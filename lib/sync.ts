import { prisma } from "./prisma";
import {
  fetchAllClients,
  fetchAllJobs,
  fetchAllInvoices,
  fetchAllJobTimesheets,
  fetchAllJobVisits,
  JobberJobNode,
  JobberClientNode,
  JobberInvoiceNode,
  FlatTimeEntry,
  FlatVisit,
  concatJobNotes,
} from "./jobber";
import {
  getInvoicePipelineRefs,
  findContactByEmail,
  createContact,
  searchOpportunities,
  moveOpportunityToStage,
  createOpportunity,
  GhlOpportunity,
  InvoicePipelineRefs,
} from "./ghl";
import { log, logError } from "./log";

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
const DB_BATCH_SIZE = 10;
async function inBatches<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  size = DB_BATCH_SIZE
): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
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
  opts: { triggeredBy?: "manual" | "cron"; full?: boolean } = {}
) {
  // Decide full vs incremental. Incremental pulls only records modified since
  // the last successful sync (with a 24h overlap for safety). We force a full
  // sync when there's no prior sync, when the last full sync is over 7 days
  // old (a weekly reconcile to catch anything incremental missed), or when
  // explicitly requested.
  const lastComplete = await prisma.syncRun.findFirst({
    where: { status: "complete" },
    orderBy: { completedAt: "desc" },
  });
  const lastFull = await prisma.syncRun.findFirst({
    where: { status: "complete", mode: "full" },
    orderBy: { completedAt: "desc" },
  });
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const fullStale =
    !lastFull ||
    !lastFull.completedAt ||
    Date.now() - new Date(lastFull.completedAt).getTime() > WEEK_MS;
  const doFull = Boolean(opts.full) || !lastComplete || fullStale;
  const since =
    doFull || !lastComplete
      ? null
      : new Date(new Date(lastComplete.startedAt).getTime() - 24 * 60 * 60 * 1000);
  const mode = doFull ? "full" : "incremental";
  log(`[sync] mode=${mode}${since ? ` since=${since.toISOString()}` : ""}`);

  const run = await prisma.syncRun.create({
    data: {
      status: "running",
      triggeredBy: opts.triggeredBy ?? "manual",
      mode,
    },
  });

  try {
    const clientNodes = await fetchAllClients(since);
    await upsertClients(clientNodes);
    await prisma.syncRun.update({
      where: { id: run.id },
      data: { customersFetched: clientNodes.length },
    });

    const jobNodes = await fetchAllJobs(since);
    await upsertJobs(jobNodes);
    await prisma.syncRun.update({
      where: { id: run.id },
      data: { jobsFetched: jobNodes.length },
    });

    const invoiceNodes = await fetchAllInvoices(since);
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

    // Visits are best-effort too. Drives the visit-level Overdue/Uninvoiced tabs.
    log("[sync] step: visits");
    try {
      const visits = await fetchAllJobVisits(since);
      await upsertVisits(visits);
      await prisma.syncRun.update({
        where: { id: run.id },
        data: { visitsFetched: visits.length },
      });
    } catch (err: any) {
      logError("Visit sync failed (continuing):", err?.message ?? err);
    }

    // Stamp the "No Invoice" note flag onto visits so the Uninvoiced Revenue
    // metric excludes intentionally-uninvoiced jobs and all their visits.
    log("[sync] step: reconcileVisitNoInvoiceFlags");
    await reconcileVisitNoInvoiceFlags();

    log("[sync] step: recomputeCustomerAggregates");
    await recomputeCustomerAggregates();
    log("[sync] step: recomputeMonthlySnapshots");
    await recomputeMonthlySnapshots();
    log("[sync] step: recomputeServiceTypeRevenue");
    await recomputeServiceTypeRevenue();

    // Mirror invoices into the GHL "Invoice Pipeline" (Sent / Overdue / Paid /
    // Canceled by status). Best-effort: a GHL outage or missing config (no API
    // key, pipeline renamed) must not fail the whole Jobber sync.
    try {
      const ghlSynced = await syncGhlInvoicePipeline();
      await prisma.syncRun.update({
        where: { id: run.id },
        data: { ghlOpportunitiesSynced: ghlSynced },
      });
      log(`[sync] ghlInvoicePipeline: ${ghlSynced} invoices synced to GHL`);
    } catch (err: any) {
      logError("GHL invoice sync failed (continuing):", err?.message ?? err);
    }

    return await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        status: "complete",
        completedAt: new Date(),
      },
    });
  } catch (err: any) {
    await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        errorMessage: err?.message ?? "Unknown error",
      },
    });
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

// Build the opportunity name we use when creating an overdue-invoice card.
// Also used as a fallback match target (see matchesInvoice).
function opportunityName(inv: {
  invoiceNumber: string | null;
  clientName: string | null;
}): string {
  const num = inv.invoiceNumber ? `#${inv.invoiceNumber}` : "";
  const who = inv.clientName ? ` — ${inv.clientName}` : "";
  return `Invoice ${num}${who}`.trim();
}

// Match an existing GHL opportunity to an invoice on invoice number or title.
function matchesInvoice(
  opp: GhlOpportunity,
  inv: { invoiceNumber: string | null; clientName: string | null }
): boolean {
  const name = (opp.name ?? "").toLowerCase();
  if (!name) return false;
  const num = (inv.invoiceNumber ?? "").toLowerCase();
  if (num && name.includes(num)) return true;
  return name === opportunityName(inv).toLowerCase();
}

// For every overdue, unpaid invoice, ensure a GHL opportunity exists in the
// "Invoice Overdue" stage of the "Invoice Pipeline" — moving an existing card
// or creating a new one. Returns the number of invoices processed.
// GHL Invoice Pipeline stage names (matched case-insensitively against the
// pipeline's stages resolved at runtime).
const GHL_STAGE_SENT = "Invoice Sent";
const GHL_STAGE_OVERDUE = "Invoice Overdue";
const GHL_STAGE_PAID = "Invoice Paid";
const GHL_STAGE_CANCELED = "Invoice Canceled";

// Map a Jobber invoice to the GHL stage it belongs in (null = skip).
// Jobber's own statuses already distinguish sent (awaiting_payment) vs overdue
// (past_due); we also honour the dueAt fallback the spec describes.
function ghlStageForInvoice(
  inv: { invoiceStatus: string | null; dueAt: Date | null },
  now: Date
): string | null {
  const status = (inv.invoiceStatus ?? "").toLowerCase();
  if (!status || status === "draft") return null; // skip drafts
  if (status === "paid") return GHL_STAGE_PAID;
  if (status === "void" || status === "bad_debt") return GHL_STAGE_CANCELED;
  if (status === "past_due") return GHL_STAGE_OVERDUE;
  if (status === "awaiting_payment") {
    return inv.dueAt && inv.dueAt < now ? GHL_STAGE_OVERDUE : GHL_STAGE_SENT;
  }
  // Unknown status — fall back to the due date so nothing silently vanishes.
  if (inv.dueAt) return inv.dueAt < now ? GHL_STAGE_OVERDUE : GHL_STAGE_SENT;
  return null;
}

// Full GHL "Invoice Pipeline" sync: route every invoice to the stage matching
// its status (Sent / Overdue / Paid / Canceled), creating the GHL contact and
// opportunity when missing. Returns the number of invoices processed.
async function syncGhlInvoicePipeline(): Promise<number> {
  log('[ghl] starting invoice pipeline sync');

  // Resolving the pipeline + its stages is the most likely thing to fail
  // (network + config). Isolate it so a failure logs and skips cleanly.
  let refs: InvoicePipelineRefs;
  try {
    refs = await getInvoicePipelineRefs();
  } catch (err: any) {
    logError('[ghl] failed to resolve pipeline refs (skipping):', err?.message ?? err);
    return 0;
  }
  log('[ghl] pipeline resolved', refs.pipelineId, '| stages:', Object.keys(refs.stageIdByName).join(', '));

  const now = new Date();
  // Every invoice in the DB — the stage is derived from status, not the query.
  const invoices = await prisma.invoiceRecord.findMany({
    include: { customer: true },
  });
  log('[ghl] invoices in DB', invoices.length);

  let processed = 0;
  let created = 0;
  let moved = 0;
  let skipped = 0;
  let contactsCreated = 0;

  for (const inv of invoices) {
    const invId = inv.invoiceNumber ?? inv.jobberInvoiceId ?? inv.id;

    // Drafts (and unknown/dateless statuses) are skipped entirely.
    const stageName = ghlStageForInvoice(inv, now);
    if (!stageName) {
      skipped += 1;
      continue;
    }
    const stageId = refs.stageIdByName[stageName.toLowerCase()];
    if (!stageId) {
      skipped += 1;
      log(`[ghl] stage "${stageName}" not found in pipeline — skipping invoice ${invId}`);
      continue;
    }

    const email = inv.customer?.email;
    if (!email) {
      skipped += 1;
      log(`[ghl] no email for invoice ${invId} — skipping`);
      continue;
    }

    try {
      const found = await findContactByEmail(email);
      // findContactByEmail falls back to a fuzzy first hit, so only an EXACT
      // email match counts; otherwise create the contact with the right email.
      const exact =
        found && (found.email ?? "").toLowerCase() === email.toLowerCase();

      let contactId: string;
      if (exact) {
        contactId = found!.id;
      } else {
        const near = found ? ` (closest GHL email: ${found.email ?? "n/a"})` : " (no GHL match)";
        log(`[ghl] email not matched in GHL for invoice ${invId} email ${email}${near}`);
        const createdContact = await createContact({
          email,
          name: inv.customer?.name ?? inv.customer?.companyName ?? inv.clientName ?? null,
          phone: inv.customer?.phone ?? null,
        });
        contactsCreated += 1;
        contactId = createdContact.id;
      }

      const opps = await searchOpportunities(contactId, refs.pipelineId);
      const match = opps.find((o) => matchesInvoice(o, inv));

      if (match) {
        if (match.pipelineStageId !== stageId) {
          await moveOpportunityToStage(match.id, stageId);
          moved += 1;
        }
      } else {
        await createOpportunity({
          pipelineId: refs.pipelineId,
          pipelineStageId: stageId,
          contactId,
          name: opportunityName(inv),
          monetaryValue: inv.amountDue || inv.total || 0,
        });
        created += 1;
      }
      processed += 1;
    } catch (err: any) {
      // One bad invoice/contact shouldn't abort the rest.
      skipped += 1;
      logError(
        `[sync] ghlInvoicePipeline: invoice ${inv.invoiceNumber ?? inv.id} failed (continuing):`,
        err?.message ?? err
      );
    }
  }

  log(
    `[ghl] invoice pipeline sync summary — processed=${processed} created=${created} ` +
      `moved=${moved} skipped=${skipped} contactsCreated=${contactsCreated}`
  );
  return processed;
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

async function upsertVisits(visits: FlatVisit[]) {
  await inBatches(visits, async (v) => {
    const start = v.startAt ? new Date(v.startAt) : null;
    const end = v.endAt ? new Date(v.endAt) : null;
    const completed = v.completedAt ? new Date(v.completedAt) : null;
    // Effective date used for range filtering and overdue checks
    const visitDate = end ?? start ?? completed ?? null;
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
