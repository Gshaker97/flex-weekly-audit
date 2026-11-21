-- One reminder may now go out on BOTH channels: one text AND one email.
--
-- Approved by the account owner on 2026-11-18, in these words: allow a customer
-- to get one text and one email on the same day.
--
-- Until now the ledger carried two caps, and each permitted a single row:
--
--   (accountId, invoiceId, dayPastDue, audience)  one message per invoice per day
--   (accountId, contactId, scheduledOn)           one message per CUSTOMER per day
--
-- One ledger row carries one channel, one body and one destination, so two
-- messages need two rows and either cap refused the second. Both caps now carry
-- "channel".
--
-- WHAT THIS DELIBERATELY DOES NOT DO. "invoiceId" is NOT added to the
-- per-customer cap. A customer with four overdue invoices still receives one
-- text and one email on that day, not four of each. The daily cap survives; it
-- is now per channel instead of per customer.
--
-- WHAT IT RELAXES, NAMED. A channel switch is no longer deduplicated by the
-- ledger: an email and a text for the same invoice, day and audience are now two
-- legitimate events rather than one. That is the point of the change.
--
-- SAFE AT THIS MOMENT. "NotificationLedger" held 0 rows when this was written,
-- verified read-only, so no message already recorded can be re-sent by the key
-- change that accompanies this migration. The old indexes are a strict subset of
-- the new ones, so no existing row could violate either new index in any case.

DROP INDEX "NotificationLedger_accountId_invoiceId_dayPastDue_audience_key";

CREATE UNIQUE INDEX "NotificationLedger_accountId_invoiceId_dayPastDue_audience_channel_key"
    ON "NotificationLedger"("accountId", "invoiceId", "dayPastDue", "audience", "channel");

DROP INDEX "NotificationLedger_accountId_contactId_scheduledOn_key";

CREATE UNIQUE INDEX "NotificationLedger_accountId_contactId_scheduledOn_channel_key"
    ON "NotificationLedger"("accountId", "contactId", "scheduledOn", "channel");
