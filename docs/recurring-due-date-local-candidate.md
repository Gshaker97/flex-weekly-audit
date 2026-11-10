# Draft: current-cohort due-date-before-stage restoration

Local candidate only. No deployment, publication, provider change, workflow change,
or live test was performed. The flag is absent/off by default. The recurring cron
can evaluate eligible cards, but **this is controlled current-cohort restoration,
not unlimited recurring invoice-cycle coverage**. No new message engine is added.

## Small integration boundary

The existing admitted sync writer routes non-Paid Overdue mutations through
`syncRecurringDueDateBeforeStage`. A disabled or held helper never falls back to
legacy Overdue PUT. Existing Overdue cards are held, not re-enrolled or demoted.
Existing review, phone, approved-card, write-approval and durable admission gates
remain. Paid exits retain their existing guards. With the feature disabled,
non-Overdue legacy paths are unchanged. With it enabled, non-Paid writes other
than the reviewed Sent-to-Overdue transition are held.

The exact full card, fresh complete owner invoice population and fresh complete
identity proof must establish one unpaid invoice and one existing open invoice
pipeline card with matching balance. Multi-invoice debt, contradictory/negative
amounts, unknown statuses, missing identities, closed/special stages and creation
are held. Paid historical invoices are allowed only if explicitly paid/zero.

Only `opportunity.due_date`, DATE field `0JiuBziS4foqfka1jQyQ` in location
`HDnGCHKTomL53dHe8KLs`, is populated, using Jobber's actual dueDate converted to
America/Phoenix YYYY-MM-DD. Blank dates may be written; exactly aligned dates
need no date PUT; any conflicting value is held. issuedDate is preserved as the
operational send date. No clock is restarted or substituted with stage-entry time.

Overdue starts on the Arizona calendar day after due date (the operational day-2
convention). A delayed sync may enter only while the first Day10 09:00 Arizona
milestone is still strictly future. Due+2 through due+9 are supported. Once that
first milestone is due/past, automatic catch-up is held. Existing Overdue cycles
always require separate execution review.

## Durable sequence

1. Verify the immutable approved full workflow inventory against fresh metadata.
2. Read complete fresh owner invoices, identities, unique card and DATE metadata.
3. Prepare/commit exact date intent; re-read source/card/effects; assert pending.
4. Attempt one date-only PUT. Full exact-card readback must confirm only that
   field changed. Confirm the date intent durably.
5. Re-read complete source, identity, card and effects after date readback.
6. Prepare/commit stage intent; re-read again; assert pending; attempt one stage
   PUT and verify full readback, including preserved due date and other fields.
7. Confirm stage intent. This does not assert message acceptance or delivery.

Any failure after admission blocks the existing durable writer. A pending or
blocked journal survives restart and prevents automatic retry. There is no
compensating stage/date reset. An already confirmed date may remain populated
when a subsequent source change holds the stage. Operator review owns recovery.
The two provider requests are NOT atomic. Fresh reads reduce, but cannot eliminate,
the race after the final read. The corrected native reminder must independently
apply its fresh payment/current-stage/channel guards before every message.

## Required private deployment policy (not supplied or activated here)

`GHL_RECURRING_DUE_DATE_ENABLED=true` alone grants nothing. Also required:
- Existing `SYNC_ADMISSION_MODE=cron_only`, sync write mode, approval ID, explicit
  card cohort and phone gate when applicable.
- `GHL_RECURRING_DUE_DATE_POLICY` containing `RecurringEffectsPolicy`, and SHA-256
  of the exact bytes in `GHL_RECURRING_DUE_DATE_POLICY_SHA256`.
- Matching approval ID, location, exact pipeline/Sent/Overdue IDs and expiry.
- FULL reviewed workflow ID/location/status/version/updatedAt inventory, hashed
  with the existing `workflowInventoryHash`. Every added, removed, changed or
  truncated workflow response holds. Reminder must be Published; closure Draft.
- Evidence references for the reviewed corrected workflow definitions, complete
  listener inventory, and the one-time same-location/date-field QA showing a
  date-only PUT cannot enroll or send. A successful date readback alone does not
  establish trigger semantics. No fabricated evidence or bare enable boolean.
- Exact opportunity/contact/owner/invoice execution-clearance entries with the
  full source fingerprint, actual review reference, original reviewedAt/expiry,
  no prior current-cycle enrollment and no active old-cycle execution. Expiry is
  at most 15 minutes after review and never auto-renewed. Unknown/later invoice
  cycles are held. Missing or expired clearance cannot be inferred from Sent.

The pinned definition contract requires an exact-opportunity stage-only trigger,
source-due-date-anchored waits, payment/channel guards, no catch-up or retained
execution replay, and no unrelated date listeners. Reusing the existing complete
inventory verifier is the ongoing trusted review boundary; it avoids a new generic
workflow-definition or provider-log API. The policy must be explicitly approved
and installed privately only after the evidence is actually established. This
local patch does not produce or approve that policy.

## Remaining native lifecycle dependency

Before claiming unlimited recurring-cycle coverage, verify the account's native
**Paid -> remove from Fixed reminder flow** cleanup and cycle reset behavior,
including retained waits and later invoices on the same card. Otherwise an old
waiting cycle can overlap a new invoice. The current exact short-lived clearance
is deliberately only a controlled restoration boundary. No new lifecycle engine,
cleanup workflow, closure publication or broad recurring send permission is added.
Coordinate other enrollment writers during the clearance window; the snapshot
cannot prove a concurrent outside enrollment did not happen after review.

## Workflow copy / plan remains Draft

Retain the user's existing corrected reminder copy and source-date day schedule;
this patch does not alter message content, audiences, delivery channels, fees,
closure automation or publication. Review the definition and Day10 09:00 Arizona
anchor before producing the pinned policy. Do not resume/replay existing overdue
executions as part of this transition. Closure remains Draft.

## Local checks

Synthetic provider/DB fixtures only. The new test suite covers ordering and
readback, source payment/change between steps, inventory drift, unknown timeouts,
restart journals, pre-existing date conflicts, multi-invoice holds, inactive
zero-IO behavior, identity/stage/status guards, delayed-sync timing and expiring
execution clearance. Run using installed dependencies:

- `node --import tsx --test tests/ghl-*.test.ts tests/invoice-*.test.ts tests/sync-writer-control.test.ts tests/observed-phone-prefix.test.ts tests/notification-recurring-cron.test.ts`
- `./node_modules/.bin/tsc --noEmit --incremental false`

`tsx --test` CLI's optional local IPC socket is unavailable in this sandbox;
Node's supported `--import tsx` loader runs the same tests without that socket.
