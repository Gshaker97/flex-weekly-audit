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
} from "./jobber";

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
  console.log(`[sync] mode=${mode}${since ? ` since=${since.toISOString()}` : ""}`);

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
      console.error("Timesheet sync failed (continuing):", err?.message ?? err);
    }

    // Visits are best-effort too. Drives the visit-level Overdue/Uninvoiced tabs.
    try {
      const visits = await fetchAllJobVisits(since);
      await upsertVisits(visits);
      await prisma.syncRun.update({
        where: { id: run.id },
        data: { visitsFetched: visits.length },
      });
    } catch (err: any) {
      console.error("Visit sync failed (continuing):", err?.message ?? err);
    }

    await recomputeCustomerAggregates();
    await recomputeMonthlySnapshots();
    await recomputeServiceTypeRevenue();

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
  for (const c of nodes) {
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
  }
}

async function upsertJobs(nodes: JobberJobNode[]) {
  for (const j of nodes) {
    let customerId: string | null = null;
    if (j.client?.id) {
      const existing = await prisma.customer.findUnique({
        where: { jobberClientId: j.client.id },
      });
      customerId = existing?.id ?? null;
    }

    const recurring = isRecurringJob(j);
    const invoiceNumber = j.invoices?.nodes?.[0]?.invoiceNumber ?? null;
    const hasInvoice = (j.invoices?.nodes?.length ?? 0) > 0;

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
        lastSyncedAt: new Date(),
      },
    });
  }
}

async function upsertInvoices(nodes: JobberInvoiceNode[]) {
  for (const inv of nodes) {
    let customerId: string | null = null;
    if (inv.client?.id) {
      const existing = await prisma.customer.findUnique({
        where: { jobberClientId: inv.client.id },
      });
      customerId = existing?.id ?? null;
    }

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
  }
}

async function upsertTimeEntries(entries: FlatTimeEntry[]) {
  for (const e of entries) {
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
  }
}

async function upsertVisits(visits: FlatVisit[]) {
  for (const v of visits) {
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
  }
}

async function recomputeCustomerAggregates() {
  const customers = await prisma.customer.findMany();
  for (const c of customers) {
    const jobs = await prisma.jobRecord.findMany({
      where: { customerId: c.id },
    });
    const totalRevenue = jobs.reduce((acc, j) => acc + (j.total || 0), 0);
    const isRecurring = jobs.some((j) => j.isRecurring);
    const lastJob = jobs
      .map((j) => j.completedAt || j.endAt)
      .filter(Boolean)
      .sort((a, b) => (b!.getTime() - a!.getTime()))[0] || null;

    await prisma.customer.update({
      where: { id: c.id },
      data: {
        totalRevenue,
        jobCount: jobs.length,
        isRecurring,
        lastJobAt: lastJob,
      },
    });
  }
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
