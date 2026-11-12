/** Hourly cron evaluation. Reads already-due Jobber invoices without refreshing
 * the token, then sends only the one Paula Day 10 allowlist decision.
 * Importing this module does not read env, Jobber, or the database.
 */
import { log } from "./log";
import { evaluateAutomaticReminders, normalizeAutomaticReminderMode, PAULA_DAY10_ALLOWLIST, phoenixClock, singleSenderConfirmed,
  type AutomaticReminderEvaluation, type AutomaticReminderToken, type ReminderSourceInvoice } from "./invoice-reminder-automatic";
import { inspectAutomaticReminderConfig } from "./invoice-reminder-automatic-config";

const JOBBER_API_URL = "https://api.getjobber.com/api/graphql";
const JOBBER_API_VERSION = "2025-04-16";
const BATCH = 25;
const MAX_INVOICES = 1000;
const MAX_WAIT_MS = 5 * 60 * 1000;

export type AutomaticReminderSummary = Readonly<{
  state: "disabled" | "evaluated" | "held" | "sent" | "unknown";
  code: string;
  checked: number;
  overdue: number;
  suppressed: number;
  elapsed: number;
  held: number;
  eligible: number;
  sends: number;
  messageAttempts: number;
  paulaDay10: string;
}>;

export type AutomaticReminderDependencies = Readonly<{
  now(): Date;
  mode(): string | undefined;
  /** Separate from mode, config, and message history. Default implementations return false. */
  singleSenderConfirmed(): boolean;
  readToken(): Promise<Readonly<{ accessToken: string; updatedAt: Date; expiresAt: Date }> | null>;
  loadOpenIds(): Promise<readonly string[]>;
  readInvoices(accessToken: string, ids: readonly string[]): Promise<readonly ReminderSourceInvoice[]>;
  priorAttempts(invoiceIds: readonly string[]): Promise<readonly string[]>;
  loadConfig(): { raw: string | undefined; sha256: string | undefined; reviewRef: string | undefined };
  sleep(ms: number): Promise<void>;
  sendPaulaDay10(raw: string, sha256: string, reviewRef: string): Promise<Readonly<{ state: string; attempted: boolean }>>;
}>;

function summary(state: AutomaticReminderSummary["state"], code: string, evaluation?: AutomaticReminderEvaluation,
  sends = 0, messageAttempts = 0): AutomaticReminderSummary {
  const invoices = evaluation?.invoices ?? [];
  return Object.freeze({
    state, code, checked: invoices.length,
    overdue: invoices.filter(item => (item.daysPastDue ?? 0) >= 1).length,
    suppressed: invoices.filter(item => item.action === "suppress").length,
    elapsed: invoices.filter(item => item.reasons.includes("elapsed_no_replay")).length,
    held: invoices.filter(item => item.action === "hold").length,
    eligible: invoices.filter(item => item.action === "eligible_send").length,
    sends, messageAttempts,
    paulaDay10: evaluation?.paula?.action ?? "absent",
  });
}

function tokenValue(token: { updatedAt: Date; expiresAt: Date } | null, now: Date): AutomaticReminderToken {
  if (!token) return null;
  return { updatedAt: token.updatedAt.toISOString(), expiresAt: token.expiresAt.toISOString() };
}

function usable(token: { expiresAt: Date } | null, now: Date): boolean {
  return !!token && Number.isFinite(token.expiresAt.getTime()) && token.expiresAt.getTime() > now.getTime();
}

