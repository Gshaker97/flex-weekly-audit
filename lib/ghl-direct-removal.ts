/** Durable single-attempt workflow removal. Acknowledgment is not quiescence. */
import { removeContactFromWorkflowOnce } from "./ghl";
import { assertSnapshotIdentityCoverage } from "./ghl-date-readiness";
import type { DateRepairSnapshot } from "./ghl-opportunity-date-repair";
import { SyncWriterBlockedError, cardNameHash, type CycleJournalEntry, type GhlWriteIntent, type SyncRunWriter } from "./sync-writer-control";

export function assertRemovalSnapshotFreshness(snapshot: DateRepairSnapshot, now: Date): void {
  const at=now.getTime();
  if (!Number.isFinite(at) || [snapshot.source.observedAt,snapshot.card.observedAt].some(value=>{
    const observed=Date.parse(value);
    return !Number.isFinite(observed) || observed>at || at-observed>15*60_000;
  })) throw new Error("Removal source/card evidence is stale or invalid");
}
export async function acknowledgeOwnedWorkflowRemoval(input: {
  writer: Pick<SyncRunWriter,"readCycleHistory"|"prepare"|"assertPending"|"confirm"|"block">;
  intent: GhlWriteIntent;
  // Rechecks source, card, workflow inventory and policy; returns original coverage proof.
  recheck: () => Promise<DateRepairSnapshot>;
  remove?: typeof removeContactFromWorkflowOnce;
  now: () => Date; assertCurrent: () => void;
}): Promise<CycleJournalEntry> {
  const removal = input.intent.workflowRemoval!;
  const previous = (await input.writer.readCycleHistory()).filter(w =>
    w.intent.workflowRemoval?.locationId === removal.locationId
    && w.intent.workflowRemoval.workflowId === removal.workflowId
    && w.intent.contactId === input.intent.contactId
    && w.intent.workflowRemoval.oldOwnershipJournalId === removal.oldOwnershipJournalId);
  if (previous.length) {
    const entry = previous[0], prior = entry.intent.workflowRemoval!;
    if (previous.length !== 1 || entry.state !== "confirmed" || !entry.removalAcknowledgment
        || prior.invoiceId!==removal.invoiceId || prior.contractSha256!==removal.contractSha256
        || (prior.purpose!=="paid_cycle_cancellation" && prior.oldPaidJournalId!==removal.oldPaidJournalId)
        || (removal.purpose==="paid_cycle_cancellation" && prior.purpose!=="paid_cycle_cancellation")
        || entry.intent.opportunityId !== input.intent.opportunityId
        || entry.intent.jobberClientId !== input.intent.jobberClientId
        || entry.intent.pipelineId !== input.intent.pipelineId) {
      await input.writer.block(); throw new SyncWriterBlockedError();
    }
    return entry; // Reuse original receipt, never reissue across runs.
  }
  let admitted = false;
  try {
    const before = await input.recheck(); assertSnapshotIdentityCoverage(before); assertRemovalSnapshotFreshness(before,input.now()); input.assertCurrent();
    admitted = true;
    const id = await input.writer.prepare(input.intent);
    await input.writer.assertPending(id);
    const final = await input.recheck();
    await input.writer.assertPending(id);
    assertSnapshotIdentityCoverage(final); assertRemovalSnapshotFreshness(final,input.now()); input.assertCurrent();
    const result = await (input.remove ?? removeContactFromWorkflowOnce)(input.intent.contactId, removal.workflowId);
    if (result?.httpStatus !== 200 || result.succeeded !== true) throw new Error("Workflow removal response is not acknowledged");
    await input.writer.confirm(id, undefined, {version:1,httpStatus:200,succeeded:true,observedAt:input.now().toISOString()});
    const receipt = (await input.writer.readCycleHistory()).find(w => w.id === id);
    if (!receipt?.removalAcknowledgment || receipt.state !== "confirmed") throw new Error("Workflow removal receipt not durably confirmed");
    return receipt;
  } catch (error) {
    if (admitted) { await input.writer.block(); throw new SyncWriterBlockedError(); }
    throw error;
  }
}

export function removalIntent(snapshot: DateRepairSnapshot, old: CycleJournalEntry, paid: CycleJournalEntry,
  approvalId: string, contractSha256: string): GhlWriteIntent {
  const current = {stageId:snapshot.card.stageId,status:"open" as const,amountCents:snapshot.card.amountCents,
    nameHash:cardNameHash(snapshot.currentCard.name)};
  return {approvalId,pipelineId:snapshot.card.pipelineId,contactId:snapshot.binding.contactId,
    opportunityId:snapshot.card.id,jobberClientId:snapshot.binding.jobberClientId,
    expected:current,target:{...current,updateName:false},
    source:{observedAt:snapshot.source.observedAt,storedInvoiceIds:snapshot.source.invoices.map(i=>i.id).sort(),
      invoices:snapshot.source.invoices.map(i=>({id:i.id,jobberClientId:i.jobberClientId,invoiceStatus:i.status,
        totalCents:i.totalCents,balanceCents:i.balanceCents,issuedDate:i.issuedDate,dueDate:i.dueDate,createdAt:null})).sort((a,b)=>a.id.localeCompare(b.id))},
    workflowRemoval:{version:1,locationId:snapshot.binding.locationId,workflowId:old.intent.cycle!.workflowId,
      invoiceId:old.intent.cycle!.invoiceId,oldOwnershipJournalId:old.id,oldPaidJournalId:paid.id,contractSha256,apiVersion:"v3"}};
}
