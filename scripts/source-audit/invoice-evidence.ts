/** Optional bounded evidence reads. Uses only the existing no-refresh source transport. */
import { AuditFailure, CacheRow, Invoice, LIMITS, cents, dateValue, normalize, object, opaqueId } from './core';
import { JobberReader } from './transport';

export const EVIDENCE_LIMITS = Object.freeze({ targets: 128, requests: 384, pagesPerConnection: 8,
  recordsPerConnection: 200, pageSize: 25, durationMs: 4 * 60_000, outputBytes: 2_000_000 });
const SCHEMA_QUERY = `query AuditInvoiceEvidenceSchema {
  __schema { queryType { fields { name args { name type { kind name ofType { kind name } } }
    type { kind name ofType { kind name } } } } }
  invoiceMetadata: __type(name: "Invoice") { fields { name type { kind name ofType { kind name } } } }
  adjustment: __type(name: "IncomeAdjustmentType") { kind enumValues { name } }
  transaction: __type(name: "JobberPaymentTransactionStatus") { kind enumValues { name } }
  category: __type(name: "ProductsAndServicesCategory") { kind enumValues { name } }
}`;
const INVOICE_FIELDS = `id invoiceNumber invoiceStatus subtotal
  amounts { total invoiceBalance discountAmount subtotal }
  issuedDate dueDate createdAt invoiceNet client { id }`;
