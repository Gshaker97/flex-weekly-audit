import { prisma } from "./prisma";
import {
  fetchAllClients,
  fetchAllJobs,
  fetchAllInvoices,
  JobberJobNode,
  JobberClientNode,
  JobberInvoiceNode,
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

function isRecurringJobType(jobType: string | null | undefined) {
  if (!jobType) return false;
  const t = jobType.toLowerCase();
  return t.includes("recurring") || t === "recurring";
}

export async function runFullSync(opts: { triggeredBy?: "manual" | "cron" } = {}) {
  const run = await prisma.syncRun.create({
    data: {
      status: "running",
      triggeredBy: opts.triggeredBy ?? "manual",
    },
  });

  try {
    // 1. Fetch all clients
    const clientNodes = await fetchAllClients();
    await upsertClients(clientNodes);

    await prisma.syncRun.update({
      where: { id: run.id },
      data: { customersFetched: clientNodes.length },
    });

    // 2. Fetch all jobs
    const jobNodes = await fetchAllJobs();
    await upsertJobs(jobNodes);

    await prisma.syncRun.update({
      where: { id: run.id },
      data: { jobsFetched: jobNodes.length },
    });

    // 3. Fetch all invoices
    const invoiceNodes = await fetchAllInvoices();
    await upsertInvoices(invoiceNodes);

    await prisma.syncRun.update({
      where: { id: run.id },
      data: { invoicesFetched: invoiceNodes.length },
    });

    // 4. Compute customer aggregates
    await recomputeCustomerAggregates();

    // 5. Compute monthly snapshots
    await recomputeMonthlySnapshots();

    // 6. Compute service type revenue
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

    const completed = isCompletedStatus(j.jobStatus) || Boolean(j.completedAt);
    const recurring = isRecurringJobType(j.jobType);
    const invoiceNumber = j.invoices?.nodes?.[0]?.invoiceNumber ?? null;
    const hasInvoice = (j.invoices?.nodes?.length ?? 0) > 0;

    await prisma.jobRecord.upsert({
      where: { jobberJobId: j.id },
      create: {
        jobberJobId: j.id,
        jobNumber: j.jobNumber != null ? String(j.jobNumber) : null,
        title: j.title ?? null,
        jobStatus: j.jobStatus ?? null,
        jobType: j.jobType ?? null,
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
        jobType: j.jobType ?? null,
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
    // suppress unused var warning
    void completed;
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
  // Clear and rebuild
  await prisma.monthlySnapshot.deleteMany({});

  const now = new Date();
  const startYear = now.getFullYear() - 1; // 24 months back

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

  // Seed 24 months so empty months render as zero
  for (let y = startYear; y <= now.getFullYear(); y++) {
    const monthStart = y === startYear ? now.getMonth() + 1 : 1;
    const monthEnd = y === now.getFullYear() ? now.getMonth() + 1 : 12;
    for (let m = monthStart; m <= monthEnd; m++) {
      getOrInit(new Date(y, m - 1, 1));
    }
  }

  // Invoiced revenue (by issuedAt)
  const invoices = await prisma.invoiceRecord.findMany();
  for (const inv of invoices) {
    if (!inv.issuedAt) continue;
    const b = getOrInit(inv.issuedAt);
    b.invoicedRevenue += inv.total || 0;
    b.collectedRevenue += inv.amountPaid || 0;
  }

  // Jobs completed + job-value/recurring breakdowns (by completedAt)
  const jobs = await prisma.jobRecord.findMany();
  for (const j of jobs) {
    if (!j.completedAt) continue;
    const b = getOrInit(j.completedAt);
    b.jobsCompleted += 1;
    if (j.total > 0) b.jobValues.push(j.total);
    if (j.isRecurring) b.recurringRevenue += j.total || 0;
    else b.oneOffRevenue += j.total || 0;
  }

  // New customers (by createdAtJobber)
  const customers = await prisma.customer.findMany();
  for (const c of customers) {
    if (!c.createdAtJobber) continue;
    const b = getOrInit(c.createdAtJobber);
    b.newCustomers += 1;
  }

  // Write
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
