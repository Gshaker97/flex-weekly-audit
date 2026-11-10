# Disabled/read-only recurring coordinator

This isolated follow-on starts at `3559dfebc9227e7339abb4593e33e5f9ff9364f2`. It does not change the approved production release or its cron. Development and tests use synthetic data only. No runtime bootstrap, provider call, credential retrieval, message, migration, publication or deployment was performed.

## One concrete callable flow

`createRecurringNotificationCoordinator()` is an exact no-op, including dependency getters. `recurringCoordinatorReadiness()` and `scripts/review-recurring-notifications.ts` are inert and enumerate the actual checks and remaining service-policy boundary. They do not initialize Prisma, inspect environment credentials or acquire a runtime.

An authenticated caller can explicitly provide `mode: "read-only"`, a `RecurringNotificationReadScope`, and a runtime factory. This performs:

1. Exhausted unfiltered account invoice-query pagination (API default status scope remains unverified) using the existing no-refresh scanner. Incomplete or over-limit discovery is held, never called an empty complete account.
2. One genuine shared cache/active/archived/quarantine/contact population capability with its original five-minute lifetime.
3. Fresh exact source/owner/cache/quarantine/contact reads for every open, valid discovered invoice, including multiple invoices per owner. Missing source values and unresolved identities remain visible holds. More than 1000 open planner inputs holds the batch without selecting a first subset.
4. The actual planner, with current source-derived dates/status/balance and exact contact-GET tags. Exact `irrigation` selects the existing irrigation branch; verified absence selects maintenance/other. Missing tags do not block common Day10. No new product taxonomy is introduced.
5. Matching Jobber/cache/GHL primary-destination projection from the genuine source handle, independently for SMS and Email. This private projection is not exposed in the report and cannot accept JSON/report clones as capabilities.
6. The actual contact/DND reader for each available primary destination (Version `2021-07-28`), and actual bounded accessible-history plus local SQL-ledger reader (Version `2021-04-15`). Missing channel DND remains held. Global omission semantics are unchanged. No external or local attempt is excluded. Reserved, pending and unknown records are preserved.
7. A redacted report of all invoice ordinals, milestone/category/timing/read holds, prior attempt presence, per-channel source/DND/history observations, unresolved execution inputs, and lossless Angie digest membership. No account, invoice, owner/contact identifiers, destination, amount, invoice dates, message body, token, raw exception or provider payload appears in this report. It is not persisted automatically.

The exact source projection requires agreement with both current primaries. Email-only and phone-only owners remain independently inspectable. An allowed Email DND result is **not** verified Email sending capability; every Email channel report says `email_transport_not_live_verified`. Email is never selected as a fallback.

## Read-only runtime and authority boundary

`bootstrapRecurringNotificationReadRuntime(scope)` is a callable deployment read binding, not startup or a cron hook. It reuses the existing exact deployment/active-hold checks and source-audit `JobberReader`. Existing Jobber auth is read in a read-only transaction; at least 900 seconds must remain. There is no application `jobberGraphQL`, refresh, token save, migration or send. GHL source IO permits only the existing read-only POST `/contacts/search` and exact-contact GET, preserving the source reader’s manual redirect rejection and route/body allowlist. DND/history IO remains GET-only with redirects rejected. History SQL is a fixed SELECT in a read-only transaction. The injected runtime is a trusted application boundary, not protection against a deliberately malicious in-process IO implementation.

The scope names an account/location and current read-review provenance, not an invoice allowlist. `reviewRef`, JSON strings, a mode flag, the omission policy and favorable DND/history checks do not grant authority to send. Standing user authorization can cover a recurring cohort and specified purpose/content; no new manual per-invoice confirmation requirement is imposed here. The missing service policy must bind that authentic authorization to the recipient cohort, milestones, channel/template, truthful effects, explicit sender/native footer and timing/action scope. This component does not manufacture `approved: true` evidence.

The existing send-time runner is deliberately not invoked to turn missing message policy into a successful dry run. It still owns full immutable Event/evidence admission, exact reservation, strictly newer final source/external reread and one-attempt transport. Its v1 pilot code and behavior are unchanged. A recurring adapter must connect its actual v2 source capability and authenticated service policy to that existing runner; the coordinator's report cannot be passed as source or approval evidence. All reports have zero reservations/attempts, `sendCapable: false`, `rolloutReady: false`, and message-policy admission `not_evaluated`.

## Time, capacity and consistency

The output measures actual local batch duration in `durationMs`; synthetic test durations are not production-capacity claims. The coordinator bounds waiting to the earlier of the finite read scope or five minutes, and guards further IO after timeout. The original source batch cannot be renewed inside a run. Each exact source/DND/history observation retains its own shorter freshness; earlier rows that expire before the report are marked held. Rows not processed before the original population expiry remain visible, with `shared_population_expired_no_renewal`. A stalled injected IO can outlive the local wait; the component does not claim it canceled an arbitrary client's socket, but it cannot initiate additional guarded reads after stopping.

The planner's current `[09:00,09:15)` America/Phoenix diagnostic window and no-catch-up behavior remain unchanged. A future reviewed orchestration phase may run after ordinary token availability/refresh and admission, before the existing 10–12-minute cache sync, rather than placing notifications at the end or relaxing the gate. This read-only component neither implements refresh nor changes that production ordering.

