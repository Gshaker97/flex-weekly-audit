# Notification ledger: local candidate, not deployment approval

**Do not deploy this candidate, apply this migration, or start it against a real database without separate schema review and explicit approval.** The repository's `npm start` runs `prisma migrate deploy` before starting Next.js. Deploying these files can therefore change the database even if notifications remain disabled. This is not a harmless code-only deployment. Neither this ledger nor its tests authorize sending, enabling workflows, changing production data, or migrating a schema.

This candidate adds `lib/notification-ledger.ts`, one Prisma model, and the additive migration `20261109140000_notification_ledger_candidate`. There is no production provider adapter or scheduled sender. Constructing a ledger factory is inert. Operations on the Prisma-backed factory would access the explicitly injected database; no such real database operations were used for this implementation.

## Admission and exact immutable content

The ledger accepts the gate's full immutable `Event` plus the exact body, destination, channel, contact ID, and scheduled date. It snapshots and validates the input before its first asynchronous step:

- The logical event key is recomputed as the JSON array `['notification-v1', accountId, invoiceId, dayPastDue, audience]`. Caller-supplied arbitrary keys are never accepted. Channel, destination, owner, due date, template, and balance deliberately do not create a new logical reminder.
- A SHA-256 event digest covers every event field using bounded, sorted-key canonical JSON. Unsupported JSON values, accessors, cycles, and non-finite numbers are rejected.
- SHA-256 of the exact UTF-8 body must match `event.bodyDigest`. No trimming or rendering is performed before hashing.
- Contact, channel, and destination must exactly equal the event. A separate destination digest binds account, contact, channel, and destination.
- `scheduledOn` must be a real canonical `YYYY-MM-DD` equal to the source due date's Phoenix calendar date plus the milestone day. The existing invoice calendar helper handles raw date-only values and explicit-offset timestamps. No stage-entry date or elapsed wait is substituted.

The database stores the immutable payload, exact body and destination, computed digests, a randomly generated reservation token, and state. These contents contain contact/message information. A production schema review must include access, logging/redaction, retention, backup, and who can read the table. Never log or expose reservation tokens. Raw SQL parameters are bound values; message or identity data is never interpolated into SQL syntax.

Successful `reserve` means one insert transaction committed and its acknowledgment reached the caller. `ON CONFLICT DO NOTHING` handles every uniqueness conflict without reclaiming or returning an existing handle. Database indexes enforce all three domains:

1. Unique canonical text event key.
2. Unique `(accountId, invoiceId, dayPastDue, audience)`, independent of JSON text serialization.
3. Unique `(accountId, contactId, scheduledOn)` across channels, invoices, milestones, and audiences.

The last restriction is intentionally conservative. Several invoices addressed to the same internal recipient collide just like homeowner reminders. The ledger does not invent batching, choose a preferred invoice, switch channels, or send several messages. Distinct contacts that resolve to a shared physical phone number are not deduplicated by this constraint; recipient identity and shared-destination policy remain separate gate/review concerns.

## Public contract and required sequence

`NotificationReservationInput`, `NotificationReservation`, `NotificationLedger`, `NotificationOutcome`, the transaction interfaces, and both factories are exported. Hash helpers are also exported for exact-content checks.

1. Pass the independent gate and obtain a valid immutable synthetic request. Eligibility under the proposed timing model is not production authorization.
2. `reserve(input)` returns `{state: 'reserved', reservation}` or `{state: 'held', reason}`. Held reasons are `invalid_reservation_input`, `already_claimed`, or `ledger_uncertain`.
3. `assertReserved(reservation)` verifies the exact token/digests against a row still in `reserved`. Reread current source, identity, recipient, DND, template, facts, and prior-attempt evidence through the separately trusted reader. Recheck the gate and reservation at the final boundary.
4. `markPending(reservation)` requires a successful assertion and atomically moves `reserved` to `pending`. **Only a true result received after the transaction's commit acknowledgment permits the next synthetic transport step.** The dispatcher also rechecks time and evidence expiry after this commit.
5. Make at most one transport invocation. Record its result once with `markOutcome(reservation, {state: 'accepted', providerMessageId})`, `{state: 'rejected'}`, or `{state: 'unknown'}`.

The same original frozen reservation object must remain in the same ledger instance. A clone, reconstructed object, different instance, forged token, or changed digest is rejected. Never serialize, recover, or restore a handle. The SQL predicates independently require ID, token, all three digests, and the expected previous state.

The application has no release, reset, lease expiration, automatic reclaim, delete, or replay API. A SQL trigger blocks changes to the immutable claim columns and permits only `reserved → pending → accepted/rejected/unknown`. Database constraints enforce valid timestamps/state shape and the provider-ID requirement for acceptance. There is no `delivered` state here, no receipt escalation, and no assertion that provider acceptance proves delivery. Receipt authentication and delivery reconciliation would require separate reviewed work.

