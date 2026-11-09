// GoHighLevel (LeadConnector) API client.
//
// Mirrors the conventions in lib/jobber.ts: env-var-driven config, a single
// fetch wrapper that retries on 429, and small typed helpers per endpoint.
// Used by the invoice-overdue sync step to mirror overdue Jobber invoices into
// the GHL "Invoice Pipeline".

const GHL_API_URL = "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "2021-07-28";

// Pipeline we sync invoices into. Resolved by name at runtime (ids differ per
// location) via GET /opportunities/pipelines; all of its stages are mapped so
// the caller can route each invoice to the right stage by name.
const INVOICE_PIPELINE_NAME = "Invoice Pipeline";

function ghlApiKey(): string {
  const key = process.env.GHL_API_KEY;
  if (!key) throw new Error("GHL_API_KEY is not set");
  return key;
}

function ghlLocationId(): string {
  const id = process.env.GHL_LOCATION_ID;
  if (!id) throw new Error("GHL_LOCATION_ID is not set");
  return id;
}

function ghlHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${ghlApiKey()}`,
    Version: GHL_API_VERSION,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

// Hard per-request timeout. Without it a stalled GHL connection hangs the whole
// sync indefinitely (the symptom: sync freezing right after the timesheets step).
const GHL_FETCH_TIMEOUT_MS = 10_000;

// Single fetch wrapper with the same retry-on-429 backoff as jobberGraphQL.
async function ghlFetch<T = any>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const url = path.startsWith("http") ? path : `${GHL_API_URL}${path}`;
  let attempt = 0;
  const maxAttempts = 4;
  while (attempt < maxAttempts) {
    // Abort each attempt after GHL_FETCH_TIMEOUT_MS so a hung socket surfaces as
    // a fast, catchable error instead of stalling the sync forever.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GHL_FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: { ...ghlHeaders(), ...(init.headers ?? {}) },
        signal: controller.signal,
      });
    } catch (err: any) {
      if (err?.name === "AbortError") {
        throw new Error(
          `GHL API timeout after ${GHL_FETCH_TIMEOUT_MS}ms (${path})`
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429) {
      // Do not automatically replay a mutation without an idempotency key.
      if (init.method && init.method !== "GET" && path !== "/contacts/search") {
        throw new Error(`GHL mutation rate limited; review outcome before retry (${path})`);
      }
      const waitMs = 5000 * (attempt + 1);
      await new Promise((r) => setTimeout(r, waitMs));
      attempt += 1;
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      let body: any = undefined;
      try {
        body = JSON.parse(text);
      } catch {
        /* non-JSON error body */
      }
      // Attach status + parsed body so callers can handle specific errors
      // (e.g. createOpportunity recovering meta.existingId on a duplicate).
      const err: any = new Error(`GHL API ${res.status} (${path}): ${text}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
  throw new Error(`GHL API: max retries exceeded (${path})`);
}

export interface InvoicePipelineRefs {
  pipelineId: string;
  // lowercased stage name -> stage id, for every stage in the Invoice Pipeline.
  stageIdByName: Record<string, string>;
}

interface GhlPipeline {
  id: string;
  name: string;
  stages: Array<{ id: string; name: string }>;
}

// Pipeline/stage ids are stable for a location, so resolve them once per sync.
let cachedRefs: InvoicePipelineRefs | null = null;

export async function getInvoicePipelineRefs(): Promise<InvoicePipelineRefs> {
  if (cachedRefs) return cachedRefs;

  const params = new URLSearchParams({ locationId: ghlLocationId() });
  const data = await ghlFetch<{ pipelines: GhlPipeline[] }>(
    `/opportunities/pipelines?${params.toString()}`
  );

  const eq = (a: string | null | undefined, b: string) =>
    (a ?? "").trim().toLowerCase() === b.toLowerCase();

  const pipeline = (data.pipelines ?? []).find((p) =>
    eq(p.name, INVOICE_PIPELINE_NAME)
  );
  if (!pipeline) {
    throw new Error(`GHL pipeline "${INVOICE_PIPELINE_NAME}" not found`);
  }

  const stageIdByName: Record<string, string> = {};
  for (const s of pipeline.stages ?? []) {
    stageIdByName[(s.name ?? "").trim().toLowerCase()] = s.id;
  }

  cachedRefs = { pipelineId: pipeline.id, stageIdByName };
  return cachedRefs;
}

