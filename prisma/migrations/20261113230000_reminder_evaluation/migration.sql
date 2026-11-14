-- Evaluate-only reminder run records. Additive: two new tables, no change to
-- any existing table, column, index or constraint.
CREATE TABLE "ReminderEvaluationRun" (
    "id" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "phoenixDate" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "candidates" INTEGER NOT NULL DEFAULT 0,
    "eligible" INTEGER NOT NULL DEFAULT 0,
    "held" INTEGER NOT NULL DEFAULT 0,
    "exclusionsVerified" BOOLEAN NOT NULL DEFAULT false,
    "sendsAttempted" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    CONSTRAINT "ReminderEvaluationRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReminderEvaluationRow" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "jobberInvoiceId" TEXT NOT NULL,
    "invoiceNumber" TEXT,
    "clientName" TEXT,
    "category" TEXT,
    "categorySource" TEXT,
    "categoryEvidence" TEXT,
    "daysPastDue" INTEGER,
    "balanceCents" INTEGER,
    "milestoneDay" INTEGER,
    "audience" TEXT,
    "decision" TEXT NOT NULL,
    "holds" TEXT NOT NULL,
    CONSTRAINT "ReminderEvaluationRow_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReminderEvaluationRun_startedAt_idx" ON "ReminderEvaluationRun"("startedAt");
CREATE INDEX "ReminderEvaluationRun_phoenixDate_idx" ON "ReminderEvaluationRun"("phoenixDate");
CREATE INDEX "ReminderEvaluationRow_runId_idx" ON "ReminderEvaluationRow"("runId");
CREATE INDEX "ReminderEvaluationRow_jobberInvoiceId_idx" ON "ReminderEvaluationRow"("jobberInvoiceId");

ALTER TABLE "ReminderEvaluationRow" ADD CONSTRAINT "ReminderEvaluationRow_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "ReminderEvaluationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
