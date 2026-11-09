# Exact invoice date preparation

This change is not notification activation. The date repair operation has a
disabled-by-default hook inside the admitted standalone cron, and no HTTP caller.
Existing stage-write modes, approved cohorts and customer workflows remain
separate. The planner never grants permission by returning a candidate.

## Implemented pieces

- Pure invoice/cycle binding, due-date repair planning, retained-execution
  reconciliation and same-opportunity Paid closure checks.
- Existing API-version `2021-07-28` contract: GET opportunity field values use
  `fieldValue`; PUT uses `customFields: [{ id, field_value }]`. No API-wide upgrade.
- A real one-shot, field-only transport integrated with `SyncRunWriter`.
  It cannot alter stage, status, money, name, contact, enrollment or messaging.
- The durable journal now records the exact field ID, blank expected value,
  source invoice ID, source fingerprint and target calendar date. It validates
  unchanged stage/status/money/name. Existing stage-only entries remain valid.
- Two fresh full-source/card/binding reads, current workflow-pause checks,
  approval expiry, exact intent hash and exact approved opportunity cohort are
  required. Pending admission is reasserted immediately before the PUT.
- Readback must confirm the exact date and unchanged other card fields. A timeout,
  rejected/unknown mutation, changed readback or lost durable acknowledgement
  leaves the writer blocked. No automatic replay or compensation is performed.
- Exact observed colon-space formatting around a valid full US phone number is
  normalized without changing digits. Other unresolved, duplicate and omitted
  owner guards are retained.

## Still required before any production date repair

The live-read adapter and `scripts/review-opportunity-date.ts` now provide a
private read-only readiness result using exact owner invoice pagination, fresh
complete identity populations, all-status card uniqueness, full card/field
reads and exact reviewed Draft workflow versions. A 404 on `/workflows` was
resolved by the provider's required `/workflows/` path; no credential change.
The existing omitted-owner and collision holds remain mandatory. This reader
cannot accept a caller's identity approval boolean or use an allowlist to bypass
them. The review script does not admit a writer or call a mutation.

1. A trusted operational adapter must establish the invoice-owner-contact-card
   relationship. A caller-supplied boolean, card name, amount or review allowlist
   is not authoritative identity evidence. Automatic matching retains its current
   strict guards; an independently reviewed direct binding needs explicit provenance.
2. Field metadata and the current full-card response must be verified. The
   version-pinned full GET sparse-field contract was verified on November 9 by
   reading a synthetic blank card, editing the same field in the UI, and reading
   the exact populated field back. Omitted fields are blank only in this full GET
   context; malformed/null field collections remain held. Search results cannot
   substitute for the exact full-card read.
3. A live adapter must freshly verify the affected workflows remain Draft and
   that field-update side effects were reviewed. Saved approval flags alone do
   not satisfy this check.
4. An exact, time-limited reviewed request and applicable publication/deployment
   permission must exist. `GHL_DUE_DATE_REPAIR_ENABLED`, `GHL_WRITE_APPROVAL_ID`
   and the exact approved cohort remain independent gates. None is enabled by
   this patch.
5. Native date parsing and exact triggering-opportunity binding require a
   synthetic, non-sending execution test. Old queued steps must not be blindly
   resumed or caught up; fee/suspension assertions still require factual evidence.

There is no new public endpoint, schema migration, background schedule or message
sender. An ordinary cron remains a no-op for date repair. Enabling the hook needs
`GHL_DUE_DATE_REPAIR_ENABLED=true`, a private `GHL_DUE_DATE_REPAIR_REQUEST` and its
exact SHA-256 in `GHL_DUE_DATE_REPAIR_REQUEST_SHA256`, plus the existing approval
and cohort gates. The request contains version 1, exact scope, approval and
reviewed workflow IDs/versions/update timestamps. Cron-only admission, review
mode and disabled phone writes are mandatory. Request expiry prevents repeated
future authorization; an already aligned date is not rewritten. No variables
are enabled by the code release. Do not invoke it as if the prerequisites were met.
Do not roll back or clear a pending date-field journal: inspect its immutable
source/target evidence and actual provider state first.

## Official API contracts

- https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/opportunities/update-opportunity/
- https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/opportunities/get-opportunity/
- https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/locations/get-custom-fields/

Unit tests use synthetic records and provider responses. They verify implementation
behavior, not actual customer consent, carrier delivery or native workflow timing.
