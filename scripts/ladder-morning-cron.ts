/**
 * THE MORNING RUNNER for the whole past-due ladder.
 *
 * One run, once a day, in the 09:00 America/Phoenix window. It reads every open
 * invoice live, asks the evaluator who is genuinely due something today, asks
 * the planner what each one should get, and reports the answer.
 *
 * IT HAS NO SEND PATH, AND THAT IS DELIBERATE RIGHT NOW. This entrypoint
 * imports no credential, no transport and no dispatcher, so there is no mode,
 * flag or environment variable that makes it send a text or create a task. Two
 * things have to happen before a send-capable version is worth writing:
 *
 *   1. THE FACTS GUARD. Days 20, 25 and 30 declare required facts
 *      (`recurring_late_fee_policy`, `service_suspended`,
 *      `collections_after_day_35_policy`). The evaluator holds any milestone
 *      whose facts are unproven, so today every one of those rungs is held with
 *      `milestone_requires_unverified_facts` - a send-capable runner would send
 *      nothing on them anyway. That guard assumes the copy ASSERTS those facts.
 *      Ours deliberately does not: day 20 and 25 warn that fees may be added,
 *      and day 30 only claims a suspension when a suspension is proven. So the
 *      question is whether a fact the copy never claims should have to be
 *      proven at all. That is a decision about the guard, and it is the owner's,
 *      not this script's.
 *
 *   2. DEPLOYMENT. Nothing of this is deployed, nothing is scheduled, and the
 *      pending ledger migration has not run. The dispatcher's reservation - the
 *      thing that stops a customer being texted twice - depends on that
 *      migration.
 *
 * Until both are settled, this runner's job is to tell the truth about what
 * WOULD happen, which is also how the chain gets proven against real data
 * before it can touch a customer.
 *
 * WHAT IT NEVER PRINTS. No phone number, no email address, no contact id, no
 * customer name, no message text. Invoice numbers, day numbers, actions and
 * hold reasons only. Destinations are resolved in memory, counted, and dropped.
 *
 * Default-off: runs only when FLEXX_LADDER_MODE is exactly "plan".
 * Pass --ignore-window for a manual review outside the morning window.
 */
import { prisma } from "../lib/prisma";
import {
  evaluateReminders, summarizeReminderEvaluation, withinArizonaWindow, phoenixParts,
  type SendChannel,
} from "../lib/reminder-evaluation";
import { createReminderEvaluationReaders } from "../lib/reminder-evaluation-readers";
import { COLLECTIONS_SINCE } from "../lib/lateInvoices";
import { planLadderDay, type LadderStepInput } from "../lib/notification-ladder-plan";
import {
  ladderDelivery, ladderMilestoneIsCustomerMessage, LADDER_SMS_SENDER,
  LADDER_CUSTOMER_MESSAGE_DAYS, LADDER_INTERNAL_TASK_DAYS, ladderCustomerChannels,
} from "../lib/notification-ladder-sender-policy";
import { planDailyReminders } from "../lib/reminder-daily-plan";
import type { Day15TermsEvidence } from "../lib/notification-day15-pilot";

const TAG = "[ladder-morning]";

/**
 * Every homeowner rung is one text AND one email, so both channels are declared
 * at every rung (owner's decision, 2026-11-24). Internal day 21 already was.
 *
 * This keys the prior-send check against the LEGACY workflow's messages. It
 * does not decide what the ladder delivers - `ladderDelivery()` does - but the
 * two must agree, so it is read from the same policy rather than inlined.
 *
 * ONE CONSEQUENCE WORTH KNOWING. The legacy workflow only ever sent texts. At a
 * rung where a legacy text already went out, the sms half is suppressed and the
 * email half stays eligible, so the pair is completed rather than repeated. The
 * customer does not get the same words twice on the same channel.
 */
const MILESTONE_CHANNELS = (step: { dayPastDue: number; audience: string }): readonly SendChannel[] =>
  step.audience === "internal" ? ["email", "sms"] : [...ladderCustomerChannels(step.dayPastDue)];

function configuredExclusions(): string[] | null {
  const raw = process.env.FLEXX_REMINDER_VERIFIED_EXCLUSIONS;
  if (typeof raw !== "string" || !raw.trim()) return null;
  return raw.split(",").map(value => value.trim()).filter(Boolean);
}

/**
 * The written policy, as evidence that a fee MAY apply. Supplied from the
 * environment rather than pinned, because it is a statement about a document
 * that exists outside this repository; without it day 15 plans nothing.
 */
