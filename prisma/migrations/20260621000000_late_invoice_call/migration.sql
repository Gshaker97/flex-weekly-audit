-- CreateTable
CREATE TABLE "LateInvoiceCall" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "calledAt" TIMESTAMP(3),
    "calledBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LateInvoiceCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LateInvoiceCall_invoiceId_key" ON "LateInvoiceCall"("invoiceId");
