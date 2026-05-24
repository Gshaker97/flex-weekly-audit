-- CreateTable
CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "triggeredBy" TEXT NOT NULL DEFAULT 'manual',
    "customersFetched" INTEGER NOT NULL DEFAULT 0,
    "jobsFetched" INTEGER NOT NULL DEFAULT 0,
    "invoicesFetched" INTEGER NOT NULL DEFAULT 0,
    "quotesFetched" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "jobberClientId" TEXT NOT NULL,
    "name" TEXT,
    "companyName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "createdAtJobber" TIMESTAMP(3),
    "isRecurring" BOOLEAN NOT NULL DEFAULT false,
    "totalRevenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "jobCount" INTEGER NOT NULL DEFAULT 0,
    "lastJobAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRecord" (
    "id" TEXT NOT NULL,
    "jobberJobId" TEXT NOT NULL,
    "jobNumber" TEXT,
    "title" TEXT,
    "jobStatus" TEXT,
    "jobType" TEXT,
    "isRecurring" BOOLEAN NOT NULL DEFAULT false,
    "total" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "createdAtJobber" TIMESTAMP(3),
    "customerId" TEXT,
    "clientName" TEXT,
    "hasInvoice" BOOLEAN NOT NULL DEFAULT false,
    "invoiceNumber" TEXT,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceRecord" (
    "id" TEXT NOT NULL,
    "jobberInvoiceId" TEXT NOT NULL,
    "invoiceNumber" TEXT,
    "invoiceStatus" TEXT,
    "subtotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "amountPaid" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "amountDue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "issuedAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdAtJobber" TIMESTAMP(3),
    "customerId" TEXT,
    "clientName" TEXT,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonthlySnapshot" (
    "id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "invoicedRevenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "collectedRevenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "newCustomers" INTEGER NOT NULL DEFAULT 0,
    "jobsCompleted" INTEGER NOT NULL DEFAULT 0,
    "averageJobValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "recurringRevenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "oneOffRevenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonthlySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceTypeRevenue" (
    "id" TEXT NOT NULL,
    "serviceName" TEXT NOT NULL,
    "revenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "jobCount" INTEGER NOT NULL DEFAULT 0,
    "year" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceTypeRevenue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SyncRun_startedAt_idx" ON "SyncRun"("startedAt");
CREATE UNIQUE INDEX "Customer_jobberClientId_key" ON "Customer"("jobberClientId");
CREATE INDEX "Customer_createdAtJobber_idx" ON "Customer"("createdAtJobber");
CREATE INDEX "Customer_isRecurring_idx" ON "Customer"("isRecurring");
CREATE UNIQUE INDEX "JobRecord_jobberJobId_key" ON "JobRecord"("jobberJobId");
CREATE INDEX "JobRecord_customerId_idx" ON "JobRecord"("customerId");
CREATE INDEX "JobRecord_completedAt_idx" ON "JobRecord"("completedAt");
CREATE INDEX "JobRecord_endAt_idx" ON "JobRecord"("endAt");
CREATE INDEX "JobRecord_jobStatus_idx" ON "JobRecord"("jobStatus");
CREATE INDEX "JobRecord_isRecurring_idx" ON "JobRecord"("isRecurring");
CREATE UNIQUE INDEX "InvoiceRecord_jobberInvoiceId_key" ON "InvoiceRecord"("jobberInvoiceId");
CREATE INDEX "InvoiceRecord_customerId_idx" ON "InvoiceRecord"("customerId");
CREATE INDEX "InvoiceRecord_issuedAt_idx" ON "InvoiceRecord"("issuedAt");
CREATE INDEX "InvoiceRecord_invoiceStatus_idx" ON "InvoiceRecord"("invoiceStatus");
CREATE UNIQUE INDEX "MonthlySnapshot_year_month_key" ON "MonthlySnapshot"("year", "month");
CREATE INDEX "MonthlySnapshot_year_month_idx" ON "MonthlySnapshot"("year", "month");
CREATE UNIQUE INDEX "ServiceTypeRevenue_year_serviceName_key" ON "ServiceTypeRevenue"("year", "serviceName");
CREATE INDEX "ServiceTypeRevenue_year_idx" ON "ServiceTypeRevenue"("year");

-- AddForeignKey
ALTER TABLE "JobRecord" ADD CONSTRAINT "JobRecord_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InvoiceRecord" ADD CONSTRAINT "InvoiceRecord_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
