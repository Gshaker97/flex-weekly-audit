# Unwired, reviewed one-attempt GHL transport candidate

This module is local preparation for a future durable dispatcher. It is **not production authorization or an activated sender**. Nothing imports it from an application route, cron, deployment entry point or existing synthetic dispatcher. Existing production capability flags remain false. No environment variables, default fetch client, credentials, actual provider requests, account changes, migrations, deployment or workflow activation were used to build or test it.

Unlike the inert request descriptor, this module contains a callable POST implementation. **Supplying real credentials, HTTP and database dependencies and invoking it can cause an actual message send.** The false capability fields describe the disabled/unwired rollout state, not a sandbox around arbitrary injected dependencies. Do not invoke it with live inputs until the exact call site, approvals, schema and rollout have been separately reviewed and authorized.

## Explicit review instead of descriptor-only sends

`reviewGhlTransportConstruction` accepts only an original construction result recognized by the contract module's private WeakMap. The narrowly exported `inspectGhlConstructionForTransport` inspection grants no permission and does not expose a bypass path in the transport.

An additional complete review must provide:

- The exact immutable event and account/location/contact/channel/destination/sender/body binding.
- Explicit verification of the pinned API version and proposed `pending` status semantics, with an evidence reference. The current public documentation ambiguity remains unresolved in reality. Synthetic tests asserting verification are not authoritative clarification.
- Sender approval and validation for the exact account/location/channel/sender and write scope.
- Approval of SHA-256 of the **whole serialized request**, including email subject, recipient, sender, body and status, not body alone.
- Explicit one-attempt authorization and approval of the proposed timing for this event, with the same exact request hash.
- Canonical UTC review/expiry timestamps, currently valid and no more than 60 seconds apart.

Missing, false, stale, mismatched or malformed review input produces held with no handle. Status `delivered` or `read` is never fabricated. Review assertions are trusted evidence supplied by the authorized caller: this code does not independently authenticate a reviewer, discover permission, prove sender ownership or resolve the provider's status contract.

The opaque returned handle is frozen and process-local. A raw descriptor, clone, JSON-restored handle or forged object cannot invoke transport. The same construction can produce at most one successful review handle. Its first `attempt` call consumes that handle synchronously before any asynchronous operation, including a call that is disabled or fails early. A module-local logical-event claim also blocks a newly built descriptor for the same account/event in this process. These are conservative local defenses, not durable uniqueness across restarts.

## Mandatory durable-pending boundary

The factory requires the trusted `NotificationLedger` instance and receives its original opaque reservation in `attempt(handle, reservation, finalGate)`. It does not accept a boolean claiming that a ledger operation succeeded. It does not reserve, reclaim, delete, reset or restore a claim.

The caller must already have passed the source/recipient policy gate, created the durable reservation through the reviewed ledger, reread the exact source and current contact/DND, and obtained authenticated fresh final evidence. The transport snapshots that final gate request and requires its full event hash to match the reviewed event and original reservation. It also compares exact body and destination digests.

The transport then owns this ordering:

1. Require explicit factory mode `reviewed-one-attempt`, correct configured account/location/write scope and a current review. The absent/default mode holds.
2. Require exact event/body/destination reservation digests and an eligible final source/recipient gate.
3. Call the trusted ledger's `assertReserved` on the original reservation.
4. Recheck review and gate freshness, then call `markPending` once.
5. Continue only after `markPending` returns true, which the ledger contract defines as successful commit acknowledgment. Failure, timeout, a thrown error or an uncertain acknowledgment cannot lead to POST.
6. Recheck all approval/source/recipient timing and expiry after that acknowledgment and immediately before POST. Expiration consumes the claim without sending and attempts one unknown-outcome write.
7. Invoke the injected HTTP client at most once, then attempt a single ledger outcome write. Acceptance records the exact provider message ID; all other outcomes record unknown. No persistence failure triggers another write or send.

**A future dispatcher must not call `markPending` before invoking this transport.** The existing synthetic dispatcher remains unchanged and is not a compatible live call site. Its separate pending transition would make this candidate hold. This transport's fresh gate checks do not authenticate fabricated evidence or make a source read and external send atomic. A trusted integration still needs the real source/DND readers, final source-to-event comparison, approved templates and claims, history checks, clock discipline, reservation lifecycle and monitoring/reconciliation design.

The ledger and HTTP dependencies are trusted boundaries. Injecting a counterfeit ledger whose methods always return true defeats those assertions; there is no attempt to turn structural TypeScript interfaces into cryptographic database provenance. Any real integration must inject the reviewed factory's original instance and its original handle, never a caller-written success stub. Local tests use the actual ledger factory over a fake transaction adapter, not a fake `pending:true` flag.

## HTTP and uncertainty

The provider origin, path, method and API version are fixed. The request uses only the exact reviewed serialized body, explicit bearer credential, JSON headers, `redirect:'error'` and an AbortSignal. No caller-controlled URL, host, method, alternate payload, scheduled send, retry header or idempotency claim is accepted.

Fixed request and response limits are each 65,536 UTF-8 bytes. Responses require streaming reads, strict UTF-8 and at most 1,024 nonempty chunks. There is no unbounded `text()` fallback. A default 5-second HTTP deadline is configurable between 1 and 30,000 ms. Byte/chunk overflow, invalid JSON/UTF-8, missing/stalled streams, redirects, exceptions, timeout and non-contract acceptance all produce unknown. Each `attempt` makes at most one POST, including HTTP 429 and 5xx. Deadline/abort is not proof the provider canceled or did not execute the request. A late accepted response cannot change an already returned unknown result or cause another outcome write.

These bounds apply to HTTP waiting and response processing. Ledger operations rely on the ledger's separately reviewed database transaction/lock/statement bounds; a deliberately unresponsive injected ledger can stall without making a provider request. The transport cannot forcibly cancel a database commit or equate local timeout with rollback.

A valid provider acceptance is never delivery. If provider acceptance is known but its outcome commit acknowledgment is lost, the overall result remains unknown and includes the acceptance evidence without claiming durable persistence. Returned results never authorize retry and never verify invoice attribution. The durable application record is still necessary because the provider contract has no invoice binding or usable exactly-once/idempotency guarantee.

No credentials, raw response bodies or exception messages are logged. Exact provider diagnostic status/error remains privately accessible through the contract module's audit accessor where parsing succeeded; it is not included in normal serialized results. Preserve those diagnostics under the eventual approved access/retention policy rather than dropping them or presenting them as successful delivery.

## Local verification

```sh
node --import tsx --test tests/notification-ghl-transport.test.ts tests/notification-ghl-contract.test.ts tests/notification-ledger.test.ts tests/notification-gate.test.mjs tests/notification-dispatch.test.mjs
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

The focused suite uses synthetic review evidence, fictional addresses, fake HTTP streams and fake transactions through the real ledger factory. It covers exact SMS/email requests, descriptor/clone rejection, missing approvals, body/destination/sender mismatch, original reservation ownership, pending acknowledgment ordering/loss, concurrency, duplicate handles/events, source/DND gate failures, expiry during commit, unknown acceptance, 429/5xx, timeout with delayed acceptance, stream limits, outcome acknowledgment loss and private error handling.

These tests do not establish real-provider semantics, carrier/email readiness, live permissions, multi-process durable behavior, actual PostgreSQL crash durability or production readiness. The separately planned real-database harness is independent and no ledger/schema changes were made for this transport.
