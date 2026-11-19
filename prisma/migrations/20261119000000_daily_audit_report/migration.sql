-- CreateTable
CREATE TABLE "DailyAuditReport" (
    "id" TEXT NOT NULL,
    "runDate" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "triggeredBy" TEXT NOT NULL DEFAULT 'cron',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "warnCount" INTEGER NOT NULL DEFAULT 0,
    "checks" JSONB,
    "errorMessage" TEXT,

    CONSTRAINT "DailyAuditReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DailyAuditReport_startedAt_idx" ON "DailyAuditReport"("startedAt");

-- CreateIndex
CREATE INDEX "DailyAuditReport_runDate_idx" ON "DailyAuditReport"("runDate");
