# Automatic invoice reminders (evaluate only until one sender is confirmed)

This is the hourly reminder pass. Deploying it does not text anyone.

GoHighLevel workflows are not known to be idle. A read-only scan of all 672
conversations found 242 workflow-sent reminder SMS from January 28 through
November 3, 2026, including 81 with the exact Day 10 body this app would send,
plus Day 15/20/30 wording. Those texts typically start about 10 days after a
card enters Invoice Overdue and repeat about every 5 days. Paula's card
`OpWOESlrv15azR3Dxwa2` entered Invoice Overdue on November 3 at 3:13 PM
America/Phoenix, so a workflow Day 10 could land on November 13, the same day
as an app send. Workflow detail and enrollment returned 404, so triggers,
waits, and whether Paula is enrolled could not be read. No reminder SMS
location-wide since November 3 at 12:09 AM, three later Overdue cards with no
text, and a November 10 edit to Fixed Automation v49 are not proof the
workflows stopped.

The app and those workflows must not both send. November 13 is not an approved
send. An empty NotificationLedger and an empty conversation history do not
answer this, because a workflow wait would not appear until it sends.

This pass does not turn on the recurring Day 10 cohort and does not change
GoHighLevel write mode.

## What runs

After a completed standalone cron sync, `scripts/sync-cron.ts` calls
`runConfiguredAutomaticReminders`. The pass:

1. Reads the existing Jobber token. It does not refresh the token.
2. Re-reads cached open invoices, and cached paid invoices that still show a
   positive balance, from Jobber by id. Unchanged already-due invoices are
   included even when the incremental sync did not return them.
3. Evaluates each invoice on the official America/Phoenix clock. Jobber
   `issuedDate` is the operational send date. Jobber `dueDate` decides lateness,
   including net-7 and net-15. The due date is not a customer-text day. The next
   Phoenix date is the first overdue day, and that overdue move is not a text.
4. Skips elapsed milestones. A missed Day 10, 15, 20, 25, or 30 is reconciliation
   only. There is no catch-up batch.
5. Suppresses paid, zero-balance, void, draft, bad-debt, and contradictory
   paid-with-balance invoices.
6. Sends nothing unless the decision is the single Paula Day 10 allowlist send
   and a separate single-sender confirmation is present. That confirmation is
   unset. Do not set it for November 13.

The only customer text this pass can attempt is SMS, using the existing Day 10
pilot and the existing approved Day 10 body. There is no email fallback and no
second sender. Day 15, Day 20, Day 25, Day 30, and the internal Day 21 prompt are
not sendable here.

## Paula Day 10 is not ready

Invoice **7171**, contact `HEcpSb9P4bCIwbMEM165`, opportunity
`OpWOESlrv15azR3Dxwa2` remains the only allowlisted candidate. Category is the
owner-selected irrigation grant. The second card `Bi2YvzKnqOx6dlGB20GT` is
refused if it appears in a reviewed config, and this pass never writes either
card. Day 15 (November 18) and the internal Day 21 prompt (November 24) are
not enabled.

Do not arm a November 13 send. The clock below is the rule that would apply
only after one sender has been confirmed in the GoHighLevel UI. It is not an
instruction to send on Friday.

A future send would be possible only when all of these are true:

- Phoenix calendar date is **2026-11-13**.
- Local time is **09:05:00 inclusive through 09:14:59**. 09:15:00 is missed and
  is not replayed. Nothing in this pass sends outside 09:00:00–09:14:59.
- The Jobber token's `updatedAt` is on that Phoenix date at or after 09:00, and
  at least 900 seconds remain. The 09:00 cron refresh is what makes this true.
  Do not refresh the token by hand.
- A fresh Jobber read still shows the invoice overdue with a positive balance.
- No Day 10 homeowner ledger row already exists for that invoice. That check
  does not prove a workflow will stay quiet later in the day.
- `FLEXX_REMINDER_SINGLE_SENDER` is exactly
  `app-only-ghl-workflows-confirmed-idle` and
  `FLEXX_REMINDER_SINGLE_SENDER_REVIEW_REF` is a non-empty review reference
  recorded after the UI confirmation. `true`, `yes`, `1`, and attempt mode do
  not match. Both are unset. Do not set them from this change.