export async function runAutomaticReminderPass(deps: AutomaticReminderDependencies, context: Readonly<{ entrypoint: string }>): Promise<AutomaticReminderSummary> {
  if (context.entrypoint !== "standalone_cron") return summary("disabled", "not_standalone_cron");
  try {
    const mode = normalizeAutomaticReminderMode(deps.mode());
    const senderConfirmed = deps.singleSenderConfirmed() === true;
    const token = await deps.readToken();
    const now = deps.now();
    if (!usable(token, now)) return summary("held", "token_unavailable");
    const ids = [...new Set(await deps.loadOpenIds())];
    if (ids.length > MAX_INVOICES) return summary("held", "invoice_reread_limit");
    const invoices = await deps.readInvoices(token!.accessToken, ids);
    const prior = await deps.priorAttempts(invoices.map(item => item.jobberInvoiceId));
    const clockNow = phoenixClock(now);
    // An empty ledger is not clearance: a workflow wait may still text later the same day.
    const paulaWindow = senderConfirmed && mode.mode === "paula-day10-attempt" && clockNow?.today === PAULA_DAY10_ALLOWLIST.scheduledOn &&
      clockNow.seconds >= 9 * 3600 && clockNow.seconds < 9 * 3600 + 15 * 60;
    const loaded = paulaWindow ? deps.loadConfig() : { raw: undefined, sha256: undefined, reviewRef: undefined };
    const inspected = paulaWindow
      ? inspectAutomaticReminderConfig(loaded.raw, loaded.sha256, loaded.reviewRef)
      : { blockers: [] as const, binding: { contactId: null, invoiceId: null, clientId: null, scheduledOn: null } };
    let evaluation = evaluateAutomaticReminders({
      now, invoices, mode: mode.mode, token: tokenValue(token, now), priorAttemptInvoiceIds: prior,
      config: inspected.binding, configBlockers: inspected.blockers.filter(item => item !== "send_mode_off"),
      singleSenderConfirmed: senderConfirmed,
    });
    const waiting = evaluation.paula?.action === "wait_for_paula_window" ? evaluation.paula : null;
    if (waiting?.waitUntil === PAULA_DAY10_ALLOWLIST.waitUntil) {
      const delay = Date.parse(waiting.waitUntil) - deps.now().getTime();
      if (!Number.isFinite(delay) || delay < 0 || delay > MAX_WAIT_MS) return summary("held", "wait_exceeds_bound", evaluation);
      await deps.sleep(delay);
      const refreshed = await deps.readToken();
      const after = deps.now();
      if (!usable(refreshed, after)) return summary("held", "token_unavailable", evaluation);
      const fresh = await deps.readInvoices(refreshed!.accessToken, [waiting.jobberInvoiceId]);
      const freshPrior = await deps.priorAttempts(fresh.map(item => item.jobberInvoiceId));
      const again = evaluateAutomaticReminders({
        now: after, invoices: fresh, mode: mode.mode, token: tokenValue(refreshed, after), priorAttemptInvoiceIds: freshPrior,
        config: inspected.binding, configBlockers: inspected.blockers.filter(item => item !== "send_mode_off"),
        singleSenderConfirmed: senderConfirmed,
      });
      const others = evaluation.invoices.filter(item => item.jobberInvoiceId !== waiting.jobberInvoiceId);
      evaluation = {
        invoices: Object.freeze([...others, ...again.invoices]),
        sends: again.sends,
        paula: again.paula,
      };
    }
    const codeBase = mode.unrecognized ? "unrecognized_mode_no_send"
      : evaluation.paula?.reasons.includes("duplicate_sender_unconfirmed") ? "duplicate_sender_unconfirmed"
      : evaluation.paula?.action ?? "no_paula_invoice";
    if (!senderConfirmed || evaluation.sends.length !== 1 || evaluation.sends[0].invoiceNumber !== PAULA_DAY10_ALLOWLIST.invoiceNumber ||
        evaluation.sends[0].action !== "eligible_send" || mode.mode !== "paula-day10-attempt" || inspected.blockers.length) {
      return summary("evaluated", codeBase, evaluation);
    }
    const outcome = await deps.sendPaulaDay10(loaded.raw!, loaded.sha256!, loaded.reviewRef!);
    if (outcome.state === "unknown" || outcome.attempted && outcome.state !== "accepted") {
      return summary("unknown", "send_outcome_unknown_no_retry", evaluation, 0, outcome.attempted ? 1 : 0);
    }
    if (outcome.state === "accepted" && outcome.attempted) return summary("sent", "paula_day10_sent", evaluation, 1, 1);
    return summary("held", "paula_day10_not_sent", evaluation, 0, outcome.attempted ? 1 : 0);
  } catch {
    return summary("held", "pass_failed");
  }
}

function cents(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value * 100);
  return Number.isSafeInteger(rounded) && Math.abs(value * 100 - rounded) < 0.000001 ? rounded : null;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read invoices by id. Does not refresh, save, or discover a send cohort. */
export async function readJobberInvoicesById(accessToken: string, ids: readonly string[], fetchImpl: typeof fetch = fetch): Promise<ReminderSourceInvoice[]> {
  const invoices: ReminderSourceInvoice[] = [];
  for (let offset = 0; offset < ids.length; offset += BATCH) {
    const batch = ids.slice(offset, offset + BATCH);
    const definitions = batch.map((_, index) => `$id${index}: EncodedId!`).join(", ");
    const fields = batch.map((_, index) => `i${index}: invoice(id: $id${index}) {
      id invoiceNumber invoiceStatus amounts { invoiceBalance } issuedDate dueDate client { id }
    }`).join("\n");
    const variables = Object.fromEntries(batch.map((id, index) => [`id${index}`, id]));
    const response = await fetchImpl(JOBBER_API_URL, {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-JOBBER-GRAPHQL-VERSION": JOBBER_API_VERSION,
      },
      body: JSON.stringify({ query: `query AutomaticReminderInvoices(${definitions}) { ${fields} }`, variables }),
    });
    if (!response.ok) throw new Error("jobber_reread_failed");
    const body = await response.json() as { data?: unknown; errors?: unknown };
    if (body.errors || !record(body.data)) throw new Error("jobber_reread_failed");
    for (let index = 0; index < batch.length; index += 1) {
      const source = body.data[`i${index}`];
      if (source == null) {
        invoices.push(Object.freeze({ jobberInvoiceId: batch[index], invoiceNumber: null, invoiceStatus: null, balanceMinor: null, issuedDate: null, dueDate: null, jobberClientId: null }));
        continue;
      }
      if (!record(source) || source.id !== batch[index]) throw new Error("jobber_reread_failed");
      const invoiceNumber = typeof source.invoiceNumber === "string" ? source.invoiceNumber.trim()
        : typeof source.invoiceNumber === "number" && Number.isSafeInteger(source.invoiceNumber) ? String(source.invoiceNumber) : null;
      invoices.push(Object.freeze({
        jobberInvoiceId: batch[index],
        invoiceNumber,
        invoiceStatus: typeof source.invoiceStatus === "string" ? source.invoiceStatus : null,
        balanceMinor: record(source.amounts) ? cents(source.amounts.invoiceBalance) : null,
        issuedDate: typeof source.issuedDate === "string" ? source.issuedDate : null,
        dueDate: typeof source.dueDate === "string" ? source.dueDate : null,
        jobberClientId: record(source.client) && typeof source.client.id === "string" ? source.client.id : null,
      }));
    }
  }
  return invoices;
}

