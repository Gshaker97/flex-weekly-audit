-- AlterTable: carry Jobber's own timesheet label + labour rate through to the
-- app, so time can be split by crew type (residential vs commercial) and costed.
ALTER TABLE "TimeEntry" ADD COLUMN     "label" TEXT,
ADD COLUMN     "labourRate" DOUBLE PRECISION,
ADD COLUMN     "visitId" TEXT,
ADD COLUMN     "clientCompanyName" TEXT;

-- CreateIndex
CREATE INDEX "TimeEntry_label_idx" ON "TimeEntry"("label");
