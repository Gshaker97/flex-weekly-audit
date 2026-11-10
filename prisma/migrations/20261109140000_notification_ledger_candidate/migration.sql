-- LOCAL CANDIDATE. DO NOT DEPLOY without separate schema review and approval.
-- npm start runs prisma migrate deploy, even when send functionality is disabled.
CREATE TABLE "NotificationLedger" (
    "id" TEXT NOT NULL,
    "reservationToken" VARCHAR(64) NOT NULL,
    "eventKey" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "dayPastDue" INTEGER NOT NULL,
    "audience" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "scheduledOn" DATE NOT NULL,
    "channel" TEXT NOT NULL,
    "eventPayload" JSONB NOT NULL,
    "body" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "eventHash" VARCHAR(64) NOT NULL,
    "bodyHash" VARCHAR(64) NOT NULL,
    "destinationHash" VARCHAR(64) NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'reserved',
    "providerMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pendingAt" TIMESTAMP(3),
    "outcomeAt" TIMESTAMP(3),
    CONSTRAINT "NotificationLedger_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "NotificationLedger_valid_identity" CHECK (
        length("accountId") BETWEEN 1 AND 256 AND length("invoiceId") BETWEEN 1 AND 256
        AND length("contactId") BETWEEN 1 AND 256 AND "dayPastDue" BETWEEN 1 AND 3660
        AND "audience" IN ('homeowner', 'internal') AND "channel" IN ('sms', 'email')
    ),
    CONSTRAINT "NotificationLedger_valid_digests" CHECK (
        "reservationToken" ~ '^[a-f0-9]{64}$' AND "eventHash" ~ '^[a-f0-9]{64}$'
        AND "bodyHash" ~ '^[a-f0-9]{64}$' AND "destinationHash" ~ '^[a-f0-9]{64}$'
    ),
    CONSTRAINT "NotificationLedger_valid_key" CHECK (
        "eventKey"::jsonb = jsonb_build_array('notification-v1', "accountId", "invoiceId", "dayPastDue", "audience")
    ),
    CONSTRAINT "NotificationLedger_valid_payload" CHECK (
        jsonb_typeof("eventPayload") = 'object'
        AND "eventPayload" @> jsonb_build_object(
            'accountId', "accountId", 'invoiceId', "invoiceId", 'dayPastDue', "dayPastDue",
            'audience', "audience", 'contactId', "contactId", 'channel', "channel",
            'destination', "destination", 'bodyDigest', "bodyHash")
    ),
    CONSTRAINT "NotificationLedger_valid_state" CHECK (
        ("state" = 'reserved' AND "pendingAt" IS NULL AND "outcomeAt" IS NULL AND "providerMessageId" IS NULL)
        OR ("state" = 'pending' AND "pendingAt" IS NOT NULL AND "outcomeAt" IS NULL AND "providerMessageId" IS NULL)
        OR ("state" = 'accepted' AND "pendingAt" IS NOT NULL AND "outcomeAt" IS NOT NULL
            AND "providerMessageId" IS NOT NULL AND length("providerMessageId") BETWEEN 1 AND 256)
        OR ("state" IN ('rejected', 'unknown') AND "pendingAt" IS NOT NULL
            AND "outcomeAt" IS NOT NULL AND "providerMessageId" IS NULL)
    )
);

CREATE UNIQUE INDEX "NotificationLedger_reservationToken_key" ON "NotificationLedger"("reservationToken");
CREATE UNIQUE INDEX "NotificationLedger_eventKey_key" ON "NotificationLedger"("eventKey");
-- Logical identity also has its own unique index: raw JSON whitespace/serialization
-- differences must never create a second claim for the same invoice milestone.
CREATE UNIQUE INDEX "NotificationLedger_accountId_invoiceId_dayPastDue_audience_key"
    ON "NotificationLedger"("accountId", "invoiceId", "dayPastDue", "audience");
-- One message per account/contact/Phoenix calendar date, across every channel,
-- invoice, milestone and audience. Includes shared internal recipient collisions.
CREATE UNIQUE INDEX "NotificationLedger_accountId_contactId_scheduledOn_key"
    ON "NotificationLedger"("accountId", "contactId", "scheduledOn");
CREATE INDEX "NotificationLedger_state_createdAt_idx" ON "NotificationLedger"("state", "createdAt");

-- Enforce immutability and one-way state changes independently of application SQL.
-- No automatic lease expiry, reclaim, reset, outcome escalation or retry exists.
CREATE FUNCTION "notification_ledger_guard_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW."id", NEW."reservationToken", NEW."eventKey", NEW."accountId", NEW."invoiceId",
           NEW."dayPastDue", NEW."audience", NEW."contactId", NEW."scheduledOn", NEW."channel",
           NEW."eventPayload", NEW."body", NEW."destination", NEW."eventHash", NEW."bodyHash",
           NEW."destinationHash", NEW."createdAt")
       IS DISTINCT FROM
       ROW(OLD."id", OLD."reservationToken", OLD."eventKey", OLD."accountId", OLD."invoiceId",
           OLD."dayPastDue", OLD."audience", OLD."contactId", OLD."scheduledOn", OLD."channel",
           OLD."eventPayload", OLD."body", OLD."destination", OLD."eventHash", OLD."bodyHash",
           OLD."destinationHash", OLD."createdAt") THEN
        RAISE EXCEPTION 'notification ledger claim data is immutable';
    END IF;
    IF OLD."state" = 'reserved' AND NEW."state" = 'pending' THEN
        RETURN NEW;
    END IF;
    IF OLD."state" = 'pending' AND NEW."state" IN ('accepted', 'rejected', 'unknown')
       AND NEW."pendingAt" IS NOT DISTINCT FROM OLD."pendingAt" THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'notification ledger transition is not permitted';
END;
$$;

CREATE TRIGGER "NotificationLedger_guard_update"
    BEFORE UPDATE ON "NotificationLedger" FOR EACH ROW EXECUTE FUNCTION "notification_ledger_guard_update"();
