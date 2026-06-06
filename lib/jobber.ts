import { prisma } from "./prisma";

const JOBBER_API_URL = "https://api.getjobber.com/api/graphql";
const JOBBER_TOKEN_URL = "https://api.getjobber.com/api/oauth/token";
const JOBBER_AUTHORIZE_URL = "https://api.getjobber.com/api/oauth/authorize";
const JOBBER_API_VERSION = "2025-04-16";

function decodeJwtExpiry(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64").toString("utf-8")
    );
    if (typeof payload.exp === "number") return payload.exp;
    return null;
  } catch {
    return null;
  }
}

function computeExpiresAt(tokens: any): Date {
  if (typeof tokens.expires_in === "number" && tokens.expires_in > 0) {
    return new Date(Date.now() + tokens.expires_in * 1000);
  }
  const jwtExp = decodeJwtExpiry(tokens.access_token);
  if (jwtExp) return new Date(jwtExp * 1000);
  return new Date(Date.now() + 55 * 60 * 1000);
}

export function getAuthorizeUrl(state: string) {
  const params = new URLSearchParams({
    client_id: process.env.JOBBER_CLIENT_ID!,
    redirect_uri: process.env.JOBBER_REDIRECT_URI!,
    response_type: "code",
    state,
  });
  return `${JOBBER_AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeCodeForToken(code: string) {
  const body = new URLSearchParams({
    client_id: process.env.JOBBER_CLIENT_ID!,
    client_secret: process.env.JOBBER_CLIENT_SECRET!,
    grant_type: "authorization_code",
    code,
    redirect_uri: process.env.JOBBER_REDIRECT_URI!,
  });
  const res = await fetch(JOBBER_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${text}`);
  }
  return res.json() as Promise<{
    access_token: string;
    refresh_token: string;
    expires_in?: number;
    token_type?: string;
  }>;
}

export async function refreshAccessToken(refreshToken: string) {
  const body = new URLSearchParams({
    client_id: process.env.JOBBER_CLIENT_ID!,
    client_secret: process.env.JOBBER_CLIENT_SECRET!,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const res = await fetch(JOBBER_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Refresh failed: ${res.status} ${text}`);
  }
  return res.json() as Promise<{
    access_token: string;
    refresh_token: string;
    expires_in?: number;
  }>;
}

export async function getValidAccessToken(): Promise<string> {
  const auth = await prisma.jobberAuth.findFirst({
    orderBy: { createdAt: "desc" },
  });
  if (!auth) {
    throw new Error("No Jobber authentication found. Connect Jobber first.");
  }
  const expiresInMs = auth.expiresAt.getTime() - Date.now();
  if (expiresInMs > 5 * 60 * 1000) return auth.accessToken;
  const refreshed = await refreshAccessToken(auth.refreshToken);
  const updated = await prisma.jobberAuth.update({
    where: { id: auth.id },
    data: {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token,
      expiresAt: computeExpiresAt(refreshed),
    },
  });
  return updated.accessToken;
}

export async function jobberGraphQL<T = any>(
  query: string,
  variables: Record<string, any> = {}
): Promise<T> {
  const accessToken = await getValidAccessToken();
  let attempt = 0;
  const maxAttempts = 4;
  while (attempt < maxAttempts) {
    const res = await fetch(JOBBER_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-JOBBER-GRAPHQL-VERSION": JOBBER_API_VERSION,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429) {
      const waitMs = 5000 * (attempt + 1);
      await new Promise((r) => setTimeout(r, waitMs));
      attempt += 1;
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Jobber API ${res.status}: ${text}`);
    }
    const data = await res.json();
    if (data.errors && data.errors.length > 0) {
      const isThrottled = data.errors.some(
        (e: any) => e.extensions?.code === "THROTTLED" || /throttl/i.test(e.message)
      );
      if (isThrottled && attempt < maxAttempts - 1) {
        const waitMs = 8000 * (attempt + 1);
        await new Promise((r) => setTimeout(r, waitMs));
        attempt += 1;
        continue;
      }
      throw new Error(
        `Jobber GraphQL error: ${data.errors.map((e: any) => e.message).join(", ")}`
      );
    }
    return data.data as T;
  }
  throw new Error("Jobber API: max retries exceeded");
}

