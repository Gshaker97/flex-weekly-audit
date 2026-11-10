/** Trusted read-only adapter for exact opportunity date preparation.
 * No provider mutation, sync invocation, workflow edit or identity bypass.
 */
import { coveragePermitsExactInvoice, readReviewedIdentityCoverage, type IdentityOmissionPolicy } from "./ghl-identity-coverage";
import { createHash } from "node:crypto";
import { prisma } from "./prisma";
import { jobberGraphQL } from "./jobber";
import { readFreshJobberIdentities, verifyFreshGhlIdentity } from "./ghl-write-identity";
import { canonicalPhone } from "./ghl-phone-match";
import { moneyCents, type PhoneInvoiceEvidence } from "./ghl-phone-state";
import { listContactsForPhoneMatching, listPipelineOpportunities, readOpportunity,
  readOpportunityCustomFields, getInvoicePipelineRefs, readWorkflowStates } from "./ghl";
import { readDueDateField, type DateRepairSnapshot } from "./ghl-opportunity-date-repair";
import { planOpportunityDueDate } from "./invoice-workflow-binding";

type GraphQL = typeof jobberGraphQL;
const safeId = (v: unknown): v is string => typeof v === "string" && !!v && v.trim() === v && v.length <= 256;

/** No global invoice scan, incremental filter or silent partial-page result. */
export async function readOwnerInvoiceEvidence(ownerId: string, query: GraphQL = jobberGraphQL): Promise<PhoneInvoiceEvidence[]> {
  if (!safeId(ownerId)) throw new Error("Invalid exact source owner");
  const statement = `query VerifyDateOwnerInvoices($id: EncodedId!, $after: String) {
    client(id: $id) { id invoices(first: 25, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id invoiceStatus amounts { total invoiceBalance } issuedDate dueDate createdAt client { id } }
    } }
  }`;
  const out: PhoneInvoiceEvidence[] = [], ids = new Set<string>(), cursors = new Set<string>();
  let after: string | null = null;
  for (let page = 0; page < 100; page++) {
    const data: any = await query(statement, { id: ownerId, after });
    const connection = data?.client?.invoices;
    if (data?.client?.id !== ownerId || !Array.isArray(connection?.nodes) || connection.nodes.length > 25
        || typeof connection.pageInfo?.hasNextPage !== "boolean") throw new Error("Incomplete exact-owner invoice snapshot");
    for (const invoice of connection.nodes) {
      if (!safeId(invoice?.id) || ids.has(invoice.id) || invoice.client?.id !== ownerId) throw new Error("Wrong or repeated owner invoice");
      ids.add(invoice.id); out.push(invoice);
    }
    if (!connection.pageInfo.hasNextPage) return out;
    after = connection.pageInfo.endCursor;
    if (!safeId(after) || cursors.has(after) || !connection.nodes.length) throw new Error("Truncated exact-owner invoice snapshot");
    cursors.add(after);
  }
  throw new Error("Exact-owner invoice snapshot exceeded limit");
}

export type WorkflowPauseExpectation = { id: string; version: number; updatedAt: string };
/** Explicit reviewed workflow versions, not just names or a saved Draft flag. */
export function workflowsMatchPaused(raw: unknown, locationId: string, expected: WorkflowPauseExpectation[]): boolean {
  const rows = (raw as any)?.workflows;
  if (!safeId(locationId) || !Array.isArray(rows) || !expected.length || new Set(expected.map(x => x.id)).size !== expected.length
      || expected.some(x => !safeId(x.id) || !Number.isSafeInteger(x.version) || x.version < 1
        || typeof x.updatedAt !== "string" || !Number.isFinite(Date.parse(x.updatedAt)))
      || rows.some(x => !safeId(x?.id)) || new Set(rows.map(x => x.id)).size !== rows.length) return false;
  return expected.every(e => {
    const w = rows.find(x => x.id === e.id);
    return w?.locationId === locationId && w.status === "draft" && w.version === e.version && w.updatedAt === e.updatedAt;
  });
}

