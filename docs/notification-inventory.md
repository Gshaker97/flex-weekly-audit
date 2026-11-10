# Read-only recurring invoice discovery and source binding

This local candidate extends `093d2747df98486216e0bfa08b1a41fa7256c33a` in a separate worktree. It does not change the frozen `cd4c0baa` release. No provider calls, credentials, production records, migrations, publication, deployment, scheduling, sends, fees, suspension or workflow activation were used for development or validation.

## Implemented entry points

1. `readNotificationInventory(request, inventoryIO)` scans the unfiltered Jobber invoice connection, including paid/void/unknown rows, with account verification on every page. It uses the existing supported query fields and source-audit paginator: 25 records/page, at most 500 pages and 12,500 records, checked terminal pagination, unique IDs/cursors, no empty continuation, one request attempt and bounded deadline. The existing token must cover 900 seconds at startup. There is no token refresh hook. The opaque result can be inspected as a discovery report; copies/JSON are not inventory capabilities.
2. `readNotificationSourceBatch(reviewedOmissionPolicy, sourceIO)` reads the cached identity population, all explicitly active and archived Jobber owners, the exact reviewed quarantine and zero-link counts, and the complete GHL contact population once. It invokes the real new shared issuer in `ghl-identity-coverage.ts`, not a structural `verified` flag. The original start time and at-most-five-minute expiry are retained. A source batch is process-local and nonserializable.
3. `planNotificationInventory(inventory, batch, optionalFreshSourceHandles)` feeds the existing real `planNotificationWorklist`. Every open invoice survives independently, even several invoices for the same owner/contact. Paid/void/invalid exclusions and owner-resolution holds remain explicit. More than 1000 open planning rows hold the entire planner input; historical paid rows do not consume that planner limit. The planner continues to preserve contact/day collisions, all Day21 digest members, stable logical event keys, actual issued/due dates and the exact Arizona window/no-catch-up rules.
4. `notificationRequestFromInventory(inventory, batch, invoiceId)` creates v2 exact-source pins from the authentic discovery row and matched population. No manual per-invoice approval is invented. The request is a description, not a capability or approval. `readDiscoveredNotificationSource(...)` passes it to `readNotificationSourceFromBatch`, producing the existing genuine `NotificationSourceHandle` only after fresh exact checks.
5. Each selected binding/reread independently checks the cached owner, both quarantine link counts, exact Jobber owner/invoice association, exact GHL contact identity and complete owner invoice connection. Every cached invoice must still occur in that complete source set; cached omissions and duplicate IDs hold. A newly discovered invoice may not yet be cached, and an owner may have many paid/unpaid invoices. These do not by themselves hold. The selected invoice's actual original total/issued/due pins must agree with fresh source; balance/status are reread and never taken from stale discovery. Source/account/owner drift still holds.
6. `refreshNotificationSource` on a v2 handle repeats the exact checks without repeating all 875-owner/1436-contact reads. It retains the original population proof, owner revision and expiry. Exact evidence remains under 60 seconds, and the request/policy/population expiry can only tighten it. The original v1 pilot entry remains explicitly version 1 and keeps its singleton source/cache restrictions.
7. The optional fresh-source handles supplied to `planNotificationInventory` contribute the selected invoice's current balance/status and its exact authenticated contact GET's tag snapshot. The snapshot keeps the original contact-read start/expiry, account/location/contact provenance and exact tags. Missing/malformed tags remain null; case ambiguity remains a branch hold. The exact `irrigation` rule selects irrigation, verified absence selects the existing other/maintenance branch. No Jobber product taxonomy is used. Without those handles, discovery is deliberately category-unknown. Common Day10/15/21 remain independent. No tags, amounts or dates establish a fee, suspension or policy fact.

## Genuine shared coverage and remaining race boundaries

The new shared identity issuer stores its real complete-read evidence privately. An owner-only capability can support collision checking for planning but fails exact-invoice checks. The exact binder rereads the owner/invoice and only then creates an invoice-scoped capability with the original expiry. Inspection clones, test-shaped objects and report JSON cannot become either capability.

