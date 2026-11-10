# Disabled notification source adapter

`lib/notification-source.ts` is a local read-only candidate. It is not a sender, a sync hook, a recurring all-invoice reminder solution, approval to enable notifications, or approval to deploy/migrate anything. All public snapshots and compositions retain `productionSendCapability: false` and `timingApproved: false`. Source-only inspection never calls a partial result send-eligible.

## Actual coverage and interfaces

- `NotificationSourceRequest` pins version 1, review reference, expiry, exact GHL location, Jobber owner/invoice and homeowner contact IDs, original invoice total in minor units, actual issuedDate/dueDate, and the existing reviewed identity-coverage policy.
- `readNotificationSource(request, io)` returns an opaque, frozen, process-local `NotificationSourceHandle`. It invokes the real `readReviewedIdentityCoverage`, not an injectable boolean or a fabricated coverage proof. That reader checks account identity on each active/archive page, exact reviewed omissions, exact-null quarantine rows, exact owner/invoice association, and fresh zero-link quarantine counts.
- The adapter invokes `verifyFreshGhlIdentity` with all cached customers, fresh source identities, the complete GHL contact snapshot and the genuine coverage capability. Primary/secondary email and phone collision checks remain intact. Quarantined cached identities remain collision witnesses. No archive deletion is inferred from a missing record.
- The existing complete-owner invoice reader supplies the current invoice set, with account identity checked on every page. The wrapper additionally requests the known `invoiceNumber` display field. There must be exactly one original source invoice and exactly that one cached invoice. Added paid or unpaid history, missing evidence, duplicates and partial pagination hold the pilot.
- `inspectNotificationSource(handle)` returns a frozen partial snapshot with exact IDs, source/owner revisions, source status/balance, actual dates, calendar late day, explicit observation/expiry provenance, invoice number when available, and unsupported inputs. Currency/category are explicitly null and categoryVerified is false. Missing or changed invoice number is not identity evidence: stable invoice ID is authoritative, and display labels do not enter the reminder source revision.
- `refreshNotificationSource(handle)` rereads current cached identities and the exact quarantine link counts, the exact Jobber owner/invoice identity, the complete GHL contact snapshot, and the complete owner-invoice source/cache set. Changed cache identities, new quarantine links, changed contact identities, or exact-owner drift hold. Comparisons use canonical sorted identity projections and retain every raw documented primary/secondary identifier and duplicate; harmless API row order and unrelated activity metadata do not cause drift. Malformed identity fields hold rather than being omitted. It reuses only the original, still-valid opaque coverage proof and preserves its original observation time, expiry, reference and owner revision.
- `composeNotificationEvidence(handle, event, external)` derives only source/owner proof from that genuine handle. It checks exact event/source binding and homeowner primary destination identity, then copies independently supplied external evidence without granting or inventing its truth. Both preflight and final compositions must still pass the separate proposal gate. No source handle, ledger reservation or positive proposal result authorizes a production send.

Opaque capabilities are not serializable. Plain objects, copies, JSON snapshots, ledger reservations and caller booleans cannot pass handle validation. The injection seam is trusted application code for actual IO or synthetic tests, not an HTTP payload or an authentication substitute.

## Timing and continuity

Actual `issuedDate` is the invoice send date. Actual `dueDate` anchors calendar days in America/Phoenix. The next calendar day after dueDate is late day 1. `createdAt`, card-entry timestamps and workflow waits never substitute for these source dates.

The snapshot provides:

- `identityObservedAt`, `identityExpiresAt`, `identitySourceRef`: original coverage lifetime. Observation starts before the initial cache/identity reads; expiry is bounded by that start plus five minutes, request expiry and policy expiry. The original issuer independently checks its own five-minute capability lifetime. The existing policy maximum remains 24 hours.
- `observedAt`, `expiresAt`, `sourceRef`: the actual source-invoice read start, never completion time or a metadata observation. Expiry is the earliest of the invoice, contact, exact-owner, cache and quarantine-count observations plus 60 seconds, and original identity/request expiry. Retained snapshots therefore cannot outlive any required exact check.
- `contactObservedAt` / `contactExpiresAt`: actual GHL read start and bounded 60-second lifetime.
- `exactOwnerObservedAt`: actual start of the exact owner/invoice association read. That recheck must remain strictly under 60 seconds when a snapshot is issued or composed.
- `cacheObservedAt`, `quarantineCountsObservedAt`: actual starts of those reads. Both must remain strictly under 60 seconds at snapshot issuance and composition, bounded by original identity expiry.
- `coverageReused`: whether a final exact read carried original account-wide coverage instead of rereading and reissuing it.

A 39-second initial identity scan therefore retains its old identity observation, while a later source query reports its own start. A final exact read can refresh expired source evidence within the original identity lifetime, but cannot refresh or extend the account-wide proof, policy or request. The gate's unchanged-owner continuity support is only justified by retaining this actual opaque issuer capability; copying a structural owner object is not itself authentication.

Reused account-wide identity coverage is not a new all-account scan. Another source owner's newly changed identifiers might remain unseen until the original coverage expires. GHL identities, cached identities, zero-link counts and the exact source owner/invoice are reread; all systems are still non-atomic. This is explicit bounded continuity, not a claim of an instantaneous global snapshot. A fresh DND read is also required externally immediately before any hypothetical dispatch. Slow/expired reads hold rather than relabeling old evidence fresh.

## Deliberate pilot limits and unsupported inputs

