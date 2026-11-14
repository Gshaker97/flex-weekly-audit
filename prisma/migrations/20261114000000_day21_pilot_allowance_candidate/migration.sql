-- LOCAL CANDIDATE. DO NOT DEPLOY without separate schema review and approval.
-- npm start runs prisma migrate deploy, so this must not reach production until
-- the Day 21 pilot itself is approved.
--
-- The entire pilot's single allowance, as ONE row.
--
-- The primary key is a fixed literal, so every worker races to insert the same
-- key regardless of invoice, contact, scheduled date or Phoenix day. Exactly one
-- INSERT ... ON CONFLICT DO NOTHING returns a row; every other one returns none.
-- That decision is made by the index at commit time, so an earlier transaction
-- that commits late cannot overturn a claim that is already committed.
--
-- There is deliberately no UPDATE or DELETE path, no expiry and no release
-- column. Once claimed the allowance stays consumed - through a crash, an
-- uncertain provider outcome, or a restart on any later date. Reopening it is a
-- manual act against the database, never something the code can do.
CREATE TABLE "Day21PilotAllowance" (
    "id" TEXT NOT NULL,
    "claimedByReservationId" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Day21PilotAllowance_pkey" PRIMARY KEY ("id"),
    -- One row, ever. The table cannot hold a second allowance.
    CONSTRAINT "Day21PilotAllowance_single_row" CHECK ("id" = 'day21-internal-email-pilot'),
    CONSTRAINT "Day21PilotAllowance_valid_claimant" CHECK (
        length("claimedByReservationId") BETWEEN 1 AND 256
    )
);
