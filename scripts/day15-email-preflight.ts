// Day 15 customer EMAIL — no-send preflight.
//
// It answers one question: if the Day 15 email were live, exactly who would
// receive one, and why is everyone else not receiving one.
//
// It cannot send. It imports no sender, no dispatcher, no GoHighLevel write path
// and nothing that reserves in the ledger. It writes nothing to either provider
// or to our own database. Making it send would mean adding code.
//
// WHO DECIDES WHAT
//   Jobber decides, from a live per-invoice read: is the invoice open, is the
//   original total positive, is there a balance left, when was it issued, and is
//   today exactly day 15 past its due date in Arizona. The cache decides nothing
//   except which invoices are worth reading.
//   Jobber also supplies the job behind the invoice, through `Invoice.jobs` and
//   `Invoice.archivedJobs`, so the warranty rule reads the real linked job rather
//   than whatever the invoice-number join happened to find.
//   GoHighLevel decides only who the message would go to and whether one has
//   already gone out.
//
// `--as-of=YYYY-MM-DD` runs the whole chain as if it were 09:05 Phoenix on that
// date, so the recipient, opt-out and duplicate checks are exercised against the
// invoices that will actually be first in line. Balances are still read live.
import { prisma } from "../lib/prisma";
import { evaluateReminders, type SendChannel } from "../lib/reminder-evaluation";
import { createReminderEvaluationReaders } from "../lib/reminder-evaluation-readers";
import { jobberGraphQL } from "../lib/jobber";
import { invoiceCalendarDate, addInvoiceCalendarDays } from "../lib/invoice-reminder-clock";
import { DAY15_EMAIL_ISSUED_ON_OR_AFTER, day15EmailAmountsArePositive, day15EmailIsWithheld,
  day15EmailIssueWindow } from "../lib/reminder-email-window";
import { readLinkedJobText, type LinkedJobsResult } from "../lib/reminder-job-notes-source";
import { classifyLinkedJobRework } from "../lib/reminder-rework-notes";
import { NATIVE_SMS_ATTESTATION_2026_11_17 } from "../lib/reminder-native-sms-attestation";

const DAY = 15;
/** Email only. Day 21 keeps whatever it already does; this run never touches it. */
const MILESTONE_CHANNELS = (step: { dayPastDue: number }): readonly SendChannel[] =>
  step.dayPastDue === DAY ? ["email"] : [];
/** Day 15 is one ledger event regardless of channel. Mirrors `eventKey`. */
const CHANNEL_BLIND = [DAY];
const OPEN = ["awaiting_payment", "past_due"];
const SETTLED = new Set(["paid", "void", "bad_debt"]);

/** Jobber reads must use the token that already exists. Refreshing it writes. */
const MIN_TOKEN_MINUTES = 8;

async function tokenMinutes(): Promise<number> {
  const auth = await prisma.jobberAuth.findFirst({ orderBy: { createdAt: "desc" }, select: { expiresAt: true } });
  if (!auth) throw new Error("no_jobber_auth_row");
  return Math.floor((auth.expiresAt.getTime() - Date.now()) / 60000);
}

function resolveNow(): { now: Date; label: string } {
  const flag = process.argv.find(arg => arg.startsWith("--as-of="));
  if (!flag) return { now: new Date(), label: "live clock" };
  const date = flag.slice("--as-of=".length);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("as_of_must_be_yyyy_mm_dd");
  // 09:05 Phoenix = 16:05Z, inside the 09:00-09:15 window.
  const now = new Date(`${date}T16:05:00.000Z`);
  if (!Number.isFinite(now.getTime())) throw new Error("as_of_unparseable");
  return { now, label: `simulated 09:05 Phoenix on ${date}` };
}

/** One bucket per invoice, mutually exclusive, in this order. They must sum. */
type Disposition =
  | "source_unreadable"
  | "settled_no_longer_owes"
  | "issued_before_programme"
  | "zero_or_unreadable_amount"
  | "withheld_by_name"
  | "excluded_warranty_or_no_charge"
  | "held_notes_unverifiable"
  | "day15_passed_no_catch_up"
  | "not_yet_day15"
  /** Passed every check in this run. NOT cleared to send: a send re-reads Jobber. */
  | "candidate"
  | "held_protection"
  | "held_ghl_dependency";

/** Holds that exist to protect a customer. These must never be relaxed. */
const PROTECTION = [
  "no_exact_destination_contact", "ambiguous_destination_contacts", "destination_contact_opted_out",
  "send_history_unavailable", "send_history_incomplete", "ambiguous_send_attribution",
  "uncertain_send_attempt", "send_detail_unknown", "already_sent_all_channels",
  "milestone_already_sent_on_another_channel", "owner_has_multiple_unpaid_invoices",
  "source_owner_unknown_or_changed", "exclusions_unverified",
];
/** Holds that ask GoHighLevel to confirm something Jobber already decided. */
const GHL_DEPENDENCY = [
  "no_invoice_pipeline_card", "ambiguous_pipeline_cards", "card_not_in_overdue_stage",
  "card_status_not_open", "service_type_jobber_only", "service_type_conflict", "service_type_unknown",
];