const JOBS_QUERY = `
  query GetJobs($after: String) {
    jobs(first: 25, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        jobNumber
        title
        jobStatus
        jobType
        billingType
        total
        completedAt
        startAt
        endAt
        createdAt
        visits(first: 3) {
          totalCount
        }
        client {
          id
          name
          companyName
        }
        invoices(first: 5) {
          nodes { id invoiceNumber }
        }
        notes(first: 20) {
          nodes {
            ... on JobNote {
              id
              message
            }
          }
        }
      }
    }
  }
`;

const JOBS_BY_RANGE_QUERY = `
  query GetJobsByRange($after: String, $startDate: ISO8601DateTime!, $endDate: ISO8601DateTime!) {
    jobs(
      first: 25
      after: $after
      filter: { completedAt: { after: $startDate, before: $endDate } }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        jobNumber
        title
        jobStatus
        jobType
        billingType
        total
        completedAt
        startAt
        endAt
        createdAt
        visits(first: 3) {
          totalCount
        }
        client {
          id
          name
          companyName
        }
        invoices(first: 5) {
          nodes { id invoiceNumber }
        }
        notes(first: 20) {
          nodes {
            ... on JobNote {
              id
              message
            }
          }
        }
      }
    }
  }
`;

const JOBS_BY_END_QUERY = `
  query GetJobsByEnd($after: String, $startDate: ISO8601DateTime!, $endDate: ISO8601DateTime!) {
    jobs(
      first: 25
      after: $after
      filter: { endAt: { after: $startDate, before: $endDate } }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        jobNumber
        title
        jobStatus
        jobType
        billingType
        total
        completedAt
        startAt
        endAt
        createdAt
        visits(first: 3) {
          totalCount
        }
        client {
          id
          name
          companyName
        }
        invoices(first: 5) {
          nodes { id invoiceNumber }
        }
        notes(first: 20) {
          nodes {
            ... on JobNote {
              id
              message
            }
          }
        }
      }
    }
  }
`;

const CLIENTS_QUERY = `
  query GetClients($after: String) {
    clients(first: 25, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        companyName
        createdAt
        emails { address primary }
        phones { number primary }
      }
    }
  }
`;

// Top-level (flat) timesheet query. Pulling entries nested under every job
// blew past Jobber's query-cost limit ("Throttled"); a flat connection is cheap.
const TIMESHEETS_QUERY = `
  query GetTimeEntries($after: String) {
    timeSheetEntries(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        finalDuration
        approved
        ticking
        note
        startAt
        endAt
        user { id name { full } }
        job { id jobNumber title }
        client { id name companyName }
      }
    }
  }
`;

// Top-level (flat) visits query — same throttle fix as timesheets.
const VISITS_QUERY = `
  query GetVisits($after: String) {
    visits(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        isComplete
        completedAt
        startAt
        endAt
        title
        visitStatus
        invoice { id }
        job { id jobNumber total visits(first: 1) { totalCount } }
        client { id name companyName }
      }
    }
  }
`;

const INVOICES_QUERY = `
  query GetInvoices($after: String) {
    invoices(first: 25, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        invoiceNumber
        invoiceStatus
        subtotal
        amounts { total invoiceBalance discountAmount subtotal }
        issuedDate
        dueDate
        createdAt
        client {
          id
          name
          companyName
        }
      }
    }
  }
`;

export interface JobberJobNode {
  id: string;
  jobNumber: string | number | null;
  title: string | null;
  jobStatus: string | null;
  jobType: string | null;
  billingType: string | null;
  total: number | null;
  completedAt: string | null;
  startAt: string | null;
  endAt: string | null;
  createdAt: string | null;
  visits?: { totalCount: number | null } | null;
  client: { id: string; name?: string | null; companyName?: string | null } | null;
  invoices: { nodes: Array<{ id: string; invoiceNumber: string | null }> };
  // `notes` is a JobNoteUnionConnection; only the JobNote member carries a
  // `message`, so other union members come back as empty objects.
  notes?: { nodes: Array<{ id?: string; message?: string | null } | null> } | null;
}

/**
 * Concatenate all note text attached to a job into a single string.
 * Returns "" when the job has no notes.
 */
export function concatJobNotes(job: JobberJobNode): string {
  const nodes = job.notes?.nodes ?? [];
  return nodes
    .map((n) => n?.message ?? "")
    .filter((m) => m.trim().length > 0)
    .join("\n")
    .trim();
}

