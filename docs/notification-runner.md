# Disabled one-event notification integration

`lib/notification-runner.ts` now joins the existing implementations instead of mocking the seams between them. This is local candidate code, not a live reminder service. There is no production route, cron, environment enable switch, credential loader, database connection, migration, provider call at import, workflow change or rollout. All verification used synthetic data and injected fake IO/network. Capability/readiness flags remain false.

The source scope remains **one explicitly reviewed owner with exactly one original invoice**, including the existing original total/date pins, reviewed omissions and original opaque identity lifetime. This does not solve reminders for all customers or billing cycles. It neither chooses new invoices nor updates a review automatically.

## What executes

`createNotificationRunner()` returns an inert object. `runOne()` is an exact no-op by default, including when `GHL_NOTIFICATIONS_ENABLED=true`. Disabled creation does not inspect dependency getters. Source function imports are deferred until the enabled path after dependency validation, because that older source module transitively initializes legacy production clients. A child-process regression verifies import, disabled run and readiness never touch the ambient Prisma singleton. There are no run-time request arguments, approval booleans, input JSON files or command-line switches that enable it.

Trusted application code can explicitly instantiate `reviewed-one-event-candidate` with all required dependencies. That opt-in is **not authorization** and cannot replace the separate reviews. With real injected clients, that explicit candidate path could perform reads, ledger writes and one POST; only fake clients were used here. It must not be exposed directly as an HTTP request-to-approval adapter.

Each enabled runner is single-use, consumed synchronously before any asynchronous operation. Its sequence is:

1. Call the actual `readNotificationSource`, including actual opaque coverage issuance and exact identity/source checks.
2. Obtain a proposed immutable event/body/sender/construction review from the trusted preparation dependency. Source facts are not synthesized into currency, category, facts or approvals.
3. Read independently trusted external evidence and the real GET-only contact parser. Read the same injected database's local ledger history. Compose source evidence through the opaque source handle.
4. Call actual `refreshNotificationSource` and reread external/contact/history evidence. Require the unchanged real gate to pass both actual preflight snapshots. No database writes occur on an ineligible preflight. Identical source timestamps hold; no delays, invented timestamps or weakened freshness rules manufacture eligibility.
5. Build the exact request with `buildGhlMessageRequest`, obtain a separate explicit transport review, and issue the real opaque transport-review handle. Full event hashes must match, in addition to the transport's exact request/body/destination/sender checks. Recheck preflight freshness after review and before reservation.
6. Reserve using the actual `createNotificationLedger` instance. The runner creates this instance itself and passes that same instance to the actual transport. It does not accept an injected `reserved: true` or fake ledger-success interface. A process-local event fence also prevents a newly created runner from retrying an unacknowledged reservation in this process.
7. **After the acknowledged reservation**, refresh the genuine source handle again and reread independent external evidence, contact/DND and local history. Retain original opaque coverage and unchanged owner proof, with the existing exact-owner reread. Require final evidence strictly newer than the admission snapshot under the unchanged gate.
8. Pass the original reservation, original transport-review handle and exact final gate to `createGhlOneAttemptTransport().attempt`. The transport alone owns final ownership assertion, acknowledged pending transition, boundary freshness check, one POST and one outcome write. The runner never calls `markPending` or `markOutcome` itself.

Accepted means provider acceptance, never delivery or verified provider-side invoice attribution. Unknown/held outcomes never authorize retry. A post-reserve read/validation failure leaves a durable reservation consumed; it is not released, reclaimed, reset or silently marked retryable. A lost reservation acknowledgment may leave a persisted row even when `reservationCreated` is false: that field records only a positively acknowledged claim. `attempted` separately indicates whether the POST boundary was entered.

## Exact history handling

A fixed parameterized SELECT reads the exact account/event key with a bounded result count. No history query mutates a row. The query uses the same database dependency as the ledger factory, and rows outside the exact scope or malformed states hold.

Before final exclusion, the runner calls the real ledger's `assertReserved` on the original in-process reservation. It then requires exactly one returned row with matching ID, reservation token, full event hash, body hash, destination hash and `reserved` state. Only that row is excluded. Missing, foreign, copied, changed, pending or duplicate reservations cannot be treated as owned. The original handle is never exposed to the external evidence/review callbacks.

