/**
 * Overlap guard: never let our Day 15 EMAIL go to a contact the legacy
 * GoHighLevel "Fixed Automation" text ladder could also reach on the same day.
 *
 * WHY A TAG IS THE GATE, AND WHY THAT IS NOT A GUESS.
 * Fixed Automation has exactly one trigger, "Pipeline stage changed", and that
 * trigger carries THREE required filters, all of which must hold for a contact
 * to enter the workflow at all:
 *     In pipeline     = Invoice Pipeline
 *     Pipeline stage  = Invoice Overdue
 *     Tag  Equals to  = flex-native-paula-approved
 * The tag filter is an allow-list on the only entry point, so a contact without
 * that tag cannot be enrolled and cannot be texted by either branch. Both
 * branches (irrigation and maintenance) sit behind that same single trigger;
 * neither has an entry point of its own. Verified in the action settings in the
 * GoHighLevel builder on 2026-11-17, read from the trigger's own filter rows
 * rather than from step names.
 *
 * WHAT THIS GUARD CANNOT SEE, STATED PLAINLY.
 * The GoHighLevel API exposes no way to ask whether a contact is currently
 * enrolled in a workflow. Every candidate endpoint returns 404
 * (/contacts/{id}/workflow, /contacts/{id}/workflows, /workflows/{id}/contacts,
 * /workflows/{id}, /workflows/{id}/status), the workflow record carries only
 * createdAt, id, locationId, name, status, updatedAt and version — no
 * enrolment counts — and the contact record has no workflow, campaign or
 * automation field at all. So "this contact has no active legacy enrolment"
 * cannot be read. It is instead derived from the trigger gate above, and that
 * derivation is only sound while no OTHER published workflow enrols into the
 * legacy ladder or writes the gate tag. That second fact is also unreadable
 * through the API, so it must be supplied as a dated human attestation. Absent,
 * malformed or stale, the guard holds. The guard never reads "unknown" as
 * "clear".
 *
 * This module decides nothing about tagging and writes nothing. It adds holds.
 */

/** The allow-list tag on Fixed Automation's only trigger. Exact, case-sensitive. */
export const NATIVE_SMS_GATE_TAG = "flex-native-paula-approved";

/** The bypass tag read inside the irrigation branch only. Informational here. */
export const NATIVE_SMS_PILOT_SKIP_TAG = "day15-pilot";

/** How long a workflow-inventory attestation stays usable, in days. */
export const NATIVE_SMS_ATTESTATION_MAX_AGE_DAYS = 7;

/**
 * A dated human statement about the GoHighLevel workflow inventory. It stands
 * in for the enrolment read the API will not give us, and it expires.
 */
export interface NativeSmsAttestation {
  /** Phoenix calendar date the workflow inventory was read, YYYY-MM-DD. */
  reviewedOn: string;
  /** Count of published workflows seen at that review. A change invalidates it. */
  publishedWorkflowCount: number;
  /**
   * Fixed Automation's ACTIVE enrolment count, read from the workflow's own
   * enrolment panel in the builder at that review. This is the only readable
   * proxy for "is anyone inside the ladder right now", and it is the one thing
   * the tag check cannot cover: a contact enrolled while tagged stays enrolled
   * after the tag is removed, because the filters are evaluated at entry only.
   * Anything other than exactly 0 holds.
   */
  activeEnrolments: number;
  /**
   * True only when a person confirmed, at that review, that no other published
   * workflow enrols a contact into the legacy Day 15 ladder and none of them
   * adds the gate tag. Anything other than exactly true holds.
   */
  noOtherEnrolmentPath: boolean;
}

export interface NativeSmsOverlapInput {
  /**
   * Every tag on the single exactly-matched destination contact, as read in the
   * same decision. null means the tags could not be read, or there was not
   * exactly one contact to read them from. Either way this holds.
   */
  contactTags: readonly string[] | null;
  attestation: NativeSmsAttestation | null | undefined;
  /** The decision instant. Used only to age the attestation. */
  now: Date;
  /** Published-workflow count observed now, when a fresh read is available. */
  observedPublishedWorkflowCount?: number | null;
  maxAgeDays?: number;
}

const DAY_MS = 86_400_000;
/** Phoenix never observes DST, so a Phoenix day starts at exactly 07:00 UTC. */
const PHOENIX_DAY_START_UTC_HOURS = 7;

