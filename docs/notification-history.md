# Local notification history adapter

This candidate is **unwired, read-only, and local-only**. It adds no production dependency, scheduler, endpoint, credentials, schema change, migration, provider call, or send capability. Only synthetic streaming HTTP and ledger fixtures were used. Importing the module is inert. It does not replace the deployed runner or enable a pilot.

## Verified contract and intentionally unsupported cases

Official public documentation was checked on November 9, 2026. This adapter pins the documented `Version: 2021-04-15`, rather than silently following the current `v3` default:

- [Search Conversations](https://marketplace.gohighlevel.com/docs/2021-04-15/ghl/conversations/search-conversation/): GET `/conversations/search`, exact `locationId` plus `contactId`, `conversations` array with exact conversation/contact/location identifiers, and `total`. Required scope: `conversations.readonly`.
- [Get messages by conversation ID](https://marketplace.gohighlevel.com/docs/2021-04-15/ghl/conversations/get-messages/): GET `/conversations/{conversationId}/messages`, nested `messages.messages`, `nextPage` and `lastMessageId`. Required scope: `conversations/message.readonly`. Continuation is the last message ID, not a page number or timestamp.

The search endpoint describes `startAfterDate` but its documented response does **not** identify a usable sort-value/cursor field. This implementation does not invent one. It handles every distinct conversation in one complete search response, only when the verified `total` equals the returned count. A larger total, missing total, duplicate, or conflicting identity holds. More than 20 conversations therefore remains unsupported until a reliable continuation contract is verified. No short-page heuristic claims completeness. This is a deliberate implementation limit, not a claim that HighLevel cannot paginate search.

Message pages are exhausted even after encountering dates before issue. `nextPage: true` requires a nonempty advancing last-message cursor matching the page's final ID. Duplicated IDs across pages/conversations, repeated/missing cursors, malformed page data and resource exhaustion hold. No type or direction filter excludes possible attempts.

The documented message enum uses `TYPE_SMS`, while an example says `SMS`; only enum spelling is accepted. Numeric `type` never establishes channel identity. Known conflicting SMS numeric call/email/voicemail types hold. Recognized SMS variants include review/no-show/campaign SMS. Only `TYPE_CALL` with numeric call type 1 can be ignored after exact identity, valid timestamp and known direction are verified. Other non-SMS/email types hold. Known inbound SMS does not represent an outbound reminder.

Email entries can represent threads with multiple underlying messages, rather than complete individual attempts. This narrow two-endpoint adapter does not expand them and always holds when an email type or email metadata appears, including inbound or older threads. It cannot infer every thread member's direction/date/status from the thread. SMS never falls back to email. An empty fully returned history can support absence across both channels, but observed email history currently prevents readiness.

## Boundaries and integrity

`readNotificationHistory(request, io)` requires the exact account, location, homeowner contact, invoice, user-authoritative `issuedDate`, and a review reference. Internal Angie and a general/all-customer rollout are unsupported. Scope is not authorization. Independent fresh source/ownership checks must establish those inputs; this module does not establish invoice status, balance, dates, contact ownership, consent or approval.

The explicit application IO provides a GET-only function, an exact configured account/location binding, a fixed SQL SELECT executor, and optionally a clock. It supplies no arbitrary `historyComplete`, attribution or delivery booleans. There is no ambient fetch, environment variable, credential lookup, redirect, write method, retry, or provider fallback. The trusted application implementation must authenticate the account/location and scopes, perform each operation once and honor GET/abort. As with all dependency injection, this module cannot prove that a malicious transport or database implementation honored its inputs.

The SELECT reads **all contact records for the exact account**, not just the candidate milestone or invoice, with a 1001-row sentinel. It verifies each immutable event payload's canonical digest, exact persisted key/identity/channel, state and unambiguous provider message ID. This is a trusted existing ledger read, not a caller-supplied list of exclusions. All validated ledger records survive in the full inspection, including rejected/unknown/reserved/pending records and records whose provider message is absent/deleted. No record is removed, rewritten, relabeled, or exempted as the current reservation. An integration must keep its separate original-capability reservation fencing; this adapter cannot clear it.

GHL history has no documented invoice or opportunity identity usable here. Only an exact immutable ledger provider-ID mapping supplies an event identity. Message wording, invoice-like body text, timestamps, due date, apparent schedule, contact alone, workflow name, numeric type and delivery status cannot attribute a reminder. An unmatched outbound SMS on or after the issue calendar date holds attribution/readiness even if it appears unrelated. The boundary includes the entire issue date in `America/Phoenix`, not a guessed invoice send instant.

A mapped provider observation adds an `unknown` attempt for its **original exact event key**, alongside its unchanged ledger record. It never turns `sent` into delivered, and even raw `delivered` does not create independently verified delivery evidence here. Unknown provider outcome strings or missing outcomes hold. A known mapped ID cannot disappear by changing direction/type/date. A mapped older milestone stays that milestone; it is not reassigned to today's reminder. Historical ledger records for other invoices on the contact also remain intact.

## Facts, absence and composition

The returned handle is opaque and process-local. `inspectNotificationHistory(handle)` exposes a frozen, minimal snapshot with before-read observation time, completion time, original expiry, reasons, exact scope, pagination status, message identity summaries, preserved attempt records, and limitations. `localLedgerRecords` retains every validated local row, `externalMessageRecords` contains only actual mapped external message observations, and `records` retains their full union. It does not expose raw bodies, email content, addresses, credentials or provider errors. Clones, serialized objects and fabricated handles cannot be inspected/composed.

Proof lifetime is 60 seconds **from before the ledger/provider reads**, not completion. Every fresh final check must perform new reads and retain their original times. Copies and composition cannot extend expiry. Runtime clocks are checked for reversal/future observations; deadlines also use monotonic elapsed time.

`boundedAbsence` means only: no outbound SMS/email since issue date in the complete, attributable **returned accessible API history**. It explicitly does not prove deleted or inaccessible records never existed. It does not erase the ledger or prove all workflow/manual/provider systems were globally searched. Search/pages/ledger are not an atomic snapshot; messages and deletions can race the read, and new attempts can race a later send. These limits are part of every facts snapshot.

`composeNotificationHistoryAttempts(handle, exactEvent, now)` projects the **full union** to `Evidence.attempts` only when all supported reads are complete, attributable, fresh and match that exact homeowner invoice/contact/account/issue date. Otherwise it returns `attempts: null` and reasons. This full-union API is **not** the runner's external-history input: it deliberately includes the current local reservation. The gate's legacy `historyComplete: true` means only qualified accessible-history-plus-ledger completeness, **not global history** and not permission to send. A production design requiring global/deletion-proof history remains blocked.

### External-only projection for the runner's independent union

`projectAccessibleGhlExternalHistory(originalHandle)` mints a separate opaque `NotificationExternalHistoryHandle` only from a complete, attributable source read. Held, malformed or incomplete source facts cannot mint it. It is not an exclusion interface: no reservation handle, exclusion IDs or caller completeness boolean is accepted.

`inspectAccessibleGhlExternalHistory(projectedHandle)` explicitly labels its coverage `accessible-ghl-external-message-history-only` and `requiresIndependentLocalLedgerUnion: true`. It retains the original scope, observation, expiry, source limits and **all actual external-message records**. Local rows were used to establish exact provider-ID mappings; local-only reservations/attempts are outside this external projection, not erased from the original facts. Even an external record mapped to a currently reserved local row remains in the projection and continues to block that event.

`composeAccessibleGhlExternalAttempts(projectedHandle, exactEvent, now)` supplies only the external component for `NotificationRunnerDependencies.readExternal`. It rechecks exact scope and freshness, returns the explicit coverage label and union requirement, and returns `attempts: null` on failure. Its legacy `historyComplete: true` means **only complete supported accessible external history**. It is not standalone gate evidence and must never replace local-ledger history.

The existing runner independently reads actual local rows for the exact event and unions those with every external record. Its own original, owned, freshly verified reservation capability is the only basis for its existing current-`reserved`-row treatment. No capability is passed into `readExternal` or this adapter. A prior accepted/unknown local event still blocks through that independent read, including when its provider message is absent. A foreign, mutated, uncertain or missing reservation cannot be excused. External records are never excluded by that rule. Integrators must use the external-only projection here, not the full-union composer or the full snapshot's `records`.

This division removes the self-reservation integration trap without changing either ledger ownership checks or external exclusions. It does not certify that an arbitrary caller performed the required local union. The real runner's existing union and ownership checks are exercised in synthetic integration tests, and production wiring remains absent.

No source evidence is constructed or restamped. A future reviewed integration must still independently check a fresh invoice, ownership, recipient, DND, channel authorization, timing, template, facts, original durable reservation and approved send transport. Existing runner composition remains unchanged in this patch, so its external-evidence placeholder has not been silently swapped or enabled. The adapter is the local implementation candidate for that history input, not a rollout.

## Resource bounds and verification

- 20 items per API page; 101 GETs; 2000 messages; 1000 ledger records.
- 1 MB per HTTP response, 4 MB total response bytes, 4096 chunks per response; strict UTF-8 and JSON decoding. Ledger snapshots have a separate 4 MB limit.
- 5-second per-request and 15-second total read deadline. Stream cancellation/AbortSignal are best effort. SQL is awaited within the total deadline, but the injected SELECT executor must enforce its own server-side cancellation/timeout. A timed-out/uncertain read is never retried or promoted by a late response.
- No cap truncation is success. Partial validated records remain available for inspection but cannot compose a ready proof.

Local checks:

```sh
node --import tsx --test tests/notification-history.test.ts
node --import tsx --test tests/notification*.test.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

No `npm build`, dependency installation, registry access, live account/customer/provider reads, schema application, publication or deployment were attempted. Production credentials, actual API semantics, deletion coverage, search continuation, email thread expansion, atomicity, authorized pilot execution and future runner wiring remain unverified or unsupported as described above.

Projection regressions use the actual runner, source, gate, ledger reservation and transport modules against fake storage/HTTP. They prove that a new actual ledger reservation can pass the final external-history check while older accepted/unknown milestones remain preserved; prior accepted/unknown attempts for the candidate event still block; unmatched and duplicate outbound history hold; a foreign reservation fails; and an observed external record mapped to a reserved event cannot be omitted. Opaque-handle forgery, scope drift and original expiry are also checked. A synthetic fake-transport `accepted` result is not a live send, delivery claim or live approval.
