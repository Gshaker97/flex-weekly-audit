# Cancellation-only paid-cycle overlap

Local extension to frozen 88e3087. No schema, workflow, deployment, provider
calls, or activation/configuration changes were made.

When owned enrolled invoice A is freshly verified paid/zero while one or more
distinct successor invoices remain unpaid, aggregate debt cannot truthfully enter
Paid/zero. The guarded sync now attempts only exact A workflow removal under
the same separately enabled direct-removal operating contract. It preserves
the card's stage, amount, name, due date, and other fields, and holds B entry.
It never fabricates a Paid claim.

Required evidence includes retained latest enroll ownership, current unique
open Sent/Overdue card with the historically owned date, complete fresh identity
and owner invoices, A paid/zero and at least one distinct unpaid successor. Changed source,
ambiguous identity/card, unknown ownership, changed owned date, or unsupported
stages hold. This is not a multi-invoice messaging policy. A source due-date edit
does not replace the historical owned card date.

The existing journal's optional removal action gains the explicit purpose
paid_cycle_cancellation and an exact observed owned-date witness. No oldPaid
journal ID is invented. Pending admission precedes the same one-attempt v3
DELETE. Unknown/malformed response or uncertain durable outcome fences all
later writes; no retry occurs. Only persisted 200/succeeded acknowledgment
completes removal. No noRelevantActiveExecution assertion is manufactured.

When aggregate debt later genuinely becomes paid, the existing Paid hook may
record its normal source-paid/witness evidence. A subsequently appearing invoice
C can reset using the original cancellation receipt, rather than reissuing
A's DELETE. The receipt's original observation predates aggregate Paid legitimately;
its invoice settlement and owned lineage are retained. No old cycle receipt is
reassigned to another invoice.

Residual already-dispatched-message and external/manual enrollment risks remain
within the explicit direct-removal operating acceptance. Provider receipt
acknowledgment is successful removal, not universal quiescence. Existing holds
alone still do not cancel unsupported or unowned executions.

Offline integration tests invoke the actual sync hook, real durable writer and
real default readers with synthetic transport: A-paid/B-unpaid cancellation,
no aggregate PUT, receipt reuse, timeout/malformed no-retry fencing, source
changes after claim, edited source due date, ownership/date/status holds,
genuine later Paid and C reset without a second DELETE.

Cancellation-only does not depend on successor count. B and C both unpaid still
allow removal of exact owned A while preserving all successor holds and all card
fields. When all source invoices are paid, the ordinary aggregate Paid exit owns
that path; cancellation-only is not invoked. This adds no multi-invoice sends.
