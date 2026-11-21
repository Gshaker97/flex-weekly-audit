# Bounded notification read pacing

Local-only implementation on the diagnostic prerequisite `7f7b97ca56fd1716d1007faf1e0026bf547817f0`, against deployed base `721ac5e1d396fa216e07054571c3aab924f91f81`. This does not activate notifications, publish code, refresh credentials, change eligibility, or retry a send.

## Scope and contract

`JobberReader.query` accepts an explicit `notificationReadRateLimit: true` option with a finite absolute `deadlineAt`. Only notification inventory and its trusted shared source bindings opt in. Other audit callers retain their existing metadata-independent behavior and backoff. The inventory factory passes the **same reader instance** to both inventory and source/identity reads. The source binding explicitly selects three attempts when opted in; it does not override a caller's one-attempt policy inside the transport.

Pacing uses the [documented Jobber cost extension](https://developer.getjobber.com/docs/using_jobbers_api/api_rate_limits/): numeric `requestedQueryCost`, `actualQueryCost`, and `throttleStatus.maximumAvailable`, `currentlyAvailable`, and `restoreRate`. A missing, nonnumeric, nonfinite, negative or inconsistent field holds. Positive requested cost/capacity/restore rate are required. Requested cost above capacity holds as unrecoverable. Successful and throttled responses are both validated; no provider error text, IDs, headers, or response data becomes diagnostic output.

The reader keeps the latest reported bucket and the largest observed requested cost for each exact query text. A known query waits for its requested cost using reported availability and refill rate, crediting elapsed time since metadata receipt and capping availability at the reported maximum. A new query shape has no invented cost. Its first read may throttle, after which the returned cost permits bounded recovery. A shared consumer can still drain the bucket; each new THROTTLED response replaces the bucket observation. No default 10,000/500 bucket, page-count estimate, HTTP 429 inference, or fixed backoff is used for opted-in reads.

Only responses whose GraphQL errors are all exactly `THROTTLED` may retry. HTTP errors (including 429/5xx), authorization/network/timeout errors, mixed GraphQL errors, or unknown metadata hold immediately. A retry uses the same serialized query and variables, including cursor. There are at most three attempts per logical read and at most 75 seconds (the original three 25-second request windows), further clamped to the caller/coordinator and original run deadlines. One-attempt options stay one-attempt. Error-body partial data is never returned.

## Deadlines and invariants

- Token startup still requires 900 seconds of existing coverage. Token validity and absolute deadlines are checked before a wait, at its anticipated wake, after the actual wake, before requests, and after successful responses. There is no refresh or token write.
- Both recurring coordinators pass their original 300-second deadline into inventory and source reads. Source query options carry the original population/request boundary and the earliest applicable 60-second source/contact/cache/count/owner proof expiry. Pacing never renews a proof. Injected source IO is also checked before and after the call.
- The invoice query, all-status enumeration, 25-per-page size, 500-page/12,500-record limits, complete terminal-page requirement, cursor/ID uniqueness, 2 MB response/64 MB total byte limits and source account checks are unchanged. Incomplete inventory still publishes no rows or source capabilities.
- Source/identity failures remain held by their existing callers. A complete inventory does not imply that every later source/history read will fit within 300 seconds. No eligibility, channel, policy, sender, scheduling, reservation, or message behavior is broadened.
- Cross-module failure reporting continues to inspect only allowlisted own data fields. Added cost facts and attempt count must be finite numbers, never booleans, strings, inherited fields or accessors.

## Offline verification

All tests use synthetic credentials, responses, invoice identities and clocks. Production clocks and sleep defaults are unchanged. Coverage includes depleted buckets, documented numeric zero actual cost on throttle, recovery, repeated throttles, shared-consumer drain, shared reader across query shapes, unchanged one-attempt/non-opted policies, malformed/missing metadata, authentication/HTTP/mixed errors, byte bounds, deadline/token failure before and after waits, identical retry bodies, no partial rows, cursor/ID uniqueness, cross-module numeric reporting, and original deployed notification bindings.

A synthetic 165-page/4,125-invoice run exercises the **real original reader and paginator**, all eight source statuses, and a bucket model with 357 requested points, 10,000 capacity and 500 points/second. It completes within the unchanged 300-second deadline without throttles. This is an offline model, not a claim of a successful production inventory.

```sh
node --import tsx --test --test-concurrency=1 tests/*.test.ts tests/*.test.mjs
node node_modules/typescript/bin/tsc --noEmit --incremental false
node node_modules/eslint/bin/eslint.js scripts/source-audit/transport.ts lib/notification-{inventory,source,recurring-coordinator,recurring-day10}.ts tests/notification-{inventory-rate-limit,inventory,source,recurring-coordinator,module-interop}.test.ts tests/notification-inventory-failure.test.mjs --no-eslintrc --config node_modules/eslint-config-next/core-web-vitals.js
git diff --check
```

No provider call, credential read, real database operation, install, production build, publication, deployment, or send is part of this work.

Validated on Node 24.22.1: all 1,599 repository tests passed, TypeScript passed, targeted ESLint passed, and whitespace checks passed. The independent read-only review found no production blocker and separately exercised inventory, shared source, mixed-module, source-audit and Day10 paths. No production Node 22 validation is claimed by these offline checks.
