# Shared GHL source monetary validation

Local-only incremental fix on the reviewed status-refresh candidate: deployed
base `5dd5a6c9f345e5de3c18d59ce5b2c3ffe91a0e34`, then
`flex-sync-minimal.patch`, then `flex-open-invoice-status-refresh.patch`.
The isolated reviewed baseline is local commit
`a5ef7a5` (the unchanged prior source was `4d28e8d` plus status refresh).
No live APIs, credentials, cache writes, deployment, environment changes, GHL
mutations or customer messages were used for this work.

## Defect and narrow correction

`phoneSourcePlan` is shared by email and phone reconciliation despite its name.
Previously it accepted, for example, total 100 / balance 150, sub-cent amounts,
and monetary values beyond safe integer cents. The status-refresh planner held
those source rows, but that informational hold did not prevent the separate GHL
planner from constructing a card update. Default `paid_only` blocked non-Paid
updates, hiding the debt case unless `sync` mode was selected. Invalid totals
could also pass the Paid shortcut when the balance was explicitly zero.

The shared GHL planner now:

- Requires both total and balance to be explicitly numeric, finite,
  nonnegative, exactly representable as safe integer cents, and balance <= total.
  Null, missing, strings, NaN, infinities, negative, over-total, unsafe and sub-cent
  values hold the entire source owner. No coercion or source amount rounding.
- Uses a cent-to-dollar round trip rather than a fixed epsilon, so ordinary
  values such as 0.29 and 19.99 work without accepting near-cent source values.
- Validates money before the explicit `paid` + zero balance shortcut. Valid
  historical/zero-total Paid rows remain eligible. Zero alone, unknown status,
  void, partial source coverage and contradictory Paid balances still hold.
- Aggregates each Sent/Overdue group in integer cents, rejects unsafe sums or
  sums that would lose a cent converting back to dollars, and converts only at
  the output boundary. Existing overdue precedence is unchanged.
- Returns null for an invalid owner plan. Existing reconciliation reports a
  hold before proposing a destination or reading/PUTting an individual card.
  Both email and separately gated phone paths use this check, even in explicit
  `GHL_INVOICE_WRITE_MODE=sync`. No schema, dependency or matching redesign.

## Hold scope and remaining release blockers

This adds a money fence inside GHL planning; it does **not** turn every
status-refresh hold into a global downstream fence. For example, changed but
valid source amounts can still cause a status-refresh hold while a separate
fresh GHL source plan is valid. A held owner does not automatically prevent
unrelated valid owners from being processed. Holds do not cancel queued messages.

The status-refresh flag must remain unset/false under dashboard-only approval.
No sync/GHL/cron activation is authorized by this local fix. The prerequisite
release blockers remain: explicitly approve and verify workflow entry/reentry,
Paid exit/queued-reminder cancellation and fee assertions; review current
source/ownership/card plans; stop old writers and drain both web sync admission
routes and in-flight cron/web processes; establish a single writer. Provider
snapshots and GET/PUT are not atomic, no durable cross-run fencing is added, and
unconfirmed writes still require operator review before resuming. Real provider
contract and database transaction integration checks remain pre-release work.

## Local verification

All test provider calls and database reads are mocked, with dummy tokens and a
cleared environment. No real credentials or reachable database were used.

- Added direct monetary boundary tests and mocked email/phone sync tests,
  including explicit sync-mode rejection, Paid-only rejection for invalid
  totals, valid decimal aggregation, overflow, precision loss and invalid
  uncached siblings. The new tests reproduce failures on the reviewed baseline.
- `node --import tsx --test tests/*.test.ts`: 132/132 passing.
- `tsc --noEmit --incremental false`: passing.
- Targeted ESLint with `next/core-web-vitals`: passing.
- Production `next build`: passing with cleared environment, telemetry disabled
  and unreachable dummy database. Shared Prisma generation was not rerun.
- `git diff --check`: passing.
