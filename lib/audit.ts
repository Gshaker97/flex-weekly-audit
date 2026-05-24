import { prisma } from "./prisma";
import { fetchJobsInRange, JobberJobNode } from "./jobber";

export type RangePreset = "ytd" | "last30" | "thisWeek" | "lastWeek" | "last90";

export function getRange(preset: RangePreset, reference: Date = new Date()) {
  const now = new Date(reference);

  if (preset === "ytd") {
    const start = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    return { start, end, label: `Year to date (${now.getFullYear()})` };
  }

  if (preset === "last30") {
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    const start = new Date(now);
    start.setDate(start.getDate() - 30);
    start.setHours(0, 0, 0, 0);
    return { start, end, label: "Last 30 days" };
  }

  if (preset === "last90") {
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    const start = new Date(now);
    start.setDate(start.getDate() - 90);
    start.setHours(0, 0, 0, 0);
    return { start, end, label: "Last 90 days" };
  }

  if (preset === "thisWeek") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    const day = d.getDay();
    const diffToMonday = (day + 6) % 7;
    const start = new Date(d);
    start.setDate(d.getDate() - diffToMonday);
    const end = new Date(start);
    end.setDate(start.getDate() + 7);
    return { start, end, label: "This week" };
  }

  // lastWeek
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diffToMonday = (day + 6) % 7;
  const thisMonday = new Date(d);
  thisMonday.setDate(d.getDate() - diffToMonday);
  const start = new Date(thisMonday);
  start.setDate(start.getDate() - 7);
  const end = new Date(thisMonday);
  return { start, end, label: "Last week" };
}

export function getCurrentWeekRange(reference: Date = new Date()) {
  const r = getRange("thisWeek", reference);
  return { weekStart: r.start, weekEnd: r.end };
}

export function getPreviousWeekRange(reference: Date = new Date()) {
  const r = getRange("lastWeek", reference);
  return { weekStart: r.start, weekEnd: r.end };
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

function classifyJob(job: JobberJobNode) {
  const completed = isCompletedStatus(job.jobStatus) || Boolean(job.completedAt);
  const hasInvoice = (job.invoices?.nodes?.length ?? 0) > 0;
  const reasons: string[] = [];
  if (!completed) reasons.push("Not marked complete");
  if (!hasInvoice) reasons.push("No invoice attached");
  return { completed, hasInvoice, reasons };
}

export async function runAudit(opts: {
  rangeStart: Date;
  rangeEnd: Date;
  triggeredBy?: "manual" | "cron";
}) {
  const audit = await prisma.audit.create({
    data: {
      weekStart: opts.rangeStart,
      weekEnd: opts.rangeEnd,
      status: "running",
      triggeredBy: opts.triggeredBy ?? "manual",
    },
  });

  try {
    const jobs = await fetchJobsInRange(opts.rangeStart, opts.rangeEnd);

    let completedCount = 0;
    let invoicedCount = 0;
    const flagged: any[] = [];

    for (const job of jobs) {
      const { completed, hasInvoice, reasons } = classifyJob(job);
      if (completed) completedCount += 1;
      if (hasInvoice) invoicedCount += 1;

      if (reasons.length > 0) {
        const clientName =
          job.client?.companyName ||
          job.client?.name ||
          "Unknown client";
        const invoiceNumber =
          job.invoices?.nodes?.[0]?.invoiceNumber ?? null;

        flagged.push({
          auditId: audit.id,
          jobberJobId: job.id,
          jobNumber: job.jobNumber != null ? String(job.jobNumber) : null,
          jobTitle: job.title ?? null,
          clientName,
          jobStatus: job.jobStatus ?? null,
          completedAt: job.completedAt ? new Date(job.completedAt) : null,
          scheduledEnd: job.endAt ? new Date(job.endAt) : null,
          totalAmount: job.total != null ? Number(job.total) : null,
          hasInvoice,
          invoiceNumber,
          flagReasons: reasons,
          jobberUrl: null,
        });
      }
    }

    if (flagged.length > 0) {
      await prisma.flaggedJob.createMany({ data: flagged });
    }

    const updated = await prisma.audit.update({
      where: { id: audit.id },
      data: {
        status: "complete",
        completedAt: new Date(),
        totalJobs: jobs.length,
        completedJobs: completedCount,
        invoicedJobs: invoicedCount,
        flaggedJobs: flagged.length,
      },
    });

    return updated;
  } catch (err: any) {
    await prisma.audit.update({
      where: { id: audit.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        errorMessage: err?.message ?? "Unknown error",
      },
    });
    throw err;
  }
}
