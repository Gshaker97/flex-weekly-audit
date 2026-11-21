/**
 * ONE WORKER FOR THE WHOLE LADDER - the half that decides.
 *
 * Days 10 and 15 each grew their own runner, and days 20, 25, 30 and the two
 * internal steps had pinned words but nobody to act on them. Seven near-copies
 * of the same job is how a reminder quietly stops firing, so the account owner
 * chose one worker for all of it (2026-11-19).
 *
 * This module is that worker's judgement, and nothing else. It performs no I/O,
 * holds no credential and sends nothing: given everything known about one
 * milestone of one invoice, it returns the single action to take - send this
 * exact text, create this exact task, or hold for these reasons. Carrying the
 * action out is a separate, explicit step, exactly as the task builder and its
 * runtime are kept apart.
 *
 * TWO RULES SHAPE EVERY DECISION HERE.
 *
 *   1. SILENCE IS THE DEFAULT. Anything unknown, unreadable, out of range or
 *      merely unconvincing produces a hold with a reason, never a send. There
 *      is no path that "assumes it's fine": every send is the end of a chain of
 *      positive checks.
 *
 *   2. THE WORDS MUST PASS THEIR OWN VALIDATOR. The copy modules pin not just
 *      what each day says but what it is allowed to claim - a fee that may
 *      apply rather than one that has been applied, a suspension only with
 *      evidence of a suspension. This planner re-checks the body it has chosen
 *      against those validators before emitting it. A body that fails is a
 *      hold. That way a careless edit to a pinned string cannot turn into a
 *      false statement about someone's account; it turns into silence and a
 *      reason, which the audit then reports.
 *
 * What this module deliberately does NOT decide: whether the contact has opted
 * out, whether the invoice is really still unpaid, whether a message already
 * went out, whether we are inside the Arizona morning window. Those are read
 * from live sources by the coordinator and the evaluator and arrive here as
 * `holds` and `alreadySent`. This file never second-guesses them and never
 * clears them.
 */
import { ladderMilestone, type InvoiceReminderCategory } from "./invoice-reminder-clock";
import { ORIGINAL_DAY10_SMS_BODY } from "./notification-copy-policy";
import {
  PROPOSED_DAY15_SMS_FEE_WARNING_BODY, day15SmsCopyWarnsWithoutClaiming,
  termsEvidenceSupportsWarning, type Day15TermsEvidence,
} from "./notification-day15-pilot";
import {
  LADDER_SMS_BODIES, ladderWarningCopyIsValid, ladderCopyClaims,
  day30Copy, day30CopyIsValid, type LadderClaim, type SuspensionEvidence,
} from "./notification-ladder-copy";
import {
  constructInternalTask, internalTaskDay,
  type InternalAssignee, type InternalTaskRequest, type InternalTaskKind,
} from "./notification-internal-task";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** Everything the worker is allowed to consider for one milestone of one invoice. */
export type LadderStepInput = Readonly<{
  /** Which rung, and for which kind of work. Irrigation has fewer rungs. */
  dayPastDue: number;
  category: InvoiceReminderCategory;
  /** Phoenix calendar date this rung falls on, and the date of this run. */
  scheduledOn: string;
  today: string;

  invoiceId: string;
  invoiceNumber: string;
  /** Live balance in minor units. Zero or less means nothing is owed. */
  balanceMinor: number;
  currency: string;
  /** Needed to decide whether the written policy covers this invoice at all. */
  invoiceIssuedOn: string | null;
  /** Whose suspension would have to be proven for day 30 to assert one. */
  jobberClientId: string;

  /** The homeowner contact a text would go to. Null means we have no destination. */
  homeownerContactId: string | null;
  /** Who owns an internal task. Null means nobody, which is never a task. */
  assignee: InternalAssignee | null;

  /** Holds already established upstream. Passed through untouched. */
  holds: readonly string[];
  /** True = already sent, false = not sent, null = we could not tell. */
  alreadySent: boolean | null;

  termsEvidence: Day15TermsEvidence | null;
  suspensionEvidence: SuspensionEvidence | null;
}>;

