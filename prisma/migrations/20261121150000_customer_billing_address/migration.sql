-- Store each Jobber client's BILLING ADDRESS on the customer.
--
-- Needed because a GoHighLevel contact created from Jobber is supposed to
-- carry the customer's billing address, and until now the sync kept only the
-- name, email and phone. The 2026-11-21 review-mode preview showed the gap
-- plainly: the one contact it would create had no address to create it with.
--
-- Four nullable text columns, no default and no backfill. Nullable because
-- Jobber genuinely has clients with no billing address on file, and a blank
-- address must stay distinguishable from one nobody has synced yet. The next
-- client sync fills them in; nothing reads them until then.
--
-- Additive only: no column is dropped, renamed or retyped, so an older build
-- of the app keeps working against this schema unchanged.
ALTER TABLE "Customer" ADD COLUMN "billingStreet" TEXT;
ALTER TABLE "Customer" ADD COLUMN "billingCity" TEXT;
ALTER TABLE "Customer" ADD COLUMN "billingState" TEXT;
ALTER TABLE "Customer" ADD COLUMN "billingPostalCode" TEXT;