const PAYMENT_FIELDS = `paymentRecords(first: 25, after: $paymentAfter) @include(if: $payments) {
  totalCount pageInfo { hasNextPage endCursor }
  nodes { id amount entryDate adjustmentType jobberPaymentTransactionStatus tipAmount }
}`;
const ITEM_FIELDS = `lineItems(first: 25, after: $itemAfter) @include(if: $items) {
  totalCount pageInfo { hasNextPage endCursor }
  nodes { id name description quantity unitPrice totalPrice category createdAt date updatedAt }
}`;
const STATUSES = new Set(['draft', 'sent', 'awaiting_payment', 'past_due', 'paid', 'void', 'bad_debt', 'deleted']);
const safeStatus = (v: unknown) => typeof v === 'string' && STATUSES.has(v.toLowerCase()) ? v.toLowerCase() : null;
export function evidenceDate(v: unknown) {
  const parsed = dateValue(v);
  if (parsed.kind !== 'valid') return { value: null, kind: parsed.kind };
  return { value: typeof v === 'string' && v.length === 10 ? parsed.day! : new Date(parsed.instant!).toISOString(), kind: 'valid' };
}
type Target = { id: string; reasons: string[] };
export function deriveEvidenceTargets(source: Invoice[], cache: CacheRow[]): Target[] {
  const selected = new Map<string, Set<string>>(), byId = new Map(source.map(v => [v.id, v]));
  const add = (id: string, reason: string) => {
    if (!opaqueId(id)) throw new AuditFailure('EVIDENCE_TARGET_ID_INVALID');
    if (!selected.has(id)) selected.set(id, new Set());
    selected.get(id)!.add(reason);
  };
  for (const row of source) {
    if (row.invoiceStatus === 'paid' && row.balance !== null && row.balance > 0) add(row.id, 'source-paid-positive');
    if (row.balance !== null && row.balance < 0) add(row.id, 'source-negative-balance');
    if (row.invoiceStatus === 'past_due' && row.balance !== null && row.balance > 0 &&
        row.dates.issued.kind === 'valid' && row.dates.issued.day! >= '2026-01-01') add(row.id, 'source-past-due-positive-issued-2026-or-later');
  }
  for (const row of cache) {
    const sourceRow = byId.get(row.jobberInvoiceId), balance = cents(row.amountDue), status = safeStatus(row.invoiceStatus);
    if (!sourceRow) add(row.jobberInvoiceId, 'cache-only-in-enumeration');
    else if (sourceRow.invoiceStatus !== status) add(row.jobberInvoiceId, 'source-cache-status-difference');
    if (status === 'paid' && balance !== null && balance > 0) add(row.jobberInvoiceId, 'cache-paid-positive');
    if (balance !== null && balance < 0) add(row.jobberInvoiceId, 'cache-negative-balance');
    const issued = dateValue(row.issuedAt);
    if (status === 'past_due' && balance !== null && balance > 0 && issued.kind === 'valid' &&
        issued.day! >= '2026-01-01') add(row.jobberInvoiceId, 'cache-past-due-positive-issued-2026-or-later');
  }
  return [...selected].sort(([a], [b]) => a.localeCompare(b)).map(([id, reasons]) => ({ id, reasons: [...reasons].sort() }));
}
function typeName(v: unknown): string | null {
  if (!object(v)) return null;
  if (v.kind === 'NON_NULL' && object(v.ofType) && typeof v.ofType.name === 'string') return `${v.ofType.name}!`;
  return typeof v.name === 'string' ? v.name : null;
}
export function validateEvidenceSchema(data: Record<string, unknown>) {
  const schema = data.__schema;
  if (!object(schema) || !object(schema.queryType) || !Array.isArray(schema.queryType.fields) || schema.queryType.fields.length > 1000)
    throw new AuditFailure('EVIDENCE_ROOT_SCHEMA_UNVERIFIED');
  const field = schema.queryType.fields.find(f => object(f) && f.name === 'invoice');
  if (!object(field) || !['Invoice', 'Invoice!'].includes(typeName(field.type) ?? '') || !Array.isArray(field.args))
    throw new AuditFailure('EVIDENCE_INVOICE_BY_ID_UNAVAILABLE');
  const id = field.args.find(a => object(a) && a.name === 'id');
  const idType = object(id) ? typeName(id.type) : null;
  if (!['EncodedId!', 'ID!'].includes(idType ?? '') || field.args.some(a => !object(a) || (a.name !== 'id' && (typeName(a.type) ?? '').endsWith('!'))))
    throw new AuditFailure('EVIDENCE_INVOICE_ARGUMENT_UNVERIFIED');
  const enums: Record<string, Set<string>> = {};
  for (const name of ['adjustment', 'transaction', 'category']) {
    const value = data[name];
    if (!object(value) || value.kind !== 'ENUM' || !Array.isArray(value.enumValues) || !value.enumValues.length || value.enumValues.length > 100 ||
        value.enumValues.some(e => !object(e) || typeof e.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(e.name)))
      throw new AuditFailure('EVIDENCE_ENUM_SCHEMA_UNVERIFIED');
    enums[name] = new Set(value.enumValues.map(e => e.name as string));
  }
  const metadata = data.invoiceMetadata;
  const updated = object(metadata) && Array.isArray(metadata.fields) ? metadata.fields.find(f => object(f) && f.name === 'updatedAt') : undefined;
  const updatedAtAvailable = object(updated) && ['ISO8601DateTime', 'ISO8601DateTime!'].includes(typeName(updated.type) ?? '');
  return { idType: idType!, enums, updatedAtAvailable };
}
export function evidenceQuery(idType: string, updatedAtAvailable = false) {
  if (!['EncodedId!', 'ID!'].includes(idType)) throw new AuditFailure('EVIDENCE_INVOICE_ARGUMENT_UNVERIFIED');
  return `query AuditInvoiceEvidence($id: ${idType}, $paymentAfter: String, $itemAfter: String, $payments: Boolean!, $items: Boolean!) {
    invoice(id: $id) { ${INVOICE_FIELDS} ${updatedAtAvailable ? 'updatedAt' : ''} ${PAYMENT_FIELDS} ${ITEM_FIELDS} }
  }`;
}
function safeInvoice(raw: Record<string, unknown>, updatedAtAvailable: boolean) {
  const row = normalize(raw);
  return { id: row.id, invoiceNumber: row.invoiceNumber, invoiceStatus: row.invoiceStatus, ownerId: row.owner,
    totalCents: row.total, balanceCents: row.balance, subtotalCents: row.subtotal, discountCents: row.discount,
    issued: evidenceDate(raw.issuedDate), due: evidenceDate(raw.dueDate), created: evidenceDate(raw.createdAt),
    updated: updatedAtAvailable ? evidenceDate(raw.updatedAt) : { value: null, kind: 'field-unavailable' },
    updatedAtAvailable,
    invoiceNetDays: typeof raw.invoiceNet === 'number' && Number.isSafeInteger(raw.invoiceNet) ? raw.invoiceNet : null,
    invoiceNetKnown: raw.invoiceNet === null || (typeof raw.invoiceNet === 'number' && Number.isSafeInteger(raw.invoiceNet)),
    issues: row.issues };
}
function enumValue(value: unknown, allowed: Set<string>, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !allowed.has(value)) throw new AuditFailure('EVIDENCE_ENUM_VALUE_UNVERIFIED');
  return value;
}
function money(value: unknown, nullable = false) {
  if (nullable && value === null) return null;
  const result = cents(value);
  if (result === null) throw new AuditFailure('EVIDENCE_MONEY_UNVERIFIED');
  return result;
}
function requiredDate(value: unknown, nullable = false) {
  const parsed = evidenceDate(value);
  if (parsed.kind !== 'valid' && !(nullable && value === null)) throw new AuditFailure('EVIDENCE_DATE_UNVERIFIED');
  return parsed;
}
export function feeWording(name: unknown, description: unknown) {
  if (typeof name !== 'string' || typeof description !== 'string' || name.length > 10_000 || description.length > 100_000)
    throw new AuditFailure('EVIDENCE_ITEM_TEXT_MALFORMED');
  const labels: Record<string, RegExp> = { 'late-fee-wording': /\blate\s+(?:payment\s+)?fees?\b/i,
    'finance-charge-wording': /\bfinance\s+charges?\b/i, 'interest-wording': /\binterest\b/i,
    'penalty-wording': /\bpenalt(?:y|ies)\b/i, 'surcharge-wording': /\bsurcharges?\b/i, 'fee-wording': /\bfees?\b/i };
  return Object.entries(labels).flatMap(([label, regex]) => {
    const matchedFields = [regex.test(name) ? 'name' : null, regex.test(description) ? 'description' : null].filter(Boolean);
    return matchedFields.length ? [{ label, matchedFields }] : [];
  });
}
type ConnectionState = { pages: number; count: number; reportedTotalCount: number | null; terminalPageObserved: boolean;
  complete: boolean; after: string | null; ids: Set<string>; cursors: Set<string>; records: Record<string, unknown>[] };