Cached and provider identities across the population are bounded collision witnesses, not an atomic global snapshot. A different owner's identifiers or quarantine reappearance may change after the shared scan. Exact selected owner/contact and quarantine link counts are reread, while other population changes can remain unseen until the original five-minute deadline. That limitation is not labeled instantaneous global freshness. At expiry the batch holds and must be replaced by a separately invoked complete batch read. There is no automatic renewal, retry or delayed dispatch.

`cacheObservedAt` on a v2 source denotes its exact cached-owner reread, not a repeat of the full cached population. `identityObservedAt` is the original full-population start. `contactObservedAt` denotes the exact selected contact GET, not the earlier complete contact search. The shared original population remains mandatory until expiry. Source proof expiry includes every relied-on exact-check start and the shorter request deadline.

An incomplete scanner report has `coverage: partial-held`, a hold reason and pages attempted. It has no usable rows or generated requests. It is never reported as an empty complete account. Successful terminal scan means connection coverage, not atomic consistency across pages; selected source must still be independently reread.

## Inert deployed read bindings

`deployedNotificationInventoryReadBindings(existingJobberReader, { tokenExpiresAt, fetch })` constructs `inventoryIO` and `sourceIO` without querying providers/database or reading credentials. Its caller must separately acquire an existing token using the established authorized read-only transaction. It must supply the real token expiry. The scanner enforces the unchanged 900-second guard; the existing `JobberReader` still bounds every request and never refreshes OAuth.

The factory reuses existing complete contact/cache/source bindings and adds exact cached-owner and contact reads. The standalone GHL allowlist permits only an exact `/contacts/{safe-id}` GET for the latter, with no query parameters, bounded response/runtime, no retries, redirect rejection and required matching response ID/location. Existing DND parsing is untouched. The exact identity projection does not silently claim SMS consent or DND permission.

No recurring bootstrap/CLI, scheduler, database writer or production activation path is added. Provider reads remain explicit calls into these interfaces, not import-time effects. A synthetic integration can call scanner → shared batch → planner → selected source handles → planner with fresh tags. It cannot call any send through this adapter.

## Remaining integration, explicitly not ready for all recurring sends

- Connect this adapter to the authorized runtime's existing no-refresh credential acquisition and its reviewed standing recipient/content/action scope. Do not manufacture per-invoice approvals, and do not treat the reviewed quarantine policy as message authorization.
- Coordinate discovery plus exact source selection at 09:00 America/Phoenix. Retain the existing `[09:00,09:15)` gate. If inventory, the original five-minute population deadline, an exact 60-second read or complete history cannot fit, hold/report the affected work; never relax the window or catch up. Real account latency has not been measured by these synthetic tests.
- Use the real sender, DND/recipient, complete historical-attempt union and ledger runner, with final fresh exact source checks before each attempted send. The adapter supplies none of those permissions or histories.
- Provide approved conditional copy and truthful invoice-bound applied-fee/recurring-policy/suspension/collections evidence. All conditional input contracts remain unapproved; currency remains unknown, never guessed USD. The existing exact static Day10 exception remains unchanged.
- Implement actual durable digest/member admission and history for Angie, and resolve homeowner same-contact/day conflicts under an approved content policy. The planner's digest is still a plan, not a forged single-invoice send.
- New owners discovered outside the cached identity population remain explicit holds pending safe cache/identity integration; they are not silently omitted from account discovery or treated as approved contacts.

## Local checks

Synthetic tests exercise real scanner, shared issuer, identity verifier, source reader, planner and exact contact transport, with fake IO only. They include a 875-owner/1436-contact population that is read once across several selected invoices and final reads; multiple/new billing-cycle invoices; full pagination/account/omission/expiry/forged-capability failures; paid transitions; tag branches; legacy v1 isolation; source and planning size limits; exact GET scope/redirect/error/byte failures; no refresh, no retries, and the 09:15 no-catch-up boundary.

Run:

```sh
node --import tsx --test tests/notification-inventory.test.ts
node --import tsx --test tests/*.test.ts tests/*.test.mjs
node node_modules/typescript/bin/tsc --noEmit --incremental false
node node_modules/eslint/bin/eslint.js lib/notification-inventory.ts lib/notification-source.ts lib/ghl-identity-coverage.ts scripts/ghl-preview/transport.ts tests/notification-inventory.test.ts --no-eslintrc --config node_modules/eslint-config-next/core-web-vitals.js
git diff --check
```
