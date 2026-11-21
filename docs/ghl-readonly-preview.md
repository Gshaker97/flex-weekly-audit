# Standalone GHL read-only preview

Base: deployed `5dd5a6c9f345e5de3c18d59ce5b2c3ffe91a0e34`.
Entry: `scripts/source-audit/ghl-readonly-preview.ts`.
This preparation was tested entirely with synthetic responses and dummy credentials.
No live GHL requests, deployments, provider/source writes, credentials, service
configuration, workflow calls, endpoint additions or uploads were performed.

## Optional integration

Import `runGhlReadonlyPreview(input, options)` in the source audit, behind an
explicit optional flag. It never logs, writes a file, opens a database, refreshes
authentication, or imports the application sync/GHL clients. Its result can be
included in the existing authorized private deployment audit log.

Input:
- `customers`: ALL cached Customer rows, selecting only jobberClientId/email/phone.
  The caller must validate count and row coverage in a bounded read-only database
  transaction before setting `customerSnapshotComplete: true`. An invoice-owner
  subset is insufficient: customers without invoices can still compete for identity.
- `cachedInvoices`: jobberInvoiceId/jobberClientId, with null owner retained.
- `freshInvoices`: id/owner/invoiceStatus/balance from the source audit. Balance
  is integer cents, never unnormalized dollars. Set `freshInvoicesComplete: true`
  only after full source pagination and verification. Missing source evidence
  creates holds; it never implies a paid or deleted invoice.
- `options`: existing securely configured apiKey/locationId and optional deadlineAt.
  Use the caller's earlier deadline to reserve output and cleanup time. There is
  no new credential, persistent access or authentication flow.

The GHL result is independently `complete` or `incomplete`. An optional GHL
failure must not erase a completed source comparison or be reported as successful
GHL verification. Cached contact fields are explicitly not fresh Jobber evidence.
There is no built-in CLI or deployment hook; the source audit owns optional execution.

## Fixed read contract

The transport permits only:
- POST `https://services.leadconnectorhq.com/contacts/search`, fixed full-snapshot body.
- GET `/opportunities/pipelines`, fixed location query.
- GET `/opportunities/search`, fixed location/pipeline and `status=all`.

All requests use Version `2021-07-28`, manual redirect handling, ten-second request
limits and a total deadline no later than five minutes after helper start.
The maximum is 220 requests, 100 pages per population, 10,000 records per input
or provider population, 3 MB per response, 32 MB total response and 5 MB output.
A short page is not treated as complete unless the verified total is reached.
There are no retries, including 403 or 429. Errors expose only controlled codes
and numeric facts. Provider nextPageUrl, raw errors, headers and bodies are not
followed or logged. Streaming bodies are byte-limited and subject to the same
request timeout. The source audit should retain its existing process watchdog.

Pinned public docs checked during preparation:
- [Contact search](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/contacts/search-contacts-advanced/index.html): top-level total; last contact searchAfter passed unchanged; page omitted after the first request. fastPagination false retains total. Primary/additional identity fields and DND are documented.
- [Opportunity search](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/opportunities/search-opportunity/index.html): status all; meta.total; startAfter and startAfterId. This GET endpoint is now marked deprecated. No migration to another endpoint is attempted here.
- [Pipelines](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/opportunities/get-pipelines/index.html): locationId; pipelines and stages.
- [Contact DND](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/contacts/get-contact/index.html): global boolean and per-channel active/inactive/permanent. This detail endpoint is documentation only; the helper uses DND returned by full contact search.

## Interpretation

Output retains only validated provider/source IDs, controlled flags, hold reasons,
counts and contract metadata. No contact names, emails, full phones, card titles,
message bodies or balances are printed. Source phone-format and ambiguity counts
are included. The historical 316-card breakdown (107 Sent, 10 Paid, 11 Overdue,
188 Closed Out) is a comparison, not a completeness oracle.

Phone normalization/matching is copied verbatim from the tested isolated
`lib/ghl-phone-match.ts` candidate, not imported from application sync. A phone
match requires canonical US number identity. International numbers retain their
country prefix and cannot become US matches. Suffixes/additional identity fields
may introduce a hold but never establish ownership. Email matches are exact after
case/whitespace normalization. All cached customer identities participate in
collision detection. Missing or ambiguous contact/card ownership cannot be chosen.

Existing-card candidates require unique contact and card ownership, ordinary open
Sent/Overdue/Paid stage and conservative fresh invoice evidence. This is not a
stage-change plan, consent check, SMS-capability check, or permission to mutate.
DND evidence is separately reported and never proves consent or mobile capability.
Won/lost/unknown status and Late Fee/Closed Out/other special stages remain held.
There is no automatic creation, deletion, merging or reopening.

Synthetic fixtures specifically cover three same-phone contacts (ambiguous, no
selection), and a won/Closed Out card with positive source debt (held, no reopening).
They are not live verification of those customer accounts. Snapshots are not atomic
across calls or systems. Later mutations would need fresh evidence and a separate
approved cutover; no writes are enabled by this report.

## Local verification

- `node --import tsx --test tests/ghl-readonly-preview.test.ts`: 71 passing tests.
- `tsc --noEmit --incremental false`: passed.
- Targeted ESLint with Next core-web-vitals: passed.
- `git diff --check`: passed.
- No full production build was needed for these isolated scripts; combined deployment
  review/build remains the integrator's responsibility.

The tsx CLI itself encountered a local IPC sandbox restriction; Node's supported
`--import tsx` loader ran the same test suite successfully without needing an IPC
socket or any permission change.
