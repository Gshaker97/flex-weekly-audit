/** Reviewed Day 10 config gate. Returns blocker names and the allowlist binding only.
 * Destination, sender, footer, account id, and quarantine values are never returned.
 */
import { createHash } from "node:crypto";
import { PAULA_DAY10_ALLOWLIST, type ReminderConfigBinding } from "./invoice-reminder-automatic";
import { ORIGINAL_DAY10_SMS_BODY } from "./notification-copy-policy";
import { inspectDay10PilotReadiness } from "./notification-day10-pilot";

export type AutomaticReminderConfigInspection = Readonly<{
  blockers: readonly string[];
  binding: ReminderConfigBinding;
}>;

const emptyBinding = (): ReminderConfigBinding => Object.freeze({
  contactId: null, invoiceId: null, clientId: null, scheduledOn: null,
});

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value;
}

export function inspectAutomaticReminderConfig(raw: string | undefined, sha256: string | undefined, reviewRef: string | undefined): AutomaticReminderConfigInspection {
  const blockers: string[] = [];
  if (typeof raw !== "string" || !raw || Buffer.byteLength(raw, "utf8") > 32_768 || typeof sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(sha256) || typeof reviewRef !== "string" || !reviewRef.trim()) {
    return Object.freeze({ blockers: Object.freeze(["required_config_missing"]), binding: emptyBinding() });
  }
  if (createHash("sha256").update(raw, "utf8").digest("hex") !== sha256) blockers.push("required_config_missing");
  if (raw.includes(PAULA_DAY10_ALLOWLIST.forbiddenOpportunityId)) blockers.push("forbidden_opportunity_present");
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  if (!parsed || typeof parsed !== "object") {
    return Object.freeze({ blockers: Object.freeze(["required_config_missing"]), binding: emptyBinding() });
  }
  const contactId = parsed.source?.scope?.contactId;
  const invoiceId = parsed.source?.scope?.invoiceId;
  const clientId = parsed.source?.scope?.jobberClientId;
  const scheduledOn = parsed.scope?.scheduledOn;
  if (!text(parsed.sender?.number)) blockers.push("sender_number_unconfigured");
  if (!text(parsed.nativeSms?.footer?.suffix)) blockers.push("native_footer_unconfigured");
  if (!text(parsed.source?.identityCoveragePolicy?.accountId)) blockers.push("jobber_account_id_unconfigured");
  const quarantine = parsed.source?.identityCoveragePolicy?.quarantine;
  if (!Array.isArray(quarantine) || quarantine.length !== 2) blockers.push("quarantine_identities_unconfigured");
  if (!text(parsed.destination)) blockers.push("destination_unconfigured");
  if (parsed.template?.body !== ORIGINAL_DAY10_SMS_BODY) blockers.push("unapproved_day10_body");
  if (contactId !== PAULA_DAY10_ALLOWLIST.contactId) blockers.push("allowlist_contact_mismatch");
  if (scheduledOn !== PAULA_DAY10_ALLOWLIST.scheduledOn || parsed.scope?.dayPastDue !== 10 ||
      parsed.scope?.audience !== "homeowner" || parsed.scope?.channel !== "sms") blockers.push("scope_not_day10_sms");
  const readiness = inspectDay10PilotReadiness(raw, { configSha256: sha256, reviewRef, action: "one-attempt" });
  if (readiness.state !== "reviewed_configuration") blockers.push("required_config_missing");
  return Object.freeze({
    blockers: Object.freeze([...new Set(blockers)]),
    binding: Object.freeze({
      contactId: text(contactId) ? contactId : null,
      invoiceId: text(invoiceId) ? invoiceId : null,
      clientId: text(clientId) ? clientId : null,
      scheduledOn: text(scheduledOn) ? scheduledOn : null,
    }),
  });
}