export type LadderAction =
  /** This rung is not today's. Nothing to do, nothing wrong. */
  | Readonly<{ kind: "not_due"; dayPastDue: number; reason: "future" | "already_past" }>
  | Readonly<{ kind: "hold"; dayPastDue: number; reasons: readonly string[] }>
  | Readonly<{
      kind: "send_sms"; dayPastDue: number; contactId: string; body: string;
      /** What these words actually claim, read from the words themselves. */
      claims: readonly LadderClaim[];
    }>
  | Readonly<{ kind: "create_task"; dayPastDue: number; taskKind: InternalTaskKind; request: InternalTaskRequest }>;

const hold = (dayPastDue: number, reasons: readonly string[]): LadderAction =>
  Object.freeze({ kind: "hold", dayPastDue, reasons: Object.freeze([...new Set(reasons)].sort()) });

/** The homeowner text for a rung, or null if this rung has no pinned homeowner copy. */
function homeownerBody(step: LadderStepInput): { body: string; valid: boolean } | null {
  switch (step.dayPastDue) {
    case 10:
      // Day 10 is the untouched original, and it already satisfies the shared
      // rule: it mentions late fees only as something to avoid, and claims
      // nothing about the account. Checked against that rule rather than
      // trusted, so a later edit to it cannot slip past unvalidated.
      return { body: ORIGINAL_DAY10_SMS_BODY, valid: ladderWarningCopyIsValid(ORIGINAL_DAY10_SMS_BODY) };
    case 15: {
      const body = PROPOSED_DAY15_SMS_FEE_WARNING_BODY;
      return { body, valid: day15SmsCopyWarnsWithoutClaiming(body) };
    }
    case 20:
    case 25: {
      const body = LADDER_SMS_BODIES[step.dayPastDue as 20 | 25];
      return { body, valid: ladderWarningCopyIsValid(body) };
    }
    case 30: {
      // The only rung whose words depend on a fact about the account. With no
      // suspension on record the conditional body is correct, not a fallback.
      const chosen = day30Copy(step.suspensionEvidence, step.jobberClientId);
      return { body: chosen.body, valid: day30CopyIsValid(chosen.body, chosen.suspensionProven) };
    }
    default:
      return null;
  }
}

/**
 * Decide the one action for one rung. Pure: same inputs, same answer, no clock
 * of its own and no network.
 */
