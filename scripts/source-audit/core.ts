/** Pure, read-only audit logic. No application sync/auth/GHL imports. */
export const LIMITS = Object.freeze({
  pageSize: 25, maxPages: 500, maxRecords: 12_500, maxResponseBytes: 2_000_000,
  maxTotalBytes: 64_000_000, maxAttempts: 3, requestMs: 25_000,
  runMs: 14 * 60_000, hardStopMs: 14 * 60_000 + 30_000,
  pageDelayMs: 200, detailLimit: 2_000, outputBytes: 8_000_000,
});
export const INVOICE_QUERY = `query AuditInvoices($after: String) {
  invoices(first: 25, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id invoiceNumber invoiceStatus subtotal
      amounts { total invoiceBalance discountAmount subtotal }
      issuedDate dueDate createdAt
      client { id }
    }
  }
}`;
// Same fields, endpoint and API version as lib/jobber.ts at deployed 5dd5a6c.
// No names, contact details, payment dates, speculative totalCount or filters.
export const JOBBER_ENDPOINT = 'https://api.getjobber.com/api/graphql';
export const JOBBER_VERSION = '2025-04-16';
export class AuditFailure extends Error {
  constructor(public readonly code: string, public readonly facts: Record<string, number | boolean> = {}) {
    super(code); this.name = 'AuditFailure';
  }
}
export type Obj = Record<string, unknown>;
export function object(value: unknown): value is Obj {
  return !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}