All external historical records are retained, including a record for the same logical event. The external reader must provide independently verified complete history across existing workflow/manual/provider activity. An empty new local ledger does not establish this. The existing ledger's contact/date uniqueness still governs competing local events. This runner is not a batch scheduler or a replacement for account-wide history/reconciliation.

Combined recipient/history proofs validate original provenance and timestamps first. They use the earliest component observation and expiry; they never promote future, malformed, stale or provenance-free original evidence into a valid proof. Contact-read observation is the actual start of the GET. DND derives solely from the real parser result, not an external caller's `allowed` flag. No channel fallback, guessed channel setting, consent requirement or carrier requirement is introduced.

## Deliberately unwired trust boundaries

The dependency factory must supply authenticated trusted IO, not arbitrary request values. Structural TypeScript interfaces do not authenticate a reviewer, HTTP client, clock or database. These production dependencies and approvals remain outstanding:

- Independent currency and verified category evidence, bound to exact account/invoice/source revision. Unknown category stays unknown. No maintenance inference is added.
- Fresh independently approved recipient identity, template version/body digest, channel/destination authorization, and any applied-fee/suspension/collections facts. The runner does not invent copy, amounts, category, policy or approval. No conditional fee/suspension copy was authorized by these tests.
- Complete external attempt history, including historical workflow and manual messages. Caller-supplied empty lists are not evidence.
- Genuine sender ownership/scope validation, full serialized-request content approval, timing/audience/one-attempt authorization and provider-required status semantics. Synthetic fixtures assert these only to exercise the seam; they do not resolve the real provider contract.
- Separately approved production database migration/adapter provisioning, least-privilege read/send credentials, source read authorization, controlled production dependency composition and live rollout.
- Durable review/history provenance, cross-process/crash operational recovery and authenticated delivery reconciliation/monitoring. The local process fences cannot replace durable records or make separate systems atomic. After restart, an ambiguous operation with no known durable record needs investigation, never automatic retry.

There is intentionally no deployable activation recipe or live CLI. Existing GHL workflows remain Draft, writes remain held, and no production database migration is implied. The source reader and transport retain their existing independent limits. An unresponsive injected source/external/database dependency can stall the runner; the eventual trusted composition must preserve the existing source transport and database timeout contracts. No new unbounded network implementation is added.

## Inert readiness adapter

Run:

```sh
node --import tsx scripts/notification-runner-readiness.ts
```

It prints only the static disabled state, one-invoice scope and outstanding dependency list. It reads no files, credentials, environment settings or accounts and performs no database/network operation. Extra arguments cannot enable sending. It is a dependency inventory, not a live readiness check or approval assertion.

## Local checks

```sh
node --import tsx --test tests/notification-runner.test.ts
node --import tsx --test tests/*.test.ts tests/*.test.mjs
node node_modules/typescript/bin/tsc --noEmit --incremental false
npm run build
```

The focused suite uses the actual source/coverage/identity, gate, contract, contact reader, ledger factory, construction review and transport with fake transaction and streaming HTTP adapters. It checks SMS/email happy paths; no-write preflight; final paid/balance/owner/extra-invoice/DND/history drift; ownership and reservation digests; present channels with omitted status hold; lost commit acknowledgments; provider 429/500; concurrency; single-use and new-runner retry fences; expiry at review/pending; immutable source timing; proof laundering; and disabled/CLI no-op behavior. These tests do not establish real-provider permission/semantics or actual production database execution. Real PostgreSQL validation of the earlier ledger implementation is separate from this fake-IO integration suite.

### Verification for this incremental candidate

- Focused runner suite: 49/49 passed.
- Complete repository suite: 1025/1025 passed.
- TypeScript: passed with `--noEmit --incremental false`.
- Build: **not verified**. `npm run build` completed Prisma client generation and started Next compilation, but execution was rejected because it attempted an external npm-registry connection under the local-only constraint. No build retry or alternate build path was attempted. The prior candidate's successful build is not a build result for this change.
