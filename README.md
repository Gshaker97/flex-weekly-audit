# Flex Weekly Audit

A standalone dashboard that scans Flex Landscaping's Jobber account each week and flags any jobs that aren't marked complete or don't have an invoice attached.

## Stack

- Next.js 14 (App Router, TypeScript)
- Tailwind CSS
- Prisma + Railway Postgres
- Jobber GraphQL API (OAuth)
- Deployed on Railway via GitHub

## Setup

### 1. Environment variables

Set these in Railway → Variables for the `flex-weekly-audit` service:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Reference the Postgres service: `${{Postgres.DATABASE_URL}}` |
| `JOBBER_CLIENT_ID` | From your Jobber Developer Center app |
| `JOBBER_CLIENT_SECRET` | From your Jobber Developer Center app |
| `JOBBER_REDIRECT_URI` | `https://<your-railway-domain>/api/auth/jobber/callback` |
| `CRON_SECRET` | Any random string (used to authorize cron calls) |
| `APP_URL` | Your Railway public domain, e.g. `https://flex-audit.up.railway.app` |

### 2. Railway settings

- Add a **Public Domain** to the service (Settings → Networking → Generate Domain)
- Make sure the Postgres service is in the same project
- Build command and start command are handled by the `package.json` scripts

### 3. Jobber app redirect URI

In your Jobber Developer Center app, set the Redirect URI to:

```
https://<your-railway-domain>/api/auth/jobber/callback
```

Required scopes: `read_jobs`, `read_invoices`, `read_clients`

### 4. First connection

Once deployed:
1. Visit your Railway URL
2. Click **Connect Jobber Account** on the prompt
3. Sign in with Flex's Jobber account and authorize
4. You'll be returned to the dashboard
5. Click **Run audit now** to verify everything works

### 5. Weekly cron

Set up a Railway cron service (or external scheduler) to hit:

```
POST https://<your-railway-domain>/api/audit/run
Header: x-cron-secret: <your CRON_SECRET>
```

Recommended schedule: Mondays at 7:00 AM Arizona time (`0 14 * * 1` in UTC).

By default the cron run audits the **previous** completed week. Add `?range=current` to audit the in-progress week instead.

## How the audit works

For each weekly run, the app:
1. Pulls every job from Jobber whose `completedAt` or scheduled `endAt` falls within the week
2. Checks each job for:
   - A completion status (`completedAt` is set OR `jobStatus` contains "complete"/"archived"/"invoiced"/"paid")
   - An attached invoice (at least one entry in `invoices.nodes`)
3. Records totals, persists flagged jobs, and renders them on the dashboard

## Local development (optional)

Since you work in GitHub-only, this is unlikely to apply, but if needed:

```bash
npm install
npx prisma migrate dev --name init
npm run dev
```
