# Flexx Landscaping KPI Dashboard

A business intelligence dashboard for Flexx Landscaping that pulls data from Jobber and surfaces revenue, customer, and operational KPIs.

## Features

**Revenue & financial**
- Month-over-month invoiced revenue
- Revenue at risk (jobs not marked complete)
- Uninvoiced revenue (jobs done but no invoice)
- Outstanding receivables (invoiced but unpaid)
- Average job value
- Revenue by service type

**Customers**
- New customers per month
- Total active customers
- Recurring service customer count
- One-off vs recurring revenue split
- Customer churn (lost recurring customers)
- Top 10 customers by revenue YTD

**Job audit (separate page at /audits)**
- Flags jobs missing completion status or invoices
- Custom date ranges (YTD, last 30/90 days, this/last week)

## Stack

- Next.js 14 (App Router, TypeScript)
- Tailwind CSS with light/dark mode
- Prisma + Railway Postgres
- Recharts for visualizations
- Jobber GraphQL API (OAuth)
- Deployed on Railway via GitHub

## How it works

The dashboard is powered by a **local Postgres cache** of Jobber data. A sync job pulls clients, jobs, and invoices from Jobber and stores them in Postgres. The dashboard queries Postgres (fast) instead of Jobber (rate-limited).

Run a sync manually with the "Sync from Jobber" button, or set up an hourly cron to keep it fresh.

## Setup

### Environment variables (Railway)

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `JOBBER_CLIENT_ID` | From Jobber Developer Center |
| `JOBBER_CLIENT_SECRET` | From Jobber Developer Center |
| `JOBBER_REDIRECT_URI` | `https://<railway-domain>/api/auth/jobber/callback` |
| `CRON_SECRET` | Any random string |
| `APP_URL` | `https://<railway-domain>` |
| `GHL_API_KEY` | GoHighLevel API key (Bearer token) |
| `GHL_LOCATION_ID` | GoHighLevel location/sub-account ID |

### First run

1. Visit your Railway URL
2. Connect Jobber
3. Click **Sync from Jobber** (takes 5-10 minutes the first time)
4. KPI dashboard populates automatically

### Hourly sync cron

Hit `POST /api/sync/run` with header `x-cron-secret: <your CRON_SECRET>` on a schedule.
The standalone `npm run sync:cron` service runs **hourly** (`0 * * * *`) so the GHL
Invoice Pipeline (Sent / Overdue / Paid / Canceled) stays current through the day.

## Daily audit (/daily-audit)

A read-only morning check that writes one report, shown on the **Daily Audit** page. It never
writes to Jobber or GoHighLevel and never sends a message. Code: `lib/daily-audit/`.

Checks:

1. **Sync is running**: the hourly Jobber sync finished in the last 2 hours with no recent failures.
2. **Invoices match Jobber**: every invoice issued since Jan 1, 2026 has the same status, balance, total and due date on the dashboard.
3. **Recent jobs match and are invoiced**: jobs completed or ending in the last 14 days match the dashboard, and completed jobs have an invoice or a "No Invoice" note.
4. **Totals match**: overdue and open counts and dollar totals equal Jobber's.
5. **GHL Invoice Pipeline**: each past-due customer has one open card in Invoice Overdue with the right value; cards left in Invoice Overdue with nothing past due are listed.
6. **Reminders on their day**: maintenance texts on days 10, 15, 20, 25 and 30 past due; irrigation on days 10 and 15 (day one is the due date). A text on the day or the day after is on time. GHL emails are shown per step. Service type comes from Jobber client tags and invoice line items.
7. **Reach**: past-due customers with no email or phone, no GHL contact, DND on, or missing the `flex-native-paula-approved` tag the GHL text workflow requires.
8. **Day-21 calls**: invoices 21+ days past due not marked called on the Collections page.

Jobber's own day 3 and day 6 reminder emails can't be confirmed, because Jobber's API doesn't expose them.

### Railway setup

Add a Cron service from this repo (same variables as the sync cron: `DATABASE_URL`, `JOBBER_CLIENT_ID`,
`JOBBER_CLIENT_SECRET`, `GHL_API_KEY`, `GHL_LOCATION_ID`):

| Setting | Value |
|---|---|
| Start command | `npm run audit:daily` |
| Cron schedule | `30 13 * * *` (6:30 AM Arizona; half past keeps it clear of the hourly sync) |

The web service's `prisma migrate deploy` creates the `DailyAuditReport` table on deploy. The
**Run audit now** button on the page starts a run on demand.

## Notes on Jobber rate limits

The API has a 10,000-point bucket that refills at 500 points/second. The sync engine paginates with 600ms delays between requests and uses small `first: 25` page sizes with bounded nested connections to stay well within budget.
