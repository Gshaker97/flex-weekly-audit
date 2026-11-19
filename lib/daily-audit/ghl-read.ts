// GET-only GoHighLevel reader for the daily audit.
//
// Deliberately separate from lib/ghl.ts: this module has no POST, PUT or
// DELETE path at all, so the audit cannot change anything in GHL. It uses the
// same GHL_API_KEY / GHL_LOCATION_ID env vars as the sync.

const GHL_API_URL = "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "2021-07-28";
const TIMEOUT_MS = 15_000;

export function ghlConfigured(): boolean {
  return !!process.env.GHL_API_KEY && !!process.env.GHL_LOCATION_ID;
}

function locationId(): string {
  const id = process.env.GHL_LOCATION_ID;
  if (!id) throw new Error("GHL_LOCATION_ID is not set");
  return id;
}

async function ghlGet<T = any>(path: string): Promise<T> {
  const key = process.env.GHL_API_KEY;
  if (!key) throw new Error("GHL_API_KEY is not set");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${GHL_API_URL}${path}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${key}`,
          Version: GHL_API_VERSION,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
    } catch (err: any) {
      if (err?.name === "AbortError") throw new Error(`GHL timeout (${path.split("?")[0]})`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) {
      throw new Error(`GHL ${res.status} (${path.split("?")[0]})`);
    }
    return (await res.json()) as T;
  }
  throw new Error(`GHL: too many retries (${path.split("?")[0]})`);
}

export interface AuditContact {
  id: string;
  email: string | null;
  phone: string | null;
  tags: string[];
  dnd: boolean;
  smsBlocked: boolean;
  emailBlocked: boolean;
}

/** Exact (case-insensitive) email match only. No fuzzy fallback. */
export async function findContactIdsByEmail(email: string): Promise<string[]> {
  const params = new URLSearchParams({ locationId: locationId(), query: email, limit: "20" });
  const data = await ghlGet<{ contacts?: Array<{ id: string; email?: string | null }> }>(
    `/contacts/?${params.toString()}`
  );
  const want = email.trim().toLowerCase();
  return (data.contacts ?? [])
    .filter((c) => (c.email ?? "").trim().toLowerCase() === want)
    .map((c) => c.id);
}

function channelBlocked(settings: any, channel: "SMS" | "Email"): boolean {
  const entry = settings && typeof settings === "object" ? settings[channel] : null;
  return !!entry && typeof entry === "object" && entry.status === "active";
}

export async function getContact(contactId: string): Promise<AuditContact> {
  const data = await ghlGet<{ contact?: any }>(`/contacts/${encodeURIComponent(contactId)}`);
  const c = data.contact ?? {};
  const dnd = c.dnd === true;
  return {
    id: contactId,
    email: typeof c.email === "string" ? c.email : null,
    phone: typeof c.phone === "string" ? c.phone : null,
    tags: Array.isArray(c.tags) ? c.tags.filter((t: unknown): t is string => typeof t === "string") : [],
    dnd,
    smsBlocked: dnd || channelBlocked(c.dndSettings, "SMS"),
    emailBlocked: dnd || channelBlocked(c.dndSettings, "Email"),
  };
}

export interface OutboundMessage {
  channel: "sms" | "email";
  dateAdded: Date;
}

const SMS_TYPES = new Set(["TYPE_SMS", "TYPE_CAMPAIGN_SMS"]);
const EMAIL_TYPES = new Set(["TYPE_EMAIL", "TYPE_CAMPAIGN_EMAIL"]);

/** Every outbound text and email to a contact. `complete` is false if a page cap was hit. */
export async function getOutboundMessages(
  contactId: string
): Promise<{ complete: boolean; messages: OutboundMessage[] }> {
  const loc = encodeURIComponent(locationId());
  const conv = await ghlGet<{ conversations?: Array<{ id: string }> }>(
    `/conversations/search?locationId=${loc}&contactId=${encodeURIComponent(contactId)}`
  );
  const messages: OutboundMessage[] = [];
  let complete = true;
  const PAGE_CAP = 10;
  for (const c of conv.conversations ?? []) {
    let lastMessageId: string | undefined;
    let page = 0;
    for (; page < PAGE_CAP; page += 1) {
      const qs = lastMessageId ? `?lastMessageId=${encodeURIComponent(lastMessageId)}` : "";
      const data = await ghlGet<{
        messages?: { messages?: any[]; nextPage?: boolean; lastMessageId?: string };
      }>(`/conversations/${encodeURIComponent(c.id)}/messages${qs}`);
      const block = data.messages;
      for (const m of block?.messages ?? []) {
        if (m?.direction !== "outbound") continue;
        const channel = SMS_TYPES.has(m.messageType) ? "sms" : EMAIL_TYPES.has(m.messageType) ? "email" : null;
        if (!channel || !m.dateAdded) continue;
        const when = new Date(m.dateAdded);
        if (Number.isNaN(when.getTime())) continue;
        messages.push({ channel, dateAdded: when });
      }
      if (!block?.nextPage || !block?.lastMessageId) break;
      lastMessageId = block.lastMessageId;
    }
    if (page >= PAGE_CAP) complete = false;
  }
  return { complete, messages };
}

export interface PipelineInfo {
  pipelineId: string;
  stageNameById: Map<string, string>;
  stageIdByName: Map<string, string>;
}

export async function getInvoicePipeline(): Promise<PipelineInfo> {
  const data = await ghlGet<{ pipelines?: Array<{ id: string; name: string; stages?: Array<{ id: string; name: string }> }> }>(
    `/opportunities/pipelines?locationId=${encodeURIComponent(locationId())}`
  );
  const p = (data.pipelines ?? []).find((x) => (x.name ?? "").trim().toLowerCase() === "invoice pipeline");
  if (!p) throw new Error('GHL pipeline "Invoice Pipeline" not found');
  const stageNameById = new Map<string, string>();
  const stageIdByName = new Map<string, string>();
  for (const s of p.stages ?? []) {
    stageNameById.set(s.id, s.name);
    stageIdByName.set((s.name ?? "").trim().toLowerCase(), s.id);
  }
  return { pipelineId: p.id, stageNameById, stageIdByName };
}

export interface AuditOpportunity {
  id: string;
  name: string | null;
  contactId: string | null;
  stageId: string | null;
  status: string | null;
  monetaryValue: number | null;
}

/** Every opportunity in the pipeline, all statuses. */
export async function listOpportunities(pipelineId: string): Promise<{ complete: boolean; opps: AuditOpportunity[] }> {
  const loc = encodeURIComponent(locationId());
  const pid = encodeURIComponent(pipelineId);
  const base = `/opportunities/search?location_id=${loc}&pipeline_id=${pid}&limit=100`;
  const opps: AuditOpportunity[] = [];
  let path: string | null = base;
  let page = 0;
  while (path) {
    const data: any = await ghlGet(path);
    for (const o of data.opportunities ?? []) {
      opps.push({
        id: o.id,
        name: o.name ?? null,
        contactId: o.contactId ?? o.contact?.id ?? null,
        stageId: o.pipelineStageId ?? null,
        status: o.status ?? null,
        monetaryValue: typeof o.monetaryValue === "number" ? o.monetaryValue : null,
      });
    }
    const m = data.meta ?? {};
    path =
      m.startAfterId && m.startAfter && (data.opportunities?.length ?? 0) > 0
        ? `${base}&startAfter=${encodeURIComponent(m.startAfter)}&startAfterId=${encodeURIComponent(m.startAfterId)}`
        : null;
    if (++page >= 60) return { complete: !path, opps };
  }
  return { complete: true, opps };
}
