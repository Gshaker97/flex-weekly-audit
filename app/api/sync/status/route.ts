import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// Lightweight status endpoint the Sync button polls while a background sync runs.
export async function GET() {
  const run = await prisma.syncRun.findFirst({
    orderBy: { startedAt: "desc" },
  });
  return NextResponse.json({ ok: true, run });
}
