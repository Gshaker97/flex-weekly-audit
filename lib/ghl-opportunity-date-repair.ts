import { createHash } from "node:crypto";
import { readOpportunity, setOpportunityDueDate, type GhlOpportunity } from "./ghl";
import { approvedGhlCards } from "./ghl-write-intent";
import { moneyCents } from "./ghl-phone-state";
import { planOpportunityDueDate, type BindingInput, type DateField } from "./invoice-workflow-binding";
import { cardNameHash, type GhlWriteIntent, type SyncRunWriter } from "./sync-writer-control";

export type DateRepairSnapshot = BindingInput & { field: DateField; currentCard: GhlOpportunity };
export type DateRepairApproval = { approvalId: string; intentSha256: string; expiresAt: string;
  effectsReviewedAt: string; workflowsRemainDraft: boolean; fieldUpdateEffectsReviewed: boolean };
const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
export const dateRepairIntentHash = (v: unknown) => sha(v);

/** Full opportunity GET, API 2021-07-28: empty custom fields are sparse.
 * Verified on an isolated same-field/location card before/after a UI date edit
 * 2026-11-09: omitted customFields -> [{id, fieldValue: "2026-11-30"}].
 * Only omission/absent array entry is blank; null/malformed arrays remain unknown.
 * This parser must never be used on a search/partial-card response.
 */
export function readDueDateField(metadata: unknown, card: GhlOpportunity, locationId: string): DateField | null {
  const data = metadata as { customFields?: unknown } | null;
  if (!Array.isArray(data?.customFields) || (card.customFields !== undefined && !Array.isArray(card.customFields)) || card.locationId !== locationId) return null;
  const fields = card.customFields ?? [];
  const matches = data.customFields.filter((f: any) => f?.fieldKey === "opportunity.due_date");
  if (matches.length !== 1) return null;
  const f = matches[0];
  if (typeof f.id !== "string" || !f.id || f.model !== "opportunity" || f.dataType !== "DATE" || f.locationId !== locationId) return null;
  if (fields.some(v => !v || typeof v.id !== "string" || !Object.hasOwn(v, "fieldValue"))
      || new Set(fields.map(v => v.id)).size !== fields.length) return null;
  const value = fields.find(v => v.id === f.id);
  return { id: f.id, locationId, model: f.model, key: f.fieldKey, type: f.dataType,
    currentValueKnown: true, currentValue: value ? value.fieldValue : null };
}

function cardScopeMatches(s: DateRepairSnapshot): boolean {
  const c = s.currentCard, b = s.binding;
  if (c.customFields !== undefined && !Array.isArray(c.customFields)) return false;
  const field = (c.customFields ?? []).filter(v => v.id === s.field.id);
  return c.id === b.opportunityId && c.locationId === b.locationId && c.contactId === b.contactId
    && c.pipelineId === b.pipelineId && c.pipelineStageId === s.card.stageId
    && c.status === s.card.status && moneyCents(c.monetaryValue) === s.card.amountCents
    && (field.length === 1 ? field[0].fieldValue === s.field.currentValue : field.length === 0 && s.field.currentValue === null);
}
function journalIntent(s: DateRepairSnapshot, approvalId: string): GhlWriteIntent | null {
  const plan = planOpportunityDueDate(s);
  if (plan.state !== "repair_candidate" || !plan.intent || !cardScopeMatches(s)) return null;
  const i = plan.intent;
  const before = { stageId: i.expectedStageId, status: "open" as const,
    amountCents: i.expectedAmountCents, nameHash: cardNameHash(s.currentCard.name) };
  return { approvalId, pipelineId: s.binding.pipelineId, contactId: i.contactId,
    opportunityId: i.opportunityId, jobberClientId: i.jobberClientId, expected: before,
    target: { ...before, updateName: false },
    source: { observedAt: s.source.observedAt,
      storedInvoiceIds: s.source.invoices.filter(v => v.jobberClientId === i.jobberClientId).map(v => v.id).sort(),
      invoices: s.source.invoices.filter(v => v.jobberClientId === i.jobberClientId).map(v => ({
        id: v.id, jobberClientId: v.jobberClientId, invoiceStatus: v.status, totalCents: v.totalCents,
        balanceCents: v.balanceCents, issuedDate: v.issuedDate, createdAt: null, dueDate: v.dueDate,
      })).sort((a,b) => a.id.localeCompare(b.id)) },
    dateField: { locationId: i.locationId, fieldId: i.fieldId, key: "opportunity.due_date",
      invoiceId: i.invoiceId, expectedValue: i.expectedValue as "" | null,
      targetValue: i.targetValue, sourceFingerprint: i.sourceFingerprint } };
}
const otherFields = (card: GhlOpportunity, fieldId: string) => (card.customFields ?? [])
  .filter(v => v.id !== fieldId).slice().sort((a,b) => a.id.localeCompare(b.id));

/** Actual exact-ID transport integrated with the existing durable writer.
 * Only the disabled-by-default exact-request cron operation calls this helper;
 * there is no HTTP route. Fresh trusted identity, workflow pause evidence and
 * exact live cohort are required. No stage, money, name, status, contact,
 * enrollment or message write.
 * Provider mutations are attempted at most once. Unknown outcomes block the run.
 */
