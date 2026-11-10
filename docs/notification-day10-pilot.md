# Disabled Day10 homeowner SMS pilot composition

This candidate adds a concrete trusted composition for **one reviewed invoice, one owner, one homeowner contact, one destination, one Day10 SMS and at most one attempt**. It is not all-customer reminders, Angie/internal messages, email, later fee/suspension milestones or a full SOP rollout. No actual runtime invocation, provider/account read, send, migration, build, deployment or enabling was performed for this change. Synthetic integration tests exercise the actual components with fake IO.

## What is now connected

`lib/notification-day10-pilot.ts` constructs the runner dependencies itself. It no longer asks a caller to invent currency/category/history/DND/template/sender/authorization booleans:

- The genuine opaque source reader and refresh provide actual account/invoice/owner/contact identity, source and owner revisions, issued/due dates, open balance and invoice number. Exact source pins and the existing one-invoice limitation remain. Source composition verifies the configured destination against both fresh Jobber and GHL primary destinations. The pilot never uses source country to guess currency.
- A separately reviewed exact invoice currency policy supplies currency with explicit two-decimal minor-unit semantics whenever balance is rendered. The exact recovered original static Day10 SMS is the sole exception: it renders no money, so an explicitly null policy remains honest unknown currency through event, metadata and gate. No USD or placeholder currency is inferred. Any altered/other body with unknown currency holds. Category remains null because Day10 is a common milestone. No applied-fee, suspension or collection facts are claimed.
- An explicitly reviewed Day10 copy policy supplies either the unchanged recovered original static SMS or a balance-rendering body with only `{{balance}}`, `{{invoiceNumber}}` and `{{dueDate}}` substitutions. The static original has no forced balance, currency or invoice-number token. Balance and dates, when rendered, come from current source facts. Missing requested invoice number or changed rendered body holds. There are no default words, guessed customer names, copied amounts or fallback templates. The reviewed policy must genuinely approve its meaning, including the no-enforcement scope; the implementation does not authenticate a document merely because its reference is nonempty.
- The real configured-sender reader uses Version `v3`, exact account/location/number, observed active account and SMS capability. It runs at preparation and every external-evidence phase. These observations do not independently establish credential ownership/write scope, global number uniqueness or permission. Those remain explicit reviewed references in the immutable configuration.
- Actual contact/DND reads use the existing Version `2021-07-28` parser. Missing channel state holds. No email fallback or extra consent/carrier gate is introduced.
- Actual history uses pinned Version `2021-04-15`, the real read-only local mapping query and all supported accessible conversation/message pages. Its opaque external-only projection is passed to the runner, which independently unions its local ledger and handles only the original owned reservation. No external message is removed.
- The exact native SMS request/receipt semantics and exact account/location/sender footer policy require explicit review references. The approved suffix policy reaches the actual construction object; the suffix is not appended to outbound copy by this code. The observed SMS 201 contract is retained. Acceptance still does not prove delivery.
- The actual runner performs two genuine preflight source/evidence reads, then, only in its explicit attempt mode, reserves and performs the final source/external reread. Actual transport alone owns pending, its final freshness/ownership checks, one POST and one outcome write. Unknown/reserved outcomes never authorize retry.

The two earlier bounded history endpoint observations confirm only the inspected shape. A search scoped to a known conversation is not contact-wide completeness, and a page with `nextPage:true` is not exhausted. This candidate retains its independent terminal-page checks, holds undocumented search continuation and does not derive a search cursor from the observed sort array.

## Review and action boundary

`inspectDay10PilotReadiness(raw, review)` is purely local. It returns specific missing/invalid fields and lists the actual runtime checks still required. It never reports rollout readiness or starts a database/client. Currency, sender/scope, exact copy policy, footer, native semantics, original source pins, finite schedule and out-of-band review mismatches have separate holds.

`reviewDay10PilotConfiguration(raw, review)` requires:

1. An exact SHA-256 of the complete raw configuration bytes, supplied **out of band**, not read from that JSON.
2. The matching explicit review reference and finite currently valid review interval, at most 24 hours.
3. A single exact Day10 date, homeowner SMS destination, source scope/pins and maximum one attempt.
4. Explicit approved copy, sender/write-scope, credential binding, timing, native semantics, footer and bounded-history policy references, plus verified currency policy when balance is rendered. Only the exact original static body may use explicit unknown currency.
5. An explicit action of `read-only` or `one-attempt` from the trusted operator/application boundary.

It issues a frozen process-local configuration handle. Clones, JSON reconstructions, an environment flag, `approved:true`, wrong hashes or expired configurations do not authorize an operation. A read-only review cannot be promoted to an attempt. A separate explicit runtime mode is still required. An exact hash is an integrity pin, **not cryptographic proof of reviewer identity or authority**. This API/CLI must be invoked only by an authorized operator or authenticated application, never exposed as an unauthenticated public “approve this JSON” endpoint. Reference strings are not an automated review of the referenced material.

The recovered original PDF supplies the exact static Day10 wording. This development assignment still has not approved any particular customer configuration or execution, and no currency policy is invented. Synthetic review references exist only in tests. Real review/action authorization must precede any eventual execution; successful local tests and an observed user test SMS do not grant customer-send approval.

## Disabled, readiness and read-only modes

`createDay10Pilot()` is an exact no-op by default. It does not inspect configuration/runtime getters, environment variables or ambient clients. Importing the pilot, runtime module or default CLI does not initialize Prisma. There is no application route, cron or environment activation switch.

The CLI is `scripts/review-day10-notification-pilot.ts`:

