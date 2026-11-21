# Phone-only matching candidate: local review, no activation

Historical six-file candidate notes. For the focused integrated candidate,
[sync-safety-review.md](sync-safety-review.md) supersedes lifecycle/mode and
legacy-email behavior below; canonical matching and API-contract notes remain.

Base: deployed `5dd5a6c9f345e5de3c18d59ce5b2c3ffe91a0e34`.
Branch: `fix/flex-phone-only-20261106`. Local, uncommitted. No production writes,
credentials, deployment, or changes from the broad candidate branch.

## Implemented scope

- Only customers missing email use the new path. Keep their stored Customer ID /
  unique Jobber client identity, rather than grouping different owners by phone.
- User explicitly confirmed local-format numbers are US. Ten digits become +1;
  eleven digits must start with 1. Formatting is ignored, explicit international
  prefixes preserved, extensions/invalid lengths rejected. Blank phones remain
  unchanged. No fuzzy hit/name matching or contact creation.
- Read complete GHL contacts with documented total counts and cursor pagination.
  Shared Jobber phones, GHL duplicate phones, another Jobber customer's email,
  or a possible seven-digit competing owner cause a hold before writes.
- Require exactly one existing open card, exact contact/pipeline ownership,
  complete opportunity search count, and existing Sent/Overdue/Paid stage. Never use
  the legacy opportunity creation / duplicate-error reassignment route.
- Aggregate eligible overdue invoices, including awaiting-payment invoices whose
  due dates elapsed. Phone-only entry eligibility keeps the deployed cutoff.
- Potential exits use a fresh full Jobber invoice connection, not the incremental
  cache. Read lazily once per sync run, reuse the promise, require pageInfo and
  unique IDs/cursors, cap at 1,000 pages, reject unmapped invoices and partial reads.
- For the exact Jobber client, require nonempty source invoices and coverage of
  every stored invoice ID. Paid requires every invoice explicitly paid with
  numeric zero balance. Explicitly paid historical/zero-total invoices count as
  settled; they are never silently filtered out. Void/unknown/negative balance,
  missing evidence, positive old debt, or partial payment prevents Paid.
- If remaining debt is exclusively future awaiting-payment invoices, with all
  other invoices explicitly settled, move the same-owner aggregate card to Sent.
  Its old aggregate title need not match a single invoice. A unique open Paid
  card can re-enter Sent/Overdue only on fresh verified positive source debt,
  never cached stale debt. No fee/suspension logic.
- Protect known phone candidates, including conflicts and failed reads/moves,
  from email-path reuse and both legacy cleanup passes. Only the verified phone
  exit can move these cards to Paid. Unrelated email behavior is unchanged.
- Preflight only phone customers with a post-cutoff nonzero stored invoice.
  Archived customers without relevant invoices do not gate sync. Exact no-match
  skips phone writes. Unsupported relevant phone formats or failed/incomplete
  GHL snapshots abort before pipeline writes because ownership is unknown.

## Deployment effects and outstanding verification

1. **No deployment is authorized or performed.** PUT stage updates include
   status=open, target stage, and for overdue cards amount/title. Existing GHL
   stage-change workflows may send messages. A Paid/Sent transition also needs
   workflow review to verify it cancels queued reminders; code cannot promise it.
2. Unsupported relevant formats or a failed GHL contact snapshot pause the whole
   GHL pipeline sync, including email card updates. Known conflicts only hold
   affected contacts. Ownerless cleanup rows are also held when phone candidates
  exist, because unrelated ownership cannot be established. Failed Jobber exit evidence holds phone exits, not the
   legacy email path. A held card may remain in an existing reminder workflow.
3. The pinned 2021-07-28 public API contracts were verified on November 7,
   2026. Contact matching now uses read-only POST /contacts/search with the
   documented top-level total and per-contact searchAfter cursor, not the
   unsupported GET meta.total assumption. Opportunity GET search documents
   meta.total, snake_case filters, contactId/pipelineId and status. Explicit
   status=all prevents a hidden closed duplicate from appearing unique.
   Live account access/provider behavior is still unverified by these tests.
4. The new full Jobber read uses the exact connection/fields already used by the
   deployed invoice query, with strict completion checks. It can add runtime/API
   cost and throttle delays, once per run only when an exit is considered.
5. Pagination and source snapshots are not transactional locks. Concurrent
   writes remain an operational race. No locking/schema migration/generalized
   safety rewrite or unrelated legacy Late Fee/Paid fix is included.
6. Only existing open Sent/Overdue/Paid cards participate. Missing/multiple cards,
   special stages, won/lost cards, and ambiguous owners are held, not created or
   automatically reopened. No-match never establishes SMS capability or consent.

## Verification

32 synthetic tests stub all database reads and all GHL/Jobber HTTP requests with
dummy credentials: `node --import tsx --test tests/ghl-phone.test.ts`.
Typecheck: `tsc --noEmit --incremental false`.
Production build: `next build` with a cleared environment and unreachable dummy
DB. The npm build wrapper's Prisma generation is not run against shared
node_modules. Final build result is recorded in the parent report.

## Pagination contract correction (November 7, 2026)

Official pinned sources:
- [Search Contacts, 2021-07-28](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/contacts/search-contacts-advanced/index.html)
- [Search Opportunity, 2021-07-28](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/opportunities/search-opportunity/index.html)

Contact search uses contacts.readonly, pageLimit=100, fastPagination=false,
and dateAdded ascending with the documented ID tie-break. Subsequent requests
preserve the final contact's mixed number/string searchAfter array unchanged;
they never combine it with page. The top-level total is explicitly the total
matching population. Completion requires that many unique IDs with stable totals.
Missing/invalid/repeated cursors, inconsistent counts, duplicate IDs, wrong
location, malformed/empty premature pages, or the 1,000-page cap fail closed.
There is no fallback treating deprecated GET count or fast-pagination hasMore as
a verified total. Tests cover continuation beyond the 10,000-record page window.

The opportunity GET route is deprecated but its pinned contract is documented.
The phone helper requests every status and holds unless meta.total and the
returned count both equal one, with an open card belonging to the exact contact
and pipeline. No legacy email helper behavior or lifecycle logic was changed by
this pagination correction. All contract fixtures use synthetic identities, not
captured production payloads. No live API requests were made.
