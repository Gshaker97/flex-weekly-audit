# Open invoice status refresh candidate

Local-only preparation. Not deployed or enabled. No live APIs, database writes,
GHL actions, customer messages, configuration changes, or workflow edits were
performed during development or verification.

## Evidence and confidence

A private read-only audit shortly after an ordinary hourly sync found source
invoices marked `past_due` while the cache still said `awaiting_payment`, with
other compared fields matching. Exact invoice identities, amounts, snapshot
counts, and source evidence are retained privately outside the repository.
Cache-only records were also observed; absence is not evidence of deletion,
payment, or void status. Connection default status coverage is unverified and
snapshots are not atomic. Publishable test identities and amounts are synthetic.

Code confirms that normal invoice fetches filter by `updatedAt` with a 24-hour
overlap, while the former by-ID reconciliation fetched only `id`. Thus it could
check visibility but could never refresh an unchanged-record status transition.
This is a verified mechanism for missing time-driven statuses, consistent with
the observed status-only discrepancies. The audit did not fetch source `updatedAt`,
so it does not prove exactly when Jobber changed status or whether Jobber failed
to advance that timestamp. The fix does not rely on that assumption.

## Patch dependency and scope

Apply this distinct add-on **after** `flex-sync-minimal.patch` on deployed base
`5dd5a6c9f345e5de3c18d59ce5b2c3ffe91a0e34`. That prior patch removes absence-based
void/$0 mutations and replaces unsafe legacy GHL logic. This add-on does not
replace or edit its phone matching, GHL policies, deletion check, or tests.
It adds one gated call in `runFullSync`, one status reader/planner/writer, and
focused tests. No schema, dependency, migration, cron, route, or UI change.

This is deliberately a **status-only** correction:

- Every cached `awaiting_payment`/`past_due` ID is checked individually, including
  old invoices, unknown issue dates, and zero/negative cached balances. No
  updatedAt or issue-date restriction and no invoice-list default filtering.
- By-ID aliases are batched at 25 with explicit IDs, status, total, balance, and
  source owner. Every requested alias must be present and match the requested ID.
  HTTP/GraphQL errors, missing aliases, wrong IDs, malformed data envelopes, and
  later-batch failures abort before any refresh transaction begins.
- A returned null object is an invoice-specific hold, never void, paid, or zero.
  Unknown status/owner/money, negative credit, inconsistent paid-positive or
  open-zero balances, and amounts changed since cache are also holds. A held old
  invoice does not starve otherwise valid status-only corrections.
- Only explicit recognized source status is copied, never inferred from date or
  balance. Monetary values must be known, finite cent amounts and must match
  cache. Matching source/cache owners are required. Matching current status is
  a no-op. The regression fixture uses five synthetic identities and invented
  amounts to exercise the same status-only mismatch.
- Changed monetary data is left for the existing/full invoice sync, not partially
  copied. This add-on does not repair that sync's separate receipt inference or
  null-to-zero problems and does not claim to do so.
- Update data is **only invoiceStatus**. It does not invent or alter amountPaid,
  paidAt, amounts, dates, or owner. It leaves lastSyncedAt unchanged because the
  whole invoice row was not refreshed.
- Updates run in one Serializable Prisma transaction with exact snapshot guards
  on local/source ID, current status, amounts, owner, and lastSyncedAt. An update
  count other than one rolls back the complete status correction. No retry.
- Refresh happens before aggregate recomputation and GHL. Read/transaction
  exceptions fail the run before GHL, rather than continuing after a partial
  refresh. Previously started jobs/visits and ordinary incremental upserts are
  outside this narrow transaction and may already have completed.

## Activation hold and smallest safe release boundary

`JOBBER_OPEN_STATUS_REFRESH_ENABLED` must equal the literal `true` to do anything.
Unset/false means no cache read, source read, or status correction from this
module. **Keep it unset/false under the current dashboard-only authorization.**

A live cache-only correction is not safely isolated with the legacy writer
running: next hourly sync reads the same InvoiceRecord statuses and may create,
move, or enroll GHL cards. Not calling GHL in the correcting process is not enough.
The existing code also has an awaiting-payment path that may already treat elapsed
invoices as overdue, so the exact net effect on affected invoices requires fresh per-card
review. There is no guarantee that changing shared statuses has no side effects.

Smallest proposed controlled release, requiring separate approval:

1. Stop new web/HTTP sync admission on BOTH GET and POST and drain in-flight web
   syncs and old standalone cron processes. A disabled button alone is not enough.
2. Install the prerequisite safety writer and choose its explicit GHL write mode
   after reviewing current per-card plans, stage-trigger/reentry behavior, fees,
   and exit/queued-message cancellation. Do not treat default `paid_only` as
   automatic authorization. `review` blocks all new GHL mutations, including Paid
   exits, but leaves already queued reminders running; it is not a neutral pause.
3. Designate one writer and verify no old deployment/process can still execute
   the legacy path. No broader persistence architecture is needed for this narrow
   patch, but this operational single-writer boundary is not implemented here.
4. Re-read source/cached differences and relevant GHL cards; then enable status
   refresh only within the approved cutover. Review counts/holds and ordinary
   paid exits before authorizing new Sent/Overdue entry.

Neither this patch nor the prerequisite implements cross-service atomicity,
provider compare-and-swap, durable writer fencing, or cancellation of queued
messages. Source can change after a read; the by-ID batch sequence is not an
atomic Jobber snapshot. Cache transaction guards protect intervening cache writes,
not arbitrary source/GHL changes. Do not activate until those release risks and
message policy are reviewed.

## Local verification

Run with a cleared environment and unreachable dummy database; all provider and
database operations in tests are mocked. No real credentials are needed.

- `node --import tsx --test tests/*.test.ts`: 98/98 passing (40 new, 58 prerequisite).
- `tsc --noEmit --incremental false`: passing.
- Targeted ESLint (Next core-web-vitals): passing.
- Production `next build`: passing with cleared environment and unreachable dummy
  DB; only stale Browserslist warnings. Shared Prisma generation was not rerun.
- `git diff --check`: passing.
- Transaction rollback is exercised with a mocked transaction, not live Postgres.
  The Prisma update filters/Serializable option typecheck against the generated
  client. A real transaction integration test remains a pre-release check.
- `tsx --test` CLI initially hit a local IPC socket permission error; the supported
  Node `--import tsx --test` entrypoint ran without needing that CLI socket.
