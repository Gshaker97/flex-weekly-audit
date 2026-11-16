/**
 * The connecting layer between a cron entrypoint and the Day 15 fee-free sender.
 *
 * It does four things and nothing else:
 *   1. refuses to do anything at all without an out-of-band approval;
 *   2. loads one bounded configuration and confirms it names exactly the one
 *      approved invoice;
 *   3. re-reads the pinned billing-SMS consent submission and requires it to agree
 *      with that configuration;
 *   4. hands the reviewed configuration to the sender, which owns every send-side
 *      safeguard (live Jobber balance, live invoice link, history, ledger, one attempt).
 *
 * Default is NO SEND. "read-only" is the default action, and reaching
 * "reviewed-one-attempt" needs the approval to say so AND the caller to pass the
 * explicit confirmation separately. Neither alone is enough.
 *
 * Import is inert. Every input arrives through `dependencies`: this module reads no
 * environment variable, no file, no database and no network of its own.
 */
import { createDay15Sender, inspectDay15SenderReadiness, reviewDay15SenderConfiguration,
  summarizeDay15SenderExecution,
  type Day15SenderConfig, type Day15SenderReadiness, type Day15SenderRuntime } from "./notification-day15-sender";
import { readDay15ConsentEvidence, type Day15ConsentIO, type Day15ConsentPin, type Day15ConsentRead }
  from "./notification-day15-consent-evidence";

export const DAY15_PILOT_RUN_KIND = "day15-homeowner-sms-fee-free-pilot-run" as const;

/**
 * Out-of-band operator approval. Deliberately NOT read from the configuration file:
 * a file that could name its own review hash, its own invoice and its own action
 * would be self-authorizing.
 */
export type Day15PilotApproval = Readonly<{
  /** sha256 of the configuration bytes, computed and reviewed outside this process. */
  configSha256: string;
  /** Must equal the configuration's own reviewRef. */
  reviewRef: string;
  /** The ONE invoice this run may touch. Any other invoice in the config is a hold. */
  allowedInvoiceId: string;
  /** "read-only" unless the pilot send itself has been approved. */
  action: "read-only" | "one-attempt";
}>;

export type Day15PilotDependencies = Readonly<{
  /** Returns the configuration bytes, or undefined when there is no configuration. */
  readConfiguration(): Promise<string | undefined>;
  /** The approval, or null. Null means: do nothing, read nothing. */
  approval(): Day15PilotApproval | null;
  /** Pinned consent submission. Null means: hold, never "look for consent instead". */
  consentPin(): Day15ConsentPin | null;
  consentIO(): Promise<Day15ConsentIO>;
  /** Built only after every static check has passed. */
  runtime(): Promise<Day15SenderRuntime>;
  /**
   * Separate, explicit confirmation that a single attempt is approved. The approval's
   * action alone does not unlock a send, and neither does this alone.
   */
  oneAttemptConfirmed(): boolean;
  /** Test seam. Defaults to the real sender; production never passes this. */
  createSender?: typeof createDay15Sender;
  now?(): Date;
}>;

export type Day15PilotOutcome = Readonly<{
  kind: typeof DAY15_PILOT_RUN_KIND;
  /** "no_approval" and "held" never attempt anything. */
  state: "no_approval" | "held" | "read_only_complete" | "attempted";
  mode: "none" | "read-only" | "reviewed-one-attempt";
  reasons: readonly string[];
  readiness: Day15SenderReadiness | null;
  consent: Day15ConsentRead | null;
  invoiceId: string | null;
  /** Redacted sender outcome, when the sender ran. */
  execution: ReturnType<typeof summarizeDay15SenderExecution> | null;
  attempted: boolean;
  productionSendCapability: false;
  rolloutReady: false;
}>;

const SHA256 = /^[a-f0-9]{64}$/;

function outcome(partial: Partial<Day15PilotOutcome> & Pick<Day15PilotOutcome, "state" | "reasons">): Day15PilotOutcome {
  return Object.freeze({
    kind: DAY15_PILOT_RUN_KIND,
    mode: "none" as const,
    readiness: null, consent: null, invoiceId: null, execution: null, attempted: false,
    productionSendCapability: false as const, rolloutReady: false as const,
    ...partial,
    reasons: Object.freeze([...partial.reasons]),
  }) as Day15PilotOutcome;
}

/**
 * One run. Returns a report; never throws for a data or evidence problem.
 * A thrown error from a dependency is reported as a hold, with no detail carried
 * through, so a credential or a provider message cannot escape into a log.
 */
