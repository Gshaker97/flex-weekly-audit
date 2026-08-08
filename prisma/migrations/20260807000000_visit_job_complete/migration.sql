-- Visits inherit completion from their parent job.
-- Crews often mark the JOB complete in Jobber rather than each individual
-- visit, which left those visits flagged "not marked as completed" forever.
ALTER TABLE "VisitRecord" ADD COLUMN "jobComplete" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "VisitRecord_jobComplete_idx" ON "VisitRecord"("jobComplete");
