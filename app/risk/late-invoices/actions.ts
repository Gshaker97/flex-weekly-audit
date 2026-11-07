"use server";

import { prisma } from "@/lib/prisma";
import { manualCallMark } from "@/lib/collection-evidence";
import { revalidatePath } from "next/cache";

// Persist only a manual mark. No authenticated actor is available here.
export async function setInvoiceCalled(invoiceId: string, called: boolean) {
  const { calledAt, calledBy } = manualCallMark(called);
  await prisma.lateInvoiceCall.upsert({
    where: { invoiceId },
    create: { invoiceId, calledAt, calledBy },
    update: { calledAt, calledBy },
  });
  revalidatePath("/risk/late-invoices");
}