Query exhaustion is labeled `exhausted-query-result`, never every account invoice verified. The provider’s unfiltered-query default status scope is unverified. Existing cache-only source omissions remain unresolved: this coordinator does not enumerate all cached invoice IDs, reports their count as null and eligibility as unknown/not evaluated, and cannot silently call them paid/deleted or clear existing unresolved records. Exact selected-owner reads still fail closed if cached invoices are missing from that owner’s source connection. Resolving account-wide cache/source coverage requires an explicit additional adapter/read, not an invented classification.

Inventory pages, population witnesses, exact source reads and history are bounded, non-transactional observations. New activity and changes to another owner can race them. An unknown SMS field is an inspection hold, not an observed opt-out. Unattributed outbound history is an attribution hold, not proof a reminder was sent. Held/incomplete history never proves absence; positive known attempts remain visible. Angie history remains unknown because homeowner-contact history cannot establish internal-notice absence. Email-only source identity remains verified independently of unverified Email transport.

A read-only eligibility observation does not guarantee later admission or reserve contact/day capacity. The final source/identity/DND/history/ledger gate remains required. Prior logical attempts are shown per milestone; homeowner contact/day conflicts and every internal Day21 member are retained rather than silently choosing a winner.

## Actual remaining rollout steps

- Resolve the unverified provider default invoice-query scope and separately enumerate/reconcile existing cache-only source omissions. Do not mark missing invoices paid/deleted or clear their unresolved state.
- Bind authentic standing service policy to the real recurring source capability and existing one-event runner; retain all final immutable binding/dedupe/unknown-no-retry checks. Day10 static original copy needs no invented currency. Do not turn missing conditional facts or tags into a Day10 blocker.
- Keep conditional Day15/20/25/30 copy unapproved until its concrete content/purpose is approved and actual invoice-bound fee/policy/suspension/collections facts are available. Never infer applied actions from dates, labels or copy. Monetary rendering still requires actual currency policy.
- Add genuine sender/footer and exact template/request review at the attempt boundary. Verify Email's actual transport/receipt semantics before claiming it ready, independently of Email DND eligibility.
- Implement Angie daily digest atomic aggregate/member admission, member-preserving unknown outcomes and many-member history correlation; approve its exact digest copy and bind the actual internal recipient. This report does not send a fabricated single-invoice digest.
- Resolve same-homeowner/contact/day collisions through the intended content/orchestration policy. Measure authorized read-only runtime latency and capacity; hold/report work that cannot fit, without automatic retry, expiry renewal or catch-up.
- Separately review publication/deployment and activation of the recurring hook. No notification cron hook or activation is added by this patch, and retired GHL enrollments are not revived.

## Checks

Synthetic integration uses the real inventory, batch source, identity/tag projection, planner, DND and history/ledger implementations with fake IO. It also checks default import inertness (throwing ambient Prisma getter), no message POST/reservation, no automatic retry, complete pagination, held partial source, exact scope, missing DND, email/phone-only cases, prior unknown ledger attempts, unattributed history, stale observations, 09:15 no-catch-up, shared-population expiry, stalled bootstrap, and the read-only/no-refresh deployed bootstrap using a fake database.

Run the focused `tests/notification-recurring-coordinator.test.ts`, all `tests/*.test.ts tests/*.test.mjs`, TypeScript, targeted ESLint and `git diff --check`. No npm build, registry, real provider call or deployment is part of these checks.

## Exact operator command and required private inputs

No command below was run against production. On this candidate checkout, the current callable command is:

```sh
node --import tsx scripts/review-recurring-notifications.ts --read-only /private/recurring-read-scope.json REVIEWED_SHA256 MATCHING_READ_REVIEW_REF
```

Use `--readiness` with the same arguments for bounded local file/schema/hash checks without acquiring credentials or initializing Prisma; no arguments print inert readiness. The separate hash/ref must come from the authenticated operator’s reviewed read request, not be self-approved by arbitrary request JSON. There is no send flag or environment enable switch. The CLI caps regular, non-symlink UTF-8 files at 32 KiB, checks immutable bytes/hash and starts its 330-second hard bound before file IO. Its coordinator retains the earlier scope/five-minute bound. Output contains only the redacted report, and the standalone runtime registers cleanup immediately after Prisma acquisition, drains a failed/late bootstrap under the still-active hard timer, and disconnects exactly once during cleanup.

The private JSON schema is exactly `version: 1`, `accountId`, `locationId`, `reviewRef`, `expiresAt` (canonical UTC), and `identityCoveragePolicy`. That policy contains the same account ID, its real reviewed omission reference/date/expiry, and exactly the two already-reviewed quarantined identities (`jobberClientId`, `email`, `phone`). These are read/identity-coverage inputs, not message approvals. No invoice list, synthetic placeholder approvals, token or customer-message body belongs in this file. Actual authorized values must be supplied privately; this patch does not generate them.

To run this in the deployed app, these later files first need separate publication/deployment approval: they are not included in the already-live 39-file release. Then an authorized operator must provide the current private read scope/hash/reference and the unchanged existing deployment configuration/holds. Existing Jobber auth must still have at least 900 seconds remaining; this path will hold rather than refresh. No scheduler, notification activation, message policy or send authority is needed or created for a read-only inspection. Actual recurring sending remains subject to the concrete rollout steps above.

## Later local Day10 execution binding

The separate `notification-recurring-day10.md` follow-on now implements the genuine v2 source-to-existing-runner path for the original Day10 SMS under an installed standing cohort policy. This read-only coordinator still never sends. Later conditional milestones and Email remain pending independently. The daily Angie digest above was a planning proposal, not a user-approved requirement; actual Day21 internal-user routing and content remain separate work.
