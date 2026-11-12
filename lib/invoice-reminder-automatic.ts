/** Automatic reminder decisions. Pure: no env, network, database, or send.
 * Already-due invoices are reconciled on the official clock. Elapsed milestones
 * are skipped. Nothing here texts a customer who is not the explicit allowlist.
 * The only allowlisted candidate is Paula Rose invoice 7171, Day 10, on
 * 2026-11-13 between 09:05 and 09:14 America/Phoenix, and even that stays held
 * until a separate single-sender confirmation says GoHighLevel workflows will
 * not also text. An empty message history is not that confirmation.
 */
import { addInvoiceCalendarDays, invoiceCalendarDate, invoiceReminderClock, invoiceReminderMilestones,
  type InvoiceReminderCategory } from "./invoice-reminder-clock";

export const CUSTOMER_SEND_WINDOW = Object.freeze({
  startSeconds: 9 * 3600,
  endExclusiveSeconds: 9 * 3600 + 15 * 60,
});

/** First rollout only. These ids are the allowlist boundary, not a secret store.
 * Phone, sender, footer, Jobber account id, and quarantine identities are not here.
 */
export const PAULA_DAY10_ALLOWLIST = Object.freeze({
  invoiceNumber: "7171",
  contactId: "HEcpSb9P4bCIwbMEM165",
  opportunityId: "OpWOESlrv15azR3Dxwa2",
  forbiddenOpportunityId: "Bi2YvzKnqOx6dlGB20GT",
  category: "irrigation" as const,
  dayPastDue: 10 as const,
  audience: "homeowner" as const,
  scheduledOn: "2026-11-13",
  /** 09:05:00 inclusive through 09:14:59; 09:15:00 is missed and is not replayed. */
  windowStartSeconds: 9 * 3600 + 5 * 60,
  windowEndExclusiveSeconds: 9 * 3600 + 15 * 60,
  waitUntil: "2026-11-13T16:05:00.000Z",
});

/** Not a default, and not inferred from a quiet ledger. Bare true/yes/1 do not match. */
export const APP_ONLY_SENDER_CONFIRMATION = "app-only-ghl-workflows-confirmed-idle";

export function singleSenderConfirmed(value: string | undefined, reviewRef: string | undefined): boolean {
  const review = typeof reviewRef === "string" && reviewRef.length > 0 && reviewRef.length <= 256 &&
    reviewRef.trim() === reviewRef && !/[\x00-\x1f\x7f]/.test(reviewRef);
  return value === APP_ONLY_SENDER_CONFIRMATION && review;
}

const OPEN_STATUSES = new Set(["awaiting_payment", "past_due"]);
const timeFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "America/Phoenix", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

export type AutomaticReminderMode = "evaluate" | "paula-day10-attempt";
export type ReminderSourceInvoice = Readonly<{
  jobberInvoiceId: string;
  invoiceNumber: string | null;
  invoiceStatus: string | null;
  balanceMinor: number | null;
  issuedDate: string | null;
  dueDate: string | null;
  jobberClientId: string | null;
}>;
export type AutomaticReminderToken = Readonly<{ updatedAt: string; expiresAt: string }> | null;
export type ReminderConfigBinding = Readonly<{
  contactId: string | null;
  invoiceId: string | null;
  clientId: string | null;
  scheduledOn: string | null;
}>;
export type InvoiceReminderAction = "suppress" | "reconcile" | "hold" | "wait_for_paula_window" | "eligible_send";
export type InvoiceReminderDecision = Readonly<{
  jobberInvoiceId: string;
  invoiceNumber: string | null;
  daysPastDue: number | null;
  action: InvoiceReminderAction;
  reasons: readonly string[];
  waitUntil: string | null;
}>;
export type AutomaticReminderEvaluation = Readonly<{
  invoices: readonly InvoiceReminderDecision[];
  sends: readonly InvoiceReminderDecision[];
  paula: InvoiceReminderDecision | null;
}>;

export function normalizeAutomaticReminderMode(value: string | undefined): { mode: AutomaticReminderMode; unrecognized: boolean } {
  if (value == null || value === "" || value === "evaluate" || value === "disabled") return { mode: "evaluate", unrecognized: false };
  if (value === "paula-day10-attempt") return { mode: "paula-day10-attempt", unrecognized: false };
  return { mode: "evaluate", unrecognized: true };
}