function phoenixDayStartMs(calendarDay: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(calendarDay)) return null;
  const ms = Date.parse(`${calendarDay}T0${PHOENIX_DAY_START_UTC_HOURS}:00:00.000Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Returns the holds this guard adds. An EMPTY array means the contact is
 * provably outside the legacy text ladder's only entry point. Any non-empty
 * result means do not send.
 */
export function nativeSmsOverlapHolds(input: NativeSmsOverlapInput): string[] {
  const holds: string[] = [];

  const attestation = input.attestation;
  if (!attestation || typeof attestation !== "object") {
    holds.push("native_sms_enrolment_unattested: no workflow-inventory attestation supplied");
  } else if (attestation.noOtherEnrolmentPath !== true) {
    holds.push("native_sms_enrolment_unattested: attestation does not rule out another enrolment path");
  } else {
    const reviewedMs = phoenixDayStartMs(String(attestation.reviewedOn ?? ""));
    const nowMs = input.now instanceof Date ? input.now.getTime() : NaN;
    if (reviewedMs === null || !Number.isFinite(nowMs)) {
      holds.push("native_sms_attestation_undated: review date or decision time unusable");
    } else if (reviewedMs > nowMs) {
      holds.push("native_sms_attestation_undated: review date is in the future");
    } else {
      const maxAge = typeof input.maxAgeDays === "number" && Number.isFinite(input.maxAgeDays) && input.maxAgeDays > 0
        ? input.maxAgeDays : NATIVE_SMS_ATTESTATION_MAX_AGE_DAYS;
      // Whole Phoenix days: an attestation reviewed N calendar days ago is
      // exactly N days old whatever the hour of the decision.
      const todayStart = Math.floor((nowMs - PHOENIX_DAY_START_UTC_HOURS * 3_600_000) / DAY_MS) * DAY_MS
        + PHOENIX_DAY_START_UTC_HOURS * 3_600_000;
      const ageDays = (todayStart - reviewedMs) / DAY_MS;
      if (ageDays > maxAge) {
        holds.push(`native_sms_attestation_stale: reviewed ${attestation.reviewedOn}, ` +
          `older than ${maxAge} days`);
      }
    }
    if (!Number.isInteger(attestation.activeEnrolments) || attestation.activeEnrolments !== 0) {
      holds.push(`native_sms_active_enrolments: ${typeof attestation.activeEnrolments === "number"
        ? attestation.activeEnrolments : "unread"} contacts are inside the legacy ladder`);
    }
    const observed = input.observedPublishedWorkflowCount;
    if (typeof observed === "number" && Number.isFinite(observed) &&
        observed !== attestation.publishedWorkflowCount) {
      holds.push(`native_sms_workflow_inventory_changed: attested ` +
        `${attestation.publishedWorkflowCount} published, now ${observed}`);
    }
  }

  holds.push(...nativeSmsTagHolds(input.contactTags));
  return holds;
}

/**
 * The tag half of the guard on its own, for the send path, where the contact's
 * tags are re-read within 60 seconds of the decision and no attestation is in
 * scope. Empty means the gate tag is provably absent from a readable tag list.
 */
export function nativeSmsTagHolds(contactTags: readonly string[] | null | undefined): string[] {
  const holds: string[] = [];
  const tags = contactTags;
  if (!Array.isArray(tags)) {
    holds.push("native_sms_contact_tags_unreadable: cannot prove the gate tag is absent");
  } else if (tags.some(tag => typeof tag !== "string")) {
    holds.push("native_sms_contact_tags_unreadable: tag list contains an unreadable entry");
  } else if (tags.includes(NATIVE_SMS_GATE_TAG)) {
    holds.push(`native_sms_gate_tag_present: contact carries ${NATIVE_SMS_GATE_TAG}`);
  } else if (tags.some(tag => tag.trim().toLowerCase() === NATIVE_SMS_GATE_TAG &&
      tag !== NATIVE_SMS_GATE_TAG)) {
    // A differently-cased or padded near-match cannot be ruled in or out without
    // knowing how GoHighLevel compares the trigger filter. It holds.
    holds.push(`native_sms_gate_tag_ambiguous: a near-match of ${NATIVE_SMS_GATE_TAG} is present`);
  }

  return holds;
}
