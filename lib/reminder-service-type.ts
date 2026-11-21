import type { InvoiceReminderCategory } from "./invoice-reminder-clock";

/**
 * Service type resolution for reminder milestones.
 *
 * Why this module exists: the ladder length depends on the service type
 * (maintenance runs to day 30, irrigation stops at day 15), and the only signal
 * previously used was a GoHighLevel contact tag, with "no irrigation tag"
 * silently read as maintenance. That is unsafe in both directions. One observed
 * client is tagged "Irrigation Promotion" in Jobber and billed on an
 * "Irrigation Diagnostic Promotion" line item, while the matched GHL contact
 * carries no tags at all, so the default treated it as maintenance and planned a
 * day 20, 25 and 30 that the irrigation ladder does not contain.
 *
 * Rules:
 *  - Jobber is the authoritative source. Its client tags and invoice line items
 *    are what the customer is actually billed for.
 *  - GoHighLevel can only ever positively assert irrigation. An absent tag is
 *    silence, never a maintenance assertion.
 *  - Anything unknown, one-sided, or contradictory resolves to no category, and
 *    the caller must hold rather than pick a ladder.
 */
export type ServiceTypeSource = "agreed" | "jobber_only" | "conflict" | "unknown";
export type ServiceTypeResolution = Readonly<{
  category: InvoiceReminderCategory | null;
  source: ServiceTypeSource;
  /** Safe to log and show in a review: labels only, never contact details. */
  evidence: Readonly<{ jobber: string[]; ghl: string[] }>;
  detail: string;
}>;

const IRRIGATION = /irrigation/i;
const MAINTENANCE = /maintenance/i;

function labels(values: readonly string[] | null | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map(value => value.trim())
    .slice(0, 20);
}

/** Jobber signal from client tags plus invoice line items, taken together. */
function jobberSignal(signals: string[]): InvoiceReminderCategory | null | "conflict" {
  if (!signals.length) return null;
  const irrigation = signals.some(value => IRRIGATION.test(value));
  const maintenance = signals.some(value => MAINTENANCE.test(value));
  if (irrigation && maintenance) return "conflict";
  if (irrigation) return "irrigation";
  if (maintenance) return "maintenance";
  return null;
}

export function resolveServiceType(input: {
  /** null/undefined means the signal was not readable, which is not the same as empty. */
  jobberClientTags?: readonly string[] | null;
  jobberLineItemNames?: readonly string[] | null;
  /** Tags of the single exactly-matched GHL contact, or null when there is not exactly one. */
  ghlContactTags?: readonly string[] | null;
}): ServiceTypeResolution {
  const jobberLabels = [...labels(input.jobberClientTags), ...labels(input.jobberLineItemNames)];
  const ghlLabels = labels(input.ghlContactTags);
  const evidence = Object.freeze({ jobber: jobberLabels, ghl: ghlLabels });
  const jobber = jobberSignal(jobberLabels);

  if (jobber === "conflict") {
    return Object.freeze({ category: null, source: "conflict", evidence,
      detail: "Jobber asserts both irrigation and maintenance for this invoice" });
  }
  if (jobber === null) {
    return Object.freeze({ category: null, source: "unknown", evidence,
      detail: "Jobber gives no service-type signal; a GoHighLevel tag alone cannot decide it" });
  }
  // GoHighLevel may only positively assert irrigation; silence is not maintenance.
  const ghlAssertsIrrigation = ghlLabels.some(value => IRRIGATION.test(value));
  if (ghlAssertsIrrigation && jobber !== "irrigation") {
    return Object.freeze({ category: null, source: "conflict", evidence,
      detail: `Jobber says ${jobber} but the GoHighLevel contact is tagged irrigation` });
  }
  if (ghlAssertsIrrigation && jobber === "irrigation") {
    return Object.freeze({ category: "irrigation", source: "agreed", evidence,
      detail: "Jobber and GoHighLevel both say irrigation" });
  }
  // Jobber is decisive but uncorroborated. Resolvable, and still held by the
  // caller until an operator confirms it, because this is exactly the case the
  // old GHL-tag default got wrong.
  return Object.freeze({ category: jobber, source: "jobber_only", evidence,
    detail: `Only Jobber asserts ${jobber}; needs operator confirmation before a ladder is chosen` });
}

/** A ladder may be chosen only when both sources agree. Everything else holds. */
export function serviceTypeIsConfirmed(resolution: ServiceTypeResolution): boolean {
  return resolution.source === "agreed" && resolution.category !== null;
}