function writtenPolicyEvidence(): Day15TermsEvidence | null {
  const ref = process.env.FLEXX_LATE_FEE_POLICY_REF;
  const from = process.env.FLEXX_LATE_FEE_POLICY_EFFECTIVE_FROM;
  const excerpt = process.env.FLEXX_LATE_FEE_POLICY_EXCERPT;
  if (!ref?.trim() || !from?.trim() || !excerpt?.trim()) return null;
  return {
    source: "company-late-fee-policy", policyRef: ref.trim(), effectiveFrom: from.trim(),
    termsExcerpt: excerpt, statesLateFee: true,
    observedAt: new Date().toISOString(), evidenceRef: `env:${ref.trim()}`,
  };
}

/** Angie's GoHighLevel user id is an account identifier, so it is never in git. */
function internalAssignee() {
  const userId = process.env.FLEXX_LADDER_INTERNAL_ASSIGNEE_ID;
  const name = process.env.FLEXX_LADDER_INTERNAL_ASSIGNEE_NAME;
  const approvalRef = process.env.FLEXX_LADDER_INTERNAL_ASSIGNEE_APPROVAL_REF;
  return userId?.trim() && name?.trim() && approvalRef?.trim()
    ? { userId: userId.trim(), displayName: name.trim(), approvalRef: approvalRef.trim() }
    : null;
}

