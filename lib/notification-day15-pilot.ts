/**
 * Day 15 homeowner SMS — CONFIGURATION VALIDATOR ONLY. Unwired.
 *
 * This module is a sibling of `notification-day10-pilot.ts` and deliberately
 * does LESS than it: it validates a reviewed configuration and nothing else.
 * It imports no transport, no runtime, no database, no client, and reads no
 * environment variable or file. There is no mode, flag or argument that makes
 * it send. Sending would mean adding code, reviewed separately.
 *
 * Why Day 15 is not Day 10 with the number changed
 * ------------------------------------------------
 * `invoiceReminderMilestones` gives day 15 a required fact that day 10 does
 * not have:
 *
 *     { dayPastDue: 15, audience: "homeowner",
 *       requiredFacts: ["three_percent_fee_applied"] }
 *
 * and `planNotification` enforces it:
 *
 *     if (step && !step.requiredFacts.every(f => event.claimedFacts.includes(f)))
 *       hold("required_template_fact_missing");
 *
 * So a Day 15 event CANNOT pass the gate unless it claims that a 3% late fee
 * was applied. That claim is about the customer's money. We therefore refuse to
 * let the claim exist unless Jobber's own invoice proves it, on that invoice,
 * arithmetically.
 *
 * The two outcomes are both correct:
 *   - Jobber proves the fee  -> "day15-fee-applied" copy, fact claimed, gate can pass.
 *   - Jobber does not        -> "day15-no-fee-claim" copy, fact NOT claimed, and the
 *                               gate holds with `required_template_fact_missing`.
 *                               That is a HOLD, not a send with softened wording.
 *
 * Nothing here decides which of those is true. It only refuses to let the
 * stronger one be asserted without evidence.
 */
import { createHash } from "node:crypto";
import { addInvoiceCalendarDays, invoiceCalendarDate } from "./invoice-reminder-clock";
import type { NotificationSourceRequest } from "./notification-source";

export const DAY15_MILESTONE = 15 as const;
export const DAY15_FEE_FACT = "three_percent_fee_applied" as const;
/** The fee rate the Day 15 copy asserts. Basis points, to avoid float drift. */
export const DAY15_FEE_BASIS_POINTS = 300 as const;

/**
 * Proof, taken from the Jobber invoice itself, that the 3% fee was applied to
 * THIS invoice. A policy document, a workflow name, a GoHighLevel tag or an
 * operator's say-so are not proof and cannot be expressed here.
 */
export type Day15FeeEvidence = Readonly<{
  source: "jobber-invoice-line-item";
  /** Must equal the invoice the reminder is about. */
  invoiceId: string;
  /** The line item name as Jobber returned it. */
  lineItemName: string;
  /** The fee charged, in minor units. */
  feeMinor: number;
  /** The amount the fee was computed on, in minor units. */
  baseMinor: number;
  observedAt: string;
  evidenceRef: string;
}>;

export type Day15TemplatePolicy = "day15-fee-applied" | "day15-no-fee-claim";

export type Day15PilotConfig = Readonly<{
  version: 1; kind: "day15-homeowner-sms-pilot"; reviewRef: string; reviewedAt: string; expiresAt: string;
  source: NotificationSourceRequest;
  destination: string;
  scope: Readonly<{ scheduledOn: string; dayPastDue: 15; audience: "homeowner"; channel: "sms"; maximumAttempts: 1;
    history: "accessible-ghl-plus-local-ledger"; timeZone: "America/Phoenix"; window: "[09:00:00,09:15:00)";
    authorizationRef: string; timingRef: string; credentialBindingRef: string }>;
  /** Day 15 renders money, so an unknown currency is never permitted here. */
  currencyPolicy: Readonly<{ accountId: string; invoiceId: string; currency: string; minorUnitExponent: 2; evidenceRef: string }>;
  sender: Readonly<{ number: string; approvalRef: string; writeScopeEvidenceRef: string }>;
  template: Readonly<{ id: string; version: string; body: string; policy: Day15TemplatePolicy; approvalRef: string }>;
  /** Required when the policy is "day15-fee-applied". Must be null otherwise. */
  feeEvidence: Day15FeeEvidence | null;
  nativeSms: Readonly<{ version: "2021-07-28"; status: "pending"; receiptSource: "app"; semanticsRef: string;
    footer: Readonly<{ mode: "exact-native-suffix"; suffix: string; evidenceRef: string }> }>;
}>;

