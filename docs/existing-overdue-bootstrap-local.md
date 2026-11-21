# Existing Overdue bootstrap: local candidate

The local adapter is integrated; no activation, publication, provider call, deployment, or customer data is included. The helper is disabled unless its caller passes enabled:true; this flag alone is NOT authorization. Native skip-route runtime proof does not establish the real Draft route has been patched. Production admission must remain off until reviewed definitions are actually present.

## Integration contract

`bootstrapExistingOverdue({enabled, adapter})` executes the bounded stage/date/stage sequence through an injected adapter. The exported BootstrapAdapter interface is the implementation boundary. The sync writer now retains a dedicated bootstrap claim/phase, never masquerading as paid reset_stage. Existing recurring helper must not be called unchanged for late cycles because it holds past Day10.

- Outer caller must enforce existing sync-only/cron-only, approved-card, location, phone ownership, and feature gates before enabling. No HTTP route or contact-wide enrollment.
- readFresh must use branded verified identity snapshots and revalidate actual 5-minute identity coverage lifetime at each boundary. The helper's source/card/effects/history ceiling of 15 minutes DOES NOT extend identity coverage. No caller-produced identity booleans alone qualify as a production adapter.
- `unchangedCardFieldsSha256` is a fresh canonical hash of the full opportunity, excluding only the stage and this exact due-date field. It includes name, other custom fields, status, balance, contact, pipeline, and location. No unrelated card drift is allowed. The designated date is separately checked through field metadata/readback.
- Read complete durable local journal history. Exact cohort review records no prior current-cycle enrollment/no active old cycle and the known automated writer inventory. No supported fresh provider execution-log reader is assumed. Later manual/external enrollment remains an explicitly reviewed operating risk.
- claimOnce atomically acquires immutable ownership under the sync admission lock. Key is location+workflow+source owner+invoice; date/fingerprint/card changes cannot mint a second attempt. Refuse any prior bootstrap/enrollment attempt, including pending, confirmed, or unknown; do not reset after failure. Store whole claim/digest durably.
- readFresh(ownClaimId) excludes ONLY that exact durable claim and its writes from history returned to the planner. assertClaim must verify stored digest, exclusive ownership, and no conflicting attempts. Never exclude all rows for the invoice/contact.
- prepare atomically journals one pending exact step before provider invocation, asserts claim ordering, and returns a durable attempt ID. assertPending verifies its pending state. write uses the actual exact opportunity ID; do not use contact-only workflow enrollment API. confirm stores exact provider readback. Unknown writes and lost claim acknowledgments block admission; do not retry automatically.
- Optional date write is skipped only if freshly aligned. Stage writes remain Overdue→Sent then Sent→Overdue. Verify Sent transition cannot send/enroll; date-only update cannot send/enroll; source-date anchored native skips advance past elapsed/due-now milestones; future steps retain the explicitly reviewed payment timing, native channel and message-fact guards. Source due date is never replaced with today.
- Retired executions stay retired, history retained. Closed/shared/multi-invoice/conflicting cards remain held.

## Clearance lifetime

Default absence of clearanceMode retains the 15-minute reviewedAt/expiry limit. New explicit `clearanceMode: historical_review_v1` permits historical execution review older than 15 minutes only through its explicitly reviewed expiry, bounded by effect-policy expiry. It is pinned in immutable claim digest; no conversion/renewal occurs automatically. All source/card/effects/history observations remain fresh, actual identity authorization remains 5 minutes, and every mutation rereads current evidence. Do not reinterpret existing approvals as this new mode.

## Verification

41 synthetic tests: successful three journaled writes; disabled no-read behavior; unknown outcomes at every step; lost claim ack; expiry after first write; payment after pending admission; drift; exact cohort/fingerprint/key; prior bootstrap/enroll even on another card; protected/shared/multi-invoice/conflicting cards; native policy/history holds; historical-review opt-in and expiry/freshness separation. Focused TypeScript checking passes. Use node --import <existing node_modules>/tsx/dist/loader.mjs --test tests/ghl-existing-overdue-bootstrap.test.ts (tsx CLI IPC socket is unavailable in this sandbox).

Production adapter note: source reader currently returns category:null. Each cohort review therefore supplies category and categoryReviewRef for that exact invoice, both immutable in claim digest. A non-null contradictory source category holds. This classification does not mutate the source fingerprint or infer a category from contact/card names. The adapter retains the original branded snapshot out-of-band and validates it immediately within write after assertPending; structured plain planner clones confer no identity authority.

## Integrated local adapter

The follow-on integrated candidate now calls syncExistingOverdueBootstrap from
the actual sync hook after normal review/mode/phone/cohort/identity/card gates.
The adapter uses real complete readiness readers, exact pinned workflow metadata,
the existing durable writer and exact stage/date transports. It retains the
original branded identity validator outside planner clones and checks it after
the last journal await immediately before each mutation. Source, card and
workflow metadata are reread at each boundary; no write is retried.

A distinct immutable bootstrap claim and exact linked phases live in the existing
private journal. Enrollment is also recorded as ordinary invoice-cycle ownership
for later Paid/reset handling. Any prior claim or enrollment for the same stable
location/workflow/owner/invoice prevents replay even after mutable dates/balances
change. The controlled sequence is Overdue to Sent, blank-only source date when
needed, then Overdue. It does not recreate cards, reset source dates or send
elapsed milestones.

The production-facing wrapper uses complete retained journal history, NOT an
invented provider execution-log API. The exact initial cohort review and
exclusiveCycleWriterReviewRef cover the known automated writer/entry inventory.
Future manual/external enrollment is an explicitly reviewed residual risk, not a
claim of universal prevention. No activeWorkflows index-negative gate is added.
The optional historical_review_v1 is a separately approved exact-cycle review
within pinned policy expiry, never an automatic conversion or renewal of the
older 15-minute mode. Fresh identity coverage remains limited to five minutes.

When source category is null, the exact reviewed category/categoryReviewRef can
pin the actual native irrigation-tag branch rather than claim source invoice
classification. Later tag edits are an external configuration risk; a non-null
contradictory source category still holds.

All flags/configuration remain absent by default. Actual live workflow/version,
skip route, fact guards, native stage/value and suppression checks require the
reviewed activation decision. No actual policy values were supplied.

## Reviewed retired current-cycle history

Default/explicit `enrollmentHistory.kind: no_prior` still requires noPriorCurrentCycleEnrollment:true. It must not be asserted for contacts with retired current-cycle waits.

An explicitly reviewed `retired_reviewed` variant permits those historical waits without claiming unavailable old execution→invoice identifiers. The outer cohort freshly binds the exact current invoice, owner, contact and card. Review must list exact retired execution IDs for that contact, retirementEvidenceRef and historyEvidenceRef, and confirm all retained Fixed executions for the contact were retired with no active retained execution. Complete contact message/action history must cover the current invoice issue date onward (`historySinceIssuedOn` must equal its source issue calendar date). Any relevant ambiguous action holds. No actual cohort review is populated by this code.

Review includes the exact category milestone set with `priorAttempt` none/attempted/unknown per day and audience. A known past attempt can remain skipped by native dates. Any attempted future milestone, any unknown history state, omitted/duplicate milestone, wrong audience, incomplete retirement/history, or ambiguous action holds. This is conservative contact-history clearance, not fabricated retrospective invoice attribution.

The entire enrollmentHistory object is pinned inside the immutable claim digest. Retirement clearance does not waive any local prior enrollment/bootstrap attempt, extend identity coverage, change timing/routes, infer category, or grant arbitrary contact enrollment. The reviewed automated-writer inventory and residual manual/external enrollment risk contract still apply.
