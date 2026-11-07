import { AuditFailure, INVOICE_QUERY, JOBBER_ENDPOINT, JOBBER_VERSION, LIMITS, object } from './core';
export class Budget {
  readonly startedAt = Date.now();
  bytes = 0;
  requests = 0;
  retries = 0;
  check() { if (Date.now() - this.startedAt >= LIMITS.runMs) throw new AuditFailure('RUN_TIME_LIMIT'); }
  async pause(ms: number) { this.check(); await new Promise(resolve => setTimeout(resolve, ms)); this.check(); }
}
export function expiryMinutes(expiresAt: Date, now = Date.now()): number {
  return Math.floor((expiresAt.getTime() - now) / 60_000);
}
export function requireToken(expiresAt: Date, now = Date.now()) {
  const remaining = expiresAt.getTime() - now;
  if (!Number.isFinite(remaining) || remaining <= 30_000) throw new AuditFailure('EXISTING_TOKEN_EXPIRED_OR_NEAR_EXPIRY', { expiryRemainingMinutes: Number.isFinite(remaining) ? expiryMinutes(expiresAt, now) : -1 });
}
export function requireTokenRunCoverage(expiresAt: Date, now = Date.now()) {
  requireToken(expiresAt, now);
  if (expiresAt.getTime() - now < LIMITS.hardStopMs + 30_000) throw new AuditFailure('EXISTING_TOKEN_INSUFFICIENT_RUN_COVERAGE', { expiryRemainingMinutes: expiryMinutes(expiresAt, now), requiredMinutes: Math.ceil((LIMITS.hardStopMs + 30_000) / 60_000) });
}
export async function boundedJson(response: Response, budget: Budget, controller: AbortController) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > LIMITS.maxResponseBytes) {
    controller.abort(); await response.body?.cancel(); throw new AuditFailure('RESPONSE_BYTE_LIMIT');
  }
  if (!response.body) { controller.abort(); throw new AuditFailure('EMPTY_RESPONSE_BODY'); }
  const reader = response.body.getReader(), parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      budget.check();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength; budget.bytes += value.byteLength;
      if (size > LIMITS.maxResponseBytes || budget.bytes > LIMITS.maxTotalBytes) {
        controller.abort(); throw new AuditFailure('RESPONSE_BYTE_LIMIT', { bytes: budget.bytes });
      }
      parts.push(value);
    }
    const joined = Buffer.concat(parts);
    try { return JSON.parse(joined.toString('utf8')) as unknown; }
    catch { throw new AuditFailure('INVALID_JSON_RESPONSE'); }
  } catch (error) {
    controller.abort();
    try { await reader.cancel(); } catch { /* Preserve sanitized original failure. */ }
    throw error;
  } finally { reader.releaseLock(); }
}
export class JobberReader {
  constructor(private readonly token: string, private readonly expiresAt: Date, readonly budget: Budget, private readonly fetcher: typeof fetch = fetch) {}
  async query(query: string, variables: Record<string, unknown> = {}, options: { maxAttempts?: number; deadlineAt?: number } = {}) {
    if (!/^\s*query\b/.test(query)) throw new AuditFailure('NON_READ_QUERY_REJECTED');
    const maxAttempts = Math.min(LIMITS.maxAttempts, options.maxAttempts ?? LIMITS.maxAttempts);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) throw new AuditFailure('PROBE_TIME_LIMIT');
      this.budget.check(); requireToken(this.expiresAt);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(LIMITS.requestMs, (options.deadlineAt ?? Infinity) - Date.now())));
      let retry = false;
      try {
        this.budget.requests++;
        const response = await this.fetcher(JOBBER_ENDPOINT, { method: 'POST', redirect: 'error',
          headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', 'X-JOBBER-GRAPHQL-VERSION': JOBBER_VERSION },
          body: JSON.stringify({ query, variables }), signal: controller.signal });
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel();
          throw new AuditFailure('EXISTING_CONNECTION_AUTHORIZATION_FAILED', { httpStatus: response.status, expiryRemainingMinutes: expiryMinutes(this.expiresAt) });
        }
        if (response.status === 429 || response.status >= 500) {
          await response.body?.cancel(); retry = true;
        } else {
          if (!response.ok) { await response.body?.cancel(); throw new AuditFailure('SOURCE_HTTP_ERROR', { httpStatus: response.status }); }
          const payload = await boundedJson(response, this.budget, controller);
          if (!object(payload)) throw new AuditFailure('SOURCE_RESPONSE_MALFORMED');
          if (payload.errors !== undefined && !Array.isArray(payload.errors)) throw new AuditFailure('SOURCE_ERRORS_MALFORMED');
          if (Array.isArray(payload.errors) && payload.errors.length) {
            const allThrottled = payload.errors.every(e => object(e) && object(e.extensions) && e.extensions.code === 'THROTTLED');
            if (allThrottled) retry = true;
            else throw new AuditFailure('SOURCE_GRAPHQL_ERROR', { graphqlErrorCount: payload.errors.length });
          } else if (!object(payload.data)) throw new AuditFailure('SOURCE_DATA_MISSING');
          else return payload.data;
        }
      } catch (error) {
        if (error instanceof AuditFailure) throw error;
        if (controller.signal.aborted) throw new AuditFailure('SOURCE_REQUEST_TIMEOUT');
        // Never print raw errors, body text, headers, URLs or credentials.
        throw new AuditFailure('SOURCE_NETWORK_ERROR');
      } finally { controller.abort(); clearTimeout(timer); }
      if (retry && attempt < maxAttempts - 1) {
        this.budget.retries++; await this.budget.pause(1500 * (attempt + 1));
      }
    }
    throw new AuditFailure('SOURCE_RETRIES_EXHAUSTED');
  }
  page(after: string | null) { return this.query(INVOICE_QUERY, { after }); }
}
const CAPABILITY_QUERY = `query AuditTypeCapabilities($typeName: String!) {
  __type(name: $typeName) {
    name kind possibleTypes { name kind }
    fields { name
      args { name type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } } }
      type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } }
    }
  }
}`;
const schemaName = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,80}$/.test(v);
function safeType(value: unknown, depth = 0): string | null {
  if (!object(value) || depth > 5) return null;
  if (schemaName(value.name)) return value.name;
  const nested = safeType(value.ofType, depth + 1);
  if (!nested) return null;
  if (value.kind === 'NON_NULL') return `${nested}!`;
  if (value.kind === 'LIST') return `[${nested}]`;
  return null;
}
function namedType(value: unknown, depth = 0): { name: string; kind: string } | null {
  if (!object(value) || depth > 5) return null;
  if (schemaName(value.name) && typeof value.kind === 'string') return { name: value.name, kind: value.kind };
  return namedType(value.ofType, depth + 1);
}
function safeFields(values: unknown) {
  return (Array.isArray(values) ? values : []).filter(f => object(f) && schemaName(f.name)).slice(0, 100)
    .map(f => { const field = f as Record<string, unknown>; return { name: field.name as string, type: safeType(field.type),
      args: (Array.isArray(field.args) ? field.args : []).filter(a => object(a) && schemaName(a.name)).slice(0, 20)
        .map(a => ({ name: a.name as string, type: safeType(a.type) })) }; });
}
function incompleteMetadata(fields: unknown[]): boolean {
  return fields.length > 100 || fields.some(f => !object(f) || !schemaName(f.name) || !safeType(f.type) ||
    (f.args !== undefined && (!Array.isArray(f.args) || f.args.length > 20 ||
      f.args.some(a => !object(a) || !schemaName(a.name) || !safeType(a.type)))));
}
export async function capabilityProbe(reader: JobberReader) {
  const deadlineAt = Math.min(Date.now() + 120_000, reader.budget.startedAt + LIMITS.runMs - 30_000);
  const options = { maxAttempts: 1, deadlineAt };
  const childSchema: { name: string; fields: ReturnType<typeof safeFields>; possibleTypes: string[]; truncated: boolean }[] = [];
  let requests = 0;
  try {
    if (Date.now() >= deadlineAt) throw new AuditFailure('PROBE_TIME_LIMIT');
    requests++;
    const data = await reader.query(CAPABILITY_QUERY, { typeName: 'Invoice' }, options);
    if (!object(data.__type) || !Array.isArray(data.__type.fields)) return { available: false, reason: 'TYPE_UNAVAILABLE', fields: [], childSchema, requests };
    const root = data.__type;
    const rootFieldsTruncated = (root.fields as unknown[]).length > 100;
    const rootSchemaIncomplete = incompleteMetadata((root.fields as unknown[]).filter(f => object(f) && typeof f.name === 'string' && /sent|payment|transaction|receipt|lineitem|product|fee|linkedCommunications|invoiceNet/i.test(f.name)));
    let unresolvedRequiredType = false;
    const fields = safeFields(root.fields).filter(f => /sent|payment|transaction|receipt|lineitem|product|fee|linkedCommunications|invoiceNet/i.test(f.name));
    const queue: { name: string; role: 'connection' | 'edge' | 'node' }[] = [];
    const seen = new Set(['Invoice']);
    const enqueue = (type: unknown, role: 'connection' | 'edge' | 'node') => {
      const named = namedType(type);
      if (!named || !['OBJECT', 'INTERFACE', 'UNION'].includes(named.kind)) { unresolvedRequiredType = true; return; }
      if (!seen.has(named.name)) {
        seen.add(named.name); queue.push({ name: named.name, role });
      }
    };
    for (const field of root.fields as unknown[]) if (object(field) && ['paymentRecords', 'linkedCommunications', 'lineItems'].includes(String(field.name))) enqueue(field.type, 'connection');
    let childReason: string | null = null;
    while (queue.length && requests < 12) {
      if (Date.now() >= deadlineAt) { childReason = 'PROBE_TIME_LIMIT'; break; }
      const next = queue.shift()!;
      try {
        requests++;
        const result = await reader.query(CAPABILITY_QUERY, { typeName: next.name }, options);
        const type = result.__type;
        if (!object(type) || (!Array.isArray(type.fields) && type.kind !== 'UNION')) { childReason = 'CHILD_TYPE_UNAVAILABLE'; break; }
        const typeFields = Array.isArray(type.fields) ? type.fields : [];
        const possible = (Array.isArray(type.possibleTypes) ? type.possibleTypes : []).filter(t => object(t) && schemaName(t.name));
        childSchema.push({ name: next.name, fields: safeFields(typeFields), possibleTypes: possible.slice(0, 8).map(t => t.name as string),
          truncated: incompleteMetadata(typeFields) || possible.length > 8 || (Array.isArray(type.possibleTypes) && possible.length !== type.possibleTypes.length) });
        if ((next.role === 'connection' && !typeFields.some(f => object(f) && ['nodes', 'edges'].includes(String(f.name)))) ||
            (next.role === 'edge' && !typeFields.some(f => object(f) && f.name === 'node'))) unresolvedRequiredType = true;
        if (next.role !== 'node') for (const field of typeFields) {
          if (!object(field)) continue;
          if (field.name === 'nodes' || field.name === 'node') enqueue(field.type, 'node');
          if (field.name === 'edges') enqueue(field.type, 'edge');
        }
        if (next.role === 'node') for (const p of possible.slice(0, 8)) enqueue(p, 'node');
      } catch (error) { childReason = error instanceof AuditFailure ? error.code : 'CHILD_PROBE_FAILED'; break; }
    }
    if (!childReason && queue.length) childReason = 'PROBE_REQUEST_LIMIT';
    if (!childReason && (rootFieldsTruncated || rootSchemaIncomplete || unresolvedRequiredType || childSchema.some(t => t.truncated))) childReason = 'SCHEMA_METADATA_INCOMPLETE';
    return { available: true, fields, rootFieldsTruncated, rootSchemaIncomplete, unresolvedRequiredType, childSchema, requests, childSchemaComplete: !rootFieldsTruncated && !childReason && childSchema.every(t => !t.truncated),
      childReason, businessFieldValuesFetched: false };
  } catch (error) {
    return { available: false, reason: error instanceof AuditFailure ? error.code : 'PROBE_FAILED', fields: [], childSchema, requests, businessFieldValuesFetched: false };
  }
}
