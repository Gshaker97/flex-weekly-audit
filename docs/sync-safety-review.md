# Focused existing-card sync candidate

Base: deployed `5dd5a6c9f345e5de3c18d59ce5b2c3ffe91a0e34`.
Local branch: `fix/flex-sync-minimal-20261107`.
This is source preparation only. No credentials, provider writes, deployment,
customer messages, fees, contact creation, or card creation/deletion were used.
The earlier six-file phone candidate is incorporated. This document supersedes
its integration and activation details; its matching/API-contract notes remain.

## Correctness fixes

- Removed the legacy absence-based Overdue sweep. A failed update, duplicate,
  unmatched owner, missing source invoice, unknown status, void, bad debt,
  partial read, or zero balance without explicit paid status never implies Paid.
- Both email and phone paths require complete contacts and status=all pipeline
  snapshots, exactly one owner/contact/card, and complete fresh Jobber invoices
  covering every stored invoice ID for that exact Jobber client. New source
  invoices count too. Source data is fetched once per run and reused.
- Only open Sent/Overdue/Paid cards participate. Won/lost/unknown status, Late
  Fee, Closed Out, canceled and every other special stage are held. PUT does
  not include status=open. Unknown source-by-ID results retain cached balances
  for review; they no longer fabricate a void/zero record.
- Preserved the pre-existing groups.has(email) awaiting guard. It was already
  present in production. Plans aggregate all elapsed awaiting debt plus past_due
  debt, so processing future invoices cannot demote an overdue customer.
- Exact US canonical phone matching keeps separate Jobber identities and holds
  duplicates/shared owners. It never creates a contact/card. Email lookup also
  requires a unique exact match; no fuzzy-first or duplicate-error reassignment.
- Old/zero/duplicate cards are not automatically deleted, even if the legacy
  CLEANUP_INVALID_OPPS flag is true. Deletion requires separate individual review.
- Every attempted change re-reads the exact card immediately before PUT. Changed
  owner/status/stage/name/value is held; an already matching target is a no-op.
  A failed/timeout/invalid-response PUT is never compensated or replayed in that
  run and halts all remaining mutations. Mutations do not auto-retry 429.

## Explicit operating modes and side effects

- GHL_INVOICE_WRITE_MODE=paid_only is the default. It permits only fresh,
  verified existing **email** card transitions into Paid. It does not silently
  turn off eligible settled exits. It blocks Sent/Overdue entry, reentry, and
  amount/title refreshes. The ability of a Paid transition to cancel reminders
  must be verified in the actual GHL workflows before activation.
- GHL_INVOICE_WRITE_MODE=review performs no GHL mutations, including Paid exits.
  This is a deliberately chosen read-only audit, not a neutral production pause.
- GHL_INVOICE_WRITE_MODE=sync allows source-verified Sent/Overdue/Paid changes
  on existing ordinary open cards. It must not be enabled until enrollment,
  reentry, and stage-trigger effects are approved and verified. No creation.
- GHL_PHONE_WRITES_ENABLED=true is additionally required for **any** phone-only
  write, including Paid. Its unset/false default leaves new phone support in
  review. It does not affect eligible email Paid exits.
- All modes keep the Jobber/dashboard sync available. Holds and read-only mode
  do not cancel already queued GHL messages. This code does not send messages,
  apply fees, change workflows, create contacts, or merge duplicates, but stage
  changes can trigger existing workflows and their messages/fee assertions.

The current published Overdue workflow permits reentry and multiple
opportunities, and Day 15 asserts a 3% fee has already been applied. That assertion
must be reconciled with an actual approved fee action before new enrollment.
Neither a successful PUT nor this patch verifies queued-message cancellation.

## Per-card review without customer messaging

Run only in an authorized environment with the existing securely configured
credentials:

```
npx tsx scripts/review-ghl-invoices.ts /private/path/ghl-plan.json
```

The script always passes review mode, regardless of environment write flags,
and does not run the dashboard sync. Its JSON records card/contact/source owner
IDs, candidate contact IDs for identity holds, stored invoice coverage, current
stage/status/value/title, proposed stage/value/title when justified, and reason.
The output is private operational/customer data. Do not publish it. Normal
Jobber OAuth refresh can update the existing authentication record even during
read-only review; the script does not change invoices or GHL records.

Two synthetic regression cases represent the currently reported audit gaps:
- Four $180 invoices and three matching GHL phones hold the existing $180 Sent
  card. The code does not guess which contact should own the $720 balance.
- A $98 card in Won/Closed Out is held even if fresh Jobber debt is positive.
  The code does not reopen it or regress the special stage.
These fixtures are not fresh live verification of those customer accounts.

## Unavoidable operational blockers before live writes

1. Snapshot + fresh GET + PUT is **not** an atomic compare-and-swap. Parallel
   web/cron runs or a human change between GET and PUT can still race. No durable
   lock, idempotency key, lease, outbox, or schema migration is introduced.
2. A per-run set and write-halt flag are not cross-run fencing. A timeout may
   have applied. A later fresh matching read avoids a duplicate update, but if
   state changed again or provider reads lag, replay/reentry is still possible.
   Stop the writer after an unconfirmed mutation and inspect the specific card
   and workflow history before resuming. Successful responses are reported as
   GHL-accepted, not proof of downstream effects or exactly-once delivery.
3. Smallest proposed production control: disable new web/HTTP sync admission
   on **both GET and POST**, drain existing background web runs and cron
   processes, then designate only the standalone scheduled cron as GHL writer.
   Disabling only the button is insufficient. No route/UI/control changes were
   made in this patch. Old deployments also need to stop before a cutover.
4. Review the current plan and workflows first, especially duplicate ownership,
   closed/special-stage holds, real fee application, and queued-reminder exits.
   Snapshot completeness is validated against the documented contracts; live
   provider behavior has not been exercised by these synthetic tests.
5. Cache receipt/amountPaid/paidAt and date-only Arizona calculations remain
   separate dashboard/revenue audit work. GHL Paid decisions do not depend on
   those cached inferred payment fields.

A dashboard-only source release can remain separate from this sync patch. A
paid-only rollout still needs approved/verified exit effects and a single writer.
Read-only mode would deliberately suspend eligible exits while queued messages
continue, so it must not be described as a harmless pause.

## Local verification

- 58 deterministic synthetic tests: original 32 phone cases plus 26 legacy,
  mode, explicit-payment, source-completeness, aggregation, special/closed card,
  duplicate identity, pagination, failure/unknown-outcome and no-replay cases.
- Every provider request and database read is mocked in tests; dummy tokens only.
- TypeScript `tsc --noEmit --incremental false`: passed.
- Production `next build`: passed with a cleared environment and unreachable
  dummy DB. Only stale Browserslist-data warnings. Shared Prisma generation was
  deliberately not run; no schema or generated-client changes are required.
- Targeted ESLint using installed Next core-web-vitals config: passed.
- `git diff --check`: passed.
- No schema, migration, dependency, cron route, UI, or deployment changes.
