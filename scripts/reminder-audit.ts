// The reminder audit — "did anything slip through the cracks?"
//
// This is the companion to `day15-email-preflight.ts`, pointed the other way.
// The preflight looks FORWARD: if the reminder were live today, who would get
// one. This looks BACKWARD: for every invoice whose milestone has already
// passed, did a message go out — and if not, is there a reason on record, or did
// we simply never look?
//
// It is the condition for switching the GoHighLevel workflow off. Our own
// process is only trustworthy if a silent failure is visible the next morning.
//
// WHAT IT CANNOT PROVE, SAID UP FRONT AND REPEATED IN THE OUTPUT
//   `evaluateReminders` refuses to judge a past milestone at all — it holds with
//   `past_milestones_for_human_reconciliation ... (never replayed)`. So the audit
//   REPLAYS each milestone date, running the evaluation with the clock set to
//   09:05 Phoenix on the day that invoice actually hit its milestone. The
//   arithmetic then lands on the right day, but every fact it reads — balance,
//   consent, opt-out, contact, send history — is read LIVE, today. A consent
//   that arrived yesterday makes an old silence look like a gap; a consent
//   withdrawn yesterday makes an old gap look explained. The verdict is
//   therefore `held_explained_by_todays_hold`, never `correctly_held`.
//   Proving the decision as it stood on the day would need a stored per-run
//   record. The `ReminderEvaluationRun`/`Row` migrations were deliberately never
//   applied, so that evidence does not exist and this script does not invent it.
//
// READ-ONLY. It imports no sender, no dispatcher, no GoHighLevel write path and
// nothing that reserves in the ledger. The only ledger access is a SELECT. No
// Jobber write, no provider write, no row of our own. Making it send or repair
// anything would mean adding code.
//
// It prints invoice numbers and machine reasons only. No customer name, email,
// phone, address or contact id reaches the output, so a report can be pasted
// into a message or a ticket as it stands.
//
// USAGE
//   npx tsx scripts/reminder-audit.ts                  yesterday and today
//   npx tsx scripts/reminder-audit.ts --weekly         last 7 days + the whole backlog
//   npx tsx scripts/reminder-audit.ts --days=30        last 30 days of milestones
//   npx tsx scripts/reminder-audit.ts --backlog        every past milestone, any age
//   npx tsx scripts/reminder-audit.ts --as-of=2026-12-01   pretend today is that date
import { prisma } from "../lib/prisma";
import { evaluateReminders, type SendChannel } from "../lib/reminder-evaluation";
import { createReminderEvaluationReaders } from "../lib/reminder-evaluation-readers";
import { jobberGraphQL } from "../lib/jobber";
import { getMessageDeliveryStatus } from "../lib/ghl";
import { invoiceCalendarDate, addInvoiceCalendarDays } from "../lib/invoice-reminder-clock";
import { day15EmailAmountsArePositive, day15EmailIsWithheld, day15EmailIssueWindow } from "../lib/reminder-email-window";
import { readLinkedJobText, type LinkedJobsResult } from "../lib/reminder-job-notes-source";
import { classifyLinkedJobRework } from "../lib/reminder-rework-notes";
import {
  auditInvoice, summariseAudit, calendarDaysBetween, VERDICT_ORDER,
  type AuditSubject, type AuditChannelSubject, type AuditChannel, type AuditFinding,
} from "../lib/reminder-audit";

/**
 * Day 15 only. Day 10 and Day 21 are deliberately out of scope: they are owned
 * elsewhere and the standing instruction is to leave them alone. Auditing them
 * read-only would be harmless, but reporting on a ladder this script does not
 * model would invite a false "all clear" about it.
 */
const DAY = 15;
const CHANNELS: readonly AuditChannel[] = ["sms", "email"];
const MILESTONE_CHANNELS = (step: { dayPastDue: number }): readonly SendChannel[] =>
  step.dayPastDue === DAY ? ["email", "sms"] : [];

const SETTLED = new Set(["paid", "void", "bad_debt"]);
const OPEN = ["awaiting_payment", "past_due"];

/** Jobber reads must use the token that already exists. Refreshing it writes. */
const MIN_TOKEN_MINUTES = 8;