function connectionState(): ConnectionState {
  return { pages: 0, count: 0, reportedTotalCount: null, terminalPageObserved: false, complete: false, after: null,
    ids: new Set(), cursors: new Set(), records: [] };
}
function publicConnection(s: ConnectionState) {
  return { pages: s.pages, observedCount: s.count, reportedTotalCount: s.reportedTotalCount,
    uniqueIds: s.ids.size, uniqueCursors: s.cursors.size, terminalPageObserved: s.terminalPageObserved, complete: s.complete, records: s.records };
}
function consumePage(raw: unknown, state: ConnectionState, project: (node: Record<string, unknown>) => Record<string, unknown> | null) {
  if (state.pages >= EVIDENCE_LIMITS.pagesPerConnection) throw new AuditFailure('EVIDENCE_CONNECTION_PAGE_LIMIT');
  if (!object(raw) || !Array.isArray(raw.nodes) || !object(raw.pageInfo) || typeof raw.pageInfo.hasNextPage !== 'boolean' ||
      typeof raw.totalCount !== 'number' || !Number.isSafeInteger(raw.totalCount) || raw.totalCount < 0)
    throw new AuditFailure('EVIDENCE_CONNECTION_MALFORMED');
  if (raw.totalCount > EVIDENCE_LIMITS.recordsPerConnection) throw new AuditFailure('EVIDENCE_CONNECTION_RECORD_LIMIT');
  if (state.reportedTotalCount !== null && raw.totalCount !== state.reportedTotalCount) throw new AuditFailure('EVIDENCE_CONNECTION_COUNT_CHANGED');
  state.reportedTotalCount = raw.totalCount;
  const cursor = raw.pageInfo.endCursor, hasNext = raw.pageInfo.hasNextPage;
  if (raw.nodes.length > EVIDENCE_LIMITS.pageSize || (!raw.nodes.length && (hasNext || state.pages > 0)))
    throw new AuditFailure('EVIDENCE_PAGE_SIZE_INVALID');
  if (raw.nodes.length ? typeof cursor !== 'string' || !cursor || cursor.length > 2048 : cursor !== null)
    throw new AuditFailure('EVIDENCE_CURSOR_INVALID');
  if (typeof cursor === 'string') {
    if (state.cursors.has(cursor)) throw new AuditFailure('EVIDENCE_CURSOR_REPEATED');
    state.cursors.add(cursor);
  }
  for (const node of raw.nodes) {
    if (!object(node) || !opaqueId(node.id)) throw new AuditFailure('EVIDENCE_RECORD_ID_INVALID');
    if (state.ids.has(node.id as string)) throw new AuditFailure('EVIDENCE_RECORD_ID_REPEATED');
    const projected = project(node);
    state.ids.add(node.id as string); state.count++;
    if (state.count > EVIDENCE_LIMITS.recordsPerConnection || state.count > raw.totalCount) throw new AuditFailure('EVIDENCE_CONNECTION_COUNT_MISMATCH');
    if (projected) state.records.push(projected);
  }
  state.pages++; state.after = typeof cursor === 'string' ? cursor : null;
  state.terminalPageObserved = !hasNext;
  if (!hasNext && state.count !== raw.totalCount) throw new AuditFailure('EVIDENCE_CONNECTION_COUNT_MISMATCH');
  state.complete = !hasNext;
}
const LIMITATIONS = [
  'Targets are a runtime union of paid-positive, negative-balance, status-difference, cache-only and positive past_due issued 2026 or later cohorts. They are not every account invoice.',
  'Complete refers to bounded target reads and terminal payment/line-item pagination with matching totalCount, not verified bank receipts or an atomic source snapshot.',
  'Payment entryDate is a Jobber record date, not a bank settlement or invoice sent date. Payment allocations and refunds are not read; record amounts are not summed as invoice cash receipts.',
  'Fee wording is a text-match candidate only. Matched labels and observed line-item prices do not establish that a fee was charged, collected, or legally due; absence of a match does not prove absence of fees.',
  'linkedCommunications exposes no usable node in the verified schema. No sent timestamp or reminder delivery/history is inferred.',
  'Invoice owner IDs are read, but full source customer phones/emails are not read or verified. Existing cached/GHL identity ambiguity remains unresolved.',
  'A null exact invoice read proves only that this query returned null; it does not establish deletion, payment, or void status.',
  'No mutation, send, fee application, OAuth refresh, endpoint, credentials, workflow, sync behavior, or service configuration is changed.',
];
export async function runOptionalInvoiceEvidence(reader: JobberReader, source: Invoice[], cache: CacheRow[], enabled: boolean): Promise<Record<string, unknown>> {
  if (!enabled) return { outcome: 'not_requested', mutationAllowed: false };
  const startedAt = Date.now(), initialRequests = reader.budget.requests;
  const deadlineAt = Math.min(startedAt + EVIDENCE_LIMITS.durationMs, reader.budget.startedAt + LIMITS.runMs - 60_000);
  let stage = 'targets', targets: Target[] = [], verifiedTargets = 0, exactNullTargets = 0;
  const records: Record<string, unknown>[] = [];
  const summary = () => ({ targetCount: targets.length, verifiedTargets, exactNullTargets, attemptedTargets: records.length,
    requests: reader.budget.requests - initialRequests, elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
    observationsStartedAt: new Date(startedAt).toISOString(), observationsFinishedAt: new Date().toISOString(),
    sourceIdentityRead: 'not_performed', originalSentDateAvailable: false, bankReceiptsVerified: false,
    mutationAllowed: false, records, limitations: LIMITATIONS });
  const check = () => {
    reader.budget.check();
    if (Date.now() >= deadlineAt) throw new AuditFailure('EVIDENCE_TIME_LIMIT');
  };
  const query = async (text: string, vars: Record<string, unknown> = {}) => {
    check();
    if (reader.budget.requests - initialRequests >= EVIDENCE_LIMITS.requests) throw new AuditFailure('EVIDENCE_REQUEST_LIMIT');
    // One attempt each: a throttling/authorization/schema failure preserves core audit, never refreshes.
    const result = await reader.query(text, vars, { maxAttempts: 1, deadlineAt });
    check(); return result;
  };
  try {
    targets = deriveEvidenceTargets(source, cache);
    if (targets.length > EVIDENCE_LIMITS.targets) throw new AuditFailure('EVIDENCE_TARGET_LIMIT', { targets: targets.length });
    if (Date.now() + 30_000 >= deadlineAt) throw new AuditFailure('EVIDENCE_INSUFFICIENT_REMAINING_BUDGET');
    if (targets.length) {
      stage = 'schema-validation';
      const schema = validateEvidenceSchema(await query(SCHEMA_QUERY)), text = evidenceQuery(schema.idType, schema.updatedAtAvailable);
      stage = 'exact-invoice-reads';
      for (const target of targets) {
        check();
        const payments = connectionState(), items = connectionState();
        const cached = cache.find(row => row.jobberInvoiceId === target.id);
        const enumerated = source.find(row => row.id === target.id);
        const result: Record<string, unknown> = { ...target, outcome: 'incomplete', current: null,
          enumerationStatus: enumerated?.invoiceStatus ?? null,
          cached: cached ? { invoiceStatus: safeStatus(cached.invoiceStatus), balanceCents: cents(cached.amountDue),
            ownerId: opaqueId(cached.customer?.jobberClientId), lastSyncedAt: evidenceDate(cached.lastSyncedAt),
            issued: evidenceDate(cached.issuedAt), due: evidenceDate(cached.dueAt) } : null };
        records.push(result);
        let fingerprint: string | null = null;
        try {
          while (!payments.complete || !items.complete) {
            if ((!payments.complete && payments.pages >= EVIDENCE_LIMITS.pagesPerConnection) || (!items.complete && items.pages >= EVIDENCE_LIMITS.pagesPerConnection))
              throw new AuditFailure('EVIDENCE_CONNECTION_PAGE_LIMIT');
            const data = await query(text, { id: target.id, paymentAfter: payments.after, itemAfter: items.after, payments: !payments.complete, items: !items.complete });
            if (data.invoice === null) {
              if (fingerprint !== null) throw new AuditFailure('EVIDENCE_INVOICE_DISAPPEARED_DURING_PAGINATION');
              result.outcome = 'not_returned_by_exact_read'; exactNullTargets++; break;
            }
            if (!object(data.invoice) || data.invoice.id !== target.id) throw new AuditFailure('EVIDENCE_EXACT_INVOICE_ID_MISMATCH');
            const current = safeInvoice(data.invoice, schema.updatedAtAvailable), serialized = JSON.stringify(current);
            if (fingerprint !== null && fingerprint !== serialized) throw new AuditFailure('EVIDENCE_INVOICE_CHANGED_DURING_PAGINATION');
            fingerprint = serialized; result.current = current;
            if (!payments.complete) consumePage(data.invoice.paymentRecords, payments, node => ({ id: node.id,
              amountCents: money(node.amount), entryDate: requiredDate(node.entryDate), adjustmentType: enumValue(node.adjustmentType, schema.enums.adjustment),
              transactionStatus: enumValue(node.jobberPaymentTransactionStatus, schema.enums.transaction, true), tipAmountCents: money(node.tipAmount, true) }));
            if (!items.complete) consumePage(data.invoice.lineItems, items, node => {
              const labels = feeWording(node.name, node.description);
              const category = enumValue(node.category, schema.enums.category);
              if (typeof node.quantity !== 'number' || !Number.isFinite(node.quantity)) throw new AuditFailure('EVIDENCE_QUANTITY_UNVERIFIED');
              const unitPriceCents = money(node.unitPrice), totalPriceCents = money(node.totalPrice);
              const created = requiredDate(node.createdAt), updated = requiredDate(node.updatedAt), date = requiredDate(node.date, true);
              return labels.length ? { id: node.id, labels, quantity: node.quantity, unitPriceCents, totalPriceCents, category,
                created, updated, date, evidence: 'wording-candidate-not-fee-confirmation' } : null;
            });
            if (!payments.complete || !items.complete) { check(); await reader.budget.pause(LIMITS.pageDelayMs); }
          }
          if (payments.complete && items.complete) { result.outcome = 'complete'; verifiedTargets++; }
        } finally {
          result.payments = publicConnection(payments); result.feeWordingCandidates = publicConnection(items);
        }
        if (Buffer.byteLength(JSON.stringify(summary())) > EVIDENCE_LIMITS.outputBytes) throw new AuditFailure('EVIDENCE_OUTPUT_LIMIT');
        check(); await reader.budget.pause(LIMITS.pageDelayMs);
      }
    }
    const final = { outcome: exactNullTargets ? 'incomplete' : 'complete', code: exactNullTargets ? 'EVIDENCE_TARGETS_NOT_RETURNED' : null,
      countsAreComplete: !exactNullTargets, allTargetsAttempted: true, ...summary() };
    if (Buffer.byteLength(JSON.stringify(final)) > EVIDENCE_LIMITS.outputBytes) throw new AuditFailure('EVIDENCE_OUTPUT_LIMIT');
    return final;
  } catch (error) {
    const safe = error instanceof AuditFailure ? error : new AuditFailure('EVIDENCE_READ_FAILED');
    const base = { outcome: 'incomplete', stage, code: safe.code, facts: safe.facts, countsAreComplete: false, ...summary() };
    if (Buffer.byteLength(JSON.stringify(base)) > EVIDENCE_LIMITS.outputBytes)
      return { ...base, records: [], code: 'EVIDENCE_OUTPUT_LIMIT', detailsOmitted: true };
    return base;
  }
}