export function runConfiguredAutomaticReminders(context: Readonly<{ entrypoint: string }>): Promise<AutomaticReminderSummary> {
  return runAutomaticReminderPass({
    now: () => new Date(),
    mode: () => process.env.FLEXX_AUTOMATIC_REMINDER_MODE,
    singleSenderConfirmed: () => singleSenderConfirmed(process.env.FLEXX_REMINDER_SINGLE_SENDER, process.env.FLEXX_REMINDER_SINGLE_SENDER_REVIEW_REF),
    readToken: async () => {
      const { prisma } = await import("./prisma");
      const auth = await prisma.$transaction(async tx => {
        await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '10000ms'");
        return tx.jobberAuth.findFirst({
          orderBy: { createdAt: "desc" },
          select: { accessToken: true, expiresAt: true, updatedAt: true },
        });
      }, { maxWait: 1000, timeout: 15000 });
      if (!auth?.accessToken) return null;
      return { accessToken: auth.accessToken, expiresAt: auth.expiresAt, updatedAt: auth.updatedAt };
    },
    loadOpenIds: async () => {
      const { prisma } = await import("./prisma");
      const rows = await prisma.invoiceRecord.findMany({
        where: { OR: [
          { invoiceStatus: { in: ["awaiting_payment", "past_due"] } },
          { invoiceStatus: "paid", amountDue: { gt: 0 } },
        ] },
        select: { jobberInvoiceId: true },
        take: MAX_INVOICES + 1,
      });
      return rows.map(row => row.jobberInvoiceId);
    },
    readInvoices: (accessToken, ids) => readJobberInvoicesById(accessToken, ids),
    priorAttempts: async invoiceIds => {
      if (!invoiceIds.length) return [];
      const { prisma } = await import("./prisma");
      const rows = await prisma.notificationLedger.findMany({
        where: { invoiceId: { in: [...invoiceIds] }, dayPastDue: 10, audience: "homeowner" },
        select: { invoiceId: true },
      });
      return rows.map(row => row.invoiceId);
    },
    loadConfig: () => ({
      raw: process.env.FLEXX_AUTOMATIC_REMINDER_CONFIG_JSON,
      sha256: process.env.FLEXX_AUTOMATIC_REMINDER_CONFIG_SHA256,
      reviewRef: process.env.FLEXX_AUTOMATIC_REMINDER_REVIEW_REF,
    }),
    sleep: ms => new Promise(resolve => { setTimeout(resolve, ms); }),
    sendPaulaDay10: async (raw, sha256, reviewRef) => {
      if (!singleSenderConfirmed(process.env.FLEXX_REMINDER_SINGLE_SENDER, process.env.FLEXX_REMINDER_SINGLE_SENDER_REVIEW_REF)) {
        return { state: "held", attempted: false };
      }
      const { reviewDay10PilotConfiguration, createDay10Pilot } = await import("./notification-day10-pilot");
      const { bootstrapDay10PilotRuntime } = await import("./notification-day10-runtime");
      const reviewed = reviewDay10PilotConfiguration(raw, { configSha256: sha256, reviewRef, action: "one-attempt" });
      if (!reviewed.handle) return { state: "held", attempted: false };
      const parsed = JSON.parse(raw) as { expiresAt?: string; source?: { scope?: { locationId?: string }; identityCoveragePolicy?: { accountId?: string } } };
      const accountId = parsed.source?.identityCoveragePolicy?.accountId;
      const locationId = parsed.source?.scope?.locationId;
      if (!accountId || !locationId || !parsed.expiresAt) return { state: "held", attempted: false };
      const pilot = createDay10Pilot({
        mode: "reviewed-one-attempt",
        config: reviewed.handle,
        runtime: () => bootstrapDay10PilotRuntime({
          accountId, locationId, action: "one-attempt", expiresAt: parsed.expiresAt!,
          service: "recurring-cron", rollout: "paula-day10-2026-11-13",
        }),
      });
      const result = await pilot.run();
      return { state: result.state, attempted: result.attempted };
    },
  }, context).then(result => {
    log(`[cron] invoice reminders: state=${result.state} code=${result.code} checked=${result.checked} overdue=${result.overdue} suppressed=${result.suppressed} elapsed=${result.elapsed} held=${result.held} eligible=${result.eligible} sends=${result.sends} attempts=${result.messageAttempts} paulaDay10=${result.paulaDay10}`);
    return result;
  });
}