const live = {
  customers: () => prisma.customer.findMany({ select: { jobberClientId: true, email: true, phone: true } }),
  storedInvoices: (ownerId: string) => prisma.invoiceRecord.findMany({ where: { customer: { jobberClientId: ownerId } }, select: { jobberInvoiceId: true } }),
  coverage: readReviewedIdentityCoverage,
  quarantineCounts: async (ids: string[]) => (await prisma.customer.findMany({
    where: { jobberClientId: { in: ids } }, select: { jobberClientId: true, _count: { select: { jobs: true, invoices: true } } },
  })).map(c => ({ jobberClientId: c.jobberClientId, jobs: c._count.jobs, invoices: c._count.invoices })),
  identities: readFreshJobberIdentities, contacts: listContactsForPhoneMatching,
  ownerInvoices: readOwnerInvoiceEvidence, card: readOpportunity, fields: readOpportunityCustomFields,
  refs: getInvoicePipelineRefs, cards: listPipelineOpportunities,
};
export type DateReadinessScope = { locationId: string; opportunityId: string; contactId: string; jobberClientId: string; invoiceId: string };

/** Strict by default. Optional trusted-call-site policy requires fresh explicit
 * account coverage and exact source reads; no request/env toggle sets approval.
 * Direct user-confirmed bindings still need a separately reviewed adapter.
 */