The original total/issued/due pins and expiring policy are deliberate pilot constraints. Expected fee additions, date changes, another billing cycle or additional paid/unpaid invoices hold until a separately reviewed request changes. The adapter never automatically updates those pins, renews a policy, guesses that an omitted invoice was deleted, or expands the owner/invoice scope.

Source statuses `paid` with zero balance, `void`, refund/unknown statuses, contradictory paid-positive or unpaid-zero states are inspectable but cannot produce open-positive-balance composition. Negative, nonfinite, sub-cent, missing or contradictory amounts hold. Partial payment changes produce a new source revision; an old event is rejected.

These inputs are **not implemented or established by this reader**:

1. Invoice/account currency. A separate trusted account/currency-policy reader must bind its evidence to this account, invoice and source revision. A requested currency string is not evidence.
2. Verified maintenance/irrigation category. An independent trusted source must establish it. Unknown stays null. D10/D15/internal D21 are common-category milestones; D20/D25/D30 require verified maintenance. Null never silently means maintenance.
3. Fresh channel-specific destination and DND, verified internal-recipient identity, and explicit approval of that internal recipient. Contact identity alone does not prove DND/consent or SMS capability. The separate GHL contract parser/reader can contribute its documented portion; it does not establish all account ownership or approvals.
4. Exact approved template/version, body digest, audience, milestone, and channel/destination authorization. The composer accepts explicit independent trusted inputs only; it cannot approve them.
5. Actually applied 3% fees, recurring fee policy, actual suspension, and collections-policy facts. These cannot be inferred from date, category, invoice total, a stage, or text in the requested message. Fact evidence remains bound to account/invoice/source revision and its own observation/expiry.
6. Complete existing attempt/message history across relevant sources, including historical GHL workflow and manual sends. A new empty ledger is not proof of no prior messages. A local reservation stays an attempt and is never removed or substituted for source proof by this adapter. Exact owned-reservation handling for any future dispatcher requires separately reviewed history composition.
7. Sender configuration, message transport, authenticated delivery receipts, runtime send approval, migration approval and production readiness.

External metadata/evidence is supplied by trusted call sites only, not event JSON or user-modifiable report files. It retains its original timestamps. The composed source observation stays equal to the actual invoice read observation. Updating metadata cannot masquerade as a strictly newer invoice reread. Composed expiry is bounded by every relied-on exact-check expiry, metadata expiry and metadata observation plus 60 seconds. Already-composed evidence therefore expires without needing another composition call; neither source nor metadata is stamped fresh at composition. The source reader deliberately does not call these unresolved inputs successful.

## Separated deployed read bindings

`deployedNotificationSourceReadBindings(reader)` is an inert factory returning the existing read-only customer/invoice/count queries, bounded standalone GHL contact reader, and an explicitly supplied source-audit `JobberReader`. The factory validates both normal and tsx/CJS default namespace export shapes without executing a database or provider request. Instantiating the already-used Prisma client does not connect it. There is no credential acquisition or refresh in this factory.

The supplied Jobber reader uses its existing no-refresh read-only transport with one attempt and a bounded request deadline. **Do not substitute application `jobberGraphQL`: its token helper can refresh credentials and write stored tokens.** The GHL binding reuses source-audit `GhlReadonlyReader` and `readAllContacts`, not the legacy application transport: fixed origin/version/read-only search body, bounded stream/response/total bytes, total/runtime and per-request timeout, redirect rejection, terminal full pagination, and no retries. It captures the existing environment location/key and refuses configuration drift. Any `contactShapeValid=false` row rejects the snapshot before mapping all raw primary and secondary identity strings back to GhlContact. DND is not silently promoted from that identity mapping. Any old evidence still fails timestamp checks. Actual reads require separate task authorization and secure existing credentials. This implementation and its tests did not invoke these deployed reads.

The full paid-cycle readiness reader is deliberately not used: its card stage/value checks and zeroing logic are unrelated to proving a coded notification's source. No card is read, moved, zeroed or enrolled by this adapter.

## Local verification

The source suite uses real source/coverage/identity implementations with synthetic IO, never a provider or database. It includes status/amount/source-set failures, account and identity collisions, policy expiry, 39-second reads, exact final drift, original-proof continuity, current cache/quarantine rechecks, forged/ledger capabilities, milestone/category gates, explicit missing approvals/history/facts, and dynamic-binding construction without live calls.

```sh
node --import tsx --test tests/notification-source.test.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
node node_modules/eslint/bin/eslint.js lib/notification-source.ts tests/notification-source.test.ts --no-eslintrc --config node_modules/eslint-config-next/core-web-vitals.js
git diff --check
```

137 source tests pass. TypeScript, targeted Next core-web-vitals ESLint, and diff whitespace checks pass. No install, migration, application startup, deploy, message send or live source check was performed for this work. These synthetic checks establish the candidate's exercised control behavior, not live account freshness, delivery reliability or general-reminder readiness.


### Narrow unknown-currency static-copy case

Currency metadata and composed source currency may be explicitly null only when the event is the exact original non-monetary Day10 homeowner SMS recognized by `notification-copy-policy.ts`. Its exact approved body digest, Day10/homeowner/SMS scope and empty claimed-fact set are checked again by the gate. This permits honest unknown currency without inventing USD or rendering money. All other bodies continue to require independent currency evidence. The positive unchanged balance, source revisions, dates, opaque ownership and every freshness/authorization/history check remain unchanged.