export interface JobberClientNode {
  id: string;
  name: string | null;
  companyName: string | null;
  createdAt: string | null;
  emails?: Array<{ address: string; primary: boolean }>;
  phones?: Array<{ number: string; primary: boolean }>;
}

export interface JobberInvoiceNode {
  id: string;
  invoiceNumber: string | null;
  invoiceStatus: string | null;
  subtotal: number | null;
  amounts: {
    total: number | null;
    invoiceBalance: number | null;
    discountAmount: number | null;
    subtotal: number | null;
  } | null;
  issuedDate: string | null;
  dueDate: string | null;
  createdAt: string | null;
  client: { id: string; name?: string | null; companyName?: string | null } | null;
}

async function paginate<T>(
  query: string,
  rootKey: string,
  baseVars: Record<string, any> = {},
  delayMs = 600
): Promise<T[]> {
  const out: T[] = [];
  let after: string | null = null;
  let hasNext = true;
  let page = 0;
  while (hasNext) {
    const data: any = await jobberGraphQL(query, { ...baseVars, after });
    const block = data?.[rootKey];
    const nodes: T[] = block?.nodes ?? [];
    out.push(...nodes);
    hasNext = block?.pageInfo?.hasNextPage ?? false;
    after = block?.pageInfo?.endCursor ?? null;
    page += 1;
    if (page > 500) {
      console.warn(`paginate: stopping at 500 pages for ${rootKey}`);
      break;
    }
    if (hasNext) await new Promise((r) => setTimeout(r, delayMs));
  }
  return out;
}

// Inject an updatedAt filter into the top-level connection of a query so we
// only pull records modified since the last sync. We INLINE the date (no typed
// $filter variable) so a wrong filter shape fails as a plain validation error
// rather than requiring us to know the exact *FilterAttributes type name.
function injectSince(query: string, since: Date | null): string {
  if (!since) return query;
  const clause = `, filter: { updatedAt: { after: "${since.toISOString()}" } }`;
  return query.replace("after: $after)", `after: $after${clause})`);
}

// Try an incremental (filtered) pull; on ANY error fall back to the full pull
// for that entity, so a bad/unsupported filter can never break the sync.
async function fetchIncremental<T>(
  query: string,
  rootKey: string,
  since: Date | null,
  label: string,
  supportsSinceFilter = true
): Promise<T[]> {
  // Some Jobber connections (jobs, visits) don't accept an updatedAt filter, so
  // attempting one just wastes a request and always falls back to a full pull.
  // Skip straight to the full pull for those.
  if (!since || !supportsSinceFilter) {
    const all = await paginate<T>(query, rootKey);
    console.log(`[sync] ${label}: full pull (${all.length})`);
    return all;
  }
  try {
    const r = await paginate<T>(injectSince(query, since), rootKey);
    console.log(`[sync] ${label}: incremental ok (${r.length} changed since ${since.toISOString()})`);
    return r;
  } catch (e: any) {
    console.warn(`[sync] ${label}: incremental filter rejected (${e?.message ?? e}) — falling back to full pull`);
    const all = await paginate<T>(query, rootKey);
    console.log(`[sync] ${label}: full pull fallback (${all.length})`);
    return all;
  }
}

export async function fetchAllJobs(since: Date | null = null): Promise<JobberJobNode[]> {
  // Jobber's JobFilterAttributes has no updatedAt — always full pull.
  return fetchIncremental<JobberJobNode>(JOBS_QUERY, "jobs", since, "jobs", false);
}

export async function fetchAllClients(since: Date | null = null): Promise<JobberClientNode[]> {
  return fetchIncremental<JobberClientNode>(CLIENTS_QUERY, "clients", since, "clients");
}


export interface FlatVisit {
  jobberVisitId: string;
  jobberJobId: string | null;
  jobNumber: string | null;
  title: string | null;
  clientName: string | null;
  isComplete: boolean;
  visitStatus: string | null;
  startAt: string | null;
  endAt: string | null;
  completedAt: string | null;
  hasInvoice: boolean;
  estimatedValue: number;
}