- No arguments: print missing configuration/review inputs and required runtime checks only.
- `--readiness <file> <reviewed-sha256> <review-ref>`: bounded local file validation only. No credentials, database or provider access.
- `--read-only <file> <reviewed-sha256> <review-ref>`: after explicit operator authorization, perform the real reads and two-pass eligibility/construction evaluation. The runner exits before transport review, reservation or POST. Deployment ledger transactions are READ ONLY, and the pilot's GHL fetch wrapper rejects non-GET requests. Jobber GraphQL and full GHL contact searches remain their separately bounded read-only query/search operations.
- `--reviewed-one-attempt <file> <reviewed-sha256> <review-ref>`: a separately explicitly authorized finite action, capable of real ledger writes and one SMS POST when all checks pass. This mode is implemented but **not invoked or approved by this development task**. It must not be confused with general deployment/rollout permission.

All output is a redacted configuration/readiness or state/reason summary. Action summaries report actual `attempted`/state and omit the misleading always-false production-send capability field, while retaining `rolloutReady:false` and `retryAllowed:false`. It excludes destination, account/contact/invoice IDs, body, raw provider response, tokens and source snapshots. There is no report-writing option. Config files are opened read-only with no symlink following, bounded at 32 KiB, checked for size/mtime/ctime changes, read once, decoded as strict UTF-8 and matched against the exact reviewed byte hash. Every file-backed mode has a two-minute hard stop starting before file open and covering reads, validation, runtime and cleanup. The no-argument readiness path remains an inert immediate return. A hard stop during an uncertain operation does not prove cancellation and never grants retry.

## Concrete deployment bootstrap

`deployedDay10PilotRuntime` is lazy, requires the original reviewed handle and defaults to read-only even if a broader handle exists. Explicit attempt action additionally requires the exact one-attempt review. `notification-day10-runtime.ts`:

- Verifies the same existing web service/environment/project/deployment and location boundaries as the source-review bootstrap.
- Requires `GHL_INVOICE_WRITE_MODE=review`, `GHL_PHONE_WRITES_ENABLED=false`, `SYNC_ADMISSION_MODE=cron_only` and no enabled notification flag. The distinct explicit pilot action never toggles these holds.
- Reads the existing Jobber token in a database READ ONLY transaction with a statement deadline. Preserves the existing `requireTokenRunCoverage` 900-second guard.
- Uses source-audit `JobberReader` and deployed read-only source bindings, never the application's token-refreshing `jobberGraphQL`. It performs no OAuth refresh or token write.
- Rechecks active holds, credential/location/database/deployment continuity and configuration expiry around actual IO. Credentials are only used for their issuing APIs and never printed.
- Supplies fixed-namespace parameterized SQL through the existing bounded transaction/lock/statement settings, with no retry. Inspection mode enforces SELECT/READ ONLY. Missing/unmigrated ledger schema is a hold, not permission to migrate.
- Exposes standalone CLI disconnect cleanup without changing the recorded send outcome. It does not call application startup, schema migration or any notification/workflow activation.

The existing source/identity proof, HTTP streaming bounds, deadlines and uncertainty behavior remain unchanged. The systems are non-atomic. A credential binding reference and exact configured location are not independent token introspection. The configured sender's page is not whole-account inventory. Accessible history cannot prove deleted/inaccessible/global absence; unexplained outbound history, email threads, partial pages or missing search continuation hold. Real production deployment/migration, broader history policy and operational reconciliation remain separate approvals/work.

## Local verification

Run only local checks for this candidate:

```sh
node --import tsx --test tests/notification-day10-pilot.test.ts
node --import tsx --test tests/*.test.ts tests/*.test.mjs
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

The pilot tests use the real source/identity, sender, history projection, contact parser, contract, gate, runner, ledger and transport over fake storage and streaming HTTP. They cover disabled exact no-op and transitive import isolation; named readiness holds; hash/ref/expiry/schema/action mismatch; source-derived amount/body; version pins; read-only no writes; exact destination; DND including absent channel; sender/history/source failure; final drift; preserved reservation exclusion; 201 acceptance; 429/500/transport uncertainty and no retries. The file-boundary regressions also simulate stalled open/read calls and reject symlink, directory and oversized inputs without runtime initialization. No live bootstrap was invoked, and no npm/build/registry command was run for this pilot.

Final local results after the static-copy correction: 71/71 focused copy-policy/pilot tests, 1194/1194 complete repository tests, TypeScript and diff checks passed. The dependency tree before this pilot delta matches the separately combined `facb293fbf5c21c3e1d77c7e85e979704ae1e328` candidate. This pilot has no independent live or production-build result.


### Exact original static-copy correction

`notification-copy-policy.ts` recognizes only the SHA-256 of the recovered original SMS, at Day10/homeowner/SMS with no claimed applied facts. It is not approval. Separate template/content/action reviews remain mandatory. The gate and source composer permit explicit `currency:null` only for that exact shape. Undefined, empty or invented currency is not accepted. Changed punctuation, wording, business phone, amount text, other channels/milestones or claimed facts cannot use the exception. Monetary rendering still requires the reviewed invoice currency policy.

The original source total/date pins, positive source balance and unchanged full balance/revision checks remain mandatory even when no amount is displayed. Regressions cover the exact unchanged body with no invoice display number, no currency claim, read-only no writes, altered/monetary bodies held, template approval still required, and final paid/partial/zero/date drift consuming the reservation without a POST. The CLI now uses a redacted execution summary without a false no-send capability assertion after an actual possible attempt.
