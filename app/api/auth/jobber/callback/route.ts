import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForToken } from "@/lib/jobber";
import { prisma } from "@/lib/prisma";

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

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = req.cookies.get("jobber_oauth_state")?.value;

  if (!code) {
    return NextResponse.json(
      { error: "Missing authorization code" },
      { status: 400 }
    );
  }

  if (!state || !cookieState || state !== cookieState) {
    return NextResponse.json(
      { error: "Invalid OAuth state" },
      { status: 400 }
    );
  }

  try {
    const tokens: any = await exchangeCodeForToken(code);

    let expiresAt: Date;
    if (typeof tokens.expires_in === "number" && tokens.expires_in > 0) {
      expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
    } else {
      const jwtExp = decodeJwtExpiry(tokens.access_token);
      if (jwtExp) {
        expiresAt = new Date(jwtExp * 1000);
      } else {
        expiresAt = new Date(Date.now() + 55 * 60 * 1000);
      }
    }

    await prisma.jobberAuth.deleteMany({});
    await prisma.jobberAuth.create({
      data: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt,
      },
    });

    const appUrl = process.env.APP_URL || url.origin;
    const res = NextResponse.redirect(`${appUrl}/?connected=1`);
    res.cookies.delete("jobber_oauth_state");
    return res;
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? "OAuth exchange failed" },
      { status: 500 }
    );
  }
}
