import { GhlPreviewFailure as Failure, GhlReadonlyReader, GHL_LIMITS, id, object } from './transport';
export type DndStatus = 'active' | 'inactive' | 'permanent' | 'unknown';
export type Contact = { id: string; email: string | null; phone: string | null;
  additionalEmails: string[]; additionalPhones: string[]; contactShapeValid: boolean;
  globalDnd: boolean | null; smsDnd: DndStatus; emailDnd: DndStatus; callDnd: DndStatus };
export type StageClass = 'sent' | 'overdue' | 'paid' | 'closed_out' | 'late_fee' | 'canceled' | 'other';
export type Pipeline = { id: string; stages: Map<string, StageClass>; requiredStagesPresent: boolean };
export type Card = { id: string; contactId: string | null; pipelineId: string; stageId: string | null;
  status: 'open' | 'won' | 'lost' | 'abandoned' | 'unknown'; ownerShapeValid: boolean };
const nullableText = (v: unknown): string | null => typeof v === 'string' ? v : null;
const dndStatus = (v: unknown): DndStatus => object(v) && ['active', 'inactive', 'permanent'].includes(String(v.status)) ? v.status as DndStatus : 'unknown';
function extra(v: unknown, key: string) { return Array.isArray(v) ? v.filter(object).map(x => nullableText(x[key])).filter((x): x is string => x !== null) : []; }
export function readContact(v: unknown, locationId: string): Contact {
  if (!object(v) || !id(v.id)) throw new Failure('CONTACT_ID_SHAPE_INVALID');
  if (v.locationId != null && v.locationId !== locationId) throw new Failure('CONTACT_LOCATION_MISMATCH');
  const shapeValid = (v.email == null || typeof v.email === 'string') && (v.phone == null || typeof v.phone === 'string') &&
    (v.additionalEmails == null || Array.isArray(v.additionalEmails) && v.additionalEmails.every(x => object(x) && typeof x.email === 'string')) &&
    (v.additionalPhones == null || Array.isArray(v.additionalPhones) && v.additionalPhones.every(x => object(x) && typeof x.phone === 'string'));
  const settings = object(v.dndSettings) ? v.dndSettings : {};
  return { id: v.id, email: nullableText(v.email), phone: nullableText(v.phone),
    additionalEmails: extra(v.additionalEmails, 'email'), additionalPhones: extra(v.additionalPhones, 'phone'),
    contactShapeValid: shapeValid, globalDnd: typeof v.dnd === 'boolean' ? v.dnd : null,
    smsDnd: dndStatus(settings.SMS), emailDnd: dndStatus(settings.Email), callDnd: dndStatus(settings.Call) };
}
function count(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > GHL_LIMITS.maxRecords) throw new Failure('SNAPSHOT_TOTAL_SHAPE_OR_LIMIT');
  return v;
}
function stageClass(name: string): StageClass {
  const n = name.trim().toLowerCase();
  return n === 'invoice sent' ? 'sent' : n === 'invoice overdue' ? 'overdue' : n === 'invoice paid' ? 'paid' :
    n === 'closed out' ? 'closed_out' : n.includes('late fee') ? 'late_fee' : n === 'invoice canceled' || n === 'invoice cancelled' ? 'canceled' : 'other';
}
export async function readInvoicePipeline(reader: GhlReadonlyReader): Promise<Pipeline> {
  const data = await reader.request(`/opportunities/pipelines?${new URLSearchParams({ locationId: reader.locationId })}`);
  if (!Array.isArray(data.pipelines) || data.pipelines.some(p => !object(p) || !id(p.id) || typeof p.name !== 'string')) throw new Failure('PIPELINE_RESPONSE_SHAPE');
  const found = data.pipelines.filter(p => object(p) && (p.name as string).trim().toLowerCase() === 'invoice pipeline');
  if (found.length !== 1) throw new Failure('INVOICE_PIPELINE_MISSING_OR_AMBIGUOUS', { matches: found.length });
  const p = found[0] as Record<string, unknown>;
  if (p.locationId != null && p.locationId !== reader.locationId) throw new Failure('PIPELINE_LOCATION_MISMATCH');
  if (!Array.isArray(p.stages)) throw new Failure('PIPELINE_STAGES_SHAPE');
  const stages = new Map<string, StageClass>(); const seenNames = new Set<string>();
  for (const s of p.stages) {
    if (!object(s) || !id(s.id) || typeof s.name !== 'string' || stages.has(s.id) || seenNames.has(s.name.trim().toLowerCase())) throw new Failure('PIPELINE_STAGE_INVALID_OR_DUPLICATE');
    stages.set(s.id, stageClass(s.name)); seenNames.add(s.name.trim().toLowerCase());
  }
  return { id: p.id as string, stages, requiredStagesPresent: ['sent', 'overdue', 'paid'].every(s => [...stages.values()].includes(s as StageClass)) };
}
export async function readAllContacts(reader: GhlReadonlyReader) {
  const out = new Map<string, Contact>(); const cursors = new Set<string>();
  let expected: number | undefined; let searchAfter: Array<string | number> | undefined;
  for (let page = 1; page <= GHL_LIMITS.maxPages; page++) {
    const data = await reader.request('/contacts/search', 'POST', { locationId: reader.locationId, pageLimit: GHL_LIMITS.pageSize,
      fastPagination: false, sort: [{ field: 'dateAdded', direction: 'asc' }], ...(searchAfter ? { searchAfter } : { page: 1 }) });
    const total = count(data.total);
    if (!Array.isArray(data.contacts) || data.contacts.length > GHL_LIMITS.pageSize || (expected !== undefined && total !== expected)) throw new Failure('CONTACT_PAGINATION_SHAPE_OR_TOTAL_CHANGED');
    expected = total;
    for (const raw of data.contacts) {
      const c = readContact(raw, reader.locationId);
      if (out.has(c.id)) throw new Failure('CONTACT_DUPLICATE_ID'); out.set(c.id, c);
    }
    if (out.size > total) throw new Failure('CONTACT_TOTAL_EXCEEDED');
    if (out.size === total) return { contacts: [...out.values()], pages: page, total, cursorCount: cursors.size };
    const last = data.contacts.at(-1); const cursor = object(last) ? last.searchAfter : undefined;
    if (!Array.isArray(cursor) || !cursor.length || cursor.length > 10 || cursor.some(v => !(typeof v === 'string' && v.length > 0 && v.length < 1024) && !(typeof v === 'number' && Number.isFinite(v)))) throw new Failure('CONTACT_CURSOR_MISSING_OR_INVALID');
    const key = JSON.stringify(cursor);
    if (cursors.has(key)) throw new Failure('CONTACT_CURSOR_REPEATED'); cursors.add(key); searchAfter = cursor;
  }
  throw new Failure('CONTACT_PAGE_LIMIT');
}
export async function readAllPipelineCards(reader: GhlReadonlyReader, pipeline: Pipeline) {
  const params = new URLSearchParams({ location_id: reader.locationId, pipeline_id: pipeline.id, status: 'all', limit: '100' });
  const out = new Map<string, Card>(); const cursors = new Set<string>(); let expected: number | undefined;
  for (let page = 1; page <= GHL_LIMITS.maxPages; page++) {
    const data = await reader.request(`/opportunities/search?${params}`);
    if (!object(data.meta)) throw new Failure('OPPORTUNITY_META_SHAPE');
    const total = count(data.meta.total);
    if (!Array.isArray(data.opportunities) || data.opportunities.length > GHL_LIMITS.pageSize || (expected !== undefined && total !== expected)) throw new Failure('OPPORTUNITY_PAGINATION_SHAPE_OR_TOTAL_CHANGED');
    expected = total;
    for (const c of data.opportunities) {
      if (!object(c) || !id(c.id) || out.has(c.id)) throw new Failure('OPPORTUNITY_INVALID_OR_DUPLICATE_ID');
      if (c.pipelineId !== pipeline.id || (c.locationId != null && c.locationId !== reader.locationId)) throw new Failure('OPPORTUNITY_PIPELINE_OR_LOCATION_MISMATCH');
      const contactId = id(c.contactId) ? c.contactId : null;
      const embedded = object(c.contact) && id(c.contact.id) ? c.contact.id : null;
      out.set(c.id, { id: c.id, contactId, pipelineId: pipeline.id, stageId: id(c.pipelineStageId) ? c.pipelineStageId : null,
        status: typeof c.status === 'string' && ['open', 'won', 'lost', 'abandoned'].includes(c.status) ? c.status as Card['status'] : 'unknown',
        ownerShapeValid: !!contactId && (!embedded || embedded === contactId) });
    }
    if (out.size > total) throw new Failure('OPPORTUNITY_TOTAL_EXCEEDED');
    if (out.size === total) return { cards: [...out.values()], pages: page, total, cursorCount: cursors.size };
    const { startAfter, startAfterId } = data.meta;
    if (!data.opportunities.length || !(typeof startAfter === 'number' && Number.isSafeInteger(startAfter) && startAfter >= 0 || typeof startAfter === 'string' && /^\d{1,16}$/.test(startAfter)) || !id(startAfterId)) throw new Failure('OPPORTUNITY_CURSOR_MISSING_OR_INVALID');
    const key = JSON.stringify([startAfter, startAfterId]);
    if (cursors.has(key)) throw new Failure('OPPORTUNITY_CURSOR_REPEATED');
    cursors.add(key); params.set('startAfter', String(startAfter)); params.set('startAfterId', startAfterId);
  }
  throw new Failure('OPPORTUNITY_PAGE_LIMIT');
}
