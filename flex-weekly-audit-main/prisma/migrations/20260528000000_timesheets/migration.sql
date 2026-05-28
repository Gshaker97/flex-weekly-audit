-- AlterTable
ALTER TABLE "SyncRun" ADD COLUMN "timeEntriesFetched" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "TimeEntry" (
    "id" TEXT NOT NULL,
    "jobberEntryId" TEXT NOT NULL,
    "jobberJobId" TEXT,
    "jobNumber" TEXT,
    "jobTitle" TEXT,
    "clientName" TEXT,
    "employeeId" TEXT,
    "employeeName" TEXT,
    "durationSeconds" INTEGER NOT NULL DEFAULT 0,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "ticking" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "occurredAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TimeEntry_jobberEntryId_key" ON "TimeEntry"("jobberEntryId");

-- CreateIndex
CREATE INDEX "TimeEntry_jobberJobId_idx" ON "TimeEntry"("jobberJobId");

-- CreateIndex
CREATE INDEX "TimeEntry_employeeId_idx" ON "TimeEntry"("employeeId");

-- CreateIndex
CREATE INDEX "TimeEntry_occurredAt_idx" ON "TimeEntry"("occurredAt");