export async function repairOpportunityDueDate(input: {
  approval: DateRepairApproval; writer: Pick<SyncRunWriter, "prepare" | "assertPending" | "confirm" | "block">;
  readFresh: () => Promise<DateRepairSnapshot>;
  // Trusted adapter must freshly re-read the reviewed affected workflow states.
  // A saved approval boolean alone cannot prove they still remain paused.
  verifyEffects: () => Promise<boolean>;
  env?: Record<string, string | undefined>; now?: () => Date;
  transport?: { update: typeof setOpportunityDueDate; read: typeof readOpportunity };
}) {
  const now = input.now ?? (() => new Date()), env = { ...(input.env ?? process.env) };
  const a = { ...input.approval }, at = now().getTime(), expires = Date.parse(a.expiresAt), reviewed = Date.parse(a.effectsReviewedAt);
  const hold = (reason: string) => ({ state: "held" as const, reason });
  if (typeof a.approvalId !== "string" || typeof env.GHL_WRITE_APPROVAL_ID !== "string" || !env.GHL_WRITE_APPROVAL_ID
      || a.approvalId !== env.GHL_WRITE_APPROVAL_ID || !/^[A-Za-z0-9._:-]{1,128}$/.test(a.approvalId)
      || env.GHL_DUE_DATE_REPAIR_ENABLED !== "true" || !/^[a-f0-9]{64}$/.test(a.intentSha256)
      || !Number.isFinite(expires) || expires <= at || expires > at + 3600_000
      || !Number.isFinite(reviewed) || reviewed > at || at - reviewed > 900_000
      || a.workflowsRemainDraft !== true || a.fieldUpdateEffectsReviewed !== true) return hold("explicit_date_repair_approval_or_effects_missing");
  let started = false;
  try {
    if (await input.verifyEffects() !== true) return hold("affected_workflows_not_currently_verified_paused");
    const first = structuredClone(await input.readFresh()); first.now = now().toISOString();
    const plan = planOpportunityDueDate(first);
    if (plan.state !== "repair_candidate" || !plan.intent) return hold(`date_plan_${plan.state}`);
    if (!approvedGhlCards(env).has(plan.intent.opportunityId)) return hold("outside_approved_card_cohort");
    if (sha(plan.intent) !== a.intentSha256) return hold("approved_intent_changed");
    const intent = journalIntent(first, a.approvalId);
    if (!intent) return hold("fresh_card_scope_unverified");
    started = true;
    const writeId = await input.writer.prepare(intent);
    await input.writer.assertPending(writeId);
    // Revalidate after committed admission; a changed invoice/owner/card cannot
    // be smuggled into a previously approved plan. No stale-plan PUT.
    const fresh = structuredClone(await input.readFresh()); fresh.now = now().toISOString();
    const replan = planOpportunityDueDate(fresh);
    if (replan.state !== "repair_candidate" || !replan.intent || sha(replan.intent) !== a.intentSha256
        || !cardScopeMatches(fresh) || cardNameHash(fresh.currentCard.name) !== intent.expected.nameHash
        || now().getTime() >= expires || now().getTime() - reviewed > 900_000) throw new Error("Date repair evidence changed after admission");
    if (await input.verifyEffects() !== true) throw new Error("Affected workflows no longer verified paused");
    await input.writer.assertPending(writeId);
    if (now().getTime() >= expires || now().getTime() - reviewed > 900_000) throw new Error("Date repair approval expired before provider attempt");
    const transport = input.transport ?? { update: setOpportunityDueDate, read: readOpportunity };
    await transport.update(replan.intent.opportunityId, replan.intent.fieldId, replan.intent.targetValue);
    const after = await transport.read(replan.intent.opportunityId);
    const values = after.customFields?.filter(v => v.id === replan.intent!.fieldId);
    if (after.id !== fresh.currentCard.id || after.locationId !== fresh.currentCard.locationId
        || after.contactId !== fresh.currentCard.contactId || after.pipelineId !== fresh.currentCard.pipelineId
        || after.pipelineStageId !== fresh.currentCard.pipelineStageId || after.status !== fresh.currentCard.status
        || after.monetaryValue !== fresh.currentCard.monetaryValue || after.name !== fresh.currentCard.name
        || values?.length !== 1 || values[0].fieldValue !== replan.intent.targetValue
        || sha(otherFields(after, replan.intent.fieldId)) !== sha(otherFields(fresh.currentCard, replan.intent.fieldId))) {
      throw new Error("Exact date-only write readback not confirmed");
    }
    await input.writer.confirm(writeId);
    return { state: "applied" as const, opportunityId: replan.intent.opportunityId, fieldId: replan.intent.fieldId,
      dueOn: replan.intent.targetValue, journalId: writeId };
  } catch (error) {
    // Before durable admission nothing was attempted. An unavailable source or
    // identity proof must hold this repair, not fail an otherwise valid cache sync.
    if (!started) return hold("fresh_date_repair_evidence_unavailable");
    await input.writer.block();
    throw error;
  }
}
