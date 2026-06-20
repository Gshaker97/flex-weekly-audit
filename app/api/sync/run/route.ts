import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { runFullSync } from "@/lib/sync";
import { logError } from "@/lib/log";

// Pin the Node.js runtime explicitly. The sync needs Node APIs (Prisma, direct
// process.stdout logging) and must not be moved to the Edge runtime, where that
// output would be suppressed. This is already the App Router default, but we
// make it explicit so a future global default can't silently change it.
export const runtime = "nodejs";
export const maxDuration = 800;
export const dynamic = "force-dynamic";

// If a run has been "running" longer than this, treat it as stale (e.g. the
// container restarted mid-sync) and allow a new one to start.
const STALE_RUNNING_MS = 20 * 60 * 1000;

async function handle(req: NextRequest) {
  const url = new URL(req.url);
  const isCron =
    req.headers.get("x-cron-secret") === process.env.CRON_SECRET ||
    url.searchParams.get("cron_secret") === process.env.CRON_SECRET;

  // Don't start a second sync if one is already in flight (and not stale).
  const running = await prisma.syncRun.findFirst({
    where: { status: "running" },
    orderBy: { startedAt: "desc" },
  });
  if (
    running &&
    Date.now() - new Date(running.startedAt).getTime() < STALE_RUNNING_MS
  ) {
    return NextResponse.json(
      { ok: true, alreadyRunning: true, syncId: running.id },
      { status: 202 }
    );
  }

  const forceFull =
    url.searchParams.get("full") === "1" ||
    url.searchParams.get("full") === "true";

  // Fire-and-forget. The sync paginates thousands of records and runs for
  // minutes — longer than the platform's HTTP/proxy timeout, which is what
  // produced the 502. The container stays alive (`next start`), so we kick the
  // sync off in the background, return immediately, and let the client poll
  // /api/sync/status for completion.
  void runFullSync({
    triggeredBy: isCron ? "cron" : "manual",
    full: forceFull,
  }).catch((err) =>
    logError("[sync] background run failed:", err?.message ?? err)
  );

  return NextResponse.json({ ok: true, started: true }, { status: 202 });
}

export async function POST(req: NextRequest) {
  return handle(req);
}

export async function GET(req: NextRequest) {
  return handle(req);
}
