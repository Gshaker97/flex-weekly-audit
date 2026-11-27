import type { GhlOpportunity } from "./ghl";
import { moneyCents, type PhoneInvoiceEvidence } from "./ghl-phone-state";
import { cardNameHash, type GhlWriteIntent } from "./sync-writer-control";
import { invoiceSettlement, settledOrOwingStatus } from "./invoice-settlement";

/**
 * The calendar day a timestamp falls on in Phoenix, which never observes DST,
 * so the offset is a constant -7. Local to this module: the clock is consulted
 * only to choose between the two owing labels, never to decide whether money is
 * owed - that is the balance's job alone.
 */
function phoenixDay(value: string | null): string | null {
  if (typeof value !== "string") return null;
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t - 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function approvedGhlCards(env: Record<string, string | undefined> = process.env): Set<string> {
  // An unset/malformed cohort deliberately withholds Paid exits as well.
  try {
    if (!env.GHL_WRITE_APPROVAL_ID || !/^[A-Za-z0-9._:-]{1,128}$/.test(env.GHL_WRITE_APPROVAL_ID)) return new Set();
    const ids: unknown = JSON.parse(env.GHL_APPROVED_OPPORTUNITY_IDS ?? "[]");
    if (!Array.isArray(ids) || ids.length > 500 || ids.some(id => typeof id !== "string" || !id || id.length > 128 || id.trim() !== id)
        || new Set(ids).size !== ids.length) return new Set();
    return new Set(ids);
  } catch { return new Set(); }
}

/**
 * Every invoice this customer has, in the shape the durable journal stores.
 * `null` means some invoice could not be read strictly enough to be evidence,
 * and a partial answer is never returned: a missing invoice is indistinguishable
 * from a paid one, and that difference decides whether anybody owes money.
 *
 * Shared by the update and creation intents so there is exactly one definition
 * of what "the verified source" means.
 *
 * THE LABEL IS CORRECTED HERE, once, before anything downstream reads it.
 * Jobber leaves `paid` on a refunded or deposit-only invoice while money is
 * still outstanding, and the durable journal's own validator refuses that
 * combination outright - `paid` must carry a zero balance or `validateIntent`
 * throws, which halts every remaining card write in the run and blocks the
 * sync pending operator review. That is exactly what happened on the first run
 * after the balance-based card rule went live (2026-11-27 20:02Z): invoice
 * #6830 reads `paid` with $60 owing, the planner correctly wanted it in
 * Overdue, and the write halted the sync.
 *
 * Correcting the label at this one chokepoint - rather than relaxing the
 * validator - means every assertion in `sync-writer-control` keeps its original
 * strictness and sees a coherent invoice: an owing label with a positive
 * balance, or `paid` with none. No duplicate-write or duplicate-send
 * protection is weakened to make this work.
 */
export function buildInvoiceSourceEvidence(
  source: PhoneInvoiceEvidence[], jobberClientId: string, observedAt: string
): GhlWriteIntent["source"]["invoices"] | null {
  const invoices: GhlWriteIntent["source"]["invoices"] = [];
  const today = phoenixDay(observedAt);
  for (const inv of source.filter(i => i.client?.id === jobberClientId)) {
    const totalCents = moneyCents(inv.amounts?.total), balanceCents = moneyCents(inv.amounts?.invoiceBalance);
    if (totalCents === null || balanceCents === null || !inv.invoiceStatus) return null;
    // A status the journal cannot record is a null answer HERE, so the caller
    // holds one card. Left to `validateIntent` it would instead throw inside
    // `prepare`, which halts the whole writer for the rest of the run - and
    // the Jobber read this evidence comes from carries every status there is,
    // void and draft included, so one void invoice on one customer would stop
    // every other customer's card from being written. Measured on the live
    // account 2026-11-25: 9 invoices in scope are void.
    if (!["paid", "past_due", "awaiting_payment"].includes(inv.invoiceStatus.toLowerCase())) return null;
    if ([inv.issuedDate, inv.createdAt, inv.dueDate].some(v => v !== null && (typeof v !== "string" || v.length > 64 || !Number.isFinite(new Date(v).getTime())))) return null;
    const raw = inv.invoiceStatus.toLowerCase();
    // Amounts the shared rule cannot read - a balance above the total, say -
    // are a null answer here for the same reason an unknown status is: one
    // unreadable invoice must hold one card, not halt the writer.
    if (invoiceSettlement(raw, totalCents, balanceCents) === "unreadable") return null;
    const dueDay = phoenixDay(inv.dueDate);
    const invoiceStatus = settledOrOwingStatus(raw, totalCents, balanceCents,
      dueDay !== null && today !== null && dueDay < today) ?? raw;
    invoices.push({ id: inv.id, jobberClientId, invoiceStatus,
      totalCents, balanceCents, issuedDate: inv.issuedDate, createdAt: inv.createdAt, dueDate: inv.dueDate });
  }
  return invoices.sort((a, b) => a.id.localeCompare(b.id));
}

export function buildGhlWriteIntent(input: {
  current: GhlOpportunity; to: { stageId: string; monetaryValue: number; name?: string };
  jobberClientId: string; source: PhoneInvoiceEvidence[]; storedInvoiceIds: string[]; observedAt: string;
}): GhlWriteIntent | null {
  const { current, to } = input;
  const before = moneyCents(current.monetaryValue), target = moneyCents(to.monetaryValue);
  if (before === null || target === null || !current.pipelineId || !current.contactId || !current.pipelineStageId || current.status !== "open") return null;
  const invoices = buildInvoiceSourceEvidence(input.source, input.jobberClientId, input.observedAt);
  if (invoices === null) return null;
  return { approvalId: process.env.GHL_WRITE_APPROVAL_ID, pipelineId: current.pipelineId, contactId: current.contactId, opportunityId: current.id, jobberClientId: input.jobberClientId,
    expected: { stageId: current.pipelineStageId, status: "open", amountCents: before, nameHash: cardNameHash(current.name) },
    target: { stageId: to.stageId, amountCents: target, nameHash: cardNameHash(to.name ?? current.name), updateName: to.name !== undefined },
    source: { observedAt: input.observedAt, storedInvoiceIds: [...input.storedInvoiceIds].sort(), invoices } };
}
