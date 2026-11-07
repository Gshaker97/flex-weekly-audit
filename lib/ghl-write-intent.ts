import type { GhlOpportunity } from "./ghl";
import { moneyCents, type PhoneInvoiceEvidence } from "./ghl-phone-state";
import { cardNameHash, type GhlWriteIntent } from "./sync-writer-control";

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
export function buildGhlWriteIntent(input: {
  current: GhlOpportunity; to: { stageId: string; monetaryValue: number; name?: string };
  jobberClientId: string; source: PhoneInvoiceEvidence[]; storedInvoiceIds: string[]; observedAt: string;
}): GhlWriteIntent | null {
  const { current, to } = input;
  const before = moneyCents(current.monetaryValue), target = moneyCents(to.monetaryValue);
  if (before === null || target === null || !current.pipelineId || !current.contactId || !current.pipelineStageId || current.status !== "open") return null;
  const invoices: GhlWriteIntent["source"]["invoices"] = [];
  for (const inv of input.source.filter(i => i.client?.id === input.jobberClientId)) {
    const totalCents = moneyCents(inv.amounts?.total), balanceCents = moneyCents(inv.amounts?.invoiceBalance);
    if (totalCents === null || balanceCents === null || !inv.invoiceStatus) return null;
    if ([inv.issuedDate, inv.createdAt, inv.dueDate].some(v => v !== null && (typeof v !== "string" || v.length > 64 || !Number.isFinite(new Date(v).getTime())))) return null;
    invoices.push({ id: inv.id, jobberClientId: input.jobberClientId, invoiceStatus: inv.invoiceStatus.toLowerCase(),
      totalCents, balanceCents, issuedDate: inv.issuedDate, createdAt: inv.createdAt, dueDate: inv.dueDate });
  }
  return { approvalId: process.env.GHL_WRITE_APPROVAL_ID, pipelineId: current.pipelineId, contactId: current.contactId, opportunityId: current.id, jobberClientId: input.jobberClientId,
    expected: { stageId: current.pipelineStageId, status: "open", amountCents: before, nameHash: cardNameHash(current.name) },
    target: { stageId: to.stageId, amountCents: target, nameHash: cardNameHash(to.name ?? current.name), updateName: to.name !== undefined },
    source: { observedAt: input.observedAt, storedInvoiceIds: [...input.storedInvoiceIds].sort(), invoices: invoices.sort((a, b) => a.id.localeCompare(b.id)) } };
}
