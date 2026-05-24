import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForToken } from "@/lib/jobber";
import { prisma } from "@/lib/prisma";

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
    const tokens = await exchangeCodeForToken(code);
    await prisma.jobberAuth.deleteMany({});
    await prisma.jobberAuth.create({
      data: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
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
