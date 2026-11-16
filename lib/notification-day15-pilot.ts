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

/**
 * Three policies, because the live approved Day 15 copy is none of the two
 * obvious ones. It reads, in part:
 *
 *   "A late fee of 3% MAY APPLY under your invoice terms, and we kindly ask
 *    this invoice be paid to avoid POTENTIAL late fees."
 *
 * That warns about a fee. It does not claim one was charged. Treating it as a
 * claim would be wrong, and treating it as fee-free would let a real claim slip
 * through later, so it gets a policy of its own.
 *
 *   day15-fee-applied   asserts the fee -> requires Jobber proof
 *   day15-fee-may-apply warns about it  -> asserts nothing, proves nothing
 *   day15-no-fee-claim  silent about it -> no fee wording at all
 */
export type Day15TemplatePolicy = "day15-fee-applied" | "day15-fee-may-apply" | "day15-no-fee-claim";

/**
 * The exact copy approved in the Fixed Automation `SMS - Day 15` step,
 * read 2026-11-16. Pinned so drift is visible.
 *
 * Note what it does NOT contain: any amount. It names no balance, so it needs
 * no currency policy and no rendering. Same shape as ORIGINAL_DAY10_SMS_BODY.
 */
export const APPROVED_DAY15_SMS_BODY =
  "Hello {{Contact.First Name}},\n\nThis is your reminder that your invoice is past due. " +
  "A late fee of 3% may apply under your invoice terms, and we kindly ask this invoice be paid " +
  "to avoid potential late fees. If you have any questions or concerns please reach out to our " +
  "office at 602-329-7865.";

/**
 * The approved copy does not just warn about a fee -- it says the fee applies
 * "under your invoice terms". That is a claim about the invoice. If the terms
 * say nothing about a late fee, the sentence is not true, so the warning needs
 * its own evidence, taken from Jobber.
 */
export type Day15TermsEvidence = Readonly<{
  source: "jobber-invoice-terms";
  invoiceId: string;
  /** The terms text as Jobber returned it. Must itself support the claim. */
  termsExcerpt: string;
  /** Must be true, AND must be visible in termsExcerpt. Asserting it is not enough. */
  statesLateFee: true;
  observedAt: string;
  evidenceRef: string;
}>;

/**
 * A record that this homeowner agreed to receive billing texts.
 *
 * This is NOT derivable from DND. An absent SMS setting means GoHighLevel holds
 * no suppression for the contact; it is not consent, and this type cannot be
 * constructed from it. `source` has no "no_dnd_record" member on purpose.
 */
export type Day15SmsConsent = Readonly<{
  source: "signed-agreement" | "written-reply" | "recorded-verbal";
  contactId: string;
  /** Consent to marketing or service texts is not consent to billing texts. */
  scope: "billing-sms";
  recordedAt: string;
  evidenceRef: string;
}>;

