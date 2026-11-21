import { createHash } from "node:crypto";
import { eventKey } from "../../lib/notification-gate.ts";
import { addInvoiceCalendarDays } from "../../lib/invoice-reminder-clock.ts";
export const BODY = "SYNTHETIC TEST ONLY: invoice reminder";
export const NOW = new Date("2026-11-09T16:00:00.000Z"); // 09:00 Phoenix.
const required = { 10: [], 15: ["three_percent_fee_applied"], 20: ["recurring_late_fee_policy"],
  21: [], 25: ["recurring_late_fee_policy"], 30: ["service_suspended", "collections_after_day_35_policy"] };
export function fixture({ day = 10, category = null, channel = "sms", now = NOW } = {}) {
  const audience = day === 21 ? "internal" : "homeowner";
  const event = { accountId: "synthetic-account", invoiceId: "synthetic-invoice", dayPastDue: day, audience,
    sourceRevision: "source-v1", ownerRevision: "owner-v1", ownerId: "synthetic-owner",
    homeownerContactId: "synthetic-homeowner-contact", issuedDate: "2026-09-01",
    dueDate: addInvoiceCalendarDays("2026-11-09", -day), balanceMinor: 12000, currency: "USD", category,
    recipientId: audience === "internal" ? "synthetic-internal-user" : "synthetic-owner",
    contactId: audience === "internal" ? "synthetic-internal-contact" : "synthetic-homeowner-contact",
    channel, destination: channel === "sms" ? "+12025550123" : "synthetic@example.invalid",
    templateId: `synthetic-${audience}-${day}`, templateVersion: "v1", bodyDigest: createHash("sha256").update(BODY).digest("hex"),
    claimedFacts: [...(required[day] ?? [])] };
  function evidence(offset) {
    const proof = { observedAt: new Date(now.getTime() - offset).toISOString(),
      expiresAt: new Date(now.getTime() + 30000).toISOString(), sourceRef: "synthetic:test-only" };
    return {
      source: { ...proof, accountId: event.accountId, invoiceId: event.invoiceId, revision: event.sourceRevision,
        available: true, complete: true, status: "open", balanceMinor: event.balanceMinor, currency: event.currency,
        ownerId: event.ownerId, issuedDate: event.issuedDate, dueDate: event.dueDate, category, categoryVerified: category !== null },
      owner: { ...proof, accountId: event.accountId, invoiceId: event.invoiceId, revision: event.ownerRevision,
        ownerId: event.ownerId, homeownerContactId: event.homeownerContactId, exactSourceIdentity: true, complete: true },
      recipient: { ...proof, accountId: event.accountId, recipientId: event.recipientId, contactId: event.contactId,
        audience, channel, destination: event.destination, exactSourceIdentity: true, destinationVerified: true,
        internalRecipientApproved: audience === "internal" },
      dnd: { ...proof, accountId: event.accountId, contactId: event.contactId, channel, destination: event.destination, state: "allowed" },
      template: { ...proof, approved: true, accountId: event.accountId, id: event.templateId, version: event.templateVersion,
        bodyDigest: event.bodyDigest, audience, dayPastDue: day, channel, claimedFacts: [...event.claimedFacts] },
      channelAuthorization: { ...proof, approved: true, eventKey: eventKey(event), recipientId: event.recipientId,
        channel, destination: event.destination },
      facts: event.claimedFacts.map(fact => ({ ...proof, fact, accountId: event.accountId, invoiceId: event.invoiceId,
        sourceRevision: event.sourceRevision, value: true })),
      attempts: { ...proof, accountId: event.accountId, historyComplete: true, records: [] },
    };
  }
  return { event, preflight: evidence(20000), final: evidence(1000) };
}
