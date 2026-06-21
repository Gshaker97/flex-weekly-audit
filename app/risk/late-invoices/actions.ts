"use server";

import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";

// Persist the manual "Sarah called" step for a past-due invoice.
export async function setInvoiceCalled(invoiceId: string, called: boolean) {
  const calledAt = called ? new Date() : null;
  const calledBy = called ? "Sarah" : null;
  await prisma.lateInvoiceCall.upsert({
    where: { invoiceId },
    create: { invoiceId, calledAt, calledBy },
    update: { calledAt, calledBy },
  });
  revalidatePath("/risk/late-invoices");
}