async function main() {
  const { now, label } = resolveNow();
  const say = (line: string) => console.log("PF15: " + line);
  const minutes = await tokenMinutes();
  if (minutes < MIN_TOKEN_MINUTES) {
    throw new Error(`jobber_token_coverage_too_short: ${minutes}m left; a read would refresh and write. Stopping.`);
  }
  say(`clock: ${label}; jobber token coverage ${minutes}m (no refresh, no write)`);
  const today = invoiceCalendarDate(now)!;

  // The cache is used ONLY to choose who to read. No date filter here on
  // purpose: the live Jobber issue date decides the programme window, so a
  // drifted cache can neither add nor remove anyone.
  const cached = await prisma.invoiceRecord.findMany({
    where: { invoiceStatus: { in: OPEN }, amountDue: { gt: 0 } },
    select: {
      jobberInvoiceId: true, invoiceNumber: true, clientName: true,
      customer: { select: { jobberClientId: true, email: true, phone: true } },
    },
  });
  say(`open invoices read from Jobber: ${cached.length} (cache used only to pick them)`);

  const facts = new Map<string, LinkedJobsResult>();
  for (const row of cached) {
    facts.set(row.jobberInvoiceId, await readLinkedJobText(row.jobberInvoiceId, jobberGraphQL));
  }

  const disposition = new Map<string, Disposition>();
  const detail = new Map<string, string>();
  const day15Today: typeof cached = [];
  /** invoiceNumber -> the date it will be exactly day 15, when that is future. */
  const upcoming: { label: string; date: string; amount: number }[] = [];

  for (const row of cached) {
    const label2 = `#${row.invoiceNumber ?? "?"}`;
    const live = facts.get(row.jobberInvoiceId)!;
    const put = (d: Disposition, why: string) => { disposition.set(row.jobberInvoiceId, d); detail.set(row.jobberInvoiceId, `${label2}:${why}`); };

    if (!live.complete && !live.invoiceStatus) { put("source_unreadable", live.reason ?? "unknown"); continue; }
    const status = (live.invoiceStatus ?? "").toLowerCase();
    if (SETTLED.has(status) || (live.balanceCents ?? 0) <= 0) { put("settled_no_longer_owes", status || "unknown"); continue; }
    if (!OPEN.includes(status)) { put("source_unreadable", `status_${status || "unknown"}`); continue; }

    const window = day15EmailIssueWindow(live.issuedDate);
    if (window === "before_programme") { put("issued_before_programme", invoiceCalendarDate(live.issuedDate) ?? "?"); continue; }
    if (window === "unusable_issue_date") { put("source_unreadable", "issue_date_unusable"); continue; }

    const amounts = day15EmailAmountsArePositive(live.totalCents, live.balanceCents);
    if (!amounts.ok) { put("zero_or_unreadable_amount", amounts.reason!); continue; }

    if (day15EmailIsWithheld(row.invoiceNumber)) { put("withheld_by_name", "named carve-out"); continue; }

    const rework = classifyLinkedJobRework(live);
    if (rework.verdict === "excluded") { put("excluded_warranty_or_no_charge", `${rework.reason}=${rework.evidence}`); continue; }
    if (rework.verdict === "hold") { put("held_notes_unverifiable", rework.reason); continue; }

    const dueOn = invoiceCalendarDate(live.dueDate);
    if (!dueOn) { put("source_unreadable", "due_date_unusable"); continue; }
    const day15On = addInvoiceCalendarDays(dueOn, DAY)!;
    if (day15On < today) { put("day15_passed_no_catch_up", `was ${day15On}`); continue; }
    if (day15On > today) {
      put("not_yet_day15", `day 15 on ${day15On}`);
      upcoming.push({ label: label2, date: day15On, amount: (live.balanceCents ?? 0) / 100 });
      continue;
    }
    day15Today.push(row);
  }

  // Only the invoices that are exactly day 15 today go through the recipient,
  // opt-out and duplicate checks, so nothing is read twice.
  if (day15Today.length) {
    const plan = await evaluateReminders({
      candidates: day15Today.map(row => ({
        jobberInvoiceId: row.jobberInvoiceId, invoiceNumber: row.invoiceNumber, clientName: row.clientName,
        jobberClientId: row.customer?.jobberClientId ?? null,
        email: row.customer?.email ?? null, phone: row.customer?.phone ?? null,
      })),
      readers: createReminderEvaluationReaders(),
      now,
      // Not supplied, and not needed for a disposition count: the quarantine is
      // a send-time identity omission covering at most two clients.
      verifiedExclusions: null,
      ignoreWindow: true,
      milestoneChannels: MILESTONE_CHANNELS,
      feeClaimFreeDay15: true,
      channelBlindMilestones: CHANNEL_BLIND,
      // The approved email path: Jobber decides status and timing.
      jobberOnlyDay15Email: true,
      // The narrow history fix: an unnumbered GoHighLevel message is dismissed
      // only when it was reliably sent strictly before this invoice's issue day
      // in Phoenix. Messages at or after issuance, unreadable timestamps,
      // incomplete history and messages naming this invoice all still hold.
      priorSendIgnoresPreIssueMessages: true,
      // Pass --native-sms-guard to run the legacy-text overlap guard. It is off
      // by default so this script keeps showing the invoice-side picture on its
      // own; with the flag it reports what the guard would do today.
      ...(process.argv.includes("--native-sms-guard")
        ? { nativeSmsOverlapAttestation: NATIVE_SMS_ATTESTATION_2026_11_17 } : {}),
    });
    for (const row of plan.rows) {
      const label2 = `#${row.invoiceNumber ?? "?"}`;
      const real = row.holds.filter(h => !h.startsWith("exclusions_unverified"));
      const ghl = real.filter(h => GHL_DEPENDENCY.some(g => h.startsWith(g)));
      const prot = real.filter(h => PROTECTION.some(p => h.startsWith(p)));
      const other = real.filter(h => !ghl.includes(h) && !prot.includes(h));
      if (!real.length) { disposition.set(row.jobberInvoiceId, "candidate"); detail.set(row.jobberInvoiceId, label2); }
      else if (prot.length || other.length) {
        disposition.set(row.jobberInvoiceId, "held_protection");
        detail.set(row.jobberInvoiceId, `${label2}:${[...prot, ...other].map(h => h.split(":")[0]).join("+")}`);
      } else {
        disposition.set(row.jobberInvoiceId, "held_ghl_dependency");
        detail.set(row.jobberInvoiceId, `${label2}:${ghl.map(h => h.split(":")[0]).join("+")}`);
      }
    }
  }

  const ORDER: Disposition[] = ["candidate", "held_protection", "held_ghl_dependency",
    "held_notes_unverifiable", "excluded_warranty_or_no_charge", "withheld_by_name",
    "zero_or_unreadable_amount", "day15_passed_no_catch_up", "not_yet_day15",
    "issued_before_programme", "settled_no_longer_owes", "source_unreadable"];
  say(`---- primary disposition on ${today} (one bucket per invoice) ----`);
  let sum = 0;
  for (const bucket of ORDER) {
    const rows = cached.filter(r => disposition.get(r.jobberInvoiceId) === bucket);
    sum += rows.length;
    if (!rows.length) continue;
    say(`  ${bucket}: ${rows.length}`);
    if (bucket !== "not_yet_day15" && bucket !== "issued_before_programme" && bucket !== "day15_passed_no_catch_up") {
      for (const r of rows) say(`      ${detail.get(r.jobberInvoiceId)}`);
    }
  }
  const unset = cached.filter(r => !disposition.get(r.jobberInvoiceId));
  say(`  TOTAL ${sum} + unclassified ${unset.length} = ${cached.length} (must match)`);

  upcoming.sort((a, b) => a.date.localeCompare(b.date));
  if (upcoming.length) {
    const first = upcoming[0].date;
    const sameDay = upcoming.filter(u => u.date === first);
    say(`---- earliest date with an invoice that clears every Jobber-side rule ----`);
    say("  (candidates, not cleared to send: Jobber is re-read immediately before any send)");
    say(`  ${first}: ${sameDay.length} invoice(s) ${sameDay.map(u => `${u.label} $${u.amount.toFixed(2)}`).join(" ")}`);
    const next = [...new Set(upcoming.map(u => u.date))].slice(0, 8);
    for (const date of next) {
      const on = upcoming.filter(u => u.date === date);
      say(`     ${date}  ${on.length} invoice(s) / $${on.reduce((a, u) => a + u.amount, 0).toFixed(2)}  ${on.map(u => u.label).join(" ")}`);
    }
  } else {
    say("---- no invoice clears every Jobber-side rule on any future date ----");
  }

  say(`programme window: issued on or after ${DAY15_EMAIL_ISSUED_ON_OR_AFTER}`);
  say("sends attempted: 0 (this script has no send path)");
  say(`ledger reservations made: 0 (this script cannot reserve)`);
}

main()
  .then(async () => { await prisma.$disconnect(); process.exit(0); })
  .catch(async (err: any) => {
    console.error("PF15 FAILED:", err?.message ?? err);
    await prisma.$disconnect();
    process.exit(1);
  });
