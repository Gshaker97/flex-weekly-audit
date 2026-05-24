import { prisma } from "./prisma";
import { fetchJobsInWeek, JobberJobNode } from "./jobber";

export function getCurrentWeekRange(reference: Date = new Date()) {
  const d = new Date(reference);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diffToMonday = (day + 6) % 7;
  const weekStart = new Date(d);
  weekStart.setDate(d.getDate() - diffToMonday);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 7);
  return { weekStart, weekEnd };
}

export function getPreviousWeekRange(reference: Date = new Date()) {
  const { weekStart } = getCurrentWeekRange(reference);
  const prevEnd = new Date(weekStart);
  const prevStart = new Date(weekStart);
  prevStart.setDate(prevStart.getDate() - 7);
  return { weekStart: prevStart, weekEnd: prevEnd };
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
  weekStart: Date;
  weekEnd: Date;
  triggeredBy?: "manual" | "cron";
}) {
  const audit = await prisma.audit.create({
    data: {
      weekStart: opts.weekStart,
      weekEnd: opts.weekEnd,
      status: "running",
      triggeredBy: opts.triggeredBy ?? "manual",
    },
  });

  try {
    const jobs = await fetchJobsInWeek(opts.weekStart, opts.weekEnd);

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