async function main() {
  const mode = process.env.FLEXX_LADDER_MODE;
  if (mode !== "plan") {
    console.log(`${TAG} disabled (FLEXX_LADDER_MODE=${mode ?? "unset"}); nothing read, nothing planned`);
    return;
  }
  const ignoreWindow = process.argv.includes("--ignore-window");
  const now = new Date();
  const parts = phoenixParts(now);
  const today = parts?.date ?? null;
  console.log(`${TAG} phoenix=${today} ${String(parts?.hour).padStart(2, "0")}:${String(parts?.minute).padStart(2, "0")} ` +
    `inWindow=${withinArizonaWindow(now)} ignoreWindow=${ignoreWindow}`);
  console.log(`${TAG} ladder: texts on days ${LADDER_CUSTOMER_MESSAGE_DAYS.join(", ")}; ` +
    `internal tasks on days ${LADDER_INTERNAL_TASK_DAYS.join(", ")}`);
  console.log(`${TAG} sender approved: ${LADDER_SMS_SENDER.approvalRef}`);
  if (!today) { console.log(`${TAG} no Phoenix date; nothing planned`); return; }

  // Same scope the collections view uses: the cache chooses WHICH invoices to
  // look at, never what is true about them.
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
  console.log(`${TAG} candidates: ${candidates.length}`);

  // Destinations are held here and nowhere else: in memory, for this run only.
  const destinations = new Map<string, { contactId: string; phone: string | null }>();
  const evaluation = await evaluateReminders({
    candidates,
    readers: createReminderEvaluationReaders(),
    now,
    verifiedExclusions: configuredExclusions(),
    ignoreWindow,
    milestoneChannels: MILESTONE_CHANNELS,
    onDestinationResolved: detail =>
      destinations.set(detail.jobberInvoiceId, { contactId: detail.contactId, phone: detail.phone }),
  });
  console.log(`${TAG} evaluation ${JSON.stringify(summarizeReminderEvaluation(evaluation))}`);
  for (const note of evaluation.notes) console.log(`${TAG} note: ${note}`);
  console.log(`${TAG} destinations resolved: ${destinations.size} of ${candidates.length}`);

  // ONE PAIR PER CUSTOMER PER DAY. The reservation gate refuses two milestones
  // for one contact on one day outright (`simultaneous_contact_event_conflict`),
  // which would leave a customer with three overdue invoices getting NOTHING.
  // So the choice of which invoice carries the day's pair is made here, by the
  // module that exists for it: furthest-along rung, then longest overdue, then
  // lowest invoice number. It only ever removes rows the evaluator already
  // called eligible - it can never create a send.
  const daily = planDailyReminders({
    rows: evaluation.rows,
    candidates: candidates.map(c => ({
      jobberInvoiceId: c.jobberInvoiceId, jobberClientId: c.jobberClientId,
      clientName: c.clientName, invoiceNumber: c.invoiceNumber,
    })),
    phoenixDate: today,
  });
  const carriesTodaysPair = new Set<string>();
  for (const customer of daily.customers) {
    for (const pick of customer.picks) carriesTodaysPair.add(pick.jobberInvoiceId);
  }
  console.log(`${TAG} daily cap: ${daily.customersWithASend} customers with a send, `
    + `${daily.smsPicked} texts, ${daily.emailPicked} emails, ${daily.droppedToCap} dropped to the cap`);
  for (const customer of daily.customers) {
    for (const drop of customer.drops) {
      console.log(`${TAG} capped   #${drop.invoiceNumber ?? "?"} ${drop.channel}: ${drop.reason}`);
    }
  }

  const terms = writtenPolicyEvidence();
  const assignee = internalAssignee();
  console.log(`${TAG} written late-fee policy evidence: ${terms ? "supplied" : "ABSENT (day 15 will hold)"}`);
  console.log(`${TAG} internal assignee: ${assignee ? "configured" : "ABSENT (days 21 and 35 will hold)"}`);

  // ----- turn the evaluation into ladder steps -------------------------------
  const steps: LadderStepInput[] = [];
  const skipped: string[] = [];
  for (const row of evaluation.rows) {
    if (row.decision !== "eligible") continue;
    // The category decides which ladder applies, so an unrecognised one is
    // skipped rather than defaulted to maintenance - irrigation has fewer rungs.
    const category = row.category === "maintenance" || row.category === "irrigation" ? row.category : null;
    if (row.milestoneDay == null || !category) {
      skipped.push(`#${row.invoiceNumber ?? "?"} eligible but no milestone or usable category resolved` +
        (row.category ? ` (category=${row.category})` : ""));
      continue;
    }
    // Held back by the one-pair-per-customer-per-day cap.
    if (row.audience !== "internal" && !carriesTodaysPair.has(row.jobberInvoiceId)) {
      skipped.push(`#${row.invoiceNumber ?? "?"} eligible but another invoice carries this customer's pair today`);
      continue;
    }
    const delivery = ladderDelivery(row.milestoneDay);
    if (!delivery) {
      skipped.push(`#${row.invoiceNumber ?? "?"} day ${row.milestoneDay} is not a ladder rung`);
      continue;
    }
    const destination = destinations.get(row.jobberInvoiceId) ?? null;
    steps.push({
      dayPastDue: row.milestoneDay,
      category,
      // An eligible row is today's milestone by definition; the planner checks
      // this against its own run date rather than taking it on trust.
      scheduledOn: today,
      today,
      invoiceId: row.jobberInvoiceId,
      invoiceNumber: row.invoiceNumber ?? "",
      balanceMinor: row.balanceCents ?? -1,
      currency: "USD",
      invoiceIssuedOn: row.sourceIssuedDate,
      jobberClientId: candidates.find(c => c.jobberInvoiceId === row.jobberInvoiceId)?.jobberClientId ?? "",
      homeownerContactId: destination?.contactId ?? null,
      assignee,
      holds: [],
      alreadySent: false,
      termsEvidence: row.milestoneDay === 15 ? terms : null,
      // Nothing in this system records a suspension, so day 30 plans the
      // conditional words. That is the correct body, not a fallback.
      suspensionEvidence: null,
    });
  }

  const plan = planLadderDay(steps, today);
  console.log(`\n${TAG} ===== what the ladder would do today =====`);
  console.log(`${TAG} ${JSON.stringify(plan.summary)}`);
  for (let index = 0; index < plan.actions.length; index += 1) {
    const action = plan.actions[index];
    const step = steps[index];
    const label = `#${step.invoiceNumber || "?"} day ${step.dayPastDue} ${step.category}`;
    if (action.kind === "send_message") {
      console.log(`${TAG} TEXT+EMAIL ${label} claims=[${action.claims.join(",")}]`
        + ` chars=${action.body.length} channels=[${action.channels.join(",")}]`
        + ` subject="${action.email.subject}" sameWords=${action.email.body === action.body}`);
    } else if (action.kind === "create_task") {
      console.log(`${TAG} TASK     ${label} ${action.taskKind}`);
    } else if (action.kind === "hold") {
      console.log(`${TAG} hold     ${label} [${action.reasons.join("; ")}]`);
    } else {
      console.log(`${TAG} not due  ${label} (${action.reason})`);
    }
  }
  for (const line of skipped) console.log(`${TAG} skipped  ${line}`);
  if (plan.holdReasons.length) console.log(`${TAG} hold reasons today: ${plan.holdReasons.join(", ")}`);

  // ----- why the rest of the ladder is quiet --------------------------------
  const heldRows = evaluation.rows.filter(row => row.decision === "held");
  const byReason = new Map<string, number>();
  for (const row of heldRows) {
    for (const hold of row.holds) {
      const key = hold.split(":")[0];
      byReason.set(key, (byReason.get(key) ?? 0) + 1);
    }
  }
  if (byReason.size) {
    console.log(`\n${TAG} ===== why the evaluator held ${heldRows.length} invoices =====`);
    for (const [reason, count] of [...byReason].sort((a, b) => b[1] - a[1])) {
      console.log(`${TAG} ${String(count).padStart(3)}  ${reason}`);
    }
  }

  // ----- is Jobber (plus GHL) enough to pick a ladder? ----------------------
  // `categoryEvidence` is labels only - the resolver guarantees it carries no
  // contact details - so it is safe to aggregate and print here.
  const serviceRows = heldRows.filter(row => row.holds.some(hold => hold.startsWith("service_type_")));
  if (serviceRows.length) {
    const jobberVocab = new Map<string, number>();
    const ghlVocab = new Map<string, number>();
    let withGhlLabels = 0, withJobberLabels = 0, ghlSaysIrrigation = 0, jobberSaysIrrigation = 0;
    const bySource = new Map<string, number>();
    for (const row of serviceRows) {
      bySource.set(row.categorySource ?? "null", (bySource.get(row.categorySource ?? "null") ?? 0) + 1);
      let evidence: { jobber?: string[]; ghl?: string[] } = {};
      try { evidence = JSON.parse(row.categoryEvidence ?? "{}"); } catch { /* unreadable */ }
      const jobber = Array.isArray(evidence.jobber) ? evidence.jobber : [];
      const ghl = Array.isArray(evidence.ghl) ? evidence.ghl : [];
      if (jobber.length) withJobberLabels += 1;
      if (ghl.length) withGhlLabels += 1;
      if (jobber.some(label => /irrigation/i.test(label))) jobberSaysIrrigation += 1;
      if (ghl.some(label => /irrigation/i.test(label))) ghlSaysIrrigation += 1;
      for (const label of jobber) jobberVocab.set(label, (jobberVocab.get(label) ?? 0) + 1);
      for (const label of ghl) ghlVocab.set(label, (ghlVocab.get(label) ?? 0) + 1);
    }
    console.log(`\n${TAG} ===== can Jobber and GoHighLevel pick the ladder? =====`);
    console.log(`${TAG} ${serviceRows.length} invoice(s) held on service type: ` +
      [...bySource].map(([source, count]) => `${source}=${count}`).join(" "));
    console.log(`${TAG} with a Jobber label: ${withJobberLabels}/${serviceRows.length}` +
      ` (irrigation: ${jobberSaysIrrigation})`);
    console.log(`${TAG} with ANY GoHighLevel tag: ${withGhlLabels}/${serviceRows.length}` +
      ` (irrigation: ${ghlSaysIrrigation})`);
    console.log(`${TAG} Jobber labels seen:`);
    for (const [label, count] of [...jobberVocab].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.log(`${TAG}   ${String(count).padStart(3)}  ${label}`);
    }
    console.log(`${TAG} GoHighLevel tags seen:${ghlVocab.size ? "" : " (none at all)"}`);
    for (const [label, count] of [...ghlVocab].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.log(`${TAG}   ${String(count).padStart(3)}  ${label}`);
    }
    if (withGhlLabels === 0) {
      console.log(`${TAG} VERDICT: GoHighLevel carries no service tags on any of these contacts, so ` +
        `"corroborated by GHL" can never be satisfied. Either Jobber alone decides, or the ladder ` +
        `never runs for these invoices.`);
    }
  }

  const facts = heldRows.filter(row =>
    row.holds.some(hold => hold.startsWith("milestone_requires_unverified_facts")));
  if (facts.length) {
    console.log(`\n${TAG} ${facts.length} invoice(s) are held ONLY by the facts guard on days ` +
      `${[...new Set(facts.map(row => row.milestoneDay))].filter(day => day != null).join(", ")}. ` +
      `Our copy for those days does not assert the facts it is being asked to prove - see the ` +
      `header of this file. That is an owner decision, not a bug.`);
  }

  const messageDays = plan.actions.filter((action, index) =>
    action.kind === "send_message" && !ladderMilestoneIsCustomerMessage(steps[index].dayPastDue));
  if (messageDays.length) {
    console.log(`${TAG} REFUSING TO REPORT A CLEAN RUN: ${messageDays.length} planned message(s) ` +
      `fall on a day the policy says is internal. This is a contradiction and must be looked at.`);
  }

  // Both halves of every pair, or neither. A planned message that somehow
  // declares one channel is the same class of contradiction as the above.
  const halfPairs = plan.actions.filter(action =>
    action.kind === "send_message" &&
    (action.channels.length !== 2 || action.email.body !== action.body));
  if (halfPairs.length) {
    console.log(`${TAG} REFUSING TO REPORT A CLEAN RUN: ${halfPairs.length} planned message(s) ` +
      `are not one text and one email with the same words. Must be looked at.`);
  }

  console.log(`\n${TAG} sends attempted: 0 (this runner has no send path)`);
  console.log(`${TAG} tasks created:   0 (this runner has no send path)`);
}

main()
  .then(async () => { await prisma.$disconnect(); process.exit(0); })
  .catch(async (err: any) => {
    console.error(`${TAG} failed:`, err?.stack ?? err?.message ?? err);
    await prisma.$disconnect();
    process.exit(1);
  });
