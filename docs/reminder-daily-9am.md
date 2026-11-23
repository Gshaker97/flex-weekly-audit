# The 9:00 AM Arizona reminder run

One run a day, at 09:00 America/Phoenix, that says who would be reminded today
and why everyone else would not. It sends nothing.

## What it is

`scripts/reminder-evaluate-cron.ts`, run by `npm run reminders:evaluate`.

It reads the open invoices the dashboard counts as collections scope, asks
Jobber and GoHighLevel about each one live, and writes a `ReminderEvaluationRun`
row plus one `ReminderEvaluationRow` per invoice. Then it prints the day's plan:
the customers who would be messaged, the channel, and the invoice behind it.

## Why it cannot send

- The file imports no sender and no GoHighLevel write path. There is no mode or
  flag that makes it deliver anything; going live means adding code, reviewed
  separately.
- It is default-off twice over. It exits immediately unless
  `FLEXX_REMINDER_EVALUATE_MODE` is exactly `evaluate`, and the evaluator
  returns `outside_window` unless the clock is inside 09:00–09:15 Phoenix
  (`--ignore-window` overrides only the second, for a manual review).

## The schedule

A Railway cron service in the **Flex Weekly Audit** project, production
environment:

| setting | value |
|---|---|
| Start command | `npm run reminders:evaluate` |
| Cron schedule | `0 16 * * *` |
| Source | `Gshaker97/flex-weekly-audit`, branch `main` |

`0 16 * * *` is 09:00 Phoenix **all year**: Arizona does not observe daylight
saving, so it is UTC−7 in January and in July alike. Do not "correct" this for
summer time — `tests/invoice-reminder-automatic.test.ts` asserts it.

This is deliberately a separate service from the hourly `zucchini-unity` sync.
The hourly sync must not grow a second job on a different clock, and a daily run
that fails should not look like a sync failure.

Auto-deploy is disabled on every service in this project, so creating the
service is not enough on its own — it has to be deployed by hand, like the
others.

## One text and one email per customer per day

The evaluator decides per **invoice**, so a customer with three unpaid invoices
can produce three separate text decisions for one morning. `lib/reminder-daily-plan.ts`
collapses that to what a day can actually deliver: for each customer, at most
one text and at most one email, with everything it drops reported as dropped.

Which invoice wins: the furthest-along milestone, then the longest overdue, then
the lowest invoice number. The cap can only remove — every pick is a row the
evaluation already called eligible on a channel it already called eligible, and
`tests/reminder-daily-plan.test.ts` asserts that picks are always a subset.

This mirrors, rather than replaces, the notification ledger's own rule: one row
per customer, per day, per channel, so one text and one email can both go out
but never two of the same kind.

## Reading a run

```
[reminder-evaluate] run=<id> {"state":"completed","candidates":41,"eligible":0,...}
[reminder-evaluate] today: 0 customer(s) would be messaged — 0 text(s), 0 email(s), 0 further message(s) dropped by the one-per-customer-per-channel cap
[reminder-evaluate] #7246 held category=maintenance/tags dpd=24 milestone=21 holds=[...]
```

Decision lines carry the invoice number and the hold reasons only — never a
phone number, an email address or message text.
