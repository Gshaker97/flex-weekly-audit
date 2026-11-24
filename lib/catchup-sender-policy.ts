/**
 * WHO THE CATCH-UP IS SENT FROM, and the two people it is sent to differently.
 *
 * Pure data and pure predicates. Nothing here sends, and nothing here grants
 * permission to send - the reviewed sender objects the contract demands are
 * still assembled by the deployment, which owns the credential. This module
 * only pins WHICH addresses those reviews are allowed to be about, so a typo or
 * a swapped sender cannot slip through unnoticed.
 *
 * THE EMAIL ADDRESS, AND HOW IT WAS ESTABLISHED. Read from GHL read-only on
 * 2026-11-24: the location record for Flexx Landscaping carries
 * `preston@flexxlandscaping.com` as both `location.email` and
 * `location.business.email`, and that is the only address GHL exposes for the
 * LOCATION itself. `/users/?locationId=` lists five staff addresses, but those
 * are logins, not the location's sending identity, so none of them is pinned.
 *
 * WHAT COULD NOT BE ESTABLISHED, AND MUST BE CHECKED BY A PERSON. The API
 * exposes no verified-sending-identity or dedicated-domain endpoint at all -
 * `/emails/verified-identities`, `/emails/dedicated-domains` and
 * `/locations/<id>/dedicated-domains` are all 404, and `/emails/builder`
 * returns templates with no from-address. So NOTHING here proves
 * flexxlandscaping.com is verified for sending. If it is not, these emails
 * either fail or land in spam. That is a deliverability question for the GHL
 * UI, deliberately left as a human check rather than guessed at here.
 */
import { LADDER_SMS_SENDER } from "./notification-ladder-sender-policy";

/** The pinned SMS sender, reused rather than restated so the two cannot drift. */
export const CATCHUP_SMS_SENDER = LADDER_SMS_SENDER;

export const CATCHUP_EMAIL_SENDER = Object.freeze({
  address: "preston@flexxlandscaping.com",
  /** How this address was arrived at, not an assertion that it works. */
  source: "ghl-location-record" as const,
  observedOn: "2026-11-24" as const,
  evidenceRef: "GET /locations/<id>: location.email and location.business.email",
  /**
   * FALSE, and only a person can change it. No API endpoint reports whether the
   * sending domain is verified, so this stays false until somebody confirms it
   * in the GHL UI. A sender review built while this is false should be treated
   * as unproven for deliverability.
   */
  sendingDomainVerified: false as const,
});

/**
 * The two people who get an email and no text, by name, with the reason.
 *
 * A BOUNDED LIST, NOT A RULE. "No phone, so email only" as a general rule would
 * quietly halve the approved message for anyone whose contact record happens to
 * be thin. These two were checked individually against Jobber and approved
 * individually by the owner on 2026-11-24, so they are written down one by one
 * and everybody else still holds.
 */
export const CATCHUP_EMAIL_ONLY_EXCEPTIONS = Object.freeze({
  /** No phone number in Jobber or GHL. There is nothing to text. */
  "7259": Object.freeze({
    clientName: "Joshua Heyrend",
    reason: "no_phone_in_jobber_or_ghl" as const,
    evidenceRef: "Jobber client.phones empty 2026-11-24; GHL contact has no phone",
  }),
  /**
   * RESOLVED 2026-11-24, AND KEPT ANYWAY AS A FALLBACK.
   *
   * Jobber had a phone for Brian Carey but his GHL contact did not, and the
   * send contract requires the destination to be an exact association of the
   * contact (`destination_not_exact_contact_association`), so he was email
   * only. The owner then approved a single CRM write and the number was copied
   * onto his GHL contact (one field, verified before and after, nothing else
   * touched). He now plans as an ordinary both-channel recipient.
   *
   * This entry stays because it costs nothing and protects something: the
   * exception only applies when the contact has NO phone
   * (`emailOnly = !phone && catchupIsEmailOnly(...)`). So with the number in
   * place it is inert, and if that number were ever removed from the contact
   * again he would fall back to email only rather than holding entirely and
   * going unmessaged.
   */
  "7299": Object.freeze({
    clientName: "Brian Carey",
    reason: "jobber_has_a_phone_but_the_ghl_contact_does_not" as const,
    evidenceRef: "Jobber client.phones had 1 primary number 2026-11-24; "
      + "copied onto the GHL contact by approved write 2026-11-24, exception now inert",
  }),
} as const);

export type CatchupEmailOnlyReason =
  (typeof CATCHUP_EMAIL_ONLY_EXCEPTIONS)[keyof typeof CATCHUP_EMAIL_ONLY_EXCEPTIONS]["reason"];

/**
 * Is EVERY invoice in this message covered by a named email-only exception?
 *
 * All of them, deliberately. A customer with one excepted invoice and one
 * ordinary one is not an email-only customer; they are a customer whose text
 * should have gone out, and silently dropping it would be the exact failure the
 * bounded list exists to prevent.
 */
export function catchupIsEmailOnly(invoiceNumbers: readonly string[]): boolean {
  if (!Array.isArray(invoiceNumbers) || invoiceNumbers.length === 0) return false;
  return invoiceNumbers.every(number =>
    typeof number === "string"
    && Object.hasOwn(CATCHUP_EMAIL_ONLY_EXCEPTIONS, number.trim()));
}

/** The named reason for each excepted invoice, for the run's own record. */
export function catchupEmailOnlyReasons(invoiceNumbers: readonly string[]): readonly string[] {
  if (!Array.isArray(invoiceNumbers)) return Object.freeze([]);
  const reasons = invoiceNumbers
    .map(number => typeof number === "string" ? number.trim() : "")
    .filter(number => Object.hasOwn(CATCHUP_EMAIL_ONLY_EXCEPTIONS, number))
    .map(number => `${number}:${(CATCHUP_EMAIL_ONLY_EXCEPTIONS as Record<string, { reason: string }>)[number].reason}`);
  return Object.freeze([...new Set(reasons)].sort());
}