export type Day15PilotConfig = Readonly<{
  version: 1; kind: "day15-homeowner-sms-pilot"; reviewRef: string; reviewedAt: string; expiresAt: string;
  source: NotificationSourceRequest;
  destination: string;
  scope: Readonly<{ scheduledOn: string; dayPastDue: 15; audience: "homeowner"; channel: "sms"; maximumAttempts: 1;
    history: "accessible-ghl-plus-local-ledger"; timeZone: "America/Phoenix"; window: "[09:00:00,09:15:00)";
    authorizationRef: string; timingRef: string; credentialBindingRef: string }>;
  /** Required whenever the body renders an amount. Null is allowed ONLY for the
   *  approved static copy, which names no amount at all. */
  currencyPolicy: Readonly<{ accountId: string; invoiceId: string; currency: string; minorUnitExponent: 2; evidenceRef: string }> | null;
  sender: Readonly<{ number: string; approvalRef: string; writeScopeEvidenceRef: string }>;
  template: Readonly<{ id: string; version: string; body: string; policy: Day15TemplatePolicy; approvalRef: string }>;
  /** Required when the policy is "day15-fee-applied". Must be null otherwise. */
  feeEvidence: Day15FeeEvidence | null;
  /** Required when the policy is "day15-fee-may-apply". Must be null otherwise. */
  termsEvidence: Day15TermsEvidence | null;
  /** Required always. A pilot send needs a homeowner who agreed to billing texts. */
  smsConsent: Day15SmsConsent | null;
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

/** Any mention of a fee at all, asserted or not. */
const FEE_MENTION = /\b(late fee|late fees|3\s?%|three percent|service charge)\b/i;
/**
 * Wording that ASSERTS a fee was actually charged. This is the dangerous shape:
 * it is a statement about the customer's balance, so it needs Jobber's proof.
 * "may apply", "could apply", "potential" are warnings and are not matched.
 */
const FEE_ASSERTED = /\b(?:fee|charge)s?\b[^.!?]{0,40}\b(?:has been|have been|was|were|is|are)\s+(?:now\s+)?(?:applied|added|charged|assessed)\b|\b(?:applied|added|charged|assessed)\s+(?:a\s+)?(?:3\s?%\s+)?(?:late\s+)?fee\b|\byour\s+balance\s+(?:now\s+)?includes\b/i;
/** Explicit conditional language. Required for the "may apply" policy. */
const FEE_CONDITIONAL = /\b(may|might|could|can|will)\s+(?:apply|be applied|be added|be charged)\b|\bpotential\b|\bto avoid\b/i;

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

/** The terms text must itself mention a late fee. `statesLateFee: true` alone is a claim, not proof. */
const TERMS_STATE_A_FEE = /\b(late fee|late charge|finance charge|past[- ]due (?:fee|charge)|3\s?%)\b/i;
export function termsEvidenceSupportsWarning(evidence: Day15TermsEvidence | null, invoiceId: string): boolean {
  if (!evidence || !keys(evidence, ["source", "invoiceId", "termsExcerpt", "statesLateFee", "observedAt", "evidenceRef"])) return false;
  if (evidence.source !== "jobber-invoice-terms") return false;
  if (!text(evidence.invoiceId) || evidence.invoiceId !== invoiceId) return false;
  if (evidence.statesLateFee !== true) return false;
  if (typeof evidence.termsExcerpt !== "string" || !evidence.termsExcerpt.trim() ||
      evidence.termsExcerpt.length > 4000) return false;
  if (!Number.isFinite(instant(evidence.observedAt)) || !text(evidence.evidenceRef)) return false;
  return TERMS_STATE_A_FEE.test(evidence.termsExcerpt);
}

/**
 * Consent to billing texts, recorded from the homeowner.
 * There is deliberately no path from a DND reading to this value: "no SMS
 * suppression on file" is not consent and cannot satisfy this check.
 */
export function smsConsentIsRecorded(consent: Day15SmsConsent | null, contactId: string): boolean {
  if (!consent || !keys(consent, ["source", "contactId", "scope", "recordedAt", "evidenceRef"])) return false;
  if (!["signed-agreement", "written-reply", "recorded-verbal"].includes(consent.source)) return false;
  if (!text(consent.contactId) || consent.contactId !== contactId) return false;
  if (consent.scope !== "billing-sms") return false;
  const at = instant(consent.recordedAt);
  return Number.isFinite(at) && at <= Date.now() && text(consent.evidenceRef);
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
      "currencyPolicy", "sender", "template", "feeEvidence", "termsEvidence", "smsConsent", "nativeSms"]),
      "exact_config_schema");
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

    // The approved static copy names no amount, so it needs no currency policy
    // and no balance placeholder. Anything else renders money and needs both.
    // `permitsUnknownCurrency` covers day 10 homeowner SMS only, never day 15.
    const isApprovedStaticCopy = c.template?.body === APPROVED_DAY15_SMS_BODY;
    const currency = c.currencyPolicy;
    const validCurrency = keys(currency, ["accountId", "invoiceId", "currency", "minorUnitExponent", "evidenceRef"]) &&
      currency?.accountId === accountId && currency?.invoiceId === s?.scope?.invoiceId &&
      /^[A-Z]{3}$/.test(currency?.currency ?? "") && currency?.minorUnitExponent === 2 && text(currency?.evidenceRef);
    check(isApprovedStaticCopy ? currency === null || validCurrency : validCurrency,
      "reviewed_exact_invoice_currency_policy");

    check(keys(c.sender, ["number", "approvalRef", "writeScopeEvidenceRef"]) && phone(c.sender?.number) &&
      text(c.sender?.approvalRef) && text(c.sender?.writeScopeEvidenceRef), "explicit_sender_and_scope_review");

    const t = c.template;
    const policyKnown = t?.policy === "day15-fee-applied" || t?.policy === "day15-fee-may-apply" ||
      t?.policy === "day15-no-fee-claim";
    check(keys(t, ["id", "version", "body", "policy", "approvalRef"]) && [t?.id, t?.version, t?.approvalRef].every(text) &&
      policyKnown && typeof t?.body === "string" && t.body.trim() && Buffer.byteLength(t.body, "utf8") <= 4000 &&
      !t.body.includes("\0") && (isApprovedStaticCopy || t.body.includes("{{balance}}")) &&
      (isApprovedStaticCopy ||
        !t.body.replace(/\{\{(balance|invoiceNumber|dueDate)\}\}/g, "").match(/[{}]/)),
      "approved_day15_exact_body_rendering_policy");

    // ---- The fee rule. This is the whole reason the module exists. ----
    const invoiceId = s?.scope?.invoiceId;
    const proven = typeof invoiceId === "string" && feeEvidenceProvesThreePercent(c.feeEvidence ?? null, invoiceId);
    const body = typeof t?.body === "string" ? t.body : "";
    const asserts = FEE_ASSERTED.test(body);
    const mentions = FEE_MENTION.test(body);
    const conditional = FEE_CONDITIONAL.test(body);

    if (t?.policy === "day15-fee-applied") {
      check(proven, "jobber_proven_three_percent_fee_for_this_invoice");
      feeClaim = proven ? "proven_by_jobber" : "unresolved";
      claimedFacts = proven ? Object.freeze([DAY15_FEE_FACT]) : Object.freeze([]);
    } else if (t?.policy === "day15-fee-may-apply") {
      // A warning, not a claim. It must actually be conditional, and it must
      // not assert. It claims no FACT, so it needs no fee evidence -- but the
      // approved copy says the fee applies "under your invoice terms", which
      // is itself a statement about the invoice, so the TERMS must back it.
      check(!asserts, "may_apply_copy_must_not_assert_a_fee_was_applied");
      check(mentions && conditional, "may_apply_copy_must_state_the_condition_explicitly");
      check(c.feeEvidence === null, "may_apply_policy_requires_null_fee_evidence");
      check(typeof invoiceId === "string" && termsEvidenceSupportsWarning(c.termsEvidence ?? null, invoiceId),
        "jobber_invoice_terms_must_support_the_fee_warning");
      feeClaim = "not_claimed_gate_will_hold";
      claimedFacts = Object.freeze([]);
    } else if (t?.policy === "day15-no-fee-claim") {
      // Silent about the fee. Any mention at all belongs under another policy.
      check(!mentions, "no_fee_claim_copy_must_not_mention_a_fee");
      check(c.feeEvidence === null, "no_fee_claim_policy_requires_null_fee_evidence");
      check(c.termsEvidence === null, "no_fee_claim_policy_requires_null_terms_evidence");
      feeClaim = "not_claimed_gate_will_hold";
      claimedFacts = Object.freeze([]);
    }
    // An assertion is only ever permitted under the proven policy.
    check(!asserts || t?.policy === "day15-fee-applied", "asserted_fee_requires_fee_applied_policy");
    // Terms evidence belongs only to the warning policy.
    check(t?.policy === "day15-fee-may-apply" || c.termsEvidence === null, "terms_evidence_requires_may_apply_policy");

    // ---- Consent. Required for every policy, with no DND-derived path to it. ----
    check(typeof s?.scope?.contactId === "string" && smsConsentIsRecorded(c.smsConsent ?? null, s.scope.contactId),
      "recorded_homeowner_consent_to_billing_sms");

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
  // The approved static copy names no amount. Nothing to render, nothing to get wrong.
  if (config.template.body === APPROVED_DAY15_SMS_BODY) return config.template.body;
  if (!config.currencyPolicy) throw new Error("monetary_rendering_requires_reviewed_currency");
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