export function planLadderStep(step: LadderStepInput): LadderAction {
  if (!step || typeof step !== "object") return hold(-1, ["malformed_ladder_step"]);
  const day = Number.isSafeInteger(step.dayPastDue) ? step.dayPastDue : -1;

  // Dates first: a rung that is not today is not a decision at all. A rung
  // already in the past is never replayed - catching up on a missed day is a
  // person's call, and the audit is what surfaces it.
  if (!DAY.test(String(step.scheduledOn)) || !DAY.test(String(step.today)))
    return hold(day, ["ladder_dates_unreadable"]);
  if (step.scheduledOn > step.today) return Object.freeze({ kind: "not_due", dayPastDue: day, reason: "future" });
  if (step.scheduledOn < step.today) return Object.freeze({ kind: "not_due", dayPastDue: day, reason: "already_past" });

  // Whatever the coordinator and the evaluator already decided stands.
  const reasons: string[] = [...(Array.isArray(step.holds) ? step.holds : ["ladder_holds_unreadable"])].filter(text);
  if (step.alreadySent === true) reasons.push("already_sent_on_this_channel");
  if (step.alreadySent !== true && step.alreadySent !== false) reasons.push("send_history_unknown");

  // This rung has to belong to this category's ladder. Irrigation stops at 21,
  // so a day 25 text for an irrigation invoice is refused here rather than sent
  // because something upstream assumed one shared ladder.
  const milestone = ladderMilestone(step.category, day);
  if (!milestone) reasons.push("day_is_not_a_rung_of_this_ladder");

  if (!text(step.invoiceId)) reasons.push("invoice_id_missing");
  if (!text(step.invoiceNumber)) reasons.push("invoice_number_missing");
  if (!Number.isSafeInteger(step.balanceMinor) || step.balanceMinor <= 0) reasons.push("balance_not_positive");
  if (typeof step.currency !== "string" || !/^[A-Z]{3}$/.test(step.currency)) reasons.push("currency_unusable");

  if (reasons.length || !milestone) return hold(day, reasons);

  if (milestone.audience === "internal") {
    // An internal rung is a task for a colleague. The builder owns the words
    // and refuses anything unowned, so its holds are returned as they are.
    const taskKind: InternalTaskKind | null = day === 21 ? "day21-call" : day === 35 ? "day35-collections" : null;
    if (!taskKind || internalTaskDay(taskKind) !== day) return hold(day, ["no_internal_task_for_this_day"]);
    if (!step.assignee) return hold(day, ["no_assignee"]);
    const request: InternalTaskRequest = {
      kind: taskKind, assignee: step.assignee,
      // A task hangs off the homeowner's contact, so a colleague opens it and
      // sees who it is about. Without one there is nowhere to put the task.
      contactId: step.homeownerContactId ?? "",
      invoiceNumber: step.invoiceNumber, invoiceId: step.invoiceId,
      dueOn: step.scheduledOn, balanceMinor: step.balanceMinor, currency: step.currency,
    };
    const built = constructInternalTask(request);
    if (built.state !== "constructed_disabled") return hold(day, built.reasons);
    return Object.freeze({ kind: "create_task", dayPastDue: day, taskKind, request: Object.freeze(request) });
  }

  // A homeowner rung is a text. It needs somewhere to go and words that pass.
  if (!text(step.homeownerContactId) || !ID.test(step.homeownerContactId as string))
    return hold(day, ["no_usable_homeowner_contact"]);

  const copy = homeownerBody(step);
  if (!copy) return hold(day, ["no_pinned_copy_for_this_day"]);

  // Day 15 is the one rung whose words make a claim about a charge, so it needs
  // evidence that something actually permits the warning for THIS invoice.
  if (day === 15 && !termsEvidenceSupportsWarning(step.termsEvidence, step.invoiceId, step.invoiceIssuedOn))
    return hold(day, ["invoice_terms_or_written_policy_must_support_the_fee_warning"]);

  // Rule 2: the chosen words are re-checked against their own validator. A
  // pinned string that has drifted becomes silence and a reason, never a send.
  if (!copy.valid) return hold(day, ["pinned_copy_failed_its_own_validator"]);

  return Object.freeze({
    kind: "send_sms", dayPastDue: day, contactId: step.homeownerContactId as string,
    body: copy.body, claims: Object.freeze(ladderCopyClaims(copy.body)),
  });
}

export type LadderDayPlan = Readonly<{
  today: string;
  actions: readonly LadderAction[];
  summary: Readonly<{ sends: number; tasks: number; holds: number; notDue: number }>;
  /** Every distinct hold reason across the day, for the morning report. */
  holdReasons: readonly string[];
}>;

/**
 * Plan every rung handed to it. The counts must account for every input, so a
 * step can never fall out of the plan unnoticed.
 */
export function planLadderDay(steps: readonly LadderStepInput[], today: string): LadderDayPlan {
  const list = Array.isArray(steps) ? steps : [];
  const actions = list.map(step => planLadderStep({ ...step, today }));
  const reasons = new Set<string>();
  for (const action of actions) if (action.kind === "hold") for (const reason of action.reasons) reasons.add(reason);
  return Object.freeze({
    today,
    actions: Object.freeze(actions),
    summary: Object.freeze({
      sends: actions.filter(a => a.kind === "send_sms").length,
      tasks: actions.filter(a => a.kind === "create_task").length,
      holds: actions.filter(a => a.kind === "hold").length,
      notDue: actions.filter(a => a.kind === "not_due").length,
    }),
    holdReasons: Object.freeze([...reasons].sort()),
  });
}
