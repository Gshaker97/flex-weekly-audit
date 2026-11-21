# Local only: optional Paid-date evidence and standing identity scope

Based on reviewed candidate 5dcf377. No provider calls, real policy values,
publication, activation, schema or new receipt API are introduced. Existing
features remain disabled by default. The original reviewed worktree is unchanged.

## Optional provenance, not cleanup acknowledgment

A confirmed Paid stage write did not previously retain proof that the opportunity
had its owned nonblank due date immediately before Paid. This extension optionally
records that exact full-card/DATE-metadata observation in the immutable Paid intent:
original ownership journal ID, known field ID/value, observation time and hash of
other opportunity fields. The value is the historical owned card date, not an
invented replacement for an edited Jobber source due date.

After the normal Paid/open/zero/name/card checks, optional fresh field metadata and
readback can record either the same owned value or blank, with unchanged other
fields. Missing/malformed/conflicting optional evidence does not block a verified
Paid exit or invent an acknowledgment. The Paid claim remains confirmed without
reuse evidence. Reuse now requires both pre-Paid provenance and eligible readback.
Legacy journals without these optional properties still parse; valid payment exits
remain possible, but their later reuse stays held. No evidence is backfilled.

These records do NOT prove a workflow removed an old execution. A pre-existing
blank cannot acquire provenance merely because a synthetic/static cleanup claim
says it succeeded. Unknown provider outcomes still use existing durable barriers.

## No operational ordered-clear adapter

The default cleanup adapter is still null. Two actual findings prevent converting
blank into a native completion signal:
- The modern Update opportunity action rejected a blank DATE value on Save.
- Official GHL troubleshooting warns that same-second actions can run out of order
  or log Executed without the intended effect. Adjacency, Save, or one successful
  QA run is not a durable remove-before-clear completion barrier.

Source: https://help.gohighlevel.com/support/solutions/articles/48001218068-troubleshooting-workflow-executions-race-conditions

A later documented direct-removal/readback approach can use the retained evidence,
but must establish its own supported completion semantics and be independently
reviewed. This patch adds no DELETE call, execution-log API, cleanup workflow or
assumed blank-field acknowledgment. Existing `freshPaymentAndChannelGuards` remains
unverified for native stage-only guards; no stage guard is labeled real-time.

## Explicit standing identity authorization

`StandingOmissionPolicy` is separate from the existing temporary 24-hour review.
It requires explicit-standing kind, original approval ID/reference/date, an
explicit until-revoked scope, exact account and two quarantined owner witnesses,
and the hash of that exact account/owner scope. No approval date is regenerated;
no temporary policy expiry is silently renewed.

Private deployment inputs, absent by default:
- GHL_STANDING_IDENTITY_ENABLED
- GHL_STANDING_IDENTITY_APPROVAL_ID
- GHL_STANDING_IDENTITY_POLICY
- GHL_STANDING_IDENTITY_POLICY_SHA256

The loader checks the pinned bytes, matching explicit approval ID and exact scope.
The actual user approval must exist and be checked before provisioning these
inputs. A hash or a syntactically valid reference is not itself permission. No real
approval, owner IDs, policy blob or activation values are supplied here.

Authorization persistence does not make observations permanent. The current full
active/archived population, exact omitted owners, fresh exact-null lookups, zero
linked jobs/invoices, account, owner/invoice relationship and identity-overlap
checks remain mandatory. Minted evidence still expires after five minutes. Existing
temporary-policy 24-hour limits remain unchanged. Quarantined cached identities
remain collision witnesses; they are not removed from the owner population.

Wiring covers outer sync identity preflight and both recurring/reset readiness
adapters. The outer run can reuse the existing bounded inventory handle, but a
changed authorization invalidates that cached handle; generic writes recheck the
policy before admission. Disabled/revoked configuration falls back to strict
completeness, not an automatically retained omission grant. Helpers reload the
configured authorization on each fresh read. No broad performance changes are made.

## Checks and limits

Synthetic tests include optional-witness failure preserving Paid, unexpected field
readback withholding reuse, missing evidence blocking reset, legacy compatibility,
standing-policy scope integrity/revocation, fresh-null/count/overlap guards,
five-minute expiry, unchanged temporary expiry, and outer sync reaching a valid
Paid exit only with its separately approved synthetic standing scope.

Witness capture adds at most one metadata GET before Paid and one metadata GET
after the already-required card readback. Failures withhold optional reuse evidence.
Fresh helper coverage still repeats potentially large identity reads; no live
throughput, account-wide readiness, native cleanup success or enrollment delivery
is inferred from offline fixtures.

## Standing-evidence boundary revalidation

The outer writer retains the same inventory handle and owner proof through card
and optional witness reads. It rechecks their original five-minute lifetime and
the exact authorization pin after those reads, before durable admission, and
again immediately after the pending assertion before PUT. Expiry/revocation
before admission holds without creating a journal entry; after admission it
blocks the writer with the pending intent retained and performs no mutation.
No read timestamp, authorization date, or evidence lifetime is refreshed to pass
these checks. Integration tests advance the clock during the actual card GET
and after durable admission, and assert zero PUTs and no policy renewal.

Helper write-boundary correction: the trusted readiness reader retains the original
branded omission token and exact immutable scope/identity inputs in a private
WeakMap. Helper snapshot clones explicitly retain its validator; JSON cannot
serialize or manufacture this proof. Default adapters additionally pin the actual
configured authorization. Both recurring enrollment and owned-cycle reset
revalidate after workflow/native and durable-journal awaits, immediately before
each date or stage PUT. Expiry/revocation before admission holds; after admission
it fences the pending claim. Neither checking nor cloning renews evidence.
Strict reads without omission authorization and injected synthetic fixtures keep
their existing contract. Real-reader synthetic regressions cover expiry during
workflow reads and final claim checks, revocation, no-write fencing, and healthy
date/stage paths. No operational cleanup adapter or policy values are supplied.
