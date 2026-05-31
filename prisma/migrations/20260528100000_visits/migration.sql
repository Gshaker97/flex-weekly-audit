-- AlterTable
ALTER TABLE "SyncRun" ADD COLUMN "visitsFetched" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "VisitRecord" (
    "id" TEXT NOT NULL,
    "jobberVisitId" TEXT NOT NULL,
    "jobberJobId" TEXT,
    "jobNumber" TEXT,
    "title" TEXT,
    "clientName" TEXT,
    "isComplete" BOOLEAN NOT NULL DEFAULT false,
    "visitStatus" TEXT,
    "visitDate" TIMESTAMP(3),
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "hasInvoice" BOOLEAN NOT NULL DEFAULT false,
    "estimatedValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VisitRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VisitRecord_jobberVisitId_key" ON "VisitRecord"("jobberVisitId");

-- CreateIndex
CREATE INDEX "VisitRecord_visitDate_idx" ON "VisitRecord"("visitDate");

-- CreateIndex
CREATE INDEX "VisitRecord_isComplete_idx" ON "VisitRecord"("isComplete");

-- CreateIndex
CREATE INDEX "VisitRecord_hasInvoice_idx" ON "VisitRecord"("hasInvoice");
