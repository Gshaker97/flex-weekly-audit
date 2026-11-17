-- Record the outcome of each hourly open-invoice Jobber verification.
--
-- Purely additive: two nullable columns on an existing table, no index, no
-- backfill, no default. Existing rows read as NULL, which the dashboard treats
-- as "no verification recorded" -- the same thing it assumed before this change.
-- Nothing is rewritten, so no stored status or balance can move as a result.
--
-- lastVerifiedAt advances only when Jobber CONFIRMED the invoice, so a failed
-- check can never make a stale row look current.
ALTER TABLE "InvoiceRecord" ADD COLUMN "lastVerifiedAt" TIMESTAMP(3);
ALTER TABLE "InvoiceRecord" ADD COLUMN "lastVerifyOutcome" TEXT;