export type Day15PilotReview = Readonly<{ configSha256: string; reviewRef: string; action: "read-only" }>;
declare const configBrand: unique symbol;
export type ReviewedDay15Pilot = Readonly<{ [configBrand]: true }>;
export type Day15PilotReadiness = Readonly<{
  state: "held" | "reviewed_configuration";
  configSha256: string | null;
  missing: readonly string[];
  actualRuntimeChecks: readonly string[];
  /** What the gate will do with this configuration, stated up front. */
  feeClaim: "proven_by_jobber" | "not_claimed_gate_will_hold" | "unresolved";
  claimedFacts: readonly string[];
  productionSendCapability: false;
  rolloutReady: false;
}>;

const configHandles = new WeakMap<ReviewedDay15Pilot, { config: Day15PilotConfig; review: Day15PilotReview }>();
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const text = (x: unknown): x is string => typeof x === "string" && !!x && x.length <= 256 && x.trim() === x && !/[\x00-\x1f\x7f]/.test(x);
const phone = (x: unknown): x is string => typeof x === "string" && /^\+1[2-9]\d{2}[2-9]\d{6}$/.test(x);
const instant = (x: unknown): number => typeof x === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x) &&
  Number.isFinite(Date.parse(x)) && new Date(Date.parse(x)).toISOString() === x ? Date.parse(x) : NaN;
const minor = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) > 0;
function freeze<T>(x: T): T { if (x && typeof x === "object") { Object.values(x as object).forEach(freeze); Object.freeze(x); } return x; }
function keys(x: unknown, expected: string[]): boolean {
  return !!x && typeof x === "object" && !Array.isArray(x) &&
    Object.keys(x).length === expected.length && Object.keys(x).every(k => expected.includes(k));
}

/** Reused verbatim from the Day 10 pilot's runtime contract. Day 15 adds the last one. */
const actualChecks = Object.freeze(["read_only_existing_token_with_900_second_coverage", "active_deployment_write_holds",
  "opaque_jobber_owner_invoice_and_both_primary_destinations", "fresh_channel_dnd_contact_get_2021_07_28",
  "configured_sender_get_v3", "exhaust_accessible_history_2021_04_15_and_preserve_all_attempts",
  "real_local_ledger_union_and_original_owned_reservation", "fresh_final_source_and_external_rereads",
  "approved_exact_rendered_request_and_single_pending_post_boundary",
  "jobber_proven_three_percent_fee_before_any_fee_claim"]);

/** Any wording that asserts a fee was charged. Matched case-insensitively. */
const FEE_LANGUAGE = /\b(late fee|3%|three percent|fee (?:has been|was|is) (?:applied|added|charged)|service charge)\b/i;

/**
 * Jobber must prove the fee on THIS invoice, arithmetically.
 * `feeMinor` has to be exactly 3% of `baseMinor`, rounded half-up to the minor
 * unit, and the line item has to name itself a fee. Nothing else counts.
 */
export function feeEvidenceProvesThreePercent(evidence: Day15FeeEvidence | null, invoiceId: string): boolean {
  if (!evidence || !keys(evidence, ["source", "invoiceId", "lineItemName", "feeMinor", "baseMinor", "observedAt", "evidenceRef"])) return false;
  if (evidence.source !== "jobber-invoice-line-item") return false;
  if (!text(evidence.invoiceId) || evidence.invoiceId !== invoiceId) return false;
  if (!text(evidence.lineItemName) || !/fee/i.test(evidence.lineItemName)) return false;
  if (!minor(evidence.feeMinor) || !minor(evidence.baseMinor)) return false;
  if (!Number.isFinite(instant(evidence.observedAt)) || !text(evidence.evidenceRef)) return false;
  return evidence.feeMinor === Math.round((evidence.baseMinor * DAY15_FEE_BASIS_POINTS) / 10_000);
}

