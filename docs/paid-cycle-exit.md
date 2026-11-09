# Exact single-invoice Paid exit (disabled by default)

This operation is separate from generic stage sync. It can change only one reviewed open card's stage to Invoice Paid and its monetary value to zero. It cannot enroll a contact, send a message, change a name/status/date, reopen a closed card, or enroll a later invoice cycle.

## Evidence and scope

A request pins the entire reviewed workflow inventory and its hash, account coverage policy, location, pipeline, Jobber client, GHL contact, opportunity and invoice IDs; original invoice total/issued/due fields; original card stage/amount/name hash; approval ID and expiry. There must still be exactly one source invoice and one stored invoice for this owner, both the approved invoice. Even an additional already-paid invoice holds this deliberately narrow pilot.

Every readiness read first compares the entire returned workflow inventory against sorted reviewed entries containing only ID, location, status, version and update time. Missing, added, changed, duplicate or malformed entries, wrong locations, and explicit pagination/truncation indicators hold. Workflow names are excluded. This Flex operation requires at least two workflows, and statuses must be exactly draft or published. Reviewed statuses are compared exactly; recording a published status never authorizes publishing anything.

Every readiness read obtains fresh explicit active and archived Jobber identities, verifies account ID on every identity page, exact-null quarantine lookups, exact selected owner/invoice, fresh zero-linked-job/invoice counts and all existing cross-field identity conflicts. Complete owner-invoice pagination independently checks the expected account on every page. Generic callers remain strict and receive no exception.

The provider's `paid` invoice status with zero balance is evidence of source settlement or closure. It is not evidence that a bank receipt or cash payment occurred; manual closure/write-off may also stop collection. Refunded/void/unknown statuses, contradictory amounts and missing evidence hold. The operation does not inspect refund transactions.

Readiness states:
- `currently_unpaid`: current source/identity/card checks support the future exit path under the current policy. No settlement or send authorization is implied.
- `paid_exit_candidate`: source is paid/zero; an exact Paid/zero card update is eligible for the existing writer checks. No mutation occurred in readiness, and closed write gates may still prevent execution.
- `already_paid_zero`: all fresh guards passed and card already has both Paid stage and zero value.
- `held`: no eligibility claim.

A Paid-stage card with nonzero value is not considered unchanged. It must satisfy the approved original amount and undergo the same fenced zeroing operation.

## Private read-only review

`node --import tsx scripts/review-paid-cycle.ts private-request.json expected-sha256 private-report.json`

The input's exact bytes must match the supplied SHA. A proposed approval ID in the request still needs valid syntax, but it need not be configured for read-only review. This script does not acquire a writer and never performs a mutation. Existing process configuration must identify the same location. Read-only source assessment does not require a real approval ID, approved-card cohort, enable flag or open phone gate. The report includes actual writeGates and phoneOnly values; closed gates are reported honestly rather than filled with synthetic settings. Actual mutation independently requires every gate, including the phone gate for a phone-only owner. Snapshot gate flags are descriptive and cannot grant authority. Held reports include sanitized actionable codes for workflow drift, account/identity coverage, quarantine changes and collisions. Unknown provider errors are reduced to a safe fallback rather than serialized. Reports are created with mode 0600 and exclusive creation; raw contact/source records are not included.

## Configuration required for a separately authorized release

No settings are enabled by this patch. The admitted cron operation requires:
- `SYNC_ADMISSION_MODE=cron_only` and standalone-cron entrypoint.
- `GHL_INVOICE_WRITE_MODE=review` so ordinary stage reconciliation remains held.
- `GHL_PAID_CYCLE_ENABLED=true` (unset is a no-op).
- `GHL_PAID_CYCLE_REQUEST`: the exact reviewed JSON below.
- `GHL_PAID_CYCLE_REQUEST_SHA256`: SHA-256 of those exact UTF-8 bytes.
- Existing `GHL_WRITE_APPROVAL_ID` equals the request approval ID.
- Existing `GHL_APPROVED_OPPORTUNITY_IDS` contains exactly the request's one card.
- Existing `GHL_LOCATION_ID` matches the request.
- For a phone-only owner, `GHL_PHONE_WRITES_ENABLED=true`; email owners do not require that gate. This does not enable generic stage writes while its mode stays review.

Request type is exported as `PaidCycleRequest` in `lib/ghl-paid-cycle.ts`. It contains:
- `version: 1`, `approvalId`, `expiresAt`.
- `scope`: `locationId`, `pipelineId`, `jobberClientId`, `contactId`, `opportunityId`, `invoiceId`.
- `originalInvoice`: positive integer `totalCents`, exact provider `issuedDate`, exact provider `dueDate`.
- `originalCard`: `stageId`, integer `amountCents`, `nameHash` produced with existing `cardNameHash`.
- `workflowInventory`: `{ entries, sha256 }`, with the exact complete reviewed list of `{ id, locationId, status, version, updatedAt }`. Compute its canonical sorted hash with `workflowInventoryHash(entries, locationId)`. Pinning just selected workflows is insufficient.
- `identityCoveragePolicy`: the existing reviewed two-ID policy, account ID, review reference and validity interval, with exact cached email/phone witnesses for the two IDs.

Request expiry cannot outlast the coverage policy. Coverage policy keeps its existing maximum 24-hour review interval. Fresh evidence keeps its existing five-minute limit; fresh reads do not renew policy approval. The whole request SHA covers the policy and all cycle fields. Request approval IDs must be strings with valid syntax; mutation requires a nonempty actual configured string that matches. The same runtime type check also hardens the existing date-repair validator against undefined/null/numeric coercion.

## Durable execution

The operation runs after generic reconciliation and the optional date repair, before the admitted sync writer finishes. It reads full fresh evidence, prepares a durable intent, asserts pending ownership, rereads all source/identity/card evidence, compares the complete plan including workflow proof, independently rereads and verifies the whole workflow inventory again immediately before the final pending fence, asserts pending ownership again, then attempts one PUT. It verifies stage/value and unchanged location, pipeline, contact, status, name and custom fields before confirming the journal. Any post-admission failure blocks the durable writer and propagates; there is no retry, compensating write or automatic release. The existing transport does not retry mutation 429 responses.

## Not notification activation-ready

This supplies a bounded payment-exit path, not a fail-closed reminder system. Native reminders must not be activated merely because readiness passes. A policy expires within 24 hours, and source/identity/provider failures can stop reconciliation sooner. Before activation, separately verify an arrangement that prevents later reminders whenever exit eligibility is lost or the policy expires, plus a Paid workflow that removes queued reminders. A monitor that may notice failure later is not equivalent to a send-time gate. No automatic expiry extension is added here.
