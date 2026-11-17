/** Standalone sync hook. Import and the disabled branch never load policy or clients. */
import { notificationModuleFunctions } from "./notification-module-interop";
import type { SyncEntrypoint } from "./sync-writer-control";
import type { RecurringDay15EmailResult } from "./notification-recurring-day15-email";
import { log, logError } from "./log";

export type RecurringDay15EmailCronSummary = Readonly<{
  state: "disabled" | "completed" | "held" | "unknown";
  code: "disabled" | "outside_window" | "policy_unavailable" | "service_result" | "service_failure";
  invoices: number; heldInvoices: number; admissionAttempts: number; messageAttempts: number;
}>;

type Context = Readonly<{ entrypoint: SyncEntrypoint }>;
type Dependencies = Readonly<{
  mode(): string | undefined;
  load(mode: "read-only" | "attempt"): Promise<Readonly<{ run(): Promise<RecurringDay15EmailResult> }>>;
  report(summary: RecurringDay15EmailCronSummary): void;
}>;

const summary = (state: RecurringDay15EmailCronSummary["state"],
  code: RecurringDay15EmailCronSummary["code"]): RecurringDay15EmailCronSummary =>
  Object.freeze({ state, code, invoices: 0, heldInvoices: 0, admissionAttempts: 0, messageAttempts: 0 });

/** Safe to retain on SyncRun. No provider text, no destination, no invoice id. */
export function recurringDay15EmailSyncIssue(result: RecurringDay15EmailCronSummary): string | null {
  if (result.state === "disabled" || result.code === "outside_window" ||
      result.state === "completed" && result.heldInvoices === 0) return null;
  return `Recurring Day15 email: state=${result.state} code=${result.code} held=${result.heldInvoices} ` +
    `admissions=${result.admissionAttempts} attempts=${result.messageAttempts}; no automatic retry of pending/unknown events.`;
}

/** Injectable orchestration for synthetic tests. Production accepts no policy, JSON or callbacks. */
export function createRecurringDay15EmailCronHook(deps: Dependencies) {
  return async (context: Context): Promise<RecurringDay15EmailCronSummary> => {
    // A request with triggeredBy=cron is still HTTP unless admitted as standalone_cron.
    if (context.entrypoint !== "standalone_cron") return summary("disabled", "disabled");
    const mode = deps.mode();
    if (mode === undefined || mode === "disabled") return summary("disabled", "disabled");
    let service: Awaited<ReturnType<Dependencies["load"]>>;
    try {
      if (mode !== "read-only" && mode !== "attempt") throw new Error("Invalid recurring mode");
      service = await deps.load(mode);
    } catch {
      const held = summary("held", "policy_unavailable"); deps.report(held); return held;
    }
    let result: RecurringDay15EmailCronSummary;
    try {
      // Never race this promise with a timer. The service stops new work at its deadline,
      // but this admitted sync retains ownership until every in-flight operation settles.
      const outcome = await service.run();
      if (!["completed", "held", "unknown"].includes(outcome.state) || !Array.isArray(outcome.invoices) ||
          ![outcome.admissionAttempts, outcome.messageAttempts].every(n => Number.isSafeInteger(n) && n >= 0))
        throw new Error("Invalid recurring result");
      if (outcome.state === "held" && outcome.reasons.length === 1 &&
          outcome.reasons[0] === "outside_arizona_window_no_catch_up" &&
          outcome.invoices.length === 0 && outcome.admissionAttempts === 0 && outcome.messageAttempts === 0)
        return summary("held", "outside_window");
      result = Object.freeze({
        state: outcome.invoices.some(row => row.result?.state === "unknown") ? "unknown" : outcome.state,
        code: "service_result", invoices: outcome.invoices.length,
        heldInvoices: outcome.invoices.filter(row =>
          row.holds.some((hold: string) => hold !== "not_current_day15") || row.result?.state === "held").length,
        admissionAttempts: outcome.admissionAttempts, messageAttempts: outcome.messageAttempts });
    } catch {
      // A rejected service may already have crossed admission. Never infer safe retry.
      result = summary("unknown", "service_failure");
    }
    deps.report(result);
    return result;
  };
}

export const runConfiguredRecurringDay15Email = createRecurringDay15EmailCronHook({
  mode: () => process.env.FLEXX_RECURRING_DAY15_EMAIL_MODE,
  load: async mode => notificationModuleFunctions(await import("./notification-recurring-day15-cron-config"),
    ["loadInstalledRecurringDay15EmailCronService"]).loadInstalledRecurringDay15EmailCronService(mode),
  report: result => {
    const write = recurringDay15EmailSyncIssue(result) === null ? log : logError;
    write(`[sync] recurringDay15Email: state=${result.state} code=${result.code} invoices=${result.invoices} ` +
      `held=${result.heldInvoices} admissions=${result.admissionAttempts} attempts=${result.messageAttempts} retry=false`);
  },
});