interface FlatVisitNode {
  id: string;
  isComplete: boolean | null;
  completedAt: string | null;
  startAt: string | null;
  endAt: string | null;
  title: string | null;
  visitStatus: string | null;
  invoice: { id: string } | null;
  job: {
    id: string;
    jobNumber: string | number | null;
    total: number | null;
    visits?: { totalCount?: number | null } | null;
  } | null;
  client: { id: string; name?: string | null; companyName?: string | null } | null;
}

export async function fetchAllJobVisits(since: Date | null = null): Promise<FlatVisit[]> {
  // Jobber's VisitFilterAttributes has no updatedAt — always full pull.
  const visits = await fetchIncremental<FlatVisitNode>(VISITS_QUERY, "visits", since, "visits", false);
  return visits.map((v) => {
    const jobTotal = v.job?.total != null ? Number(v.job.total) : 0;
    const count = v.job?.visits?.totalCount ?? 1;
    return {
      jobberVisitId: v.id,
      jobberJobId: v.job?.id ?? null,
      jobNumber: v.job?.jobNumber != null ? String(v.job.jobNumber) : null,
      title: v.title ?? null,
      clientName: v.client?.companyName || v.client?.name || null,
      isComplete: Boolean(v.isComplete),
      visitStatus: v.visitStatus ?? null,
      startAt: v.startAt ?? null,
      endAt: v.endAt ?? null,
      completedAt: v.completedAt ?? null,
      hasInvoice: v.invoice != null,
      estimatedValue: count > 0 ? jobTotal / count : 0,
    };
  });
}



export async function fetchAllInvoices(since: Date | null = null): Promise<JobberInvoiceNode[]> {
  return fetchIncremental<JobberInvoiceNode>(INVOICES_QUERY, "invoices", since, "invoices");
}

export interface FlatTimeEntry {
  jobberEntryId: string;
  jobberJobId: string | null;
  jobNumber: string | null;
  jobTitle: string | null;
  clientName: string | null;
  employeeId: string | null;
  employeeName: string | null;
  durationSeconds: number;
  approved: boolean;
  ticking: boolean;
  note: string | null;
  occurredAt: string | null;
}

interface FlatTimeEntryNode {
  id: string;
  finalDuration: number | null;
  approved: boolean | null;
  ticking: boolean | null;
  note: string | null;
  startAt: string | null;
  endAt: string | null;
  user: { id: string; name?: { full?: string | null } | null } | null;
  job: { id: string; jobNumber: string | number | null; title: string | null } | null;
  client: { id: string; name?: string | null; companyName?: string | null } | null;
}

export async function fetchAllJobTimesheets(since: Date | null = null): Promise<FlatTimeEntry[]> {
  const entries = await fetchIncremental<FlatTimeEntryNode>(TIMESHEETS_QUERY, "timeSheetEntries", since, "timesheets");
  return entries.map((e) => ({
    jobberEntryId: e.id,
    jobberJobId: e.job?.id ?? null,
    jobNumber: e.job?.jobNumber != null ? String(e.job.jobNumber) : null,
    jobTitle: e.job?.title ?? null,
    clientName: e.client?.companyName || e.client?.name || null,
    employeeId: e.user?.id ?? null,
    employeeName: e.user?.name?.full ?? null,
    durationSeconds: e.finalDuration != null ? Number(e.finalDuration) : 0,
    approved: Boolean(e.approved),
    ticking: Boolean(e.ticking),
    note: e.note ?? null,
    occurredAt: e.startAt ?? null,
  }));
}



export async function fetchJobsInRange(
  rangeStart: Date,
  rangeEnd: Date
): Promise<JobberJobNode[]> {
  const startIso = rangeStart.toISOString();
  const endIso = rangeEnd.toISOString();
  const collected: Map<string, JobberJobNode> = new Map();
  const runWith = async (q: string) => {
    const nodes = await paginate<JobberJobNode>(q, "jobs", {
      startDate: startIso,
      endDate: endIso,
    });
    for (const n of nodes) collected.set(n.id, n);
  };
  try {
    await runWith(JOBS_BY_RANGE_QUERY);
  } catch (err) {
    console.error("completedAt range query failed:", err);
  }
  try {
    await runWith(JOBS_BY_END_QUERY);
  } catch (err) {
    console.error("endAt range query failed:", err);
    if (collected.size === 0) throw err;
  }
  return Array.from(collected.values());
}

export const fetchJobsInWeek = fetchJobsInRange;
