// GoHighLevel (LeadConnector) API client.
//
// Mirrors the conventions in lib/jobber.ts: env-var-driven config, a single
// fetch wrapper that retries on 429, and small typed helpers per endpoint.
// Used by the invoice-overdue sync step to mirror overdue Jobber invoices into
// the GHL "Invoice Pipeline".

const GHL_API_URL = "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "2021-07-28";

// Pipeline + stage we sync overdue invoices into. Resolved by name at runtime
// (their ids differ per location) via GET /opportunities/pipelines.
const INVOICE_PIPELINE_NAME = "Invoice Pipeline";
const OVERDUE_STAGE_NAME = "Invoice Overdue";

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
  overdueStageId: string;
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
  const stage = (pipeline.stages ?? []).find((s) =>
    eq(s.name, OVERDUE_STAGE_NAME)
  );
  if (!stage) {
    throw new Error(
      `GHL stage "${OVERDUE_STAGE_NAME}" not found in pipeline "${INVOICE_PIPELINE_NAME}"`
    );
  }

  cachedRefs = { pipelineId: pipeline.id, overdueStageId: stage.id };
  return cachedRefs;
}

export interface GhlContact {
  id: string;
  email?: string | null;
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

export interface GhlOpportunity {
  id: string;
  name?: string | null;
  pipelineId?: string | null;
  pipelineStageId?: string | null;
  contactId?: string | null;
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

export async function moveOpportunityToStage(
  opportunityId: string,
  pipelineStageId: string
): Promise<void> {
  await ghlFetch(`/opportunities/${opportunityId}`, {
    method: "PUT",
    body: JSON.stringify({ pipelineStageId }),
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
  try {
    const data = await ghlFetch<{ opportunity: GhlOpportunity }>(
      `/opportunities/`,
      { method: "POST", body: JSON.stringify(body) }
    );
    return data.opportunity;
  } catch (err: any) {
    // GHL rejects an already-existing opportunity with 400 "Can not create
    // duplicate opportunity" and returns its id in meta.existingId. Rather than
    // failing, move that existing opportunity into the target stage — this is
    // what makes overdue invoices update existing cards instead of only the
    // brand-new ones.
    const existingId: string | undefined =
      err?.status === 400 ? err?.body?.meta?.existingId : undefined;
    if (existingId) {
      await moveOpportunityToStage(existingId, opts.pipelineStageId);
      return {
        id: existingId,
        name: opts.name,
        pipelineId: opts.pipelineId,
        pipelineStageId: opts.pipelineStageId,
        contactId: opts.contactId,
      };
    }
    throw err;
  }
}
