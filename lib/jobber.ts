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
    throw new Error("No Jobber authentication found. Connect Jobb