function readiness(raw: string | undefined, review?: Day15PilotReview): { result: Day15PilotReadiness; config?: Day15PilotConfig } {
  const missing: string[] = [], check = (ok: unknown, name: string) => { if (!ok) missing.push(name); };
  let config: Day15PilotConfig | undefined, configSha256: string | null = null;
  let feeClaim: Day15PilotReadiness["feeClaim"] = "unresolved";
  let claimedFacts: readonly string[] = Object.freeze([]);

  if (typeof raw !== "string" || !raw || Buffer.byteLength(raw, "utf8") > 32_768) missing.push("bounded_config_file");
  else {
    configSha256 = sha(raw);
    try { config = JSON.parse(raw) as Day15PilotConfig; } catch { missing.push("valid_config_json"); }
  }
  const c = config;
  if (c) {
    check(keys(c, ["version", "kind", "reviewRef", "reviewedAt", "expiresAt", "source", "destination", "scope",
      "currencyPolicy", "sender", "template", "feeEvidence", "nativeSms"]), "exact_config_schema");
    check(c.version === 1 && c.kind === "day15-homeowner-sms-pilot", "day15_pilot_version");

    const at = Date.now(), reviewed = instant(c.reviewedAt), expires = instant(c.expiresAt);
    check(text(c.reviewRef) && reviewed <= at && at < expires && expires > reviewed && expires - reviewed <= 86_400_000,
      "current_finite_config_review");

    const s = c.source, accountId = s?.identityCoveragePolicy?.accountId;
    check(s?.version === 1 && text(s.reviewRef) && s.scope && Object.values(s.scope).every(text) &&
      keys(s.scope, ["locationId", "jobberClientId", "contactId", "invoiceId"]) &&
      instant(s.expiresAt) >= expires && text(accountId) && s.originalInvoice &&
      Number.isSafeInteger(s.originalInvoice.totalMinor) && s.originalInvoice.totalMinor > 0 &&
      invoiceCalendarDate(s.originalInvoice.issuedDate) && invoiceCalendarDate(s.originalInvoice.dueDate),
      "exact_source_request_and_original_pins");

    const scope = c.scope;
    check(keys(scope, ["scheduledOn", "dayPastDue", "audience", "channel", "maximumAttempts", "history", "timeZone",
      "window", "authorizationRef", "timingRef", "credentialBindingRef"]) &&
      scope?.dayPastDue === DAY15_MILESTONE && scope.audience === "homeowner" && scope.channel === "sms" &&
      scope.maximumAttempts === 1 && scope.history === "accessible-ghl-plus-local-ledger" &&
      scope.timeZone === "America/Phoenix" && scope.window === "[09:00:00,09:15:00)" &&
      [scope.authorizationRef, scope.timingRef, scope.credentialBindingRef].every(text),
      "finite_day15_sms_scope_and_review_references");

    const due = s?.originalInvoice && invoiceCalendarDate(s.originalInvoice.dueDate);
    check(due && scope?.scheduledOn === addInvoiceCalendarDays(due, DAY15_MILESTONE), "exact_day15_scheduled_date");
    check(phone(c.destination), "exact_homeowner_sms_destination");

    // Day 15 always renders a balance, so an unknown currency is never allowed.
    // `permitsUnknownCurrency` covers day 10 homeowner SMS only.
    const currency = c.currencyPolicy;
    check(keys(currency, ["accountId", "invoiceId", "currency", "minorUnitExponent", "evidenceRef"]) &&
      currency?.accountId === accountId && currency?.invoiceId === s?.scope?.invoiceId &&
      /^[A-Z]{3}$/.test(currency?.currency ?? "") && currency?.minorUnitExponent === 2 && text(currency?.evidenceRef),
      "reviewed_exact_invoice_currency_policy");

    check(keys(c.sender, ["number", "approvalRef", "writeScopeEvidenceRef"]) && phone(c.sender?.number) &&
      text(c.sender?.approvalRef) && text(c.sender?.writeScopeEvidenceRef), "explicit_sender_and_scope_review");

    const t = c.template;
    const policyKnown = t?.policy === "day15-fee-applied" || t?.policy === "day15-no-fee-claim";
    check(keys(t, ["id", "version", "body", "policy", "approvalRef"]) && [t?.id, t?.version, t?.approvalRef].every(text) &&
      policyKnown && typeof t?.body === "string" && t.body.trim() && Buffer.byteLength(t.body, "utf8") <= 4000 &&
      !t.body.includes("\0") && t.body.includes("{{balance}}") &&
      !t.body.replace(/\{\{(balance|invoiceNumber|dueDate)\}\}/g, "").match(/[{}]/),
      "approved_day15_exact_body_rendering_policy");

    // ---- The fee rule. This is the whole reason the module exists. ----
    const invoiceId = s?.scope?.invoiceId;
    const proven = typeof invoiceId === "string" && feeEvidenceProvesThreePercent(c.feeEvidence ?? null, invoiceId);
    const claimsFee = typeof t?.body === "string" && FEE_LANGUAGE.test(t.body);

    if (t?.policy === "day15-fee-applied") {
      check(proven, "jobber_proven_three_percent_fee_for_this_invoice");
      feeClaim = proven ? "proven_by_jobber" : "unresolved";
      claimedFacts = proven ? Object.freeze([DAY15_FEE_FACT]) : Object.freeze([]);
    } else if (t?.policy === "day15-no-fee-claim") {
      // Copy that does not claim the fee must not smuggle it back in, and must
      // not carry evidence it is not using.
      check(!claimsFee, "no_fee_claim_copy_must_not_assert_a_fee");
      check(c.feeEvidence === null, "no_fee_claim_policy_requires_null_fee_evidence");
      feeClaim = "not_claimed_gate_will_hold";
      claimedFacts = Object.freeze([]);
    }
    // Fee language is only ever permitted under the proven policy.
    check(!claimsFee || t?.policy === "day15-fee-applied", "fee_language_requires_fee_applied_policy");

    const n = c.nativeSms;
    check(keys(n, ["version", "status", "receiptSource", "semanticsRef", "footer"]) && n?.version === "2021-07-28" &&
      n.status === "pending" && n.receiptSource === "app" && text(n.semanticsRef), "verified_native_sms_semantics_reference");
    check(keys(n?.footer, ["mode", "suffix", "evidenceRef"]) && n?.footer?.mode === "exact-native-suffix" &&
      typeof n.footer.suffix === "string" && !!n.footer.suffix.trim() && n.footer.suffix.length <= 4096 &&
      text(n.footer.evidenceRef), "exact_native_footer_policy");
  }

  check(review && review.configSha256 === configSha256 && /^[a-f0-9]{64}$/.test(review.configSha256), "out_of_band_reviewed_config_sha256");
  check(review && text(review.reviewRef) && review.reviewRef === c?.reviewRef, "out_of_band_review_reference");
  // Day 15 has no "one-attempt" action. There is no send path in this module.
  check(review?.action === "read-only", "explicit_read_only_runtime_action");

  const result: Day15PilotReadiness = Object.freeze({
    state: missing.length ? "held" : "reviewed_configuration",
    configSha256, missing: Object.freeze(missing), actualRuntimeChecks: actualChecks,
    feeClaim, claimedFacts, productionSendCapability: false, rolloutReady: false,
  });
  return { result, config: missing.length ? undefined : c };
}

