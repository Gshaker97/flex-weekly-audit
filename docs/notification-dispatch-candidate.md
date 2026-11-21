# Disabled notification dispatch integration candidate

**Not a live sender. Do not deploy this candidate as code-only: its additive ledger migration is applied by the existing `npm start` command. Separate schema/rollout review is required even though notification capability is disabled.**

The pure gate, durable SQL ledger, read-only source composition, pinned GHL contracts, and simulated dispatch boundary are integrated and exercised locally. A separate injected one-attempt POST transport candidate now exists, but it has no application wiring, ambient credentials, approved-content adapter, active schedule, webhook, API route or sync hook. Explicitly injecting real credentials, HTTP transport, reviewed evidence and a genuine ledger could send, so its false readiness metadata must not be mistaken for a network prohibition. All tests used synthetic/fake IO; live contract validation is separate. `configuredNotificationCapability` still returns disabled unless explicitly asked to enable; even then it holds because the activated production sender and approval path are not connected. An environment flag alone cannot turn this candidate into a live sender. No real customer identifiers, destinations, message records or secrets belong in this tree.

## What the simulation verifies

`exerciseSyntheticNotificationBatch` accepts only fictional synthetic identities, a reserved fictional destination, exact hashed synthetic body and a fake-transport kind. It cannot be used as the production entry point. These checks are a development guard, not a substitute for trusted transport implementation or authorization.

The ordering is: immutable copy → whole-batch gate → committed unique reservation → ownership check → newer source/recipient/content/fact evidence → gate → final ownership fence → committed pending state → time/expiry check → at most one fake provider attempt → committed accepted/rejected/unknown outcome. Acceptance is never called delivery. A timeout or lost database acknowledgment never produces an automatic retry.

A reservation is consumed even when a later pre-send check fails. Reserved, pending and unknown rows are not automatically reclaimed, including after process restart. This sacrifices an uncertain or stale reminder rather than risk an unauthorized/duplicate message. An operational hold report and reviewed resolution procedure are still required before activation; this candidate does not silently retry or manufacture delivery evidence.

Batch conflicts and database contact/day uniqueness prevent simultaneous invoice messages to one contact. They also hold collisions involving the shared internal recipient. This is a conservative limit, not an approved daily summary or message-prioritization policy. Channel, owner, due-date or template changes do not create a second event identity.

The fake reader's attempt evidence excludes only the exact owned current reservation. A real reader must prove that exclusion against the durable ledger and retain every other attempt and reconciled historical message. A caller-provided boolean is not source, authorization or ownership proof. No real adapter is supplied here.

## Timing and factual limits

The existing due-date calendar helper is unchanged: actual Jobber issued/due dates, Arizona calendar days, next day after due as late day one, maintenance and irrigation milestones. The target time is 09:00 Arizona. The gate's `[09:00,09:15)` tolerance and 60-second source/recipient/DND proof age are **proposed values**, not activation approval. An unchanged opaque identity proof may retain its original observation time for less than the existing five-minute maximum, with an exact final owner/invoice reread and current cache/contact collision checks. Its timestamp and expiry are never extended. Both proposal flags remain false.

Original late-fee/suspension assertions require evidence or separately approved revised copy. No fee, suspension or collections action is implemented. Email is not an automatic SMS fallback. Unknown category may support only common Day 10/15/internal 21 timing, subject to every other gate; maintenance-only milestones require verified category.

## Real integration still required

1. Validate the supplied read-only Jobber/owner and GET-only GHL adapters against authorized live records. Complete the separate currency/category, approved-content, sender, internal recipient and historical-attempt evidence bindings. Unknown metadata remains held; no caller boolean alone proves authority. Complete pagination, policy expiry and unavailable evidence hold the individual send.
2. Explicit validated GHL sender and transport-contract verification, followed by separately reviewed application wiring of the injected one-attempt transport. It owns the acknowledged pending transition and must not be invoked after another dispatcher has already marked pending. Provider acceptance, individual message IDs and later delivery statuses must be independently bound to the event. There is no assumed provider idempotency key, invoice binding or exactly-once delivery guarantee.
3. Real multi-session PostgreSQL uniqueness, lock-contention and killed-process tests against this exact migration and adapter. Embedded PostgreSQL tests verify SQL/trigger behavior but not independent server sessions or power-loss durability.
4. Migration/release approval and verified rollout/rollback procedure. Rollback must not drop message history or reset pending claims. Existing native invoice workflows remain disabled; their retained histories must not be bulk-resumed as a migration mechanism.
5. The exact first cohort, templates, operational timing/freshness limits and any synthetic real-channel test approved before customer sends. Current production admission/schedules and GHL holds stay unchanged.

A source read and an external message send cannot be atomic across providers. Fresh evidence and short dispatch intervals reduce that residual race; they do not eliminate it. No claim of perfect delivery or payment synchronization is made.
