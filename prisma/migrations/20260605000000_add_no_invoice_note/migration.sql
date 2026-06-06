-- AlterTable
ALTER TABLE "JobRecord" ADD COLUMN "notes" TEXT,
ADD COLUMN "noInvoiceFlag" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "VisitRecord" ADD COLUMN "noInvoiceFlag" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "VisitRecord_noInvoiceFlag_idx" ON "VisitRecord"("noInvoiceFlag");