The ledger is an admission mechanism, not proof of fresh eligibility. It cannot verify the authenticity of injected evidence readers, database adapters, or provider results. Any future production adapter must implement those trust boundaries and must not substitute this reservation for the gate.

## Failures, uncertainty, and concurrency

- A successful reservation permanently consumes its logical event and contact/day claim, even if later evidence fails before transport. There is no automatic retry after rejection, unknown, pending, reserved, or accepted state.
- The handle is consumed locally before the pending transaction starts. A timeout, error, zero-row update, or lost commit acknowledgment yields false and cannot be retried with that handle. SQL compare-and-set prevents two pending transitions from succeeding.
- A false/error result from `assertReserved` poisons the handle. No later check can revive it.
- An outcome write can be attempted only once. If a provider has accepted but outcome persistence fails, the caller reports uncertainty. The database may still contain `pending`, or may contain the outcome if only its acknowledgment was lost. Neither case permits another send.
- The instance records admission attempts before entering the database, so a failed or ambiguous admission is not retried automatically in that instance. A failed admission cannot prove a row exists: a connection failure can mean rollback or an unacknowledged commit. A later process cannot reconstruct that distinction merely from the exception. If a durable row exists, uniqueness blocks every future admission. If no row exists, no durable negative claim can be guaranteed during the outage. Orchestration must not automatically resubmit an uncertain admission after restart; it needs an explicit reconciliation decision. No recovery/resubmission runner exists in this candidate.
- A process crash after reservation or after pending deliberately strands the durable claim for review. A crash after an accepted provider response does not imply non-delivery. No timer or stale-row cleanup can authorize another attempt.
- A lost acknowledgment is never treated as proof of rollback. Do not wrap this adapter in automatic transaction retry or retry-on-timeout code.

The Prisma adapter uses a 1-second transaction admission maximum, a 5-second interactive transaction timeout, a 1-second PostgreSQL lock timeout, and a 2.5-second statement timeout. Timeout SQL consists of fixed constants. The adapter does not run a manual retry loop or use a client-side `Promise.race` as proof of database cancellation. A failed database acknowledgment remains uncertain regardless of these budgets. Those settings are not a guarantee about every operating-system/network failure's wall-clock return time.

## Local verification and limits

Focused checks use only synthetic data and a serialized fake transaction adapter. They cover exact hashes and schedule binding, event and contact/day conflicts, multiple ledger instances, one pending transition, token/digest changes, poisoned assertions, pending and outcome failures before/after commit acknowledgment, and permanent rejection/unknown/acceptance holds. Integration cases run the real ledger implementation with `exerciseSyntheticNotificationBatch`, a fake database, and a no-network synthetic transport.

Run the local checks without install, code generation, application startup, or database connection:

```sh
node --import tsx --test tests/notification-ledger.test.ts tests/notification-gate.test.mjs tests/notification-dispatch.test.mjs
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

These fake transaction tests and migration source checks **do not prove PostgreSQL behavior**. An independent local PGlite embedded PostgreSQL check passed 15 checks against the final schema, including constraints/triggers, restart, acknowledgment-loss and rollback paths, and alternate JSON serialization rejected by the composite logical-key index. Embedded checks do not establish independent-process concurrency, real-server crash durability, network behavior, or production readiness.

Before any production decision, separately authorize and complete disposable real PostgreSQL checks for:

- Applying the exact migration, Prisma schema parity, rollback/recovery strategy, table and trigger ownership, and least-privilege runtime permissions. The migration deliberately does not alter existing database roles. Privileged direct SQL writers can still delete/truncate records or disable triggers; prevent such use operationally. This API exposes no deletion path.
- Concurrent independent clients racing both logical event uniqueness and same-contact/day conflicts, including alternate JSON spacing, channel/contact/date drift, and shared internal recipients.
- Independent processes trying the same pending transition, lock contention, statement timeout, transaction timeout, connection loss during commit, and confirmed versus ambiguous acknowledgment paths with the actual Prisma/PostgreSQL versions.
- Server/process termination at each boundary: before insert, after commit before acknowledgment, after reservation, after pending commit, before transport, after one simulated acceptance, and before/after outcome commit. Restart must never cause duplicate transport or reclaim a claim.
- Migration-trigger checks for every immutable column, illegal transition, replay, token/digest mismatch, malformed payload, invalid state shape, and accepted-without-provider-ID.
- An explicit operator workflow for review-only unresolved claims. Recovery must not delete/reset a claim or silently retry; a new business decision is not something this ledger can infer.

No server-backed, multi-process crash/concurrency suite or live provider test has been run as part of this implementation. Production rollout remains blocked on those checks, authentic adapters, policy approval, and separate schema/deployment authorization.