/**
 * Suppression reasons that mean a message DEMONSTRABLY went out — from the
 * legacy workflow or from us — rather than that we decided against one. These
 * must not be reported as holds: with an empty ledger they mean the customer was
 * messaged and we have no record of it, which is a records failure, not a
 * decision. Matched on prefix, like every other reason in this codebase.
 */
const MEANS_SOMETHING_WAS_SENT = [
  "already_sent_by_ghl", "already_sent_all_channels", "milestone_already_sent_on_another_channel",
];

function flag(name: string): string | null {
  const found = process.argv.find(arg => arg.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : null;
}

function resolveNow(): { now: Date; today: string; label: string } {
  const asOf = flag("as-of");
  if (!asOf) {
    const now = new Date();
    return { now, today: invoiceCalendarDate(now)!, label: "live clock" };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error("as_of_must_be_yyyy_mm_dd");
  const now = new Date(`${asOf}T16:05:00.000Z`);
  if (!Number.isFinite(now.getTime())) throw new Error("as_of_unparseable");
  return { now, today: asOf, label: `simulated 09:05 Phoenix on ${asOf}` };
}

/** 09:05 Phoenix on a given calendar date: inside the 09:00-09:15 send window. */
const phoenixMorning = (date: string) => new Date(`${date}T16:05:00.000Z`);

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

async function tokenMinutes(): Promise<number> {
  const auth = await prisma.jobberAuth.findFirst({ orderBy: { createdAt: "desc" }, select: { expiresAt: true } });
  if (!auth) throw new Error("no_jobber_auth_row");
  return Math.floor((auth.expiresAt.getTime() - Date.now()) / 60000);
}

type Picked = {
  jobberInvoiceId: string; invoiceNumber: string | null; clientName: string | null;
  paidAt: Date | null;
  customer: { jobberClientId: string | null; email: string | null; phone: string | null } | null;
};

async function main() {
  const { now, today, label } = resolveNow();
  const say = (line: string) => console.log("AUDIT: " + line);

  const weekly = process.argv.includes("--weekly");
  const backlog = process.argv.includes("--backlog") || weekly;
  const days = Number(flag("days") ?? (weekly ? 7 : 1));
  if (!Number.isSafeInteger(days) || days < 0 || days > 3650) throw new Error("days_out_of_range");

  const windowStart = addInvoiceCalendarDays(today, -days)!;
  const mode = weekly ? "WEEKLY" : "DAILY";

  const minutes = await tokenMinutes();
  if (minutes < MIN_TOKEN_MINUTES) {
    throw new Error(`jobber_token_coverage_too_short: ${minutes}m left; a read would refresh and write. Stopping.`);
  }

  say(`${mode} audit on ${today} (${label}); jobber token coverage ${minutes}m (no refresh, no write)`);
  say(`milestone window: ${windowStart} .. ${today}  (day ${DAY}, channels ${CHANNELS.join("+")})` +
    `${backlog ? " PLUS the whole unpaid backlog, any age" : ""}`);
  say("read-only: no send path, no ledger write, no provider write");

  // ---------------------------------------------------------------- selection
  // The cache picks WHO to read and nothing else; every fact that decides a
  // verdict is read live from Jobber below. A drifted cache can therefore make
  // the audit look at the wrong invoice, but never make it reach a wrong
  // conclusion about one it did look at. The selection is deliberately wide:
  // a due date is used only to narrow, and it is padded either side so a cache
  // that is a few days stale still catches the invoice.
  const PAD = 5;
  const dueFrom = new Date(`${addInvoiceCalendarDays(windowStart, -(DAY + PAD))}T00:00:00.000Z`);
  const dueTo = new Date(`${addInvoiceCalendarDays(today, -(DAY - PAD))}T23:59:59.999Z`);

  const inWindow = await prisma.invoiceRecord.findMany({
    where: { dueAt: { gte: dueFrom, lte: dueTo } },
    select: { jobberInvoiceId: true, invoiceNumber: true, clientName: true, paidAt: true,
      customer: { select: { jobberClientId: true, email: true, phone: true } } },
  });
  const backlogRows: Picked[] = backlog
    ? await prisma.invoiceRecord.findMany({
        where: { invoiceStatus: { in: OPEN }, amountDue: { gt: 0 } },
        select: { jobberInvoiceId: true, invoiceNumber: true, clientName: true, paidAt: true,
          customer: { select: { jobberClientId: true, email: true, phone: true } } },
      })
    : [];

  const picked = new Map<string, Picked>();
  for (const row of [...inWindow, ...backlogRows]) picked.set(row.jobberInvoiceId, row);
  say(`candidates to read: ${picked.size} (${inWindow.length} by due date in window, ` +
    `${backlogRows.length} open-unpaid backlog, overlap merged)`);

  // ------------------------------------------------------------- live Jobber
  const live = new Map<string, LinkedJobsResult>();
  for (const row of picked.values()) {
    live.set(row.jobberInvoiceId, await readLinkedJobText(row.jobberInvoiceId, jobberGraphQL));
  }

  // --------------------------------------------------------------- the ledger
  // Our own record of what we sent. SELECT only.
  let ledgerComplete = true;
  let ledgerRows: { invoiceId: string; dayPastDue: number; channel: string; state: string;
    providerMessageId: string | null }[] = [];
  try {
    ledgerRows = await prisma.notificationLedger.findMany({
      where: { dayPastDue: DAY, invoiceId: { in: [...picked.keys()] } },
      select: { invoiceId: true, dayPastDue: true, channel: true, state: true, providerMessageId: true },
    });
  } catch (error) {
    // An unreadable ledger must make every verdict inconclusive, not make every
    // unpaid invoice look like a miss.
    ledgerComplete = false;
    say(`ledger read FAILED: ${(error as Error).message.slice(0, 120)} — every verdict below is inconclusive`);
  }
  if (ledgerComplete) say(`ledger rows for day ${DAY} on these invoices: ${ledgerRows.length}`);

  const ledgerFor = (invoiceId: string, channel: string) =>
    ledgerRows.filter(row => row.invoiceId === invoiceId && row.channel === channel)
      .map(row => ({ state: row.state, providerMessageId: row.providerMessageId }));

  // --------------------------------------------- what the provider says became of them
  const delivery = new Map<string, { complete: boolean; status: string | null }>();
  const toCheck = ledgerRows.map(row => row.providerMessageId).filter((id): id is string => !!id);
  for (const id of new Set(toCheck)) delivery.set(id, await getMessageDeliveryStatus(id));
  if (toCheck.length) {
    const confirmed = [...delivery.values()].filter(entry => entry.complete).length;
    say(`provider delivery outcomes read: ${confirmed}/${delivery.size} (unreadable counts as unconfirmed)`);
  }

  // ------------------------------------------- which invoices are in scope, and why not
  type Skip = "settled_before_programme_or_unreadable" | "issued_before_programme"
    | "zero_or_unreadable_amount" | "withheld_by_name" | "excluded_warranty_or_no_charge"
    | "milestone_outside_the_window" | "source_unreadable";
  const skipped = new Map<Skip, string[]>();
  const note = (why: Skip, labelled: string) => {
    const list = skipped.get(why) ?? []; list.push(labelled); skipped.set(why, list);
  };

  /** milestone date -> the invoices that hit day 15 on it. */
  const byDate = new Map<string, Picked[]>();
  const milestoneOn = new Map<string, string>();

  for (const row of picked.values()) {
    const tag = `#${row.invoiceNumber ?? "?"}`;
    const facts = live.get(row.jobberInvoiceId)!;

    if (!facts.complete && !facts.invoiceStatus) { note("source_unreadable", tag); continue; }
    const status = (facts.invoiceStatus ?? "").toLowerCase();

    // The programme window and the carve-outs are the same rules the send path
    // uses. An invoice the send path would never touch is not a crack.
    const window = day15EmailIssueWindow(facts.issuedDate);
    if (window === "before_programme") { note("issued_before_programme", tag); continue; }
    if (window === "unusable_issue_date") { note("source_unreadable", tag); continue; }
    if (day15EmailIsWithheld(row.invoiceNumber)) { note("withheld_by_name", tag); continue; }

    const rework = classifyLinkedJobRework(facts);
    if (rework.verdict === "excluded") { note("excluded_warranty_or_no_charge", tag); continue; }
    // NOTE: `hold` is NOT skipped. An invoice held because its notes could not
    // be verified is exactly the kind of thing that sits unreviewed for weeks,
    // so it belongs in the audit as a hold, not outside it as an exclusion.

    const dueOn = invoiceCalendarDate(facts.dueDate);
    if (!dueOn) { note("source_unreadable", tag); continue; }
    const hits = addInvoiceCalendarDays(dueOn, DAY);
    if (!hits) { note("source_unreadable", tag); continue; }

    // In scope when the milestone is inside the window, or — with --backlog —
    // any past milestone on an invoice that is still open and still owed.
    const inSpan = hits >= windowStart && hits <= today;
    const isBacklog = backlog && hits < windowStart && OPEN.includes(status) && (facts.balanceCents ?? 0) > 0;
    if (!inSpan && !isBacklog) { note("milestone_outside_the_window", tag); continue; }

    const settled = SETTLED.has(status) || (facts.balanceCents ?? 0) <= 0;
    if (!settled && !OPEN.includes(status)) { note("source_unreadable", tag); continue; }

    const amounts = day15EmailAmountsArePositive(facts.totalCents, facts.balanceCents);
    // A settled invoice legitimately has no balance left, so the positive-amount
    // rule applies only while it is still open.
    if (!settled && !amounts.ok) { note("zero_or_unreadable_amount", tag); continue; }

    milestoneOn.set(row.jobberInvoiceId, hits);
    const list = byDate.get(hits) ?? []; list.push(row); byDate.set(hits, list);
  }

  const inScope = [...byDate.values()].reduce((sum, list) => sum + list.length, 0);
  say(`in scope: ${inScope} invoice(s) across ${byDate.size} milestone date(s)`);
  for (const [why, list] of [...skipped.entries()].sort((a, b) => b[1].length - a[1].length)) {
    say(`  not audited — ${why}: ${list.length}`);
  }

  // ------------------------------------------ replay each milestone date's decision
  // One evaluation per distinct milestone date, with the clock on that date, so
  // the milestone arithmetic lands on the right day. The facts are still live.
  type Decision = {
    holds: readonly string[];
    channels: readonly { channel: string; decision: string; reason: string | null }[];
    readable: boolean;
  };
  const decisions = new Map<string, Decision>();

  for (const [date, rows] of [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    let plan;
    try {
      plan = await evaluateReminders({
        candidates: rows.map(row => ({
          jobberInvoiceId: row.jobberInvoiceId, invoiceNumber: row.invoiceNumber, clientName: row.clientName,
          jobberClientId: row.customer?.jobberClientId ?? null,
          email: row.customer?.email ?? null, phone: row.customer?.phone ?? null,
        })),
        readers: createReminderEvaluationReaders(),
        now: phoenixMorning(date),
        verifiedExclusions: null,
        ignoreWindow: true,
        milestoneChannels: MILESTONE_CHANNELS,
        feeClaimFreeDay15: true,
        channelBlindMilestones: [],
        jobberOnlyDay15Email: true,
        priorSendIgnoresPreIssueMessages: true,
      });
    } catch (error) {
      // A whole date that could not be evaluated makes its invoices
      // inconclusive. It must never make them look clean.
      say(`  replay of ${date} FAILED: ${(error as Error).message.slice(0, 120)}`);
      for (const row of rows) decisions.set(row.jobberInvoiceId, { holds: [], channels: [], readable: false });
      continue;
    }
    for (const planRow of plan.rows) {
      decisions.set(planRow.jobberInvoiceId, {
        holds: planRow.holds.filter(hold => !hold.startsWith("exclusions_unverified")),
        channels: (planRow.channels ?? []).map(entry => ({
          channel: entry.channel, decision: entry.decision, reason: entry.reason ?? null })),
        readable: true,
      });
    }
    // An invoice the evaluator returned no row for is not a pass.
    for (const row of rows) {
      if (!decisions.has(row.jobberInvoiceId)) {
        decisions.set(row.jobberInvoiceId, { holds: [], channels: [], readable: false });
      }
    }
  }

  // ------------------------------------------------------------ build and judge
  const findings: AuditFinding[] = [];
  for (const rows of byDate.values()) {
    for (const row of rows) {
      const facts = live.get(row.jobberInvoiceId)!;
      const decision = decisions.get(row.jobberInvoiceId)!;
      const status = (facts.invoiceStatus ?? "").toLowerCase();
      const openNow = !facts.invoiceStatus ? null
        : SETTLED.has(status) || (facts.balanceCents ?? 0) <= 0 ? false
        : OPEN.includes(status) ? true : null;

      const invoiceHolds = decision.holds.filter(hold =>
        !MEANS_SOMETHING_WAS_SENT.some(prefix => hold.startsWith(prefix)));
      const sentPerHolds = decision.holds.some(hold =>
        MEANS_SOMETHING_WAS_SENT.some(prefix => hold.startsWith(prefix)));

      const channels: AuditChannelSubject[] = CHANNELS.map(channel => {
        const entry = decision.channels.find(item => item.channel === channel);
        let expectation: AuditChannelSubject["expectation"];
        let suppressedReason: string | null = null;

        if (!decision.readable) {
          expectation = "unknown";
        } else if (entry) {
          expectation = entry.decision === "eligible" ? "eligible" : "suppressed";
          suppressedReason = entry.decision === "eligible" ? null : (entry.reason ?? null);
        } else if (decision.channels.length === 0 && invoiceHolds.length === 0 && !sentPerHolds) {
          // The evaluator produced neither a channel decision nor a reason.
          // That is unexplained, so it is inconclusive — not eligible, which
          // would read as a miss, and not suppressed, which would read as fine.
          expectation = "unknown";
        } else {
          // Channels were computed and this one is absent, or invoice-level
          // holds stopped the evaluation before channels were reached. The
          // invoice-level holds carry the reason.
          expectation = invoiceHolds.length ? "eligible" : "unknown";
        }

        const rows2 = ledgerFor(row.jobberInvoiceId, channel);
        const providerShown = sentPerHolds ||
          (suppressedReason !== null &&
            MEANS_SOMETHING_WAS_SENT.some(prefix => suppressedReason!.startsWith(prefix)));
        // A reason that says a message already went out is evidence of a SEND,
        // not a reason not to have sent. Reclassify it so it can never be
        // reported as a tidy hold.
        if (providerShown && suppressedReason &&
            MEANS_SOMETHING_WAS_SENT.some(prefix => suppressedReason!.startsWith(prefix))) {
          expectation = "eligible";
          suppressedReason = null;
        }

        const records = rows2
          .map(entry2 => entry2.providerMessageId)
          .filter((id): id is string => !!id)
          .map(id => ({ providerMessageId: id, status: delivery.get(id)?.status ?? null }));
        const deliveryComplete = rows2
          .map(entry2 => entry2.providerMessageId)
          .filter((id): id is string => !!id)
          .every(id => delivery.get(id)?.complete === true);

        return { channel, expectation, suppressedReason, ledger: rows2,
          delivery: records, deliveryComplete, providerShowsOurMessage: providerShown };
      });

      const subject: AuditSubject = {
        invoiceId: row.jobberInvoiceId,
        invoiceNumber: row.invoiceNumber,
        milestoneDay: DAY,
        milestoneOn: milestoneOn.get(row.jobberInvoiceId) ?? null,
        openNow,
        balanceCents: facts.balanceCents,
        paidOn: row.paidAt ? invoiceCalendarDate(row.paidAt) : null,
        // Deduplicated: the evaluator reports one hold per ambiguous message, so
        // the same reason can arrive several times for one invoice.
        invoiceHolds: [...new Set(invoiceHolds.map(hold => hold.split(":")[0]))],
        holdsComplete: decision.readable,
        ledgerComplete,
        channels,
      };
      findings.push(...auditInvoice(subject, today));
    }
  }

  // ------------------------------------------------------------------- report
  const summary = summariseAudit(findings, today);

  console.log("");
  say(`================ ${mode} AUDIT, ${today} ================`);
  if (!summary.reconciliation.ok) {
    say(`RECONCILIATION FAILED: ${summary.reconciliation.counted} counted vs ` +
      `${summary.reconciliation.findings} findings. This report is not trustworthy.`);
  }

  if (summary.total === 0) {
    say("no invoice reached day 15 in this window, so there is nothing to audit.");
    say("that is not the same as 'the reminder works'. It means nothing was due.");
  } else if (summary.clean) {
    say(`CLEAN: ${summary.total} invoice-channel(s) checked, nothing needs attention.`);
  } else {
    say(`NEEDS ATTENTION: ${summary.attention.length} of ${summary.total} invoice-channel(s).`);
    console.log("");
    say("---- look at these, worst first ----");
    for (const finding of summary.attention) {
      say(`  ${finding.verdict.toUpperCase()}  #${finding.invoiceNumber ?? "?"} ${finding.channel}` +
        `  ${finding.balanceCents === null ? "balance unknown" : money(finding.balanceCents)}` +
        `  day ${finding.milestoneDay} on ${finding.milestoneOn ?? "?"}` +
        `${finding.ageDays === null ? "" : ` (${finding.ageDays}d ago)`}`);
      say(`      ${finding.reason}`);
    }
  }

  console.log("");
  say("---- every invoice-channel, one bucket each ----");
  for (const entry of summary.counts) {
    say(`  ${entry.verdict}: ${entry.count}${entry.balanceCents ? `  ${money(entry.balanceCents)}` : ""}`);
  }
  say(`  TOTAL ${summary.reconciliation.counted} of ${summary.total} (must match)`);

  if (summary.holds.length) {
    console.log("");
    say("---- holds, by reason: decisions, not failures ----");
    say("  (recomputed TODAY. Today's hold is not proof of the hold on the day.)");
    for (const group of summary.holds) {
      say(`  ${group.reason}: ${group.invoices.length} invoice(s), ${group.count} message(s) not sent` +
        `  ${money(group.balanceCents)}` +
        `${group.oldestAgeDays === null ? "" : `  oldest ${group.oldestAgeDays}d`}`);
      say(`      ${group.invoices.slice(0, 12).join(" ")}${group.invoices.length > 12 ? ` +${group.invoices.length - 12} more` : ""}`);
    }
    if (weekly) {
      console.log("");
      say("  A hold that is weeks old is not working as designed. Each of these is");
      say("  a customer nobody has chased and nobody has decided about.");
    }
  }

  console.log("");
  say("---- what this audit can and cannot tell you ----");
  say("  CAN: whether a message exists for every invoice past its milestone, what");
  say("       the provider says became of it, and which gaps nothing explains.");
  say("  CANNOT: what was true on the milestone day. Holds are recomputed today.");
  say("  CANNOT: that a delivered message was read, or that it was the right copy.");
  if (!ledgerComplete) say("  THIS RUN: the ledger could not be read, so every verdict is inconclusive.");
  const missed = findings.filter(finding => finding.verdict === "missed_no_explanation").length;
  const distinctMissed = new Set(findings
    .filter(finding => finding.verdict === "missed_no_explanation")
    .map(finding => finding.invoiceNumber ?? "?")).size;
  console.log("");
  if (missed === 0) {
    say("MISSED WITH NO EXPLANATION: 0. Nothing fell through the cracks in this window.");
  } else if (ledgerComplete && ledgerRows.length === 0) {
    // The single most misleading thing this report could do is cry failure at a
    // system that has never run. With an empty ledger there is nothing a miss
    // could be measured against, so say so before the number is read as a
    // regression. Once the sender is live this branch stops applying by itself.
    say(`BACKLOG, NOT A FAILURE: ${missed} invoice-channel(s) across ${distinctMissed} invoice(s).`);
    say("  The ledger is EMPTY — this reminder has never sent anything, so nothing");
    say("  was missed by a running system. These are the invoices it would have");
    say("  covered, and they are the backlog that exists on day one.");
    say("  Once the sender is live, a number here means a real silent failure.");
  } else {
    say(`MISSED WITH NO EXPLANATION: ${missed} invoice-channel(s) across ${distinctMissed} invoice(s).`);
    say("  These are the cracks: past their milestone, still unpaid, nothing sent,");
    say("  and nothing on record explaining why. Each one is a customer who was");
    say("  never reminded and never decided about.");
  }
}

main()
  .catch(error => { console.error("AUDIT: failed:", error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