export interface GhlContact {
  id: string;
  additionalEmails?: Array<{ email: string }> | null;
  additionalPhones?: Array<{ phone: string }> | null;
  email?: string | null;
  phone?: string | null;
}

// Read-only POST search contract, pinned to our 2021-07-28 API version:
// https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/contacts/search-contacts-advanced/index.html
// `total` is the matching population, not a page count. Preserve the last
// contact's searchAfter unchanged; numbered pages truncate beyond 10,000 rows.
export async function listContactsForPhoneMatching(): Promise<GhlContact[]> {
  const locationId = ghlLocationId();
  const pageLimit = 100;
  const seenCursors = new Set<string>();
  const contacts = new Map<string, GhlContact>();
  let searchAfter: Array<string | number> | undefined;
  let expectedTotal: number | undefined;
  for (let page = 0; page < 1000; page++) {
    const data: any = await ghlFetch("/contacts/search", {
      method: "POST",
      body: JSON.stringify({ locationId, pageLimit, fastPagination: false,
        sort: [{ field: "dateAdded", direction: "asc" }],
        ...(searchAfter ? { searchAfter } : { page: 1 }) }),
    });
    const total = data.total;
    if (!Array.isArray(data.contacts) || data.contacts.length > pageLimit ||
        !Number.isSafeInteger(total) || total < 0 ||
        (expectedTotal !== undefined && total !== expectedTotal)) {
      throw new Error("Unverified GHL contact snapshot pagination");
    }
    expectedTotal = total;
    for (const contact of data.contacts) {
      if (typeof contact?.id !== "string" || !contact.id || contacts.has(contact.id) ||
          (contact.locationId != null && contact.locationId !== locationId)) {
        throw new Error("Duplicate or invalid GHL snapshot contact");
      }
      contacts.set(contact.id, contact);
    }
    if (contacts.size > total) throw new Error("Inconsistent GHL contact total");
    if (contacts.size === total) return [...contacts.values()];
    const cursor = data.contacts[data.contacts.length - 1]?.searchAfter;
    if (!Array.isArray(cursor) || !cursor.length || cursor.some(value =>
      !(typeof value === "string" && value.length > 0) &&
      !(typeof value === "number" && Number.isFinite(value)))) {
      throw new Error("Missing GHL contact continuation cursor");
    }
    const key = JSON.stringify(cursor);
    if (seenCursors.has(key)) throw new Error("Repeated GHL contact continuation cursor");
    seenCursors.add(key);
    searchAfter = cursor;
  }
  throw new Error("GHL contact snapshot exceeded page limit");
}

// Look up a contact by email. The `query` param is a fuzzy match, so we prefer
// an exact email match and only fall back to the first hit.
export async function findContactByEmail(
  email: string
): Promise<GhlContact | null> {
  const params = new URLSearchParams({
    locationId: ghlLocationId(),
    query: email,
    limit: "10",
  });
  const data = await ghlFetch<{ contacts: GhlContact[] }>(
    `/contacts/?${params.toString()}`
  );
  const contacts = data.contacts ?? [];
  const exact = contacts.find(
    (c) => (c.email ?? "").toLowerCase() === email.toLowerCase()
  );
  return exact ?? contacts[0] ?? null;
}

