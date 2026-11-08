# Due-date reminder clock (not activated)

## Confirmed rule

The user defines Jobber `issuedDate` as the operational send date. This is not a
claim of email delivery. Jobber `dueDate` remains authoritative, including
seven- and fifteen-day terms. The due date is day one; the next **America/Phoenix
calendar date** is "day two", i.e. the first day past due. The invoice is a
candidate for Invoice Overdue then, provided its positive open balance and
identity pass the existing checks. There is no extra two-day or fifteen-day
grace period and no customer text on day two.

Maintenance customer SMS milestones are 10, 15, 20, 25 and 30 days **past due**;
irrigation has 10 and 15 only. The internal call prompt is 21 days past due,
retaining the user-approved internal recipient. The Jobber day-3/day-6 email schedule
is not changed by this patch.

Example: issued November 1, due November 8. The Overdue-stage date is November
9. Day-10 text is November 18, Day-15 November 23, and the internal Day-21 prompt
November 29. An hourly sync makes its first eligible stage proposal after the
calendar boundary; this is not a promise of a midnight write.

## Implemented code scope

`phoneSourcePlan` (shared by email and phone paths) uses the calendar helper for
open invoices. It does not use creation time as a send-date fallback. A missing,
invalid, future-issued or contradictory date holds the owner's update. An early
`past_due` label with a current/future due date holds rather than forcing an
early enrollment or a demotion. Explicit paid/zero-balance historical evidence
retains its existing settlement path. Existing amount, ownership, identity,
cohort, special-stage, durable-write and review-mode safeguards are unchanged.

Date-only values are interpreted literally; offset timestamps are converted to
the business timezone. The dashboard's separately labeled stored-instant aging
calculation and all raw invoice records are unchanged.

The milestone planner is pure and **not a sender**. It does not charge fees,
suspend service, refer debt to collections, enroll contacts, activate workflows,
or prove send eligibility. Past milestones are explicitly reconciliation-only,
not an automatic catch-up batch. The original customer templates are unchanged.

## Remaining activation safeguards

* Both old workflows stay Draft. The existing ten-day wait after stage entry
  would send at approximately eleven days past due under the confirmed rule.
  Use absolute due-date milestones, not a blind republish or a timer reset.
* Reconcile retained executions before any activation. Their timing and old
  invoice ownership cannot be inferred from the current contact/card alone.
* The Day-15 statement that a 3% fee **has been applied** requires evidence for
  that invoice. A policy document or a fee on a different invoice is not proof.
  Day-20/25 recurrence warnings require the applicable late-fee policy.
  Day-30 suspension and future collections statements require verified facts
  and the applicable communication authorization. Otherwise hold the specific
  action or obtain approved truthful wording; do not invent completed actions.
* Before any GHL write/send, recheck the exact source invoice and owner, balance,
  target card/contact, category, channel consent/DND, prior-send ledger and
  recorded approval scope. No inference of payment from a missing invoice.
* Keep seven-day Paid closures paused until their separate exact-opportunity
  guard and fresh-source check are implemented and reviewed.

This local patch changes neither release configuration nor the currently empty
approved-write cohort. Publishing code is not workflow activation.
