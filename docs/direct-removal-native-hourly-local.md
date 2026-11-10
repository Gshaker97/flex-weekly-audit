# Disabled direct-removal and native-hourly candidate

This local extension starts from bc7c1eb. It changes no deployed configuration,
workflow, contact, or opportunity, and adds no database schema or sending engine.

## Direct reset contract

The direct alternative is separately gated by
GHL_DIRECT_WORKFLOW_REMOVAL_ENABLED=true and the existing cycle/recurring, mode,
cohort, phone and approval gates. The pinned effects policy must contain
directRemoval with apiVersion v3, contractSha256, evidenceRef,
singleCycleWriterReviewRef, and
residualDispatchAndExternalEnrollmentRiskAcceptanceRef. These may all reference
one coherent reviewed activation decision. No actual approval is supplied here.

The confirmed old enrollment or reset-stage ownership, confirmed Paid write,
owned-date witness/readback, current exact open Paid/zero card, fresh old invoice
paid/zero, distinct later single unpaid invoice, full identity coverage, and
unchanged reviewed workflow inventory remain required. An invoice already
present at old Paid is held: this does not manufacture aggregate Paid/zero while
successor debt exists.

The existing private v1 journal accepts an optional workflowRemoval intent,
separate from cycle enrollment and card writes. It records exact location,
contact, card, owner, workflow, old invoice, immutable ownership/Paid IDs and
reviewed contract. A durable pending claim precedes exactly one DELETE request:
 /contacts/{contactId}/workflow/{workflowId}
 Version: v3
 Body: {}

No redirect, mutation retry, timeout retry, or rate-limit retry is allowed.
Only HTTP 200 with JSON succeeded exactly true produces a separate durable
removalAcknowledgment. This is authoritative successful removal under the
reviewed operating contract. It is not a provider-quiescence proof and never
asserts noRelevantActiveExecution. An already dispatched message or concurrent
external enrollment remains a residual risk requiring explicit acceptance and
an exclusive-cycle-writer operating review.

An acknowledged receipt is reused across processes/runs for the same old cycle;
it is never renewed, and no later reset reissues that old-cycle DELETE.
Unknown/malformed responses, pending attempts, or uncertain durable commits
fence the run. Running/blocked rows never automatically unlock. A confirmed
receipt can survive a safely held/completed run and be reused on the next
admitted run. No indexed activeWorkflows negative result or arbitrary delay is
required. The observed QA search lag therefore cannot falsely veto or certify
completion.

After acknowledgment, fresh source/card/effects checks precede date and stage
steps. Each remains separately journaled and read back. The original five-minute
branded identity proof is rechecked immediately before every transport call,
after journal awaits. Policy revocation and expiry also stop direct writes.
The previous native-clear adapter stays null and is not invoked on this path.

## Honest native hourly payment contract

contract.paymentGuard may explicitly choose native_hourly_sync instead of
freshPaymentAndChannelGuards. Mixed claims are rejected. The variant requires:
- intervalMinutes exactly 60 and an exact once-hourly cronExpression;
- scheduleReviewRef and sourceSyncBeforeGhlReviewRef;
- nativeStageAndPositiveValueGuardReviewRef;
- nativeChannelSuppressionReviewRef;
- stalePaymentRiskAcceptanceRef.

All references may point to the same reviewed deployment decision. The schedule
and actual native guards must be checked when provisioning the pinned policy;
the code validates the declared contract, not provider scheduling configuration.
No reference or acceptance is fabricated by this patch.

This contract means payment information reaches GHL after a successful scheduled
Jobber sync; a payment between syncs may not stop an already eligible native send.
It does not promise a fresh Jobber read before each SMS, nor a hard one-hour
maximum during failed/slow syncs. Actual native stage/value and channel guards
remain necessary. No separate sender is added.

## Bootstrap timing limit and scope

The existing first-cycle clearance still expires 15 minutes after its original
review. If source sync consumes 10–14 minutes, only 1–5 minutes remain for all
identity/card/workflow reads and writes. This candidate does not establish that
a whole cohort can finish in that interval, and never renews the review.
Existing-Overdue bootstrap and immutable-cohort approval/fresh-runtime-proof
separation are separate work, not silently enabled here. Already-Overdue cards
remain held by the current recurring helper until that independently reviewed
integration is completed.

## Verification

Synthetic tests exercise one-attempt transport, exact acknowledgment shape,
durable receipt reuse, unknown outcomes, lost durable replies, retained old
journals, source change, identity expiry, disabled/missing policy, and separate
native-hourly contract validation. Production activation remains held pending
the exact reviewed policy, actual workflow/version/guard inventory and separate
bootstrap integration. No external requests were made while developing/testing.
