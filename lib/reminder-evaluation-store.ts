import { prisma } from "./prisma";
import type { ReminderEvaluationPlan } from "./reminder-evaluation";
import { summarizeReminderEvaluation } from "./reminder-evaluation";

/**
 * Records one evaluate-only run. Writes to the two ReminderEvaluation tables and
 * nothing else: no InvoiceRecord, no Customer, no SyncRun, no provider call.
 *
 * Every run is recorded, including an outside-window run that evaluated nothing,
 * so an absent record means the runner did not execute rather than that it found
 * nothing to do.
 */
export async function recordReminderEvaluation(plan: ReminderEvaluationPlan, startedAt: Date): Promise<string> {
  const summary = summarizeReminderEvaluation(plan);
  const run = await prisma.reminderEvaluationRun.create({
    data: {
      mode: plan.mode,
      phoenixDate: plan.phoenixDate ?? "unknown",
      state: plan.state,
      startedAt,
      completedAt: new Date(),
      candidates: summary.candidates,
      eligible: summary.eligible,
      held: summary.held,
      exclusionsVerified: plan.exclusionsVerified,
      sendsAttempted: plan.sendsAttempted,
      notes: plan.notes.length ? plan.notes.join(" | ").slice(0, 2000) : null,
      rows: {
        create: plan.rows.map(row => ({
          jobberInvoiceId: row.jobberInvoiceId,
          invoiceNumber: row.invoiceNumber,
          clientName: row.clientName,
          category: row.category,
          categorySource: row.categorySource,
          categoryEvidence: row.categoryEvidence?.slice(0, 1000) ?? null,
          daysPastDue: row.daysPastDue,
          balanceCents: row.balanceCents,
          milestoneDay: row.milestoneDay,
          audience: row.audience,
          decision: row.decision,
          holds: row.holds.join(" | ").slice(0, 2000),
        })),
      },
    },
    select: { id: true },
  });
  return run.id;
}
