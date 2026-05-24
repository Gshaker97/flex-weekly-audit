import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { getAuthorizeUrl } from "@/lib/jobber";

export async function GET() {
  const state = randomBytes(16).toString("hex");
  const url = getAuthorizeUrl(state);
  const res = NextResponse.redirect(url);
  res.cookies.set("jobber_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });
  return res;
}