export function opaqueId(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_+/=:.\-]{1,512}$/.test(value) ? value : null;
}
function numberLabel(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return typeof value === 'string' && /^[A-Za-z0-9#_. /\-]{1,64}$/.test(value) ? value : null;
}
const KNOWN_STATUSES = new Set(['draft', 'sent', 'awaiting_payment', 'past_due', 'paid', 'void', 'bad_debt', 'deleted']);
function status(value: unknown): string | null {
  return typeof value === 'string' && KNOWN_STATUSES.has(value.toLowerCase()) ? value.toLowerCase() : null;
}
/** Never coerce null, '', boolean or object into a zero. Reject sub-cent precision. */
export function cents(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const scaled = value * 100, rounded = Math.round(scaled);
  return Number.isSafeInteger(rounded) && Math.abs(scaled - rounded) <= 0.00001 ? rounded : null;
}
export function shape(value: unknown): string {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? 'Date' : 'invalid-Date';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isFinite(value) ? 'number' : 'non-finite-number';
  if (typeof value !== 'string') return typeof value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'date-only-string';
  if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return 'timezone-datetime-string';
  return 'other-string';
}
export function dateValue(value: unknown): { kind: 'valid' | 'null' | 'unknown'; day?: string; instant?: number } {
  if (value === null) return { kind: 'null' };
  if (value instanceof Date && Number.isFinite(value.getTime())) return { kind: 'valid', day: value.toISOString().slice(0, 10), instant: value.getTime() };
  if (typeof value !== 'string') return { kind: 'unknown' };
  const s = shape(value);
  if (s !== 'date-only-string' && s !== 'timezone-datetime-string') return { kind: 'unknown' };
  const n = Date.parse(value);
  if (!Number.isFinite(n)) return { kind: 'unknown' };
  // Date.parse normalizes invalid dates (e.g. February 30). Reject them.
  const prefix = value.slice(0, 10);
  if (new Date(`${prefix}T00:00:00Z`).toISOString().slice(0, 10) !== prefix) return { kind: 'unknown' };
  return { kind: 'valid', day: prefix, instant: n };
}
export type CacheRow = {
  jobberInvoiceId: string; invoiceNumber: string | null; invoiceStatus: string | null;
  subtotal: number; total: number; amountPaid: number; amountDue: number;
  issuedAt: Date | null; dueAt: Date | null; paidAt: Date | null; createdAtJobber: Date | null;
  customerId: string | null; customer: { jobberClientId: string } | null; lastSyncedAt: Date;
};
export type Invoice = {
  id: string; invoiceNumber: string | null; invoiceStatus: string | null;
  total: number | null; balance: number | null; subtotal: number | null;
  discount: number | null; owner: string | null;
  dates: Record<'issued' | 'due' | 'created', ReturnType<typeof dateValue>>;
  issues: string[]; raw: Obj;
};
export function normalize(node: unknown): Invoice {
  if (!object(node) || !opaqueId(node.id)) throw new AuditFailure('INVALID_SOURCE_INVOICE_ID');
  const amounts = object(node.amounts) ? node.amounts : {};
  const client = object(node.client) ? node.client : {};
  const issues: string[] = [];
  const total = cents(amounts.total), balance = cents(amounts.invoiceBalance);
  const primarySubtotal = cents(node.subtotal), nestedSubtotal = cents(amounts.subtotal);
  const subtotal = primarySubtotal ?? nestedSubtotal;
  const discount = cents(amounts.discountAmount);
  const owner = opaqueId(client.id);
  if (!numberLabel(node.invoiceNumber)) issues.push(`invoiceNumber:${shape(node.invoiceNumber)}`);
  if (!status(node.invoiceStatus)) issues.push(`invoiceStatus:${shape(node.invoiceStatus)}`);
  for (const [key, value] of Object.entries({ total, invoiceBalance: balance, discountAmount: discount, subtotal: nestedSubtotal })) {
    if (value === null) issues.push(`amounts.${key}:${shape(amounts[key])}`);
  }
  if (primarySubtotal === null) issues.push(`subtotal:${shape(node.subtotal)}`);
  if (primarySubtotal !== null && nestedSubtotal !== null && primarySubtotal !== nestedSubtotal) issues.push('subtotal-fields-disagree');
  if (!owner) issues.push(`client.id:${shape(client.id)}`);
  const dates = { issued: dateValue(node.issuedDate), due: dateValue(node.dueDate), created: dateValue(node.createdAt) };
  for (const [key, value] of Object.entries(dates)) {
    if (value.kind !== 'valid') issues.push(`${key}Date:${value.kind}`);
  }
  if (balance !== null && total !== null && balance > total) issues.push('balance-exceeds-total');
  return { id: node.id as string, invoiceNumber: numberLabel(node.invoiceNumber), invoiceStatus: status(node.invoiceStatus), total, balance, subtotal, discount, owner, dates, issues, raw: node };
}
export type PageFetch = (after: string | null) => Promise<unknown>;
export async function paginate(fetchPage: PageFetch, options: { maxPages?: number; maxRecords?: number; pause?: () => Promise<void> } = {}) {
  const records: Invoice[] = [], ids = new Set<string>(), cursors = new Set<string>();
  let after: string | null = null, pages = 0;
  const maxPages = options.maxPages ?? LIMITS.maxPages, maxRecords = options.maxRecords ?? LIMITS.maxRecords;
  let firstPage: unknown;
  while (true) {
    if (pages >= maxPages) throw new AuditFailure('SOURCE_PAGE_LIMIT', { pages, invoices: records.length });
    const data = await fetchPage(after);
    if (firstPage === undefined) firstPage = data;
    if (!object(data) || !object(data.invoices)) throw new AuditFailure('SOURCE_CONNECTION_MISSING', { pages });
    const block = data.invoices;
    if (!Array.isArray(block.nodes) || !object(block.pageInfo) || typeof block.pageInfo.hasNextPage !== 'boolean') throw new AuditFailure('SOURCE_PAGE_MALFORMED', { pages });
    const nodes = block.nodes, info = block.pageInfo;
    if (nodes.length > LIMITS.pageSize) throw new AuditFailure('SOURCE_PAGE_OVERSIZE', { pages });
    if (nodes.length === 0 && (info.hasNextPage || pages > 0)) throw new AuditFailure('SOURCE_EMPTY_CONTINUATION', { pages });
    if (nodes.length > 0 && (typeof info.endCursor !== 'string' || !info.endCursor || info.endCursor.length > 2048)) throw new AuditFailure('SOURCE_CURSOR_MISSING', { pages });
    if (nodes.length === 0 && info.endCursor !== null) throw new AuditFailure('SOURCE_EMPTY_CURSOR_INVALID', { pages });
    if (typeof info.endCursor === 'string') {
      if (cursors.has(info.endCursor)) throw new AuditFailure('SOURCE_CURSOR_REPEATED', { pages });
      cursors.add(info.endCursor);
    }
    for (const node of nodes) {
      const inv = normalize(node);
      if (ids.has(inv.id)) throw new AuditFailure('SOURCE_ID_REPEATED', { pages, invoices: records.length });
      ids.add(inv.id); records.push(inv);
      if (records.length > maxRecords) throw new AuditFailure('SOURCE_RECORD_LIMIT', { pages, invoices: records.length });
    }
    pages++;
    if (!info.hasNextPage) break;
    after = info.endCursor as string;
    await options.pause?.();
  }
  return { records, pages, firstPage, terminalPageObserved: true, uniqueIds: ids.size, uniqueCursors: cursors.size };
}
function add(map: Record<string, number>, key: string) { map[key] = (map[key] ?? 0) + 1; }
function sum(values: (number | null)[]) {
  let out = 0;
  for (const value of values) if (value !== null) {
    out += value;
    if (!Number.isSafeInteger(out)) throw new AuditFailure('TOTAL_OUT_OF_RANGE');
  }
  return out;
}
function statistics(rows: { invoiceStatus: string | null; total: number | null; balance: number | null }[]) {
  const byStatus: Record<string, { count: number; totalCents: number; positiveBalanceCents: number; negativeBalanceCents: number; zeroBalances: number; unknownBalances: number; unknownTotals: number }> = {};
  for (const row of rows) {
    const key = row.invoiceStatus ?? 'unknown';
    const bucket = byStatus[key] ??= { count: 0, totalCents: 0, positiveBalanceCents: 0, negativeBalanceCents: 0, zeroBalances: 0, unknownBalances: 0, unknownTotals: 0 };
    bucket.count++; bucket.totalCents = sum([bucket.totalCents, row.total]);
    if (row.total === null) bucket.unknownTotals++;
    if (row.balance === null) bucket.unknownBalances++;
    else if (row.balance > 0) bucket.positiveBalanceCents = sum([bucket.positiveBalanceCents, row.balance]);
    else if (row.balance < 0) bucket.negativeBalanceCents = sum([bucket.negativeBalanceCents, row.balance]);
    else bucket.zeroBalances++;
  }
  return {
    count: rows.length, totalCents: sum(rows.map(r => r.total)),
    positiveBalanceCount: rows.filter(r => r.balance !== null && r.balance > 0).length,
    positiveBalanceCents: sum(rows.filter(r => r.balance !== null && r.balance > 0).map(r => r.balance)),
    negativeBalanceCount: rows.filter(r => r.balance !== null && r.balance < 0).length,
    negativeBalanceCents: sum(rows.filter(r => r.balance !== null && r.balance < 0).map(r => r.balance)),
    openPositiveCount: rows.filter(r => ['awaiting_payment', 'past_due'].includes(r.invoiceStatus ?? '') && r.balance !== null && r.balance > 0).length,
    openPositiveBalanceCents: sum(rows.filter(r => ['awaiting_payment', 'past_due'].includes(r.invoiceStatus ?? '') && r.balance !== null && r.balance > 0).map(r => r.balance)),
    pastDuePositiveCount: rows.filter(r => r.invoiceStatus === 'past_due' && r.balance !== null && r.balance > 0).length,
    pastDuePositiveBalanceCents: sum(rows.filter(r => r.invoiceStatus === 'past_due' && r.balance !== null && r.balance > 0).map(r => r.balance)),
    unknownTotalCount: rows.filter(r => r.total === null).length,
    unknownBalanceCount: rows.filter(r => r.balance === null).length,
    paidPositiveCount: rows.filter(r => r.invoiceStatus === 'paid' && r.balance !== null && r.balance > 0).length,
    paidPositiveBalanceCents: sum(rows.filter(r => r.invoiceStatus === 'paid' && r.balance !== null && r.balance > 0).map(r => r.balance)),
    byStatus,
  };
}
function duplicates(rows: { id: string; invoiceNumber: string | null }[]) {
  const numbers = new Map<string, string[]>();
  for (const row of rows) if (row.invoiceNumber) numbers.set(row.invoiceNumber, [...(numbers.get(row.invoiceNumber) ?? []), row.id]);
  return [...numbers.entries()].filter(([, ids]) => ids.length > 1).map(([invoiceNumber, ids]) => ({ invoiceNumber, ids }));
}
function dateComparison(source: ReturnType<typeof dateValue>, cached: unknown, dayOnly: boolean) {
  const c = dateValue(cached);
  if (source.kind === 'unknown' || c.kind === 'unknown') return 'unverifiable';
  if (source.kind !== c.kind) return 'different';
  if (source.kind === 'null') return 'equal';
  return (dayOnly ? source.day === c.day : source.instant === c.instant) ? 'equal' : 'different';
}
function publicSource(inv: Invoice | undefined) {
  return inv ? { invoiceNumber: inv.invoiceNumber, status: inv.invoiceStatus, totalCents: inv.total, balanceCents: inv.balance, subtotalCents: inv.subtotal, discountCents: inv.discount, ownerId: inv.owner } : null;
}
function publicCache(row: CacheRow | undefined) {
  return row ? { invoiceNumber: numberLabel(row.invoiceNumber), status: status(row.invoiceStatus), totalCents: cents(row.total), balanceCents: cents(row.amountDue), subtotalCents: cents(row.subtotal), storedAmountPaidCentsUnverified: cents(row.amountPaid), ownerId: opaqueId(row.customer?.jobberClientId) } : null;
}
export function compare(source: Invoice[], cache: CacheRow[], targetNumbers: string[] = [], detailLimit: number = LIMITS.detailLimit) {
  const sourceById = new Map(source.map(s => [s.id, s])), cacheById = new Map<string, CacheRow>();
  for (const row of cache) {
    if (!opaqueId(row.jobberInvoiceId)) throw new AuditFailure('CACHE_ID_INVALID');
    if (cacheById.has(row.jobberInvoiceId)) throw new AuditFailure('CACHE_ID_REPEATED');
    cacheById.set(row.jobberInvoiceId, row);
  }
  if (sourceById.size !== source.length) throw new AuditFailure('SOURCE_ID_REPEATED');
  const detailRows: Obj[] = [], fieldDifferences: Record<string, number> = {}, sourceIssues: Record<string, number> = {};
  const dateShapes: Record<string, Record<string, number>> = { issuedDate: {}, dueDate: {}, createdAt: {} };
  let sourceOnly = 0, cacheOnly = 0, matching = 0, differing = 0, cachedPaidDatesUnverified = 0, cachedPaidDateEqualsIssueDate = 0, dateFieldsUnverifiable = 0;
  for (const inv of source) {
    for (const issue of inv.issues) add(sourceIssues, issue);
    for (const key of Object.keys(dateShapes)) add(dateShapes[key], shape(inv.raw[key]));
  }
  const duplicateSource = duplicates(source), duplicateCache = duplicates(cache.map(r => ({ id: r.jobberInvoiceId, invoiceNumber: numberLabel(r.invoiceNumber) })));
  const duplicateIds = new Set([...duplicateSource, ...duplicateCache].flatMap(d => d.ids));
  for (const id of new Set([...sourceById.keys(), ...cacheById.keys()])) {
    const src = sourceById.get(id), row = cacheById.get(id), fields: string[] = [];
    if (!src) { cacheOnly++; fields.push('not-returned-by-source'); }
    else if (!row) { sourceOnly++; fields.push('missing-from-cache'); }
    else {
      const s = publicSource(src)!, c = publicCache(row)!;
      for (const key of ['invoiceNumber', 'status', 'totalCents', 'balanceCents', 'subtotalCents', 'ownerId'] as const) {
        if (s[key] === null || c[key] === null) fields.push(`${key}-unverifiable`);
        if (s[key] !== c[key]) fields.push(key);
      }
      for (const [key, value, dayOnly] of [['issued', row.issuedAt, true], ['due', row.dueAt, true], ['created', row.createdAtJobber, false]] as const) {
        const result = dateComparison(src.dates[key], value, dayOnly);
        if (result === 'different') fields.push(`${key}Date`);
        if (result === 'unverifiable') { fields.push(`${key}Date-unverifiable`); dateFieldsUnverifiable++; }
      }
      // Arithmetic diagnostic only. Neither this value nor cached amountPaid is a cash receipt.
      if (src.total !== null && src.balance !== null && src.total - src.balance !== cents(row.amountPaid)) fields.push('storedAmountPaid-vs-totalMinusBalance');
      if (row.customerId && !row.customer) fields.push('orphan-customer-relation');
      if (fields.length) differing++; else matching++;
    }
    if (row?.paidAt) {
      cachedPaidDatesUnverified++;
      if (row.issuedAt && row.paidAt.getTime() === row.issuedAt.getTime()) cachedPaidDateEqualsIssueDate++;
    }
    for (const field of fields) add(fieldDifferences, field);
    const srcConflict = src?.invoiceStatus === 'paid' && src.balance !== null && src.balance > 0;
    const cacheConflict = row && status(row.invoiceStatus) === 'paid' && row.amountDue > 0;
    const srcCredit = src?.invoiceStatus === 'paid' && src.balance !== null && src.balance < 0;
    const cacheCredit = row && status(row.invoiceStatus) === 'paid' && row.amountDue < 0;
    const isVoid = src?.invoiceStatus === 'void' || (row && status(row.invoiceStatus) === 'void');
    const targeted = targetNumbers.includes(src?.invoiceNumber ?? '') || targetNumbers.includes(numberLabel(row?.invoiceNumber) ?? '');
    const reasons = [fields.length ? 'difference' : '', srcConflict ? 'source-paid-positive' : '', cacheConflict ? 'cache-paid-positive' : '', srcCredit ? 'source-paid-negative' : '', cacheCredit ? 'cache-paid-negative' : '', isVoid ? 'void-record' : '', src?.issues.length ? 'source-field-quality' : '', duplicateIds.has(id) ? 'duplicate-invoice-number' : '', targeted ? 'requested-target' : ''].filter(Boolean);
    if (reasons.length) detailRows.push({ id, reasons, fields, source: publicSource(src), cache: publicCache(row), sourceIssues: src?.issues ?? [], cachedPaidDateIsUnverified: !!row?.paidAt });
  }
  // Keep target/conflict records first if the bounded log detail limit is exceeded.
  detailRows.sort((a, b) => {
    const priority = (x: Obj) => (x.reasons as string[]).some(r => /target|paid-positive/.test(r)) ? 0 : 1;
    return priority(a) - priority(b) || String(a.id).localeCompare(String(b.id));
  });
  const targetResolution = targetNumbers.map(invoiceNumber => ({ invoiceNumber,
    sourceIds: source.filter(s => s.invoiceNumber === invoiceNumber).map(s => s.id),
    cacheIds: cache.filter(c => numberLabel(c.invoiceNumber) === invoiceNumber).map(c => c.jobberInvoiceId),
  }));
  return {
    source: statistics(source), cache: statistics(cache.map(r => ({ invoiceStatus: status(r.invoiceStatus), total: cents(r.total), balance: cents(r.amountDue) }))),
    comparison: { sourceOnly, cacheOnly, matching, differing, fieldDifferences, dateFieldsUnverifiable },
    sourceIssues, sourceDateShapes: dateShapes, duplicateInvoiceNumbers: { source: duplicateSource, cache: duplicateCache },
    paymentEvidence: { verifiedCashTotal: null, actualPaymentDatesAvailable: false, cachedPaidDatesUnverified, cachedPaidDateEqualsIssueDate },
    targetResolution, details: detailRows.slice(0, detailLimit), detailCount: detailRows.length,
    detailsTruncated: detailRows.length > detailLimit, omittedDetailCount: Math.max(0, detailRows.length - detailLimit),
  };
}

/** Review targets come from current cache facts, never a private hard-coded list. */
export function deriveTargets(cache: CacheRow[]): string[] {
  const duplicateNumbers = duplicates(cache.map(row => ({ id: row.jobberInvoiceId, invoiceNumber: numberLabel(row.invoiceNumber) }))).map(group => group.invoiceNumber);
  const flaggedNumbers = cache.filter(row => status(row.invoiceStatus) === 'void' || (status(row.invoiceStatus) === 'paid' && row.amountDue !== 0)).map(row => numberLabel(row.invoiceNumber)).filter((value): value is string => value !== null);
  return [...new Set([...duplicateNumbers, ...flaggedNumbers])].sort();
}
