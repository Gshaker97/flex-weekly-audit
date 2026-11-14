// Evaluate-only reminder runner, for the 09:00 America/Phoenix window.
//
// It reports who would get a reminder and who would be held, and records the
// run. It sends nothing and writes nothing to GoHighLevel: this entrypoint
// imports no sender and no GHL write path, so there is no mode that makes it
// send. Going live would mean adding code, reviewed separately.
//
// Default-off. Runs only when FLEXX_REMINDER_EVALUATE_MODE is exactly
// "evaluate". Pass --ignore-window for a manual review outside 09:00.
import { prisma } from "../lib/prisma";
import { evaluateReminders, summarizeReminderEvaluation, withinArizonaWindow, phoenixParts,
  type SendChannel } from "../lib/reminder-evaluation";
import { createReminderEvaluationReaders } from "../lib/reminder-evaluation-readers";
import { recordReminderEvaluation } from "../lib/reminder-evaluation-store";
import { COLLECTIONS_SINCE } from "../lib/lateInvoices";

/**
 * Which channels a milestone uses. OBSERVED in the GoHighLevel "Fixed
 * Automation" workflow on 2026-11-13 - day 21 has both an email step and an
 * internal SMS step - and NOT approved policy. It is not pinned anywhere and it
 * cannot cause a send: this entrypoint has no send path. It exists only to key
 * duplicate suppression per channel, so an email already sent cannot cancel the
 * SMS and vice versa. Needs confirmation before any cutover.
 */
const MILESTONE_CHANNELS = (step: { dayPastDue: number; audience: string }): readonly SendChannel[] =>
  step.dayPastDue === 21 ? ["email", "sms"] : ["sms"];

/** Exactly two reviewed Jobber client IDs, comma separated. Anything else is unverified. */
function configuredExclusions(): string[] | null {
  const raw = process.env.FLEXX_REMINDER_VERIFIED_EXCLUSIONS;
  if (typeof raw !== "string" || !raw.trim()) return null;
  return raw.split(",").map(value => value.trim()).filter(Boolean);
}

async function main() {
  const startedAt = new Date();
  const mode = process.env.FLEXX_REMINDER_EVALUATE_MODE;
  if (mode !== "evaluate") {
    console.log(`[reminder-evaluate] disabled (FLEXX_REMINDER_EVALUATE_MODE=${mode ?? "unset"}); nothing read, nothing recorded`);
    return;
  }
  const ignoreWindow = process.argv.includes("--ignore-window");
  const now = new Date();
  const parts = phoenixParts(now);
  console.log(`[reminder-evaluate] phoenix=${parts?.date} ${String(parts?.hour).padStart(2, "0")}:${String(parts?.minute).padStart(2, "0")} ` +
    `inWindow=${withinArizonaWindow(now)} ignoreWindow=${ignoreWindow}`);

  // Same scope the dashboard's collections view uses. Without this the runner
  // also evaluates pre-2026 invoices — one observed owner has twelve going back
  // over 800 days — which costs a live source read each per day and can never
  // produce a milestone anyway.
  const cached = await prisma.invoiceRecord.findMany({
    where: {
      invoiceStatus: { in: ["awaiting_payment", "past_due"] },
      amountDue: { gt: 0 },
      issuedAt: { gte: COLLECTIONS_SINCE },
    },
    select: {
      jobberInvoiceId: true, invoiceNumber: true, clientName: true,
      customer: { select: { jobberClientId: true, email: true, phone: true } },
    },
  });
  const candidates = cached.map(row => ({
    jobberInvoiceId: row.jobberInvoiceId,
    invoiceNumber: row.invoiceNumber,
    clientName: row.clientName,
    jobberClientId: row.customer?.jobberClientId ?? null,
    email: row.customer?.email ?? null,
    phone: row.customer?.phone ?? null,
  }));

  const plan = await evaluateReminders({
    candidates,
    readers: createReminderEvaluationReaders(),
    now,
    verifiedExclusions: configuredExclusions(),
    ignoreWindow,
    milestoneChannels: MILESTONE_CHANNELS,
  });

  const runId = await recordReminderEvaluation(plan, startedAt);
  const summary = summarizeReminderEvaluation(plan);
  console.log(`[reminder-evaluate] run=${runId} ${JSON.stringify(summary)}`);
  for (const note of plan.notes) console.log(`[reminder-evaluate] note: ${note}`);

  // Decision lines carry invoice number and hold reasons only: no phone, no
  // email, no message text.
  for (const row of plan.rows) {
    if (row.decision === "not_due" && !row.holds.some(hold => hold.startsWith("past_milestones"))) continue;
    console.log(`[reminder-evaluate] #${row.invoiceNumber ?? "?"} ${row.decision}` +
      ` category=${row.category ?? "unresolved"}/${row.categorySource ?? "-"}` +
      ` dpd=${row.daysPastDue ?? "-"} milestone=${row.milestoneDay ?? "-"}` +
      (row.channels.length ? ` channels=[${row.channels.map(entry => `${entry.channel}:${entry.decision}`).join(",")}]` : "") +
      (row.holds.length ? ` holds=[${row.holds.join("; ")}]` : ""));
  }
  console.log(`[reminder-evaluate] sends attempted: ${plan.sendsAttempted} (this runner has no send path)`);
}

main()
  .then(async () => { await prisma.$disconnect(); process.exit(0); })
  .catch(async (err: any) => {
    console.error("[reminder-evaluate] failed:", err?.stack ?? err?.message ?? err);
    await prisma.$disconnect();
    process.exit(1);
  });
