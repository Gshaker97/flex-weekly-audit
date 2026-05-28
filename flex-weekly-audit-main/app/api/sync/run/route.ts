import { NextRequest, NextResponse } from "next/server";
import { runFullSync } from "@/lib/sync";

export const maxDuration = 800;
export const dynamic = "force-dynamic";

async function handle(req: NextRequest) {
  const url = new URL(req.url);
  const isCron =
    req.headers.get("x-cron-secret") === process.env.CRON_SECRET ||
    url.searchParams.get("cron_secret") === process.env.CRON_SECRET;

  try {
    const run = await runFullSync({
      triggeredBy: isCron ? "cron" : "manual",
    });
    return NextResponse.json({ ok: true, syncId: run.id });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message ?? "Sync failed" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  return handle(req);
}

export async function GET(req: NextRequest) {
  return handle(req);
}
