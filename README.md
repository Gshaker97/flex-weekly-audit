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

Run a sync manually with the "Sync from Jobber" button, or set up a daily cron to keep it fresh.

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

### Daily sync cron

Hit `POST /api/sync/run` with header `x-cron-secret: <your CRON_SECRET>` on a schedule.

## Notes on Jobber rate limits

The API has a 10,000-point bucket that refills at 500 points/second. The sync engine paginates with 600ms delays between requests and uses small `first: 25` page sizes with bounded nested connections to stay well within budget.
