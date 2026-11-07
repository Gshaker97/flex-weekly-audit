/** Standalone audit transport. Never import application GHL, sync or auth clients. */
export const GHL_ORIGIN = 'https://services.leadconnectorhq.com';
export const GHL_VERSION = '2021-07-28';
export const GHL_LIMITS = Object.freeze({ runMs: 300_000, requestMs: 10_000, maxRequests: 220,
  pageSize: 100, maxPages: 100, maxRecords: 10_000, responseBytes: 3_000_000,
  totalBytes: 32_000_000, outputBytes: 5_000_000 });
export class GhlPreviewFailure extends Error {
  constructor(public readonly code: string, public readonly facts: Record<string, number | boolean> = {}) {
    super(code); this.name = 'GhlPreviewFailure';
  }
}
export function object(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v); }
export function id(v: unknown): v is string { return typeof v === 'string' && /^[A-Za-z0-9_+/:=.\-]{1,512}$/.test(v); }
export type ReaderOptions = { apiKey: string; locationId: string; deadlineAt?: number; fetch?: typeof fetch };
/** Exact paths only. Even same-origin nextPageUrl is never followed. */
export function assertReadOnlyRequest(url: URL, method: string, body?: Record<string, unknown>): void {
  if (url.origin !== GHL_ORIGIN || url.username || url.password || url.hash) throw new GhlPreviewFailure('REQUEST_ORIGIN_REJECTED');
  const path = url.pathname;
  const allowed = (method === 'POST' && path === '/contacts/search') ||
    (method === 'GET' && (path === '/opportunities/pipelines' || path === '/opportunities/search'));
  if (!allowed) throw new GhlPreviewFailure('REQUEST_METHOD_OR_ROUTE_REJECTED');
  const allowedQuery = path === '/opportunities/pipelines' ? ['locationId'] :
    path === '/opportunities/search' ? ['location_id', 'pipeline_id', 'status', 'limit', 'startAfter', 'startAfterId'] : [];
  for (const key of url.searchParams.keys()) if (!allowedQuery.includes(key) || url.searchParams.getAll(key).length !== 1) throw new GhlPreviewFailure('REQUEST_QUERY_REJECTED');
  if (method === 'GET' && body !== undefined) throw new GhlPreviewFailure('GET_BODY_REJECTED');
  if (path === '/opportunities/search' && (url.searchParams.get('status') !== 'all' || url.searchParams.get('limit') !== '100')) throw new GhlPreviewFailure('ALL_STATUS_SEARCH_REQUIRED');
  if (method === 'POST') {
    if (!body || Object.keys(body).some(k => !['locationId', 'pageLimit', 'fastPagination', 'sort', 'searchAfter', 'page'].includes(k)) ||
      body.pageLimit !== GHL_LIMITS.pageSize || body.fastPagination !== false ||
      JSON.stringify(body.sort) !== JSON.stringify([{ field: 'dateAdded', direction: 'asc' }]) ||
      (!Array.isArray(body.searchAfter) && body.page !== 1) || (body.searchAfter !== undefined && body.page !== undefined)) {
      throw new GhlPreviewFailure('CONTACT_SEARCH_BODY_REJECTED');
    }
  }
}
export class GhlReadonlyReader {
  readonly startedAt = Date.now(); readonly deadlineAt: number;
  requests = 0; bytes = 0;
  private readonly doFetch: typeof fetch;
  constructor(private readonly options: ReaderOptions) {
    if (!options.apiKey || !id(options.locationId)) throw new GhlPreviewFailure('EXISTING_GHL_CONFIGURATION_REQUIRED');
    this.deadlineAt = Math.min(this.startedAt + GHL_LIMITS.runMs, options.deadlineAt ?? Infinity);
    if (!Number.isFinite(this.deadlineAt)) throw new GhlPreviewFailure('INVALID_DEADLINE');
    this.doFetch = options.fetch ?? fetch;
  }
  get locationId() { return this.options.locationId; }
  check() { if (Date.now() >= this.deadlineAt) throw new GhlPreviewFailure('GHL_RUNTIME_LIMIT'); }
  async request(path: string, method: 'GET' | 'POST' = 'GET', body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.check();
    if (++this.requests > GHL_LIMITS.maxRequests) throw new GhlPreviewFailure('GHL_REQUEST_LIMIT');
    const url = new URL(path, GHL_ORIGIN);
    assertReadOnlyRequest(url, method, body);
    const actualLocation = method === 'POST' ? body?.locationId : url.searchParams.get(url.pathname === '/opportunities/pipelines' ? 'locationId' : 'location_id');
    if (actualLocation !== this.options.locationId) throw new GhlPreviewFailure('REQUEST_LOCATION_REJECTED');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(GHL_LIMITS.requestMs, this.deadlineAt - Date.now())));
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.doFetch(url, { method, redirect: 'manual', signal: controller.signal,
        headers: { Authorization: `Bearer ${this.options.apiKey}`, Version: GHL_VERSION, Accept: 'application/json', 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      if (response.status >= 300 && response.status < 400) throw new GhlPreviewFailure('GHL_REDIRECT_REJECTED', { status: response.status });
      if (!response.ok) throw new GhlPreviewFailure('GHL_HTTP_FAILURE', { status: response.status });
      if (!response.headers.get('content-type')?.toLowerCase().includes('application/json') || !response.body) throw new GhlPreviewFailure('GHL_RESPONSE_TYPE_REJECTED');
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > GHL_LIMITS.responseBytes) throw new GhlPreviewFailure('GHL_RESPONSE_BYTE_LIMIT');
      reader = response.body.getReader();
      const decoder = new TextDecoder(); let text = '', size = 0;
      while (true) {
        this.check(); const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength; this.bytes += chunk.value.byteLength;
        if (size > GHL_LIMITS.responseBytes || this.bytes > GHL_LIMITS.totalBytes) throw new GhlPreviewFailure('GHL_RESPONSE_BYTE_LIMIT');
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode(); this.check();
      let data: unknown;
      try { data = JSON.parse(text); } catch { throw new GhlPreviewFailure('GHL_INVALID_JSON'); }
      if (!object(data)) throw new GhlPreviewFailure('GHL_INVALID_RESPONSE_SHAPE');
      return data;
    } catch (error) {
      if (error instanceof GhlPreviewFailure) throw error;
      // Do not forward raw errors, bodies, URLs, headers or tokens. Never retry, including 403/429.
      throw new GhlPreviewFailure(controller.signal.aborted ? 'GHL_REQUEST_TIMEOUT' : 'GHL_REQUEST_FAILED');
    } finally {
      controller.abort(); clearTimeout(timer);
      if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
  }
}
