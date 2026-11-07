# Reviewed writer admission and durable GHL intent candidate

Local preparation only. This add-on starts from integrated tree
`91bab58ada3ffa223e582710d60955af1bc85028` and retains the now-live invoice-evidence
supplement from dashboard tree `0296f30658288c86a8dc5110987b70f198300a22` unchanged.
No production database writes, provider requests, settings, deployment, workflow
changes, fees or customer messages were performed by this implementation task.
No schema, migration, dependency or persistent credential is added.

## Admission and manual sync

`SYNC_ADMISSION_MODE=cron_only` rejects both GET and POST `/api/sync/run` before
any database/provider work, including requests carrying a cron secret. Only the
standalone script passes the `standalone_cron` entrypoint. The existing manual
button displays the returned cron-only explanation and does not begin polling.
The unset mode is `mixed`, retaining HTTP availability, but every new-version
entrypoint still uses the same durable admission barrier. An invalid mode rejects
admission. This is not authentication; the separate login/security work remains
out of scope, and old code must be stopped during cutover.

A short PostgreSQL transaction acquires a transaction-scoped advisory lock,
checks for any running/blocked SyncRun and creates one running row. It uses
ReadCommitted isolation so the check after lock acquisition sees prior commits.
The row, not a long-lived connection, owns the whole run. There is no TTL, stale
run takeover or automatic recovery. Concurrent new-version cron/web requests
cannot pass the check-create section together. An admission commit whose reply
is lost can leave a running row and safely blocks the next attempt.

All started batch operations and both heavy feeds drain before a normal failed
run can release admission. A process crash leaves the row running indefinitely.
Old deployments, manual database changes and other tools do not obey this
application protocol and must be excluded operationally.

## Durable GHL intent

Write-mode reconciliation requires an admitted writer, the appropriate existing
write mode/phone gate, a valid `GHL_WRITE_APPROVAL_ID`, and the card in
`GHL_APPROVED_OPPORTUNITY_IDS`. The latter is an explicit JSON array of unique,
nonblank opportunity IDs, bounded to 500 entries to reject malformed/unbounded
configuration. This is a resource bound, not a recommended first-run cohort.
Unset/malformed configuration withholds all GHL writes, including Paid exits.
The chosen list and release ID must be part of deployment approval.

Immediately before each PUT, a short transaction commits a versioned journal in
the admitted SyncRun.errorMessage. The pending entry contains the release ID,
card/contact/pipeline/source-owner IDs, expected and target stage and integer-cent
amount, effective title hashes, exact stored invoice coverage, and fresh source
invoice IDs/statuses/cent amounts/dates with observation time. A fingerprint
protects the captured intent from unnoticed changes. Title text and contact
addresses/numbers are not stored in the journal. Prior source warnings are kept.

The writer rechecks the pending entry, performs one PUT, and reads the exact card
back. ID, owner, pipeline, open status, target stage/value and effective name must
match before a second short transaction records confirmation. A successful PUT
or matching readback does not prove downstream delivery, cancellation or fee
application. No idempotency guarantee is claimed for the remote provider.

Every transaction requests `synchronous_commit=on`; the database must also have
working durable storage/fsync. No HTTP call occurs inside a rollbackable database
transaction. The committed pending entry therefore survives crashes, network
errors and later transaction rollback. Unknown response, readback mismatch,
prepare/confirmation acknowledgment loss or local persistence uncertainty
blocks the writer. If marking blocked itself fails, the original running row and
pending journal still block later admission. No later cron auto-clears the hold,
even if a fresh card happens to match the expected or target state.

Finalize and catch paths retain every journal entry and refuse to complete/fail
a pending or blocked run. A truly committed complete finalization with all
entries confirmed remains complete if its response is subsequently lost; there
is no unresolved provider effect in that specific case. Public status responses,
run return values and the overdue dashboard redact journal contents. Normal
logging/reporting never receives the journal. No reset/unlock endpoint or
automatic journal deletion is included.

## Identity guard scope

Mutation planning now checks GHL primary/secondary email-phone collisions and
selected identifiers belonging to another Jobber customer, including email-bearing
owners. Malformed GHL identity fields hold the complete preflight. Before an
otherwise permitted write, a separate unfiltered Jobber client connection reads
all returned primary/secondary emails and phones with strict pagination. Missing
cached owners, missing/ambiguous fields, changed primary identities and competing
fresh secondary ownership hold writes. Incremental cached identities alone can
no longer authorize a new phone-based write. Snapshots are still not atomic;
source/provider scope and behavior must be verified before activation.

## Exact controlled release actions requiring approval

1. Select the reviewed code/artifact, current per-card plan and explicit release
   ID/card allowlist. Verify any Paid-trigger workflow and actual queued-reminder
   exit behavior first. Do not silently move every structurally eligible Paid
   card in one unreviewed first run.
2. Stop new HTTP admission on both verbs and stop/drain old web and standalone
   cron processes. Install the reviewed code on both services, with
   `SYNC_ADMISSION_MODE=cron_only`. No old process may bypass this protocol.
3. Inspect existing running/blocked records. Confirm the owner process is dead
   and reconcile each recorded intent against provider/workflow history before
   any individually approved recovery. An old/target matching read alone does
   not prove whether a timed-out mutation occurred. There is no automatic reset.
4. Designate the standalone cron as the only writer. First release may explicitly
   choose `GHL_INVOICE_WRITE_MODE=paid_only`, phone writes unset/false, the approved
   release ID/card list, and `JOBBER_OPEN_STATUS_REFRESH_ENABLED=true` if that
   status correction is separately included in the approval. Otherwise leave
   status refresh off. No code or test result authorizes these settings by itself.
5. Approve the first run and inspect outcomes before expanding the list or
   permitting Sent/Overdue entry. Paid-only intentionally stops new non-Paid
   transitions; review mode or an empty list additionally withholds Paid exits.
   Existing queued messages continue unless verified workflow behavior cancels
   them. This is not a neutral pause. A durable block also stops later cache
   syncs until reviewed, trading availability for prevention of unsafe replay.

A fresh operator/source change can still race a provider GET/PUT. This candidate
is not cross-service atomicity, a provider compare-and-swap or an exactly-once
workflow guarantee. Recovery while an old process is still alive is unsafe.

## Verification

The full local test suite uses synthetic fixtures and mocked providers/database
reads, with a cleared environment and unreachable dummy database. It covers
non-expiring admission, lost commit acknowledgments, immutable journal survival,
public redaction, both HTTP verbs, batch-drain ordering, explicit allowlists,
primary/secondary identity conflicts and post-PUT readback mismatches. Full
TypeScript, repository-wide ESLint and production Next build are also required.
A separate approved isolated PostgreSQL/Prisma test harness exercises the core
admission/journal module with stub providers; its exact tested module hash and
results must accompany release review. Production behavior remains unexercised.
