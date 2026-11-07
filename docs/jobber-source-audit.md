# Bounded, read-only Jobber source audit

Prepared from deployed commit `5dd5a6c9f345e5de3c18d59ce5b2c3ffe91a0e34`. This adds an opt-in script only. It does not change the app, schema, package scripts, deployment configuration or existing sync behavior.

## Invocation inside the existing web deployment only

After reviewing and deploying these files through the authorized existing service, use this one-off pre-deploy command:

```sh
node --import tsx scripts/audit-jobber-source.ts --run-in-deployment --probe-capabilities
```

Omit `--probe-capabilities` to skip the optional schema-only probe. Do not use `npx`, copy secrets locally, create another service, add an endpoint, call a sync endpoint or start an OAuth flow. The script requires `RAILWAY_SERVICE_ID=ed22ce04-2e5d-47d1-98ed-ce63c99d3d9f`, `RAILWAY_ENVIRONMENT_ID=bc72bc2d-9a4c-494d-8bee-9ca782db1240`, a nonempty `RAILWAY_DEPLOYMENT_ID`, and existing `DATABASE_URL`. If `RAILWAY_PROJECT_ID` is exposed, it must equal `5d7858db-0443-4891-8a95-1eb1261d3e61`. Missing/wrong required metadata fails before database access. Confirm these built-in metadata variables are available in the pre-deploy runtime; do not supply credentials locally or weaken the guard. It reads the latest registered Jobber auth row in memory, selecting only the access token and expiry. It does not read the refresh token or use client secrets.

At least 15 minutes of existing token lifetime is required before beginning. Every request also rechecks that the token has more than 30 seconds remaining. An expiry/authorization failure is an incomplete result, not an invitation to sign in or refresh. Retry after the already-running normal app refresh, when authorized. The script does not schedule retries itself.

## Exact read behavior

- Two short PostgreSQL `REPEATABLE READ`, database-enforced `READ ONLY` transactions read invoice counts and the complete bounded cache. The first also reads the existing access token. Each transaction has a 60-second cap, 30-second statement timeout, and 10-second acquisition wait. No transaction remains open while calling Jobber.
- Uses the same fixed endpoint and API version (`2025-04-16`) as the deployed app and the same invoice selection, except customer names are omitted. No explicit filters or date cutoffs. API default status filtering is unverified; terminal pagination proves completion of the returned connection, not inclusion of every account status.
- Requires a valid connection, nodes, Boolean `hasNextPage`, unique opaque invoice IDs, unique nonempty end cursors, a nonempty continuation page, and an explicit terminal page. Any GraphQL error prevents treating partial data as complete. It never deduplicates by display invoice number.
- Re-fetches the first source page and compares it exactly. Compares both complete cache snapshots, including `lastSyncedAt`. A change fails as incomplete rather than quietly comparing moving data.
- These checks do **not** provide an atomic cross-system snapshot. The source API does not expose a total count in the existing query. A source mutation outside the first page can still occur during enumeration. Fresh per-invoice confirmation is required before any later correction.
- Core audit makes no GHL calls, auth/token refresh, invoice writes, status/terms changes, cash inference, sync triggers, workflow calls or service changes.

## Bounds and exit status

- 25 invoices per page; at most 500 pages / 12,500 records.
- 2 MB per response, 64 MB total successful JSON response bodies.
- At most 3 attempts per request. Only HTTP 429/5xx or all-THROTTLED GraphQL errors are retried, with a bounded delay. No authorization retry or token refresh.
- 25 seconds per HTTP request including body reading. 200 ms between pages.
- 14-minute normal run budget, 14.5-minute hard watchdog, including disconnect.
- Maximum 2,000 detail records; omitted detail count and `detailsTruncated` are explicit. Counts, totals, target resolution and comparisons still cover every enumerated record. Maximum serialized report: 8 MB.
- Exit `0`: complete source/cache enumeration and report. It does **not** mean the records agree or all business fields are known.
- Exit `2`: incomplete, with a controlled error code and safe numeric facts. No raw errors, headers, response bodies, credential values or URLs are logged.
- Exit `3`: interruption/hard runtime stop. Do not treat a partial report as complete.

## Evidence and privacy

Reports include opaque invoice/client IDs, invoice numbers, known status labels and integer-cent amounts. Date and ownership differences are identified, but raw date values, names, emails, phone numbers, local customer IDs, source response bodies and secrets are not printed. Date scalar shape histograms distinguish date-only strings, timestamp strings, numbers, objects, null and missing values. Unsupported shapes remain unverifiable.

All totals are integer cents in the source account's unverified currency. Unknown money is never coerced to zero. Positive balances and negative credits are separate. Paid-positive conflicts are not reduced by paid-negative credits. Open-positive and past-due-positive counts/totals are explicit and status-based.

