import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  const audit = await prisma.audit.findFirst({
    orderBy: { startedAt: "desc" },
    include: { flaggedJobItems: true },
  });
  return NextResponse.json(audit);
}
