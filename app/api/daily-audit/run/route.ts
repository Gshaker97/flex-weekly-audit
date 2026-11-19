import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { runDailyAudit } from "@/lib/daily-audit/run";

export const dynamic = "force-dynamic";

// Starts a daily audit in the background and returns at once; the page polls
// for the saved report. The scheduled run uses scripts/daily-audit.ts instead.
// Read-only against Jobber and GHL, same as the cron run.
export async function POST() {
  const running = await prisma.dailyAuditReport.findFirst({
    where: { status: "running", startedAt: { gte: new Date(Date.now() - 30 * 60_000) } },
  });
  if (running) {
    return NextResponse.json({ ok: true, alreadyRunning: true, reportId: running.id });
  }
  runDailyAudit({ triggeredBy: "manual" }).catch(() => {
    /* failure is recorded on the report row */
  });
  return NextResponse.json({ ok: true, started: true });
}
