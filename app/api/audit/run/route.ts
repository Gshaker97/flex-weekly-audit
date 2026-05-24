import { NextRequest, NextResponse } from "next/server";
import { runAudit, getPreviousWeekRange, getCurrentWeekRange } from "@/lib/audit";

export const maxDuration = 300;

async function handle(req: NextRequest) {
  const url = new URL(req.url);
  const isCron =
    req.headers.get("x-cron-secret") === process.env.CRON_SECRET ||
    url.searchParams.get("cron_secret") === process.env.CRON_SECRET;

  const range = url.searchParams.get("range") === "current"
    ? getCurrentWeekRange()
    : getPreviousWeekRange();

  try {
    const audit = await runAudit({
      weekStart: range.weekStart,
      weekEnd: range.weekEnd,
      triggeredBy: isCron ? "cron" : "manual",
    });
    return NextResponse.json({ ok: true, auditId: audit.id });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message ?? "Audit failed" },
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