// Non-serializable proof keeps the original branded token and its deadline.
// Cloning must explicitly preserve this validator; it never remints evidence.
const snapshotCoverage = new WeakMap<DateRepairSnapshot, () => void>();
export function assertSnapshotIdentityCoverage(snapshot: DateRepairSnapshot): void {
  snapshotCoverage.get(snapshot)?.();
}
export function assertSnapshotWriteFreshness(snapshot: DateRepairSnapshot, now: Date): void {
  assertSnapshotIdentityCoverage(snapshot);
  const at=now.getTime();
  if (!Number.isFinite(at) || [snapshot.source.observedAt,snapshot.card.observedAt].some(value=>{
    const observed=Date.parse(value);
    return !Number.isFinite(observed) || observed>at || at-observed>15*60_000;
  })) throw new Error("Source/card evidence expired before mutation");
}
export function cloneVerifiedSnapshot(snapshot: DateRepairSnapshot): DateRepairSnapshot {
  const copy = structuredClone(snapshot), check = snapshotCoverage.get(snapshot);
  if (check) snapshotCoverage.set(copy, check);
  return copy;
}
async function readVerifiedInvoiceSnapshot(scope: DateReadinessScope, deps = live, now = () => new Date(), coveragePolicy?: IdentityOmissionPolicy, authorizationCurrent?: () => boolean): Promise<DateRepairSnapshot> {
  scope = structuredClone(scope);
  coveragePolicy = coveragePolicy === undefined ? undefined : structuredClone(coveragePolicy);
  if (!scope || !Object.values(scope).every(safeId) || Object.keys(scope).length !== 5
      || scope.locationId !== process.env.GHL_LOCATION_ID) throw new Error("Exact date-repair scope is invalid");
  const begun = now().toISOString();
  const customers = await deps.customers();
  const owner = customers.filter(c => c.jobberClientId === scope.jobberClientId);
  if (owner.length !== 1) throw new Error("Exact cached owner is missing or duplicated");
  const covered = coveragePolicy ? await deps.coverage(coveragePolicy, customers, scope,
    () => deps.quarantineCounts(coveragePolicy.quarantine.map(c => c.jobberClientId))) : null;
  const identities = covered?.identities ?? await deps.identities();
  const contacts = await deps.contacts();
  const selected = contacts.find(c => c.id === scope.contactId);
  const email = owner[0].email?.trim().toLowerCase();
  const phone = canonicalPhone(owner[0].phone);
  if (!selected || !((email && email === selected.email?.trim().toLowerCase())
      || (phone && phone === canonicalPhone(selected.phone)))) throw new Error("Requested contact does not match the source primary identity");
  const identityHold = verifyFreshGhlIdentity(owner[0], customers, contacts, scope.contactId, identities, covered?.evidence);
  if (identityHold) throw new Error(identityHold);
  const refs = await deps.refs();
  const cards = await deps.cards(refs.pipelineId);
  const matches = cards.filter(c => c.contactId === scope.contactId);
  // Every status is included. A closed duplicate is not silently ignored.
  if (matches.length !== 1 || matches[0].id !== scope.opportunityId) throw new Error("Exact contact has no unique invoice-pipeline card");
  const invoices = await deps.ownerInvoices(scope.jobberClientId);
  const stored = await deps.storedInvoices(scope.jobberClientId);
  if (!stored.length || stored.some(i => !invoices.some(s => s.id === i.jobberInvoiceId))) throw new Error("Fresh owner invoices omit cached source evidence");
  const currentCard = await deps.card(scope.opportunityId);
  const field = readDueDateField(await deps.fields(), currentCard, scope.locationId);
  const amountCents = moneyCents(currentCard.monetaryValue);
  if (!field || amountCents === null || !safeId(currentCard.pipelineStageId) || !safeId(currentCard.status)) throw new Error("Current card field or monetary state is unverified");
  const sourceInvoices = invoices.map(i => {
    const totalCents = moneyCents(i.amounts?.total), balanceCents = moneyCents(i.amounts?.invoiceBalance);
    if (totalCents === null || balanceCents === null || typeof i.invoiceStatus !== "string") throw new Error("Invalid exact-owner source amounts or status");
    return { id: i.id, jobberClientId: scope.jobberClientId, status: i.invoiceStatus.toLowerCase(), totalCents, balanceCents,
      issuedDate: i.issuedDate, dueDate: i.dueDate, category: null };
  });
  if (covered && !coveragePermitsExactInvoice(covered.evidence, customers, identities, scope))
    throw new Error("Reviewed identity coverage expired or changed before snapshot completion");
  const snapshot: DateRepairSnapshot = {
    now: now().toISOString(), source: { observedAt: begun, complete: true, invoices: sourceInvoices },
    binding: { ...scope, pipelineId: refs.pipelineId, method: "unique_unpaid_invoice",
      evidenceRef: `fresh-complete-identity:${createHash("sha256").update(JSON.stringify([scope, identities, contacts, coveragePolicy ?? null])).digest("hex")}`,
      identityVerified: true, uniqueInvoiceCardVerified: true },
    card: { id: currentCard.id, locationId: currentCard.locationId ?? "", contactId: currentCard.contactId ?? "",
      pipelineId: currentCard.pipelineId ?? "", stageId: currentCard.pipelineStageId, status: currentCard.status,
      amountCents, observedAt: begun },
    stageIds: { sent: refs.stageIdByName["invoice sent"], overdue: refs.stageIdByName["invoice overdue"] }, field, currentCard,
  };
  if (covered) {
    const evidence = covered.evidence;
    const frozenCustomers = structuredClone(customers), frozenIdentities = structuredClone(identities);
    snapshotCoverage.set(snapshot, () => {
      if (authorizationCurrent && !authorizationCurrent())
        throw new Error("Reviewed identity authorization changed before mutation");
      if (!coveragePermitsExactInvoice(evidence, frozenCustomers, frozenIdentities, scope))
        throw new Error("Reviewed identity coverage expired or changed before mutation");
    });
    assertSnapshotIdentityCoverage(snapshot);
  }
  return snapshot;
}
export async function readVerifiedDateRepairSnapshot(scope: DateReadinessScope, deps = live, now = () => new Date(), coveragePolicy?: IdentityOmissionPolicy, authorizationCurrent?: () => boolean): Promise<DateRepairSnapshot> {
  const snapshot = await readVerifiedInvoiceSnapshot(scope, deps, now, coveragePolicy, authorizationCurrent);
  const plan = planOpportunityDueDate(snapshot);
  if (plan.state === "held") throw new Error(`Exact date preparation held: ${plan.reasons.join("; ")}`);
  return snapshot;
}
/** Same strict identity/source/card reader; reset eligibility is validated by
 * the journal-owned reset operation, never by bypassing identity coverage. */
export const readVerifiedCycleResetSnapshot = readVerifiedInvoiceSnapshot;

export async function verifyCurrentWorkflowPauses(locationId: string, expected: WorkflowPauseExpectation[]): Promise<boolean> {
  if (locationId !== process.env.GHL_LOCATION_ID) return false;
  return workflowsMatchPaused(await readWorkflowStates(), locationId, expected);
}