- The reviewed one-invoice config below is present and unexpired.

That wait-until-09:05 behavior runs only when the single-sender confirmation
is already present. It is not present. The pass will not wait and will not
text on November 13. If a later confirmation exists and the sync returns
before 09:05, the pass waits until 09:05 and reads the invoice again. It will
not wait more than five minutes and will not send at or after 09:15. If the
sync is still running at 09:15, Day 10 is skipped.

## What stays off

Leave these as they are. This change does not set them:

- `GHL_INVOICE_WRITE_MODE=review`
- `GHL_PHONE_WRITES_ENABLED=false`
- `GHL_APPROVED_OPPORTUNITY_IDS` empty
- `SYNC_ADMISSION_MODE=cron_only`
- `GHL_NOTIFICATIONS_ENABLED` unset
- `FLEXX_RECURRING_DAY10_MODE` and the rest of the recurring Day 10 policy unset
- `GHL_RECURRING_DUE_DATE_ENABLED`, cycle ownership, and existing-overdue
  bootstrap unset

`FLEXX_AUTOMATIC_REMINDER_MODE` is unset by default. Unset, `evaluate`, and
`disabled` only evaluate. Any other value, including `attempt` or `true`, also
only evaluates. The cohort hook is not armed.

Do not apply Railway environment patch `ba977a28-570f-417c-84ed-9a88a6ce0b6a`.
Its contents were not verified, and it is not part of this path.

## Required live config (do not invent, and do not set for November 13)

These values are not in the repo. None of them are set by this change. If any
one is missing, the pass holds and does not send:

- `FLEXX_REMINDER_SINGLE_SENDER` and
  `FLEXX_REMINDER_SINGLE_SENDER_REVIEW_REF`, only after a UI confirmation that
  the app is the only sender. Not set now.
- `FLEXX_AUTOMATIC_REMINDER_MODE=paula-day10-attempt` on the **cron** service.
  Unset, this pass only evaluates. It is not set for November 13.
- `FLEXX_AUTOMATIC_REMINDER_CONFIG_JSON`: one reviewed Day 10 pilot config,
  32 KiB or less. Contact, invoice, and client must be Paula's. `scheduledOn`
  must be `2026-11-13`. Channel must be SMS. The body must be the existing
  approved Day 10 text. `currencyPolicy` may be null with that static body.
- `FLEXX_AUTOMATIC_REMINDER_CONFIG_SHA256`: SHA-256 of the exact JSON bytes.
- `FLEXX_AUTOMATIC_REMINDER_REVIEW_REF`: the same `reviewRef` as the JSON.

The JSON would still have to contain real values this repo does not know, and
which must not be guessed:

- SMS sender number
- exact native footer suffix
- Jobber account id
- the two reviewed quarantine identities
- Paula's destination phone, matching Jobber and GoHighLevel at send time

A reviewed config expires within 24 hours. Do not commit it. Do not prepare it
for November 13 while the workflow-duplicate question is open.

The cron service id is `ee3a4c67-8b0c-48d2-871d-e20bed336c4a`. The pilot's
existing write holds still apply on that service: review mode, phone writes
false, `SYNC_ADMISSION_MODE=cron_only`, and notifications not enabled.

## November 13

Skip the send. Leave `FLEXX_AUTOMATIC_REMINDER_MODE` and
`FLEXX_REMINDER_SINGLE_SENDER` unset. The 09:00 cron still reconciles
already-due invoices and will not text. After 09:15 the Day 10 milestone is
skipped and is not replayed.

Do not set the single-sender variables, the Day 10 config, or attempt mode in
order to "make" Friday. The duplicate-workflow question is still open. A live
send waits until that is settled in the GoHighLevel UI and one sender is
chosen. This repository change does not settle it.

If a later review confirms the app is the only sender, the same clock, allowlist,
paid-balance re-read, and no-replay rules still apply. An `unknown` send result
is not retried. Day 15 and the internal Day 21 prompt stay off.

## Everyone else

Other overdue invoices are evaluated and held or reconciled. Unproven category,
shared identity, email-only, ambiguous cards, and missed milestones stay
unsent. Adding another customer requires a separate allowlist change that this
pass does not accept.