export function phoenixClock(now: Date): { today: string; seconds: number } | null {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return null;
  const today = invoiceCalendarDate(now);
  if (!today) return null;
  const parts = timeFormat.formatToParts(now);
  const part = (name: string) => Number(parts.find(item => item.type === name)?.value);
  const hour = part("hour"), minute = part("minute"), second = part("second");
  if (![hour, minute, second].every(value => Number.isInteger(value))) return null;
  return { today, seconds: (hour === 24 ? 0 : hour) * 3600 + minute * 60 + second };
}

/** Null when the token can cover a Paula Day 10 attempt. The caller must not refresh it. */
export function paulaTokenBlocker(token: AutomaticReminderToken, now: Date): string | null {
  if (!token) return "token_unavailable";
  const updated = new Date(token.updatedAt), expires = new Date(token.expiresAt);
  if (!Number.isFinite(updated.getTime()) || !Number.isFinite(expires.getTime())) return "token_unavailable";
  const updatedDay = invoiceCalendarDate(updated), today = invoiceCalendarDate(now), clock = phoenixClock(updated);
  if (!updatedDay || updatedDay !== today || !clock || clock.seconds < CUSTOMER_SEND_WINDOW.startSeconds) return "token_not_refreshed_after_0900";
  if (expires.getTime() - now.getTime() < 900_000) return "token_coverage_below_900s";
  return null;
}

function decision(invoice: ReminderSourceInvoice, daysPastDue: number | null, action: InvoiceReminderAction,
  reasons: string[], waitUntil: string | null = null): InvoiceReminderDecision {
  return Object.freeze({
    jobberInvoiceId: invoice.jobberInvoiceId, invoiceNumber: invoice.invoiceNumber, daysPastDue, action,
    reasons: Object.freeze([...new Set(reasons)]), waitUntil,
  });
}

function suppression(invoice: ReminderSourceInvoice): InvoiceReminderDecision | null {
  const balance = invoice.balanceMinor, status = invoice.invoiceStatus;
  if (status == null && balance == null) return decision(invoice, null, "hold", ["source_unavailable"]);
  if (balance == null || !Number.isSafeInteger(balance)) return decision(invoice, null, "hold", ["source_balance_unreadable"]);
  if (status === "paid" && balance === 0) return decision(invoice, null, "suppress", ["paid_zero_balance_no_reminder"]);
  if (status === "paid") return decision(invoice, null, "suppress", ["contradictory_paid_positive_balance"]);
  if (status === "void" || status === "bad_debt") return decision(invoice, null, "suppress", [status === "void" ? "void_no_reminder" : "bad_debt_no_reminder"]);
  if (status === "draft") return decision(invoice, null, "suppress", ["draft_no_reminder"]);
  if (balance <= 0) return decision(invoice, null, "suppress", ["source_not_open_positive_balance"]);
  if (!status || !OPEN_STATUSES.has(status)) return decision(invoice, null, "hold", ["source_status_unreadable"]);
  return null;
}

function milestoneReasons(category: InvoiceReminderCategory, invoice: ReminderSourceInvoice, now: Date, today: string): string[] {
  const steps = invoiceReminderMilestones(category, invoice.issuedDate, invoice.dueDate, now) ?? [];
  const reasons: string[] = [];
  if (steps.some(step => step.scheduledOn < today)) reasons.push("elapsed_no_replay");
  if (steps.some(step => step.scheduledOn > today)) reasons.push("future_milestone");
  return reasons;
}