The query does not expose actual receipt transactions, payment dates, original sent timestamp or fee/product line items. Stored `amountPaid` is compared only with arithmetic `total - balance`, explicitly not verified cash. Cached paid dates are counted as unverified; equality to issue date is diagnostic only. No actual payment date is inferred from `issuedDate`.

Review targets are derived from the current cache: paid with any nonzero balance, void, or duplicate display number. No private invoice target list is embedded in source. Source-only paid conflicts, paid credits and void records also receive details. Every duplicate display number retains all opaque IDs.

With `--probe-capabilities`, bounded `__type` introspection returns relevant Invoice field/type/argument metadata, including `linkedCommunications` and `invoiceNet`, then follows only discovered payment/communications/line-item connection, edge, node and concrete interface/union types. Maximum 12 HTTP requests, no introspection retries, two minutes for the entire probe, and a deadline 30 seconds before the overall run budget. At most 100 fields, 20 arguments per field and eight concrete types per type are retained, with explicit completeness/truncation flags. No business data, descriptions, defaults or arbitrary schema dump are fetched. Probe failure is reported separately and does not invalidate an otherwise completed core audit, unless the overall run budget is exhausted.

## Log format and reconstruction

A large one-line report risks platform log truncation. The script emits JSON log records under `audit: "jobber-source-v1"`:

1. `event: "report-part"`, with zero-based `index`, total `parts`, SHA-256 and escaped `payload`, at most about 5.3 KB per line.
2. `event: "report-complete"` manifest with exact part count, byte count and SHA-256.
3. `event: "summary"` with complete counts, key totals, difference counts and detail-truncation status.

Collect these application log lines from this one run. Require every unique index `0..parts-1`, matching hashes, and the final manifest. Concatenate `payload` in index order. Verify UTF-8 byte length and SHA-256 against the manifest, then parse that string as JSON. Missing/duplicate parts or missing manifest means the delivered evidence is incomplete, even if another summary line exists. Do not concatenate different runs.

A controlled failure instead emits a small `outcome: "incomplete"` record with stage, code and numeric facts. It never emits a successful manifest.

## Local synthetic checks (no credentials or live APIs)

```sh
node --import tsx --test tests/jobber-source-audit.test.ts
./node_modules/.bin/tsc --noEmit --pretty false --incremental false
```

The Node loader invocation avoids the optional IPC listener used by the `tsx` CLI, which this local sandbox does not permit. It uses the same already-installed runtime dependency, not a downloaded package.

Tests cover pagination completeness and bounds; repeated IDs/cursors; incomplete GraphQL data; expiry and retry limits; numeric/date shapes; unknown values; all monetary comparisons; paid-positive versus negative credits; owner/date differences; invoice-number collisions; private-field stripping; capability probe failure; report reconstruction/hash; and refusal to execute the runtime locally without its deployment environment. No production database or API was accessed during preparation.

## Optional GHL preview integration

Apply the separately reviewed GHL helper patch and this integration patch after the core patch. To request the additional read-only phase in the same existing deployment:

```sh
node --import tsx scripts/audit-jobber-source.ts --run-in-deployment --probe-capabilities --with-ghl-preview
```

The default core command remains independent of GHL configuration and makes no GHL calls. With the explicit flag, the bridge uses existing `GHL_API_KEY` and `GHL_LOCATION_ID` in memory. It first obtains a separate short, repeatable-read, database-enforced read-only snapshot of **all** Customer IDs/emails/phones, validating count equality and a 10,000-record cap. Including customers without invoices is necessary to detect competing cached phone/email owners. No raw contact values are emitted or transmitted to another service by this bridge. The helper reads GHL contacts/cards and compares identity values in deployment memory. Cached identities are not freshly verified Jobber identities.

This optional transaction does not overlap any network read. Its acquisition wait is five seconds, transaction limit 30 seconds, statement limit 15 seconds. The GHL helper has a maximum five-minute phase, additionally capped at 13.5 minutes after the overall audit began. If fewer than 40 seconds remain before that cap, the phase is skipped as incomplete before reading contacts. The overall 14-minute budget / 14.5-minute watchdog and 15-minute initial token-coverage requirement remain unchanged.

Optional configuration, contact completeness, HTTP, capability, runtime or analysis failures are contained as `ghlPreview.outcome: "incomplete"`; the completed Jobber comparison is retained. The final short summary includes `ghlPreviewOutcome`. If the combined output would exceed eight MB, the GHL result is replaced with an explicit `GHL_COMBINED_REPORT_LIMIT` incomplete result rather than dropping core evidence. The top-level complete outcome still refers to the Jobber source audit only. The helper never authorizes mutations, messaging or workflow actions, even if its structural preview is complete.

Additional local checks:

```sh
node --import tsx --test tests/jobber-source-audit.test.ts tests/ghl-readonly-preview.test.ts tests/jobber-ghl-bridge.test.ts
./node_modules/.bin/tsc --noEmit --pretty false --incremental false
```
