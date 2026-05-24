-- CreateTable
CREATE TABLE "JobberAuth" (
    "id" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "accountName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobberAuth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Audit" (
    "id" TEXT NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "weekEnd" TIMESTAMP(3) NOT NULL,
    "totalJobs" INTEGER NOT NULL DEFAULT 0,
    "completedJobs" INTEGER NOT NULL DEFAULT 0,
    "invoicedJobs" INTEGER NOT NULL DEFAULT 0,
    "flaggedJobs" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "triggeredBy" TEXT NOT NULL DEFAULT 'manual',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Audit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FlaggedJob" (
    "id" TEXT NOT NULL,
    "auditId" TEXT NOT NULL,
    "jobberJobId" TEXT NOT NULL,
    "jobNumber" TEXT,
    "jobTitle" TEXT,
    "clientName" TEXT,
    "jobStatus" TEXT,
    "completedAt" TIMESTAMP(3),
    "scheduledEnd" TIMESTAMP(3),
    "totalAmount" DOUBLE PRECISION,
    "hasInvoice" BOOLEAN NOT NULL DEFAULT false,
    "invoiceNumber" TEXT,
    "flagReasons" TEXT[],
    "jobberUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FlaggedJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Audit_weekStart_idx" ON "Audit"("weekStart");
CREATE INDEX "Audit_startedAt_idx" ON "Audit"("startedAt");
CREATE INDEX "FlaggedJob_auditId_idx" ON "FlaggedJob"("auditId");
CREATE INDEX "FlaggedJob_jobberJobId_idx" ON "FlaggedJob"("jobberJobId");

-- AddForeignKey
ALTER TABLE "FlaggedJob" ADD CONSTRAINT "FlaggedJob_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "Audit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