export function evaluateAutomaticReminders(input: Readonly<{
  now: Date;
  invoices: readonly ReminderSourceInvoice[];
  mode: AutomaticReminderMode;
  token: AutomaticReminderToken;
  priorAttemptInvoiceIds?: readonly string[];
  config?: ReminderConfigBinding;
  configBlockers?: readonly string[];
  /** Default false. A missing prior Day 10 SMS does not set this. */
  singleSenderConfirmed?: boolean;
}>): AutomaticReminderEvaluation {
  const clock = phoenixClock(input.now);
  const invoices = Array.isArray(input.invoices) ? input.invoices : [];
  if (!clock) {
    const held = invoices.map(invoice => decision(invoice, null, "hold", ["invalid_now"]));
    return Object.freeze({ invoices: Object.freeze(held), sends: Object.freeze([]), paula: null });
  }
  const counts = new Map<string, number>();
  const idCounts = new Map<string, number>();
  for (const invoice of invoices) {
    if (invoice?.invoiceNumber) counts.set(invoice.invoiceNumber, (counts.get(invoice.invoiceNumber) ?? 0) + 1);
    if (invoice?.jobberInvoiceId) idCounts.set(invoice.jobberInvoiceId, (idCounts.get(invoice.jobberInvoiceId) ?? 0) + 1);
  }
  const prior = new Set(input.priorAttemptInvoiceIds ?? []);
  const config = input.config ?? { contactId: null, invoiceId: null, clientId: null, scheduledOn: null };
  const blockers = [...(input.configBlockers ?? [])];
  const tokenBlocker = paulaTokenBlocker(input.token, input.now);
  const decided = invoices.map(invoice => classify(invoice, {
    now: input.now, today: clock.today, seconds: clock.seconds, mode: input.mode, counts, idCounts, prior, config, blockers, tokenBlocker,
    senderConfirmed: input.singleSenderConfirmed === true,
  }));
  const sends = decided.filter(item => item.action === "eligible_send");
  const safeSends = sends.length === 1 && sends[0].invoiceNumber === PAULA_DAY10_ALLOWLIST.invoiceNumber ? sends : [];
  const invoicesOut = sends.length > 1
    ? decided.map(item => item.action === "eligible_send" ? decision({
      jobberInvoiceId: item.jobberInvoiceId, invoiceNumber: item.invoiceNumber, invoiceStatus: null, balanceMinor: null,
      issuedDate: null, dueDate: null, jobberClientId: null,
    }, item.daysPastDue, "hold", [...item.reasons, "multiple_send_blocked"]) : item)
    : decided;
  const paulaMatches = invoicesOut.filter(item => item.invoiceNumber === PAULA_DAY10_ALLOWLIST.invoiceNumber);
  return Object.freeze({
    invoices: Object.freeze(invoicesOut),
    sends: Object.freeze(safeSends),
    paula: paulaMatches.length === 1 ? paulaMatches[0] : null,
  });
}