// Create a contact (used when no GHL contact matches the invoice's email, so an
// opportunity can still be attached). On a duplicate (400), GHL returns the
// existing contact id in meta.contactId — use that instead of failing.
export async function createContact(opts: {
  email: string;
  name?: string | null;
  phone?: string | null;
}): Promise<GhlContact> {
  const body: Record<string, any> = {
    locationId: ghlLocationId(),
    email: opts.email,
  };
  if (opts.name) body.name = opts.name;
  if (opts.phone) body.phone = opts.phone;
  try {
    const data = await ghlFetch<{ contact: GhlContact }>(`/contacts/`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return data.contact;
  } catch (err: any) {
    const existingId: string | undefined =
      err?.status === 400
        ? err?.body?.meta?.contactId ?? err?.body?.meta?.existingId
        : undefined;
    if (existingId) return { id: existingId, email: opts.email };
    throw err;
  }
}

export interface GhlOpportunity {
  id: string;
  name?: string | null;
  pipelineId?: string | null;
  pipelineStageId?: string | null;
  contactId?: string | null;
  status?: string | null;
  monetaryValue?: number | null;
  locationId?: string | null;
  customFields?: Array<{ id: string; fieldValue: unknown }>;
}

// Version-pinned contract: 2021-07-28 writes field_value; GET returns fieldValue.
// Do not silently switch the whole integration to the new v3 API.
export async function readOpportunityCustomFields(): Promise<unknown> {
  return ghlFetch(`/locations/${encodeURIComponent(ghlLocationId())}/customFields?model=opportunity`);
}

// Read-only metadata contract, including status/version/updatedAt/locationId.
// No publish/edit endpoint is exposed by this helper.
export async function readWorkflowStates(): Promise<unknown> {
  // The live provider returns 404 without this trailing slash.
  return ghlFetch(`/workflows/?${new URLSearchParams({ locationId: ghlLocationId() })}`);
}

/** Low-level transport only. Call through the admitted blank-date repair writer,
 * never from an unauthenticated route, preview, or generic stage update. */
export async function setOpportunityDueDate(opportunityId: string, fieldId: string, date: string): Promise<void> {
  if (![opportunityId, fieldId].every(v => /^[A-Za-z0-9_-]{1,128}$/.test(v))
      || !/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new Error("Invalid exact opportunity date update");
  }
  await ghlFetch(`/opportunities/${encodeURIComponent(opportunityId)}`, {
    method: "PUT", body: JSON.stringify({ customFields: [{ id: fieldId, field_value: date }] }),
  });
}

// All opportunities for a contact within a pipeline. The search endpoint uses
// snake_case query params.
export async function searchOpportunities(
  contactId: string,
  pipelineId: string
): Promise<GhlOpportunity[]> {
  const params = new URLSearchParams({
    location_id: ghlLocationId(),
    pipeline_id: pipelineId,
    contact_id: contactId,
  });
  const data = await ghlFetch<{ opportunities: GhlOpportunity[] }>(
    `/opportunities/search?${params.toString()}`
  );
  return data.opportunities ?? [];
}

// Every opportunity in a pipeline (paginated) — used to sweep the Overdue stage
// for stale/duplicate cards.
export async function listPipelineOpportunities(
  pipelineId: string
): Promise<GhlOpportunity[]> {
  const params = new URLSearchParams({ location_id: ghlLocationId(), pipeline_id: pipelineId,
    status: "all", limit: "100" });
  const out = new Map<string, GhlOpportunity>();
  const cursors = new Set<string>();
  let expectedTotal: number | undefined;
  for (let page = 0; page < 1000; page++) {
    const data: any = await ghlFetch(`/opportunities/search?${params}`);
    const total = data.meta?.total;
    if (!Array.isArray(data.opportunities) || !Number.isSafeInteger(total) || total < 0 ||
        (expectedTotal !== undefined && total !== expectedTotal)) throw new Error("Incomplete GHL pipeline snapshot");
    expectedTotal = total;
    for (const card of data.opportunities) {
      if (typeof card?.id !== "string" || !card.id || out.has(card.id) || card.pipelineId !== pipelineId) {
        throw new Error("Duplicate or misrouted GHL pipeline card");
      }
      out.set(card.id, card);
    }
    if (out.size > total) throw new Error("Inconsistent GHL pipeline total");
    if (out.size === total) return [...out.values()];
    const { startAfter, startAfterId } = data.meta;
    if ((!Number.isFinite(startAfter) && !(typeof startAfter === "string" && startAfter.length)) ||
        typeof startAfterId !== "string" || !startAfterId || !data.opportunities.length) {
      throw new Error("Missing GHL pipeline cursor");
    }
    const key = JSON.stringify([startAfter, startAfterId]);
    if (cursors.has(key)) throw new Error("Repeated GHL pipeline cursor");
    cursors.add(key);
    params.set("startAfter", String(startAfter));
    params.set("startAfterId", startAfterId);
  }
  throw new Error("GHL pipeline snapshot exceeded page limit");
}

// Phone path never selects a first card or invokes duplicate-create recovery.
// Pinned GET search docs define meta.total and the snake_case filters. Search
// every status so a hidden closed duplicate cannot establish false uniqueness.
// https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/opportunities/search-opportunity/index.html
export async function findSinglePhoneOpportunity(contactId: string, pipelineId: string): Promise<GhlOpportunity | null> {
  const params = new URLSearchParams({ location_id: ghlLocationId(), pipeline_id: pipelineId,
    contact_id: contactId, status: "all", limit: "100" });
  const data: any = await ghlFetch(`/opportunities/search?${params}`);
  if (!Array.isArray(data.opportunities) || data.meta?.total !== data.opportunities.length ||
      data.opportunities.length !== 1) return null;
  const opportunity = data.opportunities[0];
  if (opportunity.contactId !== contactId || opportunity.pipelineId !== pipelineId ||
      opportunity.status !== "open" || !opportunity.id) return null;
  return opportunity;
}

// Re-read immediately before a stage mutation. This is not an atomic lock;
// callers must still avoid overlapping runs and review unknown PUT outcomes.
export async function readOpportunity(opportunityId: string): Promise<GhlOpportunity> {
  const data = await ghlFetch<{ opportunity: GhlOpportunity }>(`/opportunities/${encodeURIComponent(opportunityId)}`);
  if (!data.opportunity || data.opportunity.id !== opportunityId) throw new Error("Unverified GHL opportunity readback");
  return data.opportunity;
}

export async function moveOpportunityToStage(
  opportunityId: string,
  pipelineStageId: string,
  monetaryValue?: number,
  name?: string
): Promise<void> {
  // Preserve status. A stale snapshot must never automatically reopen a card.
  const body: Record<string, any> = { pipelineStageId };
  if (monetaryValue != null) body.monetaryValue = monetaryValue;
  if (name != null) body.name = name;
  await ghlFetch(`/opportunities/${opportunityId}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export async function createOpportunity(opts: {
  pipelineId: string;
  pipelineStageId: string;
  contactId: string;
  name: string;
  monetaryValue?: number;
}): Promise<GhlOpportunity> {
  const body = {
    pipelineId: opts.pipelineId,
    locationId: ghlLocationId(),
    pipelineStageId: opts.pipelineStageId,
    contactId: opts.contactId,
    name: opts.name,
    status: "open",
    monetaryValue: opts.monetaryValue ?? 0,
  };
  const data = await ghlFetch<{ opportunity: GhlOpportunity }>(
    `/opportunities/`, { method: "POST", body: JSON.stringify(body) }
  );
  return data.opportunity;
}

// Permanently delete an opportunity (the card only — the contact is untouched).
// Used by the one-time invalid-opportunity cleanup.
export async function deleteOpportunity(opportunityId: string): Promise<void> {
  await ghlFetch(`/opportunities/${opportunityId}`, { method: "DELETE" });
}

// --- Conversations / messages (collection reminder tracking) ----------------

export interface GhlOutboundSms {
  dateAdded: Date;
  body: string;
}

interface GhlConversation {
  id: string;
}

interface GhlMessage {
  direction?: string;
  messageType?: string;
  dateAdded?: string;
  body?: string;
}

// Every outbound SMS sent to a contact across all of their conversations,
// newest first. Used to check whether a dunning reminder text went out near an
// expected date. (direction "outbound" + messageType "TYPE_SMS", verified live.)
export async function getOutboundSms(contactId: string): Promise<GhlOutboundSms[]> {
  const loc = encodeURIComponent(ghlLocationId());
  const conv = await ghlFetch<{ conversations: GhlConversation[] }>(
    `/conversations/search?locationId=${loc}&contactId=${encodeURIComponent(contactId)}`
  );

  const out: GhlOutboundSms[] = [];
  for (const c of conv.conversations ?? []) {
    let lastMessageId: string | undefined;
    let page = 0;
    while (page < 10) {
      const qs = lastMessageId
        ? `?lastMessageId=${encodeURIComponent(lastMessageId)}`
        : "";
      const data = await ghlFetch<{
        messages: { messages: GhlMessage[]; nextPage?: boolean; lastMessageId?: string };
      }>(`/conversations/${encodeURIComponent(c.id)}/messages${qs}`);
      const block = data.messages;
      for (const m of block?.messages ?? []) {
        if (m.direction === "outbound" && m.messageType === "TYPE_SMS" && m.dateAdded) {
          const d = new Date(m.dateAdded);
          if (!isNaN(d.getTime())) out.push({ dateAdded: d, body: m.body ?? "" });
        }
      }
      if (!block?.nextPage || !block?.lastMessageId) break;
      lastMessageId = block.lastMessageId;
      page += 1;
    }
  }
  out.sort((a, b) => b.dateAdded.getTime() - a.dateAdded.getTime());
  return out;
}