export async function runDay15Pilot(dependencies: Day15PilotDependencies): Promise<Day15PilotOutcome> {
  const now = dependencies.now ?? (() => new Date(Date.now()));
  const create = dependencies.createSender ?? createDay15Sender;

  // 1. No approval: read nothing, build nothing, touch nothing.
  let approval: Day15PilotApproval | null;
  try { approval = dependencies.approval(); } catch { return outcome({ state: "no_approval", reasons: ["approval_unreadable"] }); }
  if (!approval) return outcome({ state: "no_approval", reasons: ["no_out_of_band_pilot_approval"] });
  if (!SHA256.test(approval.configSha256 ?? "") || typeof approval.reviewRef !== "string" || !approval.reviewRef ||
      typeof approval.allowedInvoiceId !== "string" || !approval.allowedInvoiceId ||
      !["read-only", "one-attempt"].includes(approval.action))
    return outcome({ state: "no_approval", reasons: ["incomplete_out_of_band_pilot_approval"] });

  // 2. The action is the floor, not the ceiling. One attempt needs both signals.
  const confirmed = (() => { try { return dependencies.oneAttemptConfirmed() === true; } catch { return false; } })();
  const mode: "read-only" | "reviewed-one-attempt" =
    approval.action === "one-attempt" && confirmed ? "reviewed-one-attempt" : "read-only";
  const downgraded = approval.action === "one-attempt" && !confirmed;

  // 3. Configuration, bounded, and the exact invoice limit.
  let raw: string | undefined;
  try { raw = await dependencies.readConfiguration(); } catch { raw = undefined; }
  if (typeof raw !== "string" || !raw)
    return outcome({ state: "held", mode, reasons: ["pilot_configuration_absent"] });

  const readiness = inspectDay15SenderReadiness(raw, {
    configSha256: approval.configSha256, reviewRef: approval.reviewRef, action: approval.action,
  });
  if (readiness.state !== "reviewed_configuration")
    return outcome({ state: "held", mode, readiness, reasons: ["pilot_configuration_held", ...readiness.missing] });

  let config: Day15SenderConfig;
  try { config = JSON.parse(raw) as Day15SenderConfig; } catch {
    return outcome({ state: "held", mode, readiness, reasons: ["pilot_configuration_unparseable"] });
  }
  const invoiceId = config.source?.scope?.invoiceId ?? null;
  if (!invoiceId || invoiceId !== approval.allowedInvoiceId)
    return outcome({ state: "held", mode, readiness, invoiceId,
      reasons: ["configuration_invoice_is_not_the_one_approved_invoice"] });

  // 4. The pinned consent submission, re-read. No search, no fallback.
  const pin = (() => { try { return dependencies.consentPin(); } catch { return null; } })();
  if (!pin)
    return outcome({ state: "held", mode, readiness, invoiceId, reasons: ["pinned_consent_evidence_absent"] });
  if (pin.locationId !== config.source.scope.locationId)
    return outcome({ state: "held", mode, readiness, invoiceId,
      reasons: ["pinned_consent_location_differs_from_configuration"] });

  let consent: Day15ConsentRead;
  try {
    consent = await readDay15ConsentEvidence(pin, config.consent ?? null, await dependencies.consentIO(), now);
  } catch {
    return outcome({ state: "held", mode, readiness, invoiceId, reasons: ["consent_evidence_io_unavailable"] });
  }
  if (consent.state !== "verified")
    return outcome({ state: "held", mode, readiness, consent, invoiceId,
      reasons: ["pinned_consent_evidence_not_verified", ...consent.reasons] });

  // 5. Mint the in-process handle and run the sender. Everything after this point is
  //    the sender's own machinery, unchanged.
  const reviewed = reviewDay15SenderConfiguration(raw, {
    configSha256: approval.configSha256, reviewRef: approval.reviewRef, action: approval.action,
  });
  if (!reviewed.handle)
    return outcome({ state: "held", mode, readiness: reviewed.readiness, consent, invoiceId,
      reasons: ["configuration_review_handle_refused", ...reviewed.readiness.missing] });

  let execution: ReturnType<typeof summarizeDay15SenderExecution>;
  try {
    const sender = create({ mode, config: reviewed.handle, runtime: dependencies.runtime });
    execution = summarizeDay15SenderExecution(await sender.run());
  } catch {
    return outcome({ state: "held", mode, readiness, consent, invoiceId,
      reasons: ["sender_runtime_unavailable"] });
  }

  const reasons = [
    ...(downgraded ? ["one_attempt_not_confirmed_downgraded_to_read_only"] : []),
    ...execution.reasons,
  ];
  return outcome({
    state: mode === "reviewed-one-attempt" ? "attempted" : "read_only_complete",
    mode, readiness, consent, invoiceId, execution, attempted: execution.attempted === true, reasons,
  });
}

/** One log line. Carries no phone number, no message text and no credential. */
export function describeDay15PilotOutcome(result: Day15PilotOutcome): string {
  const parts = [
    `state=${result.state}`,
    `mode=${result.mode}`,
    `invoice=${result.invoiceId ?? "-"}`,
    `consent=${result.consent?.state ?? "-"}`,
    `sender=${result.execution?.state ?? "-"}`,
    `reserved=${result.execution?.reservationAcknowledged ?? false}`,
    `attempted=${result.attempted}`,
  ];
  if (result.reasons.length) parts.push(`reasons=[${result.reasons.join("; ")}]`);
  return `[day15-pilot] ${parts.join(" ")}`;
}
