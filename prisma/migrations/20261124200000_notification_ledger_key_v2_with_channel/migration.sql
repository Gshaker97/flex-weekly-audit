-- THE LEDGER COULD NOT RECORD ANYTHING, SO NOTHING COULD BE SENT.
--
-- `NotificationLedger_valid_key` still described the pre-channel key:
--
--   ["notification-v1", accountId, invoiceId, dayPastDue, audience]
--
-- The code has minted a per-channel key since the channel was added on
-- 2026-11-18 (`eventKey` in lib/notification-gate.ts):
--
--   ["notification-v2", accountId, invoiceId, dayPastDue, audience, channel]
--
-- So every single reservation violated this CHECK. `reserve()` catches a failed
-- INSERT and reports `ledger_uncertain`, which the dispatcher correctly treats
-- as "it is not safe to send", because an unrecorded send cannot be prevented
-- from happening twice. The result was silent: a run would report every message
-- as incomplete and send nothing, with no row to show why. Measured
-- 2026-11-24 against production: 31 of 31 catch-up messages held this way.
--
-- THIS CONSTRAINT IS STRICTLY NARROWER THAN THE ONE IT REPLACES. The key must
-- now also agree with the row's own channel, so a key cannot be minted for one
-- channel and stored on a row for the other. Nothing is relaxed: the two UNIQUE
-- indexes that actually prevent a double send
--
--   (accountId, invoiceId, dayPastDue, audience, channel)
--   (accountId, contactId, scheduledOn, channel)
--
-- are untouched, and verified still to refuse a second message for the same
-- invoice, day and channel.
--
-- No data migration: the table held 0 rows, so no v1 key exists to rewrite.

ALTER TABLE "NotificationLedger" DROP CONSTRAINT "NotificationLedger_valid_key";

ALTER TABLE "NotificationLedger" ADD CONSTRAINT "NotificationLedger_valid_key" CHECK (
    "eventKey"::jsonb = jsonb_build_array(
        'notification-v2', "accountId", "invoiceId", "dayPastDue", "audience", "channel"
    )
);