function classify(invoice: ReminderSourceInvoice, ctx: {
  now: Date; today: string; seconds: number; mode: AutomaticReminderMode;
  counts: Map<string, number>; idCounts: Map<string, number>; prior: Set<string>;
  config: ReminderConfigBinding; blockers: string[]; tokenBlocker: string | null; senderConfirmed: boolean;
}): InvoiceReminderDecision {
  if (!invoice || typeof invoice.jobberInvoiceId !== "string" || !invoice.jobberInvoiceId) {
    return decision({ jobberInvoiceId: "", invoiceNumber: null, invoiceStatus: null, balanceMinor: null, issuedDate: null, dueDate: null, jobberClientId: null },
      null, "hold", ["invalid_invoice"]);
  }
  if ((ctx.idCounts.get(invoice.jobberInvoiceId) ?? 0) > 1) return decision(invoice, null, "hold", ["duplicate_source_invoice"]);
  const suppressed = suppression(invoice);
  if (suppressed) return suppressed;
  if (invoice.invoiceStatus === "past_due") {
    const probed = invoiceReminderClock(invoice.issuedDate, invoice.dueDate, ctx.now);
    if (probed && !probed.isOverdue) return decision(invoice, probed.daysPastDue, "hold", ["early_past_due_label"]);
  }
  const official = invoiceReminderClock(invoice.issuedDate, invoice.dueDate, ctx.now);
  if (!official) return decision(invoice, null, "hold", ["invalid_or_missing_source_dates"]);
  if (!official.isOverdue) {
    const reasons = ["not_yet_overdue"];
    if (official.daysPastDue === 0) reasons.push("due_date_is_not_a_customer_text_day");
    return decision(invoice, official.daysPastDue, "reconcile", reasons);
  }
  const reasons: string[] = [];
  if (official.daysPastDue === 1) reasons.push("overdue_day_is_not_a_customer_text_day");
  const paulaNumber = invoice.invoiceNumber === PAULA_DAY10_ALLOWLIST.invoiceNumber;
  if (paulaNumber && (ctx.counts.get(invoice.invoiceNumber ?? "") ?? 0) !== 1) return decision(invoice, official.daysPastDue, "hold", ["ambiguous_invoice_number"]);
  const category: InvoiceReminderCategory = paulaNumber ? PAULA_DAY10_ALLOWLIST.category : "maintenance";
  reasons.push(...milestoneReasons(category, invoice, ctx.now, ctx.today));
  if (!paulaNumber) reasons.push(...milestoneReasons("irrigation", invoice, ctx.now, ctx.today));
  if (!paulaNumber) reasons.push("category_unproven");

  const steps = invoiceReminderMilestones(paulaNumber ? "irrigation" : "maintenance", invoice.issuedDate, invoice.dueDate, ctx.now) ?? [];
  const todaySteps = steps.filter(step => step.scheduledOn === ctx.today);
  const window = ctx.seconds < CUSTOMER_SEND_WINDOW.startSeconds ? "before"
    : ctx.seconds < CUSTOMER_SEND_WINDOW.endExclusiveSeconds ? "open" : "after";
  if (todaySteps.length && window === "before") reasons.push("waiting_for_window");
  if (todaySteps.length && window === "after") reasons.push("missed_window_no_catch_up");
  if (todaySteps.length && window === "open") reasons.push("in_customer_send_window");
  if (todaySteps.some(step => step.audience === "internal")) reasons.push("internal_prompt_gate_off");

  if (!paulaNumber) {
    if (todaySteps.some(step => step.audience === "homeowner") && window === "open") reasons.push("not_on_allowlist");
    const action = reasons.includes("not_on_allowlist") ? "hold" : "reconcile";
    return decision(invoice, official.daysPastDue, action, reasons);
  }

  const day10 = steps.find(step => step.dayPastDue === PAULA_DAY10_ALLOWLIST.dayPastDue && step.audience === "homeowner");
  const laterToday = steps.filter(step => step.scheduledOn === ctx.today && step.dayPastDue !== PAULA_DAY10_ALLOWLIST.dayPastDue);
  if (laterToday.length) reasons.push("milestone_gate_off");
  if (!day10 || day10.scheduledOn !== PAULA_DAY10_ALLOWLIST.scheduledOn || day10.timing !== "today" || official.daysPastDue !== 10) {
    if (day10 && day10.timing === "today" && day10.scheduledOn !== PAULA_DAY10_ALLOWLIST.scheduledOn) reasons.push("paula_schedule_mismatch");
    const action = reasons.includes("milestone_gate_off") || reasons.includes("paula_schedule_mismatch") ? "hold" : "reconcile";
    return decision(invoice, official.daysPastDue, action, reasons);
  }
  const scheduled = addInvoiceCalendarDays(official.dueOn, 10);
  if (scheduled !== PAULA_DAY10_ALLOWLIST.scheduledOn || ctx.today !== PAULA_DAY10_ALLOWLIST.scheduledOn) {
    return decision(invoice, official.daysPastDue, "hold", [...reasons, "paula_schedule_mismatch"]);
  }
  if (window === "after" || ctx.seconds >= PAULA_DAY10_ALLOWLIST.windowEndExclusiveSeconds) {
    return decision(invoice, official.daysPastDue, "reconcile", [...reasons, "missed_window_no_catch_up"]);
  }
  if (ctx.seconds < CUSTOMER_SEND_WINDOW.startSeconds) {
    return decision(invoice, official.daysPastDue, "reconcile", [...reasons, "waiting_for_window"]);
  }

  const sendBlockers = [...ctx.blockers];
  if (!ctx.senderConfirmed) sendBlockers.push("duplicate_sender_unconfirmed");
  if (ctx.mode !== "paula-day10-attempt") sendBlockers.push("send_mode_off");
  if (ctx.config.contactId !== PAULA_DAY10_ALLOWLIST.contactId) sendBlockers.push("allowlist_contact_mismatch");
  if (ctx.config.invoiceId !== invoice.jobberInvoiceId) sendBlockers.push("allowlist_invoice_mismatch");
  if (ctx.config.clientId !== invoice.jobberClientId) sendBlockers.push("allowlist_client_mismatch");
  if (ctx.config.scheduledOn !== PAULA_DAY10_ALLOWLIST.scheduledOn) sendBlockers.push("allowlist_schedule_mismatch");
  if (ctx.prior.has(invoice.jobberInvoiceId)) sendBlockers.push("duplicate_no_second_send");
  if (ctx.tokenBlocker) sendBlockers.push(ctx.tokenBlocker);
  if (sendBlockers.length) return decision(invoice, official.daysPastDue, "hold", [...reasons, ...sendBlockers]);
  if (ctx.seconds < PAULA_DAY10_ALLOWLIST.windowStartSeconds) {
    return decision(invoice, official.daysPastDue, "wait_for_paula_window", [...reasons, "waiting_for_paula_window"], PAULA_DAY10_ALLOWLIST.waitUntil);
  }
  return decision(invoice, official.daysPastDue, "eligible_send", [...reasons, "paula_day10_window"]);
}
