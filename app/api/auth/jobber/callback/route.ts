import { prisma } from "./prisma";

const JOBBER_API_URL = "https://api.getjobber.com/api/graphql";
const JOBBER_TOKEN_URL = "https://api.getjobber.com/api/oauth/token";
const JOBBER_AUTHORIZE_URL = "https://api.getjobber.com/api/oauth/authorize";
const JOBBER_API_VERSION = "2024-04-01";

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

  if (expiresInMs > 5 * 60 * 1000) {
    return auth.accessToken;
  }

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

  const res = await fetch(JOBBER_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-JOBBER-GRAPHQL-VERSION": JOBBER_API_VERSION,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jobber API ${res.status}: ${text}`);
  }

  const data = await res.json();

  if (data.errors && data.errors.length > 0) {
    throw new Error(
      `Jobber GraphQL error: ${data.errors.map((e: any) => e.message).join(", ")}`
    );
  }

  return data.data as T;
}

const JOBS_QUERY = `
  query GetJobs($after: String, $startDate: ISO8601DateTime!, $endDate: ISO8601DateTime!) {
    jobs(
      first: 50
      after: $after
      filter: {
        completedAt: { after: $startDate, before: $endDate }
      }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        jobNumber
        title
        jobStatus
        completedAt
        endAt
        total
        client {
          id
          name
          companyName
        }
        invoices {
          nodes { id invoiceNumber }
        }
      }
    }
  }
`;

const JOBS_BY_END_QUERY = `
  query GetJobsByEnd($after: String, $startDate: ISO8601DateTime!, $endDate: ISO8601DateTime!) {
    jobs(
      first: 50
      after: $after
      filter: {
        endAt: { after: $startDate, before: $endDate }
      }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        jobNumber
        title
        jobStatus
        completedAt
        endAt
        total
        client {
          id
          name
          companyName
        }
        invoices {
          nodes { id invoiceNumber }
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
  completedAt: string | null;
  endAt: string | null;
  total: number | null;
  client: { id: string; name?: string | null; companyName?: string | null } | null;
  invoices: { nodes: Array<{ id: string; invoiceNumber: string | null }> };
}

export async function fetchJobsInWeek(
  weekStart: Date,
  weekEnd: Date
): Promise<JobberJobNode[]> {
  const startIso = weekStart.toISOString();
  const endIso = weekEnd.toISOString();

  const collected: Map<string, JobberJobNode> = new Map();

  const runPaginated = async (query: string) => {
    let after: string | null = null;
    let hasNext = true;
    while (hasNext) {
      const data: any = await jobberGraphQL(query, {
        after,
        startDate: startIso,
        endDate: endIso,
      });
      const nodes: JobberJobNode[] = data?.jobs?.nodes ?? [];
      for (const node of nodes) {
        collected.set(node.id, node);
      }
      hasNext = data?.jobs?.pageInfo?.hasNextPage ?? false;
      after = data?.jobs?.pageInfo?.endCursor ?? null;
      if (hasNext) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  };

  try {
    await runPaginated(JOBS_QUERY);
  } catch (err) {
    console.error("completedAt filter failed, falling back to endAt only:", err);
  }

  try {
    await runPaginated(JOBS_BY_END_QUERY);
  } catch (err) {
    console.error("endAt filter failed:", err);
    if (collected.size === 0) throw err;
  }

  return Array.from(collected.values());
}
