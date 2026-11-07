import { NextRequest, NextResponse } from "next/server";
import { assertSyncAdmission, SyncAdmissionError } from "@/lib/sync-writer-control";
import { runFullSync } from "@/lib/sync";
import { logError } from "@/lib/log";

// Pin the Node.js runtime explicitly. The sync needs Node APIs (Prisma, direct
// process.stdout logging) and must not be moved to the Edge runtime, where that
// output would be suppressed. This is already the App Router default, but we
// make it explicit so a future global default can't silently change it.
export const runtime = "nodejs";
export const maxDuration = 800;
export const dynamic = "force-dynamic";

async function handle(req: NextRequest) {
  // A cron secret never bypasses the HTTP cutover barrier, on GET or POST.
  try { assertSyncAdmission("http"); }
  catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof SyncAdmissionError ? err.message : "Sync admission unavailable" }, { status: 503 });
  }
  const url = new URL(req.url);
  const isCron = Boolean(process.env.CRON_SECRET) && (
    req.headers.get("x-cron-secret") === process.env.CRON_SECRET ||
    url.searchParams.get("cron_secret") === process.env.CRON_SECRET);

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
    entrypoint: "http",
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
