import { NextRequest, NextResponse } from "next/server";
import { runAudit, getRange, RangePreset } from "@/lib/audit";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const VALID_PRESETS: RangePreset[] = [
  "ytd",
  "last30",
  "last90",
  "thisWeek",
  "lastWeek",
];

async function handle(req: NextRequest) {
  const url = new URL(req.url);
  const isCron =
    req.headers.get("x-cron-secret") === process.env.CRON_SECRET ||
    url.searchParams.get("cron_secret") === process.env.CRON_SECRET;

  const presetParam = url.searchParams.get("range") as RangePreset | null;
  const preset: RangePreset =
    presetParam && VALID_PRESETS.includes(presetParam)
      ? presetParam
      : isCron
      ? "lastWeek"
      : "ytd";

  const range = getRange(preset);

  try {
    const audit = await runAudit({
      rangeStart: range.start,
      rangeEnd: range.end,
      triggeredBy: isCron ? "cron" : "manual",
    });
    return NextResponse.json({ ok: true, auditId: audit.id, range: range.label });
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