/** Static validation only. No clients, env, files, database or network. */
export function inspectDay15PilotReadiness(raw?: string, review?: Day15PilotReview): Day15PilotReadiness {
  try { return readiness(raw, review).result; }
  catch {
    return Object.freeze({ state: "held", configSha256: null, missing: Object.freeze(["malformed_configuration"]),
      actualRuntimeChecks: actualChecks, feeClaim: "unresolved", claimedFacts: Object.freeze([]),
      productionSendCapability: false, rolloutReady: false });
  }
}

/** A hash is an integrity pin, not proof the caller had authority to approve the contents. */
export function reviewDay15PilotConfiguration(raw: string, review: Day15PilotReview) {
  const result = inspectDay15PilotReadiness(raw, review);
  if (result.state !== "reviewed_configuration") return Object.freeze({ readiness: result, handle: null });
  const handle = Object.freeze({}) as ReviewedDay15Pilot;
  configHandles.set(handle, { config: freeze(JSON.parse(raw) as Day15PilotConfig), review: freeze(structuredClone(review)) });
  return Object.freeze({ readiness: result, handle });
}

/** Read back a reviewed configuration. Returns undefined for an unknown handle. */
export function inspectReviewedDay15Configuration(handle: ReviewedDay15Pilot): Day15PilotConfig | undefined {
  return configHandles.get(handle)?.config;
}

/**
 * Render the approved body against a verified source snapshot.
 * Separate from the gate on purpose: this cannot invent a balance, and it
 * refuses an invoice number it was not given.
 */
export function renderDay15Body(config: Day15PilotConfig,
  snapshot: Readonly<{ balanceMinor: number; invoiceNumber?: string | null; dueOn: string }>): string {
  if (!minor(snapshot.balanceMinor)) throw new Error("day15_requires_positive_balance");
  if (config.template.body.includes("{{invoiceNumber}}") && !snapshot.invoiceNumber) throw new Error("invoice_display_number_required");
  const balance = `${config.currencyPolicy.currency} ${Math.floor(snapshot.balanceMinor / 100)}.${String(snapshot.balanceMinor % 100).padStart(2, "0")}`;
  return config.template.body.replace(/\{\{(balance|invoiceNumber|dueDate)\}\}/g, (_, token: string) =>
    token === "balance" ? balance : token === "invoiceNumber" ? snapshot.invoiceNumber! : snapshot.dueOn);
}

/** The facts this configuration is entitled to claim. Never a default. */
export function day15ClaimedFacts(config: Day15PilotConfig): readonly string[] {
  return config.template.policy === "day15-fee-applied" &&
    feeEvidenceProvesThreePercent(config.feeEvidence, config.source.scope.invoiceId)
    ? Object.freeze([DAY15_FEE_FACT]) : Object.freeze([]);
}
